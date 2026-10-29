import {Schema} from 'effect';

const ApiSchema8540 = Schema.Struct({bytes: Schema.Finite, files: Schema.Finite});
const ApiSchema8541 = Schema.Struct({bytes: Schema.Finite, files: Schema.Finite});
const ApiSchema8539 = Schema.Struct({excluded: ApiSchema8540, included: ApiSchema8541});
const ApiSchema279 = Schema.Array(Schema.String);
const ApiSchema555 = Schema.Union([Schema.Undefined, ApiSchema279]);
const ApiSchema8531 = Schema.Struct({
  closure: Schema.Literal('dependencies'),
  include: Schema.optionalKey(ApiSchema555),
  roots: ApiSchema279,
});
const ApiSchema8532 = Schema.Union([Schema.Undefined, ApiSchema8531]);
const ApiSchema8542 = Schema.Struct({graph: ApiSchema8532, name: Schema.String});
const ApiSchema8543 = Schema.Struct({commit: Schema.String, dirty: Schema.Boolean, displayName: Schema.String});
const ApiSchema8261 = Schema.Union([Schema.Literal('complete'), Schema.Literal('partial')]);
const ApiSchema8544 = Schema.Struct({
  completeness: ApiSchema8261,
  controlPaths: ApiSchema279,
  dependencyComponents: ApiSchema279,
  diagnostics: ApiSchema279,
  includes: ApiSchema279,
  rootComponents: ApiSchema279,
  roots: ApiSchema279,
});
const ApiSchema5623 = Schema.Struct({
  inventory: ApiSchema8539,
  project: ApiSchema8542,
  repository: ApiSchema8543,
  scope: ApiSchema8544,
  snapshotReuse: Schema.Literal('not-evaluated'),
  type: Schema.Literal('code-graph-project-scope-preview'),
  version: Schema.Literal(1),
});
const ApiSchema5747 = Schema.Union([
  Schema.Literal('running'),
  Schema.Literal('cancelled'),
  Schema.Literal('cancelling'),
  Schema.Literal('completed'),
  Schema.Literal('failed'),
]);
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
const ApiSchema5663 = Schema.Struct({
  id: Schema.String,
  status: ApiSchema5747,
  workset: Schema.String,
  createdAt: Schema.String,
  error: Schema.optionalKey(ApiSchema320),
  errorCode: Schema.optionalKey(ApiSchema320),
  finishedAt: Schema.optionalKey(ApiSchema320),
  progress: ApiSchema8335,
  warning: Schema.optionalKey(ApiSchema320),
});
const ApiSchema5665 = Schema.Array(ApiSchema5663);
const ApiSchema5666 = Schema.Struct({jobs: ApiSchema5665});
const ApiSchema8023 = Schema.Union([
  Schema.Literal('missing'),
  Schema.Literal('current'),
  Schema.Literal('detached'),
  Schema.Literal('not-observed'),
]);
const ApiSchema8552 = Schema.Struct({
  branch: Schema.optionalKey(ApiSchema320),
  branchState: ApiSchema8023,
  configured: Schema.Boolean,
  folder: Schema.optionalKey(ApiSchema320),
  path: Schema.optionalKey(ApiSchema320),
  project: Schema.String,
  uri: Schema.optionalKey(ApiSchema320),
});
const ApiSchema8553 = Schema.Array(ApiSchema8552);
const ApiSchema5682 = Schema.Struct({
  configuredMembers: Schema.Finite,
  description: Schema.optionalKey(ApiSchema320),
  members: ApiSchema8553,
  name: Schema.String,
  unresolvedMembers: Schema.Finite,
});
const ApiSchema8571 = Schema.Union([
  Schema.Literal('lease-validation-failed'),
  Schema.Literal('moniker-read-failed'),
  Schema.Literal('moniker-read-incomplete'),
  Schema.Literal('resolver-failed'),
  Schema.Literal('resolver-rejections'),
  Schema.Literal('snapshot-drift'),
]);
const ApiSchema8572 = Schema.Array(ApiSchema8571);
const ApiSchema8574 = Schema.Union([Schema.Literal('failed'), Schema.Literal('complete'), Schema.Literal('partial')]);
const ApiSchema8556 = Schema.Struct({
  diagnostics: ApiSchema8572,
  failedRepositoryCount: Schema.Finite,
  rejectionCount: Schema.Finite,
  repositoriesRead: Schema.Finite,
  repositoryCount: Schema.Finite,
  state: ApiSchema8574,
});
const ApiSchema8554 = Schema.Struct({
  bridgeCount: Schema.Finite,
  coverage: ApiSchema8556,
  digest: Schema.String,
  generationId: Schema.String,
  resolverVersion: Schema.Literal(1),
  worksetName: Schema.String,
});
const ApiSchema8555 = Schema.Union([Schema.Undefined, ApiSchema8554]);
const ApiSchema8576 = Schema.Struct({digest: Schema.String, id: Schema.String});
const ApiSchema8577 = Schema.Union([Schema.Undefined, ApiSchema8576]);
const ApiSchema8578 = Schema.Union([Schema.Literal('ready'), Schema.Literal('stale'), Schema.Literal('missing')]);
const ApiSchema8575 = Schema.Struct({
  generation: Schema.optionalKey(ApiSchema8577),
  manifestDigest: Schema.optionalKey(ApiSchema320),
  state: ApiSchema8578,
});
const ApiSchema8585 = Schema.Struct({
  deferred: Schema.Finite,
  failed: Schema.Finite,
  stale: Schema.Finite,
  missing: Schema.Finite,
  excluded: Schema.Finite,
  current: Schema.Finite,
  uncatalogued: Schema.Finite,
});
const ApiSchema8579 = Schema.Struct({current: Schema.Finite, requested: Schema.Finite, states: ApiSchema8585});
const ApiSchema8260 = Schema.Union([Schema.Literal('project'), Schema.Literal('full-repository')]);
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
const ApiSchema8593 = Schema.Union([
  Schema.Literal('repository'),
  Schema.Literal('unknown'),
  Schema.Literal('busy'),
  Schema.Literal('confirmed-corruption'),
  Schema.Literal('incompatible-schema'),
  Schema.Literal('no-space'),
  Schema.Literal('permission'),
  Schema.Literal('schema-additive'),
  Schema.Literal('transient-io'),
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
const ApiSchema8591 = Schema.Struct({
  code: ApiSchema8593,
  recovery: Schema.optionalKey(ApiSchema8463),
  retryable: Schema.Boolean,
});
const ApiSchema8592 = Schema.Union([Schema.Undefined, ApiSchema8591]);
const ApiSchema8621 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('unknown-project'),
  Schema.Literal('missing-path'),
  Schema.Literal('snapshot-drift'),
  Schema.Literal('catalog-generation-drift'),
  Schema.Literal('checkout-drift'),
  Schema.Literal('identity-drift'),
  Schema.Literal('invalid-repository'),
  Schema.Literal('no-ready-snapshot'),
  Schema.Literal('not-in-published-generation'),
  Schema.Literal('scope-drift'),
  Schema.Literal('status-corrupt'),
  Schema.Literal('status-failed'),
  Schema.Literal('status-incompatible'),
  Schema.Literal('status-unavailable'),
  Schema.Literal('worktree-drift'),
  Schema.Literal('worktree-stale'),
]);
const ApiSchema8582 = Schema.Union([
  Schema.Literal('deferred'),
  Schema.Literal('failed'),
  Schema.Literal('stale'),
  Schema.Literal('missing'),
  Schema.Literal('excluded'),
  Schema.Literal('current'),
  Schema.Literal('uncatalogued'),
]);
const ApiSchema8587 = Schema.Struct({
  projectCoverage: Schema.optionalKey(ApiSchema8257),
  detail: Schema.optionalKey(ApiSchema8592),
  project: Schema.String,
  reason: Schema.optionalKey(ApiSchema8621),
  repositoryId: Schema.optionalKey(ApiSchema320),
  snapshotId: Schema.optionalKey(ApiSchema320),
  state: ApiSchema8582,
});
const ApiSchema8588 = Schema.Array(ApiSchema8587);
const ApiSchema5699 = Schema.Struct({
  bridges: Schema.optionalKey(ApiSchema8555),
  catalog: ApiSchema8575,
  coverage: ApiSchema8579,
  manifestDigest: Schema.String,
  members: ApiSchema8588,
  type: Schema.Literal('code-graph-workset-status'),
  version: Schema.Literal(1),
  warnings: ApiSchema279,
  workset: Schema.String,
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
const ApiSchema5788 = Schema.Struct({
  catalog: ApiSchema4965,
  changed: Schema.Boolean,
  operation: ApiSchema8538,
  warnings: ApiSchema279,
});
const ApiSchema8026 = Schema.Struct({
  estimatedTokens: Schema.Finite,
  structuredBytes: Schema.Finite,
  textBytes: Schema.Finite,
  totalBytes: Schema.Finite,
});
const ApiSchema5941 = Schema.Struct({cursor: Schema.String, remainingEstimate: Schema.Finite});
const ApiSchema5942 = Schema.Union([Schema.Undefined, ApiSchema5941]);
const ApiSchema8628 = Schema.Struct({
  omittedCards: Schema.Finite,
  projectorVersion: Schema.Literal(1),
  returnedCards: Schema.Finite,
  totalCards: Schema.Finite,
  truncated: Schema.Boolean,
});
const ApiSchema8631 = Schema.Struct({score: Schema.Finite, signals: ApiSchema279, summary: Schema.String});
const ApiSchema8208 = Schema.Union([Schema.Literal('authoritative'), Schema.Literal('supporting')]);
const ApiSchema8635 = Schema.Struct({
  column: Schema.Finite,
  endColumn: Schema.Finite,
  endLine: Schema.Finite,
  line: Schema.Finite,
});
const ApiSchema8634 = Schema.Struct({path: Schema.String, repositoryKey: Schema.String, span: ApiSchema8635});
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
const ApiSchema8636 = Schema.Struct({ref: Schema.String, repositoryKey: Schema.String});
const ApiSchema8632 = Schema.Struct({
  authority: ApiSchema8208,
  confidence: Schema.Finite,
  evidence: ApiSchema8634,
  provenance: ApiSchema8210,
  relation: ApiSchema8211,
  source: ApiSchema8636,
  target: ApiSchema8636,
});
const ApiSchema8633 = Schema.Array(ApiSchema8632);
const ApiSchema8637 = Schema.Struct({
  kind: Schema.String,
  language: Schema.String,
  name: Schema.String,
  packageName: Schema.optionalKey(ApiSchema320),
  path: Schema.String,
  qualifiedName: Schema.String,
  span: ApiSchema8635,
});
const ApiSchema8629 = Schema.Struct({
  id: Schema.String,
  reason: ApiSchema8631,
  ref: Schema.String,
  relationships: ApiSchema8633,
  repositoryKey: Schema.String,
  symbol: ApiSchema8637,
});
const ApiSchema8630 = Schema.Array(ApiSchema8629);
const ApiSchema8646 = Schema.Struct({
  deferred: Schema.Finite,
  failed: Schema.Finite,
  stale: Schema.Finite,
  missing: Schema.Finite,
  excluded: Schema.Finite,
  current: Schema.Finite,
});
const ApiSchema8660 = Schema.Union([
  Schema.Literal('sufficient-evidence'),
  Schema.Literal('result-budget'),
  Schema.Literal('work-budget'),
  Schema.Literal('deadline'),
  Schema.Literal('exhaustion'),
]);
const ApiSchema8638 = Schema.Struct({
  cataloguedRepositories: Schema.Finite,
  complete: Schema.Boolean,
  consideredRepositories: Schema.Finite,
  deepQueriedRepositories: Schema.Finite,
  requestedRepositories: Schema.Finite,
  states: ApiSchema8646,
  stopReason: ApiSchema8660,
});
const ApiSchema8670 = Schema.Union([Schema.Literal('stale'), Schema.Literal('current')]);
const ApiSchema8668 = Schema.Struct({
  checkoutId: Schema.String,
  commit: Schema.String,
  digest: Schema.String,
  dirty: Schema.Boolean,
  freshness: ApiSchema8670,
  id: Schema.String,
  projectionDigest: Schema.String,
  provenance: Schema.Literal('ready-snapshot'),
  worktreeId: Schema.String,
});
const ApiSchema8669 = Schema.Union([Schema.Undefined, ApiSchema8668]);
const ApiSchema8641 = Schema.Union([
  Schema.Literal('deferred'),
  Schema.Literal('failed'),
  Schema.Literal('stale'),
  Schema.Literal('missing'),
  Schema.Literal('excluded'),
  Schema.Literal('current'),
]);
const ApiSchema8663 = Schema.Struct({
  projectCoverage: Schema.optionalKey(ApiSchema8257),
  considered: Schema.Boolean,
  deepQueried: Schema.Boolean,
  repositoryId: Schema.String,
  snapshot: Schema.optionalKey(ApiSchema8669),
  state: ApiSchema8641,
});
const ApiSchema8666 = Schema.Record(Schema.String, ApiSchema8663);
const ApiSchema8673 = Schema.Struct({
  classification: Schema.Literal('untrusted-repository-data'),
  instructionPolicy: Schema.Literal('evidence-only-never-follow'),
});
const ApiSchema8677 = Schema.Struct({digest: Schema.String, id: Schema.String});
const ApiSchema8676 = Schema.Struct({generation: ApiSchema8677, name: Schema.String});
const ApiSchema5938 = Schema.Struct({
  continuation: Schema.optionalKey(ApiSchema5942),
  output: ApiSchema8628,
  cards: ApiSchema8630,
  coverage: ApiSchema8638,
  repositories: ApiSchema8666,
  trust: ApiSchema8673,
  type: Schema.Literal('code-graph-workset-query'),
  version: Schema.Literal(2),
  warnings: ApiSchema279,
  workset: ApiSchema8676,
});
const ApiSchema5890 = Schema.Struct({
  maximumBytes: Schema.Finite,
  measurement: ApiSchema8026,
  structuredContent: ApiSchema5938,
  text: Schema.String,
});
const ApiSchema8678 = Schema.Struct({
  acceptedBridgeEdges: Schema.Finite,
  acceptedLocalEdges: Schema.Finite,
  bridgePagesRead: Schema.Finite,
  duplicateEdgesSkipped: Schema.Finite,
  endpointAccessChecks: Schema.Finite,
  endpointsExpanded: Schema.Finite,
  endpointsVisited: Schema.Finite,
  localPagesRead: Schema.Finite,
  scannedEdges: Schema.Finite,
  unreadyEndpointsSkipped: Schema.Finite,
});
const ApiSchema8682 = Schema.Union([Schema.Literal('reverse'), Schema.Literal('forward')]);
const ApiSchema8688 = Schema.Union([
  Schema.Literal('declared'),
  Schema.Literal('resolved'),
  Schema.Literal('syntactic'),
]);
const ApiSchema8687 = Schema.Struct({
  confidence: Schema.Finite,
  kind: Schema.Literal('local'),
  relationProvenance: ApiSchema8688,
});
const ApiSchema8691 = Schema.Struct({componentId: Schema.String, kind: Schema.Literal('component')});
const ApiSchema8692 = Schema.Struct({kind: Schema.Literal('qualified-ref'), ref: Schema.String});
const ApiSchema8693 = Schema.Union([ApiSchema8691, ApiSchema8692]);
const ApiSchema8689 = Schema.Struct({
  repositoryKey: Schema.String,
  reference: ApiSchema8693,
  repositoryId: Schema.String,
  snapshotId: Schema.String,
});
const ApiSchema8683 = Schema.Struct({
  id: Schema.String,
  provenance: ApiSchema8687,
  relation: Schema.String,
  source: ApiSchema8689,
  target: ApiSchema8689,
});
const ApiSchema8707 = Schema.Union([
  Schema.Literal('declared-npm-package-compatible'),
  Schema.Literal('exact-protobuf-identity'),
]);
const ApiSchema8714 = Schema.Struct({path: Schema.String, span: ApiSchema8635});
const ApiSchema8696 = Schema.Struct({
  bridgeId: Schema.String,
  confidence: Schema.Literal(1),
  generationId: Schema.String,
  kind: Schema.Literal('bridge'),
  reason: ApiSchema8707,
  resolverVersion: Schema.Finite,
  sourceEvidence: ApiSchema8714,
  targetEvidence: ApiSchema8714,
});
const ApiSchema8720 = Schema.Union([Schema.Literal('depends_on'), Schema.Literal('imports')]);
const ApiSchema8684 = Schema.Struct({
  id: Schema.String,
  provenance: ApiSchema8696,
  relation: ApiSchema8720,
  source: ApiSchema8689,
  target: ApiSchema8689,
});
const ApiSchema8685 = Schema.Union([ApiSchema8683, ApiSchema8684]);
const ApiSchema8686 = Schema.Array(ApiSchema8685);
const ApiSchema8729 = Schema.Union([
  Schema.Literal('depth'),
  Schema.Literal('cancelled'),
  Schema.Literal('deadline'),
  Schema.Literal('exhaustion'),
  Schema.Literal('edge-limit'),
  Schema.Literal('target-found'),
  Schema.Literal('unready-start'),
]);
const ApiSchema8721 = Schema.Struct({complete: Schema.Boolean, reason: ApiSchema8729});
const ApiSchema8730 = Schema.Array(ApiSchema8689);
const ApiSchema5950 = Schema.Struct({
  coverage: ApiSchema8678,
  direction: ApiSchema8682,
  edges: ApiSchema8686,
  generationId: Schema.String,
  reachedTarget: Schema.Boolean,
  stop: ApiSchema8721,
  visited: ApiSchema8730,
});
const ApiSchema8417 = Schema.Union([Schema.Literal('ready'), Schema.Literal('unavailable')]);
const ApiSchema8734 = Schema.Struct({
  componentEligible: Schema.Finite,
  componentOmitted: Schema.Finite,
  componentRepresented: Schema.Finite,
  input: Schema.Finite,
  repositoryOmitted: Schema.Finite,
  repositoryRepresented: Schema.Finite,
});
const ApiSchema8735 = Schema.Struct({
  maxEdges: Schema.Finite,
  maxEvidence: Schema.Finite,
  maxEvidencePerEdge: Schema.Finite,
  maxNodes: Schema.Finite,
});
const ApiSchema8736 = Schema.Struct({
  candidate: Schema.Finite,
  componentCandidate: Schema.Finite,
  omittedByEdgeLimit: Schema.Finite,
  omittedByNodeLimit: Schema.Finite,
  repositoryCandidate: Schema.Finite,
  returned: Schema.Finite,
});
const ApiSchema8737 = Schema.Struct({
  candidateOccurrences: Schema.Finite,
  omittedByTopology: Schema.Finite,
  omittedByEvidenceBudget: Schema.Finite,
  returned: Schema.Finite,
});
const ApiSchema8738 = Schema.Struct({
  candidate: Schema.Finite,
  componentCandidate: Schema.Finite,
  omitted: Schema.Finite,
  repositoryCandidate: Schema.Finite,
  returned: Schema.Finite,
});
const ApiSchema8746 = Schema.Union([
  Schema.Literal('edge-limit'),
  Schema.Literal('evidence-limit'),
  Schema.Literal('evidence-per-edge-limit'),
  Schema.Literal('node-limit'),
]);
const ApiSchema8747 = Schema.Array(ApiSchema8746);
const ApiSchema8739 = Schema.Struct({reasons: ApiSchema8747, truncated: Schema.Boolean});
const ApiSchema8733 = Schema.Struct({
  bridges: ApiSchema8734,
  budgets: ApiSchema8735,
  complete: Schema.Boolean,
  edges: ApiSchema8736,
  evidence: ApiSchema8737,
  evidenceComplete: Schema.Boolean,
  nodes: ApiSchema8738,
  structureComplete: Schema.Boolean,
  truncation: ApiSchema8739,
});
const ApiSchema8767 = Schema.Union([
  Schema.Literal('file'),
  Schema.Literal('package'),
  Schema.Literal('message'),
  Schema.Literal('service'),
  Schema.Literal('rpc'),
]);
const ApiSchema8774 = Schema.Union([Schema.Literal('package:npm'), Schema.Literal('protobuf')]);
const ApiSchema8775 = Schema.Struct({reason: ApiSchema8707, version: Schema.Literal(1)});
const ApiSchema8776 = Schema.Struct({monikerId: Schema.String, path: Schema.String, span: ApiSchema8635});
const ApiSchema8753 = Schema.Struct({
  bridgeId: Schema.String,
  confidence: Schema.Literal(1),
  identity: Schema.String,
  kind: ApiSchema8767,
  provenance: Schema.Literal('declared'),
  relation: ApiSchema8720,
  resolutionDomain: ApiSchema8774,
  resolver: ApiSchema8775,
  source: ApiSchema8776,
  target: ApiSchema8776,
});
const ApiSchema8754 = Schema.Array(ApiSchema8753);
const ApiSchema8752 = Schema.Struct({
  items: ApiSchema8754,
  omittedCount: Schema.Finite,
  returnedCount: Schema.Finite,
  totalCount: Schema.Finite,
  truncated: Schema.Boolean,
});
const ApiSchema8778 = Schema.Union([Schema.Literal('repository'), Schema.Literal('component')]);
const ApiSchema8779 = Schema.Struct({count: Schema.Finite, value: Schema.String});
const ApiSchema8780 = Schema.Array(ApiSchema8779);
const ApiSchema8781 = Schema.Struct({
  declared: Schema.Finite,
  heuristic: Schema.Finite,
  resolved: Schema.Finite,
  syntactic: Schema.Finite,
});
const ApiSchema8748 = Schema.Struct({
  bridgeCount: Schema.Finite,
  edgeClass: Schema.Literal('declared-cross-repository-contract'),
  evidence: ApiSchema8752,
  generationId: Schema.String,
  granularity: ApiSchema8778,
  id: Schema.String,
  kinds: ApiSchema8780,
  provenance: ApiSchema8781,
  relations: ApiSchema8780,
  resolutionDomains: ApiSchema8780,
  resolverReasons: ApiSchema8780,
  sourceNodeId: Schema.String,
  targetNodeId: Schema.String,
});
const ApiSchema8749 = Schema.Array(ApiSchema8748);
const ApiSchema8782 = Schema.Struct({
  kind: Schema.Literal('repository'),
  generationId: Schema.String,
  id: Schema.String,
  incidentBridgeCount: Schema.Finite,
  repositoryId: Schema.String,
  repositoryKey: Schema.String,
  snapshotId: Schema.String,
});
const ApiSchema8784 = Schema.Struct({
  componentId: Schema.String,
  componentKind: Schema.Literal('package'),
  kind: Schema.Literal('component'),
  packageIdentities: ApiSchema279,
  generationId: Schema.String,
  id: Schema.String,
  incidentBridgeCount: Schema.Finite,
  repositoryId: Schema.String,
  repositoryKey: Schema.String,
  snapshotId: Schema.String,
});
const ApiSchema8785 = Schema.Union([ApiSchema8782, ApiSchema8784]);
const ApiSchema8786 = Schema.Array(ApiSchema8785);
const ApiSchema8787 = Schema.Struct({
  bridgeSetDigest: Schema.String,
  complete: Schema.Boolean,
  generationId: Schema.String,
  repositoryCount: Schema.Finite,
  resolverVersion: Schema.Literal(1),
  totalBridges: Schema.Finite,
  version: Schema.Literal(1),
  worksetName: Schema.String,
});
const ApiSchema8731 = Schema.Struct({
  coverage: ApiSchema8733,
  edges: ApiSchema8749,
  nodes: ApiSchema8786,
  receipt: ApiSchema8787,
  version: Schema.Literal(1),
});
const ApiSchema8732 = Schema.Union([Schema.Undefined, ApiSchema8731]);
const ApiSchema5998 = Schema.Struct({
  bridgeSet: Schema.optionalKey(ApiSchema8555),
  state: ApiSchema8417,
  topology: Schema.optionalKey(ApiSchema8732),
  warnings: ApiSchema279,
  workset: Schema.String,
});

export const isCodeGraphProjectScopePreview = Schema.is(ApiSchema5623);
export const isJobsResponse = Schema.is(ApiSchema5666);
export const isManagerWorksetDefinition = Schema.is(ApiSchema5682);
export const isCodeGraphWorksetStatusResultV1 = Schema.is(ApiSchema5699);
export const isManagerWorksetDefinitionMutationResult = Schema.is(ApiSchema5788);
export const isProjectedCodeGraphWorksetEvidenceV1 = Schema.is(ApiSchema5890);
export const isCodeGraphCrossRepositoryTraversalResultV1 = Schema.is(ApiSchema5950);
export const isCodeGraphWorksetTopologyResultV1 = Schema.is(ApiSchema5998);
