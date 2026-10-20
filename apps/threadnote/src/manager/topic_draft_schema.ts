import {Data, Schema} from 'effect';
import {consolidationSections} from '@threadnote/memory/consolidation';
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
  const quote = rationale.check(Schema.isMaxLength(512));
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
      removedClaims: Schema.Array(Schema.String),
    };
  };
  const witnesses = (required: boolean) =>
    Schema.Array(
      Schema.Struct({
        sourceIndex: scope.behaviorSourceIndices.length ? Schema.Literals(scope.behaviorSourceIndices) : Schema.Int,
        quote,
      }),
    ).check(Schema.isMinLength(required ? 1 : 0), Schema.isMaxLength(scope.behaviorSourceIndices.length));
  const requirement = () => ({
    normativeOrdinal: Schema.Literals(scope.normativeOrdinals),
    requirementQuote: quote,
  });
  const decision = Schema.Union([
    ...(descriptive.length && scope.behaviorSourceIndices.length
      ? [
          Schema.Struct({
            currentWitnesses: witnesses(true),
            policyAssessment: Schema.Literal('no-conflict-observed'),
            ...common(true),
          }),
        ]
      : []),
    ...(!descriptive.length
      ? [
          Schema.Struct({
            policyAssessment: Schema.Literal('source-review'),
            ...common(false),
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
            currentWitnesses: witnesses(true),
            policyAssessment: Schema.Literal('conflict'),
            ...requirement(),
            ...common(false),
          }),
        ]
      : []),
    ...(scope.normativeOrdinals.length
      ? [
          Schema.Struct({
            currentWitnesses: witnesses(false),
            policyAssessment: Schema.Literal('undetermined'),
            ...requirement(),
            missingFact: rationale.check(Schema.isMaxLength(256)),
            ...common(false),
          }),
        ]
      : []),
  ]);
  return Schema.Struct({
    version: Schema.Literal(4),
    targetHash: Schema.Literal(basis.targetHash),
    observationRevision: Schema.Literal(basis.observationRevision),
    packetDigest: Schema.Literal(basis.packetDigest),
    decision,
  });
}

/** Strict provider/controller preflight; application guards belong after observed dispatch. */
export function decodeTopicDraftWire(basis: TopicMaintenanceDraftBasis, input: unknown) {
  return Schema.decodeUnknownSync(topicDraftModelSchema(basis), {onExcessProperty: 'error'})(input);
}

/** Only explicit complete-wire application rejections may enter bounded draft repair. */
export class TopicDraftApplicationValidationError extends Data.TaggedError('TopicDraftApplicationValidationError')<{
  readonly message: string;
}> {}

/** Only validated handle-to-content bindings enter projection, including imported current handles. */
export function topicDraftCurrentEvidence(
  basis: TopicMaintenanceDraftBasis,
  evidence: readonly {readonly handleId: string; readonly content: string}[],
): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      topicDraftCurrentSourceHandles(basis).map(handle => {
        const matches = evidence.filter(item => item.handleId === handle);
        if (matches.length !== 1 || !wellFormed(matches[0].content))
          throw new Error('Verified current topic evidence is missing or ambiguous.');
        return [handle, matches[0].content];
      }),
    ),
  );
}

