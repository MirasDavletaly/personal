import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { all, type DB } from './db.js';
import { badRequest } from './errors.js';

/** Every stored photo: 512×512 baseline JPEG, quality 85, no metadata. */
export const PHOTO_SIZE = 512;
const QUALITY = 85;
const MIN_INPUT = 256;
const MAX_INPUT = 4096;

/** Reads width/height from the first SOF marker without decoding the image. */
export function readJpegSize(buf: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1]!;
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS before any SOF
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

/** Crops the centre square of an RGBA image and resamples it to size×size. */
function cropResize(src: Uint8Array, srcW: number, srcH: number, size: number): Uint8Array {
  const side = Math.min(srcW, srcH);
  const x0 = Math.floor((srcW - side) / 2);
  const y0 = Math.floor((srcH - side) / 2);
  const out = new Uint8Array(size * size * 4);
  const scale = side / size;
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      let r = 0;
      let g = 0;
      let b = 0;
      if (scale >= 1) {
        // Downscale: average of the covered source area (box filter).
        const sx0 = x0 + dx * scale;
        const sy0 = y0 + dy * scale;
        const sx1 = sx0 + scale;
        const sy1 = sy0 + scale;
        let wsum = 0;
        for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy++) {
          const wy = Math.min(sy + 1, sy1) - Math.max(sy, sy0);
          if (wy <= 0) continue;
          for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx++) {
            const wx = Math.min(sx + 1, sx1) - Math.max(sx, sx0);
            if (wx <= 0) continue;
            const w = wx * wy;
            const i = (sy * srcW + sx) * 4;
            r += src[i]! * w;
            g += src[i + 1]! * w;
            b += src[i + 2]! * w;
            wsum += w;
          }
        }
        r /= wsum;
        g /= wsum;
        b /= wsum;
      } else {
        // Upscale: bilinear interpolation.
        const fx = Math.min(x0 + side - 1, Math.max(x0, x0 + (dx + 0.5) * scale - 0.5));
        const fy = Math.min(y0 + side - 1, Math.max(y0, y0 + (dy + 0.5) * scale - 0.5));
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const ix1 = Math.min(ix + 1, x0 + side - 1);
        const iy1 = Math.min(iy + 1, y0 + side - 1);
        const tx = fx - ix;
        const ty = fy - iy;
        for (let c = 0; c < 3; c++) {
          const p00 = src[(iy * srcW + ix) * 4 + c]!;
          const p10 = src[(iy * srcW + ix1) * 4 + c]!;
          const p01 = src[(iy1 * srcW + ix) * 4 + c]!;
          const p11 = src[(iy1 * srcW + ix1) * 4 + c]!;
          const v = (p00 * (1 - tx) + p10 * tx) * (1 - ty) + (p01 * (1 - tx) + p11 * tx) * ty;
          if (c === 0) r = v;
          else if (c === 1) g = v;
          else b = v;
        }
      }
      const o = (dy * size + dx) * 4;
      out[o] = Math.round(r);
      out[o + 1] = Math.round(g);
      out[o + 2] = Math.round(b);
      out[o + 3] = 255;
    }
  }
  return out;
}

/**
 * Validates an uploaded JPEG and produces the normalised photo. The output is
 * encoded from raw pixels, so EXIF, GPS, ICC and any other metadata or
 * trailing data of the upload are not carried over.
 */
export function processPhoto(input: Buffer): Buffer {
  if (input.length < 200 || input[0] !== 0xff || input[1] !== 0xd8 || input[2] !== 0xff) {
    throw badRequest('photo_not_jpeg', 'The photo must be a JPEG image');
  }
  const size = readJpegSize(input);
  if (!size) throw badRequest('photo_invalid', 'The image could not be read');
  if (size.width < MIN_INPUT || size.height < MIN_INPUT) throw badRequest('photo_too_small', 'The image is too small');
  if (size.width > MAX_INPUT || size.height > MAX_INPUT) throw badRequest('photo_too_large', 'The image is too large');
  let img: { width: number; height: number; data: Uint8Array };
  try {
    img = jpeg.decode(input, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 17, maxMemoryUsageInMB: 160 });
  } catch {
    throw badRequest('photo_invalid', 'The image could not be read');
  }
  if (img.width !== size.width || img.height !== size.height) throw badRequest('photo_invalid', 'The image could not be read');
  const pixels = cropResize(img.data, img.width, img.height, PHOTO_SIZE);
  return Buffer.from(jpeg.encode({ data: pixels, width: PHOTO_SIZE, height: PHOTO_SIZE }, QUALITY).data);
}

export function isPhotoId(id: string): boolean {
  return /^[a-f0-9]{32}$/.test(id);
}

export function photoPath(dir: string, id: string): string {
  if (!isPhotoId(id)) throw new Error('bad photo id');
  return path.join(dir, `${id}.jpg`);
}

/** Writes atomically (temp file + rename) and returns the new random id. */
export function storePhoto(dir: string, data: Buffer): string {
  mkdirSync(dir, { recursive: true });
  const id = randomBytes(16).toString('hex');
  const tmp = path.join(dir, `.${id}.tmp`);
  writeFileSync(tmp, data, { mode: 0o640 });
  renameSync(tmp, photoPath(dir, id));
  return id;
}

/**
 * Deletes photo files no employee references any more. Replaced photos are kept
 * for minAgeMs first, so that a backup taken meanwhile still finds every photo
 * its database snapshot refers to.
 */
export function collectPhotoGarbage(db: DB, dir: string, minAgeMs: number): number {
  if (!existsSync(dir)) return 0;
  const referenced = new Set(all<{ photo_id: string }>(db, 'SELECT photo_id FROM employees WHERE photo_id IS NOT NULL').map((r) => r.photo_id));
  const now = Date.now();
  let removed = 0;
  for (const name of readdirSync(dir)) {
    const m = /^\.?([a-f0-9]{32})\.(jpg|tmp)$/.exec(name);
    if (!m || (m[2] === 'jpg' && referenced.has(m[1]!))) continue;
    const file = path.join(dir, name);
    try {
      if (now - statSync(file).mtimeMs >= minAgeMs) {
        unlinkSync(file);
        removed++;
      }
    } catch {
      /* removed concurrently */
    }
  }
  return removed;
}
