import {Schema} from 'effect';
import {
  topicMaintenanceParagraphEligible,
  type TopicMaintenanceDraftBasis,
  type TopicMaintenanceDraftV1,
  type TopicMaintenanceParagraphDispositionV1,
  type TopicMaintenanceReplaceOperationV1,
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
  if (!currentHandles.length) throw new Error('Topic generation requires current evidence.');
  const rationale = Schema.String.check(Schema.isMinLength(1));
  const dependencies = basis.additionalDependencies.map(dependency => dependency.citationId);
  const common = (allowUpdate: boolean) => {
    const variants = descriptive.flatMap(paragraph => {
      const allowed = new Set([...paragraph.citationIds, ...dependencies].map(id => `current:${id}`));
      const indices = currentHandles.flatMap((handle, index) => (allowed.has(handle) ? [index] : []));
      const sourceIndex = indices.length ? Schema.Literals(indices) : Schema.Int;
      const dispositions = indices.length
        ? allowUpdate
          ? (['update', 'unchanged', 'unresolved'] as const)
          : (['unchanged', 'unresolved'] as const)
        : (['unresolved'] as const);
      return dispositions.map(disposition => {
        const fields = {
          ordinal: Schema.Literal(paragraph.ordinal),
          disposition: Schema.Literal(disposition),
          sourceIndices: Schema.Array(sourceIndex).check(
            Schema.isMinLength(disposition === 'unresolved' ? 0 : 1),
            Schema.isMaxLength(disposition === 'unresolved' ? 0 : indices.length),
          ),
          rationale,
        };
        return disposition === 'update'
          ? Schema.Struct({...fields, disposition: Schema.Literal('update'), text: rationale})
          : Schema.Struct({...fields, disposition: Schema.Literal(disposition)});
      });
    });
    return {
      paragraphDispositions: Schema.Struct({
        version: Schema.Literal(1),
        entries: Schema.Array(Schema.Union(variants.length ? variants : [Schema.String])).check(
          Schema.isMinLength(descriptive.length),
          Schema.isMaxLength(descriptive.length),
        ),
      }),
      unresolvedQuestions: Schema.Array(Schema.String),
      removedClaims: Schema.Array(Schema.String),
    };
  };
  const noQuestions = Schema.Array(Schema.String).check(Schema.isMaxLength(0));
  const revalidation = {
    rationale,
    outcome: Schema.Literal('propose-revalidation'),
    ...common(false),
    unresolvedQuestions: noQuestions,
  };
  const decision = Schema.Union([
    ...(descriptive.length
      ? [
          Schema.Struct({
            rationale,
            outcome: Schema.Literal('propose-update'),
            ...common(true),
            unresolvedQuestions: noQuestions,
          }),
        ]
      : []),
    descriptive.length
      ? Schema.Struct(revalidation)
      : Schema.Struct({
          ...revalidation,
          reviewedSourceIndices: Schema.Array(Schema.Literals(currentHandles.map((_, index) => index))).check(
            Schema.isMinLength(1),
            Schema.isMaxLength(currentHandles.length),
          ),
        }),
    Schema.Struct({
      rationale,
      outcome: Schema.Literal('policy-conflict'),
      ...common(false),
      unresolvedQuestions: Schema.Array(rationale).check(Schema.isMinLength(1)),
    }),
    Schema.Struct({rationale, outcome: Schema.Literal('insufficient-evidence'), ...common(false)}),
  ]);
  return Schema.Struct({
    version: Schema.Literal(2),
    targetHash: Schema.Literal(basis.targetHash),
    observationRevision: Schema.Literal(basis.observationRevision),
    packetDigest: Schema.Literal(basis.packetDigest),
    decision,
  });
}

export function decodeTopicDraftModelOutput(
  basis: TopicMaintenanceDraftBasis,
  input: unknown,
): TopicMaintenanceDraftV1 {
  const {decision, ...identity} = Schema.decodeUnknownSync(topicDraftModelSchema(basis), {onExcessProperty: 'error'})(
    input,
  );
  const current = topicDraftCurrentSourceHandles(basis);
  const currentHandle = (index: number) => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= current.length)
      throw new Error('Invalid topic disposition source index.');
    return current[index];
  };
  const entries: TopicMaintenanceParagraphDispositionV1[] = [];
  const operations: TopicMaintenanceReplaceOperationV1[] = [];
  for (const entry of decision.paragraphDispositions.entries) {
    if (typeof entry === 'string' || !basis.paragraphs[entry.ordinal])
      throw new Error('Invalid topic disposition ordinal.');
    const fields = {
      ordinal: entry.ordinal,
      beforeHash: basis.paragraphs[entry.ordinal].hash,
      supportHandles: entry.sourceIndices.map(currentHandle),
      rationale: entry.rationale,
    };
    entries.push({...fields, disposition: entry.disposition === 'unchanged' ? 'revalidate' : entry.disposition});
    if (entry.disposition === 'update') operations.push({...fields, text: entry.text});
  }
  const reviewed =
    decision.outcome === 'propose-revalidation'
      ? 'reviewedSourceIndices' in decision
        ? decision.reviewedSourceIndices.map(currentHandle)
        : entries.filter(entry => entry.disposition === 'revalidate').flatMap(entry => entry.supportHandles)
      : [];
  return {
    ...identity,
    version: 1,
    outcome: decision.outcome,
    rationale: decision.rationale,
    unresolvedQuestions: decision.unresolvedQuestions,
    removedClaims: decision.removedClaims,
    operations,
    reviewedHandles: [...new Set(reviewed)],
    paragraphDispositions: {version: 1, entries},
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
