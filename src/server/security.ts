import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { LIMITS } from '../shared/constants.js';

/** URL-safe random token; 32 bytes = 256 bits. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// scrypt parameters per the OWASP Password Storage Cheat Sheet
// (N=2^15, r=8, p=3: ~32 MiB per hash). Stored with the hash, so they can be
// raised later without invalidating existing passwords.
const SCRYPT = { N: 2 ** 15, r: 8, p: 3, keyLen: 32 };

function scryptAsync(password: string, salt: Buffer, keyLen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const { N, r, p, keyLen } = SCRYPT;
  const key = await scryptAsync(password.normalize('NFKC'), salt, keyLen, { N, r, p, maxmem: 128 * N * r * 2 + 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const parts = (stored ?? DUMMY_HASH).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![N, r, p].every(Number.isInteger) || N > 2 ** 20 || r > 32 || p > 16) return false;
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  const key = await scryptAsync(password.normalize('NFKC'), salt, expected.length, { N, r, p, maxmem: 128 * N * r * 2 + 1024 * 1024 });
  const ok = timingSafeEqual(key, expected);
  return stored ? ok : false;
}

// Used when the user does not exist, so that the response time does not reveal it.
const DUMMY_HASH = `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${randomBytes(16).toString('base64')}$${randomBytes(32).toString('base64')}`;

const COMMON = new Set([
  'password', 'password1', 'password12', 'password123', 'qwerty1234', 'qwertyuiop', '1234567890', '0123456789',
  '1111111111', 'iloveyou12', 'admin12345', 'welcome123', 'letmein123', 'teamkazakhstan', 'algoritmi1', 'greenspark',
  'kazakhstan', 'qwerty12345', 'abcdefghij', 'parol12345', 'йцукенгшщз',
]);

export type PasswordProblem = 'password_too_short' | 'password_too_long' | 'password_same_as_username' | 'password_too_common';

export function checkPassword(password: string, username?: string | null): PasswordProblem | null {
  const chars = [...password];
  if (chars.length < LIMITS.passwordMin) return 'password_too_short';
  if (chars.length > LIMITS.passwordMax) return 'password_too_long';
  const lower = password.toLowerCase();
  if (username && lower.includes(username.toLowerCase())) return 'password_same_as_username';
  if (COMMON.has(lower) || new Set(chars).size < 4) return 'password_too_common';
  return null;
}
