import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  monthRangeForForceComplete,
} from './util.mjs';
import {
  readNewestTkc,
  symbolTickDir,
} from './discover.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PROBE_MQ5 = path.join(REPO_ROOT, 'mql5', 'SymbolSpecProbe.mq5');
const PROBE_EA = 'SymbolSpecProbe';
const REQUEST_FILE = 'mt5batch-spec-request.txt';
const RESULT_FILE = 'mt5batch-spec-result.csv';
const DEFAULT_CLI = path.resolve(
  REPO_ROOT,
  '..',
  'mt5-batch-optimizer',
  'src-tauri',
  'target',
  'release',
  'mt5-batch-cli.exe',
);

function commonFilesDir() {
  return path.join(process.env.APPDATA, 'MetaQuotes', 'Terminal', 'Common', 'Files');
}

function writeProbeRequest(symbols) {
  const dir = commonFilesDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, REQUEST_FILE), `${symbols.join('\r\n')}\r\n`);
}

export function ensureProbeEa(installPath, dataPath) {
  if (!installPath) throw new Error('installPath missing (origin.txt not found?)');
  const experts = path.join(dataPath, 'MQL5', 'Experts');
  fs.mkdirSync(experts, { recursive: true });
  const destMq5 = path.join(experts, `${PROBE_EA}.mq5`);
  const destEx5 = path.join(experts, `${PROBE_EA}.ex5`);
  fs.copyFileSync(PROBE_MQ5, destMq5);

  const needsCompile =
    !fs.existsSync(destEx5) ||
    fs.statSync(PROBE_MQ5).mtimeMs > fs.statSync(destEx5).mtimeMs;

  if (needsCompile) {
    const metaEditor = path.join(installPath, 'MetaEditor64.exe');
    if (!fs.existsSync(metaEditor)) {
      throw new Error(`MetaEditor64.exe not found at ${metaEditor}`);
    }
    const logPath = path.join(experts, `${PROBE_EA}_compile.log`);
    spawnSync(metaEditor, [`/compile:${destMq5}`, `/log:${logPath}`], { encoding: 'utf8' });
    if (!fs.existsSync(destEx5)) {
      const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
      throw new Error(`SymbolSpecProbe compile failed: ${log.slice(-500)}`);
    }
  }
}

function buildTesterIni({ symbol, from, to, model, leverage }) {
  const lev = String(leverage).replace(/\D/g, '') || '500';
  return `[Tester]\r\n\
Expert=${PROBE_EA}\r\n\
Symbol=${symbol}\r\n\
Period=M1\r\n\
Optimization=0\r\n\
Model=${model}\r\n\
FromDate=${from}\r\n\
ToDate=${to}\r\n\
ForwardMode=0\r\n\
Deposit=10000\r\n\
Currency=USD\r\n\
Leverage=1:${lev}\r\n\
ExecutionMode=0\r\n\
Visual=0\r\n\
ShutdownTerminal=1\r\n\
ReplaceReport=0\r\n`;
}

import { readTesterLogSince, testerLogPath } from './tester-log.mjs';

export function checkOccupancy(installPath, cliPath = DEFAULT_CLI) {
  if (!fs.existsSync(cliPath)) {
    console.warn(`  occupancy CLI not found (${cliPath}), skipping check`);
    return { cliBusy: false };
  }
  const res = spawnSync(cliPath, ['occupancy'], { encoding: 'utf8' });
  if (res.status !== 0) {
    console.warn('  occupancy check failed, proceeding with caution');
    return { cliBusy: false };
  }
  const data = JSON.parse(res.stdout);
  const norm = path.normalize(installPath).toLowerCase();
  const match = data.terminals?.find(
    (t) => path.normalize(t.installPath).toLowerCase() === norm,
  );
  if (match?.cliBusy) {
    throw new Error(
      `Terminal ${installPath} is cliBusy (mt5-batch-cli run in progress). Wait or use another terminal.`,
    );
  }
  return match ?? { cliBusy: false };
}

