'use strict';
// Reads the date a photo was taken from its EXIF data (JPEG only). Returns 'YYYY-MM-DD' or ''.
// Uses DateTimeOriginal, then DateTimeDigitized, then the camera's DateTime.

function takenAt(buf) {
  try {
    if (!buf || buf.length < 12 || buf[0] !== 0xff || buf[1] !== 0xd8) return '';
    let i = 2;
    while (i + 4 < buf.length && buf[i] === 0xff) {
      const marker = buf[i + 1], len = buf.readUInt16BE(i + 2);
      if (marker === 0xda || marker === 0xd9) break; // start of image data: no EXIF before it
      if (marker === 0xe1 && buf.toString('latin1', i + 4, i + 10) === 'Exif\0\0') return fromTiff(buf, i + 10, len - 8);
      i += 2 + len;
    }
  } catch (_) { /* damaged or unusual file */ }
  return '';
}

function fromTiff(buf, start, size) {
  const end = Math.min(buf.length, start + size);
  const le = buf.toString('latin1', start, start + 2) === 'II';
  const u16 = (o) => (start + o + 2 <= end ? (le ? buf.readUInt16LE(start + o) : buf.readUInt16BE(start + o)) : 0);
  const u32 = (o) => (start + o + 4 <= end ? (le ? buf.readUInt32LE(start + o) : buf.readUInt32BE(start + o)) : 0);
  if (u16(2) !== 42) return '';
  const readIfd = (off) => {
    const tags = {};
    const n = u16(off);
    if (!n || n > 500) return tags;
    for (let k = 0; k < n; k++) {
      const e = off + 2 + k * 12;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      if (type === 2 && count >= 19 && count <= 64) { // ASCII text, stored at an offset
        const at = start + u32(e + 8);
        if (at + 19 <= end) tags[tag] = buf.toString('latin1', at, at + 19);
      } else if (type === 4 || type === 3) tags[tag] = type === 4 ? u32(e + 8) : u16(e + 8);
    }
    return tags;
  };
  const ifd0 = readIfd(u32(4));
  const exif = ifd0[0x8769] ? readIfd(ifd0[0x8769]) : {};
  for (const v of [exif[0x9003], exif[0x9004], ifd0[0x0132]]) {
    const m = typeof v === 'string' && v.match(/^(\d{4}):(\d{2}):(\d{2})/);
    if (m && m[1] >= '1990' && m[1] <= String(new Date().getFullYear() + 1) && m[2] >= '01' && m[2] <= '12' && m[3] >= '01' && m[3] <= '31') return `${m[1]}-${m[2]}-${m[3]}`;
  }
  return '';
}

module.exports = { takenAt };
