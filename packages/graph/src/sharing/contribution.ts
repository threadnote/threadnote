import {Array as EffectArray} from 'effect';
import {Clock, Effect, FileSystem, Option, Path} from 'effect';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {readJsonFile, writePrivateJsonFile} from './atomic.js';
import {SHA256_DIGEST, parseSha256Digest} from './digest.js';
import {graphSharingFailure} from './errors.js';
import {graphSharingContributionQueuePath, graphSharingLayout} from './layout.js';
import {GRAPH_SHARE_ACTION_KEY} from './action.js';
import type {GraphShareResultAnnouncementV1} from './receipts.js';
import * as EffectRecord from 'effect/Record';

export const GRAPH_SHARE_CONTRIBUTION_MODES = ['off', 'passive', 'idle', 'dedicated'] as const;
export type GraphShareContributionMode = (typeof GRAPH_SHARE_CONTRIBUTION_MODES)[number];
export const GRAPH_SHARE_QUEUE_MAXIMUM_ANNOUNCEMENTS = 512;
export const GRAPH_SHARE_QUEUE_MAXIMUM_BYTES = 512 * 1_024;
export const GRAPH_SHARE_QUEUE_MAXIMUM_AGE_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;

export interface GraphShareContributionQueueV1 {
  readonly announcements: readonly GraphShareResultAnnouncementV1[];
  readonly mode: GraphShareContributionMode;
  readonly queuedAtMilliseconds?: readonly number[];
  readonly schemaVersion: 1;
}

export function emptyGraphShareContributionQueue(
  mode: GraphShareContributionMode = 'off',
): GraphShareContributionQueueV1 {
  return {announcements: [], mode, schemaVersion: 1};
}

export function effectiveGraphShareContributionMode(
  accessMode: 'join' | 'read-only' | undefined,
  requested: GraphShareContributionMode,
): GraphShareContributionMode {
  if (accessMode !== 'join') return 'off';
  if (requested === 'idle' || requested === 'dedicated') return 'passive';
  return requested;
}

export function effectiveGraphShareContributionPolicy(
  accessMode: 'join' | 'read-only' | undefined,
  requested: GraphShareContributionMode,
  maximumUploadBytesPerSecond: number,
) {
  const mode = effectiveGraphShareContributionMode(accessMode, requested);
  return {
    activeResourceLimitsEnforced: false,
    declaredMaximumUploadBytesPerSecond: maximumUploadBytesPerSecond,
    deliveryPausedReason:
      mode === 'off'
        ? ('mode-off' as const)
        : maximumUploadBytesPerSecond === 0
          ? ('organization-upload-disabled' as const)
          : undefined,
    mode,
    positiveUploadRateLimitEnforced: false,
  };
}

export function enqueueGraphShareContribution(
  queue: GraphShareContributionQueueV1,
  announcement: GraphShareResultAnnouncementV1,
  accessMode: 'join' | 'read-only' | undefined,
  nowMilliseconds?: number,
): {readonly conflict: boolean; readonly queued: boolean; readonly queue: GraphShareContributionQueueV1} {
  const mode = effectiveGraphShareContributionMode(accessMode, queue.mode);
  if (mode === 'off') return {conflict: false, queued: false, queue};
  const duplicate = EffectArray.some(
    queue.announcements,
    item =>
      item.actionKey === announcement.actionKey &&
      item.resultManifestDigest === announcement.resultManifestDigest &&
      item.attestationDigest === announcement.attestationDigest &&
      item.semanticDigest === announcement.semanticDigest,
  );
  if (duplicate) return {conflict: false, queued: false, queue};
  const conflict = EffectArray.some(
    queue.announcements,
    item => item.actionKey === announcement.actionKey && item.semanticDigest !== announcement.semanticDigest,
  );
  const timestamp = nowMilliseconds ?? queue.queuedAtMilliseconds?.at(-1);
  return {
    conflict,
    queued: true,
    queue: {
      ...queue,
      announcements: [...queue.announcements, announcement],
      mode,
      ...(timestamp === undefined
        ? {}
        : {
            queuedAtMilliseconds: [
              ...(queue.queuedAtMilliseconds ?? EffectArray.map(queue.announcements, () => timestamp)),
              timestamp,
            ],
          }),
    },
  };
}

