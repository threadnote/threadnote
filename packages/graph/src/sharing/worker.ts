import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Path} from 'effect';
import {GRAPH_SHARE_ACTION_KEY, type GraphShareActionKey} from './action.js';
import {readJsonFile} from './atomic.js';
import {graphSharingFailure} from './errors.js';
import {GRAPH_SHARE_GIT_OBJECT_ID} from './git.js';
import {graphSharingLayout, graphSharingWorkerWorkPath} from './layout.js';

export interface GraphShareWorkerAdvertisement {
  readonly actionKey: GraphShareActionKey;
  readonly gitBlobId: string;
}

export interface GraphShareWorkerPlan {
  readonly eligible: readonly GraphShareWorkerAdvertisement[];
  readonly skippedMissingBlob: readonly GraphShareWorkerAdvertisement[];
}

export function planGraphWorkerActions(
  advertised: readonly GraphShareWorkerAdvertisement[],
  presentBlobIds: ReadonlySet<string>,
): GraphShareWorkerPlan {
  const eligible: GraphShareWorkerAdvertisement[] = [];
  const skippedMissingBlob: GraphShareWorkerAdvertisement[] = [];
  for (const action of advertised) {
    if (presentBlobIds.has(action.gitBlobId)) eligible.push(action);
    else skippedMissingBlob.push(action);
  }
  return {eligible, skippedMissingBlob};
}

export const GRAPH_SHARE_WORKER_ADVERTISEMENT_LIMIT = 4_096;

export function parseGraphShareWorkerAdvertisements(value: unknown): readonly GraphShareWorkerAdvertisement[] {
  if (!EffectArray.isArray(value) || value.length > GRAPH_SHARE_WORKER_ADVERTISEMENT_LIMIT) {
    throw graphSharingFailure('Worker advertisement list is invalid.');
  }
  return EffectArray.map(value, parseAdvertisement);
}

export const readAdvertisedGraphWorkerActions = Effect.fn('codeGraph.sharing.readAdvertisedWorkerActions')(function* (
  threadnoteHome: string,
  repositoryId: string,
  casRoot?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workPath = graphSharingWorkerWorkPath(
    path,
    graphSharingLayout(path, threadnoteHome, casRoot).workerRoot,
    repositoryId,
  );
  if (!(yield* fs.exists(workPath))) return [];
  return parseGraphShareWorkerAdvertisements(yield* readJsonFile(workPath));
});

function parseAdvertisement(value: unknown): GraphShareWorkerAdvertisement {
  if (!isRecord(value) || typeof value.actionKey !== 'string' || typeof value.gitBlobId !== 'string') {
    throw graphSharingFailure('Worker advertisement is invalid.');
  }
  if (!GRAPH_SHARE_ACTION_KEY.test(value.actionKey) || !GRAPH_SHARE_GIT_OBJECT_ID.test(value.gitBlobId)) {
    throw graphSharingFailure('Worker advertisement is invalid.');
  }
  return {actionKey: value.actionKey, gitBlobId: value.gitBlobId};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}
