import {Data, Schema} from 'effect';
import {consolidationRevision, consolidationSections} from '@threadnote/memory/consolidation';
import {
  topicMaintenanceParagraphEligible,
  type LegacyTopicMaintenanceDraftBasis as TopicMaintenanceDraftBasis,
  type TopicMaintenanceDraftBasis as AnyTopicMaintenanceDraftBasis,
  type AutomaticMaintenanceDraftBasisV3,
  validateAutomaticMaintenanceDraftBasis,
  automaticReviewSections,
  MAX_TOPIC_MAINTENANCE_DRAFT_BYTES,
  type AutomaticMaintenanceDraftV2,
  type TopicMaintenanceDraftV1,
  type TopicMaintenanceParagraphDispositionV1,
  type TopicMaintenanceReplaceOperationV1,
} from '@threadnote/memory/topic-maintenance-draft';
import {MAX_TOPIC_MAINTENANCE_BYTES} from '@threadnote/memory/topic-maintenance';

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

/** Consumer order is stable under handle permutations and citation renaming for declared sources. */
export function topicDraftCurrentSourceHandles(basis: TopicMaintenanceDraftBasis) {
  const current = basis.handles.filter(handle => handle.variant === 'current');
  const byCitation = new Map(current.map(handle => [handle.citationId, handle.id]));
  const ordered = [
    ...[...basis.paragraphs].sort((left, right) => left.ordinal - right.ordinal).flatMap(p => p.citationIds),
    ...basis.additionalDependencies.map(dependency => dependency.citationId),
  ].flatMap(id => (byCitation.has(id) ? [byCitation.get(id)!] : []));
  return [...new Set([...ordered, ...current.map(handle => handle.id)])];
}

/** Trusted selection metadata; policy declarations alone are not observed behavior. */
export function topicDraftPolicyScope(basis: TopicMaintenanceDraftBasis) {
  const behaviorCitations = new Set([
    ...basis.paragraphs.filter(topicDraftGenerationEligible).flatMap(paragraph => paragraph.citationIds),
    ...basis.additionalDependencies.map(dependency => dependency.citationId),
  ]);
  const currentById = new Map(basis.handles.map(handle => [handle.id, handle.citationId]));
  return {
    normativeOrdinals: basis.paragraphs
      .filter(paragraph => paragraph.role === 'normative')
      .map(paragraph => paragraph.ordinal),
    behaviorSourceIndices: topicDraftCurrentSourceHandles(basis).flatMap((handle, index) =>
      behaviorCitations.has(currentById.get(handle)!) ? [index] : [],
    ),
  };
}

