import {provideTestLayer} from '../helpers/effect-layer.js';
import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import fc from 'fast-check';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {
  composeWorkflowSetup,
  workflowSetupIdentity,
  recordSetupWorkflowCheckpoint,
  undoSetupWorkflows,
} from '../../src/setup/workflows.js';
import {runAgentCliAction} from '../../src/effect/agents_cli.js';
import {getAgentAdapter} from '../../src/agent_integration/adapters.js';
import {applyDevSkills, statusDevSkills, withDevSkillsMutationLease} from '../../src/dev_skills/index.js';
import {fixture, devSkillsTestLayer, snapshot} from './service-fixture.js';
import {runSetupWith, SetupOperationError, type SetupOperationOutcome} from '../../src/setup/index.js';
import {setupRepositorySourceHash} from '../../src/setup/runtime.js';
import {runCommandEffect} from '@threadnote/platform/command';

effectIt.effect(
  'public agents install composes current core, explicit opt-out and persistent disabled enrollment',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const original = getAgentAdapter('codex')!;
      let coreCalls = 0;
      const adapter = {
        ...original,
        actions: {
          ...original.actions,
          install: () =>
            Effect.sync(() => {
              coreCalls += 1;
            }),
        },
      };
      yield* f.run(runAgentCliAction(f.config, adapter, 'install', true, undefined, true));
      let status = yield* f.run(statusDevSkills(f.config, {agent: 'codex'}));
      expect(status.targets[0]).toMatchObject({enabled: false, enrolled: false});
      yield* f.run(runAgentCliAction(f.config, adapter, 'install', true));
      status = yield* f.run(statusDevSkills(f.config, {agent: 'codex'}));
      expect(status.targets[0]).toMatchObject({enabled: false, enrolled: false});
      expect(coreCalls).toBe(2);
      yield* f.run(applyDevSkills(f.config, 'install', {agent: 'codex'}));
      status = yield* f.run(statusDevSkills(f.config, {agent: 'codex'}));
      expect(status.targets[0]).toMatchObject({enabled: true, enrolled: true});
    }).pipe(TestClock.withLive, provideTestLayer(devSkillsTestLayer)),
);

effectIt.effect('public preview and core failure never enroll a consumer', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const before = yield* snapshot(f.root);
    yield* f.run(composeWorkflowSetup(f.config, {agent: 'codex'}, {apply: false, key: 'preview'}, () => Effect.void));
    expect(yield* snapshot(f.root)).toEqual(before);
    const result = yield* f
      .run(
        composeWorkflowSetup(f.config, {agent: 'codex'}, {apply: true, key: 'failure'}, () =>
          Effect.fail('core failed'),
        ),
      )
      .pipe(Effect.result);
    expect(result).toMatchObject({_tag: 'Failure'});
    expect(yield* f.fs.exists(f.path.join(f.home, 'dev-skills/index.json'))).toBe(false);
  }).pipe(TestClock.withLive, provideTestLayer(devSkillsTestLayer)),
);

fcEffectProp(
  effectIt,
  'repeated default setup cannot re-enable explicit opt-out',
  {repetitions: fc.integer({min: 1, max: 5})},
  ({repetitions}) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const core = () => Effect.void;
      yield* f.run(
        composeWorkflowSetup(f.config, {agent: 'codex'}, {apply: true, noDevSkills: true, key: 'disabled'}, core),
      );
      for (let i = 0; i < repetitions; i++)
        yield* f.run(composeWorkflowSetup(f.config, {agent: 'codex'}, {apply: true, key: `default-${i}`}, core));
      const status = yield* f.run(statusDevSkills(f.config, {agent: 'codex'}));
      expect(status.targets[0]).toMatchObject({enabled: false, enrolled: false});
    }).pipe(TestClock.withLive, provideTestLayer(devSkillsTestLayer)),
  {fastCheck: {numRuns: 8}},
);

