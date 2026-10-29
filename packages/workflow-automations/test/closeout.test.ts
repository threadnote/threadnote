import {Array as EffectArray} from 'effect';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {
  decodeNativeAuthoringDocument,
  nativeAuthoringDigest,
  nativeSpecIntentDigest,
  type NativeAuthoringDocument,
} from '../src/authoring.js';
import {decodeNativeCyclePlan, initializeNativeCycle, validateNativeCyclePhase} from '../src/cycle.js';
import {decodeNativeCloseoutProposal, prepareNativeCloseout} from '../src/closeout.js';
import {renderNativeDocument} from '../src/documents.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const digest = Effect.pipe('c', EffectString.repeat(64));
const common = {
  format: 'threadnote-native-authoring',
  schemaVersion: 1,
  id: 'feature',
  project: 'project',
  title: 'Example feature',
  objective: 'Implement verified behavior.',
  requirements: [{id: 'req', behavior: 'Retain complete results.'}],
  context: {codeRefs: [], evidenceRefs: [], note: 'Fixture evidence.'},
  source: null,
  sourceFreeReason: 'Synthetic fixture.',
};
const architecture = {
  summary: 'Existing implementation.',
  components: ['Reader'],
  contracts: ['Preserve identity.'],
  diagram: 'flowchart TD\n Reader --> Store',
};
const spec = () =>
  decodeNativeAuthoringDocument({
    ...common,
    kind: 'spec',
    actors: ['User'],
    inScope: ['Reading'],
    outOfScope: [],
    constraints: [],
    observations: [],
    scenarios: EffectArray.map(['read', 'retry'], id => ({
      id,
      requirementIds: ['req'],
      given: 'Saved input.',
      when: id + ' is requested.',
      then: 'Complete output.',
    })),
    assumptions: [],
    questions: [],
    artifacts: [],
    review: {required: false, reason: 'Fixture.'},
  });