/** Generation grammar only; the memory-owned validator remains the final authority. */
function legacyTopicDraftModelSchema(basis: TopicMaintenanceDraftBasis) {
  const descriptive = basis.paragraphs.filter(topicDraftGenerationEligible);
  const currentHandles = topicDraftCurrentSourceHandles(basis);
  if (!currentHandles.length) throw new Error('Topic generation requires current evidence.');
  const rationale = Schema.String.check(Schema.isMinLength(1));
  const scope = topicDraftPolicyScope(basis);
  const dependencies = basis.additionalDependencies.map(dependency => dependency.citationId);
  const variants = descriptive.flatMap(paragraph => {
    const allowed = new Set([...paragraph.citationIds, ...dependencies].map(id => `current:${id}`));
    const indices = currentHandles.flatMap((handle, index) => (allowed.has(handle) ? [index] : []));
    const sourceIndex = indices.length ? Schema.Literals(indices) : Schema.Int;
    const dispositions = indices.length ? (['update', 'unchanged', 'unresolved'] as const) : (['unresolved'] as const);
    return dispositions.map(disposition => {
      const fields = {
        ordinal: Schema.Literal(paragraph.ordinal),
        currentBehavior: disposition === 'unresolved' ? Schema.Union([rationale, Schema.Null]) : rationale,
        rationale,
        disposition: Schema.Literal(disposition),
        sourceIndices: Schema.Array(sourceIndex).check(
          Schema.isMinLength(disposition === 'unresolved' ? 0 : 1),
          Schema.isMaxLength(disposition === 'unresolved' ? 0 : indices.length),
        ),
      };
      return disposition === 'update'
        ? Schema.Struct({...fields, disposition: Schema.Literal('update'), text: rationale})
        : Schema.Struct({...fields, disposition: Schema.Literal(disposition)});
    });
  });
  const common = {removedClaims: Schema.Array(Schema.String)};
  const requirement = () => ({normativeOrdinal: Schema.Literals(scope.normativeOrdinals)});
  const decision = Schema.Union([
    ...(descriptive.length && scope.behaviorSourceIndices.length
      ? [Schema.Struct({policyAssessment: Schema.Literal('no-conflict-observed'), ...common})]
      : []),
    ...(!descriptive.length
      ? [
          Schema.Struct({
            policyAssessment: Schema.Literal('source-review'),
            ...common,
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
            policyAssessment: Schema.Literal('conflict'),
            ...requirement(),
            currentBehaviorSourceIndex: Schema.Literals(scope.behaviorSourceIndices),
            ...common,
          }),
        ]
      : []),
    ...(scope.normativeOrdinals.length
      ? [
          Schema.Struct({
            policyAssessment: Schema.Literal('undetermined'),
            ...requirement(),
            missingFact: rationale.check(Schema.isMaxLength(256)),
            ...common,
          }),
        ]
      : []),
  ]);
  return Schema.Struct({
    version: Schema.Literal(8),
    targetHash: Schema.Literal(basis.targetHash),
    observationRevision: Schema.Literal(basis.observationRevision),
    packetDigest: Schema.Literal(basis.packetDigest),
    facts: Schema.Struct({
      version: Schema.Literal(1),
      entries: Schema.Array(Schema.Union(variants.length ? variants : [Schema.String])).check(
        Schema.isMinLength(descriptive.length),
        Schema.isMaxLength(descriptive.length),
      ),
    }),
    normativeComparisons: Schema.Array(
      scope.normativeOrdinals.length
        ? Schema.Struct({ordinal: Schema.Literals(scope.normativeOrdinals), rationale})
        : Schema.String,
    ).check(Schema.isMinLength(scope.normativeOrdinals.length), Schema.isMaxLength(scope.normativeOrdinals.length)),
    decision,
  });
}

