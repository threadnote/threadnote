import {Array as EffectArray, Schema} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  canonicalAuthoringJson,
  decodeNativeAuthoringDocument,
  nativeAuthoringDigest,
  NativeAuthoringPlanDocumentSchema,
  projectNativeCompactIntent,
  nativeSpecIntentDigest,
  validateNativeAuthoring,
  type NativeAuthoringDocument,
} from '../src/authoring.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const hash = Effect.pipe('a', EffectString.repeat(64));
const source = {head: Effect.pipe('b', EffectString.repeat(40)), files: [{path: 'src/cache.ts', sha256: hash}]};
const context = {codeRefs: ['src/cache.ts'], evidenceRefs: [], note: 'Reviewed in the current source snapshot.'};
const requirement = {id: 'req-cache', behavior: 'The cache keeps fresh entries available.'};
const scenario = {
  id: 'scenario-fresh-cache',
  requirementIds: ['req-cache'],
  given: 'A valid cache entry exists.',
  when: 'A caller requests the entry.',
  then: 'The cache returns the fresh entry.',
};

const validSpec = (changes: Record<string, unknown> = {}): NativeAuthoringDocument =>
  decodeNativeAuthoringDocument({
    format: 'threadnote-native-authoring',
    schemaVersion: 1,
    kind: 'spec',
    id: 'cache-refresh',
    project: 'threadnote',
    title: 'Refresh cache entries',
    objective: 'Keep fresh entries available to callers.',
    requirements: [requirement],
    context,
    source,
    actors: ['operator'],
    inScope: ['cache refresh'],
    outOfScope: ['distributed cache redesign'],
    constraints: ['Preserve existing keys.'],
    observations: ['The current cache has a stale-entry edge case.'],
    scenarios: [scenario],
    assumptions: [{statement: 'The cache is local.', basis: 'Current implementation.', authority: 'evidence'}],
    questions: [],
    artifacts: [],
    review: {required: true, reason: 'Review is required for behavior changes.'},
    ...changes,
  });

const validPlan = (changes: Record<string, unknown> = {}): NativeAuthoringDocument => {
  const spec = validSpec();
  if (spec.kind !== 'spec') throw new Error('Expected the specification fixture.');
  return decodeNativeAuthoringDocument({
    format: 'threadnote-native-authoring',
    schemaVersion: 1,
    kind: 'plan',
    id: 'cache-refresh',
    project: 'threadnote',
    title: 'Refresh cache implementation',
    objective: 'Implement the accepted cache refresh behavior.',
    requirements: spec.requirements,
    context,
    source,
    current: {
      summary: 'A local cache serves entries.',
      components: ['Cache reader'],
      contracts: [],
      diagram: 'flowchart TD\n  Reader --> Cache',
    },
    target: {
      summary: 'A freshness check gates cache reads.',
      components: ['Cache reader', 'Freshness check'],
      contracts: ['Fresh entries remain readable.'],
      diagram: 'flowchart TD\n  Reader --> Freshness --> Cache',
    },
    phases: [
      {
        id: 'phase-cache-check',
        title: 'Check cached entry freshness',
        outcome: 'Fresh cache entries are returned and stale entries are refreshed.',
        dependsOn: [],
        affectedPaths: ['src/cache.ts'],
        newPaths: [],
        contracts: ['Keep cache keys stable.'],
        acceptance: [
          {
            id: 'accept-cache-freshness',
            criterion: 'Fresh entries are returned.',
            verification: 'Exercise fresh and stale cache cases.',
            requirementIds: ['req-cache'],
            scenarioIds: ['scenario-fresh-cache'],
          },
        ],
        safeBoundary: 'Do not redesign cache storage.',
      },
    ],
    decisions: [
      {
        id: 'decision-refresh-check',
        question: 'Where should freshness be checked?',
        selection: 'no-better-alternative',
        selected: 'Check freshness in the existing reader.',
        alternatives: [],
        rationale: 'This preserves the current cache contract with the smallest change.',
        affectedPhases: ['phase-cache-check'],
        authority: 'orchestrator',
      },
    ],
    openQuestions: [],
    review: {required: true, reason: 'Review is required before implementation.'},
    spec: {
      root: {uri: 'threadnote://memory/tn_spec', memoryId: 'tn_spec', revision: hash},
      binding: {
        bindingId: hash,
        runId: 'native-spec-run',
        generation: 'skill-generation-v1',
        profile: 'desktop',
      },
      documentHash: hash,
      intentHash: hash,
      requirements: spec.requirements,
      scenarios: spec.scenarios,
    },
    ...changes,
  });
};
const asPlan = (document: NativeAuthoringDocument) => {
  if (document.kind !== 'plan') throw new Error('Expected the plan fixture.');
  return document;
};

