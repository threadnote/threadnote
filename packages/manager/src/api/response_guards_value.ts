import {Schema} from 'effect';

const ApiSchema320 = Schema.Union([Schema.Undefined, Schema.String]);
const ApiSchema279 = Schema.Array(Schema.String);
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
const ApiSchema11224 = Schema.Union([Schema.Undefined, ApiSchema7863]);
const ApiSchema7908 = Schema.Union([Schema.Literal('running'), Schema.Literal('completed'), Schema.Literal('failed')]);
const ApiSchema7213 = Schema.Struct({
  sources: Schema.optionalKey(ApiSchema11224),
  agent: Schema.String,
  model: Schema.optionalKey(ApiSchema320),
  draft: Schema.optionalKey(ApiSchema320),
  error: Schema.optionalKey(ApiSchema320),
  id: Schema.String,
  sourceUris: ApiSchema279,
  status: ApiSchema7908,
});
const ApiSchema7214 = Schema.Struct({job: ApiSchema7213});
const ApiSchema11227 = Schema.Union([Schema.Literal('enrolled'), Schema.Literal('not-enrolled')]);
const ApiSchema7486 = Schema.Struct({id: Schema.String, relativePath: Schema.String});
const ApiSchema7414 = Schema.Struct({
  status: ApiSchema11227,
  sourceKind: Schema.Literal('obsidian'),
  targetUri: Schema.String,
  project: Schema.String,
  contentHash: Schema.String,
  body: Schema.String,
  paragraphs: ApiSchema279,
  citation: ApiSchema7486,
});
const ApiSchema7417 = Schema.Struct({expectedContentHash: Schema.String, revision: Schema.String, body: Schema.String});
const ApiSchema7418 = Schema.Struct({
  status: Schema.Union([Schema.Literal('enrolled'), Schema.Literal('already-enrolled')]),
  targetUri: Schema.String,
});
const ApiSchema11228 = Schema.Struct({attempts: Schema.Finite, coverageGaps: Schema.Finite, successful: Schema.Finite});
const ApiSchema11229 = Schema.Struct({
  applied: Schema.Finite,
  dismiss: Schema.Finite,
  pin: Schema.Finite,
  total: Schema.Finite,
  useful: Schema.Finite,
  wrong: Schema.Finite,
});
const ApiSchema11230 = Schema.Struct({opened: Schema.Finite, resolved: Schema.Finite});
const ApiSchema11231 = Schema.Struct({
  approved: Schema.Finite,
  deferred: Schema.Finite,
  edited: Schema.Finite,
  proposed: Schema.Finite,
  rejected: Schema.Finite,
});
const ApiSchema11232 = Schema.Struct({from: Schema.String, to: Schema.String});
const ApiSchema11234 = Schema.Union([Schema.Literal('unavailable'), Schema.Literal('available')]);
const ApiSchema109 = Schema.Union([Schema.Undefined, Schema.Finite]);
const ApiSchema11233 = Schema.Struct({
  availability: ApiSchema11234,
  completed: Schema.Finite,
  supportedAgentReuse: Schema.Finite,
  timeToFirstEvidenceMilliseconds: Schema.optionalKey(ApiSchema109),
});
const ApiSchema7502 = Schema.Struct({
  contextBrief: ApiSchema11228,
  feedback: ApiSchema11229,
  health: ApiSchema11230,
  knowledgeDelta: ApiSchema11231,
  period: ApiSchema11232,
  setup: ApiSchema11233,
});
const ApiSchema11235 = Schema.Struct({removed: Schema.Finite});
const ApiSchema7503 = Schema.Struct({
  applied: Schema.Boolean,
  feedback: ApiSchema11235,
  retentionDays: Schema.Finite,
  valueEvents: ApiSchema11235,
});
const ApiSchema7504 = Schema.Struct({
  applied: Schema.Boolean,
  exports: ApiSchema11235,
  feedback: ApiSchema11235,
  valueEvents: ApiSchema11235,
});

export const isJobResponse2 = Schema.is(ApiSchema7214);
export const isInspection = Schema.is(ApiSchema7414);
export const isPreview = Schema.is(ApiSchema7417);
export const isTopicEnrollmentApplied = Schema.is(ApiSchema7418);
export const isManagerValueReport = Schema.is(ApiSchema7502);
export const isManagerValueRetentionReceipt = Schema.is(ApiSchema7503);
export const isManagerValueDeletionReceipt = Schema.is(ApiSchema7504);
