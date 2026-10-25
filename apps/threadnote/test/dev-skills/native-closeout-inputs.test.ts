import {it as effectIt} from '@effect/vitest';
import {Effect, Option} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {SystemInfo} from '@threadnote/platform/system';
import {runCommandEffect} from '@threadnote/platform/command';
import {readPathFileSystemAuthority, sameFileSystemIdentity} from '@threadnote/platform/system';
import {
  decodeNativeAuthoringDocument,
  nativeAuthoringDigest,
  nativeSpecIntentDigest,
} from '@threadnote/workflow-automations/authoring';
import {
  decodeNativeCyclePlan,
  decodeNativeCycleState,
  initializeNativeCycle,
  validateNativeCyclePhase,
} from '@threadnote/workflow-automations/cycle';
import {nativeFixture, provideNative} from './native-automation-fixture.js';
import {loadNativeCloseoutInputs} from '../../src/workflow_automation/closeout_inputs.js';
import {
  readNativeWorkflowState,
  writeNativeWorkflowState,
  withNativeWorkflowLock,
} from '../../src/workflow_automation/store.js';
import type {NativeAuthoringCall} from '../../src/workflow_automation/authoring_artifacts.js';
import {AuthoringReferenceSchema} from '../../src/workflow_automation/authoring_artifacts.js';
import {Schema} from 'effect';

const generation = 'skill-generation-v1';
const common = {
  format: 'threadnote-native-authoring',
  schemaVersion: 1,
  id: 'feature',
  project: 'fixture',
  title: 'Closeout fixture',
  objective: 'Retain complete verified behavior.',
  requirements: [{id: 'req', behavior: 'Reader receives complete result.'}],
  context: {codeRefs: [], evidenceRefs: [], note: 'Private fixture.'},
  source: null,
  sourceFreeReason: 'A private source-free fixture.',
};
const specDocument = () =>
  decodeNativeAuthoringDocument({
    ...common,
    kind: 'spec',
    actors: ['Reader'],
    inScope: ['Reading'],
    outOfScope: [],
    constraints: [],
    observations: [],
    scenarios: [
      {
        id: 'read',
        requirementIds: ['req'],
        given: 'Saved data.',
        when: 'Reader requests it.',
        then: 'Complete result.',
      },
    ],
    assumptions: [],
    questions: [],
    artifacts: [],
    review: {required: false, reason: 'Private fixture.'},
  });
const planDocument = () =>
  decodeNativeAuthoringDocument({
    ...common,
    kind: 'plan',
    current: {summary: 'Local data.', components: ['Store'], contracts: [], diagram: 'flowchart TD\n Reader --> Store'},
    target: {
      summary: 'Verified data.',
      components: ['Store', 'Reader'],
      contracts: ['Complete result.'],
      diagram: 'flowchart TD\n Reader --> Store',
    },
    phases: [
      {
        id: 'one',
        title: 'One',
        outcome: 'Working reader.',
        dependsOn: [],
        affectedPaths: ['source.ts'],
        newPaths: [],
        contracts: [],
        acceptance: [
          {
            id: 'read-complete',
            criterion: 'Reader receives complete data.',
            verification: 'Inspect result.',
            requirementIds: ['req'],
          },
        ],
        safeBoundary: 'Independent reader behavior.',
      },
    ],
    decisions: [
      {
        id: 'retain',
        question: 'Which storage?',
        selection: 'retain',
        selected: 'Existing store.',
        alternatives: [],
        rationale: 'Avoid unnecessary replacement.',
        affectedPhases: ['one'],
        authority: 'orchestrator',
      },
    ],
    openQuestions: [],
    review: {required: false, reason: 'Private fixture.'},
  });
