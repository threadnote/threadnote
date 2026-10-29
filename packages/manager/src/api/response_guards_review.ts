import {Schema} from 'effect';

const ApiSchema320 = Schema.Union([Schema.Undefined, Schema.String]);
const ApiSchema6121 = Schema.Struct({output: Schema.optionalKey(ApiSchema320)});
const ApiSchema6212 = Schema.Union([Schema.Literal('both'), Schema.Literal('left'), Schema.Literal('right')]);
const ApiSchema6247 = Schema.Union([
  Schema.Literal('keep-both'),
  Schema.Literal('archive-other'),
  Schema.Literal('review-only'),
]);
const ApiSchema279 = Schema.Array(Schema.String);
const ApiSchema6192 = Schema.Struct({
  previewId: Schema.String,
  revision: Schema.String,
  choice: ApiSchema6212,
  mode: ApiSchema6247,
  summary: Schema.String,
  reason: Schema.optionalKey(ApiSchema320),
  keptUri: Schema.optionalKey(ApiSchema320),
  archivedUri: Schema.optionalKey(ApiSchema320),
  keptContent: Schema.optionalKey(ApiSchema320),
  archivedContent: Schema.optionalKey(ApiSchema320),
  constraints: ApiSchema279,
});
const ApiSchema6193 = Schema.Struct({preview: ApiSchema6192});
const ApiSchema9087 = Schema.Union([Schema.Literal('applied'), Schema.Literal('already-applied')]);
const ApiSchema6226 = Schema.Struct({
  status: ApiSchema9087,
  choice: ApiSchema6212,
  keptUri: Schema.optionalKey(ApiSchema320),
  archivedUri: Schema.optionalKey(ApiSchema320),
});
const ApiSchema6227 = Schema.Struct({result: ApiSchema6226});
const ApiSchema9096 = Schema.Union([
  Schema.Literal('apply'),
  Schema.Literal('conflict'),
  Schema.Literal('reject'),
  Schema.Literal('defer'),
  Schema.Literal('resume'),
  Schema.Literal('begin_apply'),
  Schema.Literal('create_review'),
  Schema.Literal('refresh_safety'),
]);
const ApiSchema256 = Schema.Union([Schema.Undefined, Schema.Literal(false), Schema.Literal(true)]);
const ApiSchema9088 = Schema.Struct({
  action: ApiSchema9096,
  allowDestructiveReplacement: Schema.optionalKey(ApiSchema256),
  at: Schema.String,
  candidateId: Schema.optionalKey(ApiSchema320),
  memoryUri: Schema.optionalKey(ApiSchema320),
  reviewId: Schema.String,
  revision: Schema.Finite,
});
const ApiSchema9089 = Schema.Array(ApiSchema9088);
const ApiSchema9098 = Schema.Union([Schema.Undefined, Schema.Literal('create'), Schema.Literal('replace')]);
const ApiSchema9102 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('conflict'),
  Schema.Literal('prepared'),
  Schema.Literal('written'),
  Schema.Literal('cleanup_pending'),
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
const ApiSchema596 = Schema.Union([
  Schema.Literal('durable'),
  Schema.Literal('handoff'),
  Schema.Literal('incident'),
  Schema.Literal('preference'),
  Schema.Literal('smoke'),
]);
const ApiSchema9120 = Schema.Union([
  Schema.Literal('create'),
  Schema.Literal('replace'),
  Schema.Literal('no_action'),
  Schema.Literal('manual_review'),
]);
const ApiSchema9121 = Schema.Struct({
  bodyCharacters: Schema.Finite,
  nonEmptyLines: Schema.Finite,
  sectionHeadings: ApiSchema279,
  sectionListTruncated: Schema.Boolean,
  version: Schema.Literal(1),
});
const ApiSchema9122 = Schema.Union([Schema.Undefined, ApiSchema9121]);
const ApiSchema9123 = Schema.Union([
  Schema.Literal('pending'),
  Schema.Literal('deferred'),
  Schema.Literal('rejected'),
  Schema.Literal('applying'),
  Schema.Literal('applied'),
  Schema.Literal('conflict'),
]);
const ApiSchema6297 = Schema.Struct({
  applyAllowDestructiveReplacement: Schema.optionalKey(ApiSchema256),
  applyApprovedAt: Schema.optionalKey(ApiSchema320),
  applyBodyText: Schema.optionalKey(ApiSchema320),
  applyContentHash: Schema.optionalKey(ApiSchema320),
  applyOperation: Schema.optionalKey(ApiSchema9098),
  applyReplaceUri: Schema.optionalKey(ApiSchema320),
  applyStage: Schema.optionalKey(ApiSchema9102),
  applyTargetUri: Schema.optionalKey(ApiSchema320),
  candidateId: Schema.String,
  categories: ApiSchema9108,
  comparison: ApiSchema9117,
  confidence: Schema.Finite,
  evidence: ApiSchema279,
  kind: ApiSchema596,
  project: Schema.String,
  proposedText: Schema.String,
  reason: Schema.String,
  recommendation: ApiSchema9120,
  replacementSafetyBaseline: Schema.optionalKey(ApiSchema9122),
  state: ApiSchema9123,
  targetContentHash: Schema.optionalKey(ApiSchema320),
  targetUri: Schema.optionalKey(ApiSchema320),
  topic: Schema.String,
});
const ApiSchema555 = Schema.Union([Schema.Undefined, ApiSchema279]);
const ApiSchema9124 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('durable'),
  Schema.Literal('handoff'),
  Schema.Literal('incident'),
  Schema.Literal('preference'),
  Schema.Literal('smoke'),
]);
const ApiSchema6323 = Schema.Struct({
  state: ApiSchema9123,
  targetUri: Schema.optionalKey(ApiSchema320),
  candidateId: Schema.String,
  applyAllowDestructiveReplacement: Schema.optionalKey(ApiSchema256),
  applyApprovedAt: Schema.optionalKey(ApiSchema320),
  applyBodyText: Schema.optionalKey(ApiSchema320),
  applyContentHash: Schema.optionalKey(ApiSchema320),
  applyOperation: Schema.optionalKey(ApiSchema9098),
  applyReplaceUri: Schema.optionalKey(ApiSchema320),
  applyStage: Schema.optionalKey(ApiSchema9102),
  applyTargetUri: Schema.optionalKey(ApiSchema320),
  categories: ApiSchema9108,
  comparison: ApiSchema9117,
  confidence: Schema.Finite,
  proposedText: Schema.String,
  reason: Schema.String,
  recommendation: ApiSchema9120,
  replacementSafetyBaseline: Schema.optionalKey(ApiSchema9122),
  targetContentHash: Schema.optionalKey(ApiSchema320),
  evidence: Schema.optionalKey(ApiSchema555),
  kind: Schema.optionalKey(ApiSchema9124),
  project: Schema.optionalKey(ApiSchema320),
  topic: Schema.optionalKey(ApiSchema320),
});
const ApiSchema6324 = Schema.Union([ApiSchema6297, ApiSchema6323]);
const ApiSchema6325 = Schema.Array(ApiSchema6324);
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
const ApiSchema9125 = Schema.Struct({
  type: Schema.Literal('structured-closeout'),
  version: Schema.Literal(1),
  rationale: Schema.String,
  constraints: ApiSchema279,
  verificationPerformed: ApiSchema279,
  knowledgeInvalidated: ApiSchema279,
  unresolvedRisks: ApiSchema279,
});
const ApiSchema9126 = Schema.Union([Schema.Undefined, ApiSchema9125]);
const ApiSchema7469 = Schema.Union([
  Schema.Literal('descriptive'),
  Schema.Literal('normative'),
  Schema.Literal('historical'),
]);
const ApiSchema7479 = Schema.Union([
  Schema.Literal('direct'),
  Schema.Literal('contextual'),
  Schema.Literal('unresolved'),
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
const ApiSchema9137 = Schema.Union([Schema.Literal('historical'), Schema.Literal('current')]);
const ApiSchema9135 = Schema.Struct({id: Schema.String, citationId: Schema.String, variant: ApiSchema9137});
const ApiSchema9136 = Schema.Array(ApiSchema9135);
const ApiSchema9134 = Schema.Struct({
  version: Schema.Literal(1),
  targetUri: Schema.String,
  targetHash: Schema.String,
  observationRevision: Schema.String,
  packetDigest: Schema.String,
  body: Schema.String,
  paragraphs: ApiSchema7831,
  additionalDependencies: ApiSchema7833,
  handles: ApiSchema9136,
});
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
const ApiSchema9144 = Schema.Union([
  Schema.Literal('update'),
  Schema.Literal('unresolved'),
  Schema.Literal('revalidate'),
]);
const ApiSchema9140 = Schema.Struct({
  ordinal: Schema.Finite,
  beforeHash: Schema.String,
  disposition: ApiSchema9144,
  supportHandles: ApiSchema279,
  rationale: Schema.String,
});
const ApiSchema9141 = Schema.Array(ApiSchema9140);
const ApiSchema9138 = Schema.Struct({version: Schema.Literal(1), entries: ApiSchema9141});
const ApiSchema9139 = Schema.Union([Schema.Undefined, ApiSchema9138]);
const ApiSchema7677 = Schema.Struct({
  version: Schema.Literal(1),
  targetHash: Schema.String,
  observationRevision: Schema.String,
  packetDigest: Schema.String,
  outcome: ApiSchema7703,
  operations: ApiSchema7705,
  reviewedHandles: ApiSchema279,
  rationale: Schema.String,
  unresolvedQuestions: ApiSchema279,
  removedClaims: ApiSchema279,
  paragraphDispositions: Schema.optionalKey(ApiSchema9139),
});
const ApiSchema7706 = Schema.Array(Schema.Finite);
const ApiSchema7664 = Schema.Struct({
  version: Schema.Literal(1),
  draft: ApiSchema7677,
  body: Schema.String,
  finalBodyHash: Schema.String,
  changedOrdinals: ApiSchema7706,
});
const ApiSchema9151 = Schema.Union([Schema.Literal('historical-verified'), Schema.Literal('current-verified')]);
const ApiSchema9152 = Schema.Struct({
  extractorSet: Schema.String,
  fileContentHash: Schema.String,
  path: Schema.String,
  repositoryId: Schema.String,
  sourceCommit: Schema.String,
  sourceDirty: Schema.Boolean,
  sourceSnapshotId: Schema.String,
});
const ApiSchema9145 = Schema.Struct({
  handleId: Schema.String,
  content: Schema.String,
  excerptHash: Schema.String,
  fileBytesHash: Schema.String,
  startLine: Schema.Finite,
  endLine: Schema.Finite,
  provenance: ApiSchema9151,
  supportsCitation: Schema.Literal(true),
  truncated: Schema.Literal(false),
  source: ApiSchema9152,
  citation: ApiSchema7714,
});
const ApiSchema9146 = Schema.Array(ApiSchema9145);
const ApiSchema9156 = Schema.Union([Schema.Undefined, Schema.Literal('model')]);
const ApiSchema6693 = Schema.Union([Schema.Literal(1), Schema.Literal(2)]);
const ApiSchema9181 = Schema.Union([
  Schema.Literal('completed'),
  Schema.Literal('failed'),
  Schema.Literal('started'),
  Schema.Literal('interrupted'),
]);
const ApiSchema4313 = Schema.Union([Schema.Literal('local-ai'), Schema.Literal('effect-ai')]);
const ApiSchema9208 = Schema.Union([
  Schema.Literal('generation'),
  Schema.Literal('validation'),
  Schema.Literal('closing-fence'),
  Schema.Literal('review-save'),
]);
const ApiSchema7773 = Schema.Union([Schema.Null, Schema.Finite]);
const ApiSchema9281 = Schema.Union([
  Schema.Literal('deadline'),
  Schema.Literal('started'),
  Schema.Literal('interrupted'),
  Schema.Literal('not-dispatched'),
  Schema.Literal('accepted'),
  Schema.Literal('draft-invalid'),
  Schema.Literal('provider-output-invalid'),
  Schema.Literal('provider-failed'),
]);
const ApiSchema9661 = Schema.Struct({status: Schema.Literal('unavailable')});
const ApiSchema9670 = Schema.Struct({
  status: Schema.Literal('measured'),
  inputTokens: Schema.Finite,
  outputTokens: Schema.Finite,
});
const ApiSchema9673 = Schema.Union([ApiSchema9661, ApiSchema9670]);
const ApiSchema9475 = Schema.Union([
  Schema.Literal('interrupted'),
  Schema.Literal('not-returned'),
  Schema.Literal('provider-decode-failed'),
]);
const ApiSchema9683 = Schema.Struct({status: Schema.Literal('unavailable'), reason: ApiSchema9475});
const ApiSchema9510 = Schema.Union([Schema.Literal('provider-text'), Schema.Literal('decoded-json')]);
const ApiSchema9692 = Schema.Struct({
  status: Schema.Literal('observed'),
  representation: ApiSchema9510,
  hash: Schema.String,
  bytes: Schema.Finite,
});
const ApiSchema9695 = Schema.Union([ApiSchema9683, ApiSchema9692]);
const ApiSchema9587 = Schema.Struct({
  ordinal: ApiSchema6693,
  promptHash: Schema.String,
  promptBytes: Schema.Finite,
  status: ApiSchema9281,
  elapsedMilliseconds: ApiSchema7773,
  usage: ApiSchema9673,
  output: ApiSchema9695,
});
const ApiSchema9589 = Schema.Array(ApiSchema9587);
const ApiSchema9649 = Schema.Struct({
  reviewId: Schema.String,
  state: ApiSchema9181,
  version: Schema.Literal(1),
  model: Schema.String,
  agent: ApiSchema4313,
  caseId: Schema.String,
  observationRevision: Schema.String,
  receiptId: Schema.String,
  targetHash: Schema.String,
  packetDigest: Schema.String,
  phase: ApiSchema9208,
  elapsedMilliseconds: ApiSchema7773,
  promptVersion: Schema.String,
  promptScope: Schema.Literal('user-prompt-utf8-sha256'),
  attempts: ApiSchema9589,
  modelVersion: Schema.optionalKey(ApiSchema320),
});
const ApiSchema9651 = Schema.Union([Schema.Undefined, ApiSchema9649]);
const ApiSchema9698 = Schema.Struct({status: Schema.Literal('unavailable')});
const ApiSchema9699 = Schema.Struct({
  status: Schema.Literal('measured'),
  inputTokens: Schema.Finite,
  outputTokens: Schema.Finite,
});
const ApiSchema9700 = Schema.Union([ApiSchema9698, ApiSchema9699]);
const ApiSchema9153 = Schema.Struct({
  origin: Schema.optionalKey(ApiSchema9156),
  agent: Schema.String,
  model: Schema.String,
  modelVersion: Schema.optionalKey(ApiSchema320),
  promptVersion: Schema.String,
  attempts: ApiSchema6693,
  observation: Schema.optionalKey(ApiSchema9651),
  usage: ApiSchema9700,
});
const ApiSchema9703 = Schema.Struct({status: Schema.Literal('unavailable')});
const ApiSchema9154 = Schema.Struct({
  origin: Schema.Literal('manual'),
  agent: Schema.Literal('manual'),
  model: Schema.Literal('none'),
  modelVersion: Schema.optionalKey(Schema.Undefined),
  promptVersion: Schema.Literal('manual-topic-v1'),
  attempts: Schema.Literal(0),
  usage: ApiSchema9703,
});
const ApiSchema9155 = Schema.Union([ApiSchema9153, ApiSchema9154]);
const ApiSchema9129 = Schema.Struct({
  version: Schema.Literal(1),
  basis: ApiSchema9134,
  proposal: ApiSchema7664,
  reviewEvidence: ApiSchema9146,
  generation: ApiSchema9155,
});
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
const ApiSchema9704 = Schema.Struct({
  version: Schema.Literal(2),
  sourceKind: Schema.Literal('obsidian'),
  originEvidence: ApiSchema7734,
  activeEvidence: ApiSchema7734,
  currentEvidence: ApiSchema7734,
  targetUri: Schema.String,
  observationRevision: Schema.String,
  body: Schema.String,
  targetHash: Schema.String,
  packetDigest: Schema.String,
  paragraphs: ApiSchema7831,
  additionalDependencies: ApiSchema7833,
  handles: ApiSchema9136,
});
const ApiSchema9711 = Schema.Struct({
  sourceKind: Schema.Literal('obsidian'),
  handleId: Schema.String,
  content: Schema.String,
  excerptHash: Schema.String,
  provenance: ApiSchema9151,
  supportsCitation: Schema.Literal(true),
  truncated: Schema.Literal(false),
  citation: ApiSchema7734,
});
const ApiSchema9712 = Schema.Array(ApiSchema9711);
const ApiSchema9130 = Schema.Struct({
  version: Schema.Literal(2),
  sourceKind: Schema.Literal('obsidian'),
  basis: ApiSchema9704,
  proposal: ApiSchema7664,
  reviewEvidence: ApiSchema9712,
  generation: ApiSchema9155,
});
const ApiSchema9714 = Schema.Struct({version: Schema.Literal(1), kind: Schema.Literal('derived')});
const ApiSchema9721 = Schema.Union([Schema.Literal(1), Schema.Literal(2), Schema.Literal(3)]);
const ApiSchema9715 = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal('legacy-approved'),
  manifestVersion: ApiSchema9721,
  manifestHash: Schema.String,
});
const ApiSchema9716 = Schema.Union([ApiSchema9714, ApiSchema9715]);
const ApiSchema606 = Schema.Union([
  Schema.Literal('active'),
  Schema.Literal('archived'),
  Schema.Literal('expired'),
  Schema.Literal('superseded'),
]);
const ApiSchema109 = Schema.Union([Schema.Undefined, Schema.Finite]);
const ApiSchema9723 = Schema.Union([Schema.Literal('shared'), Schema.Literal('personal'), Schema.Literal('external')]);
const ApiSchema9722 = Schema.Struct({
  uri: Schema.String,
  memoryId: Schema.optionalKey(ApiSchema320),
  kind: ApiSchema596,
  status: ApiSchema606,
  schemaVersion: Schema.optionalKey(ApiSchema109),
  canonicalHash: Schema.String,
  bodyHash: Schema.String,
  paragraphCount: ApiSchema7773,
  visibility: ApiSchema9723,
  readOnly: Schema.Boolean,
  artifact: Schema.Boolean,
});
const ApiSchema7789 = Schema.Union([
  Schema.Literal('unknown'),
  Schema.Literal('descriptive'),
  Schema.Literal('normative'),
  Schema.Literal('historical'),
]);
const ApiSchema9728 = Schema.Union([Schema.Literal('legacy-approved'), Schema.Literal('provisional')]);
const ApiSchema9724 = Schema.Struct({
  ordinal: Schema.Finite,
  hash: Schema.String,
  role: ApiSchema7789,
  roleAuthority: ApiSchema9728,
  support: ApiSchema7479,
  supportAuthority: ApiSchema9728,
  historicalEvidenceIds: ApiSchema279,
  acceptedEvidenceIds: ApiSchema279,
  currentEvidenceIds: ApiSchema279,
  currentSupport: ApiSchema7479,
  currentSupportAuthority: Schema.Literal('provisional'),
  scope: Schema.optionalKey(ApiSchema320),
  validity: Schema.optionalKey(ApiSchema320),
});
const ApiSchema9725 = Schema.Array(ApiSchema9724);
const ApiSchema7710 = Schema.Struct({kind: Schema.Literal('code'), citation: ApiSchema7714});
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
const ApiSchema9733 = Schema.Union([
  Schema.Literal('legacy-approved'),
  Schema.Literal('provisional'),
  Schema.Literal('recorded'),
]);
const ApiSchema9738 = Schema.Union([
  Schema.Literal('expired'),
  Schema.Literal('unknown'),
  Schema.Literal('missing'),
  Schema.Literal('available'),
  Schema.Literal('revoked'),
  Schema.Literal('corrupt'),
]);
const ApiSchema9729 = Schema.Struct({
  id: Schema.String,
  source: ApiSchema7713,
  scope: ApiSchema7742,
  authority: ApiSchema9733,
  availability: ApiSchema9738,
});
const ApiSchema9730 = Schema.Array(ApiSchema9729);
const ApiSchema7940 = Schema.Union([Schema.Literal('configuration'), Schema.Literal('dependency')]);
const ApiSchema9739 = Schema.Struct({kind: ApiSchema7940, evidenceId: Schema.String});
const ApiSchema9740 = Schema.Array(ApiSchema9739);
const ApiSchema7765 = Schema.Union([Schema.Literal('unknown'), Schema.Literal('complete'), Schema.Literal('partial')]);
const ApiSchema7772 = Schema.Union([
  Schema.Literal('recorded-only'),
  Schema.Literal('bounded-search'),
  Schema.Literal('none'),
]);
const ApiSchema7764 = Schema.Struct({
  outcome: ApiSchema7765,
  scope: ApiSchema7772,
  searchedScopes: ApiSchema279,
  omittedSources: Schema.Finite,
  omittedParagraphs: ApiSchema7773,
});
const ApiSchema7937 = Schema.Union([
  Schema.Literal('personal-review'),
  Schema.Literal('shared-owner-review'),
  Schema.Literal('read-only'),
  Schema.Literal('excluded'),
]);
const ApiSchema9758 = Schema.Union([
  Schema.Literal('read-only'),
  Schema.Literal('inactive'),
  Schema.Literal('artifact'),
  Schema.Literal('missing-id'),
  Schema.Literal('unsupported-schema'),
  Schema.Literal('coverage-gap'),
  Schema.Literal('protected-role'),
  Schema.Literal('evidence-unavailable'),
  Schema.Literal('target-bounds'),
]);
const ApiSchema9759 = Schema.Array(ApiSchema9758);
const ApiSchema9741 = Schema.Struct({
  assess: Schema.Boolean,
  draft: Schema.Boolean,
  apply: Schema.Literal(false),
  publish: Schema.Literal(false),
  reviewRoute: ApiSchema7937,
  reasons: ApiSchema9759,
});
const ApiSchema7747 = Schema.Struct({
  version: Schema.Literal(1),
  preparation: ApiSchema9716,
  target: ApiSchema9722,
  paragraphs: ApiSchema9725,
  evidence: ApiSchema9730,
  dependencies: ApiSchema9740,
  coverage: ApiSchema7764,
  capabilities: ApiSchema9741,
});
const ApiSchema9760 = Schema.Struct({
  version: Schema.Literal(2),
  kind: Schema.Literal('reviewed-support'),
  supportDigest: Schema.String,
});
const ApiSchema9763 = Schema.Struct({
  roleAuthority: Schema.Literal('reviewed'),
  supportAuthority: Schema.Literal('reviewed'),
  scope: Schema.optionalKey(ApiSchema320),
  role: ApiSchema7789,
  support: ApiSchema7479,
  ordinal: Schema.Finite,
  hash: Schema.String,
  historicalEvidenceIds: ApiSchema279,
  acceptedEvidenceIds: ApiSchema279,
  currentEvidenceIds: ApiSchema279,
  currentSupport: ApiSchema7479,
  currentSupportAuthority: Schema.Literal('provisional'),
  validity: Schema.optionalKey(ApiSchema320),
});
const ApiSchema9765 = Schema.Array(ApiSchema9763);
const ApiSchema7748 = Schema.Struct({
  version: Schema.Literal(2),
  preparation: ApiSchema9760,
  paragraphs: ApiSchema9765,
  dependencies: ApiSchema9740,
  evidence: ApiSchema9730,
  coverage: ApiSchema7764,
  target: ApiSchema9722,
  capabilities: ApiSchema9741,
});
const ApiSchema7750 = Schema.Union([ApiSchema7747, ApiSchema7748]);
const ApiSchema9781 = Schema.Struct({uri: Schema.String, hash: Schema.String});
const ApiSchema9782 = Schema.Array(ApiSchema9781);
const ApiSchema9783 = Schema.Union([ApiSchema9725, ApiSchema9765]);
const ApiSchema1655 = Schema.Tuple([]);
const ApiSchema9786 = Schema.Union([Schema.Literal('current'), Schema.Literal('accepted')]);
const ApiSchema9784 = Schema.Struct({id: Schema.String, citationId: Schema.String, variant: ApiSchema9786});
const ApiSchema9785 = Schema.Array(ApiSchema9784);
const ApiSchema9713 = Schema.Struct({
  version: Schema.Literal(3),
  kind: Schema.Literal('automatic'),
  targetUri: Schema.String,
  targetHash: Schema.String,
  observationRevision: Schema.String,
  packetDigest: Schema.String,
  body: Schema.String,
  assessment: ApiSchema7750,
  reads: ApiSchema9782,
  scopeRevision: Schema.String,
  paragraphs: ApiSchema9783,
  additionalDependencies: ApiSchema1655,
  handles: ApiSchema9785,
});
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
const ApiSchema7662 = Schema.Struct({
  version: Schema.Literal(2),
  kind: Schema.Literal('automatic'),
  draft: ApiSchema7675,
  body: Schema.String,
  finalBodyHash: Schema.String,
  changedOrdinals: ApiSchema7706,
});
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
const ApiSchema9131 = Schema.Struct({
  version: Schema.Literal(3),
  kind: Schema.Literal('automatic'),
  basis: ApiSchema9713,
  proposal: ApiSchema7662,
  reviewEvidence: ApiSchema7708,
  generation: ApiSchema9155,
});
const ApiSchema9133 = Schema.Union([Schema.Undefined, ApiSchema9129, ApiSchema9130, ApiSchema9131]);
const ApiSchema9793 = Schema.Union([Schema.Literal('reserved'), Schema.Literal('captured')]);
const ApiSchema9795 = Schema.Struct({
  version: Schema.Literal(1),
  operationId: Schema.String,
  pinId: Schema.String,
  capturedAt: Schema.String,
  expiresAt: Schema.String,
  accessHash: Schema.String,
  vaultHash: Schema.String,
  fragmentStart: Schema.Finite,
  fragmentEnd: Schema.Finite,
});
const ApiSchema9794 = Schema.Struct({
  sourceId: Schema.String,
  relativePath: Schema.String,
  fragment: Schema.String,
  expectedSourceInstanceId: Schema.String,
  expectedNoteId: Schema.String,
  expectedRevisionHash: Schema.String,
  expectedSanitizerVersion: Schema.String,
  retentionDays: Schema.Finite,
  reservation: ApiSchema9795,
});
const ApiSchema7879 = Schema.Union([Schema.Undefined, ApiSchema7734]);
const ApiSchema9787 = Schema.Struct({
  version: Schema.Literal(1),
  sourceKind: Schema.Literal('obsidian'),
  stage: ApiSchema9793,
  targetUri: Schema.String,
  targetHash: Schema.String,
  observationRevision: Schema.String,
  inspectionDigest: Schema.String,
  input: ApiSchema9794,
  citation: Schema.optionalKey(ApiSchema7879),
});
const ApiSchema9788 = Schema.Union([Schema.Undefined, ApiSchema9787]);
const ApiSchema7780 = Schema.Union([
  Schema.Literal('preview'),
  Schema.Literal('conflict'),
  Schema.Literal('parked'),
  Schema.Literal('prepared'),
  Schema.Literal('written'),
]);
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
const ApiSchema9804 = Schema.Union([ApiSchema7820, ApiSchema7822]);
const ApiSchema7816 = Schema.Union([
  Schema.Literal('depends_on'),
  Schema.Literal('references'),
  Schema.Literal('evidence_for'),
  Schema.Literal('related_to'),
  Schema.Literal('supersedes'),
]);
const ApiSchema5171 = Schema.Struct({type: ApiSchema7816, uri: Schema.String});
const ApiSchema5172 = Schema.Array(ApiSchema5171);
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
const ApiSchema9805 = Schema.Union([Schema.Undefined, ApiSchema7859]);
const ApiSchema9806 = Schema.Struct({field: Schema.String, beforeHash: Schema.String, afterHash: Schema.String});
const ApiSchema9807 = Schema.Array(ApiSchema9806);
const ApiSchema9803 = Schema.Struct({
  version: Schema.Literal(1),
  reviewId: Schema.String,
  approvedAt: Schema.String,
  targetUri: Schema.String,
  beforeContent: Schema.String,
  beforeContentHash: Schema.String,
  content: Schema.String,
  contentHash: Schema.String,
  approvalDigest: Schema.String,
  approvedProposal: ApiSchema7664,
  manifest: ApiSchema9804,
  codeCitations: ApiSchema7807,
  consolidation: Schema.optionalKey(ApiSchema9805),
  metadataDiff: ApiSchema9807,
});
const ApiSchema9796 = Schema.Struct({
  version: Schema.Literal(1),
  reviewRevision: Schema.Finite,
  stage: ApiSchema7780,
  preview: ApiSchema9803,
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
const ApiSchema9815 = Schema.Struct({
  version: Schema.Literal(2),
  sourceKind: Schema.Literal('obsidian'),
  manifest: ApiSchema7825,
  codeCitations: ApiSchema1655,
  consolidation: Schema.optionalKey(Schema.Undefined),
  reviewId: Schema.String,
  approvalDigest: Schema.String,
  targetUri: Schema.String,
  content: Schema.String,
  approvedAt: Schema.String,
  beforeContent: Schema.String,
  beforeContentHash: Schema.String,
  contentHash: Schema.String,
  approvedProposal: ApiSchema7664,
  metadataDiff: ApiSchema9807,
});
const ApiSchema9797 = Schema.Struct({
  version: Schema.Literal(2),
  sourceKind: Schema.Literal('obsidian'),
  preview: ApiSchema9815,
  reviewRevision: Schema.Finite,
  stage: ApiSchema7780,
});
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
const ApiSchema7806 = Schema.Union([Schema.Literal('MEMORY'), Schema.Literal('HANDOFF')]);
const ApiSchema7819 = Schema.Struct({
  version: Schema.Literal(1),
  memoryId: Schema.String,
  repositoryId: Schema.String,
  bodyHash: Schema.String,
  coverage: Schema.Literal('declared-only'),
  paragraphs: ApiSchema7831,
  additionalDependencies: ApiSchema7833,
});
const ApiSchema7827 = Schema.Union([Schema.Undefined, ApiSchema7819, ApiSchema7820, ApiSchema7822, ApiSchema7825]);
const ApiSchema7861 = Schema.Union([Schema.Undefined, ApiSchema7352, ApiSchema7859]);
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
const ApiSchema9832 = Schema.Struct({
  version: Schema.Literal(3),
  kind: Schema.Literal('automatic'),
  approvedProposal: ApiSchema7662,
  reviewedSupport: ApiSchema7783,
  reviewId: Schema.String,
  approvalDigest: Schema.String,
  targetUri: Schema.String,
  content: Schema.String,
  approvedAt: Schema.String,
  beforeContent: Schema.String,
  beforeContentHash: Schema.String,
  contentHash: Schema.String,
  metadataDiff: ApiSchema9807,
});
const ApiSchema9799 = Schema.Struct({
  version: Schema.Literal(3),
  kind: Schema.Literal('automatic'),
  preview: ApiSchema9832,
  reviewRevision: Schema.Finite,
  stage: ApiSchema7780,
});
const ApiSchema9802 = Schema.Union([Schema.Undefined, ApiSchema9796, ApiSchema9797, ApiSchema9799]);
const ApiSchema9839 = Schema.Struct({
  version: Schema.Literal(1),
  reviewRevision: Schema.Finite,
  targetUri: Schema.String,
  beforeContentHash: Schema.String,
  contentHash: Schema.String,
  approvalDigest: Schema.String,
});
const ApiSchema9840 = Schema.Union([Schema.Undefined, ApiSchema9839]);
const ApiSchema9841 = Schema.Union([Schema.Literal(2), Schema.Literal(5), Schema.Literal(4), Schema.Literal(3)]);
const ApiSchema9844 = Schema.Union([
  Schema.Literal('superseded'),
  Schema.Literal('preview'),
  Schema.Literal('conflict'),
  Schema.Literal('prepared'),
  Schema.Literal('written'),
]);
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
const ApiSchema4827 = Schema.Union([
  Schema.Literal('declared'),
  Schema.Literal('heuristic'),
  Schema.Literal('model'),
  Schema.Literal('resolved'),
  Schema.Literal('syntactic'),
]);
const ApiSchema4828 = Schema.Array(ApiSchema4827);
const ApiSchema4702 = Schema.Union([Schema.Literal('both'), Schema.Literal('incoming'), Schema.Literal('outgoing')]);
const ApiSchema9847 = Schema.Struct({
  kinds: ApiSchema4790,
  project: Schema.String,
  version: Schema.Literal(1),
  depth: Schema.Literal(1),
  root: Schema.String,
  configDigest: Schema.String,
  seeds: ApiSchema279,
  provenances: ApiSchema4828,
  minConfidence: Schema.Finite,
  nodeLimit: Schema.Finite,
  edgeLimit: Schema.Finite,
  selectedNodeIds: ApiSchema279,
  configurationPaths: ApiSchema279,
  direction: ApiSchema4702,
});
const ApiSchema10065 = Schema.Struct({
  id: Schema.String,
  commit: Schema.String,
  graphContentId: Schema.String,
  extractorSet: Schema.String,
});
const ApiSchema9893 = Schema.Struct({id: Schema.String, path: Schema.String, contentHash: Schema.String});
const ApiSchema9895 = Schema.Array(ApiSchema9893);
const ApiSchema9932 = Schema.Struct({
  id: Schema.String,
  sourceId: Schema.String,
  targetId: Schema.String,
  kind: ApiSchema4789,
  provenance: ApiSchema4827,
  confidence: Schema.Finite,
});
const ApiSchema9934 = Schema.Array(ApiSchema9932);
const ApiSchema10074 = Schema.Struct({
  status: Schema.Literal('exhaustive'),
  limitsReached: ApiSchema279,
  requestedDepth: Schema.Literal(1),
  completedDepth: Schema.Literal(1),
  direction: ApiSchema4702,
  nodeLimit: Schema.Finite,
  edgeLimit: Schema.Finite,
  allowedProvenances: ApiSchema4828,
  omittedNodes: Schema.Literal(0),
  missingNodes: Schema.Literal(0),
  unresolvedEdges: Schema.Literal(0),
  visitedNodes: Schema.Finite,
  inspectedEdges: Schema.Finite,
});
const ApiSchema10024 = Schema.Struct({
  seedId: Schema.String,
  nodes: ApiSchema9895,
  edges: ApiSchema9934,
  coverage: ApiSchema10074,
});
const ApiSchema10026 = Schema.Array(ApiSchema10024);
const ApiSchema10056 = Schema.Struct({
  version: Schema.Literal(1),
  repositoryId: Schema.String,
  worktreeId: Schema.String,
  sourceCommit: Schema.String,
  sourceFenceDigest: Schema.String,
  project: Schema.String,
  root: Schema.String,
  configDigest: Schema.String,
  snapshot: ApiSchema10065,
  profileDigest: Schema.String,
  scopeDigest: Schema.String,
  scopeReceiptJson: Schema.String,
  completeProject: Schema.Literal(true),
  reads: ApiSchema10026,
});
const ApiSchema10076 = Schema.Struct({kind: ApiSchema7940, ref: Schema.String, citation: ApiSchema7714});
const ApiSchema10077 = Schema.Array(ApiSchema10076);
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
const ApiSchema10078 = Schema.Struct({field: Schema.String, beforeHash: Schema.String, afterHash: Schema.String});
const ApiSchema10079 = Schema.Array(ApiSchema10078);
const ApiSchema9845 = Schema.Struct({
  version: Schema.Literal(1),
  targetUri: Schema.String,
  callerCwd: Schema.String,
  beforeContent: Schema.String,
  beforeContentHash: Schema.String,
  previousManifestHash: Schema.String,
  operation: Schema.optionalKey(ApiSchema7988),
  input: ApiSchema9847,
  proof: ApiSchema10056,
  proofDigest: Schema.String,
  revision: Schema.String,
  approvalDigest: Schema.String,
  additions: ApiSchema10077,
  omissions: ApiSchema7948,
  manifest: ApiSchema7822,
  content: Schema.String,
  contentHash: Schema.String,
  metadataDiff: ApiSchema10079,
});
const ApiSchema10080 = Schema.Struct({
  operation: ApiSchema7986,
  revision: Schema.String,
  approvalDigest: Schema.String,
  createdAt: Schema.String,
});
const ApiSchema10081 = Schema.Union([Schema.Undefined, ApiSchema10080]);
const ApiSchema9842 = Schema.Struct({
  version: Schema.Literal(1),
  stage: ApiSchema9844,
  preview: ApiSchema9845,
  successor: Schema.optionalKey(ApiSchema10081),
});
const ApiSchema9843 = Schema.Union([Schema.Undefined, ApiSchema9842]);
const ApiSchema6273 = Schema.Struct({
  auditEvents: ApiSchema9089,
  candidates: ApiSchema6325,
  codeCitations: ApiSchema7807,
  createdAt: Schema.String,
  outcome: Schema.optionalKey(ApiSchema320),
  project: Schema.String,
  reviewId: Schema.String,
  revision: Schema.Finite,
  sourceAgentClient: Schema.optionalKey(ApiSchema320),
  sourceCommit: Schema.optionalKey(ApiSchema320),
  sourceSessionId: Schema.optionalKey(ApiSchema320),
  structuredCloseout: Schema.optionalKey(ApiSchema9126),
  maintenance: Schema.optionalKey(ApiSchema9133),
  maintenanceCapture: Schema.optionalKey(ApiSchema9788),
  maintenanceApproval: Schema.optionalKey(ApiSchema9802),
  maintenanceClosedConflict: Schema.optionalKey(ApiSchema9840),
  task: Schema.String,
  topic: Schema.String,
  version: ApiSchema9841,
  dependencyExpansion: Schema.optionalKey(ApiSchema9843),
});
const ApiSchema6417 = Schema.Union([
  Schema.Literal('create'),
  Schema.Literal('replace'),
  Schema.Literal('no_action'),
  Schema.Literal('requires_explicit_operation'),
]);
const ApiSchema6438 = Schema.Union([Schema.Literal('destructive-loss-risk'), Schema.Literal('preserving')]);
const ApiSchema6430 = Schema.Struct({
  destructiveLossRisk: Schema.Boolean,
  missingSections: ApiSchema279,
  proposedBodyCharacters: Schema.Finite,
  proposedNonEmptyLines: Schema.Finite,
  retainedCharacterRatio: Schema.Finite,
  retainedLineRatio: Schema.Finite,
  targetBodyCharacters: Schema.Finite,
  targetNonEmptyLines: Schema.Finite,
  acknowledged: Schema.Boolean,
  classification: ApiSchema6438,
  requiresExplicitApproval: Schema.Boolean,
  sectionListTruncated: Schema.Boolean,
  warning: Schema.optionalKey(ApiSchema320),
});
const ApiSchema6431 = Schema.Struct({
  acknowledged: Schema.Literal(false),
  classification: Schema.Literal('review-required'),
  requiresExplicitApproval: Schema.Literal(true),
  sectionListTruncated: Schema.Literal(false),
  warning: Schema.String,
});
const ApiSchema6433 = Schema.Union([Schema.Undefined, ApiSchema6430, ApiSchema6431]);
const ApiSchema6411 = Schema.Struct({
  bodyText: Schema.String,
  expectedTargetContentHash: Schema.optionalKey(ApiSchema320),
  operation: ApiSchema6417,
  replacementSafety: Schema.optionalKey(ApiSchema6433),
  replaceUri: Schema.optionalKey(ApiSchema320),
  truncated: Schema.Boolean,
});
const ApiSchema10082 = Schema.Struct({
  kind: ApiSchema9124,
  project: Schema.String,
  targetUri: Schema.optionalKey(ApiSchema320),
  topic: Schema.String,
});
const ApiSchema10089 = Schema.Union([
  Schema.Literal('preference'),
  Schema.Literal('context-repair-or-retirement'),
  Schema.Literal('decision-or-invariant'),
  Schema.Literal('handoff-state'),
]);
const ApiSchema6369 = Schema.Struct({
  candidateId: Schema.String,
  comparison: ApiSchema9117,
  comparisonReason: Schema.String,
  confidence: Schema.Finite,
  mutationPreview: ApiSchema6411,
  proposedDestination: ApiSchema10082,
  recommendation: ApiSchema9120,
  sourceEvidence: ApiSchema279,
  state: ApiSchema9123,
  truncated: Schema.Boolean,
  type: ApiSchema10089,
});
const ApiSchema6370 = Schema.Array(ApiSchema6369);
const ApiSchema6367 = Schema.Struct({
  items: ApiSchema6370,
  noAction: Schema.Boolean,
  reviewId: Schema.String,
  revision: Schema.Finite,
  structuredCloseout: Schema.optionalKey(ApiSchema9126),
  type: Schema.Literal('knowledge-delta'),
  version: Schema.Literal(1),
});
const ApiSchema6254 = Schema.Struct({review: ApiSchema6273, delta: ApiSchema6367});

export const isOutputResponse2 = Schema.is(ApiSchema6121);
export const isPreviewResponse = Schema.is(ApiSchema6193);
export const isResultResponse = Schema.is(ApiSchema6227);
export const isReviewPreview = Schema.is(ApiSchema6254);
