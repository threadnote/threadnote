import {Schema} from 'effect';

const ApiSchema320 = Schema.Union([Schema.Undefined, Schema.String]);
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
const ApiSchema10093 = Schema.Union([Schema.Undefined, ApiSchema7714]);
const ApiSchema10092 = Schema.Struct({
  kind: Schema.String,
  citationId: Schema.optionalKey(ApiSchema320),
  reason: Schema.optionalKey(ApiSchema320),
  replacement: Schema.optionalKey(ApiSchema10093),
  subjectUri: Schema.optionalKey(ApiSchema320),
  targetUri: Schema.optionalKey(ApiSchema320),
});
const ApiSchema6543 = Schema.Struct({
  findingCategory: Schema.optionalKey(ApiSchema320),
  after: Schema.optionalKey(ApiSchema320),
  topic: Schema.optionalKey(ApiSchema320),
  kind: Schema.optionalKey(ApiSchema320),
});
const ApiSchema6544 = Schema.Union([Schema.Undefined, ApiSchema6543]);
const ApiSchema10094 = Schema.Struct({uri: Schema.String, expectedContentHash: Schema.String});
const ApiSchema10095 = Schema.Array(ApiSchema10094);
const ApiSchema6453 = Schema.Struct({
  proposalId: Schema.String,
  revision: Schema.String,
  summary: Schema.String,
  mutation: ApiSchema10092,
  selector: Schema.optionalKey(ApiSchema6544),
  preconditions: ApiSchema10095,
});
const ApiSchema6454 = Schema.Struct({proposal: ApiSchema6453});
const ApiSchema6527 = Schema.Struct({status: Schema.String});
const ApiSchema109 = Schema.Union([Schema.Undefined, Schema.Finite]);
const ApiSchema10097 = Schema.Union([
  Schema.Literal('complete'),
  Schema.Literal('partial'),
  Schema.Literal('unavailable'),
]);
const ApiSchema10098 = Schema.Struct({reason: Schema.String, count: Schema.Finite});
const ApiSchema10099 = Schema.Array(ApiSchema10098);
const ApiSchema10096 = Schema.Struct({
  eligible: Schema.Finite,
  checked: Schema.Finite,
  pending: Schema.optionalKey(ApiSchema109),
  unavailable: Schema.optionalKey(ApiSchema109),
  deferred: Schema.Finite,
  currentVerified: Schema.Finite,
  historicalVerified: Schema.Finite,
  unverified: Schema.Finite,
  state: ApiSchema10097,
  reasons: ApiSchema10099,
});
const ApiSchema10120 = Schema.Union([
  Schema.Literal('body-limit'),
  Schema.Literal('claim-budget'),
  Schema.Literal('claim-limit'),
  Schema.Literal('claim-too-large'),
  Schema.Literal('contradiction-limit'),
  Schema.Literal('no-claims'),
  Schema.Literal('record-limit'),
  Schema.Literal('unsupported-extraction'),
]);
const ApiSchema10102 = Schema.Struct({count: Schema.Finite, reason: ApiSchema10120});
const ApiSchema10103 = Schema.Array(ApiSchema10102);
const ApiSchema6906 = Schema.Struct({
  analyzedRecords: Schema.Finite,
  claimsAnalyzed: Schema.Finite,
  supportedClaims: Schema.Finite,
  unsupportedClaims: Schema.Finite,
  coverage: Schema.Literal('bounded-English-extraction'),
  contradictionCount: Schema.Finite,
  eligibleRecords: Schema.Finite,
  omittedContradictions: Schema.Finite,
  pairsCompared: Schema.Finite,
  state: ApiSchema10097,
  unknownReasons: ApiSchema10103,
  unknownRecords: Schema.Finite,
  version: Schema.Literal(2),
});
const ApiSchema6904 = Schema.Struct({
  version: Schema.Literal(2),
  actionableFindings: Schema.Finite,
  automaticallyManagedFindings: Schema.Finite,
  historicalFindings: Schema.Finite,
  affectedMemories: Schema.Finite,
  citationCoverage: ApiSchema10096,
  semanticCoverage: ApiSchema6906,
});
const ApiSchema6905 = Schema.Union([Schema.Undefined, ApiSchema6904]);
const ApiSchema10121 = Schema.Struct({
  project: Schema.String,
  memoryId: Schema.String,
  family: Schema.String,
  slot: Schema.String,
});
const ApiSchema10122 = Schema.Union([Schema.Undefined, ApiSchema10121]);
const ApiSchema10128 = Schema.Union([
  Schema.Undefined,
  Schema.Literal('historical'),
  Schema.Literal('coverage'),
  Schema.Literal('actionable'),
  Schema.Literal('automatically-managed'),
]);
const ApiSchema6524 = Schema.Union([
  Schema.Literal('candidate-contradiction'),
  Schema.Literal('candidate-possible-duplicate'),
  Schema.Literal('citation-changed'),
  Schema.Literal('citation-missing'),
  Schema.Literal('citation-unknown'),
  Schema.Literal('exact-duplicate'),
  Schema.Literal('guidance-locally-modified'),
  Schema.Literal('guidance-missing-block'),
  Schema.Literal('guidance-stale-sources'),
  Schema.Literal('guidance-unavailable'),
  Schema.Literal('relation-target-conflicted'),
  Schema.Literal('relation-target-inactive'),
  Schema.Literal('relation-target-missing'),
  Schema.Literal('review-overdue'),
  Schema.Literal('semantic-contradiction'),
  Schema.Literal('validity-expired'),
]);
const ApiSchema10129 = Schema.Union([Schema.Literal('high'), Schema.Literal('low'), Schema.Literal('medium')]);
const ApiSchema10144 = Schema.Union([
  Schema.Literal('archive-memory'),
  Schema.Literal('deduplicate-memory'),
  Schema.Literal('repair-guidance'),
  Schema.Literal('repair-citation'),
  Schema.Literal('repair-relation'),
  Schema.Literal('review-candidate'),
  Schema.Literal('review-memory'),
]);
const ApiSchema6482 = Schema.Struct({
  kind: ApiSchema10144,
  subjectUri: Schema.optionalKey(ApiSchema320),
  summary: Schema.String,
  targetUri: Schema.optionalKey(ApiSchema320),
});
const ApiSchema10151 = Schema.Union([
  Schema.Literal('manual-review'),
  Schema.Literal('requires-evidence'),
  Schema.Literal('reviewable'),
]);
const ApiSchema10152 = Schema.Struct({start: Schema.Finite, end: Schema.Finite});
const ApiSchema279 = Schema.Array(Schema.String);
const ApiSchema10156 = Schema.Struct({start: Schema.Finite, end: Schema.Finite});
const ApiSchema10154 = Schema.Struct({text: Schema.String, span: ApiSchema10156});
const ApiSchema10155 = Schema.Array(ApiSchema10154);
const ApiSchema10153 = Schema.Struct({
  headings: ApiSchema279,
  headingEvidence: ApiSchema10155,
  project: Schema.optionalKey(ApiSchema320),
  workspaceScope: Schema.optionalKey(ApiSchema320),
  environment: Schema.optionalKey(ApiSchema320),
  validFrom: Schema.optionalKey(ApiSchema320),
  validTo: Schema.optionalKey(ApiSchema320),
});
const ApiSchema8141 = Schema.Union([
  Schema.Literal('descriptive'),
  Schema.Literal('normative'),
  Schema.Literal('historical'),
]);
const ApiSchema10163 = Schema.Union([
  Schema.Literal('unsupported'),
  Schema.Literal('numeric-constraint'),
  Schema.Literal('finite-set'),
  Schema.Literal('explicit-polarity'),
]);
const ApiSchema7773 = Schema.Union([Schema.Null, Schema.Finite]);
const ApiSchema10164 = Schema.Struct({
  kind: Schema.Literal('numeric'),
  dimension: Schema.String,
  lower: ApiSchema7773,
  upper: ApiSchema7773,
  lowerInclusive: Schema.Boolean,
  upperInclusive: Schema.Boolean,
});
const ApiSchema10165 = Schema.Struct({kind: Schema.Literal('set'), values: ApiSchema279});
const ApiSchema10166 = Schema.Struct({kind: Schema.Literal('polarity'), denied: Schema.Boolean});
const ApiSchema10168 = Schema.Union([Schema.Undefined, ApiSchema10164, ApiSchema10165, ApiSchema10166]);
const ApiSchema6202 = Schema.Struct({
  claimFingerprint: Schema.String,
  claimId: Schema.String,
  recordUri: Schema.String,
  recordContentFingerprint: Schema.String,
  text: Schema.String,
  span: ApiSchema10152,
  context: ApiSchema10153,
  role: ApiSchema8141,
  extraction: ApiSchema10163,
  subject: Schema.optionalKey(ApiSchema320),
  property: Schema.optionalKey(ApiSchema320),
  constraint: Schema.optionalKey(ApiSchema10168),
});
const ApiSchema6572 = Schema.Union([Schema.Literal('incompatibility'), Schema.Literal('uncertain-comparison')]);
const ApiSchema6581 = Schema.Union([
  Schema.Literal('incompatible-values'),
  Schema.Literal('opposite-polarity'),
  Schema.Literal('policy-conflict'),
  Schema.Literal('unsupported-interpretation'),
]);
const ApiSchema6200 = Schema.Struct({
  basisFingerprint: Schema.String,
  contradictionId: Schema.String,
  left: ApiSchema6202,
  right: ApiSchema6202,
  similarityMilli: Schema.Finite,
  classification: ApiSchema6572,
  reason: ApiSchema6581,
  uncertainty: ApiSchema279,
});
const ApiSchema6556 = Schema.Union([Schema.Undefined, ApiSchema6200]);
const ApiSchema10177 = Schema.Union([
  Schema.Literal('high'),
  Schema.Literal('low'),
  Schema.Literal('medium'),
  Schema.Literal('critical'),
]);
const ApiSchema6468 = Schema.Struct({
  caseId: Schema.optionalKey(ApiSchema320),
  caseIdentity: Schema.optionalKey(ApiSchema10122),
  classification: Schema.optionalKey(ApiSchema10128),
  category: ApiSchema6524,
  confidence: ApiSchema10129,
  id: Schema.String,
  repair: ApiSchema6482,
  repairability: ApiSchema10151,
  semanticEvidence: Schema.optionalKey(ApiSchema6556),
  severity: ApiSchema10177,
  summary: Schema.String,
  uris: ApiSchema279,
});
const ApiSchema6469 = Schema.Array(ApiSchema6468);
const ApiSchema6911 = Schema.Union([Schema.Literal('findings'), Schema.Literal('clean'), Schema.Literal('unknown')]);
const ApiSchema10186 = Schema.Union([
  Schema.Literal('unavailable'),
  Schema.Literal('available'),
  Schema.Literal('ambiguous'),
]);
const ApiSchema9151 = Schema.Union([Schema.Literal('historical-verified'), Schema.Literal('current-verified')]);
const ApiSchema10189 = Schema.Struct({
  path: Schema.String,
  sourceCommit: Schema.String,
  sourceSnapshotId: Schema.String,
});
const ApiSchema10187 = Schema.Struct({
  content: Schema.String,
  startLine: Schema.Finite,
  endLine: Schema.Finite,
  excerptHash: Schema.String,
  fileBytesHash: Schema.String,
  provenance: ApiSchema9151,
  supportsCitation: Schema.Boolean,
  source: ApiSchema10189,
});
const ApiSchema10188 = Schema.Array(ApiSchema10187);
const ApiSchema10182 = Schema.Struct({
  coverage: ApiSchema10186,
  generation: Schema.String,
  attemptedSteps: ApiSchema279,
  excerpts: ApiSchema10188,
});
const ApiSchema10183 = Schema.Union([Schema.Undefined, ApiSchema10182]);
const ApiSchema10180 = Schema.Struct({
  citationId: Schema.String,
  excerpt: Schema.optionalKey(ApiSchema320),
  findingIds: ApiSchema279,
  line: Schema.optionalKey(ApiSchema109),
  path: Schema.String,
  targetLabel: Schema.optionalKey(ApiSchema320),
  evidence: Schema.optionalKey(ApiSchema10183),
});
const ApiSchema10181 = Schema.Array(ApiSchema10180);
const ApiSchema596 = Schema.Union([
  Schema.Literal('durable'),
  Schema.Literal('handoff'),
  Schema.Literal('incident'),
  Schema.Literal('preference'),
  Schema.Literal('smoke'),
]);
const ApiSchema10178 = Schema.Struct({
  contentHash: Schema.optionalKey(ApiSchema320),
  code: ApiSchema10181,
  excerpt: Schema.String,
  kind: ApiSchema596,
  title: Schema.String,
  topic: Schema.optionalKey(ApiSchema320),
  uri: Schema.String,
});
const ApiSchema10179 = Schema.Array(ApiSchema10178);
const ApiSchema10190 = Schema.Struct({state: Schema.Literal('available')});
const ApiSchema10199 = Schema.Union([
  Schema.Literal('repository-unavailable'),
  Schema.Literal('foreign-host'),
  Schema.Literal('manifest-unavailable'),
  Schema.Literal('project-not-configured'),
]);
const ApiSchema10191 = Schema.Struct({reason: ApiSchema10199, state: Schema.Literal('unavailable')});
const ApiSchema10192 = Schema.Union([ApiSchema10190, ApiSchema10191]);
const ApiSchema6465 = Schema.Struct({
  maintenance: Schema.optionalKey(ApiSchema6905),
  findings: ApiSchema6469,
  limit: Schema.Finite,
  omittedFindings: Schema.Finite,
  nextCursor: Schema.optionalKey(ApiSchema320),
  project: Schema.String,
  recordsScanned: Schema.Finite,
  remainingFindings: Schema.optionalKey(ApiSchema109),
  semanticCompleteness: ApiSchema6906,
  status: ApiSchema6911,
  version: Schema.Literal(1),
  recordPreviews: ApiSchema10179,
  repositoryEvidence: ApiSchema10192,
});
const ApiSchema6550 = Schema.Struct({outcome: Schema.Literal('ready'), evidence: ApiSchema6200});
const ApiSchema10202 = Schema.Union([
  Schema.Literal('superseded'),
  Schema.Literal('unavailable'),
  Schema.Literal('incomplete'),
  Schema.Literal('changing'),
]);
const ApiSchema6551 = Schema.Struct({outcome: ApiSchema10202, reason: Schema.String});
const ApiSchema6552 = Schema.Union([ApiSchema6550, ApiSchema6551]);
const ApiSchema10203 = Schema.Union([Schema.Literal('resolved'), Schema.Literal('ready')]);
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
const ApiSchema10221 = Schema.Struct({path: Schema.String, citationId: Schema.String, status: Schema.String});
const ApiSchema10222 = Schema.Union([Schema.Undefined, ApiSchema10221]);
const ApiSchema6481 = Schema.Union([Schema.Undefined, ApiSchema6468]);
const ApiSchema10223 = Schema.Union([Schema.Undefined, Schema.Literal('declared-only')]);
const ApiSchema8417 = Schema.Union([Schema.Literal('ready'), Schema.Literal('unavailable')]);
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
const ApiSchema10224 = Schema.Union([Schema.Undefined, ApiSchema7831]);
const ApiSchema7838 = Schema.Union([Schema.Literal('configuration'), Schema.Literal('dependency')]);
const ApiSchema7832 = Schema.Struct({kind: ApiSchema7838, citationId: Schema.String});
const ApiSchema7833 = Schema.Array(ApiSchema7832);
const ApiSchema10225 = Schema.Union([Schema.Undefined, ApiSchema7833]);
const ApiSchema8102 = Schema.Union([
  Schema.Literal('unknown'),
  Schema.Literal('changed'),
  Schema.Literal('exact'),
  Schema.Literal('relocated'),
  Schema.Literal('deleted'),
]);
const ApiSchema10231 = Schema.Struct({
  extractorSet: Schema.String,
  fileContentHash: Schema.String,
  path: Schema.String,
  repositoryId: Schema.String,
  sourceCommit: Schema.String,
  sourceDirty: Schema.Boolean,
  sourceSnapshotId: Schema.String,
});
const ApiSchema10230 = Schema.Struct({
  content: Schema.String,
  endLine: Schema.Finite,
  excerptHash: Schema.String,
  fileBytesHash: Schema.String,
  provenance: ApiSchema9151,
  source: ApiSchema10231,
  startLine: Schema.Finite,
  supportsCitation: Schema.Boolean,
  truncated: Schema.Boolean,
});
const ApiSchema10226 = Schema.Struct({
  citationId: Schema.String,
  status: ApiSchema8102,
  original: ApiSchema7714,
  current: ApiSchema7714,
  oldExcerpt: ApiSchema10230,
  newExcerpt: ApiSchema10230,
});
const ApiSchema10227 = Schema.Array(ApiSchema10226);
const ApiSchema10228 = Schema.Union([Schema.Undefined, ApiSchema10227]);
const ApiSchema6689 = Schema.Struct({
  version: Schema.Literal(1),
  outcome: ApiSchema8417,
  targetUri: Schema.String,
  targetHash: Schema.String,
  observationRevision: Schema.String,
  coverage: Schema.Literal('declared-only'),
  reason: Schema.optionalKey(ApiSchema320),
  body: Schema.optionalKey(ApiSchema320),
  paragraphs: Schema.optionalKey(ApiSchema10224),
  additionalDependencies: Schema.optionalKey(ApiSchema10225),
  sources: Schema.optionalKey(ApiSchema10228),
  truncatedExcerpts: Schema.optionalKey(ApiSchema109),
});
const ApiSchema1655 = Schema.Tuple([]);
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
const ApiSchema10234 = Schema.Union([
  Schema.Literal('expired'),
  Schema.Literal('missing'),
  Schema.Literal('available'),
  Schema.Literal('revoked'),
  Schema.Literal('corrupt'),
]);
const ApiSchema10237 = Schema.Union([
  Schema.Literal('removed'),
  Schema.Literal('unknown'),
  Schema.Literal('changed'),
  Schema.Literal('same'),
]);
const ApiSchema10232 = Schema.Struct({
  citation: ApiSchema7734,
  historical: ApiSchema10234,
  currentRevision: ApiSchema10237,
  fragment: Schema.optionalKey(ApiSchema320),
});
const ApiSchema10233 = Schema.Union([Schema.Undefined, ApiSchema10232]);
const ApiSchema6695 = Schema.Struct({
  sourceId: Schema.String,
  sourceInstanceId: Schema.String,
  noteId: Schema.String,
  relativePath: Schema.String,
  revisionHash: Schema.String,
  sanitizerVersion: Schema.String,
  accessHash: Schema.String,
  vaultHash: Schema.String,
  inspectionDigest: Schema.String,
  content: Schema.String,
  startOffset: Schema.Literal(0),
  endOffset: Schema.Finite,
  truncated: Schema.Boolean,
});
const ApiSchema6696 = Schema.Union([Schema.Undefined, ApiSchema6695]);
const ApiSchema9793 = Schema.Union([Schema.Literal('reserved'), Schema.Literal('captured')]);
const ApiSchema7879 = Schema.Union([Schema.Undefined, ApiSchema7734]);
const ApiSchema10238 = Schema.Struct({
  reviewId: Schema.String,
  revision: Schema.Finite,
  state: ApiSchema9793,
  citation: Schema.optionalKey(ApiSchema7879),
  fragment: Schema.optionalKey(ApiSchema320),
});
const ApiSchema10239 = Schema.Union([Schema.Undefined, ApiSchema10238]);
const ApiSchema6694 = Schema.Struct({
  origin: Schema.optionalKey(ApiSchema10233),
  active: Schema.optionalKey(ApiSchema10233),
  current: Schema.optionalKey(ApiSchema6696),
  capture: Schema.optionalKey(ApiSchema10239),
});
const ApiSchema6690 = Schema.Struct({
  version: Schema.Literal(2),
  sourceKind: Schema.Literal('obsidian'),
  outcome: ApiSchema8417,
  targetUri: Schema.String,
  targetHash: Schema.String,
  observationRevision: Schema.String,
  coverage: Schema.Literal('declared-only'),
  canDraft: Schema.Boolean,
  reason: Schema.optionalKey(ApiSchema320),
  body: Schema.optionalKey(ApiSchema320),
  paragraphs: Schema.optionalKey(ApiSchema10224),
  additionalDependencies: ApiSchema1655,
  obsidian: ApiSchema6694,
});
const ApiSchema6692 = Schema.Union([Schema.Undefined, ApiSchema6689, ApiSchema6690]);
const ApiSchema10240 = Schema.Struct({
  caseId: Schema.String,
  memoryUri: Schema.String,
  citationId: Schema.String,
  anchorId: Schema.String,
});
const ApiSchema10241 = Schema.Array(ApiSchema10240);
const ApiSchema10242 = Schema.Union([Schema.Undefined, ApiSchema10241]);
const ApiSchema10247 = Schema.Struct({type: Schema.String, uri: Schema.String});
const ApiSchema10245 = Schema.Struct({operation: Schema.String, relation: ApiSchema10247});
const ApiSchema10246 = Schema.Array(ApiSchema10245);
const ApiSchema10248 = Schema.Struct({instructions: Schema.String});
const ApiSchema10243 = Schema.Struct({
  proposalRevision: Schema.String,
  expectedContentHash: Schema.String,
  selectedEdits: ApiSchema10246,
  omittedEdits: Schema.Finite,
  publication: ApiSchema10248,
});
const ApiSchema10244 = Schema.Union([Schema.Undefined, ApiSchema10243]);
const ApiSchema6639 = Schema.Struct({
  reference: Schema.optionalKey(ApiSchema10222),
  repairFinding: Schema.optionalKey(ApiSchema6481),
  reviewId: Schema.optionalKey(ApiSchema320),
  coverage: Schema.optionalKey(ApiSchema10223),
  topicEvidence: Schema.optionalKey(ApiSchema6692),
  version: Schema.Literal(2),
  caseId: Schema.String,
  project: Schema.String,
  family: Schema.optionalKey(ApiSchema320),
  slot: Schema.optionalKey(ApiSchema320),
  callerCwd: Schema.optionalKey(ApiSchema320),
  memoryUri: Schema.optionalKey(ApiSchema320),
  evidenceRevision: Schema.String,
  expectedContentHash: Schema.String,
  reason: Schema.String,
  choices: ApiSchema279,
  allowedOperations: ApiSchema279,
  instructions: Schema.String,
  semanticEvidence: Schema.optionalKey(ApiSchema6556),
  evidence: Schema.optionalKey(ApiSchema10183),
  evidenceSelectors: Schema.optionalKey(ApiSchema10242),
  omittedEvidenceSelectors: Schema.optionalKey(ApiSchema109),
  ownerProposal: Schema.optionalKey(ApiSchema10244),
});
const ApiSchema6588 = Schema.Struct({outcome: ApiSchema10203, item: ApiSchema10204, packet: ApiSchema6639});
const ApiSchema10249 = Schema.Union([Schema.Undefined, ApiSchema10204]);
const ApiSchema6589 = Schema.Struct({
  outcome: ApiSchema10202,
  reason: Schema.String,
  item: Schema.optionalKey(ApiSchema10249),
});
const ApiSchema6590 = Schema.Union([ApiSchema6588, ApiSchema6589]);
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
const ApiSchema4114 = Schema.Union([
  Schema.Literal('pending'),
  Schema.Literal('deferred'),
  Schema.Literal('rejected'),
  Schema.Literal('applying'),
  Schema.Literal('applied'),
  Schema.Literal('conflict'),
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
const ApiSchema6653 = Schema.Union([Schema.Undefined, Schema.Literal('code'), Schema.Literal('obsidian')]);
const ApiSchema555 = Schema.Union([Schema.Undefined, ApiSchema279]);
const ApiSchema10252 = Schema.Union([
  Schema.Literal('complete'),
  Schema.Literal('legacy'),
  Schema.Literal('incomplete'),
]);
const ApiSchema7706 = Schema.Array(Schema.Finite);
const ApiSchema10250 = Schema.Struct({
  status: ApiSchema10252,
  eligibleCount: Schema.Finite,
  dispositionCount: Schema.Finite,
  resolvedCount: Schema.Finite,
  missingOrdinals: ApiSchema7706,
  unresolvedOrdinals: ApiSchema7706,
});
const ApiSchema10251 = Schema.Union([Schema.Undefined, ApiSchema10250]);
const ApiSchema10254 = Schema.Union([Schema.Literal('manual'), Schema.Literal('model')]);
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
const ApiSchema6693 = Schema.Union([Schema.Literal(1), Schema.Literal(2)]);
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
const ApiSchema10255 = Schema.Struct({status: Schema.Literal('unavailable')});
const ApiSchema10256 = Schema.Struct({
  status: Schema.Literal('measured'),
  inputTokens: Schema.Finite,
  outputTokens: Schema.Finite,
});
const ApiSchema10257 = Schema.Union([ApiSchema10255, ApiSchema10256]);
const ApiSchema10253 = Schema.Struct({
  origin: ApiSchema10254,
  observation: Schema.optionalKey(ApiSchema9651),
  agent: Schema.String,
  model: Schema.String,
  attempts: Schema.Finite,
  usage: ApiSchema10257,
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
const ApiSchema10258 = Schema.Struct({
  body: Schema.String,
  finalBodyHash: Schema.String,
  changedOrdinals: ApiSchema7706,
});
const ApiSchema9137 = Schema.Union([Schema.Literal('historical'), Schema.Literal('current')]);
const ApiSchema10259 = Schema.Struct({
  handleId: Schema.String,
  citationId: Schema.String,
  variant: ApiSchema9137,
  path: Schema.String,
  provenance: ApiSchema9151,
});
const ApiSchema10260 = Schema.Array(ApiSchema10259);
const ApiSchema7780 = Schema.Union([
  Schema.Literal('preview'),
  Schema.Literal('conflict'),
  Schema.Literal('parked'),
  Schema.Literal('prepared'),
  Schema.Literal('written'),
]);
const ApiSchema10263 = Schema.Struct({field: Schema.String, beforeHash: Schema.String, afterHash: Schema.String});
const ApiSchema10264 = Schema.Array(ApiSchema10263);
const ApiSchema10261 = Schema.Struct({
  stage: ApiSchema7780,
  reviewRevision: Schema.Finite,
  approvalDigest: Schema.String,
  content: Schema.String,
  contentHash: Schema.String,
  metadataDiff: ApiSchema10264,
});
const ApiSchema10262 = Schema.Union([Schema.Undefined, ApiSchema10261]);
const ApiSchema256 = Schema.Union([Schema.Undefined, Schema.Literal(false), Schema.Literal(true)]);
const ApiSchema4099 = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal('topic-maintenance'),
  sourceKind: Schema.optionalKey(ApiSchema6653),
  project: Schema.String,
  reviewId: Schema.String,
  revision: Schema.Finite,
  state: ApiSchema4114,
  topic: Schema.String,
  caseId: Schema.optionalKey(ApiSchema320),
  caseObservationMatches: Schema.Boolean,
  targetUri: Schema.String,
  targetHash: Schema.String,
  acceptedBody: Schema.String,
  observationRevision: Schema.String,
  resolvedCitationIds: Schema.optionalKey(ApiSchema555),
  coverage: Schema.Literal('declared-only'),
  paragraphCoverage: Schema.optionalKey(ApiSchema10251),
  generation: ApiSchema10253,
  draft: ApiSchema7677,
  proposal: ApiSchema10258,
  paragraphs: ApiSchema7831,
  additionalDependencies: ApiSchema7833,
  support: ApiSchema10260,
  warnings: ApiSchema279,
  approval: Schema.optionalKey(ApiSchema10262),
  canApply: Schema.Boolean,
  canFinishVerification: Schema.optionalKey(ApiSchema256),
  blockingReason: Schema.optionalKey(ApiSchema320),
});
const ApiSchema6599 = Schema.Union([ApiSchema4057, ApiSchema4099]);
const ApiSchema10265 = Schema.Union([
  Schema.Literal('running'),
  Schema.Literal('failed'),
  Schema.Literal('idle'),
  Schema.Literal('waiting-evidence'),
  Schema.Literal('needs-decision'),
]);
const ApiSchema8261 = Schema.Union([Schema.Literal('complete'), Schema.Literal('partial')]);
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

export const isProposalResponse = Schema.is(ApiSchema6454);
export const isStatusResponse2 = Schema.is(ApiSchema6527);
export const isManagerContextHealthResponseV1 = Schema.is(ApiSchema6465);
export const isManagerSemanticRefreshResultV1 = Schema.is(ApiSchema6552);
export const isManagerMaintenanceRefreshResultV1 = Schema.is(ApiSchema6590);
export const isManagerTopicReviewRecoveryV1OrManagerTopicReviewV1 = Schema.is(ApiSchema6599);
export const isManagerContextMaintenancePacketV2 = Schema.is(ApiSchema6639);
export const isManagerContextMaintenanceStatusV2 = Schema.is(ApiSchema6710);
