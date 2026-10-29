import {Array as EffectArray, String as EffectString, Effect, Predicate, Schema} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {
  decodeNativeAuthoringDocument,
  nativeAuthoringDigest,
  nativeSpecIntentDigest,
} from '@threadnote/workflow-automations/authoring';
import {
  decodeNativeCyclePlan,
  decodeNativeCycleState,
  initializeNativeCycle,
  recordNativeCycleDelivery,
  validateNativeCyclePhase,
} from '@threadnote/workflow-automations/cycle';
import {persistCodexCloudProfile} from '../../src/codex/profile.js';
import {persistCursorCloudIdentityProfile} from '../../src/cursor/profile.js';
import {AuthoringReferenceSchema} from '../../src/workflow_automation/authoring_artifacts.js';
import {
  readNativeWorkflowState,
  writeNativeWorkflowState,
  withNativeWorkflowLock,
} from '../../src/workflow_automation/store.js';
import {loadNativeCloseoutInputs} from '../../src/workflow_automation/closeout_inputs.js';
import {nativeFixture} from './native-automation-fixture.js';
import {observeCloseoutGraph, observeCloseoutStage} from './native-closeout-diagnostics.js';
import * as EffectRecord from 'effect/Record';
import * as Effect2 from 'effect';

export type CloseoutProfile = 'desktop' | 'codex-cloud-personal' | 'cursor-cloud-personal';
const generation = 'skill-generation-v1';
const common = {
  format: 'threadnote-native-authoring',
  schemaVersion: 1,
  id: 'feature',
  project: 'fixture',
  title: 'Closeout lifecycle fixture',
  objective: 'Retain complete verified behavior.',
  requirements: [{id: 'req', behavior: 'Reader receives complete result.'}],
  context: {codeRefs: [], evidenceRefs: [], note: 'Private lifecycle fixture.'},
  source: null,
  sourceFreeReason: 'A private source-free fixture.',
};
const architecture = {
  summary: 'Read the saved result.',
  components: ['Reader', 'Store'],
  contracts: ['Preserve complete results.'],
  diagram: 'flowchart TD\n Reader --> Store',
};
const specDocument = () =>
  decodeNativeAuthoringDocument({
    ...common,
    kind: 'spec',
    actors: ['Reader'],
    inScope: ['Read saved data.'],
    outOfScope: [],
    constraints: [],
    observations: [],
    scenarios: [
      {
        id: 'read',
        requirementIds: ['req'],
        given: 'Saved data.',
        when: 'The reader requests it.',
        then: 'The full result is returned.',
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
    current: architecture,
    target: architecture,
    phases: [
      {
        id: 'one',
        title: 'Reader behavior',
        outcome: 'Return complete saved data.',
        dependsOn: [],
        affectedPaths: ['source.ts'],
        newPaths: [],
        contracts: ['Preserve full result.'],
        acceptance: [
          {
            id: 'complete',
            criterion: 'Reader receives complete data.',
            verification: 'Read and compare the complete result.',
            requirementIds: ['req'],
          },
        ],
        safeBoundary: 'Reader behavior is independently verifiable.',
      },
    ],
    decisions: [
      {
        id: 'retain-store',
        question: 'Which storage implementation?',
        selection: 'retain',
        selected: 'Keep the existing store.',
        alternatives: [{id: 'replace-store', design: 'Replace the store.', tradeoffs: 'Adds migration risk.'}],
        rationale: Effect2.pipe(
          'The existing store already preserves the required identity and data. ',
          EffectString.repeat(24),
        ),
        affectedPhases: ['one'],
        authority: 'orchestrator',
      },
      {
        id: 'full-read',
        question: 'How should reads handle results?',
        selection: 'adapt',
        selected: 'Return complete results in one verified read.',
        alternatives: [{id: 'partial-read', design: 'Return partial data.', tradeoffs: 'Needs continuation.'}],
        rationale: Effect2.pipe(
          'A complete read matches the approved behavior and avoids hidden truncation. ',
          EffectString.repeat(24),
        ),
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

const decodeExportedCyclePlan = (value: unknown) => {
  if (!value || typeof value !== 'object' || !('authoring' in value)) throw new Error('Expected exported cycle plan.');
  return decodeNativeCyclePlan(value.authoring);
};

const closeoutFixture = Effect.fn('test.nativeCloseout.fixture')(function* (
  withSpec = false,
  profile: CloseoutProfile = 'desktop',
  controllerRunId = 'controller',
  cycleDelivery: 'local' | 'pr' = 'local',
) {
  const system = yield* SystemInfo;
  const environment = EffectRecord.fromEntries(
    EffectArray.filter(
      EffectRecord.toEntries(system.environment()),
      ([key]) => !Effect2.pipe(key, EffectString.startsWith('THREADNOTE_')),
    ),
  );
  if (profile === 'cursor-cloud-personal') environment.THREADNOTE_CURSOR_CLOUD_TEAM = 'default';
  const f = yield* observeCloseoutStage('provisioning', nativeFixture(environment));
  const config = {...f.config, ...(profile === 'desktop' ? {} : {manifestSource: 'bundled-example' as const})};
  const scopedSystem = {...system, currentDirectory: () => f.repo, environment: () => environment};
  const call = (request: unknown) => {
    const command = Predicate.hasProperty(request, 'command') ? request.command : undefined;
    const action = Predicate.hasProperty(request, 'action') ? request.action : undefined;
    const program = f.call(request, config).pipe(Effect.provideService(SystemInfo, scopedSystem));
    return observeCloseoutStage(command ?? action, action === 'graph-ready' ? observeCloseoutGraph(program) : program);
  };
  const git = (cwd: string, args: readonly string[]) =>
    observeCloseoutStage('fixture-git', runCommandEffect('git', ['-C', cwd, ...args]));
  yield* git(f.repo, ['config', 'user.email', 'fixture@example.invalid']);
  yield* git(f.repo, ['config', 'user.name', 'Closeout Fixture']);
  yield* git(f.repo, ['add', 'source.ts']);
  yield* git(f.repo, ['commit', '-m', 'Private closeout source']);

  if (profile !== 'desktop') {
    // Portable source citations need a stable remote identity; no operation contacts this URL.
    yield* git(f.repo, ['remote', 'add', 'origin', 'https://github.com/fixture/closeout.git']);
    const remote = f.path.join(f.root, 'remote.git');
    const worktree = f.path.join(f.root, 'shared');
    yield* git(f.root, ['init', '--bare', '--initial-branch=main', remote]);
    yield* git(f.root, ['clone', remote, worktree]);
    yield* git(worktree, ['config', 'user.email', 'fixture@example.invalid']);
    yield* git(worktree, ['config', 'user.name', 'Closeout Fixture']);
    yield* f.fs.writeFileString(f.path.join(worktree, 'README.md'), 'Private seed.\n');
    yield* git(worktree, ['add', 'README.md']);
    yield* git(worktree, ['commit', '-m', 'Seed private share']);
    yield* git(worktree, ['push', 'origin', 'main']);
    yield* f.fs.makeDirectory(f.path.join(f.home, 'share'));
    yield* f.fs.writeFileString(
      f.path.join(f.home, 'share', 'teams.json'),
      JSON.stringify({
        version: 1,
        defaultTeam: 'default',
        teams: {
          default: {name: 'default', access: 'read-write', remote, worktree, gitdir: f.path.join(worktree, '.git')},
        },
      }),
    );
    if (profile === 'codex-cloud-personal')
      yield* observeCloseoutStage('cloud-profile', persistCodexCloudProfile(config, ['default']));
    else yield* observeCloseoutStage('cloud-profile', persistCursorCloudIdentityProfile(config));
  }
  const initRun = (runId: string) =>
    call({
      ...f.base('init', runId),
      project: 'fixture',
      featureId: 'feature',
      profile,
      ...(profile === 'desktop' ? {} : {team: 'default'}),
    });

  let plan = planDocument();
  if (plan.kind !== 'plan') throw new Error('Expected fixture plan.');
  if (withSpec) {
    const specRunId = profile === 'desktop' ? 'spec-run' : 'plan-run';
    yield* initRun(specRunId);
    const spec = specDocument();
    const savedSpec = yield* call({
      ...f.base('authoring', specRunId),
      command: 'save',
      document: spec,
      ready: true,
      expectedRevision: null,
      confirmation: {
        intentHash: nativeSpecIntentDigest(spec),
        decision: 'approved',
        response: 'Approve the private lifecycle fixture behavior.',
      },
    });
    const specRoot = (yield* Schema.decodeUnknownEffect(loadedRootSchema)(savedSpec)).authoring.root;
    const specState = yield* readNativeWorkflowState(config, specRunId);
    if (!specState || spec.kind !== 'spec') throw new Error('Expected ready spec state.');
    plan = decodeNativeAuthoringDocument({
      ...plan,
      phases: EffectArray.map(plan.phases, phase => ({
        ...phase,
        acceptance: EffectArray.map(phase.acceptance, item => ({...item, scenarioIds: ['read']})),
      })),
      spec: {
        root: specRoot,
        binding: {
          bindingId: specState.state.bindingId,
          runId: specRunId,
          generation,
          profile,
          ...(profile === 'desktop' ? {} : {team: 'default'}),
        },
        documentHash: nativeAuthoringDigest(spec),
        intentHash: nativeSpecIntentDigest(spec),
        requirements: spec.requirements,
        scenarios: spec.scenarios,
      },
    });
  }
  if (plan.kind !== 'plan') throw new Error('Expected fixture plan.');
  if (!withSpec || profile === 'desktop') yield* initRun('plan-run');
  // Code citations in the closeout proposal must resolve against a real, current graph.
  // The fixture source was committed above, so this indexes only the private fixture repo/home.
  yield* call(f.base('graph-ready', 'plan-run'));
  const savedPlan = yield* call({
    ...f.base('authoring', 'plan-run'),
    command: 'save',
    document: plan,
    ready: true,
    expectedRevision: null,
  });
  const planRoot = (yield* Schema.decodeUnknownEffect(loadedRootSchema)(savedPlan)).authoring.root;
  const planState = yield* readNativeWorkflowState(config, 'plan-run');
  if (!planState) throw new Error('Expected ready plan state.');
  const unrelatedWrite = yield* call({
    ...f.write({artifactKey: 'unrelated-evidence', role: 'evidence', body: 'Independent evidence remains active.\n'}),
    runId: 'plan-run',
  });
  if (!('artifact' in unrelatedWrite)) throw new Error('Expected unrelated evidence artifact.');
  const unrelated = unrelatedWrite.artifact;

  if (controllerRunId !== 'plan-run') yield* initRun(controllerRunId);
  const controller = yield* readNativeWorkflowState(config, controllerRunId);
  if (!controller) throw new Error('Expected controller state.');
  const cyclePlan =
    cycleDelivery === 'pr'
      ? decodeExportedCyclePlan(
          yield* call({
            ...f.base('authoring', 'plan-run'),
            command: 'export-dev-cycle',
            uri: planRoot.uri,
            delivery: 'pr',
            bindings: {one: {branch: 'fixture/reader', baseBranch: 'main'}},
          }),
        )
      : decodeNativeCyclePlan({
          format: 'threadnote-native-cycle-plan',
          version: 1,
          featureId: plan.id,
          project: plan.project,
          objective: plan.objective,
          delivery: cycleDelivery,
          source: {
            root: planRoot,
            binding: {
              bindingId: planState.state.bindingId,
              runId: 'plan-run',
              generation,
              profile,
              ...(profile === 'desktop' ? {} : {team: 'default'}),
            },
            documentHash: nativeAuthoringDigest(plan),
          },
          completion: {},
          phases: [
            {
              id: 'one',
              definitionHash: EffectString.repeat(64)('1'),
              title: 'Reader behavior',
              dependsOn: [],
              allowedPaths: ['source.ts'],
              acceptanceCriteria: EffectArray.map(plan.phases[0].acceptance, item => item.criterion),
              safeToMergeReason: 'The fixture is independently verifiable.',
              branch: 'fixture/reader',
              baseBranch: 'main',
              status: 'pending',
              acceptanceRefs: EffectArray.map(plan.phases[0].acceptance, item => ({
                id: item.id,
                criterion: item.criterion,
                requirements: item.requirementIds,
                specScenarios: withSpec ? ['read'] : [],
              })),
            },
          ],
        });
  const initialHead =
    cycleDelivery === 'pr'
      ? EffectString.trim((yield* git(f.repo, ['rev-parse', 'HEAD'])).stdout)
      : EffectString.repeat(40)('a');
  const initialTree =
    cycleDelivery === 'pr'
      ? EffectString.trim((yield* git(f.repo, ['rev-parse', 'HEAD^{tree}'])).stdout)
      : EffectString.repeat(40)('b');
  const validatedCycle = validateNativeCyclePhase(
    initializeNativeCycle(cyclePlan),
    'one',
    {head: initialHead, tree: initialTree, files: ['source.ts']},
    {
      snapshotTree: initialTree,
      status: 'passed',
      productState: 'working',
      checks: [{command: 'Private fixture check', result: 'passed', evidence: 'Observed the complete result.'}],
      acceptance: EffectArray.map(plan.phases[0].acceptance, item => ({
        criterion: item.criterion,
        result: 'passed',
        evidence: 'Observed: ' + item.criterion,
      })),
    },
  );
  const cycle =
    cycleDelivery === 'pr'
      ? recordNativeCycleDelivery(validatedCycle, 'one', {
          phaseId: 'one',
          phaseHash: validatedCycle.phases.one.phaseHash,
          delivery: 'pr',
          headSha: initialHead,
          validatedTree: initialTree,
          commitEvidence: 'Fixture predecessor delivery.',
          pr: {
            url: 'https://github.com/example/private-fixture/pull/1',
            headSha: initialHead,
            branch: 'fixture/reader',
            baseBranch: 'main',
            state: 'open',
          },
          watch: {
            prUrl: 'https://github.com/example/private-fixture/pull/1',
            headSha: initialHead,
            state: 'active',
            stateDir: f.path.join(f.root, 'watch'),
            consumerKind: 'orchestrator',
            consumerId: 'fixture',
            evidence: 'Private predecessor fixture.',
          },
        })
      : validatedCycle;
  yield* observeCloseoutStage(
    'controller-state',
    withNativeWorkflowLock(
      config,
      controllerRunId,
      false,
      writeNativeWorkflowState(
        config,
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
    ),
  );

  return {
    ...f,
    call,
    config,
    generation,
    plan,
    unrelated,
    profile,
    controllerRunId,
    load: () =>
      observeCloseoutStage('load', loadNativeCloseoutInputs(config, controllerRunId, generation, call)).pipe(
        Effect.provideService(SystemInfo, scopedSystem),
      ),
    closeout: (command: string, fields: Record<string, unknown> = {}) =>
      call({...f.base('closeout', controllerRunId), command, ...fields}),
  };
});

export const nativeCloseoutFixture = (...args: Parameters<typeof closeoutFixture>) =>
  observeCloseoutStage('fixture', closeoutFixture(...args));
