'use strict';
// Text encoders for saving CSV in the encoding the file came in. TextEncoder only writes UTF-8, so
// legacy encodings use a reverse table made from TextDecoder (built once, on the first save that needs it).

const SINGLE_BYTE = new Set(['windows-1252', 'windows-1250', 'windows-1251', 'iso-8859-15', 'koi8-r', 'iso-8859-1', 'iso-8859-2']);
const DOUBLE_BYTE = new Set(['shift_jis', 'euc-jp', 'gb18030', 'big5', 'euc-kr']);
// In these encodings the second byte of a character can look like an ASCII byte (0x40-0x7E), so a byte
// scanner must skip it. EUC-JP and EUC-KR trail bytes are always >= 0xA1.
const TRAIL_CAN_BE_ASCII = new Set(['shift_jis', 'gb18030', 'big5']);

class EncodeError extends Error {
  constructor(ch, enc) {
    super(`The character "${ch}" (U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}) cannot be written in ${enc}. Save as UTF-8, or remove the character.`);
    this.code = 'ENCODE';
    this.char = ch;
    this.encoding = enc;
  }
}

const tables = new Map();

function buildTable(enc) {
  const dec = new TextDecoder(enc, { fatal: true });
  const map = new Map();
  const put = (s, bytes) => { if (s.length >= 1 && !map.has(s)) map.set(s, bytes); };
  for (let b = 0; b < 256; b++) {
    try { const s = dec.decode(Uint8Array.of(b)); if (s.length === 1 || (s.length === 2 && s.codePointAt(0) > 0xffff)) put(s, Uint8Array.of(b)); } catch { /* not a single-byte char */ }
  }
  if (DOUBLE_BYTE.has(enc)) {
    const pair = new Uint8Array(2);
    for (let lead = 0x81; lead <= 0xfe; lead++) {
      for (let trail = 0x40; trail <= 0xfe; trail++) {
        if (trail === 0x7f) continue;
        pair[0] = lead; pair[1] = trail;
        let s;
        try { s = dec.decode(pair); } catch { continue; }
        if (s.length === 1 || (s.length === 2 && s.codePointAt(0) > 0xffff)) put(s, Uint8Array.of(lead, trail));
      }
    }
  }
  return map;
}

function tableFor(enc) {
  let t = tables.get(enc);
  if (!t) { t = buildTable(enc); tables.set(enc, t); }
  return t;
}

/** Bytes of `str` in `enc`. Throws EncodeError for a character the encoding has no bytes for. */
function encode(str, enc) {
  if (enc === 'utf-8') return Buffer.from(str, 'utf8');
  if (enc === 'utf-16le') return Buffer.from(str, 'utf16le');
  if (enc === 'utf-16be') return Buffer.from(str, 'utf16le').swap16();
  const t = tableFor(enc);
  const out = Buffer.allocUnsafe(str.length * 2 + 4);
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) { out[n++] = code; continue; }
    let ch = str[i];
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) { ch = str.slice(i, i + 2); }
    const b = t.get(ch);
    if (!b) throw new EncodeError(ch, enc);
    for (let k = 0; k < b.length; k++) out[n++] = b[k];
    if (ch.length === 2) i++;
  }
  return out.subarray(0, n);
}

/** True when encode() can write every character of `str` in `enc`. */
function canEncode(str, enc) {
  try { encode(str, enc); return true; } catch { return false; }
}

const BOMS = { 'utf-8': [0xef, 0xbb, 0xbf], 'utf-16le': [0xff, 0xfe], 'utf-16be': [0xfe, 0xff] };

/** Length of the byte order mark at the start of `buf` for `enc` (0 when there is none). */
function bomLength(buf, enc) {
  const b = BOMS[enc];
  if (!b || buf.length < b.length) return 0;
  for (let i = 0; i < b.length; i++) if (buf[i] !== b[i]) return 0;
  return b.length;
}

module.exports = { encode, canEncode, bomLength, EncodeError, SINGLE_BYTE, DOUBLE_BYTE, TRAIL_CAN_BE_ASCII, BOMS };
