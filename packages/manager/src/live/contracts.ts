import {Schema} from 'effect';

export const MANAGER_LIVE_VERSION = 1;
export const MANAGER_LIVE_LIMITS = {
  connections: 16,
  tickets: 64,
  ticketLifetimeMilliseconds: 30_000,
  subscriptions: 32,
  queries: 64,
  pendingResources: 16,
  messageBytes: 8_192,
  snapshotBytes: 262_144,
  incomingFrames: 8,
  bufferedBytes: 524_288,
  heartbeatMilliseconds: 15_000,
  clientTimeoutMilliseconds: 45_000,
} as const;

/**
 * The welcome frame is the capability list; a schema name alone is not support.
 * context-maintenance invalidates its status GET, not evidence packets/actions.
 * context-health stays unadvertised until repository source coverage is ready.
 */
export const ManagerLiveProjectTopic = Schema.Literals([
  'context-health',
  'context-maintenance',
  'home',
  'citation-repair-jobs',
  'automatic-memory',
]);
export const ManagerLiveAccountTopic = Schema.Literals([
  'home',
  'share-conflicts',
  'graph-status',
  'processes',
  'model-setup',
  'runtime-updates',
  'worksets',
]);
export const ManagerLiveTopic = Schema.Literals([
  'context-health',
  'context-maintenance',
  'home',
  'citation-repair-jobs',
  'automatic-memory',
  'share-conflicts',
  'graph-status',
  'processes',
  'model-setup',
  'runtime-updates',
  'worksets',
]);
export type ManagerLiveTopic = typeof ManagerLiveTopic.Type;
export const ManagerLiveSnapshotTopic = Schema.Literals(['processes', 'graph-status']);
export type ManagerLiveSnapshotTopic = typeof ManagerLiveSnapshotTopic.Type;
export const MANAGER_LIVE_SNAPSHOT_HEADER = 'x-threadnote-live-snapshots';
export const ManagerLiveSnapshotResource = Schema.Struct({
  topic: ManagerLiveSnapshotTopic,
  scope: Schema.Literal('account'),
});
export const MANAGER_LIVE_SUPPORTED_TOPICS: readonly ManagerLiveTopic[] = [
  'context-health',
  'context-maintenance',
  'home',
  'citation-repair-jobs',
  'automatic-memory',
  'share-conflicts',
  'graph-status',
  'processes',
  'model-setup',
  'runtime-updates',
  'worksets',
];
export const ManagerLiveResource = Schema.Union([
  Schema.Struct({
    topic: ManagerLiveProjectTopic,
    project: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  }),
  Schema.Struct({topic: ManagerLiveAccountTopic, scope: Schema.Literal('account')}),
]);
export type ManagerLiveResource = typeof ManagerLiveResource.Type;
const sequence = Schema.Int.check(Schema.isBetween({minimum: 0, maximum: Number.MAX_SAFE_INTEGER}));
const generation = Schema.Int.check(Schema.isBetween({minimum: 1, maximum: Number.MAX_SAFE_INTEGER}));
const opaque = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const version = Schema.Literal(MANAGER_LIVE_VERSION);

export const ManagerLiveClientFrame = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('subscribe'),
    version,
    generation,
    resources: Schema.Array(ManagerLiveResource).check(Schema.isMaxLength(MANAGER_LIVE_LIMITS.subscriptions)),
  }),
  Schema.Struct({type: Schema.Literal('heartbeat'), version}),
]);
export type ManagerLiveClientFrame = typeof ManagerLiveClientFrame.Type;

export const ManagerLiveServerFrame = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('welcome'),
    version,
    epoch: opaque,
    topics: Schema.Array(ManagerLiveTopic),
    snapshots: Schema.optionalKey(Schema.Array(ManagerLiveSnapshotTopic)),
    heartbeatMilliseconds: Schema.Finite,
  }),
  Schema.Struct({
    type: Schema.Literal('subscribed'),
    version,
    epoch: opaque,
    generation,
    startingSequence: sequence,
    unavailable: Schema.optionalKey(Schema.Array(ManagerLiveResource).check(Schema.isMaxLength(32))),
  }),
  Schema.Struct({
    type: Schema.Literal('invalidation'),
    version,
    epoch: opaque,
    generation,
    sequence,
    resource: ManagerLiveResource,
    revision: opaque,
  }),
  Schema.Struct({type: Schema.Literal('reset'), version, epoch: opaque, generation, sequence}),
  Schema.Struct({
    type: Schema.Literal('snapshot'),
    version,
    epoch: opaque,
    generation,
    sequence,
    resource: ManagerLiveSnapshotResource,
    // These are the same authenticated JSON projections returned by the REST readers.
    data: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal('availability'),
    version,
    epoch: opaque,
    generation,
    sequence,
    resource: ManagerLiveResource,
    available: Schema.Boolean,
  }),
  Schema.Struct({type: Schema.Literal('heartbeat'), version, epoch: opaque}),
]);
export type ManagerLiveServerFrame = typeof ManagerLiveServerFrame.Type;

export function managerLiveResourceKey(resource: ManagerLiveResource): string {
  return 'project' in resource
    ? JSON.stringify(['project', resource.topic, resource.project])
    : JSON.stringify(['account', resource.topic]);
}
