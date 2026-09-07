import fs from 'node:fs';
import path from 'node:path';
import { formatBytes, listDirNames, listFiles, safeStat } from './util.mjs';

function folderStats(dir) {
  let bytes = 0;
  let files = 0;
  for (const name of listFiles(dir)) {
    const st = safeStat(path.join(dir, name));
    if (st?.isFile()) {
      bytes += st.size;
      files += 1;
    }
  }
  return { bytes, files };
}

function scanTree(root, kind) {
  const base = path.join(root, kind);
  if (!safeStat(base)?.isDirectory()) return [];
  const out = [];
  for (const symbol of listDirNames(base)) {
    const dir = path.join(base, symbol);
    const stats = folderStats(dir);
    const dated = listFiles(dir).filter((f) =>
      kind === 'ticks' ? /^\d{6}\.tkc$/i.test(f) : /^\d{4}\.(hcc|hc)$/i.test(f),
    );
    dated.sort();
    out.push({
      symbol,
      files: stats.files,
      bytes: stats.bytes,
      newest: dated.at(-1) ?? null,
    });
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export function writeManifest(destRoot, meta) {
  const servers = [];
  for (const name of listDirNames(destRoot)) {
    if (name === 'manifest.json') continue;
    const serverRoot = path.join(destRoot, name);
    if (!safeStat(serverRoot)?.isDirectory()) continue;
    const ticks = scanTree(serverRoot, 'ticks');
    const history = scanTree(serverRoot, 'history');
    if (!ticks.length && !history.length) continue;
    servers.push({
      server: name,
      ticks: {
        symbols: ticks.length,
        bytes: ticks.reduce((s, t) => s + t.bytes, 0),
        items: ticks,
      },
      history: {
        symbols: history.length,
        bytes: history.reduce((s, t) => s + t.bytes, 0),
        items: history,
      },
    });
  }

  const manifest = {
    version: 1,
    updatedAt: new Date().toISOString(),
    destRoot,
    backup: meta,
    servers,
    totals: {
      tickBytes: servers.reduce((s, x) => s + x.ticks.bytes, 0),
      historyBytes: servers.reduce((s, x) => s + x.history.bytes, 0),
      tickSymbols: servers.reduce((s, x) => s + x.ticks.symbols, 0),
      historySymbols: servers.reduce((s, x) => s + x.history.symbols, 0),
    },
  };

  const outPath = path.join(destRoot, 'manifest.json');
  fs.mkdirSync(destRoot, { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(
    `\nWrote manifest: ${outPath} (${manifest.totals.tickSymbols} tick symbols, ${formatBytes(manifest.totals.tickBytes)}; ${manifest.totals.historySymbols} history symbols, ${formatBytes(manifest.totals.historyBytes)})`,
  );
  return manifest;
}
