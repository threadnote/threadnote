import {Schema} from 'effect';

const ApiSchema320 = Schema.Union([Schema.Undefined, Schema.String]);
const ApiSchema109 = Schema.Union([Schema.Undefined, Schema.Finite]);
const ApiSchema8372 = Schema.Union([
  Schema.Literal('registering'),
  Schema.Literal('sharing'),
  Schema.Literal('waiting'),
  Schema.Literal('reclaiming'),
  Schema.Literal('scanning'),
  Schema.Literal('materializing'),
  Schema.Literal('resolving'),
  Schema.Literal('activating'),
  Schema.Literal('embedding'),
]);
const ApiSchema8390 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('database-writer'),
  Schema.Literal('disk-capacity'),
  Schema.Literal('home-builder-cap'),
  Schema.Literal('prepared-spool-budget'),
  Schema.Literal('repository-lock'),
  Schema.Literal('request-lock'),
  Schema.Literal('snapshot-build'),
]);
const ApiSchema8398 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('files'),
  Schema.Literal('snapshots'),
  Schema.Literal('symbols'),
]);
const ApiSchema8339 = Schema.Struct({
  completed: Schema.optionalKey(ApiSchema109),
  phase: ApiSchema8372,
  reason: Schema.optionalKey(ApiSchema8390),
  subphase: Schema.optionalKey(ApiSchema320),
  total: Schema.optionalKey(ApiSchema109),
  unit: Schema.optionalKey(ApiSchema8398),
});
const ApiSchema8340 = Schema.Union([Schema.Undefined, ApiSchema8339]);
const ApiSchema8412 = Schema.Union([
  Schema.Literal('cancelled'),
  Schema.Literal('cancelling'),
  Schema.Literal('completed'),
  Schema.Literal('failed'),
  Schema.Literal('waiting'),
  Schema.Literal('bridging'),
  Schema.Literal('cataloging'),
  Schema.Literal('indexing'),
  Schema.Literal('projecting'),
  Schema.Literal('publishing'),
  Schema.Literal('starting'),
]);
const ApiSchema8335 = Schema.Struct({
  activity: Schema.optionalKey(ApiSchema8340),
  attempt: Schema.optionalKey(ApiSchema109),
  completed: Schema.optionalKey(ApiSchema109),
  elapsedMilliseconds: Schema.optionalKey(ApiSchema109),
  maxAttempts: Schema.optionalKey(ApiSchema109),
  message: Schema.String,
  phase: ApiSchema8412,
  project: Schema.optionalKey(ApiSchema320),
  total: Schema.Finite,
});
const ApiSchema8417 = Schema.Union([Schema.Literal('ready'), Schema.Literal('unavailable')]);
const ApiSchema279 = Schema.Array(Schema.String);
const ApiSchema8415 = Schema.Struct({
  bridgeCount: Schema.Finite,
  digest: Schema.String,
  monikerCount: Schema.Finite,
  rejectionCount: Schema.Finite,
  resolverVersion: Schema.Finite,
  state: ApiSchema8417,
  unavailableRepositories: ApiSchema279,
  warnings: ApiSchema279,
});
const ApiSchema8416 = Schema.Union([Schema.Undefined, ApiSchema8415]);
const ApiSchema8418 = Schema.Struct({
  complete: Schema.Boolean,
  excluded: Schema.Finite,
  failed: Schema.Finite,
  missing: Schema.Finite,
  ready: Schema.Finite,
  requested: Schema.Finite,
});
const ApiSchema8419 = Schema.Struct({
  project: Schema.String,
  projectionDigest: Schema.String,
  repositoryId: Schema.String,
  snapshotId: Schema.String,
  state: Schema.Literal('ready'),
  symbolCount: Schema.Finite,
});
const ApiSchema8420 = Schema.Struct({
  project: Schema.String,
  reason: Schema.Literal('unknown-project'),
  state: Schema.Literal('excluded'),
});
const ApiSchema8445 = Schema.Union([
  Schema.Literal('repository'),
  Schema.Literal('catalog'),
  Schema.Literal('unknown'),
  Schema.Literal('busy'),
  Schema.Literal('confirmed-corruption'),
  Schema.Literal('incompatible-schema'),
  Schema.Literal('no-space'),
  Schema.Literal('permission'),
  Schema.Literal('schema-additive'),
  Schema.Literal('transient-io'),
  Schema.Literal('worktree-changed'),
]);
const ApiSchema8463 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('defer'),
  Schema.Literal('diagnose'),
  Schema.Literal('fix-permissions'),
  Schema.Literal('free-space'),
  Schema.Literal('manual-migration'),
  Schema.Literal('manual-rebuild'),
  Schema.Literal('migrate-additive'),
  Schema.Literal('reconnect-runtime'),
  Schema.Literal('retry-read-only'),
]);
const ApiSchema8427 = Schema.Struct({
  code: ApiSchema8445,
  errorType: Schema.String,
  recovery: Schema.optionalKey(ApiSchema8463),
  retryable: Schema.Boolean,
  summary: Schema.String,
});
const ApiSchema8468 = Schema.Union([Schema.Literal('index-failed'), Schema.Literal('projection-failed')]);
const ApiSchema8421 = Schema.Struct({
  detail: ApiSchema8427,
  project: Schema.String,
  reason: ApiSchema8468,
  state: Schema.Literal('failed'),
});
const ApiSchema8422 = Schema.Struct({
  project: Schema.String,
  reason: Schema.Literal('missing-path'),
  state: Schema.Literal('missing'),
});
const ApiSchema8423 = Schema.Union([ApiSchema8419, ApiSchema8420, ApiSchema8421, ApiSchema8422]);
const ApiSchema8424 = Schema.Array(ApiSchema8423);
const ApiSchema8475 = Schema.Union([Schema.Literal('ready'), Schema.Literal('staging')]);
const ApiSchema8471 = Schema.Struct({
  digest: Schema.String,
  id: Schema.String,
  manifestDigest: Schema.String,
  memberCount: Schema.Finite,
  state: ApiSchema8475,
  worksetName: Schema.String,
});
const ApiSchema8472 = Schema.Union([Schema.Undefined, ApiSchema8471]);
const ApiSchema8476 = Schema.Union([Schema.Literal('failed'), Schema.Literal('ready')]);
const ApiSchema8413 = Schema.Struct({
  bridges: Schema.optionalKey(ApiSchema8416),
  coverage: ApiSchema8418,
  manifestDigest: Schema.String,
  members: ApiSchema8424,
  published: Schema.optionalKey(ApiSchema8472),
  state: ApiSchema8476,
  type: Schema.Literal('code-graph-workset-prepare'),
  version: Schema.Literal(1),
  workset: Schema.String,
});
const ApiSchema8414 = Schema.Union([Schema.Undefined, ApiSchema8413]);
const ApiSchema5747 = Schema.Union([
  Schema.Literal('running'),
  Schema.Literal('cancelled'),
  Schema.Literal('cancelling'),
  Schema.Literal('completed'),
  Schema.Literal('failed'),
]);
const ApiSchema5176 = Schema.Struct({
  createdAt: Schema.String,
  error: Schema.optionalKey(ApiSchema320),
  errorCode: Schema.optionalKey(ApiSchema320),
  finishedAt: Schema.optionalKey(ApiSchema320),
  id: Schema.String,
  progress: ApiSchema8335,
  result: Schema.optionalKey(ApiSchema8414),
  status: ApiSchema5747,
  warning: Schema.optionalKey(ApiSchema320),
  workset: Schema.String,
});
const ApiSchema5177 = Schema.Struct({job: ApiSchema5176});
const ApiSchema6693 = Schema.Union([Schema.Literal(1), Schema.Literal(2)]);
const ApiSchema8480 = Schema.Struct({
  executorVersion: Schema.Finite,
  authoringVersion: Schema.Finite,
  cycleVersion: Schema.Finite,
  watchVersion: Schema.Finite,
  closeoutVersion: Schema.Finite,
});
const ApiSchema8481 = Schema.Union([Schema.Undefined, ApiSchema8480]);
const ApiSchema8482 = Schema.Struct({commands: ApiSchema279, prCommands: ApiSchema279});
const ApiSchema8487 = Schema.Union([Schema.Literal('support'), Schema.Literal('primary')]);
const ApiSchema8483 = Schema.Struct({id: Schema.String, role: ApiSchema8487, files: ApiSchema279});
const ApiSchema8484 = Schema.Array(ApiSchema8483);
const ApiSchema8488 = Schema.Record(Schema.String, Schema.String);
const ApiSchema8479 = Schema.Struct({
  schemaVersion: ApiSchema6693,
  nativeRequirements: Schema.optionalKey(ApiSchema8481),
  workflowProtocol: Schema.Literal(1),
  stateSchema: Schema.Literal(1),
  minimumRuntime: Schema.String,
  releaseVersion: Schema.String,
  prerequisites: ApiSchema8482,
  skills: ApiSchema8484,
  hashes: ApiSchema8488,
  digest: Schema.String,
});
const ApiSchema5457 = Schema.Union([
  Schema.Literal('desktop'),
  Schema.Literal('codex-cloud-personal'),
  Schema.Literal('cursor-cloud-personal'),
]);
const ApiSchema5363 = Schema.Union([Schema.Literal('local'), Schema.Literal('project'), Schema.Literal('user')]);
const ApiSchema8493 = Schema.Union([Schema.Literal('flat'), Schema.Literal('directory')]);
const ApiSchema5450 = Schema.Struct({
  surfaceId: Schema.String,
  agentId: Schema.String,
  profile: ApiSchema5457,
  scope: ApiSchema5363,
  cwd: Schema.optionalKey(ApiSchema320),
  skillRoot: Schema.String,
  layout: ApiSchema8493,
  discoveryRoots: ApiSchema279,
});
const ApiSchema8504 = Schema.Union([
  Schema.Literal('conflict'),
  Schema.Literal('unsupported'),
  Schema.Literal('current'),
  Schema.Literal('incomplete'),
  Schema.Literal('absent'),
  Schema.Literal('update-available'),
  Schema.Literal('modified'),
  Schema.Literal('recovery-needed'),
  Schema.Literal('incompatible'),
]);
const ApiSchema8505 = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  path: Schema.optionalKey(ApiSchema320),
});
const ApiSchema8506 = Schema.Array(ApiSchema8505);
const ApiSchema8507 = Schema.Struct({home: Schema.String, installationRoot: Schema.String, target: ApiSchema5450});
const ApiSchema8508 = Schema.Array(ApiSchema8507);
const ApiSchema8516 = Schema.Union([Schema.Literal('ready'), Schema.Literal('blocked'), Schema.Literal('unchecked')]);
const ApiSchema8511 = Schema.Struct({state: ApiSchema8516, reasons: ApiSchema8506});
const ApiSchema8509 = Schema.Struct({planning: ApiSchema8511, publication: ApiSchema8511, watch: ApiSchema8511});
const ApiSchema8510 = Schema.Union([Schema.Undefined, ApiSchema8509]);
const ApiSchema5449 = Schema.Union([
  Schema.Literal('unregistered'),
  Schema.Literal('enrolled'),
  Schema.Literal('removed'),
]);
const ApiSchema8519 = Schema.Union([Schema.Undefined, Schema.Literal(1), Schema.Literal(2)]);
const ApiSchema8517 = Schema.Struct({
  manifestSchema: Schema.optionalKey(ApiSchema8519),
  nativeRequirements: Schema.optionalKey(ApiSchema8481),
  releaseVersion: Schema.String,
  digest: Schema.String,
  workflowProtocol: Schema.Finite,
  stateSchema: Schema.Finite,
  minimumRuntime: Schema.String,
});
const ApiSchema8518 = Schema.Union([Schema.Undefined, ApiSchema8517]);
const ApiSchema8524 = Schema.Union([Schema.Literal('pending'), Schema.Literal('current'), Schema.Literal('skipped')]);
const ApiSchema8520 = Schema.Struct({
  intentId: Schema.String,
  requestedReleaseVersion: Schema.String,
  requestedBundleDigest: Schema.String,
  state: ApiSchema8524,
  attemptedAt: Schema.String,
  completedAt: Schema.optionalKey(ApiSchema320),
  issues: ApiSchema8506,
});
const ApiSchema8521 = Schema.Union([Schema.Undefined, ApiSchema8520]);
const ApiSchema5392 = Schema.Struct({
  target: ApiSchema5450,
  consumerId: Schema.String,
  installationState: ApiSchema8504,
  enrolled: Schema.Boolean,
  installedDigest: Schema.optionalKey(ApiSchema320),
  issues: ApiSchema8506,
  consumers: ApiSchema8508,
  readiness: Schema.optionalKey(ApiSchema8510),
  enrollmentState: ApiSchema5449,
  enabled: Schema.Boolean,
  installed: Schema.optionalKey(ApiSchema8518),
  lastRefresh: Schema.optionalKey(ApiSchema8521),
});
const ApiSchema5394 = Schema.Array(ApiSchema5392);
const ApiSchema5189 = Schema.Struct({schemaVersion: Schema.Literal(1), bundle: ApiSchema8479, targets: ApiSchema5394});
const ApiSchema8525 = Schema.Array(ApiSchema5363);
const ApiSchema5248 = Schema.Struct({
  surfaceId: Schema.String,
  agentId: Schema.String,
  displayName: Schema.String,
  aliases: ApiSchema279,
  status: Schema.Literal('managed'),
  profile: ApiSchema5457,
  scopes: ApiSchema8525,
  scopeReason: Schema.optionalKey(ApiSchema320),
  defaultScope: ApiSchema5363,
  platforms: ApiSchema279,
  layout: ApiSchema8493,
});
const ApiSchema5249 = Schema.Struct({
  surfaceId: Schema.String,
  agentId: Schema.String,
  displayName: Schema.String,
  aliases: ApiSchema279,
  status: Schema.Literal('unsupported'),
  reason: Schema.String,
});
const ApiSchema5250 = Schema.Union([ApiSchema5248, ApiSchema5249]);
const ApiSchema5251 = Schema.Array(ApiSchema5250);
const ApiSchema5208 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  platform: Schema.String,
  bundle: ApiSchema8479,
  surfaces: ApiSchema5251,
});
const ApiSchema5480 = Schema.Struct({name: Schema.String, path: Schema.String});
const ApiSchema5481 = Schema.Array(ApiSchema5480);
const ApiSchema5213 = Schema.Struct({schemaVersion: Schema.Literal(1), projects: ApiSchema5481});
const ApiSchema5543 = Schema.Union([Schema.Literal('update'), Schema.Literal('install'), Schema.Literal('remove')]);
const ApiSchema1112 = Schema.Union([Schema.Null, Schema.String]);
const ApiSchema8526 = Schema.Struct({path: Schema.String, beforeHash: ApiSchema1112, afterHash: ApiSchema1112});
const ApiSchema8527 = Schema.Array(ApiSchema8526);
const ApiSchema5537 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  action: ApiSchema5543,
  target: ApiSchema5450,
  consumerId: Schema.String,
  installationState: ApiSchema8504,
  bundleDigest: Schema.String,
  previewDigest: Schema.String,
  changes: ApiSchema8527,
  consumers: ApiSchema8508,
  issues: ApiSchema8506,
  canApply: Schema.Boolean,
  readiness: Schema.optionalKey(ApiSchema8510),
});
const ApiSchema8528 = Schema.Struct({
  applied: Schema.Boolean,
  recovered: Schema.Boolean,
  retainedPaths: ApiSchema279,
  schemaVersion: Schema.Literal(1),
  action: ApiSchema5543,
  target: ApiSchema5450,
  consumerId: Schema.String,
  installationState: ApiSchema8504,
  bundleDigest: Schema.String,
  previewDigest: Schema.String,
  changes: ApiSchema8527,
  consumers: ApiSchema8508,
  issues: ApiSchema8506,
  canApply: Schema.Boolean,
  readiness: Schema.optionalKey(ApiSchema8510),
});
const ApiSchema5546 = Schema.Struct({result: ApiSchema8528, status: ApiSchema5189});
const ApiSchema555 = Schema.Union([Schema.Undefined, ApiSchema279]);
const ApiSchema8531 = Schema.Struct({
  closure: Schema.Literal('dependencies'),
  include: Schema.optionalKey(ApiSchema555),
  roots: ApiSchema279,
});
const ApiSchema8532 = Schema.Union([Schema.Undefined, ApiSchema8531]);
const ApiSchema5561 = Schema.Struct({
  graph: Schema.optionalKey(ApiSchema8532),
  name: Schema.String,
  path: Schema.String,
  seed: ApiSchema279,
  uri: Schema.String,
});
const ApiSchema5835 = Schema.Struct({
  description: Schema.optionalKey(ApiSchema320),
  memberCount: Schema.Finite,
  name: Schema.String,
});
const ApiSchema5836 = Schema.Array(ApiSchema5835);
const ApiSchema8007 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('manifest-symlink'),
  Schema.Literal('unsupported-workset-yaml'),
]);
const ApiSchema8010 = Schema.Union([Schema.Literal('read-only'), Schema.Literal('editable')]);
const ApiSchema8001 = Schema.Struct({reason: Schema.optionalKey(ApiSchema8007), state: ApiSchema8010});
const ApiSchema8015 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('manifest-symlink'),
  Schema.Literal('unsupported-project-yaml'),
]);
const ApiSchema8011 = Schema.Struct({reason: Schema.optionalKey(ApiSchema8015), state: ApiSchema8010});
const ApiSchema8023 = Schema.Union([
  Schema.Literal('missing'),
  Schema.Literal('current'),
  Schema.Literal('detached'),
  Schema.Literal('not-observed'),
]);
const ApiSchema5638 = Schema.Struct({
  branch: Schema.optionalKey(ApiSchema320),
  branchState: ApiSchema8023,
  folder: Schema.String,
  name: Schema.String,
  path: Schema.String,
  worksets: ApiSchema279,
  worksetCount: Schema.Finite,
});
const ApiSchema8016 = Schema.Array(ApiSchema5638);
const ApiSchema4965 = Schema.Struct({
  definitions: ApiSchema5836,
  definitionSource: Schema.Literal('seed-manifest'),
  editability: ApiSchema8001,
  projectEditability: ApiSchema8011,
  projects: ApiSchema8016,
  projectsReadOnly: Schema.Boolean,
  readOnly: Schema.Boolean,
  revision: Schema.String,
  type: Schema.Literal('manager-workset-catalog'),
  version: Schema.Literal(1),
});
const ApiSchema8538 = Schema.Union([Schema.Literal('update'), Schema.Literal('create'), Schema.Literal('delete')]);
const ApiSchema5564 = Schema.Struct({
  catalog: ApiSchema4965,
  changed: Schema.Boolean,
  operation: ApiSchema8538,
  warnings: ApiSchema279,
});

export const isJobResponse = Schema.is(ApiSchema5177);
export const isManagerDevSkillsStatus = Schema.is(ApiSchema5189);
export const isManagerDevSkillsCatalog = Schema.is(ApiSchema5208);
export const isManagerDevSkillsProjects = Schema.is(ApiSchema5213);
export const isManagerDevSkillsPlan = Schema.is(ApiSchema5537);
export const isManagerDevSkillsApplyResponse = Schema.is(ApiSchema5546);
export const isManagerManifestProject = Schema.is(ApiSchema5561);
export const isManagerManifestProjectMutationResult = Schema.is(ApiSchema5564);