/** Strict provider/controller preflight; application guards belong after observed dispatch. */
function decodeLegacyTopicDraftWire(basis: TopicMaintenanceDraftBasis, input: unknown) {
  return Schema.decodeUnknownSync(legacyTopicDraftModelSchema(basis), {onExcessProperty: 'error'})(input);
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

export function projectTopicDraftWire(
  basis: TopicMaintenanceDraftBasis,
  wire: ReturnType<typeof decodeLegacyTopicDraftWire>,
  currentEvidence: Readonly<Record<string, string>>,
): TopicMaintenanceDraftV1 {
  const {facts, normativeComparisons, decision, ...identity} = wire;
  const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;
  const invalid = (message: string): never => {
    throw new TopicDraftApplicationValidationError({message});
  };
  const bounded = (text: string, max: number) => wellFormed(text) && text.trim().length > 0 && byteLength(text) <= max;
  const current = topicDraftCurrentSourceHandles(basis);
  // Context failures are terminal, even if the selected wire does not reference the missing source.
  for (const handle of current)
    if (typeof currentEvidence[handle] !== 'string' || !wellFormed(currentEvidence[handle]))
      throw new Error('Verified current topic evidence is unavailable.');
  const eligible = new Map(basis.paragraphs.filter(topicDraftGenerationEligible).map(p => [p.ordinal, p]));
  const normative = new Set(topicDraftPolicyScope(basis).normativeOrdinals);
  const comparisons = new Map<number, string>();
  for (const entry of normativeComparisons) {
    if (typeof entry === 'string' || !normative.has(entry.ordinal) || comparisons.has(entry.ordinal))
      return invalid('Invalid or duplicate topic comparison ordinal.');
    if (!bounded(entry.rationale, 1024)) invalid('Topic comparison rationale exceeds its UTF-8 scalar or byte bound.');
    comparisons.set(entry.ordinal, entry.rationale);
  }
  if (comparisons.size !== normative.size) invalid('Topic comparisons must cover exactly the protected ordinals.');
  const seen = new Set<number>();
  for (const entry of facts.entries) {
    if (typeof entry === 'string' || !eligible.has(entry.ordinal) || seen.has(entry.ordinal))
      return invalid('Invalid or duplicate topic fact ordinal.');
    seen.add(entry.ordinal);
    if (!bounded(entry.rationale, 1024)) invalid('Topic fact rationale exceeds its UTF-8 scalar or byte bound.');
    if (entry.currentBehavior === null ? entry.disposition !== 'unresolved' : !bounded(entry.currentBehavior, 512))
      invalid('Topic current behavior exceeds its UTF-8 scalar or byte bound.');
    const allowed = new Set(
      [
        ...eligible.get(entry.ordinal)!.citationIds,
        ...basis.additionalDependencies.map(dependency => dependency.citationId),
      ].map(id => `current:${id}`),
    );
    if (
      new Set(entry.sourceIndices).size !== entry.sourceIndices.length ||
      entry.sourceIndices.some(index => !Number.isSafeInteger(index) || !allowed.has(current[index])) ||
      (entry.disposition === 'unresolved' ? entry.sourceIndices.length !== 0 : entry.sourceIndices.length === 0)
    )
      invalid('Invalid, duplicate or unsupported topic fact source index.');
    // Check provisional text even when the final policy gate will discard it; no new replacement byte cap.
    if (entry.disposition === 'update') {
      if (!wellFormed(entry.text) || !entry.text.trim() || entry.text !== entry.text.trim())
        invalid('Invalid topic fact replacement text.');
      try {
        if (consolidationSections(entry.text).length !== 1)
          invalid('Topic fact replacement spans multiple paragraphs.');
      } catch {
        invalid('Topic fact replacement spans multiple paragraphs or exceeds the existing body bounds.');
      }
    }
  }
  if (seen.size !== eligible.size) invalid('Topic facts must cover exactly the eligible ordinals.');
  const currentHandle = (index: number) => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= current.length)
      return invalid('Invalid topic disposition source index.');
    return current[index];
  };
  if (
    'reviewedSourceIndices' in decision &&
    new Set(decision.reviewedSourceIndices).size !== decision.reviewedSourceIndices.length
  )
    invalid('Duplicate topic assessment source index.');
  if ('normativeOrdinal' in decision) {
    if (!normative.has(decision.normativeOrdinal))
      invalid('Topic requirement does not select a protected normative paragraph.');
  }
  if (
    'currentBehaviorSourceIndex' in decision &&
    !topicDraftPolicyScope(basis).behaviorSourceIndices.includes(decision.currentBehaviorSourceIndex)
  )
    invalid('Topic behavior source is outside the trusted policy scope.');
  if ('missingFact' in decision && !bounded(decision.missingFact, 256))
    invalid('Topic missing fact exceeds its UTF-8 scalar or byte bound.');
  const selectedIndices =
    'reviewedSourceIndices' in decision
      ? decision.reviewedSourceIndices
      : [
          ...facts.entries.flatMap(entry => (typeof entry === 'string' ? [] : entry.sourceIndices)),
          ...('currentBehaviorSourceIndex' in decision ? [decision.currentBehaviorSourceIndex] : []),
        ];
  const rationale = [
    `Assessment: ${decision.policyAssessment}`,
    `Current source indices: ${[...new Set(selectedIndices)].sort((a, b) => a - b).join(',')}`,
    `Normative compared: ${[...normative].sort((a, b) => a - b).join(',')}`,
    ...('normativeOrdinal' in decision ? [`Selected normative: ${decision.normativeOrdinal}`] : []),
    ...('currentBehaviorSourceIndex' in decision ? [`Behavior source: ${decision.currentBehaviorSourceIndex}`] : []),
    ...('normativeOrdinal' in decision ? [`Selected comparison: ${comparisons.get(decision.normativeOrdinal)}`] : []),
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
  const blocked = decision.policyAssessment === 'conflict' || decision.policyAssessment === 'undetermined';
  for (const entry of facts.entries) {
    if (typeof entry === 'string' || !basis.paragraphs[entry.ordinal])
      throw new TopicDraftApplicationValidationError({message: 'Invalid topic disposition ordinal.'});
    const fields = {
      ordinal: entry.ordinal,
      beforeHash: basis.paragraphs[entry.ordinal].hash,
      supportHandles: blocked ? [] : entry.sourceIndices.map(currentHandle),
      rationale: entry.rationale,
    };
    entries.push({
      ...fields,
      disposition: blocked ? 'unresolved' : entry.disposition === 'unchanged' ? 'revalidate' : entry.disposition,
    });
    if (!blocked && entry.disposition === 'update') operations.push({...fields, text: entry.text});
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
  return projectTopicDraftWire(basis, decodeLegacyTopicDraftWire(basis, input), currentEvidence);
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
  // Nullable summaries have disjoint scalar JSON types, rather than an object discriminator.
  if (
    entries.length === 2 &&
    entries.some(entry => entry?.type === 'null') &&
    entries.some(entry => entry?.type === 'string')
  ) {
    const {anyOf, ...rest} = converted;
    return {...rest, oneOf: anyOf};
  }
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
export function topicDraftNativeJsonSchema(
  schema: ReturnType<typeof topicDraftModelSchema>,
): ReturnType<typeof legacyTopicDraftNativeJsonSchema>;
export function topicDraftNativeJsonSchema(
  schema: ReturnType<typeof topicDraftModelSchema>,
  basis: AnyTopicMaintenanceDraftBasis,
): Record<string, unknown>;
export function topicDraftNativeJsonSchema(
  schema: ReturnType<typeof topicDraftModelSchema>,
  basis?: AnyTopicMaintenanceDraftBasis,
) {
  if (basis?.version !== 3) return legacyTopicDraftNativeJsonSchema(schema);
  return nativeDisjointUnions(Schema.toJsonSchemaDocument(schema, {onExcessProperty: 'error'}).schema) as Record<
    string,
    unknown
  >;
}

// The one-argument legacy adapter retains its exact decision validation and shape.
function legacyTopicDraftNativeJsonSchema(schema: ReturnType<typeof topicDraftModelSchema>) {
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
    required: document.required as readonly string[],
    properties: {
      ...Object.fromEntries(
        Object.entries(fields ?? {})
          .filter(([key]) => !['decision', 'facts', 'normativeComparisons'].includes(key))
          .map(([key, value]) => [key, nativeDisjointUnions(value)]),
      ),
      facts: nativeDisjointUnions(fields?.facts) as (typeof branches)[number],
      normativeComparisons: nativeDisjointUnions(fields?.normativeComparisons) as (typeof branches)[number],
      decision: {oneOf: branches.map(nativeDisjointUnions) as typeof branches},
    },
  };
}

/** Ordinary generation proposes roles/support in its final review; it does not enroll or approve a memory. */
export function topicDraftModelSchema(basis: AnyTopicMaintenanceDraftBasis) {
  return basis.version === 3 ? automaticTopicDraftModelSchema(basis) : legacyTopicDraftModelSchema(basis);
}

/** Separate, stable namespaces shared by the model schema, prompt and hydration. */
export function automaticTopicDraftIndexTables(basisInput: AutomaticMaintenanceDraftBasisV3) {
  const basis = validateAutomaticMaintenanceDraftBasis(basisInput);
  return Object.freeze({
    evidenceIds: Object.freeze(
      [
        ...new Set([
          ...basis.assessment.evidence.map(entry => entry.id),
          ...basis.handles.map(handle => handle.citationId),
        ]),
      ].sort(),
    ),
    currentHandles: Object.freeze(
      [...new Set(basis.handles.filter(handle => handle.variant === 'current').map(handle => handle.id))].sort(),
    ),
  });
}

function automaticTopicDraftModelSchema(basis: AutomaticMaintenanceDraftBasisV3) {
  const tables = automaticTopicDraftIndexTables(basis);
  const indices = (count: number, max = 8) =>
    Schema.Array(count ? Schema.Literals(Array.from({length: count}, (_, index) => index)) : Schema.Int).check(
      Schema.isMaxLength(Math.min(max, count)),
    );
  const paragraphs = basis.paragraphs.length ? basis.paragraphs : [{ordinal: 0}];
  const text = Schema.String;
  return Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal('automatic-model'),
    targetHash: Schema.Literal(basis.targetHash),
    observationRevision: Schema.Literal(basis.observationRevision),
    packetDigest: Schema.Literal(basis.packetDigest),
    outcome: Schema.Literals(['propose-update', 'propose-revalidation', 'policy-conflict', 'insufficient-evidence']),
    paragraphDecisions: Schema.Array(
      Schema.Union(
        paragraphs.map(paragraph =>
          Schema.Struct({
            ordinal: Schema.Literal(paragraph.ordinal),
            role: Schema.Literals(['descriptive', 'normative', 'historical', 'unknown']),
            support: Schema.Literals(['direct', 'contextual', 'unresolved']),
            evidenceIndices: indices(tables.evidenceIds.length),
          }),
        ),
      ),
    ).check(Schema.isMinLength(basis.paragraphs.length), Schema.isMaxLength(basis.paragraphs.length)),
    operations: Schema.Array(
      Schema.Union(
        paragraphs.map(paragraph =>
          Schema.Struct({
            ordinal: Schema.Literal(paragraph.ordinal),
            supportIndices: indices(tables.currentHandles.length),
            rationale: text,
            text,
          }),
        ),
      ),
    ).check(Schema.isMaxLength(basis.paragraphs.length)),
    currentSourceIndices: indices(tables.currentHandles.length, tables.currentHandles.length),
    rationale: text,
    unresolvedQuestions: Schema.Array(text),
    removedClaims: Schema.Array(text),
  });
}

