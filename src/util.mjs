import fs from 'node:fs';
import path from 'node:path';

export const MIN_HISTORY_HCC_BYTES = 1_000_000;
export const TERMINAL_ROOT = path.join(process.env.APPDATA, 'MetaQuotes', 'Terminal');
export const SKIP_TERMINAL_DIRS = new Set(['Common', 'Community']);

export function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

export async function copyFileWithRetry(src, dest, { retries = 15, delayMs = 3000 } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      await fs.promises.copyFile(src, dest);
      return;
    } catch (err) {
      lastErr = err;
      if (i < retries - 1) sleepMs(delayMs);
    }
  }
  throw lastErr;
}

export function readOriginInstallPath(dataPath) {
  const originPath = path.join(dataPath, 'origin.txt');
  try {
    const buf = fs.readFileSync(originPath);
    let text;
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
      text = new TextDecoder('utf-16le').decode(buf.subarray(2));
    } else {
      text = buf.toString('utf8');
    }
    const line = text.split(/\r?\n/)[0]?.trim();
    return line || null;
  } catch {
    return null;
  }
}

export function isDemoServer(server) {
  return /demo/i.test(server);
}

export function isCanonicalDataDir(name) {
  if (name === 'ticks' || name === 'history') return true;
  return false;
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function formatMt5Date(date) {
  return `${date.getFullYear()}.${pad2(date.getMonth() + 1)}.${pad2(date.getDate())}`;
}

export function parseYyyyMm(name) {
  const m = /^(\d{4})(\d{2})\.tkc$/i.exec(name);
  if (!m) return null;
  return { year: +m[1], month: +m[2], key: `${m[1]}${m[2]}` };
}

export function parseYyyy(name) {
  const m = /^(\d{4})\.(hcc|hc)$/i.exec(name);
  if (!m) return null;
  return { year: +m[1], ext: m[2].toLowerCase(), key: m[1] };
}

export function lastDayOfMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

export function monthRangeFromNewestTkc(newestName, now = new Date()) {
  const parsed = parseYyyyMm(newestName);
  if (!parsed) throw new Error(`Invalid tkc name: ${newestName}`);
  const from = `${parsed.year}.${pad2(parsed.month)}.01`;
  const isCurrentMonth =
    parsed.year === now.getFullYear() && parsed.month === now.getMonth() + 1;
  const toDay = isCurrentMonth ? now.getDate() : lastDayOfMonth(parsed.year, parsed.month);
  const to = `${parsed.year}.${pad2(parsed.month)}.${pad2(toDay)}`;
  return { from, to, parsed };
}

/** Pick the month to force-complete: previous calendar month when newest tkc is the in-progress month. */
export function monthRangeForForceComplete(newestName, now = new Date()) {
  const parsed = parseYyyyMm(newestName);
  if (!parsed) throw new Error(`Invalid tkc name: ${newestName}`);

  let year = parsed.year;
  let month = parsed.month;
  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;
  if (isCurrentMonth) {
    month -= 1;
    if (month < 1) {
      month = 12;
      year -= 1;
    }
  }

  const from = `${year}.${pad2(month)}.01`;
  const to = `${year}.${pad2(month)}.${pad2(lastDayOfMonth(year, month))}`;
  return {
    from,
    to,
    monthKey: `${year}${pad2(month)}`,
    sourceNewest: newestName,
  };
}

export function monthRangeFromNewestHistory(newestName, now = new Date()) {
  const parsed = parseYyyy(newestName);
  if (!parsed) throw new Error(`Invalid history name: ${newestName}`);
  const from = `${parsed.year}.01.01`;
  const isCurrentYear = parsed.year === now.getFullYear();
  const toDay = isCurrentYear ? now.getDate() : 31;
  const toMonth = isCurrentYear ? now.getMonth() + 1 : 12;
  const to = `${parsed.year}.${pad2(toMonth)}.${pad2(Math.min(toDay, lastDayOfMonth(parsed.year, toMonth)))}`;
  return { from, to, parsed };
}

export function listDirNames(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

export function listFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => {
      const st = safeStat(path.join(dir, f));
      return st?.isFile();
    });
  } catch {
    return [];
  }
}

export function symbolHasTickData(dir) {
  return listFiles(dir).some((f) => f.endsWith('.tkc'));
}

export function symbolHasHistoryData(dir) {
  return symbolHasMeaningfulHistory(dir);
}

export function symbolHasMeaningfulHistory(dir) {
  return listFiles(dir).some((f) => {
    if (!/\.(hcc|hc)$/i.test(f)) return false;
    const st = safeStat(path.join(dir, f));
    return st && st.size >= MIN_HISTORY_HCC_BYTES;
  });
}

export function newestDatedFile(files, parseFn) {
  let best = null;
  for (const name of files) {
    const parsed = parseFn(name);
    if (!parsed) continue;
    if (!best || parsed.key > best.key) best = { name, ...parsed };
  }
  return best;
}

export function loadJsonConfig(configPath) {
  if (!fs.existsSync(configPath)) return {};
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}