function fixture(
  withSpec = false,
  change?: (plan: Extract<NativeAuthoringDocument, {kind: 'plan'}>) => Extract<NativeAuthoringDocument, {kind: 'plan'}>,
) {
  let proposalPlan = decodeNativeAuthoringDocument({
    ...common,
    kind: 'plan',
    current: architecture,
    target: architecture,
    phases: EffectArray.map(['one', 'two'], (id, index) => ({
      id,
      title: id,
      outcome: 'Working ' + id,
      dependsOn: index ? ['one'] : [],
      affectedPaths: ['src/a.ts'],
      newPaths: [],
      contracts: ['No identity changes.'],
      acceptance: EffectArray.map(['first', 'second'], (label, n) => ({
        id: id + '-' + n,
        criterion: id + ' ' + label,
        verification: 'Inspect output.',
        requirementIds: ['req'],
      })),
      safeBoundary: 'Useful independent phase.',
    })),
    decisions: EffectArray.map(['first', 'second'], id => ({
      id,
      question: 'How to implement ' + id + '?',
      selection: 'retain',
      selected: 'Retained design ' + id,
      alternatives: [{id: 'rejected', design: 'Rejected design ' + id, tradeoffs: 'Adds complexity.'}],
      rationale: 'Original full rationale ' + id + ' ' + Effect.pipe('original rationale. ', EffectString.repeat(80)),
      affectedPhases: ['one'],
      authority: 'orchestrator',
    })),
    openQuestions: [],
    review: {required: false, reason: 'Fixture.'},
  });
  if (proposalPlan.kind !== 'plan') throw new Error('Expected fixture plan.');
  const behavior = withSpec ? spec() : undefined;
  if (behavior?.kind === 'spec')
    proposalPlan = {
      ...proposalPlan,
      spec: {
        root: {uri: 'threadnote://user/test/spec', memoryId: 'tn_spec', revision: digest},
        binding: {bindingId: digest, runId: 'spec-run', generation: 'gen', profile: 'desktop'},
        documentHash: nativeAuthoringDigest(behavior),
        intentHash: nativeSpecIntentDigest(behavior),
        requirements: behavior.requirements,
        scenarios: behavior.scenarios,
      },
    };
  proposalPlan = change?.(proposalPlan) ?? proposalPlan;
  const plan = decodeNativeAuthoringDocument(proposalPlan);
  if (plan.kind !== 'plan') throw new Error('Expected plan.');
  const cyclePlan = decodeNativeCyclePlan({
    format: 'threadnote-native-cycle-plan',
    version: 1,
    featureId: plan.id,
    project: plan.project,
    objective: plan.objective,
    delivery: 'local',
    source: {
      root: {uri: 'threadnote://user/test/plan', memoryId: 'tn_plan', revision: digest},
      binding: {bindingId: digest, runId: 'run', generation: 'gen', profile: 'desktop'},
      documentHash: nativeAuthoringDigest(plan),
    },
    completion: {},
    phases: EffectArray.map(plan.phases, (phase, index) => ({
      id: phase.id,
      definitionHash: Effect.pipe(String(index + 1), EffectString.repeat(64)),
      title: phase.title,
      dependsOn: phase.dependsOn,
      allowedPaths: ['src/'],
      acceptanceCriteria: EffectArray.map(phase.acceptance, item => item.criterion),
      safeToMergeReason: phase.safeBoundary,
      branch: 'feature/' + phase.id,
      baseBranch: 'main',
      status: 'pending',
      acceptanceRefs: EffectArray.map(phase.acceptance, item => ({
        id: item.id,
        criterion: item.criterion,
        requirements: item.requirementIds,
        specScenarios: [],
      })),
    })),
  });
  const initial = initializeNativeCycle(cyclePlan);
  let state = initial;
  for (const phase of cyclePlan.phases)
    state = validateNativeCyclePhase(
      state,
      phase.id,
      {
        head: Effect.pipe('a', EffectString.repeat(40)),
        tree: Effect.pipe('b', EffectString.repeat(40)),
        files: ['src/a.ts'],
      },
      {
        snapshotTree: Effect.pipe('b', EffectString.repeat(40)),
        status: 'passed',
        productState: 'working',
        checks: [{command: 'check', result: 'passed', evidence: 'Passed fixture.'}],
        acceptance: EffectArray.map(phase.acceptanceCriteria, criterion => ({
          criterion,
          result: 'passed',
          evidence: 'Verified fixture.',
        })),
      },
    );
  const proposal = decodeNativeCloseoutProposal({
    architecture: {
      ...architecture,
      summary: 'Actual implemented design.',
      invariants: ['Identity remains stable.'],
      unknowns: ['No load evidence beyond fixture.'],
      deviations: ['Adapted second choice.'],
      codeRefs: ['src/a.ts'],
    },
    architectureVerification: 'Inspected actual code and tests.',
    combinedChecks: [{command: 'check combined', result: 'passed', evidence: 'Passed all phases together.'}],
    phaseEvidence: EffectArray.map(cyclePlan.phases, phase => ({
      id: phase.id,
      acceptance: EffectArray.map(phase.acceptanceCriteria, criterion => ({
        criterion,
        evidence: 'Observed ' + criterion,
      })),
    })),
    scenarios:
      behavior?.kind === 'spec'
        ? EffectArray.map(behavior.scenarios, scenario => ({id: scenario.id, evidence: 'Observed ' + scenario.id}))
        : [],
    ...(behavior ? {behaviorVerification: 'Verified approved behavior.'} : {}),
    decisions: EffectArray.map(plan.decisions, item => ({
      id: item.id,
      implemented: item.id === 'second' ? 'Adapted actual design' : item.selected,
      rationale: 'Actual implementation explanation ' + item.id,
    })),
  });
  return {plan, state, initial, proposal, spec: behavior};
}