const caught = (run: () => unknown): unknown => {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
};
const issueCodes = (document: NativeAuthoringDocument) =>
  EffectArray.map(validateNativeAuthoring(document).issues, issue => issue.code);

const compactInput = (changes: Record<string, unknown> = {}) => ({
  title: 'Refresh stale cache entries',
  currentBehavior: 'Expired cache entries are returned without a freshness check.',
  desiredChange: 'Expired cache entries are refreshed before they are returned.',
  affectedPaths: ['src/cache.ts'],
  acceptanceCriterion: 'Expired entries are refreshed before return.',
  verification: 'Exercise an expired entry and observe its refresh.',
  eligibilityRationale: 'One behavior and one source path are explicit; no product decision or dependency is open.',
  eligibility: {status: 'eligible'},
  review: {required: false, reason: 'Routine local cache fix.'},
  ...changes,
});

const compactSource = {head: Effect.pipe('c', EffectString.repeat(40)), files: [{path: 'src/cache.ts', sha256: hash}]};

const alternativesPlan = (count: number, index = 0, marker = 'private-fixture') => {
  const plan = asPlan(validPlan());
  const decision = plan.decisions[0];
  if (!decision) throw new Error('Expected the decision fixture.');
  return {
    ...plan,
    decisions: Array.from({length: index + 1}, (_, position) => ({
      ...decision,
      id: `${marker}-decision-${position}`,
      selection: 'adapt',
      selected: `${marker} selected design 漢🧭`,
      alternatives: Array.from({length: position === index ? count : 2}, (_, item) => ({
        id: `${marker}-alternative-${item}`,
        design: `${marker} alternative design 漢🧭`,
        tradeoffs: `${marker} alternative tradeoff`,
      })),
    })),
  };
};

