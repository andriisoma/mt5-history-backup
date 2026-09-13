#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  discoverTerminals,
  findTerminalEntry,
  getServerDestPaths,
  getServerSourcePaths,
  pickBestTerminalForServer,
  printDiscovery,
} from './discover.mjs';
import { forceCompleteForEntry } from './force-month.mjs';
import { cleanupTickFolders } from './cleanup.mjs';
import { forceM1HistoryForTickSymbols, removeHistoryWithoutTickMatch, trimAllHistoryFolders } from './history.mjs';
import { writeManifest } from './manifest.mjs';
import { summarizeSyncResults, syncHistoryTree, syncTicksTree } from './sync.mjs';
import { formatBytes, loadJsonConfig } from './util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DEST = path.join(
  process.env.USERPROFILE,
  'My Drive',
  'Forex',
  'Ticks history backup',
);

function usage() {
  console.log(`MT5 ticks and M1 history backup

Usage:
  node src/backup.mjs --discover [--include-demo]
  node src/backup.mjs --dest PATH --server SERVER [--terminal ID] [--skip-tester] [--include-demo]
  node src/backup.mjs --dest PATH --all-brokers [--skip-tester] [--include-demo]

Options:
  --discover         List local MT5 broker ticks/history folders
  --dest PATH        Backup destination (default: Google Drive path or config.json)
  --server NAME      Broker server folder name (e.g. ICMarketsSC-MT5)
  --terminal ID      Terminal hash folder (optional; picks largest data set if omitted)
  --all-brokers      Backup every discovered server
  --include-demo     Include *Demo* servers
  --skip-tester      Skip force-complete tester runs before copy
  --no-cleanup       Do not remove ticks.dat-only folders from terminal or backup
  --leverage N       Tester leverage (default 500)
  --config PATH      JSON config file (default: config.json in repo root)

Copy config.example.json to config.json and edit paths for another machine.
`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const has = (flag) => args.includes(flag);

  if (!args.length || has('--help') || has('-h')) {
    usage();
    process.exit(0);
  }

  const configPath = get('--config') ?? path.join(REPO_ROOT, 'config.json');
  const fileCfg = loadJsonConfig(configPath);

  return {
    discover: has('--discover'),
    allBrokers: has('--all-brokers'),
    includeDemo: has('--include-demo') || fileCfg.includeDemo === true,
    skipTester: has('--skip-tester') || fileCfg.skipTester === true,
    noCleanup: has('--no-cleanup') || fileCfg.noCleanup === true,
    dest: get('--dest') ?? fileCfg.dest ?? DEFAULT_DEST,
    server: get('--server') ?? fileCfg.server,
    terminalId: get('--terminal') ?? fileCfg.terminalId ?? '',
    leverage: get('--leverage') ?? fileCfg.leverage ?? '500',
  };
}

async function backupOneEntry(entry, options) {
  console.log(`\n=== ${entry.server} (${entry.terminalId}) ===`);
  console.log(`  install: ${entry.installPath}`);
  console.log(`  data:    ${entry.dataPath}`);

  if (!options.skipTester) {
    await forceCompleteForEntry(entry, { leverage: options.leverage });
    const tickSymbols = entry.ticks.map((t) => t.symbol);
    const { startsBySymbol } = await forceM1HistoryForTickSymbols(entry, tickSymbols, {
      leverage: options.leverage,
    });
    entry.m1Starts = startsBySymbol;
  } else {
    console.log('  skip-tester: copying existing terminal files only');
  }

  const src = getServerSourcePaths(entry);
  const dest = getServerDestPaths(options.dest, entry.server);
  const tickSymbols = entry.ticks.map((t) => t.symbol);

  if (!options.noCleanup) {
    cleanupTickFolders(src.ticks, dest.ticks);
    if (!options.skipTester) {
      trimAllHistoryFolders(src.history, entry.m1Starts ?? {});
    } else {
      trimAllHistoryFolders(src.history, {});
    }
    removeHistoryWithoutTickMatch(src.history, tickSymbols);
    removeHistoryWithoutTickMatch(dest.history, tickSymbols);
  }

  const tickResults = await syncTicksTree(src.ticks, dest.ticks);
  const historyResults = await syncHistoryTree(src.history, dest.history, tickSymbols);

  if (!options.noCleanup) {
    trimAllHistoryFolders(dest.history, entry.m1Starts ?? {});
    removeHistoryWithoutTickMatch(dest.history, tickSymbols);
  }
  const summary = summarizeSyncResults(tickResults, historyResults);

  console.log(
    `\n  Sync summary: add=${summary.counts.add ?? 0} replace=${summary.counts.replace ?? 0} refresh=${summary.counts.refresh ?? 0} error=${summary.counts.error ?? 0}`,
  );
  if (summary.errors.length) {
    console.log('  Copy errors (retry after closing MT5 or re-run):');
    for (const e of summary.errors.slice(0, 10)) {
      console.log(`    ${e.kind}/${e.symbol} ${e.file}: ${e.message}`);
    }
    if (summary.errors.length > 10) {
      console.log(`    ... and ${summary.errors.length - 10} more`);
    }
  }

  return {
    server: entry.server,
    terminalId: entry.terminalId,
    dataPath: entry.dataPath,
    installPath: entry.installPath,
    m1Starts: entry.m1Starts ?? {},
    summary,
    tickResults,
    historyResults,
  };
}

async function main() {
  const opts = parseArgs();
  const entries = discoverTerminals({ includeDemo: opts.includeDemo });

  if (opts.discover) {
    printDiscovery(entries);
    return;
  }

  if (!opts.dest) {
    console.error('Missing --dest (backup folder)');
    process.exit(1);
  }

  fs.mkdirSync(opts.dest, { recursive: true });
  console.log(`Destination: ${opts.dest}`);

  let targets = [];

  if (opts.allBrokers) {
    const byServer = new Map();
    for (const e of entries) {
      const prev = byServer.get(e.server);
      if (!prev || e.tickBytes + e.historyBytes > prev.tickBytes + prev.historyBytes) {
        byServer.set(e.server, e);
      }
    }
    targets = [...byServer.values()];
    if (!targets.length) {
      console.error('No broker data found to backup.');
      process.exit(1);
    }
    console.log(`Backing up ${targets.length} server(s)`);
  } else {
    if (!opts.server) {
      console.error('Specify --server NAME or --all-brokers');
      process.exit(1);
    }
    let entry = findTerminalEntry(entries, {
      server: opts.server,
      terminalId: opts.terminalId || undefined,
    });
    if (!entry) {
      entry = pickBestTerminalForServer(entries, opts.server);
    }
    if (!entry) {
      console.error(`No terminal data found for server ${opts.server}`);
      process.exit(1);
    }
    targets = [entry];
  }

  const runMeta = [];
  for (const entry of targets) {
    runMeta.push(await backupOneEntry(entry, opts));
  }

  writeManifest(opts.dest, {
    ranAt: new Date().toISOString(),
    skipTester: opts.skipTester,
    includeDemo: opts.includeDemo,
    runs: runMeta.map((r) => ({
      ...r,
      m1Starts: r.m1Starts ?? {},
    })),
  });

  const copyErrors = runMeta.flatMap((r) => r.summary.errors ?? []);
  if (copyErrors.length) {
    console.error(`\nBackup finished with ${copyErrors.length} copy error(s). Re-run after closing MT5.`);
    process.exit(2);
  }

  const totalTick = targets.reduce((s, t) => s + t.tickBytes, 0);
  const totalHist = targets.reduce((s, t) => s + t.historyBytes, 0);
  console.log(`\nDone. Source tick data ~${formatBytes(totalTick)}, history ~${formatBytes(totalHist)}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
