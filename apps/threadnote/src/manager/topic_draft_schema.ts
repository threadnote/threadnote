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
  const dependencies = basis.additionalDependencies.map(dependency => dependency.citationId);
  const dispositionVariants = descriptive.flatMap(paragraph => {
    const allowed = new Set([...paragraph.citationIds, ...dependencies].map(id => `current:${id}`));
    const indices = currentHandles.flatMap((handle, index) => (allowed.has(handle) ? [index] : []));
    const sourceIndex = indices.length ? Schema.Literals(indices) : Schema.Int;
    const dispositions = indices.length ? (['update', 'revalidate', 'unresolved'] as const) : (['unresolved'] as const);
    return dispositions.map(disposition =>
      Schema.Struct({
        ordinal: Schema.Literal(paragraph.ordinal),
        disposition: Schema.Literal(disposition),
        sourceIndices: Schema.Array(sourceIndex).check(
          Schema.isMinLength(disposition === 'unresolved' ? 0 : 1),
          Schema.isMaxLength(disposition === 'unresolved' ? 0 : indices.length),
        ),
        rationale: Schema.String.check(Schema.isMinLength(1)),
      }),
    );
  });
  const disposition = Schema.Union(dispositionVariants.length ? dispositionVariants : [Schema.String]);
  const rationale = Schema.String.check(Schema.isMinLength(1));
  const common = {
    paragraphDispositions: Schema.Struct({
      version: Schema.Literal(1),
      entries: Schema.Array(disposition).check(
        Schema.isMinLength(descriptive.length),
        Schema.isMaxLength(descriptive.length),
      ),
    }),
    unresolvedQuestions: Schema.Array(Schema.String),
    removedClaims: Schema.Array(Schema.String),
  };
  const noOperations = Schema.Array(operation).check(Schema.isMaxLength(0));
  const noReviewedHandles = Schema.Array(currentHandle).check(Schema.isMaxLength(0));
  const decision = Schema.Union([
    ...(descriptive.length
      ? [
          Schema.Struct({
            rationale,
            outcome: Schema.Literal('propose-update'),
            ...common,
            operations: Schema.Array(operation).check(Schema.isMinLength(1)),
            reviewedHandles: noReviewedHandles,
          }),
        ]
      : []),
    Schema.Struct({
      rationale,
      outcome: Schema.Literal('propose-revalidation'),
      ...common,
      operations: noOperations,
      reviewedHandles: Schema.Array(currentHandle).check(Schema.isMinLength(1)),
    }),
    Schema.Struct({
      rationale,
      outcome: Schema.Literal('policy-conflict'),
      ...common,
      operations: noOperations,
      reviewedHandles: noReviewedHandles,
    }),
    Schema.Struct({
      rationale,
      outcome: Schema.Literal('insufficient-evidence'),
      ...common,
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
  const entries = converted.anyOf.map(variant =>
    typeof variant === 'object' && variant !== null && !Array.isArray(variant)
      ? (variant as Record<string, unknown>)
      : undefined,
  );
  const discriminatorKeys = ['ordinal', 'outcome', 'disposition'].filter(key =>
    entries.every(entry => {
      const properties = entry?.properties as Record<string, {enum?: readonly unknown[]}> | undefined;
      return properties?.[key]?.enum?.length === 1;
    }),
  );
  const tags = entries.map(entry => {
    if (!entry) return undefined;
    const properties = entry.properties as Record<string, {enum?: readonly unknown[]}>;
    const values = entry.enum ?? discriminatorKeys.map(key => properties[key].enum![0]);
    return Array.isArray(values) && values.length > 0 && (entry.enum === undefined || values.length === 1)
      ? JSON.stringify(values)
      : undefined;
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
