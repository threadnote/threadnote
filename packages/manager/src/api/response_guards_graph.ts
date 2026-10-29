import {Schema} from 'effect';

const ApiSchema7505 = Schema.Struct({
  confidence: Schema.Finite,
  count: Schema.Finite,
  id: Schema.String,
  provenance: Schema.String,
  relation: Schema.String,
  sourceId: Schema.String,
  targetId: Schema.String,
});
const ApiSchema7506 = Schema.Array(ApiSchema7505);
const ApiSchema7510 = Schema.Union([Schema.Literal('detail'), Schema.Literal('overview')]);
const ApiSchema256 = Schema.Union([Schema.Undefined, Schema.Literal(false), Schema.Literal(true)]);
const ApiSchema109 = Schema.Union([Schema.Undefined, Schema.Finite]);
const ApiSchema320 = Schema.Union([Schema.Undefined, Schema.String]);
const ApiSchema7514 = Schema.Union([Schema.Literal('symbol'), Schema.Literal('project')]);
const ApiSchema7511 = Schema.Struct({
  degree: Schema.Finite,
  exported: Schema.optionalKey(ApiSchema256),
  fileCount: Schema.optionalKey(ApiSchema109),
  id: Schema.String,
  kind: Schema.String,
  label: Schema.String,
  language: Schema.optionalKey(ApiSchema320),
  packageName: Schema.optionalKey(ApiSchema320),
  path: Schema.optionalKey(ApiSchema320),
  projectId: Schema.String,
  qualifiedName: Schema.optionalKey(ApiSchema320),
  signature: Schema.optionalKey(ApiSchema320),
  symbolCount: Schema.optionalKey(ApiSchema109),
  type: ApiSchema7514,
});
const ApiSchema7512 = Schema.Array(ApiSchema7511);
const ApiSchema7515 = Schema.Struct({edgeLimit: Schema.Finite, hasMore: Schema.Boolean, nodeLimit: Schema.Finite});
const ApiSchema279 = Schema.Array(Schema.String);
const ApiSchema7516 = Schema.Struct({
  matchedNodes: Schema.Finite,
  state: Schema.Literal('ready'),
  text: Schema.String,
  warnings: ApiSchema279,
});
const ApiSchema7517 = Schema.Union([Schema.Undefined, ApiSchema7516]);
const ApiSchema7531 = Schema.Struct({
  attributedSymbols: Schema.Finite,
  componentSymbols: Schema.Finite,
  fallbackSymbols: Schema.Finite,
  omittedSymbols: Schema.Finite,
  totalSymbols: Schema.Finite,
});
const ApiSchema7534 = Schema.Union([Schema.Literal('deferred'), Schema.Literal('complete')]);
const ApiSchema7535 = Schema.Struct({
  commit: Schema.String,
  completedAt: Schema.optionalKey(ApiSchema320),
  dirty: Schema.Boolean,
  edgeCount: Schema.Finite,
  fileCount: Schema.Finite,
  id: Schema.String,
  symbolCount: Schema.Finite,
});
const ApiSchema7529 = Schema.Struct({
  id: Schema.String,
  accounting: ApiSchema7531,
  displayName: Schema.String,
  metrics: ApiSchema7534,
  snapshot: ApiSchema7535,
});
const ApiSchema7536 = Schema.Struct({id: Schema.String, label: Schema.String});
const ApiSchema7537 = Schema.Struct({
  renderedEdges: Schema.Finite,
  renderedNodes: Schema.Finite,
  totalEdges: Schema.Finite,
  totalNodes: Schema.Finite,
});
const ApiSchema88 = Schema.Struct({
  edges: ApiSchema7506,
  mode: ApiSchema7510,
  nodes: ApiSchema7512,
  paging: ApiSchema7515,
  projectId: Schema.String,
  query: Schema.optionalKey(ApiSchema7517),
  repository: ApiSchema7529,
  scope: ApiSchema7536,
  stats: ApiSchema7537,
  warnings: ApiSchema279,
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
const ApiSchema122 = Schema.Struct({
  projectOffset: Schema.Finite,
  query: Schema.String,
  repository: ApiSchema7518,
  workspaceOffset: Schema.Finite,
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
const ApiSchema130 = Schema.Struct({
  hasMore: Schema.Boolean,
  offset: Schema.Finite,
  query: Schema.String,
  repositories: ApiSchema7564,
});
const ApiSchema7566 = Schema.Struct({id: Schema.String, label: Schema.String, memberCount: Schema.Finite});
const ApiSchema7567 = Schema.Array(ApiSchema7566);
const ApiSchema7576 = Schema.Union([
  Schema.Literal('complete'),
  Schema.Literal('not-requested'),
  Schema.Literal('partial'),
  Schema.Literal('unavailable'),
]);
const ApiSchema7569 = Schema.Struct({complete: Schema.Boolean, state: ApiSchema7576});
const ApiSchema7568 = Schema.Struct({complete: Schema.Boolean, nodesComplete: Schema.Boolean, topology: ApiSchema7569});
const ApiSchema7583 = Schema.Union([Schema.Literal('god-node'), Schema.Literal('hub')]);
const ApiSchema7584 = Schema.Struct({label: Schema.String, path: Schema.String});
const ApiSchema7577 = Schema.Struct({classification: ApiSchema7583, degree: Schema.Finite, node: ApiSchema7584});
const ApiSchema7578 = Schema.Array(ApiSchema7577);
const ApiSchema7585 = Schema.Struct({
  analyzedEdgeCount: Schema.Finite,
  analyzedNodeCount: Schema.Finite,
  communityCount: Schema.Finite,
  connectedComponentCount: Schema.Finite,
  maximumDegree: Schema.Finite,
});
const ApiSchema7588 = Schema.Struct({label: Schema.String});
const ApiSchema7589 = Schema.Struct({label: Schema.String});
const ApiSchema7586 = Schema.Struct({
  relation: Schema.String,
  score: Schema.Finite,
  source: ApiSchema7588,
  target: ApiSchema7589,
});
const ApiSchema7587 = Schema.Array(ApiSchema7586);
const ApiSchema323 = Schema.Struct({
  communities: ApiSchema7567,
  coverage: ApiSchema7568,
  hubs: ApiSchema7578,
  statistics: ApiSchema7585,
  surprisingLinks: ApiSchema7587,
  warnings: ApiSchema279,
});
const ApiSchema7591 = Schema.Struct({
  column: Schema.Finite,
  endColumn: Schema.Finite,
  endLine: Schema.Finite,
  line: Schema.Finite,
});
const ApiSchema7590 = Schema.Struct({
  documentation: Schema.optionalKey(ApiSchema320),
  exported: Schema.Boolean,
  id: Schema.String,
  kind: Schema.String,
  label: Schema.String,
  language: Schema.String,
  packageName: Schema.optionalKey(ApiSchema320),
  path: Schema.String,
  projectId: Schema.String,
  qualifiedName: Schema.String,
  signature: Schema.optionalKey(ApiSchema320),
  span: ApiSchema7591,
});
const ApiSchema7594 = Schema.Union([Schema.Literal('incoming'), Schema.Literal('outgoing')]);
const ApiSchema7595 = Schema.Struct({
  id: Schema.optionalKey(ApiSchema320),
  kind: Schema.optionalKey(ApiSchema320),
  label: Schema.String,
  path: Schema.optionalKey(ApiSchema320),
  projectId: Schema.optionalKey(ApiSchema320),
  qualifiedName: Schema.optionalKey(ApiSchema320),
});
const ApiSchema7592 = Schema.Struct({
  confidence: Schema.Finite,
  direction: ApiSchema7594,
  evidencePath: Schema.String,
  evidenceSpan: ApiSchema7591,
  id: Schema.String,
  provenance: Schema.String,
  related: ApiSchema7595,
  relation: Schema.String,
});
const ApiSchema7593 = Schema.Array(ApiSchema7592);
const ApiSchema7597 = Schema.Struct({count: Schema.Finite, provenance: Schema.String});
const ApiSchema7598 = Schema.Array(ApiSchema7597);
const ApiSchema7599 = Schema.Struct({
  count: Schema.Finite,
  incoming: Schema.Finite,
  outgoing: Schema.Finite,
  relation: Schema.String,
});
const ApiSchema7600 = Schema.Array(ApiSchema7599);
const ApiSchema7596 = Schema.Struct({
  incoming: Schema.Finite,
  outgoing: Schema.Finite,
  sampledEdges: Schema.optionalKey(ApiSchema109),
  summaryTruncated: Schema.optionalKey(ApiSchema256),
  provenances: ApiSchema7598,
  relations: ApiSchema7600,
  truncated: Schema.Boolean,
});
const ApiSchema326 = Schema.Struct({
  node: ApiSchema7590,
  relationships: ApiSchema7593,
  snapshotId: Schema.String,
  stats: ApiSchema7596,
});
const ApiSchema329 = Schema.Struct({
  query: ApiSchema7516,
  edges: ApiSchema7506,
  mode: ApiSchema7510,
  nodes: ApiSchema7512,
  paging: ApiSchema7515,
  projectId: Schema.String,
  repository: ApiSchema7529,
  scope: ApiSchema7536,
  stats: ApiSchema7537,
  warnings: ApiSchema279,
});
const ApiSchema332 = Schema.Struct({content: Schema.String});
const ApiSchema7601 = Schema.Struct({
  action: Schema.String,
  relativePath: Schema.String,
  detail: Schema.optionalKey(ApiSchema320),
});
const ApiSchema7602 = Schema.Array(ApiSchema7601);
const ApiSchema555 = Schema.Union([Schema.Undefined, ApiSchema279]);
const ApiSchema834 = Schema.Struct({
  output: Schema.String,
  entries: ApiSchema7602,
  reviewCount: Schema.optionalKey(ApiSchema109),
  applied: Schema.Boolean,
  warnings: Schema.optionalKey(ApiSchema555),
});

export const isGraphVisualization = Schema.is(ApiSchema88);
export const isGraphCatalogPage = Schema.is(ApiSchema122);
export const isGraphViewPage = Schema.is(ApiSchema130);
export const isGraphAnalysis = Schema.is(ApiSchema323);
export const isGraphNodeDetail = Schema.is(ApiSchema326);
export const isGraphQueryVisualization = Schema.is(ApiSchema329);
export const isContentResponse = Schema.is(ApiSchema332);
export const isIntegrationResult = Schema.is(ApiSchema834);