export function pruneGraphShareContributionQueue(
  queue: GraphShareContributionQueueV1,
  nowMilliseconds: number,
): GraphShareContributionQueueV1 {
  const timestamps = queue.queuedAtMilliseconds ?? EffectArray.map(queue.announcements, () => nowMilliseconds);
  let retained = EffectArray.filter(
    EffectArray.map(queue.announcements, (announcement, index) => ({
      announcement,
      timestamp: Math.min(nowMilliseconds, timestamps[index]),
    })),
    item => item.timestamp >= nowMilliseconds - GRAPH_SHARE_QUEUE_MAXIMUM_AGE_MILLISECONDS,
  ).slice(-GRAPH_SHARE_QUEUE_MAXIMUM_ANNOUNCEMENTS);
  const materialize = (): GraphShareContributionQueueV1 => ({
    ...queue,
    announcements: EffectArray.map(retained, item => item.announcement),
    queuedAtMilliseconds: EffectArray.map(retained, item => item.timestamp),
  });
  let result = materialize();
  while (
    retained.length > 0 &&
    new TextEncoder().encode(JSON.stringify(result)).byteLength > GRAPH_SHARE_QUEUE_MAXIMUM_BYTES
  ) {
    retained = retained.slice(1);
    result = materialize();
  }
  return result;
}

export function drainGraphShareContribution(queue: GraphShareContributionQueueV1): {
  readonly remaining: GraphShareContributionQueueV1;
  readonly sent: readonly GraphShareResultAnnouncementV1[];
} {
  return {
    remaining: {
      ...queue,
      announcements: [],
      ...(queue.queuedAtMilliseconds === undefined ? {} : {queuedAtMilliseconds: []}),
    },
    sent: queue.announcements,
  };
}

export function parseGraphShareContributionQueue(value: unknown): GraphShareContributionQueueV1 {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw graphSharingFailure('Contribution queue is invalid.');
  }
  if (!isContributionMode(value.mode) || !EffectArray.isArray(value.announcements)) {
    throw graphSharingFailure('Contribution queue is invalid.');
  }
  if (
    value.queuedAtMilliseconds !== undefined &&
    (!EffectArray.isArray(value.queuedAtMilliseconds) ||
      value.queuedAtMilliseconds.length !== value.announcements.length ||
      EffectArray.some(
        value.queuedAtMilliseconds,
        timestamp => typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp < 0,
      ))
  )
    throw graphSharingFailure('Contribution queue timestamps are invalid.');
  return {
    announcements: EffectArray.map(value.announcements, parseQueuedAnnouncement),
    mode: value.mode,
    schemaVersion: 1,
    ...(value.queuedAtMilliseconds === undefined
      ? {}
      : {
          queuedAtMilliseconds: EffectArray.map(value.queuedAtMilliseconds, timestamp => {
            if (typeof timestamp !== 'number') throw graphSharingFailure('Contribution queue timestamps are invalid.');
            return timestamp;
          }),
        }),
  };
}

export const readGraphShareContributionQueue = Effect.fn('codeGraph.sharing.readContributionQueue')(function* (
  threadnoteHome: string,
  repositoryId: string,
  mode: GraphShareContributionMode,
) {
  return pruneGraphShareContributionQueue(
    yield* readContributionQueueDocument(threadnoteHome, repositoryId, mode),
    yield* Clock.currentTimeMillis,
  );
});

