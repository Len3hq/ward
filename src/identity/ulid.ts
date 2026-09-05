import { randomBytes } from "node:crypto";

/**
 * A minimal ULID, no dependency.
 *
 * 26 Crockford base32 characters: 10 of millisecond timestamp (48 bits) then 16 of
 * randomness (80 bits). Lexicographically sortable by creation time, which makes a
 * directory of principals readable in the fs backend and a journal grep-able in
 * order — and unlike a UUIDv4 it carries no hyphens, so it survives being used as
 * an entity name and a file path segment unescaped.
 */

/** Crockford base32: no I, L, O or U, so a principal can be read aloud without ambiguity. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

function encodeTime(now: number): string {
  let time = Math.floor(now);
  let out = "";
  for (let i = 0; i < TIME_CHARS; i++) {
    out = ALPHABET[time % 32]! + out;
    time = Math.floor(time / 32);
  }
  return out;
}

function encodeRandom(): string {
  // One byte per character, masked to 5 bits. Wasteful of entropy, not of security:
  // 16 chars still carry the full 80 bits ULID specifies.
  const bytes = randomBytes(RANDOM_CHARS);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % 32]!;
  return out;
}