function wellFormed(text: string) {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function exactQuote(source: string, quote: string) {
  return quote.length > 0 && wellFormed(quote) && source.includes(quote);
}

export function projectTopicDraftWire(
  basis: TopicMaintenanceDraftBasis,
  wire: ReturnType<typeof decodeTopicDraftWire>,
  currentEvidence: Readonly<Record<string, string>>,
): TopicMaintenanceDraftV1 {
  const {decision, ...identity} = wire;
  const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;
  const invalid = (message: string): never => {
    throw new TopicDraftApplicationValidationError({message});
  };
  const current = topicDraftCurrentSourceHandles(basis);
  // Context failures are terminal, even if the selected wire does not reference the missing source.
  for (const handle of current)
    if (typeof currentEvidence[handle] !== 'string' || !wellFormed(currentEvidence[handle]))
      throw new Error('Verified current topic evidence is unavailable.');
  const currentHandle = (index: number) => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= current.length)
      return invalid('Invalid topic disposition source index.');
    return current[index];
  };
  const witnesses = 'currentWitnesses' in decision ? decision.currentWitnesses : [];
  for (const indices of [
    witnesses.map(witness => witness.sourceIndex),
    ...('reviewedSourceIndices' in decision ? [decision.reviewedSourceIndices] : []),
  ])
    if (new Set(indices).size !== indices.length) invalid('Duplicate topic assessment source index.');
  if (witnesses.reduce((total, witness) => total + byteLength(witness.quote), 0) > 512)
    invalid('Topic current witnesses exceed their UTF-8 byte bound.');
  for (const witness of witnesses)
    if (!exactQuote(currentEvidence[currentHandle(witness.sourceIndex)], witness.quote))
      invalid('Topic current witness is not an exact current excerpt quotation.');
  if ('normativeOrdinal' in decision) {
    const text = consolidationSections(basis.body)[decision.normativeOrdinal];
    if (basis.paragraphs[decision.normativeOrdinal]?.role !== 'normative')
      invalid('Topic requirement does not select a protected normative paragraph.');
    if (byteLength(decision.requirementQuote) > 512)
      invalid('Topic requirement quotation exceeds its UTF-8 byte bound.');
    if (!exactQuote(text, decision.requirementQuote))
      invalid('Topic requirement is not an exact normative paragraph quotation.');
  }
  if ('missingFact' in decision && (!wellFormed(decision.missingFact) || byteLength(decision.missingFact) > 256))
    invalid('Topic missing fact exceeds its UTF-8 scalar or byte bound.');
  const rationale =
    decision.policyAssessment === 'source-review'
      ? 'Checked source currency only; policy compliance not assessed.'
      : [
          witnesses.length
            ? 'Current evidence:\n' + witnesses.map(witness => `[${witness.sourceIndex}] ${witness.quote}`).join('\n')
            : 'No current behavior witness selected.',
          ...('normativeOrdinal' in decision
            ? [`Protected paragraph ${decision.normativeOrdinal}: ${decision.requirementQuote}`]
            : []),
          decision.policyAssessment === 'no-conflict-observed'
            ? `Assessment: no conflict observed against protected paragraphs ${topicDraftPolicyScope(basis).normativeOrdinals.join(', ') || 'none supplied'}.`
            : decision.policyAssessment === 'conflict'
              ? 'Assessment: policy conflict.'
              : 'Assessment: undetermined.',
          ...('missingFact' in decision ? [`Missing fact: ${decision.missingFact}`] : []),
        ].join('\n');
  if (byteLength(rationale) > 2048) invalid('Topic assessment rationale exceeds its UTF-8 byte bound.');
  const unresolvedQuestions =
    decision.policyAssessment === 'conflict'
      ? [
          `How should the selected current evidence be reconciled with protected paragraph ${decision.normativeOrdinal}?`,
        ]
      : decision.policyAssessment === 'undetermined'
        ? [`What evidence resolves the missing fact for protected paragraph ${decision.normativeOrdinal}?`]
        : [];
  const entries: TopicMaintenanceParagraphDispositionV1[] = [];
  const operations: TopicMaintenanceReplaceOperationV1[] = [];
  for (const entry of decision.paragraphDispositions.entries) {
    if (typeof entry === 'string' || !basis.paragraphs[entry.ordinal])
      throw new TopicDraftApplicationValidationError({message: 'Invalid topic disposition ordinal.'});
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
    rationale,
    unresolvedQuestions,
    removedClaims: decision.removedClaims,
    operations,
    reviewedHandles: [...new Set(reviewed)],
    paragraphDispositions: {version: 1, entries},
  };
}

export function decodeTopicDraftModelOutput(
  basis: TopicMaintenanceDraftBasis,
  input: unknown,
  currentEvidence: Readonly<Record<string, string>>,
): TopicMaintenanceDraftV1 {
  return projectTopicDraftWire(basis, decodeTopicDraftWire(basis, input), currentEvidence);
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