const setupCheckpointRoundtrip = (legacy: boolean, interrupted = false) =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const repo = f.path.join(f.root, 'repo');
    yield* runCommandEffect('git', ['init', '--quiet', repo]);
    let coreCalls = 0;
    let briefCalls = 0;
    const current = () =>
      Effect.succeed({ownership: 'preexisting', status: 'already-current'} satisfies SetupOperationOutcome);
    const dependencies = {
      workflowSetup: true,
      ensureCore: () =>
        Effect.sync(() => {
          coreCalls++;
          return {ownership: 'preexisting', status: 'already-current'} satisfies SetupOperationOutcome;
        }),
      ensureManifest: current,
      ensureSurface: current,
      ensureHooks: current,
      seedProject: current,
      indexGraph: current,
      inspectReversible: current,
      removeSurface: current,
      removeHooks: current,
      doctor: () => Effect.succeed({status: 'verified', ownership: 'preexisting'} satisfies SetupOperationOutcome),
      contextBrief: () =>
        Effect.gen(function* () {
          if (interrupted && briefCalls++ === 0)
            return yield* SetupOperationError.make({message: 'Interrupted legacy setup'});
          return {
            status: 'verified',
            ownership: 'preexisting',
            verification: {
              contextBriefHash: 'a'.repeat(64),
              durationMilliseconds: 0,
              freshness: 'fresh',
              graphCards: 1,
              graphContracts: 0,
              readyRepositories: 1,
              requestedRepositories: 1,
              sourceVerified: true,
              repositorySourceHash: yield* setupRepositorySourceHash(repo),
            },
          } satisfies SetupOperationOutcome;
        }),
    };
    const adapter = getAgentAdapter('codex')!;
    const attempt = yield* f
      .run(runSetupWith(f.config, adapter, {apply: true, cwd: repo}, {...dependencies, workflowSetup: !legacy}))
      .pipe(Effect.result);
    const receiptFiles = (yield* f.fs.readDirectory(f.path.join(f.home, 'setup'))).filter(
      file => file.endsWith('.json') && !file.endsWith('.workflows.json'),
    );
    const first = JSON.parse(
      yield* f.fs.readFileString(f.path.join(f.home, 'setup', receiptFiles[0])),
    ) as import('../../src/setup/contract.js').SetupReceiptV1;
    expect(attempt._tag).toBe(interrupted ? 'Failure' : 'Success');
    expect(first?.operations.some(operation => operation.kind === 'dev-skills.ensure')).toBe(!legacy);
    const repeated = yield* f.run(runSetupWith(f.config, adapter, {apply: true, cwd: repo}, dependencies));
    if (legacy) {
      expect(repeated?.planHash).toBe(first?.planHash);
      expect(repeated?.operations.map(({id, kind, inputHash}) => ({id, kind, inputHash}))).toEqual(
        first.operations.map(({id, kind, inputHash}) => ({id, kind, inputHash})),
      );
      if (!interrupted) expect(repeated?.operations).toEqual(first.operations);
    }
    const installed = (yield* f.run(statusDevSkills(f.config, {agent: 'codex'}))).targets[0];
    expect(installed).toMatchObject({enrolled: true});
    const generation = installed.installedDigest!;
    expect(coreCalls).toBe(1);
    yield* f.run(runSetupWith(f.config, adapter, {apply: true, undo: true, cwd: repo}, dependencies));
    expect((yield* f.run(statusDevSkills(f.config, {agent: 'codex'}))).targets[0]).toMatchObject({
      enrolled: false,
      enabled: false,
    });
    expect(
      yield* f.fs.exists(f.path.join(f.host, '.agents/skills/.threadnote-dev-skills/generations', generation)),
    ).toBe(true);
  }).pipe(TestClock.withLive, provideTestLayer(devSkillsTestLayer));

effectIt.effect('new setup records workflow ownership and undo retains helpers', () => setupCheckpointRoundtrip(false));
effectIt.effect('completed legacy setup enrolls independently without changing original operations/hash', () =>
  setupCheckpointRoundtrip(true),
);

effectIt.effect('interrupted legacy setup resumes original operations before independent enrollment', () =>
  setupCheckpointRoundtrip(true, true),
);

effectIt.effect('a forged workflow undo index cannot retire another setup consumer', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const selector = {agent: 'codex'};
    const owner = {selector, key: 'own-setup'};
    const foreign = {selector: {agent: 'cursor'}, key: 'another-setup'};
    yield* f.run(composeWorkflowSetup(f.config, selector, {apply: true, key: owner.key}, () => Effect.void));
    yield* f.run(composeWorkflowSetup(f.config, foreign.selector, {apply: true, key: foreign.key}, () => Effect.void));
    const identity = yield* f.run(workflowSetupIdentity(f.config, selector, owner.key, false));
    const other = yield* f.run(workflowSetupIdentity(f.config, foreign.selector, foreign.key, false));
    const file = f.path.join(f.home, 'setup', 'workflows.json');
    yield* recordSetupWorkflowCheckpoint(file, identity, owner, false);
    yield* f.fs.writeFileString(file, JSON.stringify([{...other, choice: 'default'}]));
    const before = yield* snapshot(f.root);
    const result = yield* f
      .run(withDevSkillsMutationLease(f.config, lease => undoSetupWorkflows(f.config, file, owner, lease)))
      .pipe(Effect.result);
    expect(result).toMatchObject({_tag: 'Failure'});
    expect(yield* snapshot(f.root)).toEqual(before);
    expect((yield* f.run(statusDevSkills(f.config, foreign.selector))).targets[0].enrolled).toBe(true);
  }).pipe(TestClock.withLive, provideTestLayer(devSkillsTestLayer)),
);
