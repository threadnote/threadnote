import {Schema} from 'effect';
import type {TopicMaintenanceDraftBasisV1} from '@threadnote/memory/topic-maintenance-draft';

/** Generation grammar only; the memory-owned validator remains the final authority. */
export function topicDraftModelSchema(basis: TopicMaintenanceDraftBasisV1) {
  const descriptive = basis.paragraphs.filter(paragraph => paragraph.role === 'descriptive');
  const currentHandles = basis.handles.filter(handle => handle.variant === 'current').map(handle => handle.id);
  const ordinal = descriptive.length ? Schema.Literals(descriptive.map(paragraph => paragraph.ordinal)) : Schema.Finite;
  const beforeHash = descriptive.length ? Schema.Literals(descriptive.map(paragraph => paragraph.hash)) : Schema.String;
  const currentHandle = currentHandles.length ? Schema.Literals(currentHandles) : Schema.String;
  const operation = Schema.Struct({
    ordinal,
    beforeHash,
    text: Schema.String.check(Schema.isMinLength(1)),
    supportHandles: Schema.Array(currentHandle).check(Schema.isMinLength(1)),
    rationale: Schema.String.check(Schema.isMinLength(1)),
  });
  const common = {
    rationale: Schema.String.check(Schema.isMinLength(1)),
    unresolvedQuestions: Schema.Array(Schema.String),
    removedClaims: Schema.Array(Schema.String),
  };
  const noOperations = Schema.Array(operation).check(Schema.isMaxLength(0));
  const noReviewedHandles = Schema.Array(currentHandle).check(Schema.isMaxLength(0));
  const decision = Schema.Union([
    Schema.Struct({
      ...common,
      outcome: Schema.Literal('propose-update'),
      operations: Schema.Array(operation).check(Schema.isMinLength(1)),
      reviewedHandles: Schema.Array(currentHandle),
    }),
    Schema.Struct({
      ...common,
      outcome: Schema.Literal('propose-revalidation'),
      operations: noOperations,
      reviewedHandles: Schema.Array(currentHandle).check(Schema.isMinLength(1)),
    }),
    Schema.Struct({
      ...common,
      outcome: Schema.Literal('policy-conflict'),
      operations: noOperations,
      reviewedHandles: noReviewedHandles,
    }),
    Schema.Struct({
      ...common,
      outcome: Schema.Literal('insufficient-evidence'),
      operations: noOperations,
      reviewedHandles: noReviewedHandles,
    }),
  ]);
  return Schema.Struct({
    version: Schema.Literal(1),
    targetHash: Schema.Literal(basis.targetHash),
    observationRevision: Schema.Literal(basis.observationRevision),
    packetDigest: Schema.Literal(basis.packetDigest),
    decision,
  });
}

/** Convert only the four outcome-disjoint decision branches to the native grammar's supported oneOf. */
export function topicDraftNativeJsonSchema(schema: ReturnType<typeof topicDraftModelSchema>) {
  const document = Schema.toJsonSchemaDocument(schema, {onExcessProperty: 'error'}).schema as Record<string, unknown>;
  const properties = document.properties;
  const fields =
    properties && typeof properties === 'object' && !Array.isArray(properties)
      ? (properties as Record<string, unknown>)
      : undefined;
  const decision = fields?.decision;
  if (
    !decision ||
    typeof decision !== 'object' ||
    Array.isArray(decision) ||
    !('anyOf' in decision) ||
    !Array.isArray(decision.anyOf) ||
    decision.anyOf.length !== 4
  )
    throw new Error('The topic generation schema has an unexpected decision union.');
  const outcomeEnums = decision.anyOf.map(branch =>
    typeof branch === 'object' && branch !== null && 'properties' in branch
      ? (branch.properties as {readonly outcome?: {readonly enum?: readonly string[]}}).outcome?.enum
      : undefined,
  );
  if (
    outcomeEnums.some(values => !Array.isArray(values) || values.length !== 1) ||
    new Set(outcomeEnums.map(values => values?.[0])).size !== 4 ||
    !['propose-update', 'propose-revalidation', 'policy-conflict', 'insufficient-evidence'].every(expected =>
      outcomeEnums.some(values => values?.[0] === expected),
    )
  )
    throw new Error('Topic generation outcomes are not mutually exclusive.');
  return {...document, properties: {...fields, decision: {oneOf: decision.anyOf}}};
}