/** Provider output stays compact; no runtime-expanded projection is labelled provider output. */
function decodeAutomaticTopicDraftModelWire(basis: AutomaticMaintenanceDraftBasisV3, input: unknown) {
  const wire = Schema.decodeUnknownSync(automaticTopicDraftModelSchema(basis), {onExcessProperty: 'error'})(input);
  const unique = (values: readonly number[]) => new Set(values).size === values.length;
  if (
    new TextEncoder().encode(JSON.stringify(input)).byteLength > MAX_TOPIC_MAINTENANCE_DRAFT_BYTES ||
    wire.paragraphDecisions.some(
      (decision, ordinal) => decision.ordinal !== ordinal || !unique(decision.evidenceIndices),
    ) ||
    !unique(wire.operations.map(operation => operation.ordinal)) ||
    wire.operations.some(operation => !unique(operation.supportIndices)) ||
    !unique(wire.currentSourceIndices)
  )
    throw new Error('Invalid automatic model wire coverage or indices.');
  return wire;
}

export type AutomaticTopicDraftModelWire = ReturnType<typeof decodeAutomaticTopicDraftModelWire>;

/** Strict provider-only shape. Public authored canonical V2 is accepted only by its existing route. */
export function decodeTopicDraftProviderWire(basis: AnyTopicMaintenanceDraftBasis, input: unknown) {
  return basis.version === 3
    ? decodeAutomaticTopicDraftModelWire(basis, input)
    : decodeLegacyTopicDraftWire(basis, input);
}

