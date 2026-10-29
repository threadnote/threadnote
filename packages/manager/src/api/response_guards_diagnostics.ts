import {Schema} from 'effect';
import {TreeNodeSchema} from '../ui/contracts.js';

const ApiSchema6999 = Schema.Struct({resourcesTree: TreeNodeSchema, tree: TreeNodeSchema});
const ApiSchema109 = Schema.Union([Schema.Undefined, Schema.Finite]);
const ApiSchema256 = Schema.Union([Schema.Undefined, Schema.Literal(false), Schema.Literal(true)]);
const ApiSchema320 = Schema.Union([Schema.Undefined, Schema.String]);
const ApiSchema7003 = Schema.Struct({
  addedAt: Schema.String,
  ahead: Schema.optionalKey(ApiSchema109),
  behind: Schema.optionalKey(ApiSchema109),
  default: Schema.Boolean,
  dirty: Schema.optionalKey(ApiSchema256),
  gitdir: Schema.String,
  name: Schema.String,
  remote: Schema.String,
  status: Schema.optionalKey(ApiSchema320),
  warning: Schema.optionalKey(ApiSchema320),
  worktree: Schema.String,
});
const ApiSchema7004 = Schema.Array(ApiSchema7003);
const ApiSchema7005 = Schema.Struct({shares: ApiSchema7004});
const ApiSchema7547 = Schema.Union([
  Schema.Literal('stale'),
  Schema.Literal('invalid'),
  Schema.Literal('legacy-unknown'),
  Schema.Literal('missing'),
  Schema.Literal('verified'),
]);
const ApiSchema7538 = Schema.Struct({
  available: Schema.Boolean,
  branch: Schema.optionalKey(ApiSchema320),
  displayPath: Schema.optionalKey(ApiSchema320),
  observedAt: Schema.optionalKey(ApiSchema320),
  path: Schema.optionalKey(ApiSchema320),
  state: ApiSchema7547,
});
const ApiSchema10614 = Schema.Union([Schema.Literal('paged-fallback'), Schema.Literal('persisted-summary')]);
const ApiSchema10609 = Schema.Struct({complete: Schema.Boolean, rows: Schema.Finite, source: ApiSchema10614});
const ApiSchema10615 = Schema.Struct({complete: Schema.Boolean, rows: Schema.Finite, source: ApiSchema10614});
const ApiSchema10608 = Schema.Struct({edges: ApiSchema10609, symbols: ApiSchema10615});
const ApiSchema7576 = Schema.Union([
  Schema.Literal('complete'),
  Schema.Literal('not-requested'),
  Schema.Literal('partial'),
  Schema.Literal('unavailable'),
]);
const ApiSchema10616 = Schema.Struct({complete: Schema.Boolean, state: ApiSchema7576});
const ApiSchema10607 = Schema.Struct({
  aggregates: ApiSchema10608,
  complete: Schema.Boolean,
  edgeMetricsComplete: Schema.Boolean,
  edgesComplete: Schema.Boolean,
  nodesComplete: Schema.Boolean,
  topology: ApiSchema10616,
});
const ApiSchema10618 = Schema.Struct({count: Schema.Finite, value: Schema.String});
const ApiSchema10619 = Schema.Array(ApiSchema10618);
const ApiSchema10617 = Schema.Struct({
  analyzedEdgeCount: Schema.Finite,
  analyzedNodeCount: Schema.Finite,
  aggregatedEdgeCount: Schema.Finite,
  aggregatedNodeCount: Schema.Finite,
  averageDegree: Schema.Finite,
  communityCount: Schema.Finite,
  connectedComponentCount: Schema.Finite,
  filteredEdgeCount: Schema.Finite,
  isolatedNodeCount: Schema.Finite,
  kinds: ApiSchema10619,
  languages: ApiSchema10619,
  maximumDegree: Schema.Finite,
  provenances: ApiSchema10619,
  relations: ApiSchema10619,
  scannedEdgeCount: Schema.Finite,
  selectedEdgeCount: Schema.Finite,
  selfLoopCount: Schema.Finite,
  snapshotEdgeCount: Schema.Finite,
  snapshotNodeCount: Schema.Finite,
  unresolvedEndpointEdgeCount: Schema.Finite,
});
const ApiSchema10620 = Schema.Struct({
  aggregateEdgePageReads: Schema.Finite,
  aggregateEdgeRows: Schema.Finite,
  aggregateSummaryReads: Schema.Finite,
  aggregateSymbolPageReads: Schema.Finite,
  aggregateSymbolRows: Schema.Finite,
  durationMilliseconds: Schema.Finite,
  edgePageReads: Schema.Finite,
  edgeVisits: Schema.Finite,
  nodePageReads: Schema.Finite,
});
const ApiSchema279 = Schema.Array(Schema.String);
const ApiSchema10605 = Schema.Struct({
  coverage: ApiSchema10607,
  statistics: ApiSchema10617,
  usage: ApiSchema10620,
  warnings: ApiSchema279,
});
const ApiSchema10606 = Schema.Union([Schema.Undefined, ApiSchema10605]);
const ApiSchema7534 = Schema.Union([Schema.Literal('deferred'), Schema.Literal('complete')]);
const ApiSchema7552 = Schema.Union([Schema.Literal('legacy-fallback'), Schema.Literal('workspace')]);
const ApiSchema10622 = Schema.Struct({displayName: Schema.String, repositoryId: Schema.String});
const ApiSchema10626 = Schema.Union([
  Schema.Literal('failed'),
  Schema.Literal('ready'),
  Schema.Literal('retired'),
  Schema.Literal('building'),
]);
const ApiSchema10623 = Schema.Struct({
  scopeId: Schema.optionalKey(ApiSchema320),
  baseSnapshotId: Schema.optionalKey(ApiSchema320),
  commit: Schema.String,
  completedAt: Schema.optionalKey(ApiSchema320),
  dirty: Schema.Boolean,
  edgeCount: Schema.Finite,
  extractorSet: Schema.String,
  fileCount: Schema.Finite,
  graphContentId: Schema.optionalKey(ApiSchema320),
  id: Schema.String,
  overlayFingerprint: Schema.optionalKey(ApiSchema320),
  repositoryId: Schema.String,
  state: ApiSchema10626,
  symbolCount: Schema.Finite,
  worktreeId: Schema.String,
});
const ApiSchema10602 = Schema.Struct({
  localAssociation: ApiSchema7538,
  activatedAt: Schema.optionalKey(ApiSchema320),
  analysis: Schema.optionalKey(ApiSchema10606),
  managementAvailable: Schema.Boolean,
  metrics: ApiSchema7534,
  model: ApiSchema7552,
  projectCount: Schema.Finite,
  projectsTruncated: Schema.Boolean,
  repository: ApiSchema10622,
  snapshot: ApiSchema10623,
  viewScopeId: Schema.optionalKey(ApiSchema320),
  viewWorktreeId: Schema.String,
  workspaceCount: Schema.Finite,
  workspacesTruncated: Schema.Boolean,
});
const ApiSchema10604 = Schema.Array(ApiSchema10602);
const ApiSchema10653 = Schema.Union([
  Schema.Literal('running'),
  Schema.Literal('completed'),
  Schema.Literal('failed'),
  Schema.Literal('queued'),
]);
const ApiSchema10659 = Schema.Struct({
  preparingBatch: Schema.Finite,
  retiringReferences: Schema.Finite,
  updatingAnalysis: Schema.Finite,
  writingAliases: Schema.Finite,
  writingEdges: Schema.Finite,
});
const ApiSchema10660 = Schema.Union([Schema.Undefined, ApiSchema10659]);
const ApiSchema10658 = Schema.Struct({
  aliasesDiscovered: Schema.Finite,
  elapsedMilliseconds: Schema.Finite,
  longestTransactionMilliseconds: Schema.optionalKey(ApiSchema109),
  matchingMilliseconds: Schema.Finite,
  pageCompleted: Schema.Finite,
  pageTotal: Schema.Finite,
  pagesCompleted: Schema.Finite,
  pass: Schema.Finite,
  referencesCompleted: Schema.Finite,
  referencesExamined: Schema.Finite,
  referencesTotal: Schema.Finite,
  resolved: Schema.Finite,
  transactionMilliseconds: Schema.Finite,
  transactionStageMilliseconds: Schema.optionalKey(ApiSchema10660),
  startedAt: Schema.String,
});
const ApiSchema10654 = Schema.Struct({activity: ApiSchema10658});
const ApiSchema10655 = Schema.Union([Schema.Undefined, ApiSchema10654]);
const ApiSchema10700 = Schema.Union([
  Schema.Literal('overlay-success'),
  Schema.Literal('cache-incomplete'),
  Schema.Literal('disabled'),
  Schema.Literal('dynamic-aliases'),
  Schema.Literal('extractor-context-changed'),
  Schema.Literal('fact-budget-expanded'),
  Schema.Literal('file-set-changed'),
  Schema.Literal('forced-full-rebuild'),
  Schema.Literal('incremental-rewrite-unbounded'),
  Schema.Literal('no-materialized-changes'),
  Schema.Literal('project-closure-incomplete'),
  Schema.Literal('project-closure-unbounded'),
  Schema.Literal('reexport-closure-unbounded'),
  Schema.Literal('resolution-surface-changed'),
  Schema.Literal('staging-identity-mismatch'),
  Schema.Literal('staging-unavailable'),
  Schema.Literal('workspace-changed'),
]);
const ApiSchema10663 = Schema.Struct({outcome: ApiSchema10700});
const ApiSchema10664 = Schema.Union([Schema.Undefined, ApiSchema10663]);
const ApiSchema10661 = Schema.Struct({
  dirty: Schema.Boolean,
  edges: Schema.Finite,
  files: Schema.Finite,
  snapshotId: Schema.String,
  symbols: Schema.Finite,
  overlayAssessment: Schema.optionalKey(ApiSchema10664),
});
const ApiSchema10662 = Schema.Union([Schema.Undefined, ApiSchema10661]);
const ApiSchema10705 = Schema.Union([Schema.Literal('no-space'), Schema.Literal('transient-io')]);
const ApiSchema10711 = Schema.Union([Schema.Literal('durable'), Schema.Literal('shared'), Schema.Literal('temporary')]);
const ApiSchema10707 = Schema.Struct({bytes: Schema.Finite, role: ApiSchema10711});
const ApiSchema10708 = Schema.Array(ApiSchema10707);
const ApiSchema10716 = Schema.Struct({
  availableBytes: Schema.Finite,
  requiredBytes: Schema.Finite,
  role: ApiSchema10711,
});
const ApiSchema10717 = Schema.Array(ApiSchema10716);
const ApiSchema10729 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('available-space-unknown'),
  Schema.Literal('calibration-input-unknown'),
  Schema.Literal('filesystem-topology-unknown'),
  Schema.Literal('page-storage-unknown'),
  Schema.Literal('reservation-input-unknown'),
]);
const ApiSchema10730 = Schema.Union([
  Schema.Literal('defer'),
  Schema.Literal('free-space'),
  Schema.Literal('retry-read-only'),
]);
const ApiSchema10731 = Schema.Struct({checkoutId: Schema.String, scopeId: Schema.optionalKey(ApiSchema320)});
const ApiSchema10732 = Schema.Union([Schema.Undefined, ApiSchema10731]);
const ApiSchema10706 = Schema.Struct({
  activeReservations: ApiSchema10708,
  calibrationIdentity: Schema.String,
  decisionLayer: Schema.Literal('bounded-write-reservation'),
  estimateBasis: Schema.Literal('final-fact-bytes-and-row-count'),
  filesystems: ApiSchema10717,
  modelVersion: Schema.Finite,
  reason: Schema.optionalKey(ApiSchema10729),
  recovery: ApiSchema10730,
  retryable: Schema.Boolean,
  scope: Schema.optionalKey(ApiSchema10732),
});
const ApiSchema10794 = Schema.Union([
  Schema.Literal('write code graph embedding demand'),
  Schema.Literal('write code graph vector generation'),
  Schema.Literal('admit code graph vector retirement'),
  Schema.Literal('apply persistent code graph materialization spool'),
  Schema.Literal('cache code graph file facts'),
  Schema.Literal('cache materialized code graph file shards'),
  Schema.Literal('prepare code graph vector retirement schema'),
  Schema.Literal('maintain code graph vector retirement'),
  Schema.Literal('publish persistent code graph snapshot'),
  Schema.Literal('publish persistent code graph materialization spool receipts'),
  Schema.Literal('promote ready code graph snapshot'),
  Schema.Literal('register persistent code graph materialization plan'),
  Schema.Literal('restore persistent code graph query indexes'),
  Schema.Literal('resolve persistent code graph reexport aliases'),
  Schema.Literal('resolve persistent code graph references'),
  Schema.Literal('retire code graph vector generation'),
  Schema.Literal('retire code graph vector pointer'),
  Schema.Literal('stage persistent code graph facts'),
  Schema.Literal('stage persistent code graph inventory'),
  Schema.Literal('stage persistent code graph workspace'),
  Schema.Literal('sort persistent code graph materialization spool'),
  Schema.Literal('prepare temporary incremental code graph activation'),
  Schema.Literal('publish temporary code graph snapshot'),
  Schema.Literal('resolve temporary code graph reexport aliases'),
  Schema.Literal('resolve temporary code graph references'),
  Schema.Literal('stage temporary code graph facts'),
  Schema.Literal('stage temporary code graph inventory'),
  Schema.Literal('stage temporary code graph workspace'),
  Schema.Literal('observe code graph storage capacity'),
  Schema.Literal('protect code graph storage'),
]);
const ApiSchema10703 = Schema.Struct({code: ApiSchema10705, evidence: ApiSchema10706, operation: ApiSchema10794});
const ApiSchema10704 = Schema.Union([Schema.Undefined, ApiSchema10703]);
const ApiSchema10701 = Schema.Struct({capacity: Schema.optionalKey(ApiSchema10704), summary: Schema.String});
const ApiSchema10702 = Schema.Union([Schema.Undefined, ApiSchema10701]);
const ApiSchema8863 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('0-16KiB'),
  Schema.Literal('16-64KiB'),
  Schema.Literal('64-256KiB'),
  Schema.Literal('256KiB-1MiB'),
  Schema.Literal('>1MiB'),
]);
const ApiSchema8870 = Schema.Union([
  Schema.Literal('extracting'),
  Schema.Literal('persisting'),
  Schema.Literal('reading'),
]);
const ApiSchema10795 = Schema.Struct({
  batchCompleted: Schema.Finite,
  batchTotal: Schema.Finite,
  bytes: Schema.Finite,
  classifier: Schema.optionalKey(ApiSchema320),
  degraded: Schema.optionalKey(ApiSchema256),
  factsBytes: Schema.optionalKey(ApiSchema109),
  language: Schema.String,
  parseMilliseconds: Schema.optionalKey(ApiSchema109),
  persistMilliseconds: Schema.optionalKey(ApiSchema109),
  relations: Schema.optionalKey(ApiSchema109),
  role: Schema.optionalKey(ApiSchema320),
  sizeBucket: Schema.optionalKey(ApiSchema8863),
  stage: ApiSchema8870,
  symbols: Schema.optionalKey(ApiSchema109),
});
const ApiSchema10796 = Schema.Union([Schema.Undefined, ApiSchema10795]);
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
const ApiSchema10801 = Schema.Struct({
  processId: Schema.Finite,
  processStartIdentity: Schema.optionalKey(ApiSchema320),
  runtime: Schema.Literal('bun'),
  runtimeVersion: Schema.String,
});
const ApiSchema8877 = Schema.Union([Schema.Literal('history'), Schema.Literal('owner'), Schema.Literal('waiter')]);
const ApiSchema10804 = Schema.Struct({
  lockVerified: Schema.Boolean,
  progressSilent: Schema.optionalKey(ApiSchema256),
  role: ApiSchema8877,
});
const ApiSchema10805 = Schema.Union([Schema.Undefined, ApiSchema10804]);
const ApiSchema10807 = Schema.Union([
  Schema.Literal('active'),
  Schema.Literal('completed'),
  Schema.Literal('failed'),
  Schema.Literal('abandoned'),
  Schema.Literal('stalled'),
]);
const ApiSchema10815 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('heartbeat-stale'),
  Schema.Literal('owner-exited'),
  Schema.Literal('pid-reused'),
]);
const ApiSchema10806 = Schema.Struct({
  heartbeatAgeMilliseconds: Schema.Finite,
  liveness: ApiSchema10807,
  reason: Schema.optionalKey(ApiSchema10815),
});
const ApiSchema10821 = Schema.Union([
  Schema.Literal('checkpointing-snapshot'),
  Schema.Literal('committing-snapshot'),
  Schema.Literal('copying-edges'),
  Schema.Literal('copying-files'),
  Schema.Literal('copying-lookup-keys'),
  Schema.Literal('copying-reexports'),
  Schema.Literal('copying-symbols'),
  Schema.Literal('copying-terms'),
  Schema.Literal('copying-workspace'),
  Schema.Literal('recording-completion'),
  Schema.Literal('validating-input'),
]);
const ApiSchema8849 = Schema.Union([
  Schema.Literal('progress'),
  Schema.Literal('completed'),
  Schema.Literal('started'),
]);
const ApiSchema10820 = Schema.Struct({
  elapsedMilliseconds: Schema.Finite,
  rows: Schema.optionalKey(ApiSchema109),
  stage: ApiSchema10821,
  stageElapsedMilliseconds: Schema.Finite,
  state: ApiSchema8849,
  transactionMilliseconds: Schema.optionalKey(ApiSchema109),
  startedAt: Schema.String,
});
const ApiSchema10816 = Schema.Struct({activity: ApiSchema10820});
const ApiSchema10817 = Schema.Union([Schema.Undefined, ApiSchema10816]);
const ApiSchema10824 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('references'),
  Schema.Literal('files'),
  Schema.Literal('snapshots'),
  Schema.Literal('symbols'),
]);
const ApiSchema10822 = Schema.Struct({
  accepted: Schema.optionalKey(ApiSchema109),
  completed: Schema.optionalKey(ApiSchema109),
  edges: Schema.optionalKey(ApiSchema109),
  embedded: Schema.optionalKey(ApiSchema109),
  excluded: Schema.optionalKey(ApiSchema109),
  pagesCompleted: Schema.optionalKey(ApiSchema109),
  reused: Schema.optionalKey(ApiSchema109),
  resolved: Schema.optionalKey(ApiSchema109),
  rowsDeleted: Schema.optionalKey(ApiSchema109),
  skipped: Schema.optionalKey(ApiSchema109),
  symbols: Schema.optionalKey(ApiSchema109),
  total: Schema.optionalKey(ApiSchema109),
  unit: Schema.optionalKey(ApiSchema10824),
});
const ApiSchema8892 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('files'),
  Schema.Literal('cached-fact-bytes'),
  Schema.Literal('extraction-work'),
  Schema.Literal('final-fact-bytes'),
  Schema.Literal('source-bytes'),
]);
const ApiSchema8899 = Schema.Union([Schema.Literal('high'), Schema.Literal('low'), Schema.Literal('medium')]);
const ApiSchema10825 = Schema.Struct({
  basis: Schema.optionalKey(ApiSchema8892),
  confidence: ApiSchema8899,
  remainingMilliseconds: Schema.Finite,
  scope: Schema.Literal('phase'),
});
const ApiSchema10826 = Schema.Union([Schema.Undefined, ApiSchema10825]);
const ApiSchema10829 = Schema.Struct({
  degradedFiles: Schema.optionalKey(ApiSchema109),
  factsBytesCompleted: Schema.Finite,
  sourceBytesCompleted: Schema.Finite,
  workUnitsCompleted: Schema.Finite,
  sourceBytesTotal: Schema.Finite,
  workUnitsTotal: Schema.Finite,
});
const ApiSchema10831 = Schema.Union([Schema.Undefined, ApiSchema10829]);
const ApiSchema8862 = Schema.Union([
  Schema.Literal('0-16KiB'),
  Schema.Literal('16-64KiB'),
  Schema.Literal('64-256KiB'),
  Schema.Literal('256KiB-1MiB'),
  Schema.Literal('>1MiB'),
]);
const ApiSchema10832 = Schema.Struct({
  classifier: Schema.String,
  degraded: Schema.optionalKey(ApiSchema256),
  durationMilliseconds: Schema.Finite,
  extension: Schema.String,
  factsBytes: Schema.optionalKey(ApiSchema109),
  language: Schema.String,
  pathHash: Schema.String,
  relations: Schema.optionalKey(ApiSchema109),
  role: Schema.String,
  sizeBucket: ApiSchema8862,
  sourceBytes: Schema.Finite,
  symbols: Schema.optionalKey(ApiSchema109),
});
const ApiSchema10833 = Schema.Array(ApiSchema10832);
const ApiSchema10827 = Schema.Struct({
  completedFiles: Schema.Finite,
  metrics: Schema.optionalKey(ApiSchema10831),
  slowFiles: Schema.Finite,
  topSlowFiles: ApiSchema10833,
});
const ApiSchema10828 = Schema.Union([Schema.Undefined, ApiSchema10827]);
const ApiSchema10834 = Schema.Struct({
  checkoutId: Schema.String,
  commit: Schema.String,
  displayName: Schema.optionalKey(ApiSchema320),
  repositoryId: Schema.String,
  scopeId: Schema.optionalKey(ApiSchema320),
  worktreeId: Schema.String,
});
const ApiSchema10841 = Schema.Struct({
  deduplicatedEdges: Schema.optionalKey(ApiSchema109),
  deduplicatedReferences: Schema.optionalKey(ApiSchema109),
  edges: Schema.optionalKey(ApiSchema109),
  lookupKeys: Schema.optionalKey(ApiSchema109),
  referenceCandidates: Schema.optionalKey(ApiSchema109),
  references: Schema.optionalKey(ApiSchema109),
  reexports: Schema.optionalKey(ApiSchema109),
  symbols: Schema.optionalKey(ApiSchema109),
  terms: Schema.optionalKey(ApiSchema109),
});
const ApiSchema10842 = Schema.Union([Schema.Undefined, ApiSchema10841]);
const ApiSchema10843 = Schema.Union([
  Schema.Literal('attributing'),
  Schema.Literal('committing'),
  Schema.Literal('loading-cache'),
  Schema.Literal('preparing-rows'),
  Schema.Literal('restoring-indexes'),
  Schema.Literal('writing-analysis'),
  Schema.Literal('writing-candidates'),
  Schema.Literal('writing-edges'),
  Schema.Literal('writing-facts'),
  Schema.Literal('writing-lookups'),
  Schema.Literal('writing-references'),
  Schema.Literal('writing-receipt'),
  Schema.Literal('writing-symbols'),
  Schema.Literal('writing-terms'),
]);
const ApiSchema10839 = Schema.Struct({
  batchCompleted: Schema.Finite,
  batchTotal: Schema.Finite,
  cachedFactBytes: Schema.optionalKey(ApiSchema109),
  elapsedMilliseconds: Schema.optionalKey(ApiSchema109),
  factsBytes: Schema.optionalKey(ApiSchema109),
  rows: Schema.optionalKey(ApiSchema10842),
  sourceBytes: Schema.Finite,
  stageElapsedMilliseconds: Schema.optionalKey(ApiSchema109),
  stage: ApiSchema10843,
  transactionMilliseconds: Schema.optionalKey(ApiSchema109),
  startedAt: Schema.String,
});
const ApiSchema10840 = Schema.Union([Schema.Undefined, ApiSchema10839]);
const ApiSchema10846 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('cache-incomplete'),
  Schema.Literal('disabled'),
  Schema.Literal('dynamic-aliases'),
  Schema.Literal('extractor-context-changed'),
  Schema.Literal('fact-budget-expanded'),
  Schema.Literal('file-set-changed'),
  Schema.Literal('forced-full-rebuild'),
  Schema.Literal('incremental-rewrite-unbounded'),
  Schema.Literal('no-materialized-changes'),
  Schema.Literal('project-closure-incomplete'),
  Schema.Literal('project-closure-unbounded'),
  Schema.Literal('reexport-closure-unbounded'),
  Schema.Literal('resolution-surface-changed'),
  Schema.Literal('staging-identity-mismatch'),
  Schema.Literal('staging-unavailable'),
  Schema.Literal('workspace-changed'),
]);
const ApiSchema10865 = Schema.Union([
  Schema.Literal('dependency-model-incomplete'),
  Schema.Literal('duplicate-project-identity'),
  Schema.Literal('no-project-seeds'),
  Schema.Literal('path-owner-ambiguous'),
  Schema.Literal('path-unowned'),
  Schema.Literal('project-model-incomplete'),
  Schema.Literal('project-not-stable'),
  Schema.Literal('resolution-domain-unowned'),
]);
const ApiSchema555 = Schema.Union([Schema.Undefined, ApiSchema279]);
const ApiSchema10847 = Schema.Struct({
  changedFiles: Schema.Finite,
  addedFiles: Schema.Finite,
  deletedFiles: Schema.Finite,
  detail: ApiSchema10865,
  stage: Schema.Literal('file-set-seed-assessment'),
  unownedResolutionDomains: Schema.optionalKey(ApiSchema555),
  unownedResolutionDomainFiles: Schema.optionalKey(ApiSchema109),
});
const ApiSchema10848 = Schema.Union([Schema.Undefined, ApiSchema10847]);
const ApiSchema10880 = Schema.Union([
  Schema.Literal('cached-fact-bytes'),
  Schema.Literal('source-bytes'),
  Schema.Literal('affected-files'),
]);
const ApiSchema10873 = Schema.Struct({
  changedFiles: Schema.Finite,
  limit: Schema.Finite,
  observedAtDecision: Schema.Finite,
  metric: ApiSchema10880,
  stage: Schema.Literal('project-closure-selection'),
});
const ApiSchema10905 = Schema.Union([
  Schema.Literal('candidate-lookup-keys'),
  Schema.Literal('candidate-projection-associations'),
  Schema.Literal('candidate-projection-file-associations'),
  Schema.Literal('candidate-projection-observations'),
  Schema.Literal('candidate-projection-observed-key-bytes'),
  Schema.Literal('candidate-reexport-key-bytes'),
  Schema.Literal('candidate-reexport-lookup-keys'),
  Schema.Literal('candidate-reexports'),
  Schema.Literal('candidate-scan-fact-bytes'),
  Schema.Literal('candidate-scan-files'),
  Schema.Literal('candidate-selected-files'),
]);
const ApiSchema10874 = Schema.Struct({
  changedFiles: Schema.Finite,
  limit: Schema.Finite,
  observedAtDecision: Schema.Finite,
  metric: ApiSchema10905,
  stage: Schema.Literal('resolution-candidate-scan'),
});
const ApiSchema10908 = Schema.Union([
  Schema.Literal('cached-fact-bytes'),
  Schema.Literal('source-bytes'),
  Schema.Literal('candidate-selected-files'),
]);
const ApiSchema10875 = Schema.Struct({
  changedFiles: Schema.Finite,
  limit: Schema.Finite,
  observedAtDecision: Schema.Finite,
  metric: ApiSchema10908,
  stage: Schema.Literal('resolution-candidate-rewrite'),
});
const ApiSchema10877 = Schema.Union([Schema.Undefined, ApiSchema10873, ApiSchema10874, ApiSchema10875]);
const ApiSchema8959 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('full'),
  Schema.Literal('incremental-clean'),
  Schema.Literal('incremental-overlay'),
]);
const ApiSchema10920 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('none'),
  Schema.Literal('non-typescript'),
  Schema.Literal('typescript-other'),
  Schema.Literal('typescript-path-scoped'),
  Schema.Literal('typescript-path-unscoped'),
]);
const ApiSchema10934 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('exported'),
  Schema.Literal('non-typescript-domain'),
  Schema.Literal('own-path-local'),
  Schema.Literal('unknown-lookup-form'),
  Schema.Literal('foreign-path'),
  Schema.Literal('scope-mismatch'),
]);
const ApiSchema10940 = Schema.Struct({
  attributing: Schema.optionalKey(ApiSchema109),
  committing: Schema.optionalKey(ApiSchema109),
  'loading-cache': Schema.optionalKey(ApiSchema109),
  'preparing-rows': Schema.optionalKey(ApiSchema109),
  'restoring-indexes': Schema.optionalKey(ApiSchema109),
  'writing-analysis': Schema.optionalKey(ApiSchema109),
  'writing-candidates': Schema.optionalKey(ApiSchema109),
  'writing-edges': Schema.optionalKey(ApiSchema109),
  'writing-facts': Schema.optionalKey(ApiSchema109),
  'writing-lookups': Schema.optionalKey(ApiSchema109),
  'writing-references': Schema.optionalKey(ApiSchema109),
  'writing-receipt': Schema.optionalKey(ApiSchema109),
  'writing-symbols': Schema.optionalKey(ApiSchema109),
  'writing-terms': Schema.optionalKey(ApiSchema109),
});
const ApiSchema10942 = Schema.Union([Schema.Undefined, ApiSchema10940]);
const ApiSchema10943 = Schema.Struct({
  attributionCompute: Schema.Finite,
  factBatchPreparation: Schema.Finite,
  shardAssociation: Schema.Finite,
  shardPersistence: Schema.Finite,
  shardSerialization: Schema.Finite,
});
const ApiSchema10944 = Schema.Union([Schema.Undefined, ApiSchema10943]);
const ApiSchema10949 = Schema.Union([Schema.Undefined, Schema.Literal('whole-build-heuristic')]);
const ApiSchema10950 = Schema.Union([Schema.Undefined, Schema.Literal('advisory')]);
const ApiSchema8974 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('cached-fact-bytes'),
  Schema.Literal('final-fact-bytes'),
  Schema.Literal('source-bytes-fallback'),
]);
const ApiSchema8980 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('direct-persistent'),
  Schema.Literal('temporary-staged'),
]);
const ApiSchema10945 = Schema.Struct({
  availableBytes: Schema.optionalKey(ApiSchema109),
  durableAvailableBytes: Schema.optionalKey(ApiSchema109),
  durableDatabaseBytes: Schema.optionalKey(ApiSchema109),
  durableDatabaseHighWaterBytes: Schema.optionalKey(ApiSchema109),
  durableDatabaseStartBytes: Schema.optionalKey(ApiSchema109),
  durableDatabaseGrowthBytes: Schema.optionalKey(ApiSchema109),
  durableDatabaseGrowthHighWaterBytes: Schema.optionalKey(ApiSchema109),
  durableDatabaseFileBytes: Schema.optionalKey(ApiSchema109),
  durableDatabaseFileHighWaterBytes: Schema.optionalKey(ApiSchema109),
  durableFilesystemBytes: Schema.optionalKey(ApiSchema109),
  durableFilesystemHighWaterBytes: Schema.optionalKey(ApiSchema109),
  durableJournalBytes: Schema.optionalKey(ApiSchema109),
  durableJournalHighWaterBytes: Schema.optionalKey(ApiSchema109),
  durableSharedMemoryBytes: Schema.optionalKey(ApiSchema109),
  durableSharedMemoryHighWaterBytes: Schema.optionalKey(ApiSchema109),
  durableSidecarDatabaseBytes: Schema.optionalKey(ApiSchema109),
  durableSidecarDatabaseHighWaterBytes: Schema.optionalKey(ApiSchema109),
  durableSidecarJournalBytes: Schema.optionalKey(ApiSchema109),
  durableSidecarJournalHighWaterBytes: Schema.optionalKey(ApiSchema109),
  durableSidecarWalBytes: Schema.optionalKey(ApiSchema109),
  durableSidecarWalHighWaterBytes: Schema.optionalKey(ApiSchema109),
  durableWalBytes: Schema.optionalKey(ApiSchema109),
  durableWalHighWaterBytes: Schema.optionalKey(ApiSchema109),
  decisionLayer: Schema.optionalKey(ApiSchema10949),
  enforcement: Schema.optionalKey(ApiSchema10950),
  estimateBasis: Schema.optionalKey(ApiSchema8974),
  estimatedConcurrentBuildBytes: Schema.optionalKey(ApiSchema109),
  estimatedDurableFilesystemRequiredBytes: Schema.optionalKey(ApiSchema109),
  estimatedDurableSnapshotBytes: Schema.optionalKey(ApiSchema109),
  estimatedJournalBytes: Schema.optionalKey(ApiSchema109),
  estimatedRequiredBytes: Schema.optionalKey(ApiSchema109),
  estimatedTemporaryFilesystemRequiredBytes: Schema.optionalKey(ApiSchema109),
  estimatedTemporaryDatabaseBytes: Schema.optionalKey(ApiSchema109),
  filesystemsShared: Schema.optionalKey(ApiSchema256),
  materializationMode: Schema.optionalKey(ApiSchema8980),
  modelVersion: Schema.optionalKey(ApiSchema109),
  temporaryAvailableBytes: Schema.optionalKey(ApiSchema109),
  temporaryDatabaseBytes: Schema.Finite,
  temporaryDatabaseHighWaterBytes: Schema.Finite,
});
const ApiSchema10946 = Schema.Union([Schema.Undefined, ApiSchema10945]);
const ApiSchema10844 = Schema.Struct({
  attributedFilesCompleted: Schema.optionalKey(ApiSchema109),
  attributionMilliseconds: Schema.optionalKey(ApiSchema109),
  batchesCompleted: Schema.Finite,
  batchesTotal: Schema.Finite,
  cachedFactBytesCompleted: Schema.optionalKey(ApiSchema109),
  cachedFactBytesTotal: Schema.optionalKey(ApiSchema109),
  cachedFactReplayBytesCompleted: Schema.optionalKey(ApiSchema109),
  changedFactBytesCompleted: Schema.optionalKey(ApiSchema109),
  crossGenerationShardFilesCompleted: Schema.optionalKey(ApiSchema109),
  exactGenerationShardFilesCompleted: Schema.optionalKey(ApiSchema109),
  fallbackReason: Schema.optionalKey(ApiSchema10846),
  fallbackAssessment: Schema.optionalKey(ApiSchema10848),
  fallbackBoundary: Schema.optionalKey(ApiSchema10877),
  factsBytesCompleted: Schema.optionalKey(ApiSchema109),
  factsBytesTotal: Schema.optionalKey(ApiSchema109),
  loadingMilliseconds: Schema.optionalKey(ApiSchema109),
  materializedShardReplayBytesCompleted: Schema.optionalKey(ApiSchema109),
  materializedShardCacheDeferredFilesCompleted: Schema.optionalKey(ApiSchema109),
  materializedShardCacheDeferredRawFactBytesCompleted: Schema.optionalKey(ApiSchema109),
  mode: Schema.optionalKey(ApiSchema8959),
  rawFactReplayBytesCompleted: Schema.optionalKey(ApiSchema109),
  resolutionLookupKeyForm: Schema.optionalKey(ApiSchema10920),
  resolutionPublicationGate: Schema.optionalKey(ApiSchema10934),
  rows: Schema.optionalKey(ApiSchema10842),
  sourceBytesCompleted: Schema.Finite,
  sourceBytesTotal: Schema.Finite,
  stageMilliseconds: Schema.optionalKey(ApiSchema10942),
  subphaseMilliseconds: Schema.optionalKey(ApiSchema10944),
  storage: Schema.optionalKey(ApiSchema10946),
  transactionMilliseconds: Schema.optionalKey(ApiSchema109),
});
const ApiSchema10845 = Schema.Union([Schema.Undefined, ApiSchema10844]);
const ApiSchema10835 = Schema.Struct({
  activity: Schema.optionalKey(ApiSchema10840),
  metrics: Schema.optionalKey(ApiSchema10845),
});
const ApiSchema10836 = Schema.Union([Schema.Undefined, ApiSchema10835]);
const ApiSchema10951 = Schema.Struct({key: Schema.String});
const ApiSchema10952 = Schema.Union([Schema.Undefined, ApiSchema10951]);
const ApiSchema10955 = Schema.Struct({
  elapsedMilliseconds: Schema.Finite,
  generations: Schema.Finite,
  keys: Schema.Finite,
  stage: Schema.Literal('loading-cache'),
});
const ApiSchema10953 = Schema.Struct({activity: ApiSchema10955});
const ApiSchema10954 = Schema.Union([Schema.Undefined, ApiSchema10953]);
const ApiSchema10961 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('database-writer'),
  Schema.Literal('disk-capacity'),
  Schema.Literal('home-builder-cap'),
  Schema.Literal('prepared-spool-budget'),
  Schema.Literal('repository-lock'),
  Schema.Literal('request-lock'),
  Schema.Literal('snapshot-build'),
]);
const ApiSchema10969 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('prepared-spool-budget'),
  Schema.Literal('checkout-writer'),
  Schema.Literal('home-builder-slot'),
  Schema.Literal('home-preparation-slot'),
]);
const ApiSchema10976 = Schema.Union([Schema.Literal('background'), Schema.Literal('current-required')]);
const ApiSchema10970 = Schema.Struct({
  admissionClass: ApiSchema10976,
  enqueuedAt: Schema.String,
  position: Schema.Finite,
  size: Schema.Finite,
});
const ApiSchema10971 = Schema.Union([Schema.Undefined, ApiSchema10970]);
const ApiSchema10981 = Schema.Struct({
  registering: Schema.optionalKey(ApiSchema109),
  sharing: Schema.optionalKey(ApiSchema109),
  waiting: Schema.optionalKey(ApiSchema109),
  reclaiming: Schema.optionalKey(ApiSchema109),
  scanning: Schema.optionalKey(ApiSchema109),
  materializing: Schema.optionalKey(ApiSchema109),
  resolving: Schema.optionalKey(ApiSchema109),
  activating: Schema.optionalKey(ApiSchema109),
  embedding: Schema.optionalKey(ApiSchema109),
});
const ApiSchema10983 = Schema.Union([Schema.Undefined, ApiSchema10981]);
const ApiSchema10988 = Schema.Struct({
  'database-writer': Schema.optionalKey(ApiSchema109),
  'disk-capacity': Schema.optionalKey(ApiSchema109),
  'home-builder-cap': Schema.optionalKey(ApiSchema109),
  'prepared-spool-budget': Schema.optionalKey(ApiSchema109),
  'repository-lock': Schema.optionalKey(ApiSchema109),
  'request-lock': Schema.optionalKey(ApiSchema109),
  'snapshot-build': Schema.optionalKey(ApiSchema109),
});
const ApiSchema10990 = Schema.Union([Schema.Undefined, ApiSchema10988]);
const ApiSchema10957 = Schema.Struct({
  admittedAt: Schema.optionalKey(ApiSchema320),
  blocker: Schema.optionalKey(ApiSchema10961),
  resource: Schema.optionalKey(ApiSchema10969),
  queue: Schema.optionalKey(ApiSchema10971),
  phaseMilliseconds: Schema.optionalKey(ApiSchema10983),
  waitMilliseconds: Schema.optionalKey(ApiSchema10990),
});
const ApiSchema10958 = Schema.Union([Schema.Undefined, ApiSchema10957]);
const ApiSchema10991 = Schema.Struct({
  extractionMilliseconds: Schema.Finite,
  persistenceMilliseconds: Schema.Finite,
  readingMilliseconds: Schema.Finite,
  serializationMilliseconds: Schema.optionalKey(ApiSchema109),
});
const ApiSchema10992 = Schema.Union([Schema.Undefined, ApiSchema10991]);
const ApiSchema10993 = Schema.Struct({
  completedAt: Schema.optionalKey(ApiSchema320),
  heartbeatAt: Schema.String,
  lastProgressAt: Schema.String,
  phaseStartedAt: Schema.String,
  startedAt: Schema.String,
  updatedAt: Schema.String,
});
const ApiSchema10650 = Schema.Struct({
  state: ApiSchema10653,
  resolution: Schema.optionalKey(ApiSchema10655),
  result: Schema.optionalKey(ApiSchema10662),
  error: Schema.optionalKey(ApiSchema10702),
  activity: Schema.optionalKey(ApiSchema10796),
  phase: ApiSchema8372,
  owner: ApiSchema10801,
  coordination: Schema.optionalKey(ApiSchema10805),
  observation: ApiSchema10806,
  activation: Schema.optionalKey(ApiSchema10817),
  buildId: Schema.String,
  counters: ApiSchema10822,
  eta: Schema.optionalKey(ApiSchema10826),
  extraction: Schema.optionalKey(ApiSchema10828),
  identity: ApiSchema10834,
  materialization: Schema.optionalKey(ApiSchema10836),
  request: Schema.optionalKey(ApiSchema10952),
  registration: Schema.optionalKey(ApiSchema10954),
  schemaVersion: Schema.Literal(1),
  scheduling: Schema.optionalKey(ApiSchema10958),
  subphase: Schema.optionalKey(ApiSchema320),
  timings: Schema.optionalKey(ApiSchema10992),
  worktreeLockHeld: Schema.optionalKey(ApiSchema256),
  timestamps: ApiSchema10993,
});
const ApiSchema10652 = Schema.Array(ApiSchema10650);
const ApiSchema11000 = Schema.Union([
  Schema.Literal('unknown'),
  Schema.Literal('critical'),
  Schema.Literal('elevated'),
  Schema.Literal('normal'),
]);
const ApiSchema10994 = Schema.Struct({
  availableBytes: Schema.optionalKey(ApiSchema109),
  filesystemBytes: Schema.Finite,
  logicalRowsDeleted: Schema.Finite,
  reclaimablePageBytes: Schema.Finite,
  pressure: ApiSchema11000,
  temporaryBytes: Schema.Finite,
  walBytes: Schema.Finite,
});
const ApiSchema10995 = Schema.Union([Schema.Undefined, ApiSchema10994]);
const ApiSchema11005 = Schema.Union([
  Schema.Literal('ok'),
  Schema.Literal('incompatible'),
  Schema.Literal('corrupt'),
  Schema.Literal('migration-pending'),
]);
const ApiSchema11006 = Schema.Union([
  Schema.Literal('missing'),
  Schema.Literal('current'),
  Schema.Literal('incompatible'),
]);
const ApiSchema11021 = Schema.Union([
  Schema.Literal('current'),
  Schema.Literal('incompatible'),
  Schema.Literal('column-only'),
  Schema.Literal('column-only-with-authority'),
  Schema.Literal('column-only-with-predecessor-authority'),
  Schema.Literal('released-absent'),
  Schema.Literal('released-absent-with-predecessor-authority'),
  Schema.Literal('released-absent-with-authority'),
  Schema.Literal('table-absent'),
]);
const ApiSchema11001 = Schema.Struct({
  activeSnapshots: Schema.Finite,
  buildingSnapshots: Schema.Finite,
  cachedFileBlobs: Schema.Finite,
  failedSnapshots: Schema.Finite,
  foreignKeyViolations: Schema.Finite,
  integrity: ApiSchema11005,
  persistentExtensionSchemaRevision: Schema.optionalKey(ApiSchema109),
  snapshotFileCitationBaseIndexes: ApiSchema11006,
  snapshotFileCitationSchema: ApiSchema11021,
  readySnapshots: Schema.Finite,
  schemaVersion: Schema.optionalKey(ApiSchema109),
});
const ApiSchema11002 = Schema.Union([Schema.Undefined, ApiSchema11001]);
const ApiSchema11026 = Schema.Union([
  Schema.Literal('deferred'),
  Schema.Literal('checked'),
  Schema.Literal('unreadable'),
]);
const ApiSchema11037 = Schema.Union([
  Schema.Literal('active-build'),
  Schema.Literal('analysis-failed'),
  Schema.Literal('catalog-unavailable'),
  Schema.Literal('health-check-failed'),
  Schema.Literal('orphan-provenance-cursor-recovered'),
]);
const ApiSchema11027 = Schema.Struct({code: ApiSchema11037, message: Schema.String});
const ApiSchema11028 = Schema.Array(ApiSchema11027);
const ApiSchema11051 = Schema.Union([
  Schema.Literal('cleanup-sidecar'),
  Schema.Literal('reclaim-generation'),
  Schema.Literal('remove-view-pointer'),
  Schema.Literal('retire-abandoned-build'),
]);
const ApiSchema1655 = Schema.Tuple([]);
const ApiSchema11076 = Schema.Union([
  Schema.Literal('missing-view'),
  Schema.Literal('abandoned-build'),
  Schema.Literal('orphaned-sidecar'),
  Schema.Literal('retired-generation'),
]);
const ApiSchema11038 = Schema.Struct({
  action: ApiSchema11051,
  disposition: Schema.Literal('reclaim'),
  protections: ApiSchema1655,
  reason: Schema.Literal('authority-proven'),
  state: ApiSchema11076,
});
const ApiSchema11091 = Schema.Union([
  Schema.Literal('active-maintenance'),
  Schema.Literal('active-writer'),
  Schema.Literal('active-lease'),
  Schema.Literal('active-pin'),
  Schema.Literal('required-base'),
  Schema.Literal('live-sibling-consumer'),
]);
const ApiSchema11092 = Schema.Array(ApiSchema11091);
const ApiSchema11096 = Schema.Union([Schema.Literal('required-clean-base'), Schema.Literal('protected')]);
const ApiSchema11072 = Schema.Union([
  Schema.Literal('missing-view'),
  Schema.Literal('abandoned-build'),
  Schema.Literal('unreadable-store'),
  Schema.Literal('corrupt-store'),
  Schema.Literal('orphaned-sidecar'),
  Schema.Literal('retired-generation'),
  Schema.Literal('required-clean-base'),
]);
const ApiSchema11039 = Schema.Struct({
  action: Schema.Literal('preserve'),
  disposition: Schema.Literal('preserve'),
  protections: ApiSchema11092,
  reason: ApiSchema11096,
  state: ApiSchema11072,
});
const ApiSchema11101 = Schema.Union([
  Schema.Literal('manual-rebuild'),
  Schema.Literal('retry-observation'),
  Schema.Literal('verify-authority'),
]);
const ApiSchema11106 = Schema.Union([
  Schema.Literal('confirmed-corruption'),
  Schema.Literal('unreadable'),
  Schema.Literal('insufficient-authority'),
]);
const ApiSchema11040 = Schema.Struct({
  action: ApiSchema11101,
  disposition: Schema.Literal('observe'),
  protections: ApiSchema11092,
  reason: ApiSchema11106,
  state: ApiSchema11072,
});
const ApiSchema11041 = Schema.Union([ApiSchema11038, ApiSchema11039, ApiSchema11040]);
const ApiSchema11042 = Schema.Array(ApiSchema11041);
const ApiSchema11156 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('freelist'),
  Schema.Literal('freelist-and-fragmentation'),
]);
const ApiSchema11149 = Schema.Struct({
  reason: Schema.optionalKey(ApiSchema11156),
  minimumReclaimableBytes: Schema.Finite,
  minimumReclaimableRatio: Schema.Finite,
});
const ApiSchema11138 = Schema.Struct({
  reason: Schema.Literal('active-build'),
  state: Schema.Literal('deferred'),
  threshold: ApiSchema11149,
});
const ApiSchema11167 = Schema.Union([Schema.Literal('index'), Schema.Literal('internal'), Schema.Literal('table')]);
const ApiSchema11161 = Schema.Struct({
  bytes: Schema.Finite,
  kind: ApiSchema11167,
  name: Schema.String,
  pages: Schema.Finite,
});
const ApiSchema11162 = Schema.Array(ApiSchema11161);
const ApiSchema11186 = Schema.Union([
  Schema.Literal('lifecycle'),
  Schema.Literal('analysis'),
  Schema.Literal('facts-cache'),
  Schema.Literal('lexical'),
  Schema.Literal('lookup-resolution'),
  Schema.Literal('other'),
  Schema.Literal('structural-graph'),
  Schema.Literal('workspace-inventory'),
]);
const ApiSchema11169 = Schema.Struct({
  bytes: Schema.Finite,
  name: ApiSchema11186,
  objectCount: Schema.Finite,
  pages: Schema.Finite,
});
const ApiSchema11170 = Schema.Array(ApiSchema11169);
const ApiSchema11190 = Schema.Struct({
  activeLogicalPayloadBytes: Schema.Finite,
  activeLogicalPayloadBytesPerSymbol: Schema.optionalKey(ApiSchema109),
  activeSnapshotCount: Schema.Finite,
  activeSymbolCount: Schema.Finite,
  attributedBtreeBytes: Schema.Finite,
  attributedBtreeBytesPerSymbol: Schema.optionalKey(ApiSchema109),
  denominator: Schema.Literal('unique-active-snapshot-symbols'),
  readyLogicalPayloadBytes: Schema.Finite,
  retiredLogicalPayloadBytes: Schema.Finite,
});
const ApiSchema11195 = Schema.Struct({
  classifier: Schema.String,
  edgeRows: Schema.Finite,
  factRawBytes: Schema.Finite,
  factStoredBytes: Schema.Finite,
  files: Schema.Finite,
  logicalBytes: Schema.Finite,
  logicalRows: Schema.Finite,
  lookupRows: Schema.Finite,
  sourceBytes: Schema.Finite,
  symbolRows: Schema.Finite,
});
const ApiSchema11196 = Schema.Array(ApiSchema11195);
const ApiSchema11193 = Schema.Struct({
  active: Schema.Boolean,
  associatedFactRawBytes: Schema.Finite,
  associatedFactStoredBytes: Schema.Finite,
  classifiers: ApiSchema11196,
  commit: Schema.String,
  completedAt: Schema.optionalKey(ApiSchema320),
  edgeCount: Schema.Finite,
  id: Schema.String,
  logicalPayloadBytes: Schema.Finite,
  logicalRows: Schema.Finite,
  state: ApiSchema10626,
  symbolCount: Schema.Finite,
});
const ApiSchema11194 = Schema.Array(ApiSchema11193);
const ApiSchema11187 = Schema.Struct({
  baseline: ApiSchema11190,
  snapshots: ApiSchema11194,
  snapshotsTruncated: Schema.Boolean,
  state: Schema.Literal('available'),
});
const ApiSchema11188 = Schema.Struct({
  reason: Schema.Literal('snapshot-attribution-unavailable'),
  state: Schema.Literal('unavailable'),
});
const ApiSchema11189 = Schema.Union([ApiSchema11187, ApiSchema11188]);
const ApiSchema11168 = Schema.Struct({
  groups: ApiSchema11170,
  groupsComplete: Schema.Boolean,
  snapshots: ApiSchema11189,
});
const ApiSchema11157 = Schema.Struct({
  allocatedBytes: Schema.Finite,
  attributedBytes: Schema.Finite,
  freelistBytes: Schema.Finite,
  fragmentedBytes: Schema.Finite,
  objectCount: Schema.Finite,
  objects: ApiSchema11162,
  objectsTruncated: Schema.Boolean,
  semantic: ApiSchema11168,
  state: Schema.Literal('available'),
  unattributedBytes: Schema.Finite,
});
const ApiSchema11158 = Schema.Struct({
  reason: Schema.Literal('sqlite-dbstat-unavailable'),
  state: Schema.Literal('unavailable'),
});
const ApiSchema11160 = Schema.Union([Schema.Undefined, ApiSchema11157, ApiSchema11158]);
const ApiSchema11142 = Schema.Struct({
  minimumReclaimableBytes: Schema.Finite,
  minimumReclaimableRatio: Schema.Finite,
  recommended: Schema.Boolean,
  reason: Schema.optionalKey(ApiSchema11156),
});
const ApiSchema11139 = Schema.Struct({
  attribution: Schema.optionalKey(ApiSchema11160),
  compactionOpportunityBytes: Schema.optionalKey(ApiSchema109),
  compactionOpportunityRatio: Schema.optionalKey(ApiSchema109),
  freelistPages: Schema.Finite,
  fragmentedBytes: Schema.optionalKey(ApiSchema109),
  fragmentationRatio: Schema.optionalKey(ApiSchema109),
  pageCount: Schema.Finite,
  pageSize: Schema.Finite,
  reclaimableBytes: Schema.Finite,
  reclaimableRatio: Schema.Finite,
  state: Schema.Literal('available'),
  threshold: ApiSchema11142,
});
const ApiSchema11140 = Schema.Struct({
  reason: Schema.Literal('database-busy-or-unreadable'),
  state: Schema.Literal('unavailable'),
  threshold: ApiSchema11149,
});
const ApiSchema11141 = Schema.Union([ApiSchema11138, ApiSchema11139, ApiSchema11140]);
const ApiSchema11131 = Schema.Struct({
  state: Schema.Literal('available'),
  checkoutId: Schema.String,
  availableBytes: Schema.optionalKey(ApiSchema109),
  databaseBytes: Schema.Finite,
  filesystemBytes: Schema.Finite,
  journalBytes: Schema.Finite,
  pageStorage: ApiSchema11141,
  shmBytes: Schema.Finite,
  totalBytes: Schema.Finite,
  temporaryBytes: Schema.Finite,
  walBytes: Schema.Finite,
});
const ApiSchema11135 = Schema.Struct({state: Schema.Literal('missing'), checkoutId: Schema.String});
const ApiSchema11137 = Schema.Union([ApiSchema11131, ApiSchema11135]);
const ApiSchema10588 = Schema.Struct({
  views: ApiSchema10604,
  builds: ApiSchema10652,
  waiters: ApiSchema10652,
  checkoutId: Schema.String,
  accounting: Schema.optionalKey(ApiSchema10995),
  health: Schema.optionalKey(ApiSchema11002),
  healthState: ApiSchema11026,
  issues: ApiSchema11028,
  lifecycle: ApiSchema11042,
  storage: ApiSchema11137,
});
const ApiSchema10590 = Schema.Array(ApiSchema10588);
const ApiSchema11201 = Schema.Struct({analyze: Schema.Boolean, deep: Schema.Boolean});
const ApiSchema11202 = Schema.Struct({
  activeBuildCount: Schema.Finite,
  analysisCompleteCount: Schema.Finite,
  analysisPartialCount: Schema.Finite,
  databaseCount: Schema.Finite,
  deferredDatabaseCount: Schema.Finite,
  healthyDatabaseCount: Schema.Finite,
  migrationPendingDatabaseCount: Schema.Finite,
  readySnapshotCount: Schema.Finite,
  totalStorageBytes: Schema.Finite,
  unhealthyDatabaseCount: Schema.Finite,
  unreadableDatabaseCount: Schema.Finite,
  viewCount: Schema.Finite,
  waiterCount: Schema.Finite,
});
const ApiSchema7706 = Schema.Array(Schema.Finite);
const ApiSchema11204 = Schema.Struct({
  bytes: Schema.Finite,
  checkoutId: Schema.String,
  fileCount: Schema.Finite,
  versions: ApiSchema7706,
});
const ApiSchema11205 = Schema.Array(ApiSchema11204);
const ApiSchema11203 = Schema.Struct({
  bytes: Schema.Finite,
  checkouts: ApiSchema11205,
  fileCount: Schema.Finite,
  unsafeEntryCount: Schema.Finite,
});
const ApiSchema7010 = Schema.Struct({
  databases: ApiSchema10590,
  version: Schema.Literal(2),
  mode: ApiSchema11201,
  summary: ApiSchema11202,
  generatedAt: Schema.String,
  obsoleteStores: ApiSchema11203,
  type: Schema.Literal('code-graph-diagnostics'),
});
const ApiSchema11215 = Schema.Union([
  Schema.Literal('removed'),
  Schema.Literal('ready'),
  Schema.Literal('already-removed'),
  Schema.Literal('not-found'),
  Schema.Literal('stale-target'),
]);
const ApiSchema11208 = Schema.Struct({state: ApiSchema11215});
const ApiSchema7015 = Schema.Struct({approvalDigest: Schema.String, output: Schema.String, result: ApiSchema11208});
const ApiSchema7789 = Schema.Union([
  Schema.Literal('unknown'),
  Schema.Literal('descriptive'),
  Schema.Literal('normative'),
  Schema.Literal('historical'),
]);
const ApiSchema7479 = Schema.Union([
  Schema.Literal('direct'),
  Schema.Literal('contextual'),
  Schema.Literal('unresolved'),
]);
const ApiSchema7787 = Schema.Struct({
  ordinal: Schema.Finite,
  hash: Schema.String,
  role: ApiSchema7789,
  support: ApiSchema7479,
  evidenceIds: ApiSchema279,
  scope: Schema.optionalKey(ApiSchema320),
  validity: Schema.optionalKey(ApiSchema320),
});
const ApiSchema7788 = Schema.Array(ApiSchema7787);
const ApiSchema7718 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('unavailable'),
  Schema.Literal('capsule-retained'),
]);
const ApiSchema7719 = Schema.Struct({algorithm: Schema.Literal('sha256'), value: Schema.String});
const ApiSchema7724 = Schema.Union([Schema.Literal('local'), Schema.Literal('remote')]);
const ApiSchema7725 = Schema.Struct({kind: Schema.Literal('file')});
const ApiSchema7732 = Schema.Union([Schema.Undefined, ApiSchema7719]);
const ApiSchema7733 = Schema.Struct({
  column: Schema.Finite,
  endColumn: Schema.Finite,
  endLine: Schema.Finite,
  line: Schema.Finite,
});
const ApiSchema7726 = Schema.Struct({
  fragmentCanonicalization: Schema.Literal('utf8-source-span-v1'),
  fragmentHash: ApiSchema7719,
  kind: Schema.Literal('symbol'),
  language: Schema.String,
  name: Schema.String,
  nodeId: Schema.String,
  qualifiedName: Schema.String,
  signatureHash: Schema.optionalKey(ApiSchema7732),
  span: ApiSchema7733,
  symbolKind: Schema.String,
});
const ApiSchema7727 = Schema.Union([ApiSchema7725, ApiSchema7726]);
const ApiSchema7714 = Schema.Struct({
  anchorId: Schema.optionalKey(ApiSchema320),
  evidenceRetention: Schema.optionalKey(ApiSchema7718),
  extractorSet: Schema.String,
  fileContentHash: ApiSchema7719,
  id: Schema.String,
  path: Schema.String,
  repositoryId: Schema.String,
  repositoryIdentityKind: ApiSchema7724,
  sourceCommit: Schema.String,
  sourceDirty: Schema.Boolean,
  sourceGraphContentId: Schema.optionalKey(ApiSchema320),
  sourceSnapshotId: Schema.String,
  target: ApiSchema7727,
  version: Schema.Literal(1),
});
const ApiSchema7710 = Schema.Struct({kind: Schema.Literal('code'), citation: ApiSchema7714});
const ApiSchema7734 = Schema.Struct({
  version: Schema.Literal(1),
  sourceId: Schema.String,
  sourceInstanceId: Schema.String,
  vaultHash: Schema.String,
  accessHash: Schema.String,
  noteId: Schema.String,
  relativePath: Schema.String,
  revisionHash: Schema.String,
  sanitizerVersion: Schema.String,
  fragmentHash: Schema.String,
  fragmentStart: Schema.Finite,
  fragmentEnd: Schema.Finite,
  pinId: Schema.String,
  expiresAt: Schema.String,
});
const ApiSchema7711 = Schema.Struct({kind: Schema.Literal('obsidian'), evidence: ApiSchema7734});
const ApiSchema7737 = Schema.Struct({
  ordinal: Schema.Finite,
  hash: Schema.String,
  startOffset: Schema.Finite,
  endOffset: Schema.Finite,
});
const ApiSchema7712 = Schema.Struct({
  kind: Schema.Literal('memory'),
  uri: Schema.String,
  memoryId: Schema.optionalKey(ApiSchema320),
  canonicalHash: Schema.String,
  fragment: ApiSchema7737,
});
const ApiSchema7713 = Schema.Union([ApiSchema7710, ApiSchema7711, ApiSchema7712]);
const ApiSchema7742 = Schema.Union([
  Schema.Literal('shared'),
  Schema.Literal('repository'),
  Schema.Literal('personal'),
  Schema.Literal('external'),
]);
const ApiSchema7792 = Schema.Struct({repositoryId: Schema.String, teamId: Schema.String, path: Schema.String});
const ApiSchema7793 = Schema.Union([Schema.Undefined, ApiSchema7792]);
const ApiSchema7790 = Schema.Struct({
  id: Schema.String,
  source: ApiSchema7713,
  scope: ApiSchema7742,
  locator: Schema.optionalKey(ApiSchema7793),
});
const ApiSchema7791 = Schema.Array(ApiSchema7790);
const ApiSchema7794 = Schema.Struct({
  reviewId: Schema.String,
  approvedAt: Schema.String,
  targetBeforeHash: Schema.String,
  preparationDigest: Schema.String,
  sourceVectorDigest: Schema.String,
});
const ApiSchema7786 = Schema.Struct({
  bodyHash: Schema.String,
  paragraphs: ApiSchema7788,
  sources: ApiSchema7791,
  acceptance: ApiSchema7794,
  digest: Schema.String,
});
const ApiSchema7795 = Schema.Union([Schema.Undefined, ApiSchema7786]);
const ApiSchema596 = Schema.Union([
  Schema.Literal('durable'),
  Schema.Literal('handoff'),
  Schema.Literal('incident'),
  Schema.Literal('preference'),
  Schema.Literal('smoke'),
]);
const ApiSchema606 = Schema.Union([
  Schema.Literal('active'),
  Schema.Literal('archived'),
  Schema.Literal('expired'),
  Schema.Literal('superseded'),
]);
const ApiSchema7806 = Schema.Union([Schema.Literal('MEMORY'), Schema.Literal('HANDOFF')]);
const ApiSchema7807 = Schema.Array(ApiSchema7714);
const ApiSchema7816 = Schema.Union([
  Schema.Literal('depends_on'),
  Schema.Literal('references'),
  Schema.Literal('evidence_for'),
  Schema.Literal('related_to'),
  Schema.Literal('supersedes'),
]);
const ApiSchema5171 = Schema.Struct({type: ApiSchema7816, uri: Schema.String});
const ApiSchema5172 = Schema.Array(ApiSchema5171);
const ApiSchema7469 = Schema.Union([
  Schema.Literal('descriptive'),
  Schema.Literal('normative'),
  Schema.Literal('historical'),
]);
const ApiSchema7830 = Schema.Struct({
  ordinal: Schema.Finite,
  hash: Schema.String,
  role: ApiSchema7469,
  support: ApiSchema7479,
  citationIds: ApiSchema279,
  scope: Schema.optionalKey(ApiSchema320),
  validity: Schema.optionalKey(ApiSchema320),
});
const ApiSchema7831 = Schema.Array(ApiSchema7830);
const ApiSchema7838 = Schema.Union([Schema.Literal('configuration'), Schema.Literal('dependency')]);
const ApiSchema7832 = Schema.Struct({kind: ApiSchema7838, citationId: Schema.String});
const ApiSchema7833 = Schema.Array(ApiSchema7832);
const ApiSchema7819 = Schema.Struct({
  version: Schema.Literal(1),
  memoryId: Schema.String,
  repositoryId: Schema.String,
  bodyHash: Schema.String,
  coverage: Schema.Literal('declared-only'),
  paragraphs: ApiSchema7831,
  additionalDependencies: ApiSchema7833,
});
const ApiSchema7847 = Schema.Struct({citationId: Schema.String, acceptedCitationId: Schema.String});
const ApiSchema7848 = Schema.Array(ApiSchema7847);
const ApiSchema7820 = Schema.Struct({
  version: Schema.Literal(2),
  originCitationIds: ApiSchema279,
  acceptedSources: ApiSchema7848,
  coverage: Schema.Literal('declared-only'),
  paragraphs: ApiSchema7831,
  memoryId: Schema.String,
  repositoryId: Schema.String,
  bodyHash: Schema.String,
  additionalDependencies: ApiSchema7833,
});
const ApiSchema7856 = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.String,
  proofDigest: Schema.String,
  requestDigest: Schema.String,
  previousManifestHash: Schema.String,
  sourceCommit: Schema.String,
  citationIds: ApiSchema279,
});
const ApiSchema7857 = Schema.Array(ApiSchema7856);
const ApiSchema7858 = Schema.Union([Schema.Undefined, ApiSchema7857]);
const ApiSchema7822 = Schema.Struct({
  version: Schema.Literal(3),
  sourceKind: Schema.Literal('code'),
  dependencyExpansions: Schema.optionalKey(ApiSchema7858),
  coverage: Schema.Literal('declared-only'),
  paragraphs: ApiSchema7831,
  memoryId: Schema.String,
  repositoryId: Schema.String,
  bodyHash: Schema.String,
  additionalDependencies: ApiSchema7833,
  originCitationIds: ApiSchema279,
  acceptedSources: ApiSchema7848,
});
const ApiSchema7825 = Schema.Struct({
  version: Schema.Literal(3),
  sourceKind: Schema.Literal('obsidian'),
  memoryId: Schema.String,
  bodyHash: Schema.String,
  coverage: Schema.Literal('declared-only'),
  paragraphs: ApiSchema7831,
  additionalDependencies: ApiSchema1655,
  originCitationId: Schema.String,
  activeEvidence: ApiSchema7734,
});
const ApiSchema7827 = Schema.Union([Schema.Undefined, ApiSchema7819, ApiSchema7820, ApiSchema7822, ApiSchema7825]);
const ApiSchema7862 = Schema.Struct({
  uri: Schema.String,
  revision: Schema.String,
  memoryId: Schema.optionalKey(ApiSchema320),
  fragments: ApiSchema279,
  codeCitations: ApiSchema7807,
  relations: ApiSchema5172,
});
const ApiSchema7863 = Schema.Array(ApiSchema7862);
const ApiSchema7864 = Schema.Union([
  Schema.Literal('unsupported'),
  Schema.Literal('direct'),
  Schema.Literal('contextual'),
  Schema.Literal('unresolved'),
]);
const ApiSchema7865 = Schema.Struct({
  sourceUri: Schema.String,
  fragment: Schema.Finite,
  citationIds: ApiSchema279,
  relationIndexes: ApiSchema7706,
});
const ApiSchema7866 = Schema.Array(ApiSchema7865);
const ApiSchema7363 = Schema.Struct({section: Schema.String, disposition: ApiSchema7864, supports: ApiSchema7866});
const ApiSchema7364 = Schema.Array(ApiSchema7363);
const ApiSchema7869 = Schema.Union([Schema.Literal('archive'), Schema.Literal('forget'), Schema.Literal('keep')]);
const ApiSchema7870 = Schema.Struct({
  kind: ApiSchema596,
  status: ApiSchema606,
  project: Schema.String,
  topic: Schema.String,
  sourceAgentClient: Schema.String,
});
const ApiSchema7352 = Schema.Struct({
  version: Schema.Literal(1),
  bodyHash: Schema.String,
  requestHash: Schema.String,
  sources: ApiSchema7863,
  reviews: ApiSchema7364,
  operationId: Schema.String,
  cleanup: ApiSchema7869,
  cleanupShared: Schema.Boolean,
  target: ApiSchema7870,
});
const ApiSchema7878 = Schema.Union([Schema.Literal('origin'), Schema.Literal('reviewed-current')]);
const ApiSchema7872 = Schema.Struct({
  ordinal: Schema.Finite,
  originOrdinal: Schema.Finite,
  hash: Schema.String,
  evidence: ApiSchema7878,
  citationIds: ApiSchema279,
});
const ApiSchema7873 = Schema.Array(ApiSchema7872);
const ApiSchema7871 = Schema.Struct({
  reviewId: Schema.String,
  targetBeforeHash: Schema.String,
  packetDigest: Schema.String,
  observationRevision: Schema.String,
  paragraphs: ApiSchema7873,
});
const ApiSchema7859 = Schema.Struct({
  version: Schema.Literal(2),
  origin: ApiSchema7352,
  originBody: Schema.String,
  bodyHash: Schema.String,
  requestHash: Schema.String,
  acceptance: ApiSchema7871,
});
const ApiSchema7861 = Schema.Union([Schema.Undefined, ApiSchema7352, ApiSchema7859]);
const ApiSchema7879 = Schema.Union([Schema.Undefined, ApiSchema7734]);
const ApiSchema7892 = Schema.Union([
  Schema.Literal('superhuman'),
  Schema.Literal('pocket'),
  Schema.Literal('linear'),
  Schema.Literal('github'),
]);
const ApiSchema7882 = Schema.Struct({
  version: Schema.Literal(1),
  provider: ApiSchema7892,
  sourceId: Schema.String,
  sourceInstanceId: Schema.String,
  resourceUri: Schema.String,
  accessHash: Schema.String,
  revisionHash: Schema.String,
  contentHash: Schema.String,
  rendererVersion: Schema.String,
  sanitizerVersion: Schema.String,
  fragmentHash: Schema.String,
  fragmentStart: Schema.Finite,
  fragmentEnd: Schema.Finite,
  pinId: Schema.String,
  expiresAt: Schema.String,
});
const ApiSchema7883 = Schema.Union([Schema.Undefined, ApiSchema7882]);
const ApiSchema7796 = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.String,
  body: Schema.String,
  memoryId: Schema.optionalKey(ApiSchema320),
  kind: ApiSchema596,
  status: ApiSchema606,
  headerTitle: ApiSchema7806,
  codeCitations: ApiSchema7807,
  relations: ApiSchema5172,
  topicMaintenance: Schema.optionalKey(ApiSchema7827),
  consolidation: Schema.optionalKey(ApiSchema7861),
  obsidianEvidence: Schema.optionalKey(ApiSchema7879),
  sourceEvidence: Schema.optionalKey(ApiSchema7883),
  digest: Schema.String,
});
const ApiSchema7797 = Schema.Union([Schema.Undefined, ApiSchema7796]);
const ApiSchema7783 = Schema.Struct({
  type: Schema.Literal('reviewed-memory-support'),
  version: Schema.Literal(1),
  active: ApiSchema7786,
  initialApproval: Schema.optionalKey(ApiSchema7795),
  legacyOrigin: Schema.optionalKey(ApiSchema7797),
});
const ApiSchema11216 = Schema.Union([Schema.Undefined, ApiSchema7783]);
const ApiSchema6653 = Schema.Union([Schema.Undefined, Schema.Literal('code'), Schema.Literal('obsidian')]);
const ApiSchema11217 = Schema.Struct({version: Schema.Finite, sourceKind: Schema.optionalKey(ApiSchema6653)});
const ApiSchema11218 = Schema.Union([Schema.Undefined, ApiSchema11217]);
const ApiSchema7354 = Schema.Union([Schema.Undefined, ApiSchema7352]);
const ApiSchema7071 = Schema.Union([
  Schema.Literal('durable'),
  Schema.Literal('handoff'),
  Schema.Literal('incident'),
  Schema.Literal('preference'),
  Schema.Literal('smoke'),
]);
const ApiSchema7072 = Schema.Union([
  Schema.Literal('active'),
  Schema.Literal('archived'),
  Schema.Literal('expired'),
  Schema.Literal('superseded'),
]);
const ApiSchema4166 = Schema.Struct({
  reviewedSupport: Schema.optionalKey(ApiSchema11216),
  topicMaintenance: Schema.optionalKey(ApiSchema11218),
  consolidation: Schema.optionalKey(ApiSchema7354),
  consolidationError: Schema.optionalKey(ApiSchema320),
  archivedFrom: Schema.optionalKey(ApiSchema320),
  kind: ApiSchema7071,
  project: Schema.optionalKey(ApiSchema320),
  sourceAgentClient: Schema.String,
  status: ApiSchema7072,
  supersedes: Schema.optionalKey(ApiSchema320),
  timestamp: Schema.String,
  topic: Schema.optionalKey(ApiSchema320),
});
const ApiSchema4164 = Schema.Struct({
  body: Schema.String,
  content: Schema.String,
  metadata: ApiSchema4166,
  uri: Schema.String,
});
const ApiSchema4165 = Schema.Union([Schema.Undefined, ApiSchema4164]);
const ApiSchema4161 = Schema.Struct({
  content: Schema.String,
  node: TreeNodeSchema,
  record: Schema.optionalKey(ApiSchema4165),
});
const ApiSchema4162 = Schema.Union([Schema.Undefined, ApiSchema4161]);
const ApiSchema7058 = Schema.Struct({
  content: Schema.String,
  localMemory: Schema.optionalKey(ApiSchema4162),
  output: Schema.String,
});
const ApiSchema7174 = Schema.Struct({
  error: Schema.optionalKey(ApiSchema320),
  ok: Schema.Boolean,
  output: Schema.optionalKey(ApiSchema320),
  uri: Schema.String,
});
const ApiSchema7175 = Schema.Array(ApiSchema7174);
const ApiSchema7176 = Schema.Struct({results: ApiSchema7175});
const ApiSchema11223 = Schema.Union([Schema.Literal('ok'), Schema.Literal('fail'), Schema.Literal('warn')]);
const ApiSchema7206 = Schema.Struct({detail: Schema.String, name: Schema.String, status: ApiSchema11223});
const ApiSchema7207 = Schema.Array(ApiSchema7206);
const ApiSchema7208 = Schema.Struct({checks: ApiSchema7207, shares: ApiSchema7004});

export const isTreeResponse = Schema.is(ApiSchema6999);
export const isSharesResponse = Schema.is(ApiSchema7005);
export const isCodeGraphLocalDiagnosticsReport = Schema.is(ApiSchema7010);
export const isManagerGraphViewRemovalResponse = Schema.is(ApiSchema7015);
export const isMemoryResponse = Schema.is(ApiSchema4161);
export const isReadResponse = Schema.is(ApiSchema7058);
export const isResultsResponse = Schema.is(ApiSchema7176);
export const isCheckssharesResponse = Schema.is(ApiSchema7208);
