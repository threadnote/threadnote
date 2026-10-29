import {Schema} from 'effect';

const ApiSchema6065 = Schema.Struct({status: Schema.Literal('ok')});
const ApiSchema8788 = Schema.Struct({state: Schema.Literal('idle')});
const ApiSchema8789 = Schema.Struct({startedAt: Schema.String, state: Schema.Literal('inspecting')});
const ApiSchema8790 = Schema.Struct({
  checkoutId: Schema.String,
  opportunityBytes: Schema.Finite,
  startedAt: Schema.String,
  state: Schema.Literal('running'),
});
const ApiSchema8805 = Schema.Union([
  Schema.Literal('missing'),
  Schema.Literal('no-candidate'),
  Schema.Literal('not-needed'),
]);
const ApiSchema8791 = Schema.Struct({
  action: ApiSchema8805,
  completedAt: Schema.String,
  inspected: Schema.Finite,
  inspectionFailures: Schema.Finite,
  state: Schema.Literal('completed'),
});
const ApiSchema8792 = Schema.Struct({
  action: Schema.Literal('compacted'),
  checkoutId: Schema.String,
  completedAt: Schema.String,
  reclaimedBytes: Schema.Finite,
  startedAt: Schema.String,
  state: Schema.Literal('completed'),
});
const ApiSchema8812 = Schema.Union([Schema.Literal('active-build'), Schema.Literal('active-maintenance')]);
const ApiSchema8793 = Schema.Struct({
  checkoutId: Schema.String,
  completedAt: Schema.String,
  reason: ApiSchema8812,
  startedAt: Schema.String,
  state: Schema.Literal('deferred'),
});
const ApiSchema320 = Schema.Union([Schema.Undefined, Schema.String]);
const ApiSchema8817 = Schema.Union([Schema.Literal('compaction-failed'), Schema.Literal('inspection-failed')]);
const ApiSchema8794 = Schema.Struct({
  checkoutId: Schema.optionalKey(ApiSchema320),
  completedAt: Schema.String,
  reason: ApiSchema8817,
  startedAt: Schema.String,
  state: Schema.Literal('failed'),
});
const ApiSchema8796 = Schema.Union([
  Schema.Undefined,
  ApiSchema8788,
  ApiSchema8789,
  ApiSchema8790,
  ApiSchema8791,
  ApiSchema8792,
  ApiSchema8793,
  ApiSchema8794,
]);
const ApiSchema109 = Schema.Union([Schema.Undefined, Schema.Finite]);
const ApiSchema8845 = Schema.Union([
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
const ApiSchema8822 = Schema.Struct({
  elapsedMilliseconds: Schema.Finite,
  rows: Schema.optionalKey(ApiSchema109),
  stage: ApiSchema8845,
  stageElapsedMilliseconds: Schema.Finite,
  startedAt: Schema.String,
  state: ApiSchema8849,
  transactionMilliseconds: Schema.optionalKey(ApiSchema109),
});
const ApiSchema8820 = Schema.Struct({activity: ApiSchema8822});
const ApiSchema8821 = Schema.Union([Schema.Undefined, ApiSchema8820]);
const ApiSchema256 = Schema.Union([Schema.Undefined, Schema.Literal(false), Schema.Literal(true)]);
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
const ApiSchema8850 = Schema.Struct({
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
const ApiSchema8851 = Schema.Union([Schema.Undefined, ApiSchema8850]);
const ApiSchema8877 = Schema.Union([Schema.Literal('history'), Schema.Literal('owner'), Schema.Literal('waiter')]);
const ApiSchema8871 = Schema.Struct({
  lockVerified: Schema.Boolean,
  progressSilent: Schema.optionalKey(ApiSchema256),
  role: ApiSchema8877,
});
const ApiSchema8872 = Schema.Union([Schema.Undefined, ApiSchema8871]);
const ApiSchema8878 = Schema.Struct({
  accepted: Schema.optionalKey(ApiSchema109),
  completed: Schema.optionalKey(ApiSchema109),
  edges: Schema.optionalKey(ApiSchema109),
  excluded: Schema.optionalKey(ApiSchema109),
  pagesCompleted: Schema.optionalKey(ApiSchema109),
  reused: Schema.optionalKey(ApiSchema109),
  resolved: Schema.optionalKey(ApiSchema109),
  rowsDeleted: Schema.optionalKey(ApiSchema109),
  skipped: Schema.optionalKey(ApiSchema109),
  symbols: Schema.optionalKey(ApiSchema109),
  total: Schema.optionalKey(ApiSchema109),
  unit: Schema.optionalKey(ApiSchema320),
});
const ApiSchema8879 = Schema.Struct({summary: Schema.String});
const ApiSchema8880 = Schema.Union([Schema.Undefined, ApiSchema8879]);
const ApiSchema8892 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('files'),
  Schema.Literal('cached-fact-bytes'),
  Schema.Literal('extraction-work'),
  Schema.Literal('final-fact-bytes'),
  Schema.Literal('source-bytes'),
]);
const ApiSchema8899 = Schema.Union([Schema.Literal('high'), Schema.Literal('low'), Schema.Literal('medium')]);
const ApiSchema8881 = Schema.Struct({
  basis: Schema.optionalKey(ApiSchema8892),
  confidence: ApiSchema8899,
  remainingMilliseconds: Schema.Finite,
});
const ApiSchema8882 = Schema.Union([Schema.Undefined, ApiSchema8881]);
const ApiSchema8902 = Schema.Struct({
  factsBytesCompleted: Schema.Finite,
  sourceBytesCompleted: Schema.Finite,
  sourceBytesTotal: Schema.Finite,
  workUnitsCompleted: Schema.Finite,
  workUnitsTotal: Schema.Finite,
});
const ApiSchema8903 = Schema.Union([Schema.Undefined, ApiSchema8902]);
const ApiSchema8862 = Schema.Union([
  Schema.Literal('0-16KiB'),
  Schema.Literal('16-64KiB'),
  Schema.Literal('64-256KiB'),
  Schema.Literal('256KiB-1MiB'),
  Schema.Literal('>1MiB'),
]);
const ApiSchema8904 = Schema.Struct({
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
const ApiSchema8905 = Schema.Array(ApiSchema8904);
const ApiSchema8900 = Schema.Struct({
  completedFiles: Schema.Finite,
  metrics: Schema.optionalKey(ApiSchema8903),
  slowFiles: Schema.Finite,
  topSlowFiles: ApiSchema8905,
});
const ApiSchema8901 = Schema.Union([Schema.Undefined, ApiSchema8900]);
const ApiSchema8906 = Schema.Struct({
  checkoutId: Schema.String,
  commit: Schema.String,
  displayName: Schema.optionalKey(ApiSchema320),
  repositoryId: Schema.String,
  scopeId: Schema.optionalKey(ApiSchema320),
  worktreeId: Schema.String,
});
const ApiSchema8907 = Schema.Struct({branch: Schema.optionalKey(ApiSchema320), worktreePath: Schema.String});
const ApiSchema8908 = Schema.Union([Schema.Undefined, ApiSchema8907]);
const ApiSchema8914 = Schema.Union([
  Schema.Literal('active'),
  Schema.Literal('completed'),
  Schema.Literal('failed'),
  Schema.Literal('abandoned'),
  Schema.Literal('stalled'),
]);
const ApiSchema8909 = Schema.Struct({heartbeatAgeMilliseconds: Schema.Finite, liveness: ApiSchema8914});
const ApiSchema8919 = Schema.Struct({
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
const ApiSchema8920 = Schema.Union([Schema.Undefined, ApiSchema8919]);
const ApiSchema8949 = Schema.Union([
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
const ApiSchema8917 = Schema.Struct({
  batchCompleted: Schema.Finite,
  batchTotal: Schema.Finite,
  cachedFactBytes: Schema.optionalKey(ApiSchema109),
  elapsedMilliseconds: Schema.optionalKey(ApiSchema109),
  factsBytes: Schema.optionalKey(ApiSchema109),
  rows: Schema.optionalKey(ApiSchema8920),
  sourceBytes: Schema.Finite,
  stage: ApiSchema8949,
  stageElapsedMilliseconds: Schema.optionalKey(ApiSchema109),
  startedAt: Schema.String,
  transactionMilliseconds: Schema.optionalKey(ApiSchema109),
});
const ApiSchema8918 = Schema.Union([Schema.Undefined, ApiSchema8917]);
const ApiSchema8959 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('full'),
  Schema.Literal('incremental-clean'),
  Schema.Literal('incremental-overlay'),
]);
const ApiSchema8964 = Schema.Struct({
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
const ApiSchema8966 = Schema.Union([Schema.Undefined, ApiSchema8964]);
const ApiSchema8967 = Schema.Struct({
  attributionCompute: Schema.Finite,
  factBatchPreparation: Schema.Finite,
  shardAssociation: Schema.Finite,
  shardPersistence: Schema.Finite,
  shardSerialization: Schema.Finite,
});
const ApiSchema8968 = Schema.Union([Schema.Undefined, ApiSchema8967]);
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
const ApiSchema8969 = Schema.Struct({
  availableBytes: Schema.optionalKey(ApiSchema109),
  durableAvailableBytes: Schema.optionalKey(ApiSchema109),
  durableDatabaseBytes: Schema.optionalKey(ApiSchema109),
  durableDatabaseFileBytes: Schema.optionalKey(ApiSchema109),
  durableDatabaseFileHighWaterBytes: Schema.optionalKey(ApiSchema109),
  durableDatabaseGrowthBytes: Schema.optionalKey(ApiSchema109),
  durableDatabaseGrowthHighWaterBytes: Schema.optionalKey(ApiSchema109),
  durableDatabaseHighWaterBytes: Schema.optionalKey(ApiSchema109),
  durableDatabaseStartBytes: Schema.optionalKey(ApiSchema109),
  durableFilesystemBytes: Schema.optionalKey(ApiSchema109),
  durableFilesystemHighWaterBytes: Schema.optionalKey(ApiSchema109),
  durableJournalBytes: Schema.optionalKey(ApiSchema109),
  durableJournalHighWaterBytes: Schema.optionalKey(ApiSchema109),
  durableSharedMemoryBytes: Schema.optionalKey(ApiSchema109),
  durableSharedMemoryHighWaterBytes: Schema.optionalKey(ApiSchema109),
  durableWalBytes: Schema.optionalKey(ApiSchema109),
  durableWalHighWaterBytes: Schema.optionalKey(ApiSchema109),
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
  temporaryAvailableBytes: Schema.optionalKey(ApiSchema109),
  temporaryDatabaseBytes: Schema.Finite,
  temporaryDatabaseHighWaterBytes: Schema.Finite,
});
const ApiSchema8970 = Schema.Union([Schema.Undefined, ApiSchema8969]);
const ApiSchema8950 = Schema.Struct({
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
  fallbackReason: Schema.optionalKey(ApiSchema320),
  factsBytesCompleted: Schema.optionalKey(ApiSchema109),
  factsBytesTotal: Schema.optionalKey(ApiSchema109),
  loadingMilliseconds: Schema.optionalKey(ApiSchema109),
  materializedShardReplayBytesCompleted: Schema.optionalKey(ApiSchema109),
  mode: Schema.optionalKey(ApiSchema8959),
  rawFactReplayBytesCompleted: Schema.optionalKey(ApiSchema109),
  rows: Schema.optionalKey(ApiSchema8920),
  sourceBytesCompleted: Schema.Finite,
  sourceBytesTotal: Schema.Finite,
  stageMilliseconds: Schema.optionalKey(ApiSchema8966),
  subphaseMilliseconds: Schema.optionalKey(ApiSchema8968),
  storage: Schema.optionalKey(ApiSchema8970),
  transactionMilliseconds: Schema.optionalKey(ApiSchema109),
});
const ApiSchema8951 = Schema.Union([Schema.Undefined, ApiSchema8950]);
const ApiSchema8915 = Schema.Struct({
  activity: Schema.optionalKey(ApiSchema8918),
  metrics: Schema.optionalKey(ApiSchema8951),
});
const ApiSchema8916 = Schema.Union([Schema.Undefined, ApiSchema8915]);
const ApiSchema8981 = Schema.Struct({processId: Schema.Finite, processStartIdentity: Schema.optionalKey(ApiSchema320)});
const ApiSchema8982 = Schema.Struct({key: Schema.String});
const ApiSchema8983 = Schema.Union([Schema.Undefined, ApiSchema8982]);
const ApiSchema8987 = Schema.Struct({
  preparingBatch: Schema.Finite,
  retiringReferences: Schema.Finite,
  updatingAnalysis: Schema.Finite,
  writingAliases: Schema.Finite,
  writingEdges: Schema.Finite,
});
const ApiSchema8988 = Schema.Union([Schema.Undefined, ApiSchema8987]);
const ApiSchema8986 = Schema.Struct({
  aliasesDiscovered: Schema.Finite,
  elapsedMilliseconds: Schema.Finite,
  matchingMilliseconds: Schema.Finite,
  pageCompleted: Schema.Finite,
  pageTotal: Schema.Finite,
  pagesCompleted: Schema.Finite,
  pass: Schema.Finite,
  referencesCompleted: Schema.Finite,
  referencesExamined: Schema.Finite,
  referencesTotal: Schema.Finite,
  resolved: Schema.Finite,
  startedAt: Schema.String,
  transactionMilliseconds: Schema.Finite,
  transactionStageMilliseconds: Schema.optionalKey(ApiSchema8988),
});
const ApiSchema8984 = Schema.Struct({activity: ApiSchema8986});
const ApiSchema8985 = Schema.Union([Schema.Undefined, ApiSchema8984]);
const ApiSchema8989 = Schema.Struct({snapshotId: Schema.String});
const ApiSchema8990 = Schema.Union([Schema.Undefined, ApiSchema8989]);
const ApiSchema8991 = Schema.Union([
  Schema.Literal('running'),
  Schema.Literal('completed'),
  Schema.Literal('failed'),
  Schema.Literal('queued'),
]);
const ApiSchema8992 = Schema.Struct({
  extractionMilliseconds: Schema.Finite,
  persistenceMilliseconds: Schema.Finite,
  readingMilliseconds: Schema.Finite,
  serializationMilliseconds: Schema.optionalKey(ApiSchema109),
});
const ApiSchema8993 = Schema.Union([Schema.Undefined, ApiSchema8992]);
const ApiSchema8994 = Schema.Struct({
  heartbeatAt: Schema.String,
  lastProgressAt: Schema.String,
  startedAt: Schema.String,
});
const ApiSchema8818 = Schema.Struct({
  activation: Schema.optionalKey(ApiSchema8821),
  activity: Schema.optionalKey(ApiSchema8851),
  buildId: Schema.String,
  coordination: Schema.optionalKey(ApiSchema8872),
  counters: ApiSchema8878,
  error: Schema.optionalKey(ApiSchema8880),
  eta: Schema.optionalKey(ApiSchema8882),
  extraction: Schema.optionalKey(ApiSchema8901),
  identity: ApiSchema8906,
  managerContext: Schema.optionalKey(ApiSchema8908),
  observation: ApiSchema8909,
  materialization: Schema.optionalKey(ApiSchema8916),
  owner: ApiSchema8981,
  phase: Schema.String,
  request: Schema.optionalKey(ApiSchema8983),
  resolution: Schema.optionalKey(ApiSchema8985),
  result: Schema.optionalKey(ApiSchema8990),
  state: ApiSchema8991,
  subphase: Schema.optionalKey(ApiSchema320),
  timings: Schema.optionalKey(ApiSchema8993),
  timestamps: ApiSchema8994,
});
const ApiSchema8819 = Schema.Array(ApiSchema8818);
const ApiSchema9001 = Schema.Union([Schema.Literal('graph-maintenance'), Schema.Literal('selected-snapshot-purge')]);
const ApiSchema9019 = Schema.Union([
  Schema.Literal('status-unavailable'),
  Schema.Literal('acquiring-gates'),
  Schema.Literal('waiting-builders'),
  Schema.Literal('verifying-vectors'),
  Schema.Literal('verifying-graph'),
  Schema.Literal('retiring-and-cleaning'),
  Schema.Literal('working'),
]);
const ApiSchema8995 = Schema.Struct({
  checkoutId: Schema.optionalKey(ApiSchema320),
  completed: Schema.optionalKey(ApiSchema109),
  operation: ApiSchema9001,
  phase: ApiSchema9019,
  snapshotId: Schema.optionalKey(ApiSchema320),
  startedAt: Schema.optionalKey(ApiSchema320),
  total: Schema.optionalKey(ApiSchema109),
  updatedAt: Schema.optionalKey(ApiSchema320),
});
const ApiSchema8996 = Schema.Union([Schema.Undefined, ApiSchema8995]);
const ApiSchema6085 = Schema.Struct({
  automaticCompaction: Schema.optionalKey(ApiSchema8796),
  builds: ApiSchema8819,
  catalogRevision: Schema.optionalKey(ApiSchema320),
  lifecyclePending: Schema.optionalKey(ApiSchema256),
  maintenance: Schema.optionalKey(ApiSchema8996),
  waiterCount: Schema.Finite,
  waiters: ApiSchema8819,
});
const ApiSchema9025 = Schema.Union([Schema.Literal('ready'), Schema.Literal('unknown'), Schema.Literal('not-indexed')]);
const ApiSchema9020 = Schema.Struct({
  folder: Schema.String,
  graphState: ApiSchema9025,
  name: Schema.String,
  path: Schema.String,
  scopeId: Schema.optionalKey(ApiSchema320),
});
const ApiSchema9021 = Schema.Array(ApiSchema9020);
const ApiSchema9022 = Schema.Union([Schema.Undefined, ApiSchema9021]);
const ApiSchema9034 = Schema.Union([
  Schema.Literal('no-ready-snapshot'),
  Schema.Literal('lease-deferred'),
  Schema.Literal('lease-failed'),
  Schema.Literal('unreadable-database'),
]);
const ApiSchema9026 = Schema.Struct({checkoutId: Schema.String, code: ApiSchema9034, message: Schema.String});
const ApiSchema9027 = Schema.Array(ApiSchema9026);
const ApiSchema9040 = Schema.Union([Schema.Literal('maintenance'), Schema.Literal('active-build')]);
const ApiSchema9035 = Schema.Struct({reason: ApiSchema9040, state: Schema.Literal('deferred')});
const ApiSchema9036 = Schema.Struct({state: Schema.Literal('unavailable')});
const ApiSchema9037 = Schema.Struct({
  blockedRepositories: Schema.Finite,
  checkedAt: Schema.String,
  pendingRepositories: Schema.Finite,
  viewCleanupAdvanced: Schema.Boolean,
  repositoryCount: Schema.Finite,
  state: Schema.Literal('observed'),
  unavailableRepositories: Schema.Finite,
  viewsTruncated: Schema.Boolean,
});
const ApiSchema9039 = Schema.Union([Schema.Undefined, ApiSchema9035, ApiSchema9036, ApiSchema9037]);
const ApiSchema7531 = Schema.Struct({
  attributedSymbols: Schema.Finite,
  componentSymbols: Schema.Finite,
  fallbackSymbols: Schema.Finite,
  omittedSymbols: Schema.Finite,
  totalSymbols: Schema.Finite,
});
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
const ApiSchema7534 = Schema.Union([Schema.Literal('deferred'), Schema.Literal('complete')]);
const ApiSchema7552 = Schema.Union([Schema.Literal('legacy-fallback'), Schema.Literal('workspace')]);
const ApiSchema7560 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('legacy-fallback'),
  Schema.Literal('component'),
  Schema.Literal('facet'),
]);
const ApiSchema7553 = Schema.Struct({
  buildSystem: Schema.optionalKey(ApiSchema320),
  fileCount: Schema.optionalKey(ApiSchema109),
  id: Schema.String,
  kind: Schema.optionalKey(ApiSchema320),
  label: Schema.String,
  model: Schema.optionalKey(ApiSchema7560),
  provenance: Schema.optionalKey(ApiSchema320),
  symbolCount: Schema.optionalKey(ApiSchema109),
  workspaceId: Schema.optionalKey(ApiSchema320),
});
const ApiSchema7554 = Schema.Array(ApiSchema7553);
const ApiSchema7535 = Schema.Struct({
  commit: Schema.String,
  completedAt: Schema.optionalKey(ApiSchema320),
  dirty: Schema.Boolean,
  edgeCount: Schema.Finite,
  fileCount: Schema.Finite,
  id: Schema.String,
  symbolCount: Schema.Finite,
});
const ApiSchema7561 = Schema.Struct({
  buildSystem: Schema.String,
  id: Schema.String,
  name: Schema.String,
  root: Schema.String,
});
const ApiSchema7562 = Schema.Array(ApiSchema7561);
const ApiSchema7518 = Schema.Struct({
  accounting: ApiSchema7531,
  activatedAt: Schema.optionalKey(ApiSchema320),
  checkoutId: Schema.String,
  displayName: Schema.String,
  id: Schema.String,
  label: Schema.String,
  localAssociation: ApiSchema7538,
  metrics: ApiSchema7534,
  model: ApiSchema7552,
  projectCount: Schema.Finite,
  projects: ApiSchema7554,
  projectsTruncated: Schema.Boolean,
  scopeId: Schema.optionalKey(ApiSchema320),
  snapshot: ApiSchema7535,
  worktreeId: Schema.String,
  workspaceCount: Schema.Finite,
  workspaces: ApiSchema7562,
  workspacesTruncated: Schema.Boolean,
});
const ApiSchema7565 = Schema.Array(ApiSchema7518);
const ApiSchema7563 = Schema.Struct({
  defaultViewId: Schema.String,
  displayName: Schema.String,
  id: Schema.String,
  repositoryId: Schema.String,
  views: ApiSchema7565,
  viewsTruncated: Schema.Boolean,
});
const ApiSchema7564 = Schema.Array(ApiSchema7563);
const ApiSchema9051 = Schema.Union([Schema.Literal('missing'), Schema.Literal('unavailable')]);
const ApiSchema9043 = Schema.Struct({state: ApiSchema9051});
const ApiSchema9062 = Schema.Union([
  Schema.Literal('not-needed'),
  Schema.Literal('eligible'),
  Schema.Literal('space-unknown'),
  Schema.Literal('waiting-for-space'),
]);
const ApiSchema9052 = Schema.Struct({
  allocatedBytes: Schema.Finite,
  automaticCompaction: ApiSchema9062,
  compactionOpportunityBytes: Schema.optionalKey(ApiSchema109),
  inUseBytes: Schema.Finite,
  reclaimableRatio: Schema.Finite,
  requiredFreeBytes: Schema.optionalKey(ApiSchema109),
  reusableBytes: Schema.Finite,
  state: Schema.Literal('available'),
});
const ApiSchema9053 = Schema.Struct({reason: Schema.Literal('active-build'), state: Schema.Literal('deferred')});
const ApiSchema9054 = Schema.Struct({
  reason: Schema.Literal('database-busy-or-unreadable'),
  state: Schema.Literal('unavailable'),
});
const ApiSchema9055 = Schema.Union([ApiSchema9052, ApiSchema9053, ApiSchema9054]);
const ApiSchema9044 = Schema.Struct({
  databaseBytes: Schema.Finite,
  pageStorage: ApiSchema9055,
  physicalBytes: Schema.Finite,
  sidecarBytes: Schema.Finite,
  state: Schema.Literal('available'),
});
const ApiSchema9045 = Schema.Union([ApiSchema9043, ApiSchema9044]);
const ApiSchema9048 = Schema.Record(Schema.String, ApiSchema9045);
const ApiSchema9050 = Schema.Union([Schema.Undefined, ApiSchema9048]);
const ApiSchema6069 = Schema.Struct({
  automaticCompaction: Schema.optionalKey(ApiSchema8796),
  builds: ApiSchema8819,
  catalogRevision: Schema.optionalKey(ApiSchema320),
  configuredProjects: Schema.optionalKey(ApiSchema9022),
  diagnostics: ApiSchema9027,
  lifecyclePending: Schema.optionalKey(ApiSchema256),
  reconciliation: Schema.optionalKey(ApiSchema9039),
  maintenance: Schema.optionalKey(ApiSchema8996),
  manifestRevision: Schema.optionalKey(ApiSchema320),
  repositories: ApiSchema7564,
  storage: Schema.optionalKey(ApiSchema9050),
  waiterCount: Schema.Finite,
  waiters: ApiSchema8819,
});
const ApiSchema9065 = Schema.Struct({
  memories: Schema.optionalKey(ApiSchema109),
  coverage: Schema.optionalKey(ApiSchema320),
  scanned: Schema.optionalKey(ApiSchema109),
  pending: Schema.optionalKey(ApiSchema109),
  outcomes: Schema.optionalKey(ApiSchema109),
  decisionMemories: Schema.optionalKey(ApiSchema109),
  healthCoverage: Schema.optionalKey(ApiSchema320),
});
const ApiSchema9066 = Schema.Union([Schema.Undefined, ApiSchema9065]);
const ApiSchema9067 = Schema.Struct({
  timestamp: Schema.String,
  topic: Schema.optionalKey(ApiSchema320),
  project: Schema.optionalKey(ApiSchema320),
  uri: Schema.String,
});
const ApiSchema9068 = Schema.Array(ApiSchema9067);
const ApiSchema9074 = Schema.Union([
  Schema.Literal('context-health'),
  Schema.Literal('reviews'),
  Schema.Literal('context'),
]);
const ApiSchema9079 = Schema.Union([Schema.Literal('reviews'), Schema.Literal('health'), Schema.Literal('value')]);
const ApiSchema9084 = Schema.Union([
  Schema.Literal('unavailable'),
  Schema.Literal('attention'),
  Schema.Literal('clear'),
]);
const ApiSchema9069 = Schema.Struct({
  action: ApiSchema9074,
  count: Schema.optionalKey(ApiSchema109),
  detail: Schema.String,
  id: ApiSchema9079,
  status: ApiSchema9084,
  title: Schema.String,
});
const ApiSchema9070 = Schema.Array(ApiSchema9069);
const ApiSchema6106 = Schema.Struct({
  stats: Schema.optionalKey(ApiSchema9066),
  handoffs: ApiSchema9068,
  lanes: ApiSchema9070,
  project: Schema.String,
  version: Schema.Literal(1),
});

export const isStatusResponse = Schema.is(ApiSchema6065);
export const isStatus = Schema.is(ApiSchema6085);
export const isGraphCatalog = Schema.is(ApiSchema6069);
export const isHomeResponse = Schema.is(ApiSchema6106);
