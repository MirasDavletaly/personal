// Minimal POSIX ustar reader/writer for backup archives (regular files only).
// Archives are standard: `tar -tzf backup.tar.gz` lists them on the NAS.

export interface TarFile {
  name: string;
  data: Buffer;
  mtime?: Date;
}

function writeField(buf: Buffer, offset: number, length: number, value: string): void {
  buf.write(value.slice(0, length), offset, length, 'utf8');
}

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  buf.write(value.toString(8).padStart(length - 1, '0'), offset, length - 1, 'ascii');
  buf[offset + length - 1] = 0;
}

export function createTar(files: TarFile[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    if (Buffer.byteLength(f.name) > 100) throw new Error(`tar: name too long: ${f.name}`);
    const h = Buffer.alloc(512, 0);
    writeField(h, 0, 100, f.name);
    writeOctal(h, 100, 8, 0o644);
    writeOctal(h, 108, 8, 0);
    writeOctal(h, 116, 8, 0);
    writeOctal(h, 124, 12, f.data.length);
    writeOctal(h, 136, 12, Math.floor((f.mtime ?? new Date()).getTime() / 1000));
    h.fill(0x20, 148, 156);
    h[156] = 0x30; // '0' regular file
    writeField(h, 257, 6, 'ustar\0');
    writeField(h, 263, 2, '00');
    writeField(h, 265, 32, 'root');
    writeField(h, 297, 32, 'root');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    parts.push(h, f.data);
    const pad = (512 - (f.data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  return Buffer.concat(parts);
}

function readString(buf: Buffer, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? length : end).toString('utf8');
}

export function readTar(buf: Buffer): TarFile[] {
  const files: TarFile[] = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
    const stored = Number.parseInt(readString(h, 148, 8).trim(), 8);
    if (stored !== sum) throw new Error('tar: bad header checksum');
    const prefix = readString(h, 345, 155);
    const base = readString(h, 0, 100);
    const name = prefix ? `${prefix}/${base}` : base;
    const size = Number.parseInt(readString(h, 124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new Error('tar: bad size');
    const type = String.fromCharCode(h[156] || 0x30);
    off += 512;
    if (off + size > buf.length) throw new Error('tar: truncated archive');
    const data = buf.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (type === '0') files.push({ name, data: Buffer.from(data) });
    else if (type === '5' || type === 'x' || type === 'g') continue; // directories, pax headers
    else throw new Error(`tar: unsupported entry type "${type}" for ${name}`);
  }
  return files;
}
