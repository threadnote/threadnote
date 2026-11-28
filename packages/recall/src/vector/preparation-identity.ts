import {Effect, Record as EffectRecord, String as EffectString} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {loadExternalResourceAccess} from '@threadnote/store/external-resource';
import {RECALL_CHUNKER_VERSION} from '../chunker.js';

export const RECALL_PREPARATION_PREFIX = 'idle-recall-v2:';
export const recallVectorAuthorizationKey = (resources: Readonly<Record<string, unknown>>) =>
  sha256HexSync(
    JSON.stringify(
      EffectRecord.toEntries(resources).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    ),
  );

export const loadRecallVectorAuthorizationKey = Effect.fn('recall.vectorAuthorizationKey')(function* (config: {
  readonly agentContextHome: string;
  readonly account?: string;
  readonly user?: string;
}) {
  const resources =
    config.account !== undefined && config.user !== undefined
      ? yield* loadExternalResourceAccess({home: config.agentContextHome, account: config.account, user: config.user})
      : {};
  return recallVectorAuthorizationKey(resources);
});

export function recallVectorPreparationIdentity(
  corpus: string,
  authorization: string,
  modelId: string,
  recipe: string,
) {
  return [corpus, authorization, modelId, recipe, RECALL_CHUNKER_VERSION] as const;
}
export function recallVectorPreparationJobId(identity: ReturnType<typeof recallVectorPreparationIdentity>) {
  return RECALL_PREPARATION_PREFIX + sha256HexSync(JSON.stringify(['idle-recall-v2', ...identity]));
}
/**
 * The job id a delta target holds until activation. Older binaries look targets up by the real job id and do
 * not know the copy state, so they must never find an unfinished delta.
 */
export const RECALL_DELTA_JOB_PREFIX = 'delta:';
export function recallVectorDeltaJobId(jobId: string) {
  return RECALL_DELTA_JOB_PREFIX + jobId;
}
export function recallVectorPreparationMatches(
  jobId: string,
  identity: ReturnType<typeof recallVectorPreparationIdentity>,
) {
  return !EffectString.startsWith(RECALL_PREPARATION_PREFIX)(jobId) || jobId === recallVectorPreparationJobId(identity);
}