function hydrateAutomaticTopicDraftWire(basis: AutomaticMaintenanceDraftBasisV3, input: unknown) {
  const wire = decodeAutomaticTopicDraftModelWire(basis, input);
  const tables = automaticTopicDraftIndexTables(basis);
  const {currentSourceIndices, ...decisions} = wire;
  return decodeAutomaticTopicDraftWire(basis, {
    ...decisions,
    version: 2,
    kind: 'automatic',
    purpose: 'automatic',
    paragraphDecisions: wire.paragraphDecisions.map(({evidenceIndices, ...decision}) => ({
      ...decision,
      beforeHash: basis.paragraphs[decision.ordinal].hash,
      evidenceIds: evidenceIndices.map(index => tables.evidenceIds[index]),
    })),
    operations: wire.operations.map(({supportIndices, ...operation}) => ({
      ...operation,
      beforeHash: basis.paragraphs[operation.ordinal].hash,
      supportHandles: supportIndices.map(index => tables.currentHandles[index]),
    })),
    reviewedHandles: currentSourceIndices.map(index => tables.currentHandles[index]),
  });
}

function automaticTopicDraftCanonicalSchema(basis: AutomaticMaintenanceDraftBasisV3) {
  const text = Schema.String;
  // A missing admitted namespace permits only [], never an unconstrained ID.
  const admitted = (values: readonly string[]) =>
    Schema.Array(values.length ? Schema.Literals(values) : text).check(Schema.isMaxLength(Math.min(8, values.length)));
  const current = basis.handles.filter(handle => handle.variant === 'current').map(handle => handle.id);
  const evidence = [
    ...new Set([...basis.assessment.evidence.map(entry => entry.id), ...basis.handles.map(h => h.citationId)]),
  ];
  // maxItems:0 below closes empty paragraph universes without an empty union.
  const paragraphs = basis.paragraphs.length ? basis.paragraphs : [{ordinal: 0, hash: ''}];
  const decisions = paragraphs.map(paragraph =>
    Schema.Struct({
      ordinal: Schema.Literal(paragraph.ordinal),
      beforeHash: Schema.Literal(paragraph.hash),
      role: Schema.Literals(['descriptive', 'normative', 'historical', 'unknown']),
      support: Schema.Literals(['direct', 'contextual', 'unresolved']),
      evidenceIds: admitted(evidence),
    }),
  );
  const operations = paragraphs.map(paragraph =>
    Schema.Struct({
      ordinal: Schema.Literal(paragraph.ordinal),
      beforeHash: Schema.Literal(paragraph.hash),
      supportHandles: admitted(current),
      rationale: text,
      text,
    }),
  );
  return Schema.Struct({
    version: Schema.Literal(2),
    kind: Schema.Literal('automatic'),
    purpose: Schema.Literal('automatic'),
    targetHash: Schema.Literal(basis.targetHash),
    observationRevision: Schema.Literal(basis.observationRevision),
    packetDigest: Schema.Literal(basis.packetDigest),
    outcome: Schema.Literals(['propose-update', 'propose-revalidation', 'policy-conflict', 'insufficient-evidence']),
    paragraphDecisions: Schema.Array(Schema.Union(decisions)).check(
      Schema.isMinLength(basis.paragraphs.length),
      Schema.isMaxLength(basis.paragraphs.length),
    ),
    operations: Schema.Array(Schema.Union(operations)).check(Schema.isMaxLength(basis.paragraphs.length)),
    reviewedHandles: Schema.Array(current.length ? Schema.Literals(current) : text).check(
      Schema.isMaxLength(current.length),
    ),
    rationale: text,
    unresolvedQuestions: Schema.Array(text),
    removedClaims: Schema.Array(text),
  });
}

