import {Schema} from 'effect';

const ApiSchema279 = Schema.Array(Schema.String);
const ApiSchema555 = Schema.Union([Schema.Undefined, ApiSchema279]);
const ApiSchema892 = Schema.Struct({id: Schema.String, pages: Schema.optionalKey(ApiSchema555)});
const ApiSchema893 = Schema.Array(ApiSchema892);
const ApiSchema320 = Schema.Union([Schema.Undefined, Schema.String]);
const ApiSchema894 = Schema.Struct({
  documentId: Schema.String,
  pageId: Schema.optionalKey(ApiSchema320),
  name: Schema.String,
  browserLink: Schema.optionalKey(ApiSchema320),
  iconUrl: Schema.optionalKey(ApiSchema320),
});
const ApiSchema895 = Schema.Array(ApiSchema894);
const ApiSchema858 = Schema.Struct({documents: ApiSchema893, selections: ApiSchema895});
const ApiSchema7603 = Schema.Struct({id: Schema.String, name: Schema.String});
const ApiSchema7604 = Schema.Array(ApiSchema7603);
const ApiSchema7605 = Schema.Struct({id: Schema.String, name: Schema.String});
const ApiSchema7606 = Schema.Array(ApiSchema7605);
const ApiSchema7607 = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  url: Schema.String,
  teamId: Schema.String,
  projectId: Schema.optionalKey(ApiSchema320),
});
const ApiSchema7608 = Schema.Array(ApiSchema7607);
const ApiSchema1452 = Schema.Struct({
  organizationId: Schema.String,
  principalId: Schema.String,
  teams: ApiSchema7604,
  projects: ApiSchema7606,
  issues: ApiSchema7608,
});
const ApiSchema1542 = Schema.Struct({ticket: Schema.String});
const ApiSchema7640 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('cli'),
  Schema.Literal('graph-builder'),
  Schema.Literal('graph-embedding-worker'),
  Schema.Literal('graph-compaction-worker'),
  Schema.Literal('graph-diagnostics-worker'),
  Schema.Literal('graph-parser-worker'),
  Schema.Literal('graph-query-worker'),
  Schema.Literal('graph-waiter'),
  Schema.Literal('integration-sync-worker'),
  Schema.Literal('local-model-worker'),
  Schema.Literal('manager'),
  Schema.Literal('mcp'),
  Schema.Literal('mcp-broker'),
]);
const ApiSchema7641 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('cli'),
  Schema.Literal('graph-builder'),
  Schema.Literal('graph-embedding-worker'),
  Schema.Literal('graph-compaction-worker'),
  Schema.Literal('graph-diagnostics-worker'),
  Schema.Literal('graph-parser-worker'),
  Schema.Literal('graph-query-worker'),
  Schema.Literal('graph-waiter'),
  Schema.Literal('integration-sync-worker'),
  Schema.Literal('legacy'),
  Schema.Literal('local-model-worker'),
  Schema.Literal('manager'),
  Schema.Literal('mcp'),
  Schema.Literal('mcp-broker'),
]);
const ApiSchema7638 = Schema.Union([
  Schema.Literal('cli'),
  Schema.Literal('graph-builder'),
  Schema.Literal('graph-embedding-worker'),
  Schema.Literal('graph-compaction-worker'),
  Schema.Literal('graph-diagnostics-worker'),
  Schema.Literal('graph-parser-worker'),
  Schema.Literal('graph-query-worker'),
  Schema.Literal('graph-waiter'),
  Schema.Literal('integration-sync-worker'),
  Schema.Literal('legacy'),
  Schema.Literal('local-model-worker'),
  Schema.Literal('manager'),
  Schema.Literal('mcp'),
  Schema.Literal('mcp-broker'),
]);
const ApiSchema109 = Schema.Union([Schema.Undefined, Schema.Finite]);
const ApiSchema7649 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('current-manager'),
  Schema.Literal('identity-unverified'),
  Schema.Literal('legacy-process'),
]);
const ApiSchema6061 = Schema.Struct({
  activityRole: Schema.optionalKey(ApiSchema7640),
  ageMilliseconds: Schema.Finite,
  currentOperation: Schema.optionalKey(ApiSchema320),
  parentProcessId: Schema.Finite,
  parentRole: Schema.optionalKey(ApiSchema7641),
  processId: Schema.Finite,
  processRef: Schema.optionalKey(ApiSchema320),
  releaseVersion: Schema.optionalKey(ApiSchema320),
  role: ApiSchema7638,
  rssBytes: Schema.optionalKey(ApiSchema109),
  startedAt: Schema.String,
  terminable: Schema.Boolean,
  terminationBlockedReason: Schema.optionalKey(ApiSchema7649),
});
const ApiSchema7609 = Schema.Array(ApiSchema6061);
const ApiSchema2722 = Schema.Struct({
  processes: ApiSchema7609,
  schemaVersion: Schema.Finite,
  truncated: Schema.Boolean,
});
const ApiSchema4049 = Schema.Union([Schema.Literal('automatic'), Schema.Literal('off')]);
const ApiSchema7658 = Schema.Union([
  Schema.Literal('off'),
  Schema.Literal('pending'),
  Schema.Literal('ready'),
  Schema.Literal('not-requested'),
  Schema.Literal('downloading'),
  Schema.Literal('verifying'),
  Schema.Literal('retry-wait'),
  Schema.Literal('action-required'),
]);
const ApiSchema3996 = Schema.Struct({
  version: Schema.Literal(1),
  intentEpoch: Schema.Finite,
  modelId: Schema.String,
  totalBytes: Schema.Finite,
  policy: ApiSchema4049,
  phase: ApiSchema7658,
  bytes: Schema.Finite,
  attempts: Schema.Finite,
  artifactReady: Schema.Boolean,
  effectiveDefault: Schema.Boolean,
  environmentOff: Schema.Boolean,
  nextAttemptAt: Schema.optionalKey(ApiSchema109),
  reason: Schema.optionalKey(ApiSchema320),
});
const ApiSchema4052 = Schema.Struct({output: Schema.String});
const ApiSchema7660 = Schema.Struct({name: Schema.String, roots: ApiSchema279});
const ApiSchema7661 = Schema.Array(ApiSchema7660);
const ApiSchema7659 = Schema.Struct({expectedRevision: Schema.String, projects: ApiSchema7661});
const ApiSchema4053 = Schema.Struct({scopeSelection: ApiSchema7659});
const ApiSchema4054 = Schema.Union([ApiSchema4052, ApiSchema4053]);
const ApiSchema4114 = Schema.Union([
  Schema.Literal('pending'),
  Schema.Literal('deferred'),
  Schema.Literal('rejected'),
  Schema.Literal('applying'),
  Schema.Literal('applied'),
  Schema.Literal('conflict'),
]);
const ApiSchema4097 = Schema.Union([Schema.Literal('automatic'), Schema.Literal('manual-edit')]);
const ApiSchema7695 = Schema.Union([
  Schema.Literal('unknown'),
  Schema.Literal('descriptive'),
  Schema.Literal('normative'),
  Schema.Literal('historical'),
]);
const ApiSchema7696 = Schema.Union([
  Schema.Literal('direct'),
  Schema.Literal('contextual'),
  Schema.Literal('unresolved'),
]);
const ApiSchema7693 = Schema.Struct({
  ordinal: Schema.Finite,
  beforeHash: Schema.String,
  role: ApiSchema7695,
  support: ApiSchema7696,
  evidenceIds: ApiSchema279,
});
const ApiSchema7694 = Schema.Array(ApiSchema7693);
const ApiSchema7703 = Schema.Union([
  Schema.Literal('policy-conflict'),
  Schema.Literal('propose-update'),
  Schema.Literal('propose-revalidation'),
  Schema.Literal('insufficient-evidence'),
]);
const ApiSchema7704 = Schema.Struct({
  ordinal: Schema.Finite,
  beforeHash: Schema.String,
  text: Schema.String,
  supportHandles: ApiSchema279,
  rationale: Schema.String,
});
const ApiSchema7705 = Schema.Array(ApiSchema7704);
const ApiSchema7675 = Schema.Struct({
  version: Schema.Literal(2),
  kind: Schema.Literal('automatic'),
  purpose: ApiSchema4097,
  paragraphDecisions: ApiSchema7694,
  desiredBody: Schema.optionalKey(ApiSchema320),
  observationRevision: Schema.String,
  targetHash: Schema.String,
  packetDigest: Schema.String,
  outcome: ApiSchema7703,
  operations: ApiSchema7705,
  reviewedHandles: ApiSchema279,
  rationale: Schema.String,
  unresolvedQuestions: ApiSchema279,
  removedClaims: ApiSchema279,
});
const ApiSchema7706 = Schema.Array(Schema.Finite);
const ApiSchema7662 = Schema.Struct({
  version: Schema.Literal(2),
  kind: Schema.Literal('automatic'),
  draft: ApiSchema7675,
  body: Schema.String,
  finalBodyHash: Schema.String,
  changedOrdinals: ApiSchema7706,
});
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
const ApiSchema7743 = Schema.Struct({repositoryId: Schema.String, teamId: Schema.String, path: Schema.String});
const ApiSchema7744 = Schema.Union([Schema.Undefined, ApiSchema7743]);
const ApiSchema7709 = Schema.Struct({
  id: Schema.String,
  source: ApiSchema7713,
  scope: ApiSchema7742,
  locator: Schema.optionalKey(ApiSchema7744),
});
const ApiSchema7745 = Schema.Struct({startLine: Schema.Finite, endLine: Schema.Finite, fileBytesHash: Schema.String});
const ApiSchema7746 = Schema.Union([Schema.Undefined, ApiSchema7745]);
const ApiSchema7707 = Schema.Struct({
  handleId: Schema.String,
  descriptor: ApiSchema7709,
  content: Schema.String,
  contentHash: Schema.String,
  codeExcerpt: Schema.optionalKey(ApiSchema7746),
});
const ApiSchema7708 = Schema.Array(ApiSchema7707);
const ApiSchema7765 = Schema.Union([Schema.Literal('unknown'), Schema.Literal('complete'), Schema.Literal('partial')]);
const ApiSchema7772 = Schema.Union([
  Schema.Literal('recorded-only'),
  Schema.Literal('bounded-search'),
  Schema.Literal('none'),
]);
const ApiSchema7773 = Schema.Union([Schema.Null, Schema.Finite]);
const ApiSchema7764 = Schema.Struct({
  outcome: ApiSchema7765,
  scope: ApiSchema7772,
  searchedScopes: ApiSchema279,
  omittedSources: Schema.Finite,
  omittedParagraphs: ApiSchema7773,
});
const ApiSchema7780 = Schema.Union([
  Schema.Literal('preview'),
  Schema.Literal('conflict'),
  Schema.Literal('parked'),
  Schema.Literal('prepared'),
  Schema.Literal('written'),
]);
const ApiSchema7781 = Schema.Struct({field: Schema.String, beforeHash: Schema.String, afterHash: Schema.String});
const ApiSchema7782 = Schema.Array(ApiSchema7781);
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
const ApiSchema1655 = Schema.Tuple([]);
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
const ApiSchema4120 = Schema.Struct({
  stage: ApiSchema7780,
  reviewRevision: Schema.Finite,
  approvalDigest: Schema.String,
  content: Schema.String,
  contentHash: Schema.String,
  metadataDiff: ApiSchema7782,
  reviewedSupport: ApiSchema7783,
});
const ApiSchema4121 = Schema.Union([Schema.Undefined, ApiSchema4120]);
const ApiSchema4116 = Schema.Struct({instructions: Schema.String, publicationApprovalRequired: Schema.Boolean});
const ApiSchema4117 = Schema.Union([Schema.Undefined, ApiSchema4116]);
const ApiSchema4056 = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal('automatic-memory-review'),
  project: Schema.String,
  reviewId: Schema.String,
  revision: Schema.Finite,
  state: ApiSchema4114,
  targetUri: Schema.String,
  targetHash: Schema.String,
  evidenceRevision: Schema.String,
  purpose: ApiSchema4097,
  acceptedBody: Schema.String,
  proposal: ApiSchema7662,
  sourceEvidence: ApiSchema7708,
  coverage: ApiSchema7764,
  approval: Schema.optionalKey(ApiSchema4121),
  canApply: Schema.Boolean,
  canFinishVerification: Schema.Boolean,
  verified: Schema.Boolean,
  ownerProposal: Schema.optionalKey(ApiSchema4117),
});
const ApiSchema4087 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('checking'),
  Schema.Literal('target-changed'),
  Schema.Literal('source-changed'),
  Schema.Literal('source-unavailable'),
  Schema.Literal('scope-changed'),
  Schema.Literal('policy-changed'),
  Schema.Literal('verification-unavailable'),
]);
const ApiSchema7893 = Schema.Struct({action: Schema.Literal('reject')});
const ApiSchema7894 = Schema.Union([Schema.Undefined, ApiSchema7893]);
const ApiSchema4057 = Schema.Struct({
  reason: Schema.optionalKey(ApiSchema4087),
  version: Schema.Literal(1),
  kind: Schema.Literal('topic-maintenance-recovery'),
  project: Schema.String,
  reviewId: Schema.String,
  revision: Schema.Finite,
  state: ApiSchema4114,
  caseId: Schema.optionalKey(ApiSchema320),
  recovery: Schema.optionalKey(ApiSchema7894),
});
const ApiSchema4058 = Schema.Union([ApiSchema4056, ApiSchema4057]);

export const isResolvedSuperhumanSelection = Schema.is(ApiSchema858);
export const isResolvedLinearSelection = Schema.is(ApiSchema1452);
export const isTicketResponse = Schema.is(ApiSchema1542);
export const isManagerProcessDiagnostics = Schema.is(ApiSchema2722);
export const isModelSetupStatus = Schema.is(ApiSchema3996);
export const isGraphIndexActionResponse = Schema.is(ApiSchema4054);
export const isManagerAutomaticReviewOrManagerTopicReviewRecoveryV1 = Schema.is(ApiSchema4058);
export const isManagerAutomaticReview = Schema.is(ApiSchema4056);
