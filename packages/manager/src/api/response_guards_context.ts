import {Schema} from 'effect';

const ApiSchema320 = Schema.Union([Schema.Undefined, Schema.String]);
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
const ApiSchema279 = Schema.Array(Schema.String);
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
const ApiSchema8026 = Schema.Struct({
  estimatedTokens: Schema.Finite,
  structuredBytes: Schema.Finite,
  textBytes: Schema.Finite,
  totalBytes: Schema.Finite,
});
const ApiSchema8035 = Schema.Record(Schema.String, Schema.Finite);
const ApiSchema8032 = Schema.Struct({
  complete: Schema.Boolean,
  consideredRepositories: Schema.Finite,
  readyRepositories: Schema.Finite,
  requestedRepositories: Schema.Finite,
  states: ApiSchema8035,
});
const ApiSchema7706 = Schema.Array(Schema.Finite);
const ApiSchema8040 = Schema.Union([Schema.Undefined, ApiSchema7706]);
const ApiSchema8038 = Schema.Struct({
  complete: Schema.Boolean,
  matchedMemories: Schema.Finite,
  requested: Schema.Finite,
  resolved: Schema.Finite,
  unresolvedOrdinals: Schema.optionalKey(ApiSchema8040),
});
const ApiSchema8039 = Schema.Union([Schema.Undefined, ApiSchema8038]);
const ApiSchema8037 = Schema.Struct({
  codeAnchors: Schema.optionalKey(ApiSchema8039),
  consideredCandidates: Schema.Finite,
  durableCandidates: Schema.Finite,
  fresh: Schema.Finite,
  handoffCandidates: Schema.Finite,
  stale: Schema.Finite,
  unknown: Schema.Finite,
});
const ApiSchema109 = Schema.Union([Schema.Undefined, Schema.Finite]);
const ApiSchema8041 = Schema.Struct({
  durableDecisions: Schema.Finite,
  coverageGaps: Schema.Finite,
  recommendedFollowUps: Schema.Finite,
  graphCards: Schema.Finite,
  graphContracts: Schema.Finite,
  sourceExcerpts: Schema.optionalKey(ApiSchema109),
  activeHandoffs: Schema.Finite,
  stalenessAndConflicts: Schema.Finite,
  verifiedProcedures: Schema.optionalKey(ApiSchema109),
});
const ApiSchema8031 = Schema.Struct({
  gaps: ApiSchema279,
  graph: ApiSchema8032,
  memory: ApiSchema8037,
  omissions: ApiSchema8041,
});
const ApiSchema8069 = Schema.Struct({
  anchors: Schema.optionalKey(ApiSchema320),
  attempted: Schema.optionalKey(ApiSchema320),
  avoidRepeat: Schema.optionalKey(ApiSchema320),
  blockers: Schema.optionalKey(ApiSchema320),
  decisions: Schema.optionalKey(ApiSchema320),
  graphQuery: Schema.optionalKey(ApiSchema320),
  graphQuestion: Schema.optionalKey(ApiSchema320),
  observations: Schema.optionalKey(ApiSchema320),
  invariants: Schema.optionalKey(ApiSchema320),
  nextStep: Schema.optionalKey(ApiSchema320),
  rationale: Schema.optionalKey(ApiSchema320),
  risks: Schema.optionalKey(ApiSchema320),
  task: Schema.optionalKey(ApiSchema320),
  unresolved: Schema.optionalKey(ApiSchema320),
  verification: Schema.optionalKey(ApiSchema320),
});
const ApiSchema8070 = Schema.Union([Schema.Undefined, ApiSchema8069]);
const ApiSchema8071 = Schema.Union([Schema.Undefined, Schema.Literal(true)]);
const ApiSchema8099 = Schema.Union([
  Schema.Literal('source-changed'),
  Schema.Literal('ambiguous-relocation'),
  Schema.Literal('citation-limit'),
  Schema.Literal('exact'),
  Schema.Literal('extractor-mismatch'),
  Schema.Literal('graph-incomplete'),
  Schema.Literal('graph-stale'),
  Schema.Literal('malformed-citation'),
  Schema.Literal('relocated'),
  Schema.Literal('repository-ambiguous'),
  Schema.Literal('repository-unavailable'),
  Schema.Literal('source-deleted'),
  Schema.Literal('validation-error'),
]);
const ApiSchema8102 = Schema.Union([
  Schema.Literal('unknown'),
  Schema.Literal('changed'),
  Schema.Literal('exact'),
  Schema.Literal('relocated'),
  Schema.Literal('deleted'),
]);
const ApiSchema8072 = Schema.Struct({
  citationId: Schema.String,
  observedNodeId: Schema.optionalKey(ApiSchema320),
  reason: ApiSchema8099,
  relocationHint: Schema.optionalKey(ApiSchema320),
  status: ApiSchema8102,
});
const ApiSchema8073 = Schema.Array(ApiSchema8072);
const ApiSchema8074 = Schema.Union([Schema.Undefined, ApiSchema8073]);
const ApiSchema8109 = Schema.Union([Schema.Literal('current-complete'), Schema.Literal('incomplete')]);
const ApiSchema8103 = Schema.Struct({
  coverage: ApiSchema8109,
  exact: Schema.Finite,
  relocated: Schema.Finite,
  stale: Schema.Finite,
  unknown: Schema.Finite,
  validatorVersion: Schema.Literal(1),
});
const ApiSchema8104 = Schema.Union([Schema.Undefined, ApiSchema8103]);
const ApiSchema8112 = Schema.Union([Schema.Literal('stale'), Schema.Literal('unknown'), Schema.Literal('fresh')]);
const ApiSchema8117 = Schema.Union([Schema.Literal('code-citations'), Schema.Literal('source-commit')]);
const ApiSchema8118 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('unknown'),
  Schema.Literal('changed'),
  Schema.Literal('exact'),
  Schema.Literal('relocated'),
  Schema.Literal('deleted'),
]);
const ApiSchema8122 = Schema.Union([Schema.Literal('symbol'), Schema.Literal('file')]);
const ApiSchema8119 = Schema.Struct({
  anchorOrdinal: Schema.Finite,
  citationId: Schema.String,
  kind: ApiSchema8122,
  status: ApiSchema8102,
});
const ApiSchema8120 = Schema.Array(ApiSchema8119);
const ApiSchema8121 = Schema.Union([Schema.Undefined, ApiSchema8120]);
const ApiSchema8125 = Schema.Union([Schema.Undefined, Schema.Literal('code-citation')]);
const ApiSchema8126 = Schema.Union([Schema.Literal('durable'), Schema.Literal('handoff')]);
const ApiSchema8127 = Schema.Struct({
  appliesTo: Schema.String,
  invariant: Schema.String,
  avoid: Schema.optionalKey(ApiSchema320),
  verify: Schema.optionalKey(ApiSchema320),
});
const ApiSchema8128 = Schema.Union([Schema.Undefined, ApiSchema8127]);
const ApiSchema8138 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('external'),
  Schema.Literal('agent_generated'),
  Schema.Literal('canonical_repo'),
  Schema.Literal('reviewed_shared'),
  Schema.Literal('user_approved'),
]);
const ApiSchema8141 = Schema.Union([
  Schema.Literal('descriptive'),
  Schema.Literal('normative'),
  Schema.Literal('historical'),
]);
const ApiSchema8146 = Schema.Union([
  Schema.Literal('none'),
  Schema.Literal('pending-review'),
  Schema.Literal('review-unavailable'),
]);
const ApiSchema8139 = Schema.Struct({
  coverage: Schema.Literal('declared-only'),
  excerptOrdinal: Schema.Finite,
  excerptRole: ApiSchema8141,
  historicalParagraphs: Schema.Finite,
  normativeParagraphs: Schema.Finite,
  unresolvedParagraphs: Schema.Finite,
  attention: ApiSchema8146,
  reviewId: Schema.optionalKey(ApiSchema320),
});
const ApiSchema8140 = Schema.Union([Schema.Undefined, ApiSchema8139]);
const ApiSchema8153 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('approved'),
  Schema.Literal('inferred'),
  Schema.Literal('untrusted'),
]);
const ApiSchema8042 = Schema.Struct({
  continuationCard: Schema.optionalKey(ApiSchema8070),
  citationErrorCount: Schema.optionalKey(ApiSchema109),
  citationDetailsOmitted: Schema.optionalKey(ApiSchema8071),
  citationReceipts: Schema.optionalKey(ApiSchema8074),
  citationSummary: Schema.optionalKey(ApiSchema8104),
  freshness: ApiSchema8112,
  freshnessBasis: ApiSchema8117,
  preciseStatus: Schema.optionalKey(ApiSchema8118),
  codeRelations: Schema.optionalKey(ApiSchema8121),
  selectionBasis: Schema.optionalKey(ApiSchema8125),
  kind: ApiSchema8126,
  project: Schema.optionalKey(ApiSchema320),
  topic: Schema.optionalKey(ApiSchema320),
  uri: Schema.String,
  memoryId: Schema.optionalKey(ApiSchema320),
  actionCard: Schema.optionalKey(ApiSchema8128),
  authority: Schema.optionalKey(ApiSchema8138),
  topicMaintenance: Schema.optionalKey(ApiSchema8140),
  excerpt: Schema.String,
  rank: Schema.Finite,
  sourceCommit: Schema.optionalKey(ApiSchema320),
  trust: Schema.optionalKey(ApiSchema8153),
});
const ApiSchema8044 = Schema.Array(ApiSchema8042);
const ApiSchema8160 = Schema.Union([
  Schema.Literal('partial'),
  Schema.Literal('sufficient'),
  Schema.Literal('degraded'),
  Schema.Literal('no-match'),
]);
const ApiSchema8167 = Schema.Struct({
  budgetTokens: Schema.Literal(800),
  callerCwd: Schema.String,
  edgeLimit: Schema.Literal(12),
  nodeId: Schema.String,
  nodeLimit: Schema.Literal(8),
  operation: Schema.Literal('node'),
});
const ApiSchema8161 = Schema.Struct({
  arguments: ApiSchema8167,
  id: Schema.String,
  operation: Schema.Literal('inspect-node'),
  rank: Schema.Finite,
  ref: Schema.String,
  tool: Schema.Literal('inspect_code_graph'),
});
const ApiSchema8178 = Schema.Struct({uri: Schema.String});
const ApiSchema8162 = Schema.Struct({
  arguments: ApiSchema8178,
  id: Schema.String,
  operation: Schema.Literal('read-memory'),
  rank: Schema.Finite,
  tool: Schema.Literal('read_context'),
  uri: Schema.String,
});
const ApiSchema8183 = Schema.Struct({
  budgetTokens: Schema.Literal(800),
  cursor: Schema.String,
  edgeLimit: Schema.Literal(12),
  nodeLimit: Schema.Literal(8),
  operation: Schema.Literal('query'),
  workset: Schema.String,
});
const ApiSchema8163 = Schema.Struct({
  arguments: ApiSchema8183,
  cursor: Schema.String,
  id: Schema.String,
  operation: Schema.Literal('continue-workset'),
  rank: Schema.Finite,
  tool: Schema.Literal('inspect_code_graph'),
  workset: Schema.String,
});
const ApiSchema8187 = Schema.Struct({
  budgetTokens: Schema.Literal(800),
  callerCwd: Schema.String,
  edgeLimit: Schema.Literal(12),
  nodeLimit: Schema.Literal(8),
  operation: Schema.Literal('query'),
  query: Schema.String,
});
const ApiSchema8188 = Schema.Struct({
  budgetTokens: Schema.Literal(800),
  edgeLimit: Schema.Literal(12),
  nodeLimit: Schema.Literal(8),
  operation: Schema.Literal('query'),
  query: Schema.String,
  workset: Schema.String,
});
const ApiSchema8189 = Schema.Union([ApiSchema8187, ApiSchema8188]);
const ApiSchema5040 = Schema.Union([Schema.Literal('workset'), Schema.Literal('repository')]);
const ApiSchema8164 = Schema.Struct({
  arguments: ApiSchema8189,
  id: Schema.String,
  operation: Schema.Literal('graph-status'),
  rank: Schema.Finite,
  scope: ApiSchema5040,
  tool: Schema.Literal('inspect_code_graph'),
  workset: Schema.optionalKey(ApiSchema320),
});
const ApiSchema8165 = Schema.Union([ApiSchema8161, ApiSchema8162, ApiSchema8163, ApiSchema8164]);
const ApiSchema8166 = Schema.Array(ApiSchema8165);
const ApiSchema8193 = Schema.Struct({
  kind: Schema.String,
  language: Schema.String,
  line: Schema.Finite,
  name: Schema.String,
  packageName: Schema.optionalKey(ApiSchema320),
  path: Schema.String,
  qualifiedName: Schema.String,
});
const ApiSchema8191 = Schema.Struct({
  id: Schema.String,
  rank: Schema.Finite,
  reason: Schema.String,
  ref: Schema.String,
  repositoryKey: Schema.String,
  symbol: ApiSchema8193,
});
const ApiSchema8192 = Schema.Array(ApiSchema8191);
const ApiSchema8194 = Schema.Struct({
  cursor: Schema.String,
  remainingEstimate: Schema.Finite,
  state: Schema.Literal('available'),
});
const ApiSchema8195 = Schema.Struct({
  omittedCards: Schema.Finite,
  state: Schema.Literal('rerun-required'),
  upstreamRemainingEstimate: Schema.optionalKey(ApiSchema109),
});
const ApiSchema8197 = Schema.Union([Schema.Undefined, ApiSchema8194, ApiSchema8195]);
const ApiSchema8208 = Schema.Union([Schema.Literal('authoritative'), Schema.Literal('supporting')]);
const ApiSchema8209 = Schema.Struct({
  line: Schema.Finite,
  path: Schema.String,
  pathTruncated: Schema.optionalKey(ApiSchema8071),
  repositoryKey: Schema.String,
  repositoryKeyTruncated: Schema.optionalKey(ApiSchema8071),
});
const ApiSchema8210 = Schema.Union([
  Schema.Literal('declared'),
  Schema.Literal('heuristic'),
  Schema.Literal('model'),
  Schema.Literal('resolved'),
  Schema.Literal('syntactic'),
]);
const ApiSchema8211 = Schema.Union([
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
const ApiSchema8202 = Schema.Struct({
  authority: ApiSchema8208,
  evidence: ApiSchema8209,
  id: Schema.String,
  provenance: ApiSchema8210,
  rank: Schema.Finite,
  relation: ApiSchema8211,
  sourceRef: Schema.String,
  targetRef: Schema.String,
});
const ApiSchema8203 = Schema.Array(ApiSchema8202);
const ApiSchema8219 = Schema.Union([Schema.Literal('current-dirty-overlay'), Schema.Literal('graph-snapshot')]);
const ApiSchema8222 = Schema.Union([Schema.Literal('current-dirty-overlay'), Schema.Literal('current-clean')]);
const ApiSchema8212 = Schema.Struct({
  content: Schema.String,
  coveredGraphRefs: ApiSchema279,
  endLine: Schema.Finite,
  evidenceKind: ApiSchema8219,
  freshness: Schema.Literal('fresh'),
  id: Schema.String,
  path: Schema.String,
  repositoryKey: Schema.String,
  snapshotIdentity: ApiSchema8222,
  startLine: Schema.Finite,
  truncated: Schema.Boolean,
});
const ApiSchema8213 = Schema.Array(ApiSchema8212);
const ApiSchema8214 = Schema.Union([Schema.Undefined, ApiSchema8213]);
const ApiSchema8190 = Schema.Struct({
  cards: ApiSchema8192,
  continuation: Schema.optionalKey(ApiSchema8197),
  contracts: ApiSchema8203,
  sources: Schema.optionalKey(ApiSchema8214),
});
const ApiSchema8237 = Schema.Union([
  Schema.Literal('candidate-conflict'),
  Schema.Literal('invalid-code-citation'),
  Schema.Literal('stale-link'),
  Schema.Literal('stale-memory'),
  Schema.Literal('unknown-memory-freshness'),
  Schema.Literal('topic-support'),
]);
const ApiSchema8223 = Schema.Struct({
  id: Schema.String,
  kind: ApiSchema8237,
  rank: Schema.Finite,
  summary: Schema.String,
  uris: ApiSchema279,
});
const ApiSchema8224 = Schema.Array(ApiSchema8223);
const ApiSchema5011 = Schema.Union([
  Schema.Literal('resume'),
  Schema.Literal('brief'),
  Schema.Literal('locate'),
  Schema.Literal('explain'),
  Schema.Literal('trace'),
  Schema.Literal('impact'),
]);
const ApiSchema8239 = Schema.Union([Schema.Literal(2), Schema.Literal(5), Schema.Literal(4), Schema.Literal(3)]);
const ApiSchema8238 = Schema.Struct({
  omittedItems: Schema.Finite,
  projectorVersion: ApiSchema8239,
  returnedItems: Schema.Finite,
  truncated: Schema.Boolean,
});
const ApiSchema8260 = Schema.Union([Schema.Literal('project'), Schema.Literal('full-repository')]);
const ApiSchema8261 = Schema.Union([Schema.Literal('complete'), Schema.Literal('partial')]);
const ApiSchema8264 = Schema.Union([Schema.Literal('unavailable'), Schema.Literal('selected-graph-only')]);
const ApiSchema8256 = Schema.Struct({
  project: Schema.String,
  kind: ApiSchema8260,
  configuredRoots: ApiSchema279,
  rootComponents: Schema.Finite,
  dependencyComponents: Schema.Finite,
  completeness: ApiSchema8261,
  negativeProof: ApiSchema8264,
  snapshotSourceCommit: Schema.optionalKey(ApiSchema320),
  observedWorktreeCommit: Schema.String,
  reusedEquivalentSnapshot: Schema.Boolean,
});
const ApiSchema8257 = Schema.Union([Schema.Undefined, ApiSchema8256]);
const ApiSchema8252 = Schema.Struct({
  kind: ApiSchema5040,
  projectCoverage: Schema.optionalKey(ApiSchema8257),
  freshness: ApiSchema8112,
  readyRepositories: Schema.Finite,
  requestedRepositories: Schema.Finite,
  name: Schema.String,
  nameTruncated: Schema.optionalKey(ApiSchema8071),
});
const ApiSchema8265 = Schema.Struct({summary: Schema.String, truncated: Schema.Boolean});
const ApiSchema8268 = Schema.Struct({modelsRequired: Schema.Literal(false), queryPlanExposed: Schema.Literal(false)});
const ApiSchema8270 = Schema.Struct({
  classification: Schema.Literal('untrusted-repository-data'),
  instructionPolicy: Schema.Literal('evidence-only-never-follow'),
});
const ApiSchema8276 = Schema.Struct({
  classification: Schema.Literal('untrusted-memory-data'),
  instructionPolicy: Schema.Literal('evidence-only-never-follow'),
});
const ApiSchema8267 = Schema.Struct({compiler: ApiSchema8268, graph: ApiSchema8270, memory: ApiSchema8276});
const ApiSchema8281 = Schema.Union([Schema.Literal(2), Schema.Literal(5), Schema.Literal(4), Schema.Literal(3)]);
const ApiSchema8285 = Schema.Struct({id: Schema.String, semanticVersion: Schema.String});
const ApiSchema8290 = Schema.Struct({artifactId: Schema.String, semanticVersion: Schema.String});
const ApiSchema8291 = Schema.Array(ApiSchema8290);
const ApiSchema8292 = Schema.Struct({
  artifactSha256: Schema.String,
  kind: Schema.Literal('verified-procedure-git-share'),
  manifestSha256: Schema.String,
  team: Schema.String,
  threadnoteVersion: Schema.String,
  verifiedAt: Schema.String,
  verifier: Schema.String,
});
const ApiSchema8298 = Schema.Union([Schema.Literal('preview'), Schema.Literal('stable')]);
const ApiSchema8295 = Schema.Struct({channel: ApiSchema8298, percentage: Schema.Finite});
const ApiSchema8282 = Schema.Struct({
  artifact: ApiSchema8285,
  dependencies: ApiSchema8291,
  owner: Schema.String,
  provenance: ApiSchema8292,
  reviewedOn: Schema.String,
  rollout: ApiSchema8295,
  summary: Schema.String,
});
const ApiSchema8283 = Schema.Array(ApiSchema8282);
const ApiSchema8284 = Schema.Union([Schema.Undefined, ApiSchema8283]);
const ApiSchema8027 = Schema.Struct({
  coverage: ApiSchema8031,
  durableDecisions: ApiSchema8044,
  evidenceState: ApiSchema8160,
  recommendedFollowUps: ApiSchema8166,
  graph: ApiSchema8190,
  activeHandoffs: ApiSchema8044,
  stalenessAndConflicts: ApiSchema8224,
  mode: ApiSchema5011,
  output: ApiSchema8238,
  scope: ApiSchema8252,
  task: ApiSchema8265,
  trust: ApiSchema8267,
  type: Schema.Literal('context-brief'),
  version: ApiSchema8281,
  verifiedProcedures: Schema.optionalKey(ApiSchema8284),
});
const ApiSchema4970 = Schema.Struct({
  maximumBytes: Schema.Finite,
  measurement: ApiSchema8026,
  structuredContent: ApiSchema8027,
  text: Schema.String,
});
const ApiSchema5018 = Schema.Struct({output: Schema.String});
const ApiSchema8299 = Schema.Struct({level: Schema.String, reason: Schema.String, score: Schema.Finite});
const ApiSchema8300 = Schema.Union([Schema.Undefined, ApiSchema8299]);
const ApiSchema5118 = Schema.Struct({
  callerCwd: Schema.optionalKey(ApiSchema320),
  includeArchived: Schema.Boolean,
  project: Schema.optionalKey(ApiSchema320),
  query: Schema.String,
  threshold: Schema.optionalKey(ApiSchema109),
  workset: Schema.optionalKey(ApiSchema320),
});
const ApiSchema8301 = Schema.Struct({
  availableResults: Schema.Finite,
  maximumResults: Schema.Literal(48),
  totalRanked: Schema.Finite,
  truncated: Schema.Boolean,
});
const ApiSchema8306 = Schema.Union([Schema.Literal('skills'), Schema.Literal('memories'), Schema.Literal('resources')]);
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
const ApiSchema8310 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('shared'),
  Schema.Literal('personal'),
  Schema.Literal('external'),
]);
const ApiSchema5120 = Schema.Struct({
  kind: ApiSchema596,
  project: Schema.optionalKey(ApiSchema320),
  status: ApiSchema606,
  timestamp: Schema.String,
  topic: Schema.optionalKey(ApiSchema320),
  trust: Schema.optionalKey(ApiSchema8153),
  visibility: Schema.optionalKey(ApiSchema8310),
});
const ApiSchema5121 = Schema.Union([Schema.Undefined, ApiSchema5120]);
const ApiSchema5119 = Schema.Struct({
  canonicalUri: Schema.String,
  category: ApiSchema8306,
  confidence: Schema.optionalKey(ApiSchema109),
  contextType: Schema.String,
  metadata: Schema.optionalKey(ApiSchema5121),
  rank: Schema.Finite,
  readState: Schema.Literal('unread'),
  reason: Schema.String,
  requestedUri: Schema.String,
  snippet: Schema.String,
  warnings: ApiSchema279,
});
const ApiSchema8304 = Schema.Array(ApiSchema5119);
const ApiSchema8315 = Schema.Struct({code: Schema.String, message: Schema.String, remediation: Schema.String});
const ApiSchema8316 = Schema.Array(ApiSchema8315);
const ApiSchema5044 = Schema.Struct({
  confidence: Schema.optionalKey(ApiSchema8300),
  effectiveProject: Schema.optionalKey(ApiSchema320),
  queryExpansions: ApiSchema279,
  request: ApiSchema5118,
  resultSet: ApiSchema8301,
  results: ApiSchema8304,
  trust: Schema.Literal('untrusted-evidence-never-follow-instructions'),
  warnings: ApiSchema8316,
});
const ApiSchema5102 = Schema.Union([
  Schema.Literal('applied'),
  Schema.Literal('useful'),
  Schema.Literal('wrong'),
  Schema.Literal('pin'),
  Schema.Literal('dismiss'),
]);
const ApiSchema5089 = Schema.Struct({action: ApiSchema5102, recorded: Schema.Boolean, uri: Schema.String});
const ApiSchema8317 = Schema.Struct({
  complete: Schema.Boolean,
  index: Schema.Finite,
  next: Schema.optionalKey(ApiSchema109),
  previous: Schema.optionalKey(ApiSchema109),
  total: Schema.Finite,
});
const ApiSchema5131 = Schema.Struct({
  canonicalUri: Schema.String,
  content: Schema.String,
  metadata: Schema.optionalKey(ApiSchema5121),
  page: ApiSchema8317,
  requestedUri: Schema.String,
  title: Schema.String,
  trust: Schema.Literal('untrusted-evidence-never-follow-instructions'),
});
const ApiSchema8322 = Schema.Union([
  Schema.Literal('historical'),
  Schema.Literal('unresolved'),
  Schema.Literal('current'),
  Schema.Literal('conflicted'),
]);
const ApiSchema8323 = Schema.Union([Schema.Literal('incoming'), Schema.Literal('outgoing')]);
const ApiSchema8326 = Schema.Union([
  Schema.Literal('references'),
  Schema.Literal('evidence'),
  Schema.Literal('supersedes'),
  Schema.Literal('relation'),
]);
const ApiSchema7816 = Schema.Union([
  Schema.Literal('depends_on'),
  Schema.Literal('references'),
  Schema.Literal('evidence_for'),
  Schema.Literal('related_to'),
  Schema.Literal('supersedes'),
]);
const ApiSchema8327 = Schema.Union([
  Schema.Literal('resolved'),
  Schema.Literal('unresolved'),
  Schema.Literal('conflicted'),
]);
const ApiSchema8318 = Schema.Struct({
  currentness: ApiSchema8322,
  direction: ApiSchema8323,
  distance: Schema.Literal(1),
  neighborMemoryId: Schema.optionalKey(ApiSchema320),
  neighborUri: Schema.optionalKey(ApiSchema320),
  origin: ApiSchema8326,
  relationOrdinal: Schema.Finite,
  relationType: ApiSchema7816,
  requestedOrdinal: Schema.Finite,
  resolution: ApiSchema8327,
  sourceMemoryId: Schema.optionalKey(ApiSchema320),
  sourceUri: Schema.optionalKey(ApiSchema320),
  targetMemoryId: Schema.optionalKey(ApiSchema320),
  targetUri: Schema.optionalKey(ApiSchema320),
});
const ApiSchema8319 = Schema.Array(ApiSchema8318);
const ApiSchema8328 = Schema.Struct({
  connectionCount: Schema.Finite,
  premiseCount: Schema.Finite,
  resultCount: Schema.Finite,
  truncated: Schema.Boolean,
  truncatedSeedOrdinals: Schema.optionalKey(ApiSchema8040),
  version: Schema.Literal(1),
});
const ApiSchema5171 = Schema.Struct({type: ApiSchema7816, uri: Schema.String});
const ApiSchema5172 = Schema.Array(ApiSchema5171);
const ApiSchema5169 = Schema.Struct({expectedContent: Schema.String, relations: ApiSchema5172, uri: Schema.String});
const ApiSchema5170 = Schema.Union([Schema.Undefined, ApiSchema5169]);
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
const ApiSchema7807 = Schema.Array(ApiSchema7714);
const ApiSchema8329 = Schema.Struct({
  codeCitations: ApiSchema7807,
  memoryId: Schema.String,
  metadata: ApiSchema5120,
  uri: Schema.String,
});
const ApiSchema8330 = Schema.Array(ApiSchema8329);
const ApiSchema8331 = Schema.Struct({
  memoryId: Schema.optionalKey(ApiSchema320),
  requestedOrdinal: Schema.Finite,
  requestedRef: Schema.String,
  state: ApiSchema8322,
  uri: Schema.optionalKey(ApiSchema320),
});
const ApiSchema8332 = Schema.Array(ApiSchema8331);
const ApiSchema5147 = Schema.Struct({
  connections: ApiSchema8319,
  coverage: ApiSchema8328,
  editor: Schema.optionalKey(ApiSchema5170),
  nodes: ApiSchema8330,
  premises: ApiSchema8332,
  requestedUri: Schema.String,
  trust: Schema.Literal('relations-are-navigation-evidence-not-entailment'),
});
const ApiSchema5154 = Schema.Struct({
  content: Schema.String,
  memoryId: Schema.String,
  relations: ApiSchema5172,
  uri: Schema.String,
});

export const isManagerWorksetCatalog = Schema.is(ApiSchema4965);
export const isProjectedContextBriefV1 = Schema.is(ApiSchema4970);
export const isOutputResponse = Schema.is(ApiSchema5018);
export const isManagerRecallResponse = Schema.is(ApiSchema5044);
export const isManagerRecallFeedbackResponse = Schema.is(ApiSchema5089);
export const isManagerContextReadResponse = Schema.is(ApiSchema5131);
export const isManagerContextConnectionsResponse = Schema.is(ApiSchema5147);
export const isManagerMemoryRelationsResponse = Schema.is(ApiSchema5154);
