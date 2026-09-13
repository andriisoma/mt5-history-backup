import fs from 'node:fs';
import path from 'node:path';
import {
  copyFileWithRetry,
  formatBytes,
  listDirNames,
  listFiles,
  newestDatedFile,
  parseYyyy,
  parseYyyyMm,
  safeStat,
  symbolHasHistoryData,
  symbolHasMeaningfulHistory,
  symbolHasTickData,
} from './util.mjs';

const TICK_SIDECARS = new Set(['ticks.dat']);

function shouldCopySidecar(name, srcStat, destStat) {
  if (!destStat) return true;
  if (srcStat.mtimeMs > destStat.mtimeMs) return true;
  if (srcStat.size > destStat.size) return true;
  return false;
}

async function syncOneFile(src, dest, action, log, errors) {
  const srcStat = safeStat(src);
  if (!srcStat) return null;
  const destStat = safeStat(dest);
  try {
    await copyFileWithRetry(src, dest);
  } catch (err) {
    const entry = {
      action: 'error',
      file: path.basename(src),
      message: err.message,
    };
    errors.push(entry);
    console.log(`    error    ${entry.file} (${err.message})`);
    return entry;
  }
  const entry = {
    action,
    file: path.basename(src),
    srcBytes: srcStat.size,
    destBytes: destStat?.size ?? 0,
  };
  log.push(entry);
  console.log(
    `    ${action.padEnd(8)} ${entry.file} (${formatBytes(srcStat.size)}${destStat ? `, was ${formatBytes(destStat.size)}` : ''})`,
  );
  return entry;
}

/**
 * Sync dated files with last-file-only replace rule.
 * @param {object} opts
 * @param {string} opts.sourceDir
 * @param {string} opts.destDir
 * @param {(name:string)=>object|null} opts.parseDated
 * @param {Set<string>} opts.sidecars
 * @param {string} opts.kind - ticks | history
 */
export async function syncSymbolFolder(opts) {
  const { sourceDir, destDir, parseDated, sidecars, kind, symbol } = opts;
  const log = [];
  const errors = [];
  if (!safeStat(sourceDir)?.isDirectory()) return { symbol, kind, log, errors, skipped: true };

  const srcFiles = listFiles(sourceDir);
  const destExists = safeStat(destDir)?.isDirectory();
  const destFiles = destExists ? listFiles(destDir) : [];

  const srcDated = srcFiles.filter((f) => parseDated(f));
  const destDated = destFiles.filter((f) => parseDated(f));
  const srcNewest = newestDatedFile(srcDated, parseDated);
  const destNewest = newestDatedFile(destDated, parseDated);

  if (!destExists) {
    fs.mkdirSync(destDir, { recursive: true });
    console.log(`  ${symbol}: new folder (${srcDated.length} dated file(s))`);
    for (const name of srcFiles) {
      if (sidecars.has(name) || parseDated(name)) {
        await syncOneFile(path.join(sourceDir, name), path.join(destDir, name), 'add', log, errors);
      }
    }
    return { symbol, kind, log, errors };
  }

  const destDatedSet = new Set(destDated);

  for (const name of srcDated) {
    if (!destDatedSet.has(name)) {
      await syncOneFile(path.join(sourceDir, name), path.join(destDir, name), 'add', log, errors);
    }
  }

  const undersized = destDated
    .filter((name) => {
      const srcStat = safeStat(path.join(sourceDir, name));
      const destStat = safeStat(path.join(destDir, name));
      return srcStat && destStat && srcStat.size > destStat.size;
    })
    .sort();

  const replaceTarget = undersized.at(-1);
  if (replaceTarget) {
    const srcPath = path.join(sourceDir, replaceTarget);
    const destPath = path.join(destDir, replaceTarget);
    await syncOneFile(srcPath, destPath, 'replace', log, errors);
  } else if (destNewest && srcNewest && destNewest.name === srcNewest.name) {
    const srcStat = safeStat(path.join(sourceDir, srcNewest.name));
    const destStat = safeStat(path.join(destDir, destNewest.name));
    if (srcStat && destStat) {
      console.log(
        `    skip     ${srcNewest.name} (src ${formatBytes(srcStat.size)} <= dest ${formatBytes(destStat.size)})`,
      );
    }
  }

  for (const name of srcFiles) {
    if (!sidecars.has(name)) continue;
    const srcPath = path.join(sourceDir, name);
    const destPath = path.join(destDir, name);
    const srcStat = safeStat(srcPath);
    const destStat = safeStat(destPath);
    if (srcStat && shouldCopySidecar(name, srcStat, destStat)) {
      await syncOneFile(srcPath, destPath, destStat ? 'refresh' : 'add', log, errors);
    }
  }

  return { symbol, kind, log, errors };
}

export async function syncTicksTree(sourceTicksRoot, destTicksRoot) {
  const results = [];
  if (!safeStat(sourceTicksRoot)?.isDirectory()) {
    console.log(`Source ticks folder missing: ${sourceTicksRoot}`);
    return results;
  }
  fs.mkdirSync(destTicksRoot, { recursive: true });
  const symbols = listDirNames(sourceTicksRoot).filter((symbol) =>
    symbolHasTickData(path.join(sourceTicksRoot, symbol)),
  );
  console.log(`\nSync ticks (${symbols.length} symbol(s))`);
  for (const symbol of symbols) {
    const res = await syncSymbolFolder({
      sourceDir: path.join(sourceTicksRoot, symbol),
      destDir: path.join(destTicksRoot, symbol),
      parseDated: parseYyyyMm,
      sidecars: TICK_SIDECARS,
      kind: 'ticks',
      symbol,
    });
    if (res.log.length) results.push(res);
  }
  return results;
}

export async function syncHistoryTree(sourceHistoryRoot, destHistoryRoot, tickSymbols = null) {
  const results = [];
  if (!safeStat(sourceHistoryRoot)?.isDirectory()) {
    console.log(`Source history folder missing: ${sourceHistoryRoot}`);
    return results;
  }
  fs.mkdirSync(destHistoryRoot, { recursive: true });
  const tickSet = tickSymbols == null ? null : new Set(tickSymbols);
  const symbols = listDirNames(sourceHistoryRoot).filter((symbol) => {
    if (tickSet && !tickSet.has(symbol)) return false;
    return symbolHasMeaningfulHistory(path.join(sourceHistoryRoot, symbol));
  });
  console.log(`\nSync history (${symbols.length} symbol(s))`);
  for (const symbol of symbols) {
    const res = await syncSymbolFolder({
      sourceDir: path.join(sourceHistoryRoot, symbol),
      destDir: path.join(destHistoryRoot, symbol),
      parseDated: parseYyyy,
      sidecars: new Set(),
      kind: 'history',
      symbol,
    });
    if (res.log.length) results.push(res);
  }
  return results;
}

export function summarizeSyncResults(tickResults, historyResults) {
  const counts = { add: 0, replace: 0, refresh: 0, error: 0 };
  const errors = [];
  for (const group of [...tickResults, ...historyResults]) {
    for (const e of group.log) counts[e.action] = (counts[e.action] ?? 0) + 1;
    for (const e of group.errors ?? []) {
      counts.error += 1;
      errors.push({ symbol: group.symbol, kind: group.kind, ...e });
    }
  }
  return { counts, errors };
}
