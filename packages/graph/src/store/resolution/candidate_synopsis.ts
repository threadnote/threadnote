import {Array as EffectArray} from 'effect';
import {
  candidateBytesEqual,
  candidatePairHint,
  CANDIDATE_PAGE_PROTOCOL_SHA,
  type CandidatePair,
} from './candidate_pages.js';

import {candidateSynopsis, CANDIDATE_SYNOPSIS_BYTES} from './candidate_synopsis_bits.js';
export {
  candidateSynopsis,
  candidateSynopsisMayContain,
  CANDIDATE_SYNOPSIS_BYTES,
  CANDIDATE_SYNOPSIS_BITS_PER_KEY,
} from './candidate_synopsis_bits.js';

export function candidateSynopsisBinding(
  snapshotKey: number,
  fileKey: number,
  ordinal: number,
  rawSha: string,
  storedSha: string,
  bits: Uint8Array,
): Uint8Array {
  if (
    !EffectArray.every([snapshotKey, fileKey, ordinal], Number.isSafeInteger) ||
    snapshotKey < 1 ||
    fileKey < 1 ||
    ordinal < 0 ||
    bits.byteLength !== CANDIDATE_SYNOPSIS_BYTES
  )
    throw new Error('Candidate synopsis binding is invalid.');
  const hash = new Bun.CryptoHasher('sha256');
  hash.update(JSON.stringify([CANDIDATE_PAGE_PROTOCOL_SHA, snapshotKey, fileKey, ordinal, rawSha, storedSha]));
  hash.update(bits);
  return new Uint8Array(hash.digest());
}

/** Producer/reader use complete original values, never hash equality alone, to validate the synopsis. */
export function candidateSynopsisMatches(bits: Uint8Array, pairs: readonly CandidatePair[]): boolean {
  return candidateBytesEqual(bits, candidateSynopsis(EffectArray.map(pairs, candidatePairHint)));
}
