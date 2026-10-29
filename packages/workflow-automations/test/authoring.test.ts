import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  canonicalAuthoringJson,
  decodeNativeAuthoringDocument,
  nativeAuthoringDigest,
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

describe('native authoring documents', () => {
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
    expect(nativeSpecIntentDigest(plan)).toBe(nativeAuthoringDigest(plan));
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
  });
});
