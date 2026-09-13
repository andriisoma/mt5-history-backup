import fs from 'node:fs';
import path from 'node:path';
import {
  MIN_HISTORY_HCC_BYTES,
  formatMt5Date,
  listFiles,
  safeStat,
  symbolHasMeaningfulHistory,
} from './util.mjs';
import { readNewestTkc, symbolHistoryDir, symbolTickDir } from './discover.mjs';
import { parseM1HistoryStart, readTesterLogSince } from './tester-log.mjs';
import { checkOccupancy, runTesterSession } from './force-month.mjs';

function historyYear(name) {
  const m = /^(\d{4})\.(hcc|hc)$/i.exec(name);
  return m ? +m[1] : null;
}

export function trimHistoryFolder(historyDir, { m1Start, label = path.basename(historyDir) } = {}) {
  if (!safeStat(historyDir)?.isDirectory()) return { removed: [], m1Start: m1Start ?? null, hasData: false };

  const startYear = m1Start ? parseInt(m1Start.split('.')[0], 10) : null;
  const removed = [];
  for (const name of listFiles(historyDir)) {
    if (!/\.(hcc|hc)$/i.test(name)) continue;
    const filePath = path.join(historyDir, name);
    const st = safeStat(filePath);
    if (!st) continue;
    const year = historyYear(name);
    const isStub = st.size < MIN_HISTORY_HCC_BYTES;
    const beforeStart = startYear != null && year != null && year < startYear;
    if (beforeStart || isStub) {
      try {
        fs.unlinkSync(filePath);
        removed.push({ file: name, bytes: st.size, reason: beforeStart ? 'before M1 start' : 'stub' });
      } catch (err) {
        removed.push({ file: name, error: err.message });
      }
    }
  }

  const remaining = listFiles(historyDir).filter((f) => /\.(hcc|hc)$/i.test(f));
  if (!remaining.length) {
    try {
      fs.rmSync(historyDir, { recursive: true, force: true });
    } catch {
      /* ok */
    }
  }

  if (removed.length) {
    console.log(
      `  trim     ${label}: removed ${removed.length} file(s)` +
        (m1Start ? ` (M1 from ${m1Start})` : ''),
    );
  }
  return { removed, m1Start: m1Start ?? null, hasData: symbolHasMeaningfulHistory(historyDir) };
}

export function trimAllHistoryFolders(historyRoot, startsBySymbol = {}) {
  if (!safeStat(historyRoot)?.isDirectory()) return { startsBySymbol, trimmed: {} };
  const trimmed = {};
  for (const symbol of fs.readdirSync(historyRoot)) {
    const dir = path.join(historyRoot, symbol);
    if (!safeStat(dir)?.isDirectory()) continue;
    trimmed[symbol] = trimHistoryFolder(dir, {
      m1Start: startsBySymbol[symbol] ?? null,
      label: symbol,
    });
  }
  return { startsBySymbol, trimmed };
}

export async function forceM1HistoryForTickSymbols(entry, tickSymbols, options = {}) {
  checkOccupancy(entry.installPath, options.cliPath);
  const leverage = options.leverage ?? '500';
  const to = formatMt5Date(new Date());
  const wideFrom = '2000.01.01';
  const startsBySymbol = {};
  const failures = [];

  console.log(`\nForce M1 history (${tickSymbols.length} symbol(s), Model=1)`);

  for (const symbol of tickSymbols) {
    const histDir = symbolHistoryDir(entry, symbol);
    const tickDir = symbolTickDir(entry, symbol);
    if (!readNewestTkc(tickDir)) continue;

    const hadHistory = symbolHasMeaningfulHistory(histDir);
    console.log(
      `  ${symbol}: ${hadHistory ? 'refresh' : 'download'} ${wideFrom} -> ${to} (Model=1)`,
    );

    try {
      const result = await runTesterSession(entry, symbol, { from: wideFrom, to, model: 1, leverage });
      const m1Start = parseM1HistoryStart(result.logText ?? '', symbol);
      if (m1Start) {
        startsBySymbol[symbol] = m1Start;
        console.log(`    m1 start ${symbol}: ${m1Start}`);
      } else {
        console.log(`    warn     ${symbol}: M1 start not found in tester log`);
      }
      trimHistoryFolder(histDir, { m1Start, label: symbol });
    } catch (err) {
      failures.push({ symbol, error: err.message });
      console.log(`    warn     ${symbol}: ${err.message}`);
    }
  }

  if (failures.length) {
    console.log(`\n  M1 history warnings: ${failures.length} symbol(s)`);
  }
  return { startsBySymbol, failures };
}

export function removeHistoryWithoutTickMatch(historyRoot, tickSymbols) {
  if (!safeStat(historyRoot)?.isDirectory()) return { removed: [] };
  const tickSet = new Set(tickSymbols);
  const removed = [];
  for (const symbol of fs.readdirSync(historyRoot)) {
    if (tickSet.has(symbol)) continue;
    const dir = path.join(historyRoot, symbol);
    if (!safeStat(dir)?.isDirectory()) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(symbol);
    } catch {
      /* ok */
    }
  }
  if (removed.length) {
    console.log(`\nCleanup history: removed ${removed.length} folder(s) not in tick set`);
  }
  return { removed };
}
