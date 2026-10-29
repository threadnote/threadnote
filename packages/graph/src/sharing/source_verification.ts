import {Array as EffectArray} from 'effect';
import {Effect} from 'effect';
import {canonicalJson} from '../checkpoint/canonical_json.js';
import {serializeBoundedCodeGraphFact} from '../fact/budget.js';
import type {CodeGraphSourceVerification} from '../indexer/types.js';
import type {CodeGraphFileFacts, CodeGraphInventoryFile} from '../types.js';
import {graphShareLanguageAndRole, graphShareParseActionKey} from './action.js';
import type {Sha256Digest} from './digest.js';
import {sha256Digest} from './digest.js';
import {graphSharingFailure} from './errors.js';
import type {VerifiedGraphShareParseReceipt} from './parse/cache.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export interface GraphShareSourceUseEvidence {
  readonly consumedActions: number;
  readonly consumedResultManifestDigests: readonly Sha256Digest[];
  readonly sourceVerifiedFiles: number;
}

/** Signed worker receipts carry the full producing commit; legacy receipts carry only batchId. */
export type GraphShareSourceVerifiedReceipt = VerifiedGraphShareParseReceipt & {
  readonly sourceCommit?: string;
};

/** Attempt-local proof. Raw cache contents alone never establish source provenance. */
export function makeGraphShareSourceVerification(input: {
  readonly repositoryId: string;
  readonly sourceCommit: string;
  readonly verified: readonly GraphShareSourceVerifiedReceipt[];
}): {
  readonly hooks: CodeGraphSourceVerification;
  readonly complete: () => Effect.Effect<GraphShareSourceUseEvidence, unknown>;
} {
  const selected = new Map<string, GraphShareSourceVerifiedReceipt>();
  const fresh = new Map<string, {readonly context: string; readonly digest: Sha256Digest}>();
  const consumed = new Map<string, Sha256Digest>();
  let initialized = false;
  const initialize = () => {
    if (initialized) return;
    for (const item of input.verified) {
      const producingCommit = item.sourceCommit ?? item.announcement.batchId;
      if (
        producingCommit !== input.sourceCommit ||
        item.announcement.batchId !== Effect2.pipe(producingCommit, EffectString.slice(0, 40)) ||
        item.parsed.repositoryId !== input.repositoryId
      ) {
        throw graphSharingFailure('Contribution does not belong to the exact publication source target.');
      }
      const previous = selected.get(item.parsed.normalizedPath);
      if (previous && previous.announcement.resultManifestDigest !== item.announcement.resultManifestDigest) {
        throw graphSharingFailure('Publication selected conflicting results for one source path.');
      }
      selected.set(item.parsed.normalizedPath, item);
    }
    initialized = true;
  };
  const digest = (facts: CodeGraphFileFacts) => sha256Digest(canonicalJson(facts));
  const context = (file: CodeGraphInventoryFile) =>
    canonicalJson({
      blobId: file.blobId,
      contentHash: file.contentHash,
      language: file.language,
      mode: file.mode,
      path: file.path,
      source: file.source,
    });
  const hooks: CodeGraphSourceVerification = {
    observeParserBatch: group =>
      sourceVerificationAttempt(() => {
        initialize();
        const factsByPath = new Map(EffectArray.map(group.facts, fact => [fact.facts.path, fact]));
        for (const file of group.files) {
          const local = factsByPath.get(file.path);
          if (!local || file.source !== 'commit') {
            throw graphSharingFailure('Source verification requires fresh committed parser facts.');
          }
          const observed = {context: context(file), digest: digest(local.facts)};
          const previous = fresh.get(file.path);
          if (previous && (previous.context !== observed.context || previous.digest !== observed.digest)) {
            throw graphSharingFailure('Source facts changed within the publication attempt.');
          }
          const item = selected.get(file.path);
          if (item) {
            const parsed = item.parsed;
            const languageAndRole = graphShareLanguageAndRole(file.language, 'source');
            const actionKey = graphShareParseActionKey({
              contentHash: file.contentHash,
              extractorSet: group.cacheIdentity,
              languageAndRole,
              normalizedPath: file.path,
              repositoryId: input.repositoryId,
            });
            if (
              parsed.actionKey !== actionKey ||
              item.announcement.actionKey !== actionKey ||
              parsed.gitBlobId !== file.blobId ||
              parsed.contentHash !== file.contentHash ||
              parsed.extractorSet !== group.cacheIdentity ||
              parsed.languageAndRole !== languageAndRole ||
              digest(parsed.facts) !== observed.digest
            ) {
              throw graphSharingFailure(
                'Contribution does not match independently parsed source facts and action context.',
              );
            }
            const bounded = serializeBoundedCodeGraphFact(parsed.facts);
            if (digest(bounded.facts) !== observed.digest) {
              throw graphSharingFailure('Contribution changes at the bounded fact representation boundary.');
            }
          }
          fresh.set(file.path, observed);
        }
      }),
    materializeFacts: batch =>
      sourceVerificationAttempt(() => {
        initialize();
        const output = new Map(batch.facts);
        for (const file of batch.files) {
          const local = batch.facts.get(file.path);
          const observed = fresh.get(file.path);
          if (!local || !observed || observed.context !== context(file) || digest(local) !== observed.digest) {
            throw graphSharingFailure('Assembly input lacks matching fresh-source evidence from this attempt.');
          }
          const item = selected.get(file.path);
          if (!item) continue;
          // Use the original payload's complete bounded value, never a rewritten or locally generated receipt.
          const original = serializeBoundedCodeGraphFact(item.parsed.facts).facts;
          if (digest(original) !== observed.digest) {
            throw graphSharingFailure('Original contribution changed before assembly consumption.');
          }
          output.set(file.path, original);
          consumed.set(item.parsed.actionKey, item.announcement.resultManifestDigest);
        }
        return output;
      }),
  };
  return {
    hooks,
    // Call only after a successful ready assembly. A failed/interrupted attempt must discard this object.
    complete: () =>
      sourceVerificationAttempt(() => {
        initialize();
        if (selected.size !== consumed.size) {
          throw graphSharingFailure('Publication did not consume every selected contribution.');
        }
        return {
          consumedActions: consumed.size,
          consumedResultManifestDigests: [...consumed.values()].sort(),
          sourceVerifiedFiles: fresh.size,
        };
      }),
  };
}

function sourceVerificationAttempt<A>(body: () => A) {
  return Effect.try({
    try: body,
    catch: cause => graphSharingFailure('Contribution source verification failed.', cause),
  });
}
