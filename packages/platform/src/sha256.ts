/** Hashes UTF-8 text or the exact bytes in a view with synchronous SHA-256. */
export function sha256HexSync(value: string | Uint8Array): string {
  return Bun.SHA256.hash(value, 'hex');
}
