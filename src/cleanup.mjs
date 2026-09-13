import fs from 'node:fs';
import path from 'node:path';
import { listDirNames, listFiles, safeStat, symbolHasTickData } from './util.mjs';

export function findTickDatOnlySymbols(ticksRoot) {
  if (!safeStat(ticksRoot)?.isDirectory()) return [];
  return listDirNames(ticksRoot).filter((symbol) => {
    const dir = path.join(ticksRoot, symbol);
    return safeStat(dir)?.isDirectory() && !symbolHasTickData(dir);
  });
}

export function removeTickDatOnlyFolders(ticksRoot, { label = ticksRoot } = {}) {
  const symbols = findTickDatOnlySymbols(ticksRoot);
  if (!symbols.length) {
    console.log(`\nCleanup ${label}: no ticks.dat-only folders`);
    return { removed: [], count: 0 };
  }

  console.log(`\nCleanup ${label}: removing ${symbols.length} ticks.dat-only folder(s)`);
  const removed = [];
  for (const symbol of symbols) {
    const dir = path.join(ticksRoot, symbol);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(symbol);
      if (removed.length <= 10) {
        console.log(`  remove   ${symbol}`);
      }
    } catch (err) {
      console.log(`  error    ${symbol} (${err.message})`);
    }
  }
  if (removed.length > 10) {
    console.log(`  ... and ${removed.length - 10} more`);
  }
  return { removed, count: removed.length };
}

export function cleanupTickFolders(sourceTicksRoot, destTicksRoot) {
  const source = removeTickDatOnlyFolders(sourceTicksRoot, { label: 'terminal ticks' });
  const dest = destTicksRoot
    ? removeTickDatOnlyFolders(destTicksRoot, { label: 'backup ticks' })
    : { removed: [], count: 0 };
  return { source, dest };
}