const readContributionQueueDocument = Effect.fn('codeGraph.sharing.readContributionQueueDocument')(function* (
  threadnoteHome: string,
  repositoryId: string,
  mode: GraphShareContributionMode,
  recoverOversized = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const queuePath = graphSharingContributionQueuePath(
    path,
    graphSharingLayout(path, threadnoteHome).root,
    repositoryId,
  );
  if (!(yield* fs.exists(queuePath))) return emptyGraphShareContributionQueue(mode);
  const stat = yield* fs.stat(queuePath);
  if (Number(stat.size) > 4 * 1_024 * 1_024) {
    if (!recoverOversized) return yield* graphSharingFailure('Contribution queue exceeds the metadata read limit.');
    // Callers enabling recovery hold the queue mutation lock. Preserve one legacy backlog without decoding it.
    yield* fs.rename(queuePath, `${queuePath}.oversized`);
    yield* fs.chmod(`${queuePath}.oversized`, 0o600);
    const empty = emptyGraphShareContributionQueue(mode);
    yield* writeGraphShareContributionQueue(threadnoteHome, repositoryId, empty);
    return empty;
  }
  const queue = parseGraphShareContributionQueue(yield* readJsonFile(queuePath));
  const now = yield* Clock.currentTimeMillis;
  const modified = Option.isSome(stat.mtime) ? Math.min(now, stat.mtime.value.getTime()) : now;
  return {
    ...queue,
    queuedAtMilliseconds:
      queue.queuedAtMilliseconds ?? EffectArray.map(queue.announcements, () => Math.max(0, modified)),
  };
});

export const prunePersistedGraphShareContributionQueue = Effect.fn('codeGraph.sharing.pruneContributionQueue')(
  function* (threadnoteHome: string, repositoryId: string, mode: GraphShareContributionMode) {
    yield* withContributionQueueLock(
      threadnoteHome,
      repositoryId,
      Effect.gen(function* () {
        const current = yield* readContributionQueueDocument(threadnoteHome, repositoryId, mode, true);
        const pruned = pruneGraphShareContributionQueue(current, yield* Clock.currentTimeMillis);
        if (current.announcements.length > 0 && JSON.stringify(current) !== JSON.stringify(pruned)) {
          yield* writeGraphShareContributionQueue(threadnoteHome, repositoryId, pruned);
        }
      }),
    );
  },
);

export const writeGraphShareContributionQueue = Effect.fn('codeGraph.sharing.writeContributionQueue')(function* (
  threadnoteHome: string,
  repositoryId: string,
  queue: GraphShareContributionQueueV1,
) {
  const path = yield* Path.Path;
  yield* writePrivateJsonFile(
    graphSharingContributionQueuePath(path, graphSharingLayout(path, threadnoteHome).root, repositoryId),
    queue,
  );
  return queue;
});

export const enqueuePersistedGraphShareContribution = Effect.fn('codeGraph.sharing.enqueuePersistedContribution')(
  function* (
    threadnoteHome: string,
    repositoryId: string,
    accessMode: 'join' | 'read-only' | undefined,
    announcement: GraphShareResultAnnouncementV1,
    mode: GraphShareContributionMode,
  ) {
    return yield* withContributionQueueLock(
      threadnoteHome,
      repositoryId,
      Effect.gen(function* () {
        const current = pruneGraphShareContributionQueue(
          yield* readContributionQueueDocument(threadnoteHome, repositoryId, mode, true),
          yield* Clock.currentTimeMillis,
        );
        const now = yield* Clock.currentTimeMillis;
        const enqueued = enqueueGraphShareContribution({...current, mode}, announcement, accessMode, now);
        const next = {...enqueued, queue: pruneGraphShareContributionQueue(enqueued.queue, now)};
        if (next.queued) yield* writeGraphShareContributionQueue(threadnoteHome, repositoryId, next.queue);
        return next;
      }),
    );
  },
);

export const acknowledgeGraphShareContributions = Effect.fn('codeGraph.sharing.acknowledgeContributions')(function* (
  threadnoteHome: string,
  repositoryId: string,
  sent: readonly GraphShareResultAnnouncementV1[],
  mode: GraphShareContributionMode,
) {
  if (sent.length === 0) return;
  yield* withContributionQueueLock(
    threadnoteHome,
    repositoryId,
    Effect.gen(function* () {
      const current = pruneGraphShareContributionQueue(
        yield* readContributionQueueDocument(threadnoteHome, repositoryId, mode, true),
        yield* Clock.currentTimeMillis,
      );
      const remaining = removeAcknowledgedGraphShareContributions(current, sent);
      if (remaining.announcements.length !== current.announcements.length) {
        yield* writeGraphShareContributionQueue(threadnoteHome, repositoryId, remaining);
      }
    }),
  );
});