/** Terminal wire/context preflight only; the memory owner still decides application validity. */
function decodeAutomaticTopicDraftWire(basisInput: AutomaticMaintenanceDraftBasisV3, input: unknown) {
  const basis = validateAutomaticMaintenanceDraftBasis(basisInput);
  const wire = Schema.decodeUnknownSync(automaticTopicDraftCanonicalSchema(basis), {onExcessProperty: 'error'})(input);
  const size = (text: string) => new TextEncoder().encode(text).byteLength;
  const invalid = (): never => {
    throw new Error('Invalid automatic generation wire identity, coverage or bounds.');
  };
  const bounded = (text: string, max: number) => wellFormed(text) && text.length > 0 && size(text) <= max;
  const strings = (values: readonly string[], count: number, max: number) =>
    values.length <= count && values.every(value => bounded(value, max));
  const unique = (values: readonly unknown[]) => new Set(values).size === values.length;
  const current = new Set(basis.handles.filter(handle => handle.variant === 'current').map(handle => handle.id));
  const evidence = new Set([
    ...basis.assessment.evidence.map(entry => entry.id),
    ...basis.handles.map(h => h.citationId),
  ]);
  if (
    size(JSON.stringify(input)) > MAX_TOPIC_MAINTENANCE_DRAFT_BYTES ||
    !bounded(wire.rationale, 2048) ||
    !strings(wire.reviewedHandles, basis.assessment.version === 2 ? 24 : 16, 80) ||
    !unique(wire.reviewedHandles) ||
    wire.reviewedHandles.some(handle => !current.has(handle)) ||
    !strings(wire.unresolvedQuestions, 16, 512) ||
    !strings(wire.removedClaims, 64, 512) ||
    wire.operations.length > basis.paragraphs.length ||
    !unique(wire.operations.map(operation => operation.ordinal)) ||
    wire.paragraphDecisions.length !== basis.paragraphs.length
  )
    invalid();
  const sections = automaticReviewSections(basis.body);
  if (
    sections.length !== basis.paragraphs.length ||
    sections.some((text, ordinal) => consolidationRevision(text) !== basis.paragraphs[ordinal].hash)
  )
    invalid();
  let bodyBytes = size(basis.body);
  for (const operation of wire.operations) {
    const prior = basis.paragraphs[operation.ordinal];
    if (
      !Number.isSafeInteger(operation.ordinal) ||
      !prior ||
      operation.beforeHash !== prior.hash ||
      !bounded(operation.text, MAX_TOPIC_MAINTENANCE_BYTES) ||
      automaticReviewSections(operation.text).length !== 1 ||
      !bounded(operation.rationale, 1024) ||
      !strings(operation.supportHandles, 8, 80) ||
      !unique(operation.supportHandles) ||
      operation.supportHandles.some(handle => !current.has(handle))
    )
      invalid();
    bodyBytes += size(operation.text) - size(sections[operation.ordinal]);
  }
  if (bodyBytes > MAX_TOPIC_MAINTENANCE_BYTES) invalid();
  for (const [ordinal, decision] of wire.paragraphDecisions.entries()) {
    if (
      decision.ordinal !== ordinal ||
      decision.beforeHash !== basis.paragraphs[ordinal].hash ||
      !strings(decision.evidenceIds, 8, 68) ||
      !unique(decision.evidenceIds) ||
      decision.evidenceIds.some(id => !evidence.has(id))
    )
      invalid();
  }
  return wire;
}
export function decodeTopicDraftWire(
  basis: TopicMaintenanceDraftBasis,
  input: unknown,
): ReturnType<typeof decodeLegacyTopicDraftWire>;
export function decodeTopicDraftWire(
  basis: AutomaticMaintenanceDraftBasisV3,
  input: unknown,
): AutomaticMaintenanceDraftV2;
export function decodeTopicDraftWire(
  basis: AnyTopicMaintenanceDraftBasis,
  input: unknown,
): ReturnType<typeof decodeLegacyTopicDraftWire> | AutomaticMaintenanceDraftV2;
export function decodeTopicDraftWire(
  basis: AnyTopicMaintenanceDraftBasis,
  input: unknown,
): ReturnType<typeof decodeLegacyTopicDraftWire> | AutomaticMaintenanceDraftV2 {
  return basis.version === 3 ? hydrateAutomaticTopicDraftWire(basis, input) : decodeLegacyTopicDraftWire(basis, input);
}
