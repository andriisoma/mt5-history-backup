import fs from 'node:fs';
import path from 'node:path';
import {
  TERMINAL_ROOT,
  SKIP_TERMINAL_DIRS,
  formatBytes,
  isDemoServer,
  listDirNames,
  listFiles,
  readOriginInstallPath,
  safeStat,
} from './util.mjs';

function scanServerData(serverPath, kind) {
  const base = path.join(serverPath, kind);
  if (!safeStat(base)?.isDirectory()) return [];
  const symbols = [];
  for (const symbol of listDirNames(base)) {
    const dir = path.join(base, symbol);
    const files = listFiles(dir);
    const hasData =
      kind === 'ticks'
        ? files.some((f) => f.endsWith('.tkc'))
        : files.some((f) => /\.(hcc|hc)$/i.test(f));
    if (!hasData) continue;
    let bytes = 0;
    for (const f of files) {
      const st = safeStat(path.join(dir, f));
      if (st) bytes += st.size;
    }
    symbols.push({ symbol, fileCount: files.length, bytes, files: files.slice(0, 5) });
  }
  return symbols.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function scanTerminal(dataPath, options = {}) {
  const terminalId = path.basename(dataPath);
  const installPath = readOriginInstallPath(dataPath);
  const basesPath = path.join(dataPath, 'bases');
  if (!safeStat(basesPath)?.isDirectory()) return [];

  const servers = [];
  for (const server of listDirNames(basesPath)) {
    if (options.includeDemo !== true && isDemoServer(server)) continue;
    const serverPath = path.join(basesPath, server);
    const ticks = scanServerData(serverPath, 'ticks');
    const history = scanServerData(serverPath, 'history');
    if (!ticks.length && !history.length) continue;
    servers.push({
      terminalId,
      dataPath,
      installPath,
      server,
      ticks,
      history,
      tickBytes: ticks.reduce((s, t) => s + t.bytes, 0),
      historyBytes: history.reduce((s, t) => s + t.bytes, 0),
    });
  }
  return servers;
}

export function discoverTerminals(options = {}) {
  if (!safeStat(TERMINAL_ROOT)?.isDirectory()) {
    throw new Error(`MT5 terminal root not found: ${TERMINAL_ROOT}`);
  }

  const entries = [];
  for (const name of listDirNames(TERMINAL_ROOT)) {
    if (SKIP_TERMINAL_DIRS.has(name)) continue;
    const dataPath = path.join(TERMINAL_ROOT, name);
    entries.push(...scanTerminal(dataPath, options));
  }
  return entries;
}

export function findTerminalEntry(entries, { server, terminalId, dataPath } = {}) {
  return entries.find((e) => {
    if (server && e.server !== server) return false;
    if (terminalId && e.terminalId !== terminalId) return false;
    if (dataPath && path.normalize(e.dataPath) !== path.normalize(dataPath)) return false;
    return true;
  });
}

export function pickBestTerminalForServer(entries, server) {
  const matches = entries.filter((e) => e.server === server);
  if (!matches.length) return null;
  return matches.sort((a, b) => b.tickBytes + b.historyBytes - (a.tickBytes + a.historyBytes))[0];
}

export function printDiscovery(entries) {
  if (!entries.length) {
    console.log('No broker ticks/history folders found.');
    return;
  }
  console.log(`Found ${entries.length} terminal/server pair(s):\n`);
  for (const e of entries) {
    console.log(`  ${e.server}`);
    console.log(`    terminal: ${e.terminalId}`);
    console.log(`    install:  ${e.installPath ?? '(unknown)'}`);
    console.log(`    data:     ${e.dataPath}`);
    console.log(
      `    ticks:    ${e.ticks.length} symbol(s), ${formatBytes(e.tickBytes)}`,
    );
    console.log(
      `    history:  ${e.history.length} symbol(s), ${formatBytes(e.historyBytes)}`,
    );
    console.log('');
  }
}

export function getServerSourcePaths(entry) {
  const serverBase = path.join(entry.dataPath, 'bases', entry.server);
  return {
    ticks: path.join(serverBase, 'ticks'),
    history: path.join(serverBase, 'history'),
  };
}

export function getServerDestPaths(destRoot, server) {
  return {
    ticks: path.join(destRoot, server, 'ticks'),
    history: path.join(destRoot, server, 'history'),
  };
}

export function symbolTickDir(entry, symbol) {
  return path.join(entry.dataPath, 'bases', entry.server, 'ticks', symbol);
}

export function symbolHistoryDir(entry, symbol) {
  return path.join(entry.dataPath, 'bases', entry.server, 'history', symbol);
}

export function listTickSymbols(entry) {
  return entry.ticks.map((t) => t.symbol);
}

export function listHistorySymbols(entry) {
  return entry.history.map((t) => t.symbol);
}

export function readNewestTkc(symbolDir) {
  const files = listFiles(symbolDir).filter((f) => f.endsWith('.tkc'));
  if (!files.length) return null;
  return files.sort().at(-1);
}

export function readNewestHistoryFile(symbolDir) {
  const files = listFiles(symbolDir).filter((f) => /\.(hcc|hc)$/i.test(f));
  if (!files.length) return null;
  return files.sort((a, b) => {
    const ya = parseInt(a, 10);
    const yb = parseInt(b, 10);
    return ya - yb;
  }).at(-1);
}