describe('native authoring documents', () => {
  const scopedPlan = (affected: number, added: number) => {
    const document = asPlan(validPlan());
    return {
      ...document,
      phases: EffectArray.map(document.phases, phase => ({
        ...phase,
        affectedPaths: Array.from({length: affected}, (_, index) => `src/affected-${index}.ts`),
        newPaths: Array.from({length: added}, (_, index) => `src/new-${index}.ts`),
      })),
    };
  };

  it('admits either path classification up to the unchanged combined cycle capacity', () => {
    for (const [affected, added] of [
      [136, 53],
      [256, 0],
      [0, 256],
      [128, 128],
      [0, 0],
    ]) {
      const input = scopedPlan(affected, added);
      expect(decodeNativeAuthoringDocument(input)).toEqual(input);
      expect(validateNativeAuthoring(input).issues).toEqual([]);
      expect(decodeNativeAuthoringDocument(JSON.parse(canonicalAuthoringJson(input)))).toEqual(input);
    }
  });

  it('rejects combined overflow across classifications without mutating input', () => {
    for (const [affected, added] of [
      [256, 1],
      [129, 128],
      [1, 256],
      [0, 257],
      [257, 0],
    ]) {
      const input = scopedPlan(affected, added);
      const before = JSON.stringify(input);
      const error = caught(() => decodeNativeAuthoringDocument(input));
      expect(error).toMatchObject({code: 'invalid-document'});
      expect(error instanceof Error ? error.message : '').toBe(
        'A phase may contain at most 256 affectedPaths and newPaths entries combined.',
      );
      expect(JSON.stringify(input)).toBe(before);
    }
    const privateMarker = 'private-overflow-path-value';
    const privateInput = scopedPlan(129, 128);
    const [firstPhase, ...remainingPhases] = privateInput.phases;
    if (!firstPhase) throw new Error('Expected the phase fixture.');
    const privacyError = caught(() =>
      decodeNativeAuthoringDocument({
        ...privateInput,
        phases: [
          {...firstPhase, affectedPaths: [privateMarker, ...firstPhase.affectedPaths.slice(1)]},
          ...remainingPhases,
        ],
      }),
    );
    expect(privacyError).toMatchObject({
      code: 'invalid-document',
      message: 'A phase may contain at most 256 affectedPaths and newPaths entries combined.',
    });
    if (!(privacyError instanceof Error)) throw new Error('Expected a rejected authoring document.');
    expect(privacyError.message).not.toContain(privateMarker);
    expect(Schema.toJsonSchemaDocument(NativeAuthoringPlanDocumentSchema)).toBeDefined();
    // Source evidence retains its separate128-entry cap.
    expect(
      caught(() =>
        decodeNativeAuthoringDocument({
          ...scopedPlan(0, 0),
          source: {
            ...source,
            files: Array.from({length: 129}, (_, index) => ({path: `src/${index}.ts`, sha256: hash})),
          },
        }),
      ),
    ).toMatchObject({code: 'invalid-document'});
  });

  it('publishes per-list limits and the required combined runtime constraint', () => {
    const publicSchema = Schema.decodeUnknownSync(
      Schema.Struct({
        schema: Schema.Struct({
          properties: Schema.Struct({
            phases: Schema.Struct({
              items: Schema.Struct({
                allOf: Schema.Array(Schema.Struct({description: Schema.String})),
                properties: Schema.Struct({
                  affectedPaths: Schema.Struct({maxItems: Schema.Finite}),
                  newPaths: Schema.Struct({maxItems: Schema.Finite}),
                }),
              }),
            }),
          }),
        }),
      }),
    )(Schema.toJsonSchemaDocument(NativeAuthoringPlanDocumentSchema));
    expect(publicSchema.schema.properties.phases.items).toMatchObject({
      allOf: [
        {
          description:
            'Runtime validation requires affectedPaths and newPaths to contain at most 256 entries combined.',
        },
      ],
      properties: {affectedPaths: {maxItems: 256}, newPaths: {maxItems: 256}},
    });
  });

  it('preserves exact classified paths and round trips iff their combined count fits', () => {
    fc.assert(
      fc.property(fc.integer({min: 0, max: 270}), fc.integer({min: 0, max: 270}), (affected, added) => {
        const input = scopedPlan(affected, added);
        const before = JSON.stringify(input);
        if (affected + added <= 256) {
          const decoded = decodeNativeAuthoringDocument(input);
          expect(decoded).toEqual(input);
          expect(decodeNativeAuthoringDocument(JSON.parse(canonicalAuthoringJson(decoded)))).toEqual(input);
        } else expect(caught(() => decodeNativeAuthoringDocument(input))).toMatchObject({code: 'invalid-document'});
        expect(JSON.stringify(input)).toBe(before);
      }),
      {numRuns: 48},
    );
  });

  it('strictly decodes versioned spec and plan shapes, safe source paths, and the canonical byte ceiling', () => {
    expect(decodeNativeAuthoringDocument(validSpec())).toEqual(validSpec());
    expect(decodeNativeAuthoringDocument(validPlan())).toEqual(validPlan());
    for (const invalid of [
      {...validSpec(), path: '/private/source.ts'},
      {...validSpec(), unexpected: true},
      {...validSpec(), context: {...context, secretPath: '/tmp/private'}},
      {...validSpec(), source: {...source, files: [{path: '../outside.ts', sha256: hash}]}},
      {...validSpec(), source: {...source, files: [{path: 'C:/outside.ts', sha256: hash}]}},
      {...validSpec(), schemaVersion: 2},
      {...validSpec(), title: 'Two\nlines'},
      {...validSpec(), source: {...source, files: [{path: 'src/cache.ts', sha256: 'no-digest'}]}},
      {...validSpec(), objective: Effect.pipe('🧭', EffectString.repeat(110_000))},
      {...validSpec(), observations: Array.from({length: 128}, () => Effect.pipe('x', EffectString.repeat(8192)))},
    ])
      expect(caught(() => decodeNativeAuthoringDocument(invalid))).toMatchObject({code: 'invalid-document'});
  });

  it('keeps the alternatives boundary and reports only its rejected location, count and maximum', () => {
    for (const count of [0, 1, 2]) {
      const input = alternativesPlan(count);
      const before = JSON.stringify(input);
      const decoded = decodeNativeAuthoringDocument(input);
      expect(decoded).toEqual(input);
      expect(JSON.stringify(input)).toBe(before);
      expect(validateNativeAuthoring(decoded)).toMatchObject({ready: false, issues: []});
    }
    expect(caught(() => decodeNativeAuthoringDocument(alternativesPlan(3)))).toMatchObject({
      code: 'invalid-document',
      message: 'decisions[0].alternatives has 3 items; maximum 2.',
    });
  });

  it('reports the actual alternatives failure without exposing authored content or mutating input', () => {
    fc.assert(
      fc.property(fc.integer({min: 0, max: 63}), fc.integer({min: 3, max: 12}), fc.uuid(), (index, count, token) => {
        const marker = `private-${token}`;
        const input = alternativesPlan(count, index, marker);
        const before = JSON.stringify(input);
        const error = caught(() => decodeNativeAuthoringDocument(input));
        expect(error).toMatchObject({
          code: 'invalid-document',
          message: `decisions[${index}].alternatives has ${count} items; maximum 2.`,
        });
        if (!(error instanceof Error)) throw new Error('Expected a rejected authoring document.');
        expect(error.message).not.toContain(marker);
        expect(new TextEncoder().encode(error.message).byteLength).toBeLessThanOrEqual(256);
        expect(JSON.stringify(input)).toBe(before);
      }),
      {numRuns: 40},
    );
  });

  it('keeps unrelated, malformed and unknown-field failures generic without inventing alternatives diagnostics', () => {
    const input = alternativesPlan(2);
    const decision = input.decisions[0];
    if (!decision) throw new Error('Expected the decision fixture.');
    const marker = 'private-field-and-value';
    for (const invalid of [
      {...input, [marker]: marker},
      {...input, context: {...input.context, codeRefs: Array.from({length: 9}, (_, i) => `src/${i}.ts`)}},
      {...input, decisions: [{...decision, alternatives: {length: 3, [marker]: marker}}]},
      {...input, decisions: [{...decision, alternatives: [{id: 'a', design: 0, tradeoffs: marker}]}]},
      {
        ...input,
        decisions: [{...decision, alternatives: [{id: 'a', design: 0, tradeoffs: marker}, ...decision.alternatives]}],
      },
      {
        ...input,
        decisions: [{...decision, alternatives: [{id: 'a', design: marker, tradeoffs: marker, [marker]: marker}]}],
      },
    ]) {
      const before = JSON.stringify(invalid);
      expect(caught(() => decodeNativeAuthoringDocument(invalid))).toMatchObject({
        code: 'invalid-document',
        message: 'The native authoring document is malformed or contains unsupported fields.',
      });
      expect(JSON.stringify(invalid)).toBe(before);
    }
  });

  it('canonicalizes recursively, omits undefined object fields, and roundtrips bounded Unicode', () => {
    expect(canonicalAuthoringJson({z: {b: 2, a: 1}, a: undefined})).toBe('{"z":{"a":1,"b":2}}');
    const reverse = (value: unknown): unknown => {
      if (EffectArray.isArray(value)) return EffectArray.map(value, reverse);
      if (value !== null && typeof value === 'object')
        return EffectRecord.fromEntries(
          EffectArray.map(EffectRecord.toEntries(value).reverse(), ([key, item]) => [key, reverse(item)]),
        );
      return value;
    };
    fc.assert(
      fc.property(
        fc
          .array(fc.constantFrom('a', 'é', '漢', '🧭', '🌊', ' e', 'x\n'), {maxLength: 120})
          .map(parts => EffectArray.join(parts, '')),
        generated => {
          const original = validSpec({objective: `Keep this behavior — ${generated}`});
          const decodedAgain = decodeNativeAuthoringDocument(JSON.parse(canonicalAuthoringJson(original)));
          expect(decodedAgain).toEqual(original);
          expect(canonicalAuthoringJson(reverse(original))).toBe(canonicalAuthoringJson(original));
          expect(nativeAuthoringDigest(decodedAgain)).toBe(nativeAuthoringDigest(original));
        },
      ),
      {numRuns: 60},
    );
  });

  it('keeps spec approval intent stable across source-only changes but binds all behavioral content', () => {
    const original = validSpec();
    const sourceOnly = validSpec({
      source: {...source, head: Effect.pipe('c', EffectString.repeat(40))},
      context: {...context, note: 'Updated source context.'},
      observations: ['A newer observation.'],
      review: {required: true, reason: 'Updated classification reason.'},
    });
    expect(nativeSpecIntentDigest(sourceOnly)).toBe(nativeSpecIntentDigest(original));
    expect(nativeAuthoringDigest(sourceOnly)).not.toBe(nativeAuthoringDigest(original));
    expect(
      nativeSpecIntentDigest(
        validSpec({requirements: [{id: 'req-cache', behavior: 'Stale entries are never returned.'}]}),
      ),
    ).not.toBe(nativeSpecIntentDigest(original));
    const plan = validPlan();
    const refreshedPlan = validPlan({
      source: {...source, head: Effect.pipe('c', EffectString.repeat(40))},
      context: {
        ...context,
        evidenceRefs: [{uri: 'threadnote://memory/tn_evidence', memoryId: 'tn_evidence', revision: hash}],
        note: 'Refreshed evidence.',
      },
      openQuestions: ['A transient evidence follow-up.'],
      review: {required: true, reason: 'Updated review rationale.'},
    });
    expect(nativeSpecIntentDigest(refreshedPlan)).toBe(nativeSpecIntentDigest(plan));
    expect(nativeAuthoringDigest(refreshedPlan)).not.toBe(nativeAuthoringDigest(plan));
    expect(nativeSpecIntentDigest(plan, 1)).toBe(nativeAuthoringDigest(plan));
    const semanticChanges = [
      validPlan({requirements: [{id: 'req-cache', behavior: 'Only fresh entries are returned.'}]}),
      validPlan({current: {...asPlan(plan).current, summary: 'The cache reader serves stale entries.'}}),
      validPlan({target: {...asPlan(plan).target, summary: 'A new freshness design gates cache reads.'}}),
      validPlan({phases: [{...asPlan(plan).phases[0], outcome: 'A changed implementation outcome.'}]}),
      validPlan({decisions: [{...asPlan(plan).decisions[0], selected: 'Use a different freshness boundary.'}]}),
      validPlan({review: {required: false, reason: 'Routine plan.'}}),
    ];
    for (const changed of semanticChanges)
      expect(nativeSpecIntentDigest(changed)).not.toBe(nativeSpecIntentDigest(plan));
  });

  it('property: plan source and evidence refreshes preserve v2 intent while changing the full document digest', () => {
    const original = asPlan(validPlan());
    fc.assert(
      fc.property(fc.integer({min: 0, max: 0x7fffffff}), index => {
        const head = Effect.pipe(index.toString(16), EffectString.padStart(40, '0'));
        const refreshed = asPlan(
          validPlan({
            source: {...source, head},
            context: {
              ...context,
              note: `Evidence refresh ${index}.`,
              evidenceRefs: [
                {
                  uri: 'threadnote://memory/tn_evidence',
                  memoryId: 'tn_evidence',
                  revision: Effect.pipe(index.toString(16), EffectString.padStart(64, '0')),
                },
              ],
            },
            openQuestions: [`Refresh follow-up ${index}.`],
            review: {required: original.review.required, reason: `Updated review reason ${index}.`},
          }),
        );
        expect(nativeSpecIntentDigest(refreshed)).toBe(nativeSpecIntentDigest(original));
        expect(nativeAuthoringDigest(refreshed)).not.toBe(nativeAuthoringDigest(original));
      }),
      {numRuns: 60},
    );
  });

  it('reports spec semantic gaps and only marks an exact confirmed, reviewed spec ready', () => {
    const spec = validSpec();
    expect(validateNativeAuthoring(spec)).toMatchObject({ready: false, issues: []});
    const changedReferences = validSpec({
      scenarios: [{...scenario, requirementIds: ['unknown-requirement']}],
      context: {...context, codeRefs: ['src/other.ts']},
    });
    expect(issueCodes(changedReferences)).toEqual(
      expect.arrayContaining(['unknown-reference', 'requirement-uncovered', 'code-ref-out-of-snapshot']),
    );
    const duplicate = validSpec({
      requirements: [requirement, requirement],
      scenarios: [
        {...scenario, id: 'duplicate', requirementIds: ['req-cache', 'req-cache']},
        {...scenario, id: 'duplicate'},
      ],
    });
    expect(issueCodes(duplicate)).toEqual(expect.arrayContaining(['duplicate-id', 'duplicate-reference']));
    const sourceLess = validSpec({source: null, context: {...context, codeRefs: []}});
    expect(issueCodes(sourceLess)).toContain('source-required');

    const intentHash = nativeSpecIntentDigest(spec);
    const documentHash = nativeAuthoringDigest(spec);
    const accepted = validateNativeAuthoring(spec, {
      ready: true,
      confirmation: {decision: 'approved', intentHash, response: 'Approved the requirements and acceptance criteria.'},
      review: {documentHash, outcome: 'accepted', blockingIssueCount: 0},
    });
    expect(accepted).toMatchObject({ready: true, documentHash, intentHash, issues: []});
    const stale = validateNativeAuthoring(spec, {
      ready: true,
      confirmation: {
        decision: 'approved',
        intentHash: Effect.pipe('0', EffectString.repeat(64)),
        response: 'Approved.',
      },
      review: {
        documentHash: Effect.pipe('0', EffectString.repeat(64)),
        outcome: 'changes-requested',
        blockingIssueCount: 1,
      },
    });
    expect(stale.ready).toBe(false);
    expect(EffectArray.map(stale.issues, issue => issue.code)).toEqual(
      expect.arrayContaining(['confirmation-required', 'review-required']),
    );
    const unresolved = validSpec({
      questions: [{id: 'q-cache', question: 'How long?', impact: 'Affects expiry.', disposition: 'open'}],
    });
    expect(validateNativeAuthoring(unresolved).issues).toEqual([]);
    expect(issueCodes(unresolved)).not.toContain('open-question');
    expect(
      EffectArray.map(
        validateNativeAuthoring(unresolved, {
          ready: true,
          confirmation: {decision: 'approved', intentHash: nativeSpecIntentDigest(unresolved), response: 'Approved'},
        }).issues,
        issue => issue.code,
      ),
    ).toContain('open-question');
  });

  it('checks plan references, exact linked requirements, acyclic phase order, decisions, and ready gates', () => {
    const plan = validPlan();
    expect(validateNativeAuthoring(plan)).toMatchObject({ready: false, issues: []});
    const planIntent = nativeAuthoringDigest(plan);
    const validReady = validateNativeAuthoring(plan, {
      ready: true,
      confirmation: {decision: 'approved', intentHash: planIntent, response: 'Approved implementation plan.'},
      review: {documentHash: planIntent, outcome: 'accepted', blockingIssueCount: 0},
    });
    expect(validReady).toMatchObject({ready: true, issues: []});
    const legacyReady = validateNativeAuthoring(plan, {
      ready: true,
      planIntentPolicyVersion: 1,
      review: {documentHash: planIntent, outcome: 'accepted', blockingIssueCount: 0},
    });
    expect(legacyReady).toMatchObject({ready: true, documentHash: planIntent, intentHash: planIntent, issues: []});
    const evidenceRefresh = validPlan({context: {...context, note: 'Updated source context.'}});
    expect(nativeSpecIntentDigest(evidenceRefresh)).toBe(nativeSpecIntentDigest(plan));
    expect(
      validateNativeAuthoring(evidenceRefresh, {
        ready: true,
        review: {documentHash: planIntent, outcome: 'accepted', blockingIssueCount: 0},
      }).issues,
    ).toEqual(expect.arrayContaining([expect.objectContaining({code: 'review-required'})]));
    expect(
      validateNativeAuthoring(evidenceRefresh, {
        ready: true,
        review: {
          documentHash: nativeAuthoringDigest(evidenceRefresh),
          outcome: 'accepted',
          blockingIssueCount: 0,
        },
      }).ready,
    ).toBe(true);
    expect(() =>
      validPlan({
        current: {...asPlan(validPlan()).current, summary: ''},
      }),
    ).toThrow();

    const proseArchitecture = validPlan({
      current: {
        ...asPlan(validPlan()).current,
        diagram: 'graph traversal follows imports and returns the cached result.',
      },
      target: {...asPlan(validPlan()).target, diagram: ''},
    });
    const proseReady = validateNativeAuthoring(proseArchitecture, {
      ready: true,
      confirmation: {
        decision: 'approved',
        intentHash: nativeAuthoringDigest(proseArchitecture),
        response: 'Approved implementation plan.',
      },
      review: {
        documentHash: nativeAuthoringDigest(proseArchitecture),
        outcome: 'accepted',
        blockingIssueCount: 0,
      },
    });
    expect(proseReady).toMatchObject({ready: true, issues: []});

    const changedRequirement = validPlan({
      requirements: [{id: 'req-cache', behavior: 'Fresh entries only are returned.'}],
    });
    expect(issueCodes(changedRequirement)).toContain('linked-spec-requirements-changed');
    const basePhase = asPlan(validPlan()).phases[0];
    const baseAcceptance = basePhase.acceptance[0];
    const badReferences = validPlan({
      phases: [
        {
          ...basePhase,
          dependsOn: ['missing-phase'],
          acceptance: [
            {
              ...baseAcceptance,
              requirementIds: ['missing-requirement'],
              scenarioIds: ['missing-scenario'],
            },
          ],
        },
      ],
    });
    expect(issueCodes(badReferences)).toEqual(
      expect.arrayContaining([
        'unknown-reference',
        'unknown-scenario-reference',
        'requirement-uncovered',
        'scenario-uncovered',
      ]),
    );
    const cycle = validPlan({
      phases: EffectArray.map(
        [
          ...asPlan(validPlan()).phases,
          {
            ...basePhase,
            id: 'phase-cycle',
            dependsOn: ['phase-cache-check'],
          },
        ],
        phase => (phase.id === 'phase-cache-check' ? {...phase, dependsOn: ['phase-cycle']} : phase),
      ),
    });
    expect(issueCodes(cycle)).toContain('phase-dependency-cycle');
    const selfDependency = validPlan({
      phases: [{...basePhase, dependsOn: ['phase-cache-check']}],
    });
    expect(issueCodes(selfDependency)).toEqual(
      expect.arrayContaining(['phase-self-dependency', 'phase-dependency-cycle']),
    );

    const draftWithoutDecision = validPlan({decisions: [], openQuestions: ['Choose a release window.']});
    expect(validateNativeAuthoring(draftWithoutDecision)).toMatchObject({ready: false, issues: []});
    const notReady = validateNativeAuthoring(draftWithoutDecision, {
      ready: true,
      confirmation: {
        decision: 'approved',
        intentHash: nativeAuthoringDigest(draftWithoutDecision),
        response: 'Approved.',
      },
    });
    expect(notReady.ready).toBe(false);
    expect(EffectArray.map(notReady.issues, issue => issue.code)).toEqual(
      expect.arrayContaining(['open-question', 'decision-required']),
    );
    const invalidDiagram = validPlan({
      current: {...asPlan(validPlan()).current, diagram: '```mermaid\nflowchart TD\n```'},
    });
    expect(
      EffectArray.map(
        validateNativeAuthoring(invalidDiagram, {
          ready: true,
          confirmation: {
            decision: 'approved',
            intentHash: nativeAuthoringDigest(invalidDiagram),
            response: 'Approved.',
          },
        }).issues,
        issue => issue.code,
      ),
    ).toContain('diagram-invalid');

    const proseDiagram = validPlan({
      current: {
        ...asPlan(validPlan()).current,
        diagram: 'The reader checks freshness before it returns a cached entry.',
      },
    });
    expect(issueCodes(proseDiagram)).not.toContain('diagram-invalid');
  });

  it('projects one compact intent into the canonical plan and requires exact intent confirmation', () => {
    const result = projectNativeCompactIntent(
      compactInput(),
      {featureId: 'cache-refresh', project: 'threadnote'},
      compactSource,
    );
    expect(result.status).toBe('eligible');
    if (result.status !== 'eligible' || result.document.kind !== 'plan') throw new Error('Expected compact plan.');
    const plan = result.document;
    expect(plan).toMatchObject({
      kind: 'plan',
      compactOrigin: {version: 1, expanded: false},
      current: {summary: compactInput().currentBehavior, components: []},
      target: {summary: compactInput().desiredChange, components: []},
      phases: [
        {dependsOn: [], affectedPaths: ['src/cache.ts'], acceptance: [{criterion: compactInput().acceptanceCriterion}]},
      ],
      decisions: [],
    });
    expect(validateNativeAuthoring(plan, {ready: true})).toMatchObject({
      ready: false,
      issues: expect.arrayContaining([expect.objectContaining({code: 'confirmation-required'})]),
    });
    const validation = validateNativeAuthoring(plan, {
      ready: true,
      confirmation: {
        intentHash: nativeSpecIntentDigest(plan),
        decision: 'approved',
        response: 'I approve this exact compact behavior and scope.',
      },
    });
    expect(validation).toMatchObject({ready: true, issues: []});
    expect(
      validateNativeAuthoring(plan, {
        ready: true,
        confirmation: {
          intentHash: nativeSpecIntentDigest({...plan, target: {...plan.target, summary: 'A changed intent.'}}),
          decision: 'approved',
          response: 'I approve this exact compact behavior and scope.',
        },
      }).ready,
    ).toBe(false);
  });

  it('returns the exact planning decision for ineligible compact intent without constructing a plan', () => {
    const result = projectNativeCompactIntent(
      compactInput({
        eligibility: {
          status: 'needs-planning',
          missingDecision: 'Choose whether expired cache entries should refresh synchronously or in the background.',
          evidenceRefs: ['threadnote://user/me/memories/durable/projects/threadnote/cache.md'],
        },
      }),
      {featureId: 'cache-refresh', project: 'threadnote'},
      compactSource,
    );
    expect(result).toMatchObject({
      status: 'needs-planning',
      missingDecision: 'Choose whether expired cache entries should refresh synchronously or in the background.',
      evidenceRefs: ['threadnote://user/me/memories/durable/projects/threadnote/cache.md'],
    });
  });

  it('keeps compact projection deterministic, idempotent and nonmutating across bounded prose inputs', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{0,32}$/u),
        fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{0,32}$/u),
        (currentBehavior, desiredChange) => {
          fc.pre(EffectString.trim(currentBehavior) !== EffectString.trim(desiredChange));
          const input = compactInput({currentBehavior, desiredChange});
          const before = JSON.stringify(input);
          const first = projectNativeCompactIntent(
            input,
            {featureId: 'cache-refresh', project: 'threadnote'},
            compactSource,
          );
          const second = projectNativeCompactIntent(
            input,
            {featureId: 'cache-refresh', project: 'threadnote'},
            compactSource,
          );
          expect(first.status).toBe('eligible');
          expect(second.status).toBe('eligible');
          if (first.status !== 'eligible' || second.status !== 'eligible') return;
          expect(nativeAuthoringDigest(first.document)).toBe(nativeAuthoringDigest(second.document));
          expect(nativeSpecIntentDigest(first.document)).toBe(nativeSpecIntentDigest(second.document));
          if (first.document.kind !== 'plan' || !first.document.compactOrigin)
            throw new Error('The compact marker must remain in the canonical plan.');
          expect(
            nativeSpecIntentDigest({
              ...first.document,
              compactOrigin: {
                ...first.document.compactOrigin,
                eligibilityRationale: first.document.compactOrigin.eligibilityRationale + ' Reclassified.',
              },
            }),
          ).not.toBe(nativeSpecIntentDigest(first.document));
          expect(JSON.stringify(input)).toBe(before);
        },
      ),
      {numRuns: 40},
    );
  });
});
