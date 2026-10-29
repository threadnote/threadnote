import {Schema} from 'effect';

const ApiSchema4326 = Schema.Struct({id: Schema.String, label: Schema.String, isDefault: Schema.Boolean});
const ApiSchema4327 = Schema.Array(ApiSchema4326);
const ApiSchema4189 = Schema.Struct({models: ApiSchema4327});
const ApiSchema7898 = Schema.Union([Schema.Undefined, Schema.Literal('missing'), Schema.Literal('changed')]);
const ApiSchema4194 = Schema.Struct({
  id: Schema.String,
  team: Schema.String,
  uri: Schema.String,
  relativePath: Schema.String,
  reason: Schema.String,
  status: Schema.String,
  hasLocalContent: Schema.Boolean,
  hasSharedContent: Schema.Boolean,
  identityConflict: Schema.optionalKey(ApiSchema7898),
});
const ApiSchema4195 = Schema.Array(ApiSchema4194);
const ApiSchema4196 = Schema.Struct({conflicts: ApiSchema4195});
const ApiSchema320 = Schema.Union([Schema.Undefined, Schema.String]);
const ApiSchema4201 = Schema.Struct({
  revision: Schema.String,
  localContent: Schema.optionalKey(ApiSchema320),
  sharedContent: Schema.optionalKey(ApiSchema320),
  previousContent: Schema.optionalKey(ApiSchema320),
  diff: Schema.String,
  canKeepLocal: Schema.Boolean,
  canUseShared: Schema.Boolean,
  canMerge: Schema.Boolean,
  readOnly: Schema.Boolean,
  id: Schema.String,
  team: Schema.String,
  uri: Schema.String,
  relativePath: Schema.String,
  reason: Schema.String,
  status: Schema.String,
  hasLocalContent: Schema.Boolean,
  hasSharedContent: Schema.Boolean,
  identityConflict: Schema.optionalKey(ApiSchema7898),
});
const ApiSchema4250 = Schema.Record(Schema.String, Schema.Unknown);
const ApiSchema7903 = Schema.Union([Schema.Literal('latest'), Schema.Literal('beta')]);
const ApiSchema4294 = Schema.Union([Schema.Literal('automatic'), Schema.Literal('notify')]);
const ApiSchema7904 = Schema.Struct({version: Schema.String, title: Schema.String, body: Schema.String});
const ApiSchema7905 = Schema.Array(ApiSchema7904);
const ApiSchema7908 = Schema.Union([Schema.Literal('running'), Schema.Literal('completed'), Schema.Literal('failed')]);
const ApiSchema7906 = Schema.Struct({
  status: ApiSchema7908,
  message: Schema.String,
  output: Schema.optionalKey(ApiSchema320),
});
const ApiSchema7907 = Schema.Union([Schema.Undefined, ApiSchema7906]);
const ApiSchema4256 = Schema.Struct({
  installedVersion: Schema.String,
  runningVersion: Schema.String,
  channel: ApiSchema7903,
  developmentBuild: Schema.Boolean,
  restartRequired: Schema.Boolean,
  policy: ApiSchema4294,
  policyManaged: Schema.Boolean,
  automaticRunning: Schema.Boolean,
  automaticFailure: Schema.optionalKey(ApiSchema320),
  latestVersion: Schema.optionalKey(ApiSchema320),
  updateAvailable: Schema.Boolean,
  checkedAt: Schema.optionalKey(ApiSchema320),
  checkError: Schema.optionalKey(ApiSchema320),
  notesError: Schema.optionalKey(ApiSchema320),
  installedNotes: ApiSchema7905,
  availableNotes: ApiSchema7905,
  job: Schema.optionalKey(ApiSchema7907),
});
const ApiSchema7926 = Schema.Union([
  Schema.Literal('retry'),
  Schema.Literal('policy'),
  Schema.Literal('deferred'),
  Schema.Literal('failed'),
  Schema.Literal('ready'),
  Schema.Literal('unknown'),
  Schema.Literal('preparing'),
  Schema.Literal('queued'),
  Schema.Literal('generating'),
  Schema.Literal('waiting-model'),
  Schema.Literal('waiting-budget'),
  Schema.Literal('paused'),
  Schema.Literal('reviewed'),
  Schema.Literal('verification'),
]);
const ApiSchema109 = Schema.Union([Schema.Undefined, Schema.Finite]);
const ApiSchema7765 = Schema.Union([Schema.Literal('unknown'), Schema.Literal('complete'), Schema.Literal('partial')]);
const ApiSchema7772 = Schema.Union([
  Schema.Literal('recorded-only'),
  Schema.Literal('bounded-search'),
  Schema.Literal('none'),
]);
const ApiSchema279 = Schema.Array(Schema.String);
const ApiSchema7773 = Schema.Union([Schema.Null, Schema.Finite]);
const ApiSchema7764 = Schema.Struct({
  outcome: ApiSchema7765,
  scope: ApiSchema7772,
  searchedScopes: ApiSchema279,
  omittedSources: Schema.Finite,
  omittedParagraphs: ApiSchema7773,
});
const ApiSchema7927 = Schema.Struct({
  ordinal: Schema.Finite,
  role: Schema.String,
  authority: Schema.String,
  support: Schema.String,
});
const ApiSchema7928 = Schema.Array(ApiSchema7927);
const ApiSchema7937 = Schema.Union([
  Schema.Literal('personal-review'),
  Schema.Literal('shared-owner-review'),
  Schema.Literal('read-only'),
  Schema.Literal('excluded'),
]);
const ApiSchema256 = Schema.Union([Schema.Undefined, Schema.Literal(false), Schema.Literal(true)]);
const ApiSchema4308 = Schema.Struct({
  uri: Schema.String,
  title: Schema.String,
  targetHash: Schema.String,
  state: ApiSchema7926,
  reason: Schema.optionalKey(ApiSchema320),
  nextEligibleAt: Schema.optionalKey(ApiSchema109),
  retryCount: Schema.optionalKey(ApiSchema109),
  reviewId: Schema.optionalKey(ApiSchema320),
  evidenceRevision: Schema.optionalKey(ApiSchema320),
  coverage: ApiSchema7764,
  paragraphs: ApiSchema7928,
  route: ApiSchema7937,
  legacyUncited: Schema.Boolean,
  canGenerate: Schema.optionalKey(ApiSchema256),
});
const ApiSchema7909 = Schema.Array(ApiSchema4308);
const ApiSchema4412 = Schema.Struct({
  version: Schema.Literal(1),
  project: Schema.String,
  items: ApiSchema7909,
  omitted: Schema.Finite,
  incomplete: Schema.optionalKey(ApiSchema256),
  unavailableRecords: Schema.optionalKey(ApiSchema109),
  nextCursor: Schema.optionalKey(ApiSchema320),
});
const ApiSchema7940 = Schema.Union([Schema.Literal('configuration'), Schema.Literal('dependency')]);
const ApiSchema7938 = Schema.Struct({
  kind: ApiSchema7940,
  citationId: Schema.String,
  path: Schema.optionalKey(ApiSchema320),
});
const ApiSchema7939 = Schema.Array(ApiSchema7938);
const ApiSchema7941 = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  path: Schema.String,
  kind: Schema.String,
  citationId: Schema.String,
});
const ApiSchema7942 = Schema.Array(ApiSchema7941);
const ApiSchema7945 = Schema.Struct({id: Schema.String, path: Schema.String, contentHash: Schema.String});
const ApiSchema7946 = Schema.Array(ApiSchema7945);
const ApiSchema7959 = Schema.Union([
  Schema.Literal('excluded'),
  Schema.Literal('advisory'),
  Schema.Literal('self-loop'),
  Schema.Literal('cycle'),
  Schema.Literal('duplicate'),
  Schema.Literal('unselected'),
]);
const ApiSchema7947 = Schema.Struct({kind: ApiSchema7959, id: Schema.String});
const ApiSchema7948 = Schema.Array(ApiSchema7947);
const ApiSchema7943 = Schema.Struct({eligible: ApiSchema7946, omissions: ApiSchema7948});
const ApiSchema7944 = Schema.Union([Schema.Undefined, ApiSchema7943]);
const ApiSchema7960 = Schema.Struct({
  seedId: Schema.String,
  status: Schema.Literal('exhaustive'),
  visitedNodes: Schema.Finite,
  inspectedEdges: Schema.Finite,
});
const ApiSchema7961 = Schema.Array(ApiSchema7960);
const ApiSchema7962 = Schema.Union([Schema.Undefined, ApiSchema7961]);
const ApiSchema4515 = Schema.Struct({
  status: Schema.Literal('ready'),
  sourceKind: Schema.Literal('code'),
  targetUri: Schema.String,
  project: Schema.String,
  configDigest: Schema.String,
  body: Schema.String,
  warning: Schema.String,
  currentScope: ApiSchema7939,
  seeds: ApiSchema7942,
  choices: Schema.optionalKey(ApiSchema7944),
  coverage: Schema.optionalKey(ApiSchema7962),
});
const ApiSchema7986 = Schema.Struct({
  id: Schema.String,
  generation: Schema.Finite,
  predecessorRevision: Schema.String,
  predecessorApprovalDigest: Schema.String,
});
const ApiSchema7988 = Schema.Union([Schema.Undefined, ApiSchema7986]);
const ApiSchema4789 = Schema.Union([
  Schema.Literal('documents'),
  Schema.Literal('calls'),
  Schema.Literal('configures'),
  Schema.Literal('constructs'),
  Schema.Literal('contains'),
  Schema.Literal('declares'),
  Schema.Literal('depends_on'),
  Schema.Literal('exports'),
  Schema.Literal('extends'),
  Schema.Literal('implements'),
  Schema.Literal('imports'),
  Schema.Literal('overrides'),
  Schema.Literal('reads_or_writes'),
  Schema.Literal('references'),
  Schema.Literal('reexports'),
  Schema.Literal('semantic_association'),
  Schema.Literal('tests'),
]);
const ApiSchema4790 = Schema.Array(ApiSchema4789);
const ApiSchema7989 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('both'),
  Schema.Literal('incoming'),
  Schema.Literal('outgoing'),
]);
const ApiSchema4827 = Schema.Union([
  Schema.Literal('declared'),
  Schema.Literal('heuristic'),
  Schema.Literal('model'),
  Schema.Literal('resolved'),
  Schema.Literal('syntactic'),
]);
const ApiSchema4828 = Schema.Array(ApiSchema4827);
const ApiSchema4926 = Schema.Struct({
  kinds: ApiSchema4790,
  version: Schema.Literal(1),
  depth: Schema.Literal(1),
  direction: Schema.optionalKey(ApiSchema7989),
  configDigest: Schema.String,
  seeds: ApiSchema279,
  provenances: ApiSchema4828,
  minConfidence: Schema.Finite,
  nodeLimit: Schema.Finite,
  edgeLimit: Schema.Finite,
  selectedNodeIds: ApiSchema279,
  configurationPaths: ApiSchema279,
});
const ApiSchema7990 = Schema.Struct({
  kind: ApiSchema7940,
  ref: Schema.String,
  path: Schema.String,
  citationId: Schema.String,
});
const ApiSchema7991 = Schema.Array(ApiSchema7990);
const ApiSchema7992 = Schema.Struct({field: Schema.String, beforeHash: Schema.String, afterHash: Schema.String});
const ApiSchema7993 = Schema.Array(ApiSchema7992);
const ApiSchema7994 = Schema.Struct({
  seedId: Schema.String,
  status: Schema.Literal('exhaustive'),
  visitedNodes: Schema.Finite,
  inspectedEdges: Schema.Finite,
});
const ApiSchema7995 = Schema.Array(ApiSchema7994);
const ApiSchema4518 = Schema.Struct({
  status: Schema.Literal('preview'),
  operation: Schema.optionalKey(ApiSchema7988),
  targetUri: Schema.String,
  project: Schema.String,
  selection: ApiSchema4926,
  revision: Schema.String,
  approvalDigest: Schema.String,
  content: Schema.String,
  body: Schema.String,
  additions: ApiSchema7991,
  omissions: ApiSchema7948,
  metadataDiff: ApiSchema7993,
  coverage: ApiSchema7995,
});
const ApiSchema8000 = Schema.Union([Schema.Literal('expanded'), Schema.Literal('already-expanded')]);
const ApiSchema4519 = Schema.Struct({
  status: ApiSchema8000,
  targetUri: Schema.String,
  reviewId: Schema.String,
  revision: Schema.String,
});
const ApiSchema4520 = Schema.Union([ApiSchema4515, ApiSchema4518, ApiSchema4519]);

export const isConsolidationModelsResponse = Schema.is(ApiSchema4189);
export const isConflictsResponse = Schema.is(ApiSchema4196);
export const isSharingConflictDetail = Schema.is(ApiSchema4201);
export const isJsonRecord = Schema.is(ApiSchema4250);
export const isRuntimeUpdates = Schema.is(ApiSchema4256);
export const isManagerAutomaticMemoryStatus = Schema.is(ApiSchema4412);
export const isManagerTopicExpansionInspection = Schema.is(ApiSchema4515);
export const isManagerTopicExpansionInspectionOrManagerTopicExpansionPreviewOrManagerTopicExpansionApplied =
  Schema.is(ApiSchema4520);