export async function runTesterSession(entry, symbol, { from, to, model, leverage }) {
  writeProbeRequest([symbol]);
  ensureProbeEa(entry.installPath, entry.dataPath);

  const resultPath = path.join(commonFilesDir(), RESULT_FILE);
  try {
    fs.unlinkSync(resultPath);
  } catch {
    /* ok */
  }

  const iniDir = path.join(process.env.LOCALAPPDATA, 'mt5-history-backup', 'tester-ini');
  fs.mkdirSync(iniDir, { recursive: true });
  const iniPath = path.join(
    iniDir,
    `${entry.terminalId}-${symbol}-m${model}-${from.replace(/\./g, '')}.ini`,
  );
  fs.writeFileSync(iniPath, buildTesterIni({ symbol, from, to, model, leverage }));

  const terminalExe = path.join(entry.installPath, 'terminal64.exe');
  if (!fs.existsSync(terminalExe)) {
    throw new Error(`terminal64.exe not found: ${terminalExe}`);
  }

  const logOffset = fs.existsSync(testerLogPath(entry.dataPath))
    ? fs.statSync(testerLogPath(entry.dataPath)).size
    : 0;
  const started = Date.now();

  console.log(`    tester Model=${model} ${symbol} ${from} -> ${to}`);
  spawn(terminalExe, [`/config:${iniPath}`], { stdio: 'ignore', detached: true }).unref();

  const deadline = Date.now() + (model === 1 ? 45 : 20) * 60_000;
  while (Date.now() < deadline) {
    const sessionLog = readTesterLogSince(entry.dataPath, logOffset);
    if (/Test passed|final balance/i.test(sessionLog)) {
      return { ok: true, logText: sessionLog };
    }
    if (/SymbolSpecProbe: wrote/i.test(sessionLog)) {
      return { ok: true, logText: sessionLog };
    }
    if (new RegExp(`${symbol}.*real ticks begin`, 'i').test(sessionLog)) {
      return { ok: true, logText: sessionLog };
    }
    if (new RegExp(`${symbol}.*ticks data begins`, 'i').test(sessionLog)) {
      return { ok: true, logText: sessionLog };
    }
    if (fs.existsSync(resultPath)) {
      const st = fs.statSync(resultPath);
      if (st.size > 20 && st.mtimeMs >= started - 5000) {
        return { ok: true, logText: sessionLog };
      }
    }
    if (/tester stopped/i.test(sessionLog) && /not found|failed/i.test(sessionLog)) {
      throw new Error(`Tester failed for ${symbol}: ${sessionLog.slice(-300)}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error(`Tester timed out for ${symbol} (${from} -> ${to})`);
}

export async function forceCompleteLastMonth(entry, symbols, options = {}) {
  const { leverage = '500' } = options;
  checkOccupancy(entry.installPath, options.cliPath);

  const tickSymbols = symbols.filter((s) => {
    const newest = readNewestTkc(symbolTickDir(entry, s));
    return Boolean(newest);
  });

  console.log(`\nForce-complete last month (${tickSymbols.length} tick symbol(s))`);
  const failures = [];
  for (const symbol of tickSymbols) {
    const dir = symbolTickDir(entry, symbol);
    const newest = readNewestTkc(dir);
    const { from, to, monthKey, sourceNewest } = monthRangeForForceComplete(newest);
    console.log(`  ${symbol}: ${sourceNewest} -> force ${monthKey} (${from} -> ${to})`);
    try {
      await runTesterSession(entry, symbol, { from, to, model: 4, leverage });
    } catch (err) {
      failures.push({ symbol, error: err.message });
      console.log(`    warn     ${symbol}: ${err.message}`);
    }
  }
  if (failures.length) {
    console.log(`\n  Force-month warnings: ${failures.length} symbol(s) (sync will still run)`);
  }
  return failures;
}

export async function forceCompleteForEntry(entry, options = {}) {
  const tickSymbols = entry.ticks.map((t) => t.symbol);
  return forceCompleteLastMonth(entry, tickSymbols, options);
}
