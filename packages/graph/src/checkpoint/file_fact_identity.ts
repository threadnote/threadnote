import {sha256HexSync} from '@threadnote/platform/sha256';
import type {CodeGraphFileFacts} from '../types.js';
import {canonicalJson} from './canonical_json.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const CHECKPOINT_FILE_FACT_IDENTITY_DOMAIN = 'threadnote-code-graph-checkpoint-file-fact-v1\0';

/** Exact portable identity for one already-validated materialized file fact. */
export function codeGraphCheckpointFileFactCacheIdentity(facts: CodeGraphFileFacts): string {
  return `cgfd_${Effect.pipe(sha256HexSync(`${CHECKPOINT_FILE_FACT_IDENTITY_DOMAIN}${canonicalJson(facts)}`), EffectString.slice(0, 40))}`;
}
