/** Synchronous app-runtime SHA-256; portable package validation keeps its independent implementation. */
export function sha256HexSync(value: string | Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex');
}