export function removeAcknowledgedGraphShareContributions(
  queue: GraphShareContributionQueueV1,
  sent: readonly GraphShareResultAnnouncementV1[],
): GraphShareContributionQueueV1 {
  const acknowledged = new Set(EffectArray.map(sent, announcementIdentity));
  const retained = EffectArray.filter(
    EffectArray.map(queue.announcements, (item, index) => ({item, index})),
    ({item}) => !acknowledged.has(announcementIdentity(item)),
  );
  return {
    ...queue,
    announcements: EffectArray.map(retained, ({item}) => item),
    ...(queue.queuedAtMilliseconds === undefined
      ? {}
      : {queuedAtMilliseconds: EffectArray.map(retained, ({index}) => queue.queuedAtMilliseconds![index])}),
  };
}

function announcementIdentity(item: GraphShareResultAnnouncementV1): string {
  return JSON.stringify([
    item.actionKey,
    item.attestationDigest,
    item.batchId,
    item.resultManifestDigest,
    item.semanticDigest,
  ]);
}

function withContributionQueueLock<A, E, R>(
  threadnoteHome: string,
  repositoryId: string,
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const queuePath = graphSharingContributionQueuePath(
      path,
      graphSharingLayout(path, threadnoteHome).root,
      repositoryId,
    );
    yield* fs.makeDirectory(path.dirname(queuePath), {recursive: true, mode: 0o700});
    return yield* withExclusiveFileLock(
      fs,
      `${queuePath}.lock`,
      {retryIntervalMilliseconds: 25, staleAfterMilliseconds: 30_000, waitTimeoutMilliseconds: 30_000},
      effect,
    );
  });
}

function parseQueuedAnnouncement(value: unknown): GraphShareResultAnnouncementV1 {
  if (!isRecord(value)) throw graphSharingFailure('Contribution announcement is invalid.');
  if (typeof value.actionKey !== 'string' || !GRAPH_SHARE_ACTION_KEY.test(value.actionKey)) {
    throw graphSharingFailure('Contribution announcement action key is invalid.');
  }
  if (typeof value.batchId !== 'string' || !/^[0-9a-f]{40}$/u.test(value.batchId)) {
    throw graphSharingFailure('Contribution announcement batch is invalid.');
  }
  if (typeof value.attestationDigest !== 'string' || !SHA256_DIGEST.test(value.attestationDigest)) {
    throw graphSharingFailure('Contribution announcement attestation digest is invalid.');
  }
  if (typeof value.resultManifestDigest !== 'string' || !SHA256_DIGEST.test(value.resultManifestDigest)) {
    throw graphSharingFailure('Contribution announcement result digest is invalid.');
  }
  if (typeof value.semanticDigest !== 'string' || !SHA256_DIGEST.test(value.semanticDigest)) {
    throw graphSharingFailure('Contribution announcement semantic digest is invalid.');
  }
  const announcement: GraphShareResultAnnouncementV1 = {
    actionKey: value.actionKey,
    attestationDigest: parseSha256Digest(value.attestationDigest, 'Contribution announcement attestation digest'),
    batchId: value.batchId,
    resultManifestDigest: parseSha256Digest(value.resultManifestDigest, 'Contribution announcement result digest'),
    semanticDigest: parseSha256Digest(value.semanticDigest, 'Contribution announcement semantic digest'),
  };
  if (JSON.stringify(EffectRecord.keys(value).sort()) !== JSON.stringify(EffectRecord.keys(announcement).sort())) {
    throw graphSharingFailure('Contribution announcement contains unsupported fields.');
  }
  return announcement;
}

function isContributionMode(value: unknown): value is GraphShareContributionMode {
  return typeof value === 'string' && (GRAPH_SHARE_CONTRIBUTION_MODES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}
