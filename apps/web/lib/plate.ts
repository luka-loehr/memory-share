/**
 * A tiny procedural PNG, used as the gate's cover when there is no real one to
 * degrade — no cover asset, no thumbnail yet, or no image transform available.
 *
 * It is generated rather than shipped as a static file so that every memory
 * gets its own plate: the colours come from the slug, so two different links
 * do not look identical, and no photograph is involved at all.
 *
 * Encoding is done by hand (stored deflate blocks) to keep the route free of
 * dependencies; at 64x64 the size cost of not compressing is a few kilobytes.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** zlib stream made only of stored (uncompressed) deflate blocks. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks: Uint8Array[] = [];
  const MAX = 65535;
  for (let offset = 0; offset < raw.length; offset += MAX) {
    const slice = raw.subarray(offset, Math.min(offset + MAX, raw.length));
    const final = offset + MAX >= raw.length ? 1 : 0;
    const header = new Uint8Array(5);
    header[0] = final;
    header[1] = slice.length & 0xff;
    header[2] = (slice.length >> 8) & 0xff;
    header[3] = ~slice.length & 0xff;
    header[4] = (~slice.length >> 8) & 0xff;
    blocks.push(header, slice);
  }

  const bodyLength = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(2 + bodyLength + 4);
  out[0] = 0x78; // CMF: deflate, 32K window
  out[1] = 0x01; // FLG: no dictionary, fastest
  let cursor = 2;
  for (const block of blocks) {
    out.set(block, cursor);
    cursor += block.length;
  }
  new DataView(out.buffer).setUint32(cursor, adler32(raw));
  return out;
}

function encodePng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  // One filter byte (0 = None) per scanline, ahead of that row's pixels.
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const to = y * (1 + width * 3);
    raw[to] = 0;
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), to + 1);
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibStored(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];

  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    png.set(part, cursor);
    cursor += part.length;
  }
  return png;
}

/** xorshift32, so the plate is stable for a given seed across requests. */
function rng(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 100000) / 100000;
  };
}

function seedFrom(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * A 64x64 plate: two seeded tones smeared across a diagonal with a little
 * grain, so it reads as an unexposed sheet of film rather than a placeholder.
 */
export function developingPlate(seed: string, size = 64): Uint8Array {
  const random = rng(seedFrom(seed));
  const angle = random() * Math.PI * 2;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);

  // Kept inside the app's warm, low-key palette rather than a random hue.
  const warm = [40 + random() * 60, 26 + random() * 26, 18 + random() * 16];
  const cool = [14 + random() * 12, 13 + random() * 10, 16 + random() * 14];

  const rgb = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size - 0.5) * dx + (y / size - 0.5) * dy + 0.5;
      const wave = 0.5 + 0.5 * Math.sin(u * Math.PI * 2.2 + random() * 0.02);
      const grain = (random() - 0.5) * 14;
      const at = (y * size + x) * 3;
      for (let c = 0; c < 3; c++) {
        const value = cool[c] + (warm[c] - cool[c]) * wave + grain;
        rgb[at + c] = Math.max(0, Math.min(255, Math.round(value)));
      }
    }
  }
  return encodePng(size, size, rgb);
}