describe('pure native closeout admission', () => {
  it('bounds composed display titles and retains complete maximum-length feature titles and rationale', () => {
    for (const title of [
      Effect.pipe('x', EffectString.repeat(256)),
      Effect.pipe('x', EffectString.repeat(234)) + Effect.pipe('🧭', EffectString.repeat(5)),
    ]) {
      const f = fixture(true, plan => ({...plan, title}));
      const result = prepareNativeCloseout(f.state, f.plan, f.proposal, f.spec);
      for (const document of [
        result.documents.architecture,
        ...result.documents.decisions,
        result.documents.handoff,
        result.documents.behavior!,
      ]) {
        expect(document.title.length).toBeLessThanOrEqual(256);
        expect(document.title).not.toMatch(/[\uD800-\uDFFF]/u);
      }
      expect(renderNativeDocument(result.documents.handoff)).toContain(title);
      expect(renderNativeDocument(result.documents.decisions[0])).toContain(f.plan.decisions[0].rationale);
    }
  });
  it('requires completed cycle and exact pinned plan identity/hash', () => {
    const f = fixture();
    expect(() => prepareNativeCloseout(f.initial, f.plan, f.proposal)).toThrow();
    expect(() => prepareNativeCloseout(f.state, {...f.plan, objective: 'Changed.'}, f.proposal)).toThrow();
    expect(() => prepareNativeCloseout(f.state, {...f.plan, project: 'other'}, f.proposal)).toThrow();
  });
  it('renders actual architecture and preserves original decisions separately from implementation deviations', () => {
    const f = fixture();
    const before = JSON.stringify(f);
    const result = prepareNativeCloseout(f.state, f.plan, f.proposal);
    expect(JSON.stringify(f)).toBe(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.decisions[0].planned)).toBe(true);
    const architecture = renderNativeDocument(result.documents.architecture);
    expect(result.documents.architecture.kind).toBe('architecture-current');
    expect(architecture).toContain('Actual implemented design.');
    expect(architecture).toContain('Identity remains stable.');
    expect(architecture).toContain('Adapted second choice.');
    const decision = renderNativeDocument(result.documents.decisions[1]);
    expect(decision).toContain(f.plan.decisions[1].rationale);
    expect(decision).toContain('Actual implemented choice: Adapted actual design');
    expect(decision).toContain('Rejected design second');
    expect(decision).not.toContain('Actual implemented choice: Rejected design second');
    const mutable = {
      ...f.proposal,
      architecture: {...f.proposal.architecture, components: [...f.proposal.architecture.components]},
    };
    const isolated = prepareNativeCloseout(f.state, f.plan, mutable);
    mutable.architecture.components.push('Later mutation');
    expect(isolated.architecture.components).toEqual(['Reader']);
  });
  it('requires nonblank evidence and exact phase/criterion/decision membership', () => {
    const f = fixture();
    for (const proposal of [
      {...f.proposal, architectureVerification: ' '},
      {...f.proposal, combinedChecks: []},
      {...f.proposal, phaseEvidence: f.proposal.phaseEvidence.slice(1)},
      {...f.proposal, decisions: []},
      {...f.proposal, decisions: EffectArray.map(f.proposal.decisions, item => ({...item, rationale: ''}))},
      {
        ...f.proposal,
        phaseEvidence: EffectArray.map(f.proposal.phaseEvidence, item => ({
          ...item,
          acceptance: item.acceptance.slice(1),
        })),
      },
      {...f.proposal, phaseEvidence: [...f.proposal.phaseEvidence, {...f.proposal.phaseEvidence[0], id: 'extra'}]},
    ])
      expect(() => prepareNativeCloseout(f.state, f.plan, proposal)).toThrow();
  });
  it('requires matching spec identity, pin and complete scenario evidence with behavior verification', () => {
    const f = fixture(true);
    const result = prepareNativeCloseout(f.state, f.plan, f.proposal, f.spec);
    expect(result.documents.behavior?.kind).toBe('spec');
    expect(EffectArray.map(result.scenarios, item => item.scenario.id)).toEqual(['read', 'retry']);
    const content = renderNativeDocument(result.documents.behavior!);
    expect(content).toContain('Retain complete results.');
    expect(content).toContain('Observed retry');
    expect(() =>
      prepareNativeCloseout(f.state, f.plan, {...f.proposal, behaviorVerification: undefined}, f.spec),
    ).toThrow();
    expect(() => prepareNativeCloseout(f.state, f.plan, {...f.proposal, scenarios: []}, f.spec)).toThrow();
    expect(() =>
      prepareNativeCloseout(
        f.state,
        f.plan,
        f.proposal,
        f.spec ? {...f.spec, objective: 'Changed approved intent.'} : undefined,
      ),
    ).toThrow();
    expect(() => prepareNativeCloseout(f.state, f.plan, f.proposal)).toThrow();
  });
  it('rejects unsupported proposal fields, unsafe source paths and invalid Mermaid', () => {
    const f = fixture();
    for (const proposal of [
      {...f.proposal, extra: true},
      {...f.proposal, architecture: {...f.proposal.architecture, diagram: '```mermaid\nflowchart TD\n```'}},
      ...EffectArray.map(['../secret', '/absolute', 'C:\\secret', 'src//a.ts', 'src/a.ts:2'], path => ({
        ...f.proposal,
        architecture: {...f.proposal.architecture, codeRefs: [path]},
      })),
    ])
      expect(() => prepareNativeCloseout(f.state, f.plan, proposal)).toThrow();
  });
  it('rejects a document over 60000 bytes instead of truncating original rationale or alternatives', () => {
    const f = fixture(false, plan => ({
      ...plan,
      decisions: [
        {
          ...plan.decisions[0],
          selected: Effect.pipe('s', EffectString.repeat(8192)),
          rationale: Effect.pipe('r', EffectString.repeat(8192)),
          alternatives: [
            {
              id: 'a',
              design: Effect.pipe('d', EffectString.repeat(8192)),
              tradeoffs: Effect.pipe('t', EffectString.repeat(8192)),
            },
            {
              id: 'b',
              design: Effect.pipe('d', EffectString.repeat(8192)),
              tradeoffs: Effect.pipe('t', EffectString.repeat(8192)),
            },
          ],
        },
        ...plan.decisions.slice(1),
      ],
    }));
    const proposal = {
      ...f.proposal,
      decisions: EffectArray.map(f.proposal.decisions, item =>
        item.id === 'first'
          ? {
              ...item,
              implemented: Effect.pipe('i', EffectString.repeat(8192)),
              rationale: Effect.pipe('e', EffectString.repeat(8192)),
            }
          : item,
      ),
    };
    expect(() => prepareNativeCloseout(f.state, f.plan, proposal)).toThrow();
  });
  it('normalizes membership permutations deterministically and rejects duplicated evidence', () => {
    const f = fixture(true);
    const expected = prepareNativeCloseout(f.state, f.plan, f.proposal, f.spec);
    fc.assert(
      fc.property(
        fc.tuple(...Array.from({length: 4}, () => fc.shuffledSubarray([0, 1], {minLength: 2, maxLength: 2}))),
        orders => {
          const [phases, criteria, decisions, scenarios] = orders;
          const proposal = {
            ...f.proposal,
            phaseEvidence: EffectArray.map(phases, i => ({
              ...f.proposal.phaseEvidence[i],
              acceptance: EffectArray.map(criteria, j => f.proposal.phaseEvidence[i].acceptance[j]),
            })),
            decisions: EffectArray.map(decisions, i => f.proposal.decisions[i]),
            scenarios: EffectArray.map(scenarios, i => f.proposal.scenarios[i]),
          };
          expect(prepareNativeCloseout(f.state, f.plan, proposal, f.spec)).toEqual(expected);
          expect(() =>
            prepareNativeCloseout(
              f.state,
              f.plan,
              {...proposal, scenarios: [proposal.scenarios[0], proposal.scenarios[0]]},
              f.spec,
            ),
          ).toThrow();
          expect(() =>
            prepareNativeCloseout(
              f.state,
              f.plan,
              {...proposal, decisions: [proposal.decisions[0], proposal.decisions[0]]},
              f.spec,
            ),
          ).toThrow();
        },
      ),
      {numRuns: 24},
    );
  });
});
