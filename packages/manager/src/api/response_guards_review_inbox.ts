import {Schema} from 'effect';

const ApiSchema10265 = Schema.Union([
  Schema.Literal('running'),
  Schema.Literal('failed'),
  Schema.Literal('idle'),
  Schema.Literal('waiting-evidence'),
  Schema.Literal('needs-decision'),
]);
const ApiSchema8261 = Schema.Union([Schema.Literal('complete'), Schema.Literal('partial')]);
const ApiSchema109 = Schema.Union([Schema.Undefined, Schema.Finite]);
const ApiSchema10266 = Schema.Struct({
  project: Schema.String,
  state: ApiSchema8261,
  eligibleRecords: Schema.Finite,
  checkedBatches: Schema.Finite,
  totalBatches: Schema.Finite,
  extractedRecords: Schema.Finite,
  totalRecords: Schema.Finite,
  extractionComplete: Schema.Boolean,
  comparisonComplete: Schema.Boolean,
  comparedClaimPairs: Schema.Finite,
  totalClaimPairs: Schema.optionalKey(ApiSchema109),
  unsupportedRecords: Schema.Finite,
  unsupportedClaims: Schema.Finite,
  bodyLimitedRecords: Schema.Finite,
  outputOmittedFindings: Schema.Finite,
  churnCount: Schema.Finite,
  dirtyRecordPairsRemaining: Schema.Finite,
});
const ApiSchema10267 = Schema.Array(ApiSchema10266);
const ApiSchema10268 = Schema.Union([Schema.Undefined, ApiSchema10267]);
const ApiSchema320 = Schema.Union([Schema.Undefined, Schema.String]);
const ApiSchema10269 = Schema.Struct({
  complete: Schema.Boolean,
  admittedRecords: Schema.Finite,
  incompleteReason: Schema.optionalKey(ApiSchema320),
});
const ApiSchema10270 = Schema.Union([Schema.Undefined, ApiSchema10269]);
const ApiSchema10271 = Schema.Struct({
  project: Schema.String,
  generation: Schema.String,
  cursor: Schema.Finite,
  eligible: Schema.Finite,
  checked: Schema.Finite,
  eligibleCitations: Schema.Finite,
  checkedCitations: Schema.Finite,
});
const ApiSchema10272 = Schema.Array(ApiSchema10271);
const ApiSchema10205 = Schema.Struct({uri: Schema.String, hash: Schema.String});
const ApiSchema10206 = Schema.Array(ApiSchema10205);
const ApiSchema10207 = Schema.Union([Schema.Undefined, ApiSchema10206]);
const ApiSchema10218 = Schema.Union([
  Schema.Literal('resolved'),
  Schema.Literal('historical'),
  Schema.Literal('queued'),
  Schema.Literal('repairing'),
  Schema.Literal('waiting-evidence'),
  Schema.Literal('needs-decision'),
  Schema.Literal('retired'),
  Schema.Literal('deferred-policy'),
]);
const ApiSchema10219 = Schema.Struct({at: Schema.String, reason: Schema.String});
const ApiSchema10220 = Schema.Array(ApiSchema10219);
const ApiSchema10204 = Schema.Struct({
  caseId: Schema.String,
  project: Schema.String,
  memoryId: Schema.String,
  subjectUri: Schema.optionalKey(ApiSchema320),
  archivedUri: Schema.optionalKey(ApiSchema320),
  subjectContentHashes: Schema.optionalKey(ApiSchema10207),
  family: Schema.String,
  slot: Schema.String,
  evidenceRevision: Schema.String,
  disposition: ApiSchema10218,
  reason: Schema.String,
  causeKey: Schema.optionalKey(ApiSchema320),
  repositoryId: Schema.optionalKey(ApiSchema320),
  firstSeen: Schema.String,
  lastSeen: Schema.String,
  lastChecked: Schema.String,
  attemptCount: Schema.Finite,
  nextAttemptAt: Schema.optionalKey(ApiSchema320),
  events: ApiSchema10220,
});
const ApiSchema10273 = Schema.Array(ApiSchema10204);
const ApiSchema10276 = Schema.Union([
  Schema.Literal('applying'),
  Schema.Literal('applied'),
  Schema.Literal('conflict'),
  Schema.Literal('undone'),
]);
const ApiSchema10274 = Schema.Struct({
  receiptId: Schema.String,
  project: Schema.String,
  subjectUri: Schema.String,
  archivedUri: Schema.optionalKey(ApiSchema320),
  postHash: Schema.String,
  timestamp: Schema.String,
  state: ApiSchema10276,
});
const ApiSchema10275 = Schema.Array(ApiSchema10274);
const ApiSchema8035 = Schema.Record(Schema.String, Schema.Finite);
const ApiSchema10277 = Schema.Union([Schema.Undefined, ApiSchema8035]);
const ApiSchema10278 = Schema.Struct({
  causeKey: Schema.String,
  project: Schema.String,
  disposition: ApiSchema10218,
  reason: Schema.String,
  repositoryId: Schema.optionalKey(ApiSchema320),
  affectedMemories: Schema.Finite,
  nextAttemptAt: Schema.optionalKey(ApiSchema320),
});
const ApiSchema10279 = Schema.Array(ApiSchema10278);
const ApiSchema10280 = Schema.Union([Schema.Undefined, ApiSchema10279]);
const ApiSchema6788 = Schema.Struct({
  generation: Schema.String,
  caseNextCursor: Schema.optionalKey(ApiSchema320),
  receiptNextCursor: Schema.optionalKey(ApiSchema320),
});
const ApiSchema6789 = Schema.Union([Schema.Undefined, ApiSchema6788]);
const ApiSchema10376 = Schema.Union([
  Schema.Literal('discovery'),
  Schema.Literal('record-read'),
  Schema.Literal('authority-check'),
  Schema.Literal('inventory-cache'),
]);
const ApiSchema10339 = Schema.Union([
  Schema.Literal('invalid-header'),
  Schema.Literal('invalid-utf8'),
  Schema.Literal('permission-denied'),
  Schema.Literal('record-size-limit'),
  Schema.Literal('cache-size-limit'),
  Schema.Literal('authority-boundary'),
  Schema.Literal('record-not-regular'),
  Schema.Literal('record-changed'),
  Schema.Literal('io-error'),
]);
const ApiSchema10532 = Schema.Struct({
  version: Schema.Literal(1),
  stage: ApiSchema10376,
  category: ApiSchema10339,
  summary: Schema.String,
  recovery: Schema.String,
  retryable: Schema.Boolean,
  memoryUri: Schema.optionalKey(ApiSchema320),
});
const ApiSchema10534 = Schema.Union([Schema.Undefined, ApiSchema10532]);
const ApiSchema10283 = Schema.Struct({
  reason: Schema.String,
  at: Schema.String,
  diagnostic: Schema.optionalKey(ApiSchema10534),
});
const ApiSchema10284 = Schema.Union([Schema.Undefined, ApiSchema10283]);
const ApiSchema6710 = Schema.Struct({
  version: Schema.Literal(2),
  paused: Schema.Boolean,
  state: ApiSchema10265,
  generation: Schema.String,
  semanticCoverage: Schema.optionalKey(ApiSchema10268),
  preparation: Schema.optionalKey(ApiSchema10270),
  projects: ApiSchema10272,
  cases: ApiSchema10273,
  receipts: ApiSchema10275,
  counts: Schema.optionalKey(ApiSchema10277),
  groups: Schema.optionalKey(ApiSchema10280),
  omittedCases: Schema.optionalKey(ApiSchema109),
  omittedReceipts: Schema.optionalKey(ApiSchema109),
  page: Schema.optionalKey(ApiSchema6789),
  lastProgressAt: Schema.optionalKey(ApiSchema320),
  error: Schema.optionalKey(ApiSchema10284),
});
const ApiSchema6718 = Schema.Union([
  Schema.Literal('conflict'),
  Schema.Literal('undone'),
  Schema.Literal('already-undone'),
]);
const ApiSchema6719 = Schema.Struct({status: ApiSchema6718, reason: Schema.optionalKey(ApiSchema320)});
const ApiSchema6720 = Schema.Union([ApiSchema6710, ApiSchema6719]);
const ApiSchema10541 = Schema.Struct({
  checking: Schema.optionalKey(ApiSchema109),
  'target-changed': Schema.optionalKey(ApiSchema109),
  'source-changed': Schema.optionalKey(ApiSchema109),
  'source-unavailable': Schema.optionalKey(ApiSchema109),
  'scope-changed': Schema.optionalKey(ApiSchema109),
  'policy-changed': Schema.optionalKey(ApiSchema109),
  'verification-unavailable': Schema.optionalKey(ApiSchema109),
});
const ApiSchema10537 = Schema.Struct({
  assessments: Schema.Finite,
  awaitingSources: Schema.Finite,
  obsolete: Schema.Finite,
  reasons: ApiSchema10541,
  nextRetryAt: Schema.optionalKey(ApiSchema109),
});
const ApiSchema10538 = Schema.Union([Schema.Undefined, ApiSchema10537]);
const ApiSchema10550 = Schema.Union([Schema.Undefined, Schema.Literal('assessment'), Schema.Literal('obsolete')]);
const ApiSchema10552 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('automatic-memory'),
  Schema.Literal('topic-maintenance'),
]);
const ApiSchema9107 = Schema.Union([
  Schema.Literal('handoff'),
  Schema.Literal('preference'),
  Schema.Literal('decision'),
  Schema.Literal('invariant'),
]);
const ApiSchema9108 = Schema.Array(ApiSchema9107);
const ApiSchema9117 = Schema.Union([
  Schema.Literal('duplicate'),
  Schema.Literal('contradiction'),
  Schema.Literal('new'),
  Schema.Literal('possible_duplicate'),
  Schema.Literal('replacement'),
]);
const ApiSchema9120 = Schema.Union([
  Schema.Literal('create'),
  Schema.Literal('replace'),
  Schema.Literal('no_action'),
  Schema.Literal('manual_review'),
]);
const ApiSchema9123 = Schema.Union([
  Schema.Literal('pending'),
  Schema.Literal('deferred'),
  Schema.Literal('rejected'),
  Schema.Literal('applying'),
  Schema.Literal('applied'),
  Schema.Literal('conflict'),
]);
const ApiSchema10553 = Schema.Struct({
  candidateId: Schema.String,
  categories: ApiSchema9108,
  comparison: ApiSchema9117,
  confidence: Schema.Finite,
  proposedText: Schema.String,
  reason: Schema.String,
  recommendation: ApiSchema9120,
  state: ApiSchema9123,
  targetUri: Schema.optionalKey(ApiSchema320),
});
const ApiSchema10554 = Schema.Array(ApiSchema10553);
const ApiSchema10543 = Schema.Struct({
  queueStatus: Schema.optionalKey(ApiSchema10550),
  kind: Schema.optionalKey(ApiSchema10552),
  candidates: ApiSchema10554,
  createdAt: Schema.String,
  project: Schema.String,
  reviewId: Schema.String,
  revision: Schema.Finite,
  task: Schema.String,
  topic: Schema.String,
});
const ApiSchema10544 = Schema.Array(ApiSchema10543);
const ApiSchema6790 = Schema.Struct({
  background: Schema.optionalKey(ApiSchema10538),
  items: ApiSchema10544,
  pendingCount: Schema.Finite,
  project: Schema.String,
  version: Schema.Literal(1),
});
const ApiSchema10560 = Schema.Union([
  Schema.Literal('applying'),
  Schema.Literal('completed'),
  Schema.Literal('failed'),
  Schema.Literal('scanning'),
  Schema.Literal('starting'),
  Schema.Literal('rebuilding'),
]);
const ApiSchema10557 = Schema.Struct({
  batch: Schema.Finite,
  failedCount: Schema.Finite,
  initialCitationCount: Schema.optionalKey(ApiSchema109),
  message: Schema.String,
  pagesScanned: Schema.Finite,
  phase: ApiSchema10560,
  repairableCount: Schema.Finite,
  repairedCount: Schema.Finite,
  unresolvedCount: Schema.Finite,
});
const ApiSchema10561 = Schema.Union([Schema.Literal('running'), Schema.Literal('completed'), Schema.Literal('failed')]);
const ApiSchema10555 = Schema.Struct({
  createdAt: Schema.String,
  error: Schema.optionalKey(ApiSchema320),
  finishedAt: Schema.optionalKey(ApiSchema320),
  id: Schema.String,
  progress: ApiSchema10557,
  project: Schema.String,
  status: ApiSchema10561,
  warning: Schema.optionalKey(ApiSchema320),
});
const ApiSchema10556 = Schema.Union([Schema.Null, ApiSchema10555]);
const ApiSchema6820 = Schema.Struct({job: ApiSchema10556});
const ApiSchema6957 = Schema.Union([
  Schema.Literal('citation-changed'),
  Schema.Literal('citation-missing'),
  Schema.Literal('citation-unknown'),
]);
const ApiSchema8122 = Schema.Union([Schema.Literal('symbol'), Schema.Literal('file')]);
const ApiSchema6952 = Schema.Struct({
  category: ApiSchema6957,
  citationId: Schema.String,
  findingId: Schema.String,
  path: Schema.String,
  proposalId: Schema.String,
  replacementId: Schema.String,
  revision: Schema.String,
  sourceCommit: Schema.String,
  subjectExcerpt: Schema.optionalKey(ApiSchema320),
  subjectTitle: Schema.optionalKey(ApiSchema320),
  subjectUri: Schema.String,
  targetKind: ApiSchema8122,
});
const ApiSchema6953 = Schema.Array(ApiSchema6952);
const ApiSchema6933 = Schema.Struct({
  items: ApiSchema6953,
  project: Schema.String,
  nextCursor: Schema.optionalKey(ApiSchema320),
  repairableCount: Schema.Finite,
  requiresGraphCount: Schema.Finite,
  truncated: Schema.Boolean,
  version: Schema.Literal(1),
});
const ApiSchema10562 = Schema.Struct({
  error: Schema.optionalKey(ApiSchema320),
  findingId: Schema.String,
  status: Schema.String,
});
const ApiSchema10563 = Schema.Array(ApiSchema10562);
const ApiSchema6938 = Schema.Struct({appliedCount: Schema.Finite, failedCount: Schema.Finite, results: ApiSchema10563});
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
const ApiSchema6966 = Schema.Struct({conflicts: ApiSchema4195});
const ApiSchema279 = Schema.Array(Schema.String);
const ApiSchema10566 = Schema.Union([
  Schema.Literal('failed'),
  Schema.Literal('unavailable'),
  Schema.Literal('available'),
  Schema.Literal('timed-out'),
]);
const ApiSchema6987 = Schema.Struct({uris: ApiSchema279, semantic: ApiSchema10566, warnings: ApiSchema279});
const ApiSchema7224 = Schema.Union([
  Schema.Literal('local-ai'),
  Schema.Literal('effect-ai'),
  Schema.Literal('cursor'),
  Schema.Literal('claude'),
  Schema.Literal('codex'),
  Schema.Literal('copilot'),
]);
const ApiSchema10567 = Schema.Struct({
  available: Schema.Boolean,
  command: Schema.optionalKey(ApiSchema320),
  id: ApiSchema7224,
  label: Schema.String,
});
const ApiSchema10568 = Schema.Array(ApiSchema10567);
const ApiSchema4294 = Schema.Union([Schema.Literal('automatic'), Schema.Literal('notify')]);
const ApiSchema10570 = Schema.Struct({attempt: Schema.Finite, failedAt: Schema.String, summary: Schema.String});
const ApiSchema10571 = Schema.Union([Schema.Undefined, ApiSchema10570]);
const ApiSchema10572 = Schema.Struct({
  completedAt: Schema.String,
  fromVersion: Schema.String,
  repairRequired: Schema.Boolean,
  toVersion: Schema.String,
});
const ApiSchema10573 = Schema.Union([Schema.Undefined, ApiSchema10572]);
const ApiSchema10574 = Schema.Struct({attempt: Schema.Finite, fromVersion: Schema.String, startedAt: Schema.String});
const ApiSchema10575 = Schema.Union([Schema.Undefined, ApiSchema10574]);
const ApiSchema10569 = Schema.Struct({
  effectivePolicy: ApiSchema4294,
  lastFailure: Schema.optionalKey(ApiSchema10571),
  lastSuccess: Schema.optionalKey(ApiSchema10573),
  running: Schema.optionalKey(ApiSchema10575),
});
const ApiSchema10576 = Schema.Struct({account: Schema.String, agentContextHome: Schema.String, user: Schema.String});
const ApiSchema6995 = Schema.Struct({
  agents: ApiSchema10568,
  autoUpdate: ApiSchema10569,
  config: ApiSchema10576,
  latestVersion: Schema.optionalKey(ApiSchema320),
  updateAvailable: Schema.Boolean,
  version: Schema.String,
});

export const isManagerContextMaintenanceResult = Schema.is(ApiSchema6720);
export const isManagerReviewInboxResponseV1 = Schema.is(ApiSchema6790);
export const isManagerCitationRepairJobResponseV1 = Schema.is(ApiSchema6820);
export const isCitationRepairPreview = Schema.is(ApiSchema6933);
export const isCitationRepairApplyResult = Schema.is(ApiSchema6938);
export const isConflictsResponse2 = Schema.is(ApiSchema6966);
export const isLibrarySearchResponse = Schema.is(ApiSchema6987);
export const isStateResponse = Schema.is(ApiSchema6995);
