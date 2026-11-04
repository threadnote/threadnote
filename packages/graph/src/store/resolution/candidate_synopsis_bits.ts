export const CANDIDATE_SYNOPSIS_BYTES = 128;
export const CANDIDATE_SYNOPSIS_BITS_PER_KEY = 8;

/** All eight offsets use the complete existing128-bit hint. Collisions only add positive pages. */
export function candidateSynopsis(hints: Iterable<Uint8Array>): Uint8Array {
  const bits = new Uint8Array(CANDIDATE_SYNOPSIS_BYTES);
  for (const hint of hints) {
    if (hint.byteLength !== 16) throw new Error('Candidate synopsis requires the complete128-bit hint.');
    for (let i = 0; i < 16; i += 2) {
      const offset = ((hint[i] << 8) | hint[i + 1]) & 1023;
      bits[offset >>> 3] |= 1 << (offset & 7);
    }
  }
  return bits;
}

export function candidateSynopsisMayContain(bits: Uint8Array, hint: Uint8Array): boolean {
  if (bits.byteLength !== CANDIDATE_SYNOPSIS_BYTES || hint.byteLength !== 16)
    throw new Error('Candidate synopsis is truncated.');
  let possible = true;
  // Deliberately execute all8 tests: the charged logical/bit work is independent of early negatives.
  for (let i = 0; i < 16; i += 2) {
    const offset = ((hint[i] << 8) | hint[i + 1]) & 1023;
    if ((bits[offset >>> 3] & (1 << (offset & 7))) === 0) possible = false;
  }
  return possible;
}