const loadedRootSchema = Schema.Struct({
  authoring: Schema.Struct({root: AuthoringReferenceSchema, readiness: Schema.Literal('ready')}),
});
const setup = Effect.fn('test.closeoutInputs.setup')(function* (withSpec = false) {
  const f = yield* nativeFixture();
  yield* runCommandEffect('git', ['-C', f.repo, 'add', 'source.ts']);
  yield* runCommandEffect('git', [
    '-C',
    f.repo,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Private fixture',
  ]);
  const system = yield* SystemInfo;
  const scopedSystem = {...system, currentDirectory: () => f.repo, environment: () => ({})};
  let plan = planDocument();
  if (plan.kind !== 'plan') throw new Error('Expected plan.');
  if (withSpec) {
    yield* f.init('spec-run');
    const spec = specDocument();
    const saved = yield* f.call({
      ...f.base('authoring', 'spec-run'),
      command: 'save',
      document: spec,
      ready: true,
      expectedRevision: null,
      confirmation: {
        intentHash: nativeSpecIntentDigest(spec),
        decision: 'approved',
        response: 'Approve private fixture requirements.',
      },
    });
    const root = (yield* Schema.decodeUnknownEffect(loadedRootSchema)(saved)).authoring.root;
    const specState = yield* readNativeWorkflowState(f.config, 'spec-run');
    if (!specState || spec.kind !== 'spec') throw new Error('Expected spec state.');
    plan = decodeNativeAuthoringDocument({
      ...plan,
      phases: plan.phases.map(phase => ({
        ...phase,
        acceptance: phase.acceptance.map(item => ({...item, scenarioIds: ['read']})),
      })),
      spec: {
        root,
        binding: {bindingId: specState.state.bindingId, runId: 'spec-run', generation, profile: 'desktop'},
        documentHash: nativeAuthoringDigest(spec),
        intentHash: nativeSpecIntentDigest(spec),
        requirements: spec.requirements,
        scenarios: spec.scenarios,
      },
    });
  }
  yield* f.init('plan-run');
  const saved = yield* f.call({
    ...f.base('authoring', 'plan-run'),
    command: 'save',
    document: plan,
    ready: true,
    expectedRevision: null,
  });
  const planRoot = (yield* Schema.decodeUnknownEffect(loadedRootSchema)(saved)).authoring.root;
  const planState = yield* readNativeWorkflowState(f.config, 'plan-run');
  if (!planState || plan.kind !== 'plan') throw new Error('Expected plan state.');
  yield* f.call({
    ...f.write({artifactKey: 'unrelated', role: 'evidence', body: 'Unrelated active native evidence.\n'}),
    runId: 'plan-run',
  });
  yield* f.init('controller');
  const controller = yield* readNativeWorkflowState(f.config, 'controller');
  if (!controller) throw new Error('Expected controller.');
  const cyclePlan = decodeNativeCyclePlan({
    format: 'threadnote-native-cycle-plan',
    version: 1,
    featureId: 'feature',
    project: 'fixture',
    objective: plan.objective,
    delivery: 'local',
    source: {
      root: planRoot,
      binding: {bindingId: planState.state.bindingId, runId: 'plan-run', generation, profile: 'desktop'},
      documentHash: nativeAuthoringDigest(plan),
    },
    completion: {},
    phases: [
      {
        id: 'one',
        definitionHash: '1'.repeat(64),
        title: 'One',
        dependsOn: [],
        allowedPaths: ['source.ts'],
        acceptanceCriteria: ['Reader receives complete data.'],
        safeToMergeReason: 'Independent fixture.',
        branch: 'fixture/one',
        baseBranch: 'main',
        status: 'pending',
        acceptanceRefs: [
          {id: 'read-complete', criterion: 'Reader receives complete data.', requirements: ['req'], specScenarios: []},
        ],
      },
    ],
  });
  const cycle = validateNativeCyclePhase(
    initializeNativeCycle(cyclePlan),
    'one',
    {head: 'a'.repeat(40), tree: 'b'.repeat(40), files: ['source.ts']},
    {
      snapshotTree: 'b'.repeat(40),
      status: 'passed',
      productState: 'working',
      checks: [{command: 'fixture check', result: 'passed', evidence: 'Observed.'}],
      acceptance: [
        {criterion: 'Reader receives complete data.', result: 'passed', evidence: 'Observed complete result.'},
      ],
    },
  );
  yield* withNativeWorkflowLock(
    f.config,
    'controller',
    false,
    writeNativeWorkflowState(
      f.config,
      {
        ...controller.state,
        cycle: {
          state: decodeNativeCycleState(cycle),
          plans: [cyclePlan],
          baselines: {},
          reviewLimits: {},
          reviewExpansions: [],
          snapshots: [],
          reviews: [],
          attempts: [],
        },
      },
      controller.revision,
    ),
  );
  const load = (call: NativeAuthoringCall<Effect.Services<ReturnType<typeof f.call>>> = f.call) =>
    loadNativeCloseoutInputs(f.config, 'controller', generation, call).pipe(
      Effect.provideService(SystemInfo, scopedSystem),
    );
  return {...f, plan, planRoot, load};
});
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(TestClock.withLive, provideNative);

