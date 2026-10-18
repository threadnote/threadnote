import {Schema} from 'effect';
import {
  topicMaintenanceParagraphEligible,
  type TopicMaintenanceDraftBasis,
} from '@threadnote/memory/topic-maintenance-draft';

export function topicDraftGenerationEligible(paragraph: TopicMaintenanceDraftBasis['paragraphs'][number]) {
  return topicMaintenanceParagraphEligible(paragraph);
}

export function topicDraftGenerationScopeSupported(basis: TopicMaintenanceDraftBasis, sourceExcerptChanged: boolean) {
  return (
    !sourceExcerptChanged ||
    basis.paragraphs.some(topicDraftGenerationEligible) ||
    basis.paragraphs.every(paragraph => paragraph.role !== 'descriptive')
  );
}

export function topicDraftCurrentSourceHandles(basis: TopicMaintenanceDraftBasis) {
  return basis.handles.filter(handle => handle.variant === 'current').map(handle => handle.id);
}

/** Generation grammar only; the memory-owned validator remains the final authority. */
export function topicDraftModelSchema(basis: TopicMaintenanceDraftBasis) {
  const descriptive = basis.paragraphs.filter(topicDraftGenerationEligible);
  const currentHandles = topicDraftCurrentSourceHandles(basis);
  const currentHandle = currentHandles.length ? Schema.Literals(currentHandles) : Schema.String;
  const operationVariants = descriptive.map(paragraph =>
    Schema.Struct({
      ordinal: Schema.Literal(paragraph.ordinal),
      beforeHash: Schema.Literal(paragraph.hash),
      text: Schema.String.check(Schema.isMinLength(1)),
      supportHandles: Schema.Array(currentHandle).check(Schema.isMinLength(1)),
      rationale: Schema.String.check(Schema.isMinLength(1)),
    }),
  );
  const operation = Schema.Union(operationVariants.length ? operationVariants : [Schema.String]);
  const sourceIndex = currentHandles.length ? Schema.Literals(currentHandles.map((_, index) => index)) : Schema.Int;
  const dispositionVariants = descriptive.map(paragraph =>
    Schema.Struct({
      ordinal: Schema.Literal(paragraph.ordinal),
      disposition: Schema.Literals(['update', 'revalidate', 'unresolved']),
      sourceIndices: Schema.Array(sourceIndex).check(Schema.isMaxLength(currentHandles.length)),
      rationale: Schema.String.check(Schema.isMinLength(1)),
    }),
  );
  const disposition = Schema.Union(dispositionVariants.length ? dispositionVariants : [Schema.String]);
  const common = {
    paragraphDispositions: Schema.Struct({
      version: Schema.Literal(1),
      entries: Schema.Array(disposition).check(
        Schema.isMinLength(descriptive.length),
        Schema.isMaxLength(descriptive.length),
      ),
    }),
    rationale: Schema.String.check(Schema.isMinLength(1)),
    unresolvedQuestions: Schema.Array(Schema.String),
    removedClaims: Schema.Array(Schema.String),
  };
  const noOperations = Schema.Array(operation).check(Schema.isMaxLength(0));
  const noReviewedHandles = Schema.Array(currentHandle).check(Schema.isMaxLength(0));
  const decision = Schema.Union([
    ...(descriptive.length
      ? [
          Schema.Struct({
            ...common,
            outcome: Schema.Literal('propose-update'),
            operations: Schema.Array(operation).check(Schema.isMinLength(1)),
            reviewedHandles: Schema.Array(currentHandle),
          }),
        ]
      : []),
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

export function decodeTopicDraftModelOutput(basis: TopicMaintenanceDraftBasis, input: unknown) {
  const {decision, ...identity} = Schema.decodeUnknownSync(topicDraftModelSchema(basis), {onExcessProperty: 'error'})(
    input,
  );
  const current = topicDraftCurrentSourceHandles(basis);
  return {
    ...identity,
    ...decision,
    paragraphDispositions: {
      version: 1 as const,
      entries: decision.paragraphDispositions.entries.map(entry => {
        if (typeof entry === 'string' || !basis.paragraphs[entry.ordinal])
          throw new Error('Invalid topic disposition ordinal.');
        return {
          ordinal: entry.ordinal,
          beforeHash: basis.paragraphs[entry.ordinal].hash,
          disposition: entry.disposition,
          supportHandles: entry.sourceIndices.map(index => {
            if (!Number.isSafeInteger(index) || index < 0 || index >= current.length)
              throw new Error('Invalid topic disposition source index.');
            return current[index];
          }),
          rationale: entry.rationale,
        };
      }),
    },
  };
}

function nativeDisjointUnions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(nativeDisjointUnions);
  if (typeof value !== 'object' || value === null) return value;
  const converted = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, nativeDisjointUnions(item)]));
  if (!Array.isArray(converted.anyOf)) return converted;
  const tags = converted.anyOf.map(variant => {
    if (typeof variant !== 'object' || variant === null || Array.isArray(variant)) return undefined;
    const entry = variant as Record<string, unknown>;
    const properties = entry.properties as Record<string, {enum?: readonly unknown[]}> | undefined;
    const values = entry.enum ?? properties?.ordinal?.enum ?? properties?.outcome?.enum;
    return Array.isArray(values) && values.length === 1 ? JSON.stringify(values[0]) : undefined;
  });
  if (tags.length > 1 && (tags.some(tag => tag === undefined) || new Set(tags).size !== tags.length))
    throw new Error('Topic generation schema contains overlapping alternatives.');
  const {anyOf, ...rest} = converted;
  return {...rest, oneOf: anyOf};
}

/** Convert disjoint schema alternatives to the native grammar's supported oneOf. */
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
    (decision.anyOf.length !== 3 && decision.anyOf.length !== 4)
  )
    throw new Error('The topic generation schema has an unexpected decision union.');
  const outcomeEnums = decision.anyOf.map(branch =>
    typeof branch === 'object' && branch !== null && 'properties' in branch
      ? (branch.properties as {readonly outcome?: {readonly enum?: readonly string[]}}).outcome?.enum
      : undefined,
  );
  if (
    outcomeEnums.some(values => !Array.isArray(values) || values.length !== 1) ||
    new Set(outcomeEnums.map(values => values?.[0])).size !== decision.anyOf.length ||
    ![
      ...(decision.anyOf.length === 4 ? ['propose-update'] : []),
      'propose-revalidation',
      'policy-conflict',
      'insufficient-evidence',
    ].every(expected => outcomeEnums.some(values => values?.[0] === expected))
  )
    throw new Error('Topic generation outcomes are not mutually exclusive.');
  return {
    ...document,
    properties: {...fields, decision: {oneOf: decision.anyOf.map(nativeDisjointUnions) as typeof decision.anyOf}},
  };
}
