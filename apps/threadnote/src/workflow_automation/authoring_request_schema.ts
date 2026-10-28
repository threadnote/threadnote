import {Schema} from 'effect';

const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u));
const reference = Schema.Struct({
  uri: Schema.String.check(Schema.isPattern(/^threadnote:\/\/[^\s]+$/u), Schema.isMaxLength(4096)),
  memoryId: Schema.String.check(Schema.isPattern(/^tn_[A-Za-z0-9_-]{1,128}$/u)),
  revision: digest,
});
const confirmation = Schema.Struct({
  intentHash: digest,
  decision: Schema.Literal('approved'),
  response: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
});
const review = Schema.Struct({
  documentHash: digest,
  outcome: Schema.Literals(['accepted', 'changes-requested']),
  blockingIssueCount: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});

export const nativeAuthoringRequestSchema = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  executorVersion: Schema.Literal(1),
  action: Schema.Literal('authoring'),
  command: Schema.Literals([
    'schema',
    'scope-inspect',
    'pin',
    'validate',
    'render',
    'review-packet',
    'challenge-packet',
    'acceptance-packet',
    'confirm',
    'save',
    'load',
    'recover',
    'diff',
    'export-plan',
    'from-spec',
    'export-dev-cycle',
    'closeout-input',
    'read',
  ]),
  runId: id,
  generation: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  document: Schema.optionalKey(Schema.Unknown),
  before: Schema.optionalKey(Schema.Unknown),
  after: Schema.optionalKey(Schema.Unknown),
  ready: Schema.optionalKey(Schema.Boolean),
  confirmation: Schema.optionalKey(confirmation),
  review: Schema.optionalKey(review),
  uri: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^threadnote:\/\/[^\s]+$/u), Schema.isMaxLength(4096))),
  expectedRevision: Schema.optionalKey(Schema.NullOr(digest)),
  paths: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(128))),
  literalOnly: Schema.optionalKey(Schema.Boolean),
  evidenceRefs: Schema.optionalKey(Schema.Array(reference).check(Schema.isMaxLength(16))),
  delivery: Schema.optionalKey(Schema.Literals(['local', 'commit', 'pr'])),
  bindings: Schema.optionalKey(Schema.Record(id, Schema.Struct({branch: Schema.String, baseBranch: Schema.String}))),
  sectionId: Schema.optionalKey(id),
  artifactId: Schema.optionalKey(id),
  decisionId: Schema.optionalKey(id),
  designRisk: Schema.optionalKey(Schema.Literals(['routine', 'alternatives', 'uncertain'])),
  offsetBytes: Schema.optionalKey(Schema.Finite),
  maxBytes: Schema.optionalKey(Schema.Finite),
  sourceDigest: Schema.optionalKey(digest),
  detail: Schema.optionalKey(Schema.Literals(['summary', 'document', 'outline', 'section'])),
  userResponse: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
  userDecision: Schema.optionalKey(Schema.Literals(['approve', 'reject', 'defer'])),
  packet: Schema.optionalKey(Schema.Unknown),
});