effectIt.effect('admits clean current source and only active original authoring-owned artifacts without writes', () =>
  Effect.gen(function* () {
    const f = yield* setup();
    const before = yield* f.fs.readFileString(f.statePath('controller'));
    const result = yield* f.load();
    expect(result.planRoot).toEqual(f.planRoot);
    expect(result.plan).toEqual(f.plan);
    const gitRoot = (yield* runCommandEffect('git', [
      '--no-optional-locks',
      '-C',
      f.repo,
      'rev-parse',
      '--show-toplevel',
    ])).stdout.trim();
    const canonicalGitRoot = yield* f.fs.realPath(gitRoot);
    const fixtureRoot = yield* f.fs.realPath(f.repo);
    const gitAuthority = yield* readPathFileSystemAuthority(canonicalGitRoot, 'Directory');
    const fixtureAuthority = yield* readPathFileSystemAuthority(fixtureRoot, 'Directory');
    expect(Option.isSome(gitAuthority) && Option.isSome(fixtureAuthority)).toBe(true);
    if (Option.isSome(gitAuthority) && Option.isSome(fixtureAuthority))
      expect(sameFileSystemIdentity(gitAuthority.value, fixtureAuthority.value)).toBe(true);
    expect(result.source.repo).toBe(canonicalGitRoot);
    expect(result.source.head).toMatch(/^[a-f0-9]{40}$/u);
    expect(result.source.tree).toMatch(/^[a-f0-9]{40}$/u);
    expect(result.owned.length).toBeGreaterThan(0);
    expect(
      result.owned.every(
        item => item.runId === 'plan-run' && item.sourceRunId === 'plan-run' && item.role.startsWith('authoring-'),
      ),
    ).toBe(true);
    expect(result.owned.some(item => item.artifactKey === 'unrelated')).toBe(false);
    expect(new Set(result.owned.map(item => item.bindingId + '\n' + item.uri)).size).toBe(result.owned.length);
    expect(yield* f.fs.readFileString(f.statePath('controller'))).toBe(before);
  }).pipe(run),
);

effectIt.effect('loads approved linked spec from its separate original authoring binding', () =>
  Effect.gen(function* () {
    const f = yield* setup(true);
    const result = yield* f.load();
    expect(result.spec).toEqual(specDocument());
    expect(new Set(result.owned.map(item => item.runId))).toEqual(new Set(['plan-run', 'spec-run']));
    expect(new Set(result.owned.map(item => item.bindingId)).size).toBe(2);
  }).pipe(run),
);

effectIt.effect('rejects missing cycle, generation drift, loaded root drift and dirty source', () =>
  Effect.gen(function* () {
    const f = yield* nativeFixture();
    yield* f.init();
    expect((yield* loadNativeCloseoutInputs(f.config, 'native-run', generation, f.call).pipe(Effect.result))._tag).toBe(
      'Failure',
    );
    expect(
      (yield* loadNativeCloseoutInputs(f.config, 'native-run', 'wrong-generation', f.call).pipe(Effect.result))._tag,
    ).toBe('Failure');
    const ready = yield* setup();
    const drift = (request: unknown) =>
      ready.call(request).pipe(
        Effect.map(value => {
          if (
            request &&
            typeof request === 'object' &&
            'command' in request &&
            request.command === 'load' &&
            value &&
            typeof value === 'object' &&
            'authoring' in value &&
            value.authoring &&
            typeof value.authoring === 'object'
          ) {
            const parsed = Schema.decodeUnknownSync(loadedRootSchema)(value);
            return {
              ...value,
              authoring: {...value.authoring, root: {...parsed.authoring.root, revision: 'f'.repeat(64)}},
            };
          }
          return value;
        }),
      );
    expect((yield* ready.load(drift).pipe(Effect.result))._tag).toBe('Failure');
    yield* ready.fs.writeFileString(ready.path.join(ready.repo, 'source.ts'), 'export const changed = true;\n');
    expect((yield* ready.load().pipe(Effect.result))._tag).toBe('Failure');
  }).pipe(run),
);

effectIt.effect('rejects a missing owned artifact rather than silently dropping retirement inventory', () =>
  Effect.gen(function* () {
    const f = yield* setup();
    const initial = yield* f.load();
    const owned = initial.owned.find(item => item.role === 'authoring-child' && item.uri.includes('arch-current'));
    if (!owned) throw new Error('Expected authoring data fixture.');
    yield* f.store.remove(f.location, owned.uri);
    expect((yield* f.load().pipe(Effect.result))._tag).toBe('Failure');
  }).pipe(run),
);
