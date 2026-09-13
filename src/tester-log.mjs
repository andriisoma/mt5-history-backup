import fs from 'node:fs';
import path from 'node:path';

export function testerLogPath(dataPath, date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return path.join(dataPath, 'Tester', 'logs', `${y}${m}${d}.log`);
}

function decodeLogBytes(buf, { utf16le = false } = {}) {
  if (utf16le) return new TextDecoder('utf-16le').decode(buf);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buf.subarray(2));
  }
  return new TextDecoder('utf-8').decode(buf);
}

export function readTesterLogSince(dataPath, offset, maxBytes = 4 * 1024 * 1024) {
  const p = testerLogPath(dataPath);
  if (!fs.existsSync(p)) return '';
  const stat = fs.statSync(p);
  if (offset >= stat.size) return '';

  const fd = fs.openSync(p, 'r');
  try {
    const bom = Buffer.alloc(2);
    fs.readSync(fd, bom, 0, 2, 0);
    const isUtf16 = bom[0] === 0xff && bom[1] === 0xfe;
    let start = offset > 0 ? offset : isUtf16 ? 2 : 0;
    if (isUtf16 && (start - 2) % 2 !== 0) start += 1;
    const readLen = Math.min(stat.size - start, maxBytes);
    if (readLen <= 0) return '';
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, start);
    return decodeLogBytes(buf, { utf16le: isUtf16 && start >= 2 });
  } finally {
    fs.closeSync(fd);
  }
}

export function readTesterLogTail(dataPath, maxBytes = 1024 * 1024) {
  const p = testerLogPath(dataPath);
  if (!fs.existsSync(p)) return '';
  const stat = fs.statSync(p);
  return readTesterLogSince(dataPath, Math.max(0, stat.size - maxBytes), maxBytes);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Best M1 bar start for symbol from tester log (Core session line). */
export function parseM1HistoryStart(logText, symbol) {
  const sym = escapeRegex(symbol);
  const patterns = [
    new RegExp(`${sym},M1: history begins from (\\d{4}\\.\\d{2}\\.\\d{2})`, 'gi'),
    new RegExp(`${sym},M1 \\(ICMarkets[^)]*\\): history begins from (\\d{4}\\.\\d{2}\\.\\d{2})`, 'gi'),
    new RegExp(`Tester\\s+${sym}: history data begins from (\\d{4}\\.\\d{2}\\.\\d{2})`, 'gi'),
  ];
  let best = null;
  for (const re of patterns) {
    for (const m of logText.matchAll(re)) {
      const date = m[1];
      if (!best || date > best) best = date;
    }
  }
  return best;
}

export function parseSessionForSymbol(logText, symbol) {
  const sym = escapeRegex(symbol);
  const startRe = new RegExp(`Tester\\s+"${escapeRegex('SymbolSpecProbe.ex5')}"|testing of Experts\\\\SymbolSpecProbe\\.ex5 from`, 'i');
  const symRe = new RegExp(`${sym},M1`, 'i');
  const chunks = logText.split(/\r?\n/);
  let session = [];
  for (const line of chunks) {
    if (/Tester\s+"SymbolSpecProbe\.ex5"/i.test(line) || /testing of Experts\\SymbolSpecProbe\.ex5 from/i.test(line)) {
      session = [line];
      continue;
    }
    if (session.length && symRe.test(line)) {
      session.push(line);
    }
    if (session.length && /Test passed|automatic testing finished/i.test(line)) {
      session.push(line);
      break;
    }
  }
  return session.join('\n');
}
