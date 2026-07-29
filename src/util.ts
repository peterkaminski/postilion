// Small pure helpers: tokens, hashing, day keys. Kept dependency-free so they
// unit-test without a Workers runtime.

const HEX = "0123456789abcdef";

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += HEX[b >> 4] + HEX[b & 0xf];
  return out;
}

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

// 6-digit PIN, zero-padded, from rejection-sampled CSPRNG (no modulo bias).
export function randomPin(): string {
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < 4_000_000_000) return String(buf[0] % 1_000_000).padStart(6, "0");
  }
}

// Signup passcodes: grouped base32-ish, unambiguous alphabet (no 0/O/1/I).
const PASSCODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export function randomPasscode(): string {
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  let s = "";
  for (let i = 0; i < 12; i++) {
    if (i > 0 && i % 4 === 0) s += "-";
    s += PASSCODE_ALPHABET[buf[i] % PASSCODE_ALPHABET.length];
  }
  return s;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return bytesToHex(new Uint8Array(digest));
}

// UTC day key for quota counters, e.g. "2026-07-29".
export function dayKeyUTC(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
}

// message_id for messages we mint: ULID-flavored (time-sortable, random tail).
export function mintMessageId(now: Date = new Date()): string {
  return `msg-${now.getTime().toString(36)}-${randomToken(8)}`;
}

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
