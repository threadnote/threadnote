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

/** Trusted selection metadata; policy declarations alone are not observed behavior. */
export function topicDraftPolicyScope(basis: TopicMaintenanceDraftBasis) {
  const behaviorCitations = new Set([
    ...basis.paragraphs.filter(topicDraftGenerationEligible).flatMap(paragraph => paragraph.citationIds),
    ...basis.additionalDependencies.map(dependency => dependency.citationId),
  ]);
  return {
    normativeOrdinals: basis.paragraphs
      .filter(paragraph => paragraph.role === 'normative')
      .map(paragraph => paragraph.ordinal),
    behaviorSourceIndices: topicDraftCurrentSourceHandles(basis).flatMap((handle, index) =>
      behaviorCitations.has(handle.slice('current:'.length)) ? [index] : [],
    ),
  };
}

/** Generation grammar only; the memory-owned validator remains the final authority. */
export function topicDraftModelSchema(basis: TopicMaintenanceDraftBasis) {
  const descriptive = basis.paragraphs.filter(topicDraftGenerationEligible);
  const currentHandles = topicDraftCurrentSourceHandles(basis);
  if (!currentHandles.length) throw new Error('Topic generation requires current evidence.');
  const rationale = Schema.String.check(Schema.isMinLength(1));
  const observedBehavior = rationale.check(Schema.isMaxLength(512));
  const comparison = rationale.check(Schema.isMaxLength(1024));
  const scope = topicDraftPolicyScope(basis);
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
  const behaviorIndices = (required: boolean) =>
    Schema.Array(scope.behaviorSourceIndices.length ? Schema.Literals(scope.behaviorSourceIndices) : Schema.Int).check(
      Schema.isMinLength(required ? 1 : 0),
      Schema.isMaxLength(scope.behaviorSourceIndices.length),
    );
  const assessment = (required: boolean) => ({
    observedBehavior,
    behaviorSourceIndices: behaviorIndices(required),
    comparison,
  });
  const noQuestions = Schema.Array(Schema.String).check(Schema.isMaxLength(0));
  const questions = Schema.Array(rationale).check(Schema.isMinLength(1));
  const decision = Schema.Union([
    ...(descriptive.length && scope.behaviorSourceIndices.length
      ? [
          Schema.Struct({
            ...assessment(true),
            policyAssessment: Schema.Literal('no-conflict-observed'),
            ...common(true),
            unresolvedQuestions: noQuestions,
          }),
        ]
      : []),
    ...(!descriptive.length
      ? [
          Schema.Struct({
            comparison: Schema.Literal('Checked source currency only; policy compliance not assessed.'),
            policyAssessment: Schema.Literal('source-review'),
            ...common(false),
            unresolvedQuestions: noQuestions,
            reviewedSourceIndices: Schema.Array(Schema.Literals(currentHandles.map((_, index) => index))).check(
              Schema.isMinLength(1),
              Schema.isMaxLength(currentHandles.length),
            ),
          }),
        ]
      : []),
    ...(scope.normativeOrdinals.length && scope.behaviorSourceIndices.length
      ? [
          Schema.Struct({
            ...assessment(true),
            policyAssessment: Schema.Literal('conflict'),
            ...common(false),
            unresolvedQuestions: questions,
          }),
        ]
      : []),
    Schema.Struct({
      ...assessment(false),
      policyAssessment: Schema.Literal('undetermined'),
      ...common(false),
      unresolvedQuestions: questions,
    }),
  ]);
  return Schema.Struct({
    version: Schema.Literal(3),
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
  const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;
  if (
    byteLength(decision.comparison) > 1024 ||
    ('observedBehavior' in decision && byteLength(decision.observedBehavior) > 512)
  )
    throw new Error('Topic policy assessment exceeds its UTF-8 byte bound.');
  for (const indices of [
    ...('behaviorSourceIndices' in decision ? [decision.behaviorSourceIndices] : []),
    ...('reviewedSourceIndices' in decision ? [decision.reviewedSourceIndices] : []),
  ])
    if (new Set(indices).size !== indices.length) throw new Error('Duplicate topic assessment source index.');
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
  const outcome =
    decision.policyAssessment === 'conflict'
      ? 'policy-conflict'
      : decision.policyAssessment === 'undetermined'
        ? 'insufficient-evidence'
        : decision.policyAssessment === 'source-review'
          ? 'propose-revalidation'
          : operations.length
            ? 'propose-update'
            : entries.some(entry => entry.disposition === 'revalidate')
              ? 'propose-revalidation'
              : 'insufficient-evidence';
  const reviewed =
    outcome === 'propose-revalidation'
      ? 'reviewedSourceIndices' in decision
        ? decision.reviewedSourceIndices.map(currentHandle)
        : entries.filter(entry => entry.disposition === 'revalidate').flatMap(entry => entry.supportHandles)
      : [];
  return {
    ...identity,
    version: 1,
    outcome,
    rationale:
      'observedBehavior' in decision ? `${decision.observedBehavior}\n\n${decision.comparison}` : decision.comparison,
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
  const discriminatorKeys = ['ordinal', 'policyAssessment', 'disposition'].filter(key =>
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
  if (!decision || typeof decision !== 'object' || Array.isArray(decision))
    throw new Error('The topic generation schema has an unexpected decision union.');
  const branches = 'anyOf' in decision && Array.isArray(decision.anyOf) ? decision.anyOf : [decision];
  const assessmentEnums = branches.map(branch =>
    typeof branch === 'object' && branch !== null && 'properties' in branch
      ? (branch.properties as {readonly policyAssessment?: {readonly enum?: readonly string[]}}).policyAssessment?.enum
      : undefined,
  );
  if (
    assessmentEnums.some(
      values =>
        !Array.isArray(values) ||
        values.length !== 1 ||
        !['no-conflict-observed', 'conflict', 'undetermined', 'source-review'].includes(values[0]),
    ) ||
    new Set(assessmentEnums.map(values => values?.[0])).size !== branches.length
  )
    throw new Error('Topic generation assessments are not mutually exclusive.');
  return {
    ...document,
    properties: {...fields, decision: {oneOf: branches.map(nativeDisjointUnions) as typeof branches}},
  };
}
