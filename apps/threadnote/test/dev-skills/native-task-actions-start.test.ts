import {Array as EffectArray, Deferred, Effect, FileSystem, Fiber, Path, Record as EffectRecord, Schema} from 'effect';
import * as EffectOption from 'effect/Option';
import * as EffectString from 'effect/String';
import {Command} from 'effect/cli';
import {it as effectIt} from '@effect/vitest';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {
  ResourceStore,
  type ResourceStoreLocation,
  type ResourceStoreWriteOptions,
} from '@threadnote/store/resource-store';
import {describe, expect, vi} from 'vitest';
import fc from 'fast-check';
import {
  decodeNativeTaskActionRef,
  encodeNativeTaskActionRef,
  nativeTaskStartRunId,
} from '@threadnote/workflow-automations/task';
import {workflowTitleSlug} from '@threadnote/workflow-automations/naming';
import {
  NativeAuthoringPlanDocumentSchema,
  NativeCompactSourceSnapshotSchema,
  nativeAuthoringDigest,
  nativeSpecIntentDigest,
  projectNativeCompactIntent,
} from '@threadnote/workflow-automations/authoring';
import {decodeNativeCycleRuntime} from '@threadnote/workflow-automations/cycle-runtime';
import {CommandExecutor, runCommandEffect} from '@threadnote/platform/command';
import {sha256Hex} from '@threadnote/platform/digest';
import {EffectMcpServerAdapter} from '../../src/effect/ai/mcp.js';
import {registerWorkflowTaskTool} from '../../src/mcp/server/workflow.js';
import {readNativeTaskView} from '../../src/workflow_automation/task.js';
import {
  makeNativeTaskActionCommands,
  makeNativeTaskStartCommand,
  makeNativeTaskViewCommand,
} from '../../src/effect/workflow_cli.js';
import {
  runNativeTaskAction as runNativeTaskActionCore,
  runNativeTaskStart,
} from '../../src/workflow_automation/task_actions.js';
import {runNativeTaskAuthoring} from '../../src/workflow_automation/task_authoring.js';
import {readNativeTaskInstalledTarget} from '../../src/workflow_automation/task_admission.js';
import {applyDevSkills, statusDevSkills} from '../../src/dev_skills/index.js';
import {DevSkillsSource, loadDevSkillsBundleAt} from '../../src/dev_skills/manifest.js';
import {enrollmentContext} from '../../src/dev_skills/registry.js';
import {SystemInfo} from '@threadnote/platform/system';
import {readNativeWorkflowState, serializeNativeWorkflowState} from '../../src/workflow_automation/store.js';
import {withDeferredCodeAnchorMutationLocks} from '../../src/memory/deferred/code_anchor.js';
import {healAnchorsAfterGraphIndex} from '../../src/memory/deferred/code_anchor_recovery.js';
import {runWorkflowAutomation} from '../../src/workflow_automation/index.js';
import {sha256HexSync} from '../../src/workflow_memory/native_digest.js';
import {GraphDiagnostics, object, run} from './native-cycle-lifecycle-fixture.js';
import {nativeFixture} from './native-automation-fixture.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {cliTestLayer, fixture, runNativeTaskAction, packet, inspectTaskOnce} from './native-task-actions-fixture.js';

describe('native task actions', () => {
  effectIt.effect('preserves each snapshot authority command through the shared registration schema', () =>
    Effect.gen(function* () {
      const f = yield* fixture(['one'], 'local');
      const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
      const registration = yield* Effect.acquireRelease(
        Effect.sync(() => vi.spyOn(mcp, 'registerTool')),
        registered => Effect.sync(() => registered.mockRestore()),
      );
      registerWorkflowTaskTool(mcp, f.config);
      const snapshot = EffectOption.getOrThrow(
        EffectArray.findFirst(registration.mock.calls, ([name]) => name === 'workflow_task_snapshot'),
      );
      const schema = Schema.Struct(snapshot[1].inputSchema);
      const decode = Schema.decodeUnknownEffect(schema);
      const commands = ['recover-unreviewed-rebase', 'requalify-base', 'integrate-same-label-base'] as const;
      for (const command of commands) {
        const valid = {
          runId: 'run',
          callerCwd: f.repo,
          snapshot: {
            command,
            snapshotRef: 'opaque-ref',
            reason: 'Existing source authority',
            userAuthority: 'Caller assertion',
          },
        };
        expect(yield* decode(valid)).toEqual(valid);
        for (const key of ['command', 'snapshotRef', 'reason', 'userAuthority'] as const) {
          const missing: Record<string, unknown> = {...valid.snapshot};
          delete missing[key];
          expect((yield* decode({...valid, snapshot: missing}).pipe(Effect.exit))._tag).toBe('Failure');
          for (const invalid of ['', null, 1, false])
            expect(
              (yield* decode({...valid, snapshot: {...valid.snapshot, [key]: invalid}}).pipe(Effect.exit))._tag,
            ).toBe('Failure');
        }
      }
      const value = fc.oneof(fc.string({maxLength: 32}), fc.constantFrom(null, 1, false));
      fc.assert(
        fc.property(
          fc.constantFrom(...commands),
          value,
          value,
          value,
          (command, snapshotRef, reason, userAuthority) => {
            // Independent former per-command arm: all three fields are required nonempty strings.
            const previous = Schema.Struct({
              command: Schema.Literal(command),
              snapshotRef: Schema.String.check(Schema.isMinLength(1)),
              reason: Schema.String.check(Schema.isMinLength(1)),
              userAuthority: Schema.String.check(Schema.isMinLength(1)),
            });
            const input = {command, snapshotRef, reason, userAuthority};
            expect(Schema.is(schema)({runId: 'run', callerCwd: f.repo, snapshot: input})).toBe(
              Schema.is(previous)(input),
            );
          },
        ),
        {numRuns: 40, seed: 424244},
      );
    }).pipe(run),
  );

  effectIt.effect('lists recorded installation targets and inspection codes on admission failure', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const repo = yield* f.fs.realPath(f.repo);
      const home = yield* f.fs.realPath(f.home);
      const config = {...f.config, agentContextHome: home};
      const system = yield* SystemInfo;
      const scoped = {...system, currentDirectory: () => repo, homeDirectory: home};
      yield* applyDevSkills(config, 'install', {agent: 'codex'}).pipe(Effect.provideService(SystemInfo, scoped));
      const missing = yield* readNativeTaskInstalledTarget(config, undefined, repo).pipe(
        Effect.provideService(SystemInfo, scoped),
        Effect.result,
      );
      expect(missing).toMatchObject({
        failure: {code: 'needs-resources', message: expect.stringContaining('installationTarget')},
      });
      if (missing._tag !== 'Failure') throw new Error('Expected missing target to fail');
      expect(missing.failure.message).toContain('--installation-target');
      expect(missing.failure.message).toContain('codex');
      expect(missing.failure.message).toContain('current');
      expect(missing.failure.message).not.toContain(f.root);
      const unknown = yield* readNativeTaskInstalledTarget(config, 'missing-target', repo).pipe(
        Effect.provideService(SystemInfo, scoped),
        Effect.result,
      );
      expect(unknown).toMatchObject({
        failure: {code: 'needs-resources', message: expect.stringContaining('Inspection code:')},
      });
      if (unknown._tag !== 'Failure') throw new Error('Expected unknown target to fail');
      expect(unknown.failure.message).toContain('codex');
      expect(unknown.failure.message).not.toContain(f.root);
      const sourceRoot = f.path.join(f.root, 'updated-skill-source');
      const sourceBundle = yield* loadDevSkillsBundleAt(
        Bun.fileURLToPath(new URL('../../../../', import.meta.url)),
        '5.3.0-beta.7',
        false,
      );
      for (const [key, encoded] of EffectRecord.toEntries(sourceBundle.files)) {
        const destination = f.path.join(sourceRoot, 'config', 'agent-skills', key);
        yield* f.fs.makeDirectory(f.path.dirname(destination), {recursive: true});
        const content = Buffer.from(encoded, 'base64');
        yield* f.fs.writeFile(
          destination,
          key === 'dev-spec/SKILL.md' ? Buffer.concat([content, Buffer.from('\nUpdated generation.\n')]) : content,
        );
      }
      const inventory = {
        schemaVersion: sourceBundle.manifest.schemaVersion,
        nativeRequirements: sourceBundle.manifest.nativeRequirements,
        workflowProtocol: sourceBundle.manifest.workflowProtocol,
        stateSchema: sourceBundle.manifest.stateSchema,
        minimumRuntime: sourceBundle.manifest.minimumRuntime,
        skills: sourceBundle.manifest.skills,
      };
      yield* f.fs.writeFileString(f.path.join(sourceRoot, 'config', 'dev-skills.json'), JSON.stringify(inventory));
      const updatedSource = {root: sourceRoot, runtimeVersion: sourceBundle.manifest.releaseVersion};
      const stale = yield* readNativeTaskInstalledTarget(config, 'codex', repo).pipe(
        Effect.provideService(SystemInfo, scoped),
        Effect.provideService(DevSkillsSource, updatedSource),
        Effect.result,
      );
      expect(stale).toMatchObject({failure: {code: 'needs-resources'}});
      if (stale._tag === 'Failure') {
        expect(stale.failure.message).toContain('dev-skills update --agent codex-cli --scope user --profile desktop');
        expect(stale.failure.message).not.toContain(f.root);
      }
      yield* applyDevSkills(config, 'update', {agent: 'codex'}).pipe(
        Effect.provideService(SystemInfo, scoped),
        Effect.provideService(DevSkillsSource, updatedSource),
      );
      expect(
        yield* readNativeTaskInstalledTarget(config, 'codex', repo).pipe(
          Effect.provideService(SystemInfo, scoped),
          Effect.provideService(DevSkillsSource, updatedSource),
        ),
      ).toMatchObject({installationState: 'current'});
      yield* applyDevSkills(config, 'install', {agent: 'devin-local', scope: 'project', cwd: repo}).pipe(
        Effect.provideService(SystemInfo, scoped),
      );
      const projectStale = yield* readNativeTaskInstalledTarget(config, 'devin-local', repo).pipe(
        Effect.provideService(SystemInfo, scoped),
        Effect.provideService(DevSkillsSource, updatedSource),
        Effect.result,
      );
      expect(projectStale).toMatchObject({failure: {code: 'needs-resources'}});
      if (projectStale._tag === 'Failure') {
        expect(projectStale.failure.message).toContain(
          'dev-skills update --agent devin-local --scope project --profile desktop --cwd .',
        );
        expect(projectStale.failure.message).toContain('from the target checkout');
        expect(projectStale.failure.message).not.toContain(f.root);
      }
      yield* applyDevSkills(config, 'update', {agent: 'devin-local', scope: 'project', cwd: repo}).pipe(
        Effect.provideService(SystemInfo, scoped),
        Effect.provideService(DevSkillsSource, updatedSource),
      );
      yield* applyDevSkills(config, 'install', {agent: 'devin-local', scope: 'user'}).pipe(
        Effect.provideService(SystemInfo, scoped),
        Effect.provideService(DevSkillsSource, updatedSource),
      );
      const context = yield* enrollmentContext(config);
      let projectId: string | undefined;
      for (const [id, entry] of EffectRecord.toEntries(context.homeIndex.targets))
        if (entry.target.surfaceId === 'devin-local' && entry.target.scope === 'project') projectId = id;
      expect(projectId).toMatch(/^[a-f0-9]{64}$/u);
      if (!projectId) throw new Error('Expected recorded project consumer ID.');
      const explicitProject = yield* readNativeTaskInstalledTarget(config, projectId, repo).pipe(
        Effect.provideService(SystemInfo, scoped),
        Effect.provideService(DevSkillsSource, updatedSource),
      );
      expect(explicitProject).toMatchObject({
        consumerId: projectId,
        target: {scope: 'project'},
        installationState: 'current',
      });
      const wrongCheckout = yield* readNativeTaskInstalledTarget(config, projectId, home).pipe(
        Effect.provideService(SystemInfo, scoped),
        Effect.provideService(DevSkillsSource, updatedSource),
        Effect.result,
      );
      expect(wrongCheckout).toMatchObject({failure: {code: 'needs-resources'}});
      if (wrongCheckout._tag === 'Failure') expect(wrongCheckout.failure.message).toContain('target-checkout-mismatch');
      const bareUser = yield* readNativeTaskInstalledTarget(config, 'devin-local', repo).pipe(
        Effect.provideService(SystemInfo, scoped),
        Effect.provideService(DevSkillsSource, updatedSource),
      );
      expect(bareUser).toMatchObject({target: {scope: 'user'}, installationState: 'current'});
      const unknownId = EffectString.repeat(64)('a');
      const invalidStart = yield* runNativeTaskStart(config, {
        callerCwd: repo,
        featureName: 'Unknown installed target',
        installationTarget: unknownId,
        intent: {
          title: 'Unknown installed target',
          currentBehavior: 'Target admission fails.',
          desiredChange: 'Admit a recorded target.',
          affectedPaths: ['source.ts'],
          acceptanceCriterion: 'The recorded target is admitted.',
          verification: 'Inspect target admission.',
          eligibilityRationale: 'The failure is isolated.',
          eligibility: {status: 'eligible'},
          review: {required: false, reason: 'Focused fixture.'},
        },
      }).pipe(Effect.provideService(SystemInfo, scoped), Effect.result);
      expect(invalidStart).toMatchObject({failure: {code: 'needs-resources'}});
      expect(yield* f.fs.exists(f.path.join(home, 'workflow-automations'))).toBe(false);
    }).pipe(run),
  );

  effectIt.effect('starts in a selected graph project and rejects ambiguous unselected scope', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const repo = yield* f.fs.realPath(f.repo);
      const home = yield* f.fs.realPath(f.home);
      const config = {...f.config, agentContextHome: home, manifestPath: f.path.join(home, 'manifest.json')};
      const system = yield* SystemInfo;
      const testSystem = {...system, currentDirectory: () => repo, homeDirectory: home};
      yield* f.fs.makeDirectory(f.path.join(repo, 'apps', 'alpha'), {recursive: true});
      yield* f.fs.makeDirectory(f.path.join(repo, 'apps', 'beta'), {recursive: true});
      yield* f.fs.writeFileString(
        f.path.join(repo, 'package.json'),
        JSON.stringify({private: true, workspaces: ['apps/*']}),
      );
      yield* f.fs.writeFileString(
        f.path.join(repo, 'apps', 'alpha', 'package.json'),
        JSON.stringify({name: '@fixture/alpha'}),
      );
      yield* f.fs.writeFileString(
        f.path.join(repo, 'apps', 'beta', 'package.json'),
        JSON.stringify({name: '@fixture/beta'}),
      );
      yield* f.fs.writeFileString(f.path.join(repo, 'apps', 'alpha', 'source.ts'), 'export const selected = true;\n');
      yield* f.fs.writeFileString(f.path.join(repo, 'apps', 'beta', 'source.ts'), 'export const other = true;\n');
      yield* runCommandEffect('git', ['-C', repo, 'add', '.']);
      yield* runCommandEffect('git', [
        '-C',
        repo,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-m',
        'Graph projects',
      ]);
      const projects = EffectArray.map(['Alpha', 'Beta'], name => ({
        name,
        path: repo,
        seed: [],
        uri: `threadnote://resources/repos/${EffectString.toLowerCase(name)}`,
        graph: {closure: 'dependencies' as const, roots: [`apps/${EffectString.toLowerCase(name)}`]},
      }));
      yield* f.fs.writeFileString(config.manifestPath, JSON.stringify({version: 1, projects}));
      yield* applyDevSkills(config, 'install', {agent: 'codex'}).pipe(Effect.provideService(SystemInfo, testSystem));
      const intent = {
        title: 'Selected graph task',
        currentBehavior: 'Selected source is not checked.',
        desiredChange: 'Selected source is checked.',
        affectedPaths: ['apps/alpha/source.ts'],
        acceptanceCriterion: 'Selected source is checked.',
        verification: 'Inspect selected source.',
        eligibilityRationale: 'One local source and behavior are explicit.',
        eligibility: {status: 'eligible' as const},
        review: {required: false, reason: 'Focused fixture.'},
      };
      const request = {callerCwd: repo, featureName: 'Selected graph task', installationTarget: 'codex', intent};
      const unselected = yield* runNativeTaskStart(config, request).pipe(
        Effect.provideService(SystemInfo, testSystem),
        Effect.result,
      );
      expect(unselected).toMatchObject({failure: {code: 'graph-scope-required'}});
      const index = yield* (yield* CodeGraphIndexer).index({cwd: repo, threadnoteHome: home, project: projects[0]});
      expect(index.snapshot.state).toBe('ready');
      const started = object(
        yield* runNativeTaskStart(config, {...request, graphProject: ' alpha '}).pipe(
          Effect.provideService(SystemInfo, testSystem),
        ),
      );
      if (typeof started.taskRef !== 'string') throw new Error('Expected task reference after start');
      const state = yield* readNativeWorkflowState(config, started.taskRef);
      expect(state?.state.graphProject).toBe('Alpha');
      const selectedBytes = yield* f.fs.readFileString(f.statePath(started.taskRef));
      expect(
        yield* runNativeTaskStart(config, {...request, graphProject: 'Beta'}).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.result,
        ),
      ).toMatchObject({failure: {code: 'graph-scope-conflict'}});
      expect(yield* f.fs.readFileString(f.statePath(started.taskRef))).toBe(selectedBytes);
      const legacyName = 'Legacy graph task';
      const legacyRunId = nativeTaskStartRunId(undefined, workflowTitleSlug('repo'), workflowTitleSlug(legacyName));
      const installed = yield* statusDevSkills(config, {agent: 'codex'}).pipe(
        Effect.provideService(SystemInfo, testSystem),
      );
      yield* runWorkflowAutomation(config, {
        protocolVersion: 1,
        executorVersion: 1,
        action: 'init',
        runId: legacyRunId,
        project: 'repo',
        featureId: workflowTitleSlug(legacyName),
        generation: installed.bundle.digest,
        profile: 'desktop',
        title: intent.title,
      }).pipe(Effect.provideService(SystemInfo, testSystem));
      const legacyBytes = yield* f.fs.readFileString(f.statePath(legacyRunId));
      expect(
        yield* runNativeTaskStart(config, {...request, featureName: legacyName, graphProject: 'Alpha'}).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.result,
        ),
      ).toMatchObject({failure: {code: 'graph-scope-conflict'}});
      expect(yield* f.fs.readFileString(f.statePath(legacyRunId))).toBe(legacyBytes);
    }).pipe(run),
  );

  const startFromCheckout = (configuredProject: string, linkedWorktree: string | undefined) =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const repo = yield* f.fs.realPath(f.repo);
      const home = yield* f.fs.realPath(f.home);
      yield* runCommandEffect('git', ['-C', repo, 'add', 'source.ts']);
      yield* runCommandEffect('git', [
        '-C',
        repo,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-m',
        'Fixture source',
      ]);
      const checkoutPath = linkedWorktree === undefined ? repo : f.path.join(f.root, linkedWorktree);
      if (linkedWorktree !== undefined)
        yield* runCommandEffect('git', ['-C', repo, 'worktree', 'add', '-b', linkedWorktree, checkoutPath]);
      const checkout = yield* f.fs.realPath(checkoutPath);
      const config = {...f.config, agentContextHome: home, manifestPath: f.path.join(home, 'manifest.json')};
      yield* f.fs.writeFileString(
        config.manifestPath,
        JSON.stringify({
          version: 1,
          projects: [
            {name: configuredProject, path: repo, seed: [], uri: `threadnote://resources/repos/${configuredProject}`},
          ],
        }),
      );
      const system = yield* SystemInfo;
      const testSystem = {...system, currentDirectory: () => checkout, homeDirectory: home};
      yield* applyDevSkills(config, 'install', {agent: 'codex'}).pipe(Effect.provideService(SystemInfo, testSystem));
      const indexed = yield* (yield* CodeGraphIndexer).index({cwd: checkout, threadnoteHome: home});
      expect(indexed.snapshot.state).toBe('ready');
      const start = (graphProject?: string) =>
        runNativeTaskStart(config, {
          callerCwd: checkout,
          featureName: 'Checkout task',
          installationTarget: 'codex',
          ...(graphProject === undefined ? {} : {graphProject}),
          intent: {
            title: 'Checkout task',
            currentBehavior: 'Checkout source is not checked.',
            desiredChange: 'Checkout source is checked.',
            affectedPaths: ['source.ts'],
            acceptanceCriterion: 'Checkout source is checked.',
            verification: 'Inspect checkout source.',
            eligibilityRationale: 'One local source and behavior are explicit.',
            eligibility: {status: 'eligible' as const},
            review: {required: false, reason: 'Focused fixture.'},
          },
        }).pipe(Effect.provideService(SystemInfo, testSystem), Effect.result);
      const runId = nativeTaskStartRunId(undefined, 'repo', 'checkout-task');
      return {start, state: readNativeWorkflowState(config, runId), runId};
    });

  effectIt.effect('files a linked-worktree task start under the repository project', () =>
    Effect.gen(function* () {
      const checkout = yield* startFromCheckout('repo', 'repo-second');
      expect(yield* checkout.start()).toMatchObject({success: {taskRef: checkout.runId}});
      expect((yield* checkout.state)?.state.project).toBe('repo');
    }).pipe(run),
  );

  effectIt.effect('rejects an unroutable project before writing state, so the recommended retry starts', () =>
    Effect.gen(function* () {
      const checkout = yield* startFromCheckout('other', undefined);
      const rejected = yield* checkout.start();
      expect(yield* checkout.state).toBeUndefined();
      expect(rejected).toMatchObject({failure: {code: 'graph-scope-required'}});
      expect(yield* checkout.start('other')).toMatchObject({success: {taskRef: checkout.runId}});
    }).pipe(run),
  );

  effectIt.effect(
    'reports a read-back drained outcome for a canonical prior binding without rewriting its history',
    () =>
      Effect.gen(function* () {
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
          'Committed cutover fixture source',
        ]);
        const system = yield* SystemInfo;
        const repo = yield* f.fs.realPath(f.repo);
        const home = yield* f.fs.realPath(f.home);
        const config = {...f.config, agentContextHome: home, manifestPath: f.path.join(home, 'manifest.json')};
        const testSystem = {...system, currentDirectory: () => repo, homeDirectory: home};
        const installed = yield* applyDevSkills(config, 'install', {agent: 'codex'}).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(installed.applied).toBe(true);
        const currentStatus = yield* statusDevSkills(config, {agent: 'codex'}).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        const current = currentStatus.targets[0];
        if (!current?.installedDigest) throw new Error('Expected a verified current private bundle.');
        expect(current.installedDigest).toBe(currentStatus.bundle.digest);
        const priorDigest = EffectString.repeat(64)('a');
        expect(priorDigest).not.toBe(currentStatus.bundle.digest);
        const runId = 'task-cutover-prior-binding';
        const intent = {
          title: 'Controlled cutover task',
          currentBehavior: 'The old binding remains inspectable.',
          desiredChange: 'The old binding receives an explicit transition outcome.',
          affectedPaths: ['source.ts'],
          acceptanceCriterion: 'The old generation and canonical history remain unchanged.',
          verification: 'Read the transition outcome and canonical run bytes.',
          eligibilityRationale: 'One fixture task validates a bounded safe cutover.',
          eligibility: {status: 'eligible' as const},
          review: {required: false, reason: 'Cutover metadata fixture.'},
        };
        const initialized = object(
          yield* f.call({
            protocolVersion: 1,
            executorVersion: 1,
            action: 'init',
            runId,
            project: 'repo',
            featureId: 'controlled-cutover',
            generation: priorDigest,
            profile: 'desktop',
            title: intent.title,
          }),
        );
        const historicalWrite = object(
          yield* f.call({
            ...f.write({
              operationId: 'pre-cutover-history',
              artifactKey: 'pre-cutover-history',
              body: 'Canonical synthetic prior-binding evidence.\n',
            }),
            runId,
            generation: priorDigest,
          }),
        );
        expect(historicalWrite).toMatchObject({status: 'ok', runId, operationId: 'pre-cutover-history'});
        const bindingId = String(initialized.bindingId);
        const statePath = f.statePath(runId);
        const journalPath = f.journalPath(bindingId);
        const beforeBytes = yield* f.fs.readFileString(statePath);
        const beforeJournal = yield* f.fs.readFileString(journalPath);
        const before = yield* readNativeWorkflowState(config, runId);
        if (!before) throw new Error('Expected canonical prior binding.');
        expect(before.state.generation).toBe(priorDigest);
        expect(before.state.bindingId).toBe(bindingId);
        expect(before.state.operations).toHaveLength(1);
        const currentTaskCard = yield* readNativeTaskView(config, {runId, callerCwd: repo});
        const issuedTaskRef = String(currentTaskCard.taskRef);
        const decodedTaskRef = decodeNativeTaskActionRef(issuedTaskRef);
        expect(decodedTaskRef).toMatchObject({
          kind: 'task',
          runId,
          generationHash: sha256HexSync(priorDigest),
          stateRevision: before.revision,
        });
        const base = {
          callerCwd: repo,
          featureName: 'Controlled cutover',
          installationTarget: 'codex',
          taskRef: issuedTaskRef,
          intent,
        };
        const first = object(
          yield* runNativeTaskStart(config, base).pipe(Effect.provideService(SystemInfo, testSystem)),
        );
        expect(first).toMatchObject({
          status: 'binding-transition',
          outcome: 'drained',
          binding: {runId, generation: priorDigest, bindingId},
          selectedTarget: {installedDigest: currentStatus.bundle.digest},
          owners: [],
        });
        const repeated = object(
          yield* runNativeTaskStart(config, base).pipe(Effect.provideService(SystemInfo, testSystem)),
        );
        expect(repeated).toEqual(first);
        expect(yield* f.fs.readFileString(statePath)).toBe(beforeBytes);
        expect(yield* f.fs.readFileString(journalPath)).toBe(beforeJournal);
        const after = yield* readNativeWorkflowState(config, runId);
        expect(after?.state.generation).toBe(priorDigest);
        expect(after?.state.bindingId).toBe(bindingId);
        expect(after?.state.operations).toEqual(before.state.operations);
        if (!decodedTaskRef) throw new Error('Expected the issued task reference to decode.');
        const byCanonicalRunId = object(
          yield* runNativeTaskStart(config, {...base, taskRef: runId}).pipe(
            Effect.provideService(SystemInfo, testSystem),
          ),
        );
        expect(byCanonicalRunId).toEqual(first);
        const malformedRef = yield* runNativeTaskStart(config, {...base, taskRef: 'taskref-v1.invalid'}).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.result,
        );
        expect(malformedRef).toMatchObject({failure: {code: 'invalid-task-ref'}});
        const wrongKindRef = yield* runNativeTaskStart(config, {
          ...base,
          taskRef: encodeNativeTaskActionRef({...decodedTaskRef, kind: 'work'}),
        }).pipe(Effect.provideService(SystemInfo, testSystem), Effect.result);
        expect(wrongKindRef).toMatchObject({failure: {code: 'invalid-task-ref'}});
        const wrongScope = yield* runNativeTaskStart(config, {...base, featureName: 'Different feature'}).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.result,
        );
        expect(wrongScope).toMatchObject({failure: {code: 'task-identity-conflict'}});
        const staleGeneration = yield* runNativeTaskStart(config, {
          ...base,
          taskRef: encodeNativeTaskActionRef({...decodedTaskRef, generationHash: EffectString.repeat(64)('f')}),
        }).pipe(Effect.provideService(SystemInfo, testSystem), Effect.result);
        expect(staleGeneration).toMatchObject({failure: {code: 'stale-task-ref'}});
        const staleRevision = yield* runNativeTaskStart(config, {
          ...base,
          taskRef: encodeNativeTaskActionRef({...decodedTaskRef, stateRevision: EffectString.repeat(64)('0')}),
        }).pipe(Effect.provideService(SystemInfo, testSystem), Effect.result);
        expect(staleRevision).toMatchObject({failure: {code: 'stale-task-ref'}});
        expect(yield* f.fs.readFileString(statePath)).toBe(beforeBytes);
        expect(yield* f.fs.readFileString(journalPath)).toBe(beforeJournal);

        const foreignRepo = f.path.join(f.root, 'foreign-cutover');
        yield* f.fs.makeDirectory(foreignRepo);
        yield* f.fs.writeFileString(f.path.join(foreignRepo, 'source.ts'), 'export const foreign = true;\n');
        yield* runCommandEffect('git', ['init', '--initial-branch=main', foreignRepo]);
        const wrongRepo = yield* runNativeTaskStart(config, {...base, callerCwd: foreignRepo}).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.result,
        );
        expect(wrongRepo).toMatchObject({failure: {code: 'task-identity-conflict'}});
        expect(yield* f.fs.readFileString(statePath)).toBe(beforeBytes);
        expect(yield* f.fs.readFileString(journalPath)).toBe(beforeJournal);
        const wrongTarget = yield* runNativeTaskStart(config, {...base, installationTarget: 'missing-target'}).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.result,
        );
        expect(wrongTarget._tag).toBe('Failure');
        expect(yield* f.fs.readFileString(statePath)).toBe(beforeBytes);
        expect(yield* f.fs.readFileString(journalPath)).toBe(beforeJournal);
        const staleRun = yield* runNativeTaskStart(config, {...base, taskRef: 'task-cutover-missing'}).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.result,
        );
        expect(staleRun).toMatchObject({failure: {code: 'run-not-found'}});
        expect(yield* f.fs.readFileString(statePath)).toBe(beforeBytes);
        expect(yield* f.fs.readFileString(journalPath)).toBe(beforeJournal);
      }).pipe(run),
  );

  effectIt.effect.each([
    'prepared-data-before-write',
    'prepared-data',
    'prepared-view',
    'verified-data-prefix',
    'verified-last-child',
    'prepared-root',
    'verified-root',
  ])('recovers an exact semantic compact save at %s', cut =>
    Effect.gen(function* () {
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
        'Fixture source',
      ]);
      const system = yield* SystemInfo;
      const repo = yield* f.fs.realPath(f.repo);
      const home = yield* f.fs.realPath(f.home);
      const config = {...f.config, agentContextHome: home, manifestPath: f.path.join(home, 'manifest.json')};
      const scopedSystem = {...system, currentDirectory: () => repo, homeDirectory: home};
      yield* applyDevSkills(config, 'install', {agent: 'codex'}).pipe(Effect.provideService(SystemInfo, scopedSystem));
      const indexer = yield* CodeGraphIndexer;
      expect((yield* indexer.index({cwd: repo, threadnoteHome: home})).snapshot.state).toBe('ready');
      const intent = {
        title: 'Recover one compact fixture change',
        currentBehavior: 'Expired fixture data is returned.',
        desiredChange: 'Expired fixture data is refreshed before return.',
        affectedPaths: ['source.ts'],
        acceptanceCriterion: 'The refreshed fixture value is returned.',
        verification: 'Read an expired fixture.',
        eligibilityRationale: 'One source-bound fixture behavior with no unresolved decisions.',
        eligibility: {status: 'eligible'},
        review: {required: false, reason: 'Bounded fixture correction.'},
      };
      const featureName = 'Recovery ' + cut;
      const runId = 'task-' + EffectString.slice(0, 48)(sha256HexSync('repo\nrecovery-' + cut));
      const base = {featureName, callerCwd: repo, installationTarget: 'codex', intent};
      const statePath = f.path.join(home, 'workflow-automations', 'native-v1', runId + '.json');
      const actualFs = yield* FileSystem.FileSystem;
      const actualPath = yield* Path.Path;
      const observe = () =>
        readNativeWorkflowState(config, runId).pipe(
          Effect.provideService(FileSystem.FileSystem, actualFs),
          Effect.provideService(Path.Path, actualPath),
          Effect.orDie,
        );
      let injected = false;
      const writes = new Map<string, number>();
      const stop = () =>
        Effect.sync(() => {
          injected = true;
        }).pipe(Effect.andThen(Effect.die(new Error('Synthetic compact cut: ' + cut))));
      const matchesPrepared = (state: Effect.Success<ReturnType<typeof readNativeWorkflowState>>) => {
        const last = state?.state.operations.at(-1);
        if (!state?.state.authoringSave || last?.status !== 'prepared') return false;
        if (cut === 'prepared-data' || cut === 'prepared-data-before-write') return last.intent.nameHint === 'source';
        if (cut === 'prepared-view') return last.intent.nameHint === 'plan-overview';
        return (
          cut === 'prepared-root' &&
          last.intent.role === 'authoring-root' &&
          last.intent.artifactKey === 'author-root-plan'
        );
      };
      const observedStore = ResourceStore.of({
        ...f.store,
        writeChecked: <E, R>(
          location: ResourceStoreLocation,
          uri: string,
          content: string,
          options: ResourceStoreWriteOptions,
          check: Effect.Effect<void, E, R>,
        ) =>
          Effect.gen(function* () {
            if (!injected && cut === 'prepared-data-before-write' && matchesPrepared(yield* observe()))
              return yield* stop();
            const result = yield* f.store.writeChecked(location, uri, content, options, check);
            writes.set(uri, (writes.get(uri) ?? 0) + 1);
            if (!injected && cut !== 'prepared-data-before-write' && matchesPrepared(yield* observe()))
              return yield* stop();
            return result;
          }),
      });
      const faultFs = {
        ...actualFs,
        rename: (from: string, to: string) =>
          actualFs.rename(from, to).pipe(
            Effect.tap(() =>
              Effect.gen(function* () {
                if (injected || to !== statePath) return;
                const state = yield* observe();
                const last = state?.state.operations.at(-1);
                if (!state?.state.authoringSave || last?.status !== 'verified') return;
                const selected =
                  cut === 'verified-data-prefix'
                    ? last.intent.nameHint === 'source'
                    : cut === 'verified-last-child'
                      ? last.intent.nameHint === 'decisions'
                      : cut === 'verified-root' && last.intent.role === 'authoring-root';
                if (selected) return yield* stop();
              }),
            ),
          ),
      };
      const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(SystemInfo, scopedSystem),
          Effect.provideService(ResourceStore, observedStore),
          Effect.provideService(FileSystem.FileSystem, faultFs),
        );
      const interrupted = yield* scoped(runNativeTaskStart(config, base)).pipe(Effect.result);
      expect(interrupted, cut).toMatchObject({
        failure: {message: expect.stringContaining('Synthetic compact cut: ' + cut)},
      });
      expect(injected, cut).toBe(true);
      const pending = yield* observe();
      if (!pending?.state.authoringSave) throw new Error('Expected the original admitted save at ' + cut);
      const reservation = pending.state.authoringSave;
      expect(reservation.operationStart).toBe(0);
      expect(reservation.rootUri).toBeNull();
      const prefix = pending.state.operations;
      expect(prefix.length).toBeGreaterThan(0);
      expect(prefix.at(-1)?.status).toBe(EffectString.startsWith('verified-')(cut) ? 'verified' : 'prepared');
      const originalBytes = yield* f.fs.readFileString(statePath);
      const journalPath = f.journalPath(pending.state.bindingId);
      const originalJournal = yield* f.fs.readFileString(journalPath);
      const writesBefore = [...writes];
      const prefixReadbacks: {uri: string; bytes: string}[] = [];
      for (const operation of prefix)
        if (operation.status === 'verified' && operation.artifact)
          prefixReadbacks.push({
            uri: operation.artifact.uri,
            bytes: yield* f.store.read(f.location, operation.artifact.uri),
          });
      const unchanged = () =>
        Effect.gen(function* () {
          expect(yield* f.fs.readFileString(statePath), cut).toBe(originalBytes);
          expect(yield* f.fs.readFileString(journalPath), cut).toBe(originalJournal);
          expect([...writes], cut).toEqual(writesBefore);
        });
      const changed = yield* scoped(
        runNativeTaskStart(config, {
          ...base,
          taskRef: runId,
          intent: {...intent, desiredChange: 'Discard expired fixture data.'},
        }),
      ).pipe(Effect.result);
      expect(changed, cut).toMatchObject({failure: {code: 'pending-operation'}});
      yield* unchanged();
      yield* f.fs.writeFileString(f.path.join(repo, 'source.ts'), 'export const fixture = false;\n');
      const drifted = yield* scoped(runNativeTaskStart(config, {...base, taskRef: runId})).pipe(Effect.result);
      expect(drifted, cut).toMatchObject({failure: {code: 'evidence-unavailable'}});
      yield* unchanged();
      yield* f.fs.writeFileString(f.path.join(repo, 'source.ts'), 'export const fixture = true;\n');
      const foreignRepo = f.path.join(f.root, 'other', 'repo');
      yield* f.fs.makeDirectory(foreignRepo, {recursive: true});
      yield* runCommandEffect('git', ['init', '--initial-branch=main', foreignRepo]);
      const foreign = yield* scoped(runNativeTaskStart(config, {...base, taskRef: runId, callerCwd: foreignRepo})).pipe(
        Effect.result,
      );
      expect(foreign, cut).toMatchObject({failure: {code: 'binding-drift'}});
      yield* unchanged();
      const notEligible = yield* scoped(
        runNativeTaskStart(config, {
          ...base,
          taskRef: runId,
          intent: {
            ...intent,
            eligibility: {status: 'needs-planning', missingDecision: 'Choose another behavior.', evidenceRefs: []},
          },
        }),
      ).pipe(Effect.result);
      expect(notEligible).toMatchObject({failure: {code: 'task-intent-conflict'}});
      yield* unchanged();
      const firstRoot = EffectArray.some(
        prefix,
        item => item.status === 'verified' && item.intent.role === 'authoring-root',
      );
      if (!firstRoot) {
        const {authoringSave: _reservation, ...unrelated} = pending.state;
        yield* Effect.acquireUseRelease(
          f.fs.writeFileString(statePath, serializeNativeWorkflowState(unrelated)),
          () =>
            Effect.gen(function* () {
              const unreservedBytes = yield* f.fs.readFileString(statePath);
              const refused = yield* scoped(runNativeTaskStart(config, {...base, taskRef: runId})).pipe(Effect.result);
              expect(refused).toMatchObject({failure: {code: 'task-intent-missing'}});
              expect(yield* f.fs.readFileString(statePath)).toBe(unreservedBytes);
              expect(yield* f.fs.readFileString(journalPath)).toBe(originalJournal);
              expect([...writes]).toEqual(writesBefore);
            }),
          () => f.fs.writeFileString(statePath, originalBytes),
        );
      }
      if (prefix.length >= 2 && prefix[0].status === 'verified' && prefix[1].status === 'verified') {
        const malformed = {...pending.state, operations: [prefix[1], prefix[0], ...prefix.slice(2)]};
        yield* Effect.acquireUseRelease(
          f.fs.writeFileString(statePath, serializeNativeWorkflowState(malformed)),
          () =>
            Effect.gen(function* () {
              const badBytes = yield* f.fs.readFileString(statePath);
              const refused = yield* scoped(runNativeTaskStart(config, {...base, taskRef: runId})).pipe(Effect.result);
              expect(refused, cut).toMatchObject({failure: {code: 'pending-operation'}});
              expect(yield* f.fs.readFileString(statePath)).toBe(badBytes);
              expect(yield* f.fs.readFileString(journalPath)).toBe(originalJournal);
              expect([...writes]).toEqual(writesBefore);
            }),
          () => f.fs.writeFileString(statePath, originalBytes),
        );
      }
      const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
      registerWorkflowTaskTool(mcp, config);
      const recovered = object(yield* scoped(mcp.invokeTool('workflow_task_start', {...base, taskRef: runId})));
      expect(recovered.isError, cut).not.toBe(true);
      const complete = yield* observe();
      if (!complete) throw new Error('Expected recovered task state.');
      expect(complete.state.authoringSave, cut).toBeUndefined();
      expect(complete.state.runId).toBe(pending.state.runId);
      expect(complete.state.generation).toBe(pending.state.generation);
      expect(complete.state.bindingId).toBe(pending.state.bindingId);
      for (const key of ['project', 'featureId', 'title', 'profile', 'team', 'naming'] as const)
        expect(complete.state[key], cut + ' identity ' + key).toEqual(pending.state[key]);
      expect(new Set(EffectArray.map(complete.state.operations, item => item.intent.operationId)).size).toBe(
        complete.state.operations.length,
      );
      expect(EffectArray.every(complete.state.operations, item => item.status === 'verified')).toBe(true);
      expect(EffectArray.map(complete.state.operations, item => item.intent.nameHint)).toEqual([
        'source',
        'index',
        'plan-overview',
        'decisions',
        'plan',
      ]);
      for (const original of prefixReadbacks)
        expect(yield* f.store.read(f.location, original.uri)).toBe(original.bytes);
      expect(
        EffectArray.map(complete.state.operations.slice(0, prefix.length), item => ({
          intent: item.intent,
          digest: item.intentDigest,
        })),
      ).toEqual(EffectArray.map(prefix, item => ({intent: item.intent, digest: item.intentDigest})));
      for (const operation of complete.state.operations) {
        if (!operation.artifact) throw new Error('Expected verified artifact.');
        expect(writes.get(operation.artifact.uri), cut + ' ' + operation.intent.nameHint).toBe(1);
      }
      const view = object(yield* scoped(readNativeTaskView(config, {runId, callerCwd: repo, detail: 'packet'})));
      const authoring = object(view.authoring);
      expect(authoring).toMatchObject({readiness: 'draft', status: 'awaiting-user-confirmation'});
      expect(authoring.confirmation).toBeUndefined();
      const document = yield* Schema.decodeUnknownEffect(NativeAuthoringPlanDocumentSchema)(
        object(authoring.packet).document,
      );
      expect(document.current.summary).toBe(intent.currentBehavior);
      expect(document.target.summary).toBe(intent.desiredChange);
      expect(authoring.documentHash).toBe(nativeAuthoringDigest(document));
      const loaded = object(
        object(
          yield* scoped(
            runWorkflowAutomation(config, {
              protocolVersion: 1,
              executorVersion: 1,
              action: 'authoring',
              command: 'load',
              runId,
              generation: complete.state.generation,
              uri: object(authoring.root).uri,
              detail: 'document',
            }),
          ),
        ).authoring,
      );
      expect(loaded.document).toEqual(document);
      const finishedBytes = yield* f.fs.readFileString(statePath);
      const finishedWrites = [...writes];
      yield* f.fs.writeFileString(f.path.join(repo, 'source.ts'), 'export const fixture = false;\n');
      const replay = object(yield* scoped(runNativeTaskStart(config, {...base, taskRef: runId})));
      expect(replay.status).toBe('resumed');
      expect(yield* f.fs.readFileString(statePath)).toBe(finishedBytes);
      expect([...writes]).toEqual(finishedWrites);
      yield* f.fs.writeFileString(f.path.join(repo, 'source.ts'), 'export const fixture = true;\n');
      const confirmed = object(
        yield* scoped(
          runNativeTaskAction(config, {
            command: 'compact-confirm',
            runId,
            callerCwd: repo,
            presentedIntentHash: authoring.intentHash,
            userDecision: 'approve',
            userResponse: 'I approve this exact recovered fixture change.',
            baseBranch: 'main',
          }),
        ),
      );
      expect(confirmed, cut).toMatchObject({status: 'admitted', taskReadiness: 'ready'});
      expect((yield* observe())?.state.authoringSave).toBeUndefined();
    }).pipe(run),
  );

  effectIt.effect('resumes a graph-free standard compact save that a busy memory lock stopped', () =>
    Effect.gen(function* () {
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
        'Fixture source',
      ]);
      const system = yield* SystemInfo;
      const repo = yield* f.fs.realPath(f.repo);
      const home = yield* f.fs.realPath(f.home);
      const config = {...f.config, agentContextHome: home, manifestPath: f.path.join(home, 'manifest.json')};
      const scopedSystem = {...system, currentDirectory: () => repo, homeDirectory: home};
      yield* applyDevSkills(config, 'install', {agent: 'codex'}).pipe(Effect.provideService(SystemInfo, scopedSystem));
      // No graph is published, so the standard start writes its first children without code citations.
      const start = {
        featureName: 'Busy graph-free start',
        callerCwd: repo,
        installationTarget: 'codex',
        workflowProfile: 'standard' as const,
        intent: {
          title: 'Busy graph-free start',
          currentBehavior: 'Expired fixture data is returned.',
          desiredChange: 'Expired fixture data is refreshed before return.',
          affectedPaths: ['source.ts'],
          acceptanceCriterion: 'The refreshed fixture value is returned.',
          verification: 'Read an expired fixture.',
          eligibilityRationale: 'One source-bound fixture behavior with no unresolved decisions.',
          eligibility: {status: 'eligible' as const},
          review: {required: false, reason: 'Bounded fixture correction.'},
        },
      };
      const runId = nativeTaskStartRunId(undefined, 'repo', workflowTitleSlug(start.featureName));
      const testScope = yield* Effect.scope;
      const actualFs = yield* FileSystem.FileSystem;
      const indexer = yield* CodeGraphIndexer;
      const statePath = f.path.join(home, 'workflow-automations', 'native-v1', runId + '.json');
      const release = yield* Deferred.make<void>();
      let holder: Fiber.Fiber<void, unknown> | undefined;
      const healMemoryLocks: string[] = [];
      // After the first child is verified, a graph index publishes and heals deferred anchors, as the start's
      // warm-up does. Then another writer holds the memory lock, so the next child exhausts its lock budget.
      const faultFs = {
        ...actualFs,
        rename: (from: string, to: string) =>
          actualFs.rename(from, to).pipe(
            Effect.tap(() =>
              Effect.gen(function* () {
                if (holder || to !== statePath) return;
                if ((yield* readNativeWorkflowState(config, runId))?.state.operations[0]?.status !== 'verified') return;
                const summary = yield* indexer.index({cwd: repo, threadnoteHome: home, ensureVectors: false});
                yield* healAnchorsAfterGraphIndex(config, repo, summary.identity).pipe(
                  Effect.provideService(FileSystem.FileSystem, {
                    ...actualFs,
                    writeFileString: (path, data, options) => {
                      if (EffectString.includes('memory-locks')(path)) healMemoryLocks.push(path);
                      return actualFs.writeFileString(path, data, options);
                    },
                  }),
                );
                const acquired = yield* Deferred.make<void>();
                holder = yield* withDeferredCodeAnchorMutationLocks(
                  actualFs,
                  config,
                  [],
                  Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Deferred.await(release))),
                ).pipe(Effect.asVoid, Effect.forkIn(testScope));
                yield* Deferred.await(acquired);
              }).pipe(Effect.provideService(FileSystem.FileSystem, actualFs)),
            ),
          ),
      };
      const stopped = yield* runNativeTaskStart(config, start).pipe(
        Effect.provideService(SystemInfo, scopedSystem),
        Effect.provideService(FileSystem.FileSystem, faultFs),
        Effect.result,
      );
      expect(stopped).toMatchObject({failure: {code: 'memory-busy', retryable: true}});
      yield* Deferred.succeed(release, undefined);
      if (holder) yield* Fiber.join(holder);
      // The run queues no deferred anchor, so the warm-up heal took no memory lock and left the child unchanged.
      expect(healMemoryLocks).toEqual([]);
      const first = (yield* readNativeWorkflowState(config, runId))?.state.operations[0]?.artifact;
      if (!first) throw new Error('Expected the verified first child.');
      expect(yield* f.store.read(f.location, first.uri).pipe(Effect.flatMap(sha256Hex))).toBe(first.revision);
      const resumed = object(
        yield* runNativeTaskStart(config, start).pipe(Effect.provideService(SystemInfo, scopedSystem)),
      );
      expect(resumed.status).toBe('awaiting-user-confirmation');
      const complete = yield* readNativeWorkflowState(config, runId);
      expect(complete?.state.authoringSave).toBeUndefined();
      expect(EffectArray.map(complete?.state.operations ?? [], item => [item.intent.nameHint, item.status])).toEqual([
        ['source', 'verified'],
        ['index', 'verified'],
        ['plan-overview', 'verified'],
        ['decisions', 'verified'],
        ['plan', 'verified'],
      ]);
    }).pipe(run),
  );

  effectIt.effect(
    'starts a semantic task from a verified local installed bundle and safely replays or refuses changed intent',
    () =>
      Effect.gen(function* () {
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
          'Fixture source',
        ]);
        const intent = {
          title: 'Refresh expired fixture data',
          currentBehavior: 'Expired fixture data is returned without a freshness check.',
          desiredChange: 'Expired fixture data is refreshed before it is returned.',
          affectedPaths: ['source.ts'],
          acceptanceCriterion: 'Expired fixture data is refreshed before return.',
          verification: 'Exercise expired fixture data and observe the refresh.',
          eligibilityRationale:
            'One behavior and one inspected file are explicit, with no unresolved product decision.',
          eligibility: {status: 'eligible' as const},
          review: {required: false, reason: 'Routine local fixture correction.'},
        };
        const base = {callerCwd: f.repo, featureName: 'Fixture refresh', installationTarget: 'codex', intent};
        const withoutTarget = {callerCwd: f.repo, featureName: 'Fixture refresh', intent};
        const missingResources = yield* runNativeTaskStart(f.config, withoutTarget).pipe(Effect.result);
        expect(missingResources).toMatchObject({failure: {code: 'needs-resources'}});
        const needsPlanning = yield* runNativeTaskStart(f.config, {
          ...base,
          intent: {
            ...intent,
            eligibility: {
              status: 'needs-planning' as const,
              missingDecision: 'Select refresh behavior.',
              evidenceRefs: [],
            },
          },
        });
        expect(needsPlanning).toMatchObject({status: 'needs-planning', missingDecision: 'Select refresh behavior.'});

        const system = yield* SystemInfo;
        const canonicalRepo = yield* f.fs.realPath(f.repo);
        const canonicalHome = yield* f.fs.realPath(f.home);
        const config = {
          ...f.config,
          agentContextHome: canonicalHome,
          manifestPath: f.path.join(canonicalHome, 'manifest.json'),
        };
        const testSystem = {...system, currentDirectory: () => canonicalRepo, homeDirectory: canonicalHome};
        const expectedRunId = 'task-' + EffectString.slice(0, 48)(sha256HexSync('repo\nfixture-refresh'));
        const installed = yield* applyDevSkills(config, 'install', {
          agent: 'codex',
        }).pipe(Effect.provideService(SystemInfo, testSystem));
        expect(installed.applied).toBe(true);
        const graphBlocked = yield* runNativeTaskStart(config, base).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.result,
        );
        expect(graphBlocked).toMatchObject({failure: {code: 'evidence-unavailable'}});
        expect(yield* readNativeWorkflowState(config, expectedRunId)).toBeUndefined();
        const graph = yield* GraphDiagnostics;
        expect(
          (yield* graph.prepare(
            Effect.flatMap(CodeGraphIndexer, indexer =>
              indexer.index({cwd: canonicalRepo, threadnoteHome: canonicalHome}),
            ),
          )).snapshot.state,
        ).toBe('ready');
        const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
        registerWorkflowTaskTool(mcp, config);
        const missingTargetMcpCall = yield* mcp.invokeTool('workflow_task_start', withoutTarget).pipe(Effect.result);
        expect(missingTargetMcpCall._tag).toBe('Failure');
        expect(yield* readNativeWorkflowState(config, expectedRunId)).toBeUndefined();
        const testFs = yield* FileSystem.FileSystem;
        const testPath = yield* Path.Path;
        let injectedPreparedRoot = false;
        let checkedWrites = 0;
        const interruptedStore = ResourceStore.of({
          ...f.store,
          writeChecked: <E, R>(
            location: ResourceStoreLocation,
            uri: string,
            content: string,
            options: ResourceStoreWriteOptions,
            check: Effect.Effect<void, E, R>,
          ) =>
            f.store.writeChecked(location, uri, content, options, check).pipe(
              Effect.tap(() => {
                checkedWrites++;
                if (injectedPreparedRoot) return Effect.void;
                return readNativeWorkflowState(config, expectedRunId).pipe(
                  Effect.provideService(FileSystem.FileSystem, testFs),
                  Effect.provideService(Path.Path, testPath),
                  Effect.orDie,
                  Effect.map(state => {
                    if (!state?.state.authoringSave) return false;
                    const firstPrepared = EffectArray.findFirst(
                      state.state.operations,
                      operation => operation.status === 'prepared',
                    );
                    const last = state.state.operations[state.state.operations.length - 1];
                    return (
                      firstPrepared._tag === 'Some' &&
                      firstPrepared.value === last &&
                      last?.intent.artifactKey === 'author-root-plan' &&
                      last.intent.role === 'authoring-root' &&
                      last.intent.sourceRunId === expectedRunId
                    );
                  }),
                  Effect.flatMap(isPreparedRoot => {
                    if (!isPreparedRoot) return Effect.void;
                    injectedPreparedRoot = true;
                    return Effect.die(new Error('Synthetic lost acknowledgement after prepared compact root'));
                  }),
                );
              }),
            ),
        });
        const interrupted = yield* runNativeTaskStart(config, base).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.provideService(ResourceStore, interruptedStore),
          Effect.result,
        );
        expect(interrupted._tag).toBe('Failure');
        expect(injectedPreparedRoot).toBe(true);
        const preparedState = yield* readNativeWorkflowState(config, expectedRunId);
        expect(preparedState?.state.authoringSave).toBeDefined();
        const pendingRoot = preparedState?.state.operations[preparedState.state.operations.length - 1];
        expect(pendingRoot).toMatchObject({
          status: 'prepared',
          intent: {artifactKey: 'author-root-plan', role: 'authoring-root', sourceRunId: expectedRunId},
        });
        const writesAtFailure = checkedWrites;
        const preparedStatePath = f.path.join(
          canonicalHome,
          'workflow-automations',
          'native-v1',
          expectedRunId + '.json',
        );
        const preparedBytes = yield* f.fs.readFileString(preparedStatePath);
        const changedPendingIntent = yield* runNativeTaskStart(config, {
          ...base,
          intent: {...intent, desiredChange: 'Delete expired fixture data.'},
        }).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.provideService(ResourceStore, interruptedStore),
          Effect.result,
        );
        expect(changedPendingIntent).toMatchObject({failure: {code: 'pending-operation'}});
        expect(yield* f.fs.readFileString(preparedStatePath)).toBe(preparedBytes);
        expect(checkedWrites).toBe(writesAtFailure);
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = false;\n');
        const changedPendingSource = yield* runNativeTaskStart(config, base).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.provideService(ResourceStore, interruptedStore),
          Effect.result,
        );
        expect(changedPendingSource._tag).toBe('Failure');
        expect(yield* f.fs.readFileString(preparedStatePath)).toBe(preparedBytes);
        expect(checkedWrites).toBe(writesAtFailure);
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = true;\n');
        const startResponse = object(
          yield* mcp
            .invokeTool('workflow_task_start', base)
            .pipe(
              Effect.provideService(SystemInfo, testSystem),
              Effect.provideService(ResourceStore, interruptedStore),
            ),
        );
        expect(checkedWrites).toBe(writesAtFailure);
        expect(startResponse.isError).not.toBe(true);
        const started = object(startResponse.structuredContent);
        expect(started.status).toBe('awaiting-user-confirmation');
        expect(typeof started.runId).toBe('string');
        expect(started.taskRef).toBe(started.runId);
        const runId = String(started.runId);
        const statePath = f.path.join(canonicalHome, 'workflow-automations', 'native-v1', runId + '.json');
        const savedState = yield* f.fs.readFileString(statePath);
        const resumed = object(
          yield* runNativeTaskStart(config, base).pipe(
            Effect.provideService(SystemInfo, testSystem),
            Effect.provideService(ResourceStore, interruptedStore),
          ),
        );
        expect(resumed).toMatchObject({status: 'resumed', runId, taskRef: runId});
        const {intent: _intent, ...withoutIntent} = base;
        const resumeWithoutIntent = yield* runNativeTaskStart(config, {...withoutIntent, taskRef: runId}).pipe(
          Effect.result,
        );
        expect(resumeWithoutIntent).toMatchObject({
          failure: {code: 'invalid-request', message: expect.stringContaining('resume requires intent')},
        });
        const viewByFeatureName = yield* readNativeTaskView(config, {runId: 'fixture-refresh', callerCwd: f.repo}).pipe(
          Effect.result,
        );
        expect(viewByFeatureName).toMatchObject({
          failure: {code: 'run-not-found', message: expect.stringContaining('runId that workflow_task_start returned')},
        });
        expect(yield* f.fs.readFileString(statePath)).toBe(savedState);

        let cliResult: Record<string, unknown> | undefined;
        let cliHandlerCalls = 0;
        const taskStart = makeNativeTaskStartCommand(options => {
          cliHandlerCalls++;
          const {eligibility, missingDecision, evidenceRefs, reviewRequired, reviewReason, ...fields} = options;
          const cliIntent = {
            title: fields.title,
            currentBehavior: fields.currentBehavior,
            desiredChange: fields.desiredChange,
            affectedPaths: fields.affectedPaths,
            acceptanceCriterion: fields.acceptanceCriterion,
            verification: fields.verification,
            eligibilityRationale: fields.eligibilityRationale,
            eligibility:
              eligibility === 'eligible'
                ? {status: 'eligible' as const}
                : {status: 'needs-planning' as const, missingDecision: missingDecision ?? '', evidenceRefs},
            review: {required: reviewRequired, reason: reviewReason},
          };
          return runNativeTaskStart(config, {
            callerCwd: fields.callerCwd,
            featureName: fields.featureName,
            installationTarget: fields.installationTarget,
            ...(fields.taskRef === undefined ? {} : {taskRef: fields.taskRef}),
            intent: cliIntent,
          }).pipe(
            Effect.provideService(SystemInfo, testSystem),
            Effect.tap(value => Effect.sync(() => (cliResult = object(value)))),
            Effect.asVoid,
          );
        });
        const cli = Command.make('workflow-automation').pipe(Command.withSubcommands([taskStart]));
        const runCli = Command.runWith(cli, {version: 'fixture'});
        const taskStartArgs = [
          '--caller-cwd',
          f.repo,
          '--feature-name',
          'Fixture refresh',
          '--title',
          intent.title,
          '--current-behavior',
          intent.currentBehavior,
          '--desired-change',
          intent.desiredChange,
          '--affected-path',
          'source.ts',
          '--acceptance',
          intent.acceptanceCriterion,
          '--verification',
          intent.verification,
          '--eligibility-rationale',
          intent.eligibilityRationale,
          '--eligibility',
          'eligible',
          '--review-reason',
          intent.review.reason,
        ];
        const missingTargetCli = yield* runCli(['task-start', ...taskStartArgs]).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.result,
        );
        expect(missingTargetCli._tag).toBe('Failure');
        expect(cliHandlerCalls).toBe(0);
        yield* runCli(['task-start', '--installation-target', 'codex', ...taskStartArgs]).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(cliResult).toMatchObject({status: 'resumed', taskRef: runId});
        expect(yield* f.fs.readFileString(statePath)).toBe(savedState);

        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = false;\n');
        const replayAfterSourceDrift = object(
          yield* runNativeTaskStart(config, base).pipe(Effect.provideService(SystemInfo, testSystem)),
        );
        expect(replayAfterSourceDrift.status).toBe('resumed');
        expect(yield* f.fs.readFileString(statePath)).toBe(savedState);

        const foreignRepo = f.path.join(f.root, 'foreign');
        yield* f.fs.makeDirectory(foreignRepo);
        yield* f.fs.writeFileString(f.path.join(foreignRepo, 'source.ts'), 'export const fixture = true;\n');
        yield* runCommandEffect('git', ['init', '--initial-branch=main', foreignRepo]);
        yield* runCommandEffect('git', ['-C', foreignRepo, 'add', 'source.ts']);
        yield* runCommandEffect('git', [
          '-C',
          foreignRepo,
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '-m',
          'Foreign source',
        ]);
        const foreignResume = yield* runNativeTaskStart(config, {
          ...base,
          callerCwd: foreignRepo,
          taskRef: runId,
        }).pipe(Effect.provideService(SystemInfo, testSystem), Effect.result);
        expect(foreignResume).toMatchObject({failure: {code: 'task-identity-conflict'}});
        expect(yield* f.fs.readFileString(statePath)).toBe(savedState);

        const changed = yield* runNativeTaskStart(config, {
          ...base,
          intent: {...intent, desiredChange: 'Delete expired fixture data.'},
        }).pipe(Effect.provideService(SystemInfo, testSystem), Effect.result);
        expect(changed).toMatchObject({failure: {code: 'task-intent-conflict'}});
        expect(yield* f.fs.readFileString(statePath)).toBe(savedState);
      }).pipe(run, provideTestLayer(cliTestLayer)),
  );

  effectIt.effect(
    'recovers an unchanged-tree rebase through the task snapshot facade without carrying review or validation',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(['one'], 'pr');
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "feature";\n');
        yield* f.git(['commit', '-am', 'Feature snapshot']);
        const head = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
        const captured = object(
          object(
            (yield* f.mutate('snapshot', {
              phaseId: 'one',
              snapshotId: 'before-rebase',
              acceptedHead: head,
              reason: 'Capture the feature before review.',
            })).snapshot,
          ).snapshot,
        );
        const before = yield* readNativeWorkflowState(f.config, 'native-run');
        const originalView = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
        const snapshotRef = originalView.phase?.snapshot?.snapshotRef;
        if (!snapshotRef) throw new Error('Expected the original review reference.');
        yield* f.git(['checkout', 'main']);
        yield* f.git(['commit', '--allow-empty', '-m', 'Advance base identity without tree changes']);
        yield* f.git(['checkout', 'feature/one']);
        yield* f.git(['rebase', 'main']);
        const view = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
        expect(view.unreviewedRebaseRecovery).toMatchObject({
          action: 'recover-unreviewed-rebase',
          snapshotRef,
          userAuthorityRequired: true,
        });
        const request = {
          command: 'recover-unreviewed-rebase-snapshot',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef,
          reason: 'Recover the authorized same-tree rebase.',
          userAuthority: 'Rebase this approved feature onto updated main.',
        };
        const bytes = yield* f.fs.readFileString(f.statePath());
        const report = {
          mode: 'full',
          selected: ['correctness', 'simplicity'],
          lanes: [
            {name: 'correctness', status: 'complete'},
            {name: 'simplicity', status: 'complete'},
          ],
          findings: [],
        };
        expect(
          yield* runNativeTaskActionCore(f.config, {
            command: 'record-review',
            runId: 'native-run',
            callerCwd: f.repo,
            snapshotRef,
            report,
          }).pipe(Effect.result),
        ).toMatchObject({failure: {code: 'source-drift'}});
        expect(yield* f.fs.readFileString(f.statePath())).toBe(bytes);
        const afterRejectedReview = yield* readNativeWorkflowState(f.config, 'native-run');
        expect(afterRejectedReview?.state.cycle?.attempts).toEqual(before?.state.cycle?.attempts);
        expect(afterRejectedReview?.state.cycle?.reviews).toEqual(before?.state.cycle?.reviews);

        expect(
          yield* runNativeTaskActionCore(f.config, {...request, userAuthority: '   '}).pipe(Effect.result),
        ).toMatchObject({failure: {code: 'invalid-rebase-recovery'}});
        expect(yield* f.fs.readFileString(f.statePath())).toBe(bytes);
        const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
        registerWorkflowTaskTool(mcp, f.config);
        const recovered = object(
          object(
            yield* mcp.invokeTool('workflow_task_snapshot', {
              runId: request.runId,
              callerCwd: request.callerCwd,
              snapshot: {
                command: 'recover-unreviewed-rebase',
                snapshotRef,
                reason: request.reason,
                userAuthority: request.userAuthority,
              },
            }),
          ).structuredContent,
        );
        const admitted = object(object(recovered.snapshot).snapshot);
        expect(admitted.tree).toBe(captured.tree);
        expect(admitted.head).not.toBe(captured.head);
        const after = yield* readNativeWorkflowState(f.config, 'native-run');
        expect(after?.state.cycle?.snapshots[0]).toEqual(before?.state.cycle?.snapshots[0]);
        expect(after?.state.cycle?.baselines).toEqual(before?.state.cycle?.baselines);
        expect(after?.state.cycle?.reviews).toEqual([]);
        expect(after?.state.cycle?.state.phases.one.validation).toBeUndefined();
        expect(object(yield* runNativeTaskAction(f.config, request))).toMatchObject({
          replayed: true,
          snapshotRef: recovered.snapshotRef,
        });
        const reviewed = object(
          yield* runNativeTaskAction(f.config, {
            command: 'record-review',
            runId: request.runId,
            callerCwd: f.repo,
            snapshotRef: recovered.snapshotRef,
            report: {
              mode: 'full',
              selected: ['correctness', 'simplicity'],
              lanes: [
                {name: 'correctness', status: 'complete'},
                {name: 'simplicity', status: 'complete'},
              ],
              findings: [],
            },
          }),
        );
        expect(reviewed.status, typeof reviewed.message === 'string' ? reviewed.message : undefined).toBe('recorded');
        const validated = object(
          yield* runNativeTaskAction(f.config, {
            command: 'record-validation',
            runId: 'native-run',
            callerCwd: f.repo,
            snapshotRef: recovered.snapshotRef,
            validation: {
              checks: [
                {command: 'same-tree source check', result: 'passed', evidence: 'Actual rebase source was read.'},
              ],
              acceptance: [{criterion: 'one works', result: 'passed', evidence: 'Recovered source and history match.'}],
            },
          }),
        );
        const publication = {exemption: 'small-fix', reason: 'Private same-tree recovery fixture.'};
        expect(yield* f.mutate('publication-ready', {phaseId: 'one', publication})).toMatchObject({
          status: 'ok',
          tree: captured.tree,
        });
        const prHead = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
        expect(
          object(
            yield* runNativeTaskAction(f.config, {
              command: 'deliver-pr',
              runId: 'native-run',
              callerCwd: f.repo,
              validationRef: String(validated.validationRef),
              commitEvidence: 'Recovered exact source ' + prHead,
              publication,
              pr: {
                url: 'https://github.com/example/repo/pull/1058',
                headSha: prHead,
                branch: 'feature/one',
                baseBranch: 'main',
                state: 'open',
              },
            }),
          ),
        ).toMatchObject({status: 'watch-required'});
      }).pipe(run),
  );

  effectIt.effect('recovers an unreviewed snapshot through the public task action and requires full review', () =>
    Effect.gen(function* () {
      const affectedPaths = Array.from(
        {length: 160},
        (_, index) => `receipt-${index}-abcdefghijklmnopqrstuvwxyz012345.txt`,
      );
      const f = yield* fixture(['one'], 'local', false, false, true, undefined, undefined, {one: affectedPaths});
      for (const path of affectedPaths) yield* f.fs.writeFileString(f.path.join(f.repo, path), 'Admitted text.\n');
      yield* f.git(['add', ...affectedPaths]);
      yield* f.git(['commit', '-m', 'Admit bounded-response snapshot scope']);
      yield* f.mutate('begin-phase', {phaseId: 'one'});
      const work = object(
        yield* runNativeTaskAction(f.config, {
          command: 'work',
          runId: 'native-run',
          callerCwd: f.repo,
          packet,
        }),
      );
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "first admitted files";\n');
      for (const path of affectedPaths) yield* f.fs.writeFileString(f.path.join(f.repo, path), 'Changed text.\n');
      yield* f.git(['add', 'source.ts', ...affectedPaths]);
      yield* f.git(['commit', '-m', 'First source candidate']);
      const firstResult = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-snapshot',
          runId: 'native-run',
          callerCwd: f.repo,
          workRef: String(work.workRef),
        }),
      );
      const firstSnapshot = object(object(firstResult.snapshot).snapshot);
      const firstSnapshotRef = String(firstResult.snapshotRef);
      const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
      const storedFirst = (yield* readNativeWorkflowState(f.config, 'native-run'))?.state.cycle?.snapshots.at(-1);
      expect(bytes(storedFirst)).toBeGreaterThan(16_384);
      expect(object(firstResult.snapshot).counts).toMatchObject({files: affectedPaths.length + 1});
      expect(bytes(firstResult.snapshot)).toBeLessThan(4_096);
      expect(decodeNativeTaskActionRef(firstSnapshotRef)).toMatchObject({
        snapshotId: firstSnapshot.snapshotId,
        sourceHead: firstSnapshot.head,
        sourceTree: firstSnapshot.tree,
      });
      const afterFirst = yield* f.fs.readFileString(f.statePath());
      const firstReplay = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-snapshot',
          runId: 'native-run',
          callerCwd: f.repo,
          workRef: String(work.workRef),
        }),
      );
      expect(firstReplay).toMatchObject({status: 'recorded', replayed: true, snapshotRef: firstSnapshotRef});
      expect(firstReplay.snapshot).toEqual(firstResult.snapshot);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(afterFirst);

      yield* f.fs.writeFileString(
        f.path.join(f.repo, 'source.ts'),
        'export const fixture = "corrected candidate two";\n',
      );
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'Correct admitted source before review']);
      const recoveryRequest = {
        command: 'supersede-unreviewed-snapshot',
        runId: 'native-run',
        callerCwd: f.repo,
        snapshotRef: firstSnapshotRef,
        reason: 'Corrected admitted files before any review was accepted; request a full independent review.',
      };
      const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
      registerWorkflowTaskTool(mcp, f.config);
      const recoveryResponse = object(
        yield* mcp.invokeTool('workflow_task_snapshot', {
          runId: 'native-run',
          callerCwd: f.repo,
          snapshot: {
            command: 'supersede-unreviewed',
            snapshotRef: firstSnapshotRef,
            reason: recoveryRequest.reason,
          },
        }),
      );
      expect(recoveryResponse.isError).not.toBe(true);
      const recovered = object(recoveryResponse.structuredContent);
      expect(recovered).toMatchObject({status: 'recorded', replayed: false});
      const secondSnapshot = object(object(recovered.snapshot).snapshot);
      const storedSecond = (yield* readNativeWorkflowState(f.config, 'native-run'))?.state.cycle?.snapshots.at(-1);
      expect(secondSnapshot).toMatchObject({
        snapshotId: expect.stringMatching(/^superseded-/u),
        supersedes: firstSnapshot.snapshotId,
        unreviewedSupersession: {reason: recoveryRequest.reason},
        phaseHash: String(firstSnapshot.phaseHash),
        baseTree: firstSnapshot.baseTree,
      });
      expect(secondSnapshot.tree).not.toBe(firstSnapshot.tree);
      expect(object(recovered.snapshot).counts).toMatchObject({files: affectedPaths.length + 1});
      expect(bytes(recoveryResponse)).toBeLessThan(8_192);
      expect(decodeNativeTaskActionRef(String(recovered.snapshotRef))).toMatchObject({
        snapshotId: secondSnapshot.snapshotId,
        sourceHead: secondSnapshot.head,
        sourceTree: secondSnapshot.tree,
      });
      const afterRecovery = yield* f.fs.readFileString(f.statePath());
      const replay = object(yield* runNativeTaskAction(f.config, recoveryRequest));
      expect(replay).toMatchObject({status: 'recorded', replayed: true});
      expect(replay.snapshot).toEqual(recovered.snapshot);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(afterRecovery);
      let cliReplay: Record<string, unknown> | undefined;
      const commands = makeNativeTaskActionCommands(
        () => Effect.void,
        () => Effect.void,
        () => Effect.void,
        () => Effect.void,
        () => Effect.void,
        () => Effect.void,
        () => Effect.void,
        () => Effect.void,
        () => Effect.void,
        options =>
          runNativeTaskAction(f.config, {command: 'supersede-unreviewed-snapshot', ...options}).pipe(
            Effect.tap(value => Effect.sync(() => (cliReplay = object(value)))),
            Effect.asVoid,
          ),
      );
      const cli = Command.make('workflow-automation').pipe(Command.withSubcommands([commands]));
      const runCli = Command.runWith(cli, {version: 'fixture'});
      yield* runCli([
        'task-action',
        'supersede-unreviewed-snapshot',
        '--run-id',
        'native-run',
        '--caller-cwd',
        f.repo,
        '--snapshot-ref',
        firstSnapshotRef,
        '--reason',
        recoveryRequest.reason,
      ]);
      expect(cliReplay).toMatchObject({status: 'recorded', replayed: true});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(afterRecovery);
      const changedIntent = yield* runNativeTaskAction(f.config, {
        ...recoveryRequest,
        reason: 'Change the reason after recovery.',
      }).pipe(Effect.result);
      expect(changedIntent).toMatchObject({failure: {code: 'stale-snapshot-ref'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(afterRecovery);

      const review = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-review',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef: String(recovered.snapshotRef),
          report: {
            mode: 'full',
            selected: ['correctness', 'simplicity'],
            lanes: [
              {name: 'correctness', status: 'complete'},
              {name: 'simplicity', status: 'complete'},
            ],
            findings: [],
          },
        }),
      );
      expect(review.status).toBe('recorded');
      const runtime = (yield* readNativeWorkflowState(f.config, 'native-run'))?.state.cycle;
      expect(runtime?.snapshots).toHaveLength(2);
      expect(runtime?.snapshots[0]?.snapshot).toEqual(storedFirst?.snapshot);
      expect(runtime?.snapshots[1]?.snapshot).toEqual(storedSecond?.snapshot);
      expect(EffectArray.map(runtime?.reviews ?? [], item => item.report.mode)).toEqual(['full']);
    }).pipe(run),
  );

  effectIt.effect('records the next iteration over an unreviewed snapshot that a reconcile made stale', () =>
    Effect.gen(function* () {
      const f = yield* fixture(['one'], 'local');
      yield* f.mutate('begin-phase', {phaseId: 'one'});
      const work = (workPacket = packet) =>
        Effect.map(
          runNativeTaskAction(f.config, {command: 'work', runId: 'native-run', callerCwd: f.repo, packet: workPacket}),
          result => String(object(result).workRef),
        );
      const firstWorkRef = yield* work();
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "before amendment";\n');
      yield* f.git(['commit', '-am', 'Source before the amendment']);
      const stale = object(
        object(
          object(
            yield* runNativeTaskAction(f.config, {
              command: 'record-snapshot',
              runId: 'native-run',
              callerCwd: f.repo,
              workRef: firstWorkRef,
            }),
          ).snapshot,
        ).snapshot,
      );
      const staleStored = (yield* readNativeWorkflowState(f.config, 'native-run'))?.state.cycle?.snapshots.at(
        -1,
      )?.snapshot;
      const plan = yield* f.revise({
        phases: EffectArray.map(f.document.phases, phase => ({...phase, outcome: 'Amended approved outcome.'})),
      });
      yield* f.mutate('reconcile', {plan, reason: 'The approved phase outcome changed before review.'});
      yield* f.mutate('resume-phase', {phaseId: 'one', reason: 'Implement the amended contract.'});
      const request = {
        command: 'record-snapshot',
        runId: 'native-run',
        callerCwd: f.repo,
        workRef: yield* work(),
        reason: 'The amended contract retires the unreviewed snapshot; review the same source in full.',
      } as const;
      const recorded = object(yield* runNativeTaskAction(f.config, request));
      const current = object(object(recorded.snapshot).snapshot);
      expect(current).toMatchObject({
        supersedes: stale.snapshotId,
        unreviewedSupersession: {reason: request.reason},
        tree: stale.tree,
      });
      expect(current.phaseHash).not.toBe(stale.phaseHash);
      const afterRecord = yield* f.fs.readFileString(f.statePath());
      expect(object(yield* runNativeTaskAction(f.config, request))).toMatchObject({replayed: true});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(afterRecord);
      const review = {
        selected: ['correctness', 'simplicity'],
        lanes: [
          {name: 'correctness', status: 'complete'},
          {name: 'simplicity', status: 'complete'},
        ],
        findings: [],
      };
      const record = (mode: string) =>
        runNativeTaskAction(f.config, {
          command: 'record-review',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef: String(recorded.snapshotRef),
          report: {...review, mode},
        });
      expect(object(yield* record('incremental'))).toMatchObject({status: 'invalid'});
      expect(object(yield* record('full'))).toMatchObject({status: 'recorded'});
      const runtime = (yield* readNativeWorkflowState(f.config, 'native-run'))?.state.cycle;
      expect(runtime?.snapshots[0]?.snapshot).toEqual(staleStored);
      expect(EffectArray.map(runtime?.reviews ?? [], item => item.snapshotId)).toEqual([current.snapshotId]);
    }).pipe(run),
  );

  effectIt.effect('recovers a rebased unreviewed snapshot that a reconcile made stale', () =>
    Effect.gen(function* () {
      const f = yield* fixture(['one'], 'local');
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "feature";\n');
      yield* f.git(['commit', '-am', 'Feature snapshot']);
      const head = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
      const stale = object(
        object(
          (yield* f.mutate('snapshot', {
            phaseId: 'one',
            snapshotId: 'before-rebase',
            acceptedHead: head,
            reason: 'Capture the feature before review.',
          })).snapshot,
        ).snapshot,
      );
      const snapshotRef = (yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo})).phase
        ?.snapshot?.snapshotRef;
      if (!snapshotRef) throw new Error('Expected the original review reference.');
      yield* f.git(['checkout', 'main']);
      yield* f.git(['commit', '--allow-empty', '-m', 'Advance the base']);
      yield* f.git(['checkout', 'feature/one']);
      yield* f.git(['rebase', 'main']);
      const plan = yield* f.revise({
        phases: EffectArray.map(f.document.phases, phase => ({...phase, outcome: 'Amended approved outcome.'})),
      });
      yield* f.mutate('reconcile', {plan, reason: 'The approved phase outcome changed after the rebase.'});
      yield* f.mutate('resume-phase', {phaseId: 'one', reason: 'Recover the rebased source under the amendment.'});
      const request = {
        command: 'recover-unreviewed-rebase-snapshot',
        runId: 'native-run',
        callerCwd: f.repo,
        snapshotRef,
        reason: 'Recover the rebased source under the amended contract.',
        userAuthority: 'Rebase this approved feature onto updated main.',
      } as const;
      const recovered = object(yield* runNativeTaskAction(f.config, request));
      const current = object(object(recovered.snapshot).snapshot);
      expect(current).toMatchObject({
        supersedes: stale.snapshotId,
        unreviewedSupersession: {reason: request.reason, rebaseRecovery: {authority: request.userAuthority}},
      });
      expect(current.phaseHash).not.toBe(stale.phaseHash);
      expect(object(yield* runNativeTaskAction(f.config, request))).toMatchObject({replayed: true});
      expect(
        object(
          yield* runNativeTaskAction(f.config, {
            command: 'record-review',
            runId: 'native-run',
            callerCwd: f.repo,
            snapshotRef: String(recovered.snapshotRef),
            report: {
              mode: 'full',
              selected: ['correctness', 'simplicity'],
              lanes: [
                {name: 'correctness', status: 'complete'},
                {name: 'simplicity', status: 'complete'},
              ],
              findings: [],
            },
          }),
        ),
      ).toMatchObject({status: 'recorded'});
    }).pipe(run),
  );

  effectIt.effect(
    'requalifies an exact reviewed predecessor on an approved divergent base through the consolidated snapshot action',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(
          ['one'],
          'local',
          false,
          false,
          true,
          {one: {branch: 'feature/one', baseBranch: 'prerelease'}},
          repo => runCommandEffect('git', ['-C', repo, 'branch', 'prerelease']),
        );
        yield* f.mutate('begin-phase', {phaseId: 'one'});
        const work = object(
          yield* runNativeTaskAction(f.config, {command: 'work', runId: 'native-run', callerCwd: f.repo, packet}),
        );
        yield* f.fs.writeFileString(
          f.path.join(f.repo, 'source.ts'),
          'export const feature = "reviewed predecessor";\n',
        );
        yield* f.git(['add', 'source.ts']);
        yield* f.git(['commit', '-m', 'Reviewed predecessor source']);
        const priorResult = object(
          yield* runNativeTaskAction(f.config, {
            command: 'record-snapshot',
            runId: 'native-run',
            callerCwd: f.repo,
            workRef: String(work.workRef),
          }),
        );
        const prior = object(object(priorResult.snapshot).snapshot);
        const priorStored = (yield* readNativeWorkflowState(f.config, 'native-run'))?.state.cycle?.snapshots.at(
          -1,
        )?.snapshot;
        const predecessorRef = String(priorResult.snapshotRef);
        const priorFinding = {
          id: 'F1011',
          file: 'source.ts',
          line: 1,
          body: 'Retain this reviewed finding across base requalification.',
          trigger: 'Inspect the rewritten branch.',
          impact: 'The original finding history must remain visible.',
          evidence: 'Observed in the private base-requalification fixture.',
          severity: 'minor',
          category: 'correctness',
          confidence: 97,
          state: 'new',
        };
        const priorReview = {
          mode: 'full',
          selected: ['correctness', 'simplicity'],
          lanes: [
            {name: 'correctness', status: 'complete'},
            {name: 'simplicity', status: 'complete'},
          ],
          findings: [priorFinding],
        };
        expect(
          object(
            yield* runNativeTaskAction(f.config, {
              command: 'record-review',
              runId: 'native-run',
              callerCwd: f.repo,
              snapshotRef: predecessorRef,
              report: priorReview,
            }),
          ).status,
        ).toBe('recorded');
        const reviewedState = yield* readNativeWorkflowState(f.config, 'native-run');
        if (!reviewedState?.state.cycle) throw new Error('Expected the reviewed predecessor runtime.');
        const reviewedRuntime = reviewedState.state.cycle;
        const historicalBaseline = reviewedRuntime.baselines.one;
        if (!historicalBaseline) throw new Error('Expected the retained original phase baseline.');
        const historicalReviews = [...reviewedRuntime.reviews];
        const historicalAttempts = [...reviewedRuntime.attempts];
        const reviewLimits = {...reviewedRuntime.reviewLimits};
        const featureHead = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);

        yield* f.git(['checkout', 'main']);
        yield* f.fs.writeFileString(f.path.join(f.repo, 'incoming.ts'), 'export const incoming = true;\n');
        yield* f.git(['add', 'incoming.ts']);
        yield* f.git(['commit', '-m', 'Divergent reviewed new base']);
        const ontoHead = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
        yield* f.git(['remote', 'add', 'origin', 'https://github.com/example/repo.git']);
        yield* f.git(['config', '--local', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
        yield* f.git(['update-ref', 'refs/remotes/origin/main', ontoHead]);
        yield* f.git(['checkout', '-b', 'feature/main']);
        yield* f.git(['cherry-pick', featureHead]);
        const rebasedHead = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
        expect(rebasedHead).not.toBe(featureHead);
        yield* f.git(['checkout', 'main']);
        yield* f.fs.writeFileString(f.path.join(f.repo, 'local-main-only.ts'), 'export const localMain = true;\n');
        yield* f.git(['add', 'local-main-only.ts']);
        yield* f.git(['commit', '-m', 'Advance the local base independently']);
        const localMainHead = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
        expect(localMainHead).not.toBe(ontoHead);
        yield* f.git(['checkout', 'feature/main']);

        const amendedPlan = yield* f.revise({}, {one: {branch: 'feature/main', baseBranch: 'origin/main'}});
        yield* f.mutate('reconcile', {
          plan: amendedPlan,
          reason: 'Test-only explicit approval to use main as the declared phase base.',
        });
        const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
        registerWorkflowTaskTool(mcp, f.config);
        for (const incompleteRequest of [{callerCwd: f.repo}, {runId: 'native-run'}]) {
          expect(yield* readNativeTaskView(f.config, incompleteRequest).pipe(Effect.result)).toMatchObject({
            failure: {code: 'invalid-request'},
          });
        }
        const taskViewResult = object(
          yield* mcp.invokeTool('workflow_task_view', {runId: 'native-run', callerCwd: f.repo}),
        );
        expect(taskViewResult.isError).not.toBe(true);
        const taskView = object(taskViewResult.structuredContent);
        const requalification = object(taskView.baseRequalification);
        expect(taskView.next).toMatchObject({action: 'blocked', phaseId: 'one'});
        expect(requalification).toMatchObject({
          action: 'requalify-base',
          phaseId: 'one',
          predecessorRef,
          fromBaseBranch: 'prerelease',
          toBaseBranch: 'origin/main',
        });
        const stateBeforeReviewOmission = yield* f.fs.readFileString(f.statePath());
        const currentStored = yield* readNativeWorkflowState(f.config, 'native-run');
        if (!currentStored?.state.cycle) throw new Error('Expected the stale reviewed-base runtime.');
        const noReviewState = serializeNativeWorkflowState({
          ...currentStored.state,
          cycle: {...currentStored.state.cycle, reviews: [], attempts: []},
        });
        yield* Effect.acquireUseRelease(
          f.fs.writeFileString(f.statePath(), noReviewState),
          () =>
            Effect.gen(function* () {
              const noReviewViewResult = object(
                yield* mcp.invokeTool('workflow_task_view', {runId: 'native-run', callerCwd: f.repo}),
              );
              expect(noReviewViewResult.isError).not.toBe(true);
              const noReviewView = object(noReviewViewResult.structuredContent);
              expect(noReviewView.next).toMatchObject({action: 'blocked', phaseId: 'one'});
              expect(noReviewView.baseRequalification).toBeUndefined();
            }),
          () => f.fs.writeFileString(f.statePath(), stateBeforeReviewOmission),
        );

        const request = {
          command: 'requalify-base-snapshot',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef: predecessorRef,
          reason: 'Requalify the reviewed source after the approved base transition.',
          userAuthority: 'Test-only explicit human approval for this fixture base transition.',
        };
        const refuseWithoutMutation = (input: typeof request, code: string) =>
          Effect.gen(function* () {
            const before = yield* f.fs.readFileString(f.statePath());
            const refusal = yield* runNativeTaskAction(f.config, input).pipe(Effect.result);
            expect(refusal).toMatchObject({failure: {code}});
            expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
          });
        const decoded = decodeNativeTaskActionRef(predecessorRef);
        if (!decoded) throw new Error('The task view predecessor reference must be decodable.');
        yield* refuseWithoutMutation(
          {...request, snapshotRef: encodeNativeTaskActionRef({...decoded, phaseId: 'two'})},
          'stale-snapshot-ref',
        );
        yield* refuseWithoutMutation(
          {
            ...request,
            snapshotRef: encodeNativeTaskActionRef({
              ...decoded,
              sourceHead: EffectString.repeat(decoded.sourceHead!.length)('f'),
            }),
          },
          'stale-snapshot-ref',
        );
        yield* refuseWithoutMutation(
          {
            ...request,
            snapshotRef: encodeNativeTaskActionRef({...decoded, generationHash: sha256HexSync('foreign-generation')}),
          },
          'invalid-snapshot-ref',
        );
        yield* refuseWithoutMutation({...request, runId: 'foreign-run'}, 'run-not-found');

        yield* f.git(['update-ref', 'refs/heads/prerelease', ontoHead]);
        const movedHistoricalLabel = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
        expect(movedHistoricalLabel.baseRequalification?.predecessorRef).toBe(predecessorRef);
        yield* f.git(['update-ref', 'refs/remotes/origin/main', String(prior.declaredBaseHead)]);
        yield* refuseWithoutMutation(request, 'stale-snapshot-ref');
        yield* f.git(['update-ref', 'refs/remotes/origin/main', ontoHead]);
        yield* f.git(['checkout', 'feature/one']);
        yield* refuseWithoutMutation(request, 'stale-snapshot-ref');
        yield* f.git(['checkout', 'feature/main']);
        expect(EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout)).toBe(rebasedHead);

        const beforeRequalification = yield* f.fs.readFileString(f.statePath());
        const appliedResponse = object(
          yield* mcp.invokeTool('workflow_task_snapshot', {
            runId: 'native-run',
            callerCwd: f.repo,
            snapshot: {
              command: 'requalify-base',
              snapshotRef: predecessorRef,
              reason: request.reason,
              userAuthority: request.userAuthority,
            },
          }),
        );
        expect(appliedResponse.isError).not.toBe(true);
        const applied = object(appliedResponse.structuredContent);
        expect(applied).toMatchObject({status: 'recorded', replayed: false});
        const requalified = object(object(applied.snapshot).snapshot);
        const remoteBaseTree = EffectString.trim((yield* f.git(['rev-parse', 'origin/main^{tree}'])).stdout);
        expect(requalified.declaredBaseHead).toBe(ontoHead);
        expect(requalified.declaredBaseHead).not.toBe(localMainHead);
        expect(requalified.scopeBase).toBe(remoteBaseTree);
        expect(requalified).toMatchObject({
          snapshotId: expect.stringMatching(/^base-requalified-/u),
          previous: prior.snapshotId,
          phaseHash: prior.phaseHash,
          baseTree: historicalBaseline.tree,
          acceptedHead: rebasedHead,
          baseRequalification: {
            preRebaseHead: featureHead,
            ontoHead,
            rebasedHead,
            fromBaseBranch: 'prerelease',
            toBaseBranch: 'origin/main',
            priorDeclaredBaseHead: prior.declaredBaseHead,
            reason: request.reason,
            authority: request.userAuthority,
          },
        });
        const requalifiedRef = String(applied.snapshotRef);
        const afterRequalification = yield* f.fs.readFileString(f.statePath());
        const exactReplay = object(
          yield* mcp.invokeTool('workflow_task_snapshot', {
            runId: 'native-run',
            callerCwd: f.repo,
            snapshot: {
              command: 'requalify-base',
              snapshotRef: predecessorRef,
              reason: request.reason,
              userAuthority: request.userAuthority,
            },
          }),
        );
        expect(exactReplay.structuredContent).toMatchObject({
          status: 'recorded',
          replayed: true,
          snapshot: applied.snapshot,
          snapshotRef: requalifiedRef,
        });
        expect(yield* f.fs.readFileString(f.statePath())).toBe(afterRequalification);
        expect(afterRequalification).not.toBe(beforeRequalification);

        let cliReplay: Record<string, unknown> | undefined;
        const actionCommands = makeNativeTaskActionCommands(
          () => Effect.void,
          () => Effect.void,
          () => Effect.void,
          () => Effect.void,
          () => Effect.void,
          () => Effect.void,
          () => Effect.void,
          () => Effect.void,
          () => Effect.void,
          () => Effect.void,
          () => Effect.void,
          options =>
            runNativeTaskAction(f.config, {command: 'requalify-base-snapshot', ...options}).pipe(
              Effect.tap(value => Effect.sync(() => (cliReplay = object(value)))),
              Effect.asVoid,
            ),
        );
        const cli = Command.make('workflow-automation').pipe(Command.withSubcommands([actionCommands]));
        yield* Command.runWith(cli, {version: 'fixture'})([
          'task-action',
          'requalify-base-snapshot',
          '--run-id',
          'native-run',
          '--caller-cwd',
          f.repo,
          '--snapshot-ref',
          predecessorRef,
          '--reason',
          request.reason,
          '--user-authority',
          request.userAuthority,
        ]);
        expect(cliReplay).toMatchObject({status: 'recorded', replayed: true, snapshotRef: requalifiedRef});
        expect(yield* f.fs.readFileString(f.statePath())).toBe(afterRequalification);

        const currentView = object(
          (yield* mcp.invokeTool('workflow_task_view', {runId: 'native-run', callerCwd: f.repo})).structuredContent,
        );
        expect(currentView.next).toMatchObject({action: 'review', phaseId: 'one', snapshotId: requalified.snapshotId});
        expect(currentView.baseRequalification).toBeUndefined();
        const beforeReviewState = yield* readNativeWorkflowState(f.config, 'native-run');
        if (!beforeReviewState?.state.cycle) throw new Error('Expected the requalified cycle state.');
        expect(beforeReviewState.state.cycle.baselines).toEqual(reviewedRuntime.baselines);
        expect(beforeReviewState.state.cycle.reviewLimits).toEqual(reviewLimits);
        expect(beforeReviewState.state.cycle.reviews[0]).toEqual(historicalReviews[0]);
        expect(beforeReviewState.state.cycle.attempts.slice(0, historicalAttempts.length)).toEqual(historicalAttempts);
        expect(beforeReviewState.state.cycle.snapshots[0]?.snapshot).toEqual(priorStored);
        const requalifiedFullReport = {
          ...priorReview,
          findings: [{...priorFinding, state: 'carried', reason: 'Retained and rechecked after base requalification.'}],
        };
        const incrementalRefusal = object(
          yield* runNativeTaskAction(f.config, {
            command: 'record-review',
            runId: 'native-run',
            callerCwd: f.repo,
            snapshotRef: requalifiedRef,
            report: {...requalifiedFullReport, mode: 'incremental'},
          }),
        );
        expect(incrementalRefusal.status).toBe('invalid');
        const afterInvalidReview = yield* readNativeWorkflowState(f.config, 'native-run');
        expect(afterInvalidReview?.state.cycle?.reviews).toHaveLength(historicalReviews.length);
        expect(afterInvalidReview?.state.cycle?.reviewLimits).toEqual(reviewLimits);
        const fullReview = object(
          yield* runNativeTaskAction(f.config, {
            command: 'record-review',
            runId: 'native-run',
            callerCwd: f.repo,
            snapshotRef: requalifiedRef,
            report: requalifiedFullReport,
          }),
        );
        expect(fullReview.status).toBe('recorded');
        const reviewedRequalification = yield* readNativeWorkflowState(f.config, 'native-run');
        expect(reviewedRequalification?.state.cycle?.reviews.at(-1)?.report).toMatchObject({
          mode: 'full',
          findings: [{id: priorFinding.id, state: 'carried'}],
        });
        expect(reviewedRequalification?.state.cycle?.reviewLimits).toEqual(reviewLimits);

        const requalifiedPacket = {...packet, anchors: [{path: 'source.ts', pattern: 'export const feature'}]};
        const followupWork = object(
          yield* runNativeTaskAction(f.config, {
            command: 'work',
            runId: 'native-run',
            callerCwd: f.repo,
            packet: requalifiedPacket,
          }),
        );
        yield* f.fs.writeFileString(
          f.path.join(f.repo, 'source.ts'),
          'export const feature = "reviewed predecessor";\nexport const followup = true;\n',
        );
        yield* f.git(['add', 'source.ts']);
        yield* f.git(['commit', '-m', 'Incremental requalified source change']);
        const followupSnapshot = object(
          yield* runNativeTaskAction(f.config, {
            command: 'record-snapshot',
            runId: 'native-run',
            callerCwd: f.repo,
            workRef: String(followupWork.workRef),
            reason: 'Record the next source change after the full requalification review.',
          }),
        );
        const followup = object(object(followupSnapshot.snapshot).snapshot);
        expect(followup).toMatchObject({previous: requalified.snapshotId});
        expect(followup.baseRequalification).toBeUndefined();
        const incremental = object(
          yield* f.call({
            ...f.base('cycle'),
            command: 'detail',
            snapshotId: followup.snapshotId,
            detailKind: 'patch',
          }),
        );
        const incrementalPatch = String(object(incremental.page).text);
        expect(incrementalPatch).toContain('+export const followup = true;');
        expect(incrementalPatch).not.toContain('+export const feature = "reviewed predecessor";');
        const final = yield* readNativeWorkflowState(f.config, 'native-run');
        expect(EffectArray.map(final?.state.cycle?.snapshots ?? [], item => item.snapshot.snapshotId)).toEqual([
          prior.snapshotId,
          requalified.snapshotId,
          followup.snapshotId,
        ]);
        expect(final?.state.cycle?.reviews[0]).toEqual(historicalReviews[0]);
        expect(final?.state.cycle?.reviewLimits).toEqual(reviewLimits);
        expect(final?.state.cycle?.reviewExpansions).toEqual(reviewedRuntime.reviewExpansions);
      }).pipe(run),
  );

  effectIt.effect.prop(
    'refuses generated foreign-generation reviewed-base references without changing canonical state',
    {
      suffixes: Schema.Array(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,12}$/u))).check(
        Schema.isBetweenLength(1, 4),
      ),
    },
    ({suffixes}) =>
      Effect.gen(function* () {
        const f = yield* fixture(['one'], 'local');
        yield* f.mutate('begin-phase', {phaseId: 'one'});
        const work = object(
          yield* runNativeTaskAction(f.config, {command: 'work', runId: 'native-run', callerCwd: f.repo, packet}),
        );
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const reviewed = true;\n');
        yield* f.git(['add', 'source.ts']);
        yield* f.git(['commit', '-m', 'Reviewed-base reference fixture']);
        const recorded = object(
          yield* runNativeTaskAction(f.config, {
            command: 'record-snapshot',
            runId: 'native-run',
            callerCwd: f.repo,
            workRef: String(work.workRef),
          }),
        );
        const snapshotRef = String(recorded.snapshotRef);
        const snapshot = decodeNativeTaskActionRef(snapshotRef);
        if (!snapshot) throw new Error('The reviewed predecessor ref must decode.');
        yield* runNativeTaskAction(f.config, {
          command: 'record-review',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef,
          report: {
            mode: 'full',
            selected: ['correctness', 'simplicity'],
            lanes: [
              {name: 'correctness', status: 'complete'},
              {name: 'simplicity', status: 'complete'},
            ],
            findings: [],
          },
        });
        const before = yield* f.fs.readFileString(f.statePath());
        for (const suffix of new Set(suffixes)) {
          const generationHash = sha256HexSync(`foreign-generation:${suffix}`);
          if (generationHash === snapshot.generationHash) continue;
          const refusal = yield* runNativeTaskAction(f.config, {
            command: 'requalify-base-snapshot',
            runId: 'native-run',
            callerCwd: f.repo,
            snapshotRef: encodeNativeTaskActionRef({...snapshot, generationHash}),
            reason: 'A bounded generated wrong-generation reference must not requalify source.',
            userAuthority: 'Test-only generated invalid reference; no authority is asserted.',
          }).pipe(Effect.result);
          expect(refusal).toMatchObject({failure: {code: 'invalid-snapshot-ref'}});
          expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
        }
      }).pipe(run),
    {arbitrary: {runs: 4}},
  );

  effectIt.effect('refuses task-action supersession of a reviewed snapshot without mutating state', () =>
    Effect.gen(function* () {
      const f = yield* fixture(['one'], 'local');
      yield* f.mutate('begin-phase', {phaseId: 'one'});
      const work = object(
        yield* runNativeTaskAction(f.config, {
          command: 'work',
          runId: 'native-run',
          callerCwd: f.repo,
          packet,
        }),
      );
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "reviewed candidate";\n');
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'Reviewed candidate']);
      const recorded = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-snapshot',
          runId: 'native-run',
          callerCwd: f.repo,
          workRef: String(work.workRef),
        }),
      );
      yield* runNativeTaskAction(f.config, {
        command: 'record-review',
        runId: 'native-run',
        callerCwd: f.repo,
        snapshotRef: String(recorded.snapshotRef),
        report: {
          mode: 'full',
          selected: ['correctness', 'simplicity'],
          lanes: [
            {name: 'correctness', status: 'complete'},
            {name: 'simplicity', status: 'complete'},
          ],
          findings: [],
        },
      });
      yield* f.fs.writeFileString(
        f.path.join(f.repo, 'source.ts'),
        'export const fixture = "after accepted review";\n',
      );
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'Change after accepted review']);
      const before = yield* f.fs.readFileString(f.statePath());
      const refused = yield* runNativeTaskAction(f.config, {
        command: 'supersede-unreviewed-snapshot',
        runId: 'native-run',
        callerCwd: f.repo,
        snapshotRef: String(recorded.snapshotRef),
        reason: 'The predecessor already has an accepted review.',
      }).pipe(Effect.result);
      expect(refused).toMatchObject({failure: {code: 'review-history'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
    }).pipe(run),
  );

  effectIt.effect('recovers the current one-phase PR review card from its opaque snapshot reference', () =>
    Effect.gen(function* () {
      const f = yield* fixture(['P1'], 'pr');
      yield* f.mutate('begin-phase', {phaseId: 'P1'});
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "P1 first source";\n');
      const firstResult = yield* f.mutate('snapshot', {
        phaseId: 'P1',
        snapshotId: 'p1-unreviewed',
      });
      const firstSnapshot = object(object(firstResult.snapshot).snapshot);
      const stored = yield* readNativeWorkflowState(f.config, 'native-run');
      if (!stored?.state.cycle) throw new Error('Expected current cycle state.');
      const baseline = stored.state.cycle.baselines.P1;
      if (!baseline) throw new Error('Expected the P1 baseline.');
      const snapshotRef = encodeNativeTaskActionRef({
        version: 1,
        kind: 'snapshot',
        runId: 'native-run',
        generationHash: sha256HexSync(stored.state.generation),
        phaseId: 'P1',
        phaseHash: String(firstSnapshot.phaseHash),
        baselineHead: baseline.head,
        baselineTree: baseline.tree,
        baselineRef: baseline.pinnedRef,
        sourceHead: String(firstSnapshot.head),
        sourceTree: String(firstSnapshot.tree),
        snapshotId: String(firstSnapshot.snapshotId),
      });
      const currentCard = object(
        yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo, role: 'review'}),
      );
      expect(currentCard).toMatchObject({
        status: 'ready',
        next: {action: 'review', phaseId: 'P1', snapshotId: 'p1-unreviewed'},
      });

      const beforeForeign = yield* f.fs.readFileString(f.statePath());
      const staleRef = encodeNativeTaskActionRef({
        version: 1,
        kind: 'snapshot',
        runId: 'native-run',
        generationHash: sha256HexSync(stored.state.generation),
        phaseId: 'P1',
        phaseHash: String(firstSnapshot.phaseHash),
        baselineHead: baseline.head,
        baselineTree: baseline.tree,
        baselineRef: baseline.pinnedRef,
        sourceHead: String(firstSnapshot.head),
        sourceTree: '0000000000000000000000000000000000000000',
        snapshotId: String(firstSnapshot.snapshotId),
      });
      const foreign = yield* runNativeTaskAction(f.config, {
        command: 'supersede-unreviewed-snapshot',
        runId: 'native-run',
        callerCwd: f.repo,
        snapshotRef: staleRef,
        reason: 'Try to recover from a stale source reference.',
      }).pipe(Effect.result);
      expect(foreign).toMatchObject({failure: {code: 'stale-snapshot-ref'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeForeign);

      const changedSource = 'export const fixture = "P1 corrected source";\n';
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), changedSource);
      const reason = 'Corrected admitted P1 files before any review was accepted.';
      const recovered = object(
        yield* runNativeTaskAction(f.config, {
          command: 'supersede-unreviewed-snapshot',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef,
          reason,
        }),
      );
      expect(recovered).toMatchObject({status: 'recorded', replayed: false});
      const candidate = object(object(recovered.snapshot).snapshot);
      expect(candidate).toMatchObject({
        supersedes: firstSnapshot.snapshotId,
        unreviewedSupersession: {reason},
        phaseId: 'P1',
        phaseHash: String(firstSnapshot.phaseHash),
        baseTree: firstSnapshot.baseTree,
      });
      expect(candidate.tree).not.toBe(firstSnapshot.tree);
      const afterRecovery = yield* f.fs.readFileString(f.statePath());
      const replay = object(
        yield* runNativeTaskAction(f.config, {
          command: 'supersede-unreviewed-snapshot',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef,
          reason,
        }),
      );
      expect(replay).toMatchObject({status: 'recorded', replayed: true});
      expect(replay.snapshot).toEqual(recovered.snapshot);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(afterRecovery);
      const changedIntent = yield* runNativeTaskAction(f.config, {
        command: 'supersede-unreviewed-snapshot',
        runId: 'native-run',
        callerCwd: f.repo,
        snapshotRef,
        reason: 'Changed the business reason after recovery.',
      }).pipe(Effect.result);
      expect(changedIntent).toMatchObject({failure: {code: 'stale-snapshot-ref'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(afterRecovery);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "P1 drifted again";\n');
      const changedSourceReplay = yield* runNativeTaskAction(f.config, {
        command: 'supersede-unreviewed-snapshot',
        runId: 'native-run',
        callerCwd: f.repo,
        snapshotRef,
        reason,
      }).pipe(Effect.result);
      expect(changedSourceReplay).toMatchObject({failure: {code: 'source-drift'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(afterRecovery);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), changedSource);

      const report = {
        snapshotId: candidate.snapshotId,
        phaseHash: candidate.phaseHash,
        snapshotTree: candidate.tree,
        status: 'complete',
        selected: ['correctness', 'simplicity'],
        lanes: [
          {name: 'correctness', status: 'complete'},
          {name: 'simplicity', status: 'complete'},
        ],
        findings: [],
      };
      const incremental = yield* f.mutate('validate-review', {
        snapshotId: candidate.snapshotId,
        attemptId: 'p1-incremental-refused',
        report: {...report, mode: 'incremental'},
      });
      expect(incremental).toMatchObject({status: 'error', code: 'invalid-cycle-review'});
      const full = yield* f.mutate('validate-review', {
        snapshotId: candidate.snapshotId,
        attemptId: 'p1-full-review',
        report: {...report, mode: 'full'},
      });
      expect(full).toMatchObject({status: 'ok'});
      const runtime = decodeNativeCycleRuntime(object(JSON.parse(yield* f.fs.readFileString(f.statePath()))).cycle);
      expect(EffectArray.map(runtime.snapshots, entry => entry.snapshot.snapshotId)).toEqual([
        firstSnapshot.snapshotId,
        candidate.snapshotId,
      ]);
      expect(EffectArray.map(runtime.reviews, entry => entry.snapshotId)).toEqual([candidate.snapshotId]);
      expect(EffectArray.map(runtime.attempts, entry => entry.id)).toEqual([
        'p1-incremental-refused',
        'p1-full-review',
      ]);
      expect(EffectArray.map(runtime.attempts, entry => entry.status)).toEqual(['invalid', 'accepted']);
    }).pipe(run),
  );

  effectIt.effect('reconciles an amended compact-origin PR cycle without changing delivery or bindings', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const repo = yield* f.fs.realPath(f.repo);
      const home = yield* f.fs.realPath(f.home);
      const config = {...f.config, agentContextHome: home, manifestPath: f.path.join(home, 'manifest.json')};
      const system = yield* SystemInfo;
      const testSystem = {...system, currentDirectory: () => repo, homeDirectory: home};
      yield* f.fs.writeFileString(f.path.join(repo, 'unlisted.ts'), 'export const unlisted = true;\n');
      yield* runCommandEffect('git', ['-C', repo, 'add', 'source.ts', 'unlisted.ts']);
      yield* runCommandEffect('git', [
        '-C',
        repo,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-m',
        'Fixture source',
      ]);
      yield* applyDevSkills(config, 'install', {agent: 'codex'}).pipe(Effect.provideService(SystemInfo, testSystem));
      const intent = {
        title: 'Refresh compact fixture data',
        currentBehavior: 'Expired fixture values are returned without a freshness check.',
        desiredChange: 'Expired fixture values are refreshed before return.',
        affectedPaths: ['source.ts'],
        acceptanceCriterion: 'Expired fixture values refresh before return.',
        verification: 'Exercise expiration and observe the refreshed value.',
        eligibilityRationale: 'One local source and one bounded behavior are explicit.',
        eligibility: {status: 'eligible' as const},
        review: {required: false, reason: 'The fixture behavior is bounded.'},
      };
      const startInput = {callerCwd: repo, featureName: intent.title, installationTarget: 'codex', intent};
      expect(
        yield* runNativeTaskStart(config, startInput).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.result,
        ),
      ).toMatchObject({
        failure: {code: 'evidence-unavailable'},
      });
      const mixedShape = yield* runNativeTaskStart(config, {
        ...startInput,
        delivery: 'pr',
        bindings: {compact: {branch: 'main', baseBranch: 'main'}},
      }).pipe(Effect.provideService(SystemInfo, testSystem), Effect.result);
      if (mixedShape._tag !== 'Failure') throw new Error('A compact start must refuse shared-plan fields.');
      expect(mixedShape.failure).toMatchObject({code: 'invalid-request'});
      expect(mixedShape.failure.message).toContain('delivery');
      expect(mixedShape.failure.message).toContain('bindings');
      // A standard run needs no published graph: it starts in a fresh checkout and stores its artifacts uncited.
      const standardStart = object(
        yield* runNativeTaskStart(config, {
          ...startInput,
          featureName: 'Standard ' + intent.title,
          workflowProfile: 'standard',
        }).pipe(Effect.provideService(SystemInfo, testSystem)),
      );
      expect(standardStart.status).toBe('awaiting-user-confirmation');
      const standardRunId = String(standardStart.taskRef);
      // Compact confirmation chooses the first admission's delivery.
      expect(
        yield* runNativeTaskAction(config, {
          command: 'compact-confirm',
          runId: standardRunId,
          callerCwd: repo,
          presentedIntentHash: String(standardStart.intentHash),
          userDecision: 'approve',
          userResponse: 'I approve this exact fixture change delivered as a PR.',
          baseBranch: 'main',
          delivery: 'pr',
        }).pipe(Effect.provideService(SystemInfo, testSystem)),
      ).toMatchObject({status: 'admitted'});
      expect((yield* readNativeWorkflowState(config, standardRunId))?.state.cycle?.state.plan.delivery).toBe('pr');
      // The approved delivery stays with the run: another mode refuses early, and a replay keeps the approved mode.
      const confirmStandard = (fields: object) =>
        runNativeTaskAction(config, {
          command: 'compact-confirm',
          runId: standardRunId,
          callerCwd: repo,
          presentedIntentHash: String(standardStart.intentHash),
          ...fields,
        }).pipe(Effect.provideService(SystemInfo, testSystem));
      expect(yield* confirmStandard({delivery: 'local'}).pipe(Effect.result)).toMatchObject({
        failure: {code: 'delivery-conflict'},
      });
      expect(yield* confirmStandard({})).toMatchObject({status: 'admitted'});
      expect((yield* readNativeWorkflowState(config, standardRunId))?.state.cycle?.state.plan.delivery).toBe('pr');
      // Before admission, a replay that names another delivery needs the user's new response.
      const reviewedStart = object(
        yield* runNativeTaskStart(config, {
          ...startInput,
          featureName: 'Reviewed ' + intent.title,
          workflowProfile: 'standard',
          intent: {...intent, review: {required: true, reason: 'The fixture change needs one plan review.'}},
        }).pipe(Effect.provideService(SystemInfo, testSystem)),
      );
      const confirmReviewed = (fields: object) =>
        runNativeTaskAction(config, {
          command: 'compact-confirm',
          runId: String(reviewedStart.taskRef),
          callerCwd: repo,
          presentedIntentHash: String(reviewedStart.intentHash),
          baseBranch: 'main',
          ...fields,
        }).pipe(Effect.provideService(SystemInfo, testSystem));
      expect(
        yield* confirmReviewed({
          userDecision: 'approve',
          userResponse: 'I approve this exact fixture change delivered as a PR.',
          delivery: 'pr',
        }),
      ).toMatchObject({status: 'awaiting-review'});
      expect(yield* confirmReviewed({delivery: 'local'}).pipe(Effect.result)).toMatchObject({
        failure: {code: 'delivery-not-confirmed'},
      });
      expect(yield* confirmReviewed({delivery: 'pr'})).toMatchObject({status: 'awaiting-review'});
      expect((yield* readNativeWorkflowState(config, String(reviewedStart.taskRef)))?.state.cycle).toBeUndefined();
      expect(
        (yield* (yield* CodeGraphIndexer).index({cwd: repo, threadnoteHome: home, ensureVectors: false})).snapshot
          .state,
      ).toBe('ready');
      const started = object(
        yield* runNativeTaskStart(config, startInput).pipe(Effect.provideService(SystemInfo, testSystem)),
      );
      const runId = String(started.taskRef);
      const initialState = yield* readNativeWorkflowState(config, runId);
      if (!initialState) throw new Error('The compact start must initialize a canonical run.');
      const compactRead = object(
        object(
          yield* f.call(
            {
              ...f.base('authoring', runId, initialState.state.generation),
              command: 'load',
              uri: object(started.root).uri,
              detail: 'document',
            },
            config,
          ),
        ).authoring,
      );
      const compactDocument = yield* Schema.decodeUnknownEffect(NativeAuthoringPlanDocumentSchema)(
        compactRead.document,
      );
      const compactPhase = compactDocument.phases[0];
      const compactAcceptance = compactPhase?.acceptance[0];
      if (!compactPhase || !compactAcceptance)
        throw new Error('The compact plan needs one phase and acceptance criterion.');
      const expansion = {
        ...compactDocument,
        current: {
          ...compactDocument.current,
          components: ['source.ts contains the fixture value consumed by callers.'],
        },
        target: {...compactDocument.target, components: ['Refresh the fixture value before returning it.']},
        phases: [
          compactPhase,
          {
            ...compactPhase,
            id: 'verify',
            title: 'Verify refreshed fixture data',
            outcome: 'The refreshed fixture value remains available after reload.',
            dependsOn: [String(compactPhase.id)],
            acceptance: [
              {
                ...compactAcceptance,
                id: 'persisted',
                criterion: 'The refreshed value persists.',
                verification: 'Reload and observe the refreshed value.',
              },
            ],
          },
        ],
        decisions: [
          {
            id: 'verify-refresh',
            question: 'How is persistence verified?',
            selection: 'no-better-alternative',
            selected: 'Reload the fixture after refresh.',
            alternatives: [],
            rationale: 'A dependent phase verifies persistence.',
            affectedPhases: [String(compactPhase.id), 'verify'],
            authority: 'orchestrator',
          },
        ],
      };
      const outsideRefIndex = expansion.context.codeRefs.length;
      const rejectedExpansion = yield* runNativeTaskAction(config, {
        command: 'compact-expand',
        runId,
        callerCwd: repo,
        document: {
          ...expansion,
          context: {...expansion.context, codeRefs: [...expansion.context.codeRefs, 'unlisted.ts']},
        },
      }).pipe(Effect.result);
      expect(rejectedExpansion).toMatchObject({
        failure: {
          code: 'invalid-document',
          detail: {
            issues: expect.arrayContaining([
              expect.objectContaining({
                code: 'code-ref-out-of-snapshot',
                path: `context.codeRefs[${outsideRefIndex}]`,
              }),
            ]),
          },
        },
      });
      // The runtime fills format, identity, source hashes and compact origin from the run and checkout.
      const {
        format: _format,
        schemaVersion: _schemaVersion,
        id: _id,
        project: _project,
        source: _source,
        kind: _kind,
        compactOrigin: _compactOrigin,
        ...expansionBusiness
      } = expansion;
      const firstExpansion = object(
        yield* runNativeTaskAction(config, {
          command: 'compact-expand',
          runId,
          callerCwd: repo,
          document: expansionBusiness,
        }),
      );
      expect(firstExpansion.status).toBe('awaiting-user-confirmation');
      const expandedRead = object(
        object(
          yield* f.call(
            {
              ...f.base('authoring', runId, initialState.state.generation),
              command: 'load',
              uri: object(firstExpansion.root).uri,
              detail: 'document',
            },
            config,
          ),
        ).authoring,
      );
      const expandedDocument = yield* Schema.decodeUnknownEffect(NativeAuthoringPlanDocumentSchema)(
        expandedRead.document,
      );
      expect(expandedDocument.compactOrigin?.expanded).toBe(true);
      const contentFile = f.path.join(home, 'compact-business.json');
      const business = {
        title: expandedDocument.title,
        objective: expandedDocument.objective,
        requirements: expandedDocument.requirements,
        context: expandedDocument.context,
        current: expandedDocument.current,
        target: expandedDocument.target,
        phases: expandedDocument.phases,
        decisions: expandedDocument.decisions,
        openQuestions: expandedDocument.openQuestions,
        review: expandedDocument.review,
      };
      yield* f.fs.writeFileString(contentFile, JSON.stringify(business));
      const authored = object(
        yield* runNativeTaskAuthoring(config, {
          command: 'start',
          callerCwd: repo,
          featureName: intent.title,
          kind: 'plan',
          contentFile,
          installationTarget: 'codex',
        }).pipe(Effect.provideService(SystemInfo, testSystem)),
      );
      expect(authored).toMatchObject({status: 'draft', replayed: true});
      const approved = object(
        yield* runNativeTaskAuthoring(config, {
          command: 'decide',
          callerCwd: repo,
          authoringRef: String(authored.authoringRef),
          userDecision: 'approve',
          userResponse: 'I approve this exact expanded fixture plan.',
        }).pipe(Effect.provideService(SystemInfo, testSystem)),
      );
      const admitted = object(
        yield* runNativeTaskAuthoring(config, {
          command: 'admit',
          callerCwd: repo,
          authoringRef: String(approved.authoringRef),
          delivery: 'pr',
          bindings: {
            compact: {branch: 'main', baseBranch: 'main'},
            verify: {branch: 'main', baseBranch: 'main'},
          },
        }).pipe(Effect.provideService(SystemInfo, testSystem)),
      );
      expect(admitted.status).toBe('admitted');
      const initialCycle = yield* readNativeWorkflowState(config, runId);
      expect(initialCycle?.state.cycle?.state.plan).toMatchObject({
        delivery: 'pr',
        phases: [
          {id: 'compact', branch: 'main', baseBranch: 'main'},
          {id: 'verify', branch: 'main', baseBranch: 'main'},
        ],
      });

      const verifyPhase = expandedDocument.phases[1];
      const verifyAcceptance = verifyPhase?.acceptance[0];
      if (!verifyPhase || !verifyAcceptance) throw new Error('The expanded plan must include its verification phase.');
      const amendment = {
        ...expandedDocument,
        title: 'Refresh and verify compact fixture data',
        objective: 'Refresh fixture data and verify the persisted result.',
        target: {...expandedDocument.target, summary: 'Expired fixture values refresh and persist before return.'},
        phases: [
          ...expandedDocument.phases,
          {
            ...verifyPhase,
            id: 'readback',
            title: 'Read back refreshed fixture data',
            outcome: 'The refreshed fixture value is available to later reads.',
            dependsOn: [String(verifyPhase.id)],
            acceptance: [
              {
                ...verifyAcceptance,
                id: 'readback',
                criterion: 'Later reads return the refreshed value.',
                verification: 'Read the fixture value after reload.',
              },
            ],
          },
        ],
        decisions: [
          ...expandedDocument.decisions,
          {
            id: 'readback-refresh',
            question: 'How are later reads checked?',
            selection: 'no-better-alternative',
            selected: 'Read the value after reload.',
            alternatives: [],
            rationale: 'The final phase verifies the persisted result.',
            affectedPhases: ['compact', 'verify', 'readback'],
            authority: 'orchestrator',
          },
        ],
      };
      const expanded = object(
        yield* runNativeTaskAction(config, {
          command: 'compact-expand',
          runId,
          callerCwd: repo,
          document: amendment,
        }),
      );
      expect(expanded.status).toBe('awaiting-user-confirmation');
      const confirmed = object(
        yield* runNativeTaskAction(config, {
          command: 'compact-confirm',
          runId,
          callerCwd: repo,
          presentedIntentHash: String(expanded.intentHash),
          userDecision: 'approve',
          userResponse: 'I approve this exact amended fixture plan.',
          bindings: {
            compact: {branch: 'main', baseBranch: 'main'},
            verify: {branch: 'main', baseBranch: 'main'},
            readback: {branch: 'main', baseBranch: 'main'},
          },
        }),
      );
      expect(confirmed.status).toBe('admitted');
      const after = yield* readNativeWorkflowState(config, runId);
      expect(after?.state.cycle?.state.plan).toMatchObject({
        delivery: 'pr',
        phases: [
          {id: 'compact', branch: 'main', baseBranch: 'main'},
          {id: 'verify', branch: 'main', baseBranch: 'main'},
          {id: 'readback', branch: 'main', baseBranch: 'main'},
        ],
      });
      expect(after?.state.cycle?.plans).toHaveLength(2);
    }).pipe(run),
  );

  effectIt.effect('saves a compact draft, records exact user approval and initializes the same task facade', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* f.init();
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
        'Fixture source',
      ]);
      const emptyState = yield* f.fs.readFileString(f.statePath());
      expect(
        yield* inspectTaskOnce(readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo})),
      ).toMatchObject({status: 'uninitialized'});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(emptyState);
      const indexer = yield* CodeGraphIndexer;
      const indexed = yield* indexer.index({cwd: f.repo, threadnoteHome: f.home});
      expect(indexed.snapshot.state).toBe('ready');
      const intent = {
        title: 'Refresh expired fixture data',
        currentBehavior: 'Expired fixture data is returned without a freshness check.',
        desiredChange: 'Expired fixture data is refreshed before it is returned.',
        affectedPaths: ['source.ts'],
        acceptanceCriterion: 'Expired fixture data is refreshed before return.',
        verification: 'Exercise expired fixture data and observe the refresh.',
        eligibilityRationale:
          'One behavior and one inspected file are explicit, with no unresolved product decision or dependency.',
        eligibility: {status: 'eligible'},
        review: {required: false, reason: 'Routine local fixture correction.'},
      };
      const inspectedSource = object(
        yield* f.call({
          ...f.base('authoring'),
          command: 'scope-inspect',
          paths: intent.affectedPaths,
          literalOnly: true,
        }),
      );
      const sourceSnapshot = yield* Schema.decodeUnknownEffect(NativeCompactSourceSnapshotSchema)(
        object(inspectedSource.authoring).source,
      );
      const forgedCompact = projectNativeCompactIntent(
        intent,
        {featureId: 'feature', project: 'fixture'},
        sourceSnapshot,
      );
      if (forgedCompact.status !== 'eligible') throw new Error('Expected eligible fixture compact intent.');
      const beforeForgedSave = yield* f.fs.readFileString(f.statePath());
      const forgedSave = yield* f
        .call({
          ...f.base('authoring'),
          command: 'save',
          document: forgedCompact.document,
          ready: false,
          expectedRevision: null,
        })
        .pipe(Effect.result);
      expect(forgedSave).toMatchObject({failure: {code: 'compact-origin-forbidden'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeForgedSave);
      let cliDraft: Record<string, unknown> | undefined;
      const commands = makeNativeTaskActionCommands(
        () => Effect.void,
        () => Effect.void,
        () => Effect.void,
        () => Effect.void,
        () => Effect.void,
        () => Effect.void,
        options =>
          runNativeTaskAction(f.config, {command: 'compact-start', ...options}).pipe(
            Effect.tap(value => Effect.sync(() => (cliDraft = object(value)))),
            Effect.asVoid,
          ),
        () => Effect.void,
        () => Effect.void,
      );
      const cli = Command.make('workflow-automation').pipe(Command.withSubcommands([commands]));
      const runCli = Command.runWith(cli, {version: 'fixture'});
      const beforeStart = yield* f.fs.readFileString(f.statePath());
      const malformed = yield* runCli([
        'task-action',
        'compact-start',
        '--run-id',
        'native-run',
        '--caller-cwd',
        f.repo,
        '--intent',
        '{invalid',
      ]).pipe(Effect.result);
      expect(malformed).toMatchObject({failure: {code: 'invalid-request'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeStart);
      yield* runCli([
        'task-action',
        'compact-start',
        '--run-id',
        'native-run',
        '--caller-cwd',
        f.repo,
        '--intent',
        JSON.stringify(intent),
      ]);
      const draft = object(cliDraft);
      expect(draft.status).toBe('awaiting-user-confirmation');
      expect(yield* f.fs.readFileString(f.statePath())).not.toBe(beforeStart);
      const savedState = yield* f.fs.readFileString(f.statePath());
      // The mutation response can be lost: recover the current root and packet through the read-only facade.
      const initialState = yield* readNativeWorkflowState(f.config, 'native-run');
      if (!initialState) throw new Error('Expected persisted compact run.');
      const initialJournal = yield* f.fs.readFileString(f.journalPath(initialState.state.bindingId));
      // Test oracle only: observe and decode the actual persisted document independently
      // before discarding the mutation response. Keep this read outside the traced task-view scope.
      const expectedInitialDocument = yield* Schema.decodeUnknownEffect(NativeAuthoringPlanDocumentSchema, {
        onExcessProperty: 'error',
      })(
        object(
          object(
            yield* f.call({...f.base('authoring'), command: 'load', uri: object(draft.root).uri, detail: 'document'}),
          ).authoring,
        ).document,
      );

      const resumedDraft = object(
        yield* inspectTaskOnce(readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo})),
      );
      expect(resumedDraft).toMatchObject({
        status: 'blocked',
        next: {action: 'compact-confirm'},
        authoring: {
          status: 'awaiting-user-confirmation',
          root: draft.root,
          intentHash: draft.intentHash,
          documentHash: draft.documentHash,
          packet: {intentHash: draft.intentHash, documentHash: draft.documentHash},
        },
      });
      expect(object(resumedDraft.authoring).packet).not.toHaveProperty('document');
      expect(yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo})).toEqual(resumedDraft);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(savedState);
      expect(yield* f.fs.readFileString(f.journalPath(initialState.state.bindingId))).toBe(initialJournal);
      let cliPacket: Record<string, unknown> | undefined;
      const taskViewCommand = makeNativeTaskViewCommand(options =>
        readNativeTaskView(f.config, {
          runId: options.runId,
          callerCwd: options.callerCwd,
          ...(options.detail === undefined ? {} : {detail: options.detail}),
        }).pipe(
          Effect.tap(value =>
            Effect.sync(() => {
              cliPacket = object(value);
            }),
          ),
          Effect.asVoid,
        ),
      );
      const taskViewCli = Command.make('workflow-automation').pipe(Command.withSubcommands([taskViewCommand]));
      yield* Command.runWith(taskViewCli, {version: 'fixture'})([
        'task-view',
        '--run-id',
        'native-run',
        '--caller-cwd',
        f.repo,
        '--detail',
        'packet',
      ]);
      const recoveredDraft = object(object(object(cliPacket).authoring).packet);
      expect(recoveredDraft.document).toEqual(expectedInitialDocument);
      expect(recoveredDraft.documentHash).toBe(nativeAuthoringDigest(expectedInitialDocument));
      expect(recoveredDraft.intentHash).toBe(nativeSpecIntentDigest(expectedInitialDocument));

      expect(recoveredDraft).toMatchObject({
        intentHash: draft.intentHash,
        documentHash: draft.documentHash,
        document: {
          title: intent.title,
          current: {summary: intent.currentBehavior},
          target: {summary: intent.desiredChange},
          phases: [
            {
              affectedPaths: intent.affectedPaths,
              acceptance: [{criterion: intent.acceptanceCriterion, verification: intent.verification}],
            },
          ],
          compactOrigin: {eligibilityRationale: intent.eligibilityRationale},
        },
      });
      expect(yield* f.fs.readFileString(f.statePath())).toBe(savedState);
      expect(yield* f.fs.readFileString(f.journalPath(initialState.state.bindingId))).toBe(initialJournal);
      const draftPacket = object(draft.packet);
      const draftDocument = object(draftPacket.document);
      const documentWithoutCompactOrigin = {...draftDocument};
      delete documentWithoutCompactOrigin.compactOrigin;
      const root = object(draft.root);
      const markerRemoval = yield* f
        .call({
          ...f.base('authoring'),
          command: 'save',
          document: documentWithoutCompactOrigin,
          ready: false,
          uri: root.uri,
          expectedRevision: root.revision,
        })
        .pipe(Effect.result);
      expect(markerRemoval).toMatchObject({failure: {code: 'compact-confirmation-required'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(savedState);
      const intentHash = String(draft.intentHash);
      const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
      registerWorkflowTaskTool(mcp, f.config);
      const omittedDecision = object(
        yield* mcp.invokeTool('workflow_task_compact_confirm', {
          runId: 'native-run',
          callerCwd: f.repo,
          presentedIntentHash: intentHash,
          userResponse: 'I reject this exact intent because it changes too much.',
          baseBranch: 'main',
        }),
      );
      expect(omittedDecision.structuredContent).toMatchObject({status: 'awaiting-user-confirmation'});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(savedState);
      const explicitRejection = object(
        yield* mcp.invokeTool('workflow_task_compact_confirm', {
          runId: 'native-run',
          callerCwd: f.repo,
          presentedIntentHash: intentHash,
          userDecision: 'reject',
          userResponse: 'I reject this exact intent because it changes too much.',
          baseBranch: 'main',
        }),
      );
      expect(explicitRejection.structuredContent).toMatchObject({status: 'reject'});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(savedState);
      const explicitDeferral = object(
        yield* mcp.invokeTool('workflow_task_compact_confirm', {
          runId: 'native-run',
          callerCwd: f.repo,
          presentedIntentHash: intentHash,
          userDecision: 'defer',
          userResponse: 'Defer this exact intent until I decide.',
          baseBranch: 'main',
        }),
      );
      expect(explicitDeferral.structuredContent).toMatchObject({status: 'defer'});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(savedState);
      const response = object(
        yield* mcp.invokeTool('workflow_task_compact_confirm', {
          runId: 'native-run',
          callerCwd: f.repo,
          presentedIntentHash: intentHash,
          userResponse: 'I approve this exact bounded fixture change.',
          userDecision: 'approve',
          baseBranch: 'main',
        }),
      );
      expect(response.isError).not.toBe(true);
      const approved = object(response.structuredContent);
      expect(approved).toMatchObject({
        status: 'admitted',
        intentHash,
        taskReadiness: 'ready',
        task: {status: 'ready', next: {action: 'implement'}},
      });
      expect((yield* readNativeWorkflowState(f.config, 'native-run'))?.state.cycle?.state.plan.delivery).toBe('local');
      const initialPlan = yield* Schema.decodeUnknownEffect(NativeAuthoringPlanDocumentSchema)(draftDocument);
      const work = object(
        yield* runNativeTaskAction(f.config, {
          command: 'work',
          runId: 'native-run',
          callerCwd: f.repo,
          packet,
        }),
      );
      expect(work).toMatchObject({status: 'ready', phaseId: 'compact'});
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "worker result";\n');
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
        'Worker source result',
      ]);
      const reindexed = yield* (yield* CodeGraphIndexer).index({cwd: f.repo, threadnoteHome: f.home});
      expect(reindexed.snapshot.state).toBe('ready');
      const snapshot = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-snapshot',
          runId: 'native-run',
          callerCwd: f.repo,
          workRef: String(work.workRef),
        }),
      );
      expect(snapshot.status).toBe('recorded');
      const snapshotRef = String(snapshot.snapshotRef);
      const finding = {
        id: 'compact-expansion-preserved-finding',
        file: 'source.ts',
        line: 1,
        body: 'The implementation has not yet established the expanded behavior.',
        trigger: 'The phase has an unreviewed source snapshot.',
        impact: 'The expanded plan must retain this finding and its history.',
        evidence: 'The finding is stored against the immutable compact phase snapshot.',
        severity: 'important',
        category: 'correctness',
        confidence: 90,
        state: 'new',
      };
      const recordedFinding = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-review',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef,
          report: {
            mode: 'full',
            selected: ['correctness', 'simplicity'],
            lanes: [
              {name: 'correctness', status: 'complete'},
              {name: 'simplicity', status: 'complete'},
            ],
            findings: [finding],
          },
        }),
      );
      expect(recordedFinding).toMatchObject({status: 'recorded', replayed: false});
      const beforeExpansion = yield* readNativeWorkflowState(f.config, 'native-run');
      const preservedCycle = beforeExpansion?.state.cycle;
      expect(preservedCycle?.attempts).toHaveLength(1);
      expect(preservedCycle?.attempts[0]?.report).toContain('compact-expansion-preserved-finding');
      expect(preservedCycle?.reviews).toHaveLength(1);
      const sourceInspection = object(
        object(
          yield* f.call({
            ...f.base('authoring'),
            command: 'scope-inspect',
            paths: ['source.ts'],
            literalOnly: true,
          }),
        ).authoring,
      );
      const refreshedSource = object(sourceInspection.source);
      const compactPhase = initialPlan.phases[0];
      const firstAcceptance = compactPhase?.acceptance[0];
      if (!compactPhase || !firstAcceptance) throw new Error('The compact plan must have one accepted phase.');
      const expandedDocument = {
        ...initialPlan,
        title: 'Refresh fixture data and verify the persisted result',
        objective: 'Refresh stale fixture data and verify the persisted result on the same run.',
        requirements: [{id: 'behavior', behavior: 'Stale fixture data is refreshed and verified before return.'}],
        source: refreshedSource,
        current: {
          ...initialPlan.current,
          summary: 'Expired fixture data is returned without a freshness check.',
          components: ['source.ts exports the fixture value consumed by the reload check.'],
        },
        target: {
          ...initialPlan.target,
          summary: 'Expired fixture data is refreshed and then verified before return.',
          components: [
            'source.ts refreshes the fixture value and exposes the persisted result for reload verification.',
          ],
        },
        phases: [
          {
            ...compactPhase,
            title: 'Refresh expired fixture data',
            outcome: 'Expired fixture data is refreshed before return.',
            acceptance: [
              {
                ...firstAcceptance,
                criterion: 'Expired fixture data is refreshed before return.',
                verification: 'Exercise expiration and observe the refreshed result.',
              },
            ],
          },
          {
            ...compactPhase,
            id: 'verify',
            title: 'Verify persisted fixture data',
            outcome: 'The refreshed fixture data remains available after reload.',
            dependsOn: ['compact'],
            acceptance: [
              {
                ...firstAcceptance,
                id: 'persisted-result',
                criterion: 'The refreshed fixture result remains available after reload.',
                verification: 'Reload the fixture and observe the refreshed result.',
              },
            ],
          },
        ],
        decisions: [
          {
            id: 'verify-after-refresh',
            question: 'How should persistence be checked?',
            selection: 'no-better-alternative',
            selected: 'Use the existing readback path after the refresh.',
            alternatives: [],
            rationale: 'This adds one dependent verification phase while retaining the existing storage contract.',
            affectedPhases: ['compact', 'verify'],
            authority: 'orchestrator',
          },
        ],
        review: {required: true, reason: 'The expanded scope adds a dependent persistence check.'},
      };
      // The MCP shape passes an unknown item key on, so the strict runtime decode refuses it instead of dropping it.
      const misspelled = yield* mcp
        .invokeTool('workflow_task_compact_expand', {
          runId: 'native-run',
          callerCwd: f.repo,
          document: {
            ...expandedDocument,
            phases: [{...expandedDocument.phases[0], acceptance: [{...firstAcceptance, scenarioId: ['typo']}]}],
          },
        })
        .pipe(Effect.result);
      expect(misspelled).toMatchObject({
        failure: {code: 'invalid-document', message: expect.stringContaining('acceptance[0]')},
      });
      const expanded = object(
        yield* mcp.invokeTool('workflow_task_compact_expand', {
          runId: 'native-run',
          callerCwd: f.repo,
          document: expandedDocument,
        }),
      );
      expect(expanded.isError).not.toBe(true);
      const expandedContent = object(expanded.structuredContent);
      expect(expandedContent).toMatchObject({
        status: 'awaiting-user-confirmation',
        previousRoot: root.uri,
        root: {uri: root.uri},
      });
      const expandedIntentHash = String(expandedContent.intentHash);
      expect(expandedIntentHash).not.toBe(intentHash);
      // Independently capture the complete persisted expansion as a test oracle, not a user recovery step.
      const expectedExpandedDocument = yield* Schema.decodeUnknownEffect(NativeAuthoringPlanDocumentSchema, {
        onExcessProperty: 'error',
      })(
        object(
          object(
            yield* f.call({
              ...f.base('authoring'),
              command: 'load',
              uri: object(expandedContent.root).uri,
              detail: 'document',
            }),
          ).authoring,
        ).document,
      );
      // Recover all authored material through the task MCP surface after discarding the expansion response.
      const detailedExpanded = object(
        yield* mcp.invokeTool('workflow_task_view', {
          runId: 'native-run',
          callerCwd: f.repo,
          detail: 'packet',
        }),
      );
      expect(detailedExpanded.isError).not.toBe(true);
      const recoveredExpanded = object(object(object(detailedExpanded.structuredContent).authoring).packet);
      expect(recoveredExpanded).toMatchObject({
        intentHash: expandedIntentHash,
        documentHash: expandedContent.documentHash,
      });
      const recoveredExpandedDocument = object(recoveredExpanded.document);
      expect(recoveredExpandedDocument).toEqual(expectedExpandedDocument);
      expect(recoveredExpanded.documentHash).toBe(nativeAuthoringDigest(expectedExpandedDocument));
      expect(recoveredExpanded.intentHash).toBe(nativeSpecIntentDigest(expectedExpandedDocument));

      expect(recoveredExpandedDocument.title).toBe(expandedDocument.title);
      expect(recoveredExpandedDocument.current).toEqual(expandedDocument.current);
      expect(recoveredExpandedDocument.target).toEqual(expandedDocument.target);
      expect(recoveredExpandedDocument.phases).toEqual(expandedDocument.phases);
      expect(recoveredExpandedDocument.decisions).toEqual(expandedDocument.decisions);
      expect(recoveredExpandedDocument.requirements).toEqual(expandedDocument.requirements);
      const expandedResume = object(yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo}));
      expect(expandedResume).toMatchObject({
        status: 'blocked',
        next: {action: 'compact-confirm'},
        authoring: {
          status: 'awaiting-user-confirmation',
          intentHash: expandedIntentHash,
          documentHash: expandedContent.documentHash,
          root: expandedContent.root,
        },
        cycleTask: {status: 'blocked'},
      });
      expect(object(expandedResume.authoring).intentHash).not.toBe(intentHash);
      const beforeStaleConfirmation = yield* f.fs.readFileString(f.statePath());
      const staleConfirmation = yield* runNativeTaskAction(f.config, {
        command: 'compact-confirm',
        runId: 'native-run',
        callerCwd: f.repo,
        presentedIntentHash: intentHash,
        userResponse: 'I approve the original compact intent.',
        baseBranch: 'main',
      }).pipe(Effect.result);
      expect(staleConfirmation).toMatchObject({failure: {code: 'stale-intent'}});
      const afterStaleConfirmation = yield* f.fs.readFileString(f.statePath());
      expect(afterStaleConfirmation).toBe(beforeStaleConfirmation);
      const awaitingExpandedApproval = object(
        yield* runNativeTaskAction(f.config, {
          command: 'compact-confirm',
          runId: 'native-run',
          callerCwd: f.repo,
          presentedIntentHash: expandedIntentHash,
          baseBranch: 'main',
        }),
      );
      expect(awaitingExpandedApproval.status).toBe('awaiting-user-confirmation');
      expect(awaitingExpandedApproval.actorIdentity).toContain('caller-asserted');
      expect(yield* f.fs.readFileString(f.statePath())).toBe(afterStaleConfirmation);
      const approvedWithoutReview = object(
        yield* runNativeTaskAction(f.config, {
          command: 'compact-confirm',
          runId: 'native-run',
          callerCwd: f.repo,
          presentedIntentHash: expandedIntentHash,
          userDecision: 'approve',
          userResponse: 'I approve the expanded two-phase intent and its exact source scope.',
          baseBranch: 'main',
        }),
      );
      expect(approvedWithoutReview.status).toBe('awaiting-review');
      const reviewState = yield* f.fs.readFileString(f.statePath());
      const awaitingReview = object(yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo}));
      expect(awaitingReview).toMatchObject({
        status: 'blocked',
        next: {action: 'compact-confirm'},
        authoring: {
          status: 'awaiting-review',
          intentHash: expandedIntentHash,
          documentHash: expandedContent.documentHash,
        },
        cycleTask: {status: 'blocked'},
      });
      expect(yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo})).toEqual(awaitingReview);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(reviewState);
      const expandedApproval = object(
        yield* mcp.invokeTool('workflow_task_compact_confirm', {
          runId: 'native-run',
          callerCwd: f.repo,
          presentedIntentHash: expandedIntentHash,
          userDecision: 'approve',
          userResponse: 'I approve the expanded two-phase intent and its exact source scope.',
          baseBranch: 'main',
          review: {
            documentHash: String(expandedContent.documentHash),
            outcome: 'accepted',
            blockingIssueCount: 0,
          },
        }),
      );
      expect(expandedApproval.isError).not.toBe(true);
      expect(expandedApproval.structuredContent).toMatchObject({
        status: 'admitted',
        intentHash: expandedIntentHash,
        actorIdentity: expect.stringContaining('caller-asserted'),
      });
      const afterExpansion = yield* readNativeWorkflowState(f.config, 'native-run');
      expect(afterExpansion?.state.cycle?.snapshots).toEqual(preservedCycle?.snapshots);
      expect(afterExpansion?.state.cycle?.attempts).toEqual(preservedCycle?.attempts);
      expect(afterExpansion?.state.cycle?.reviews).toEqual(preservedCycle?.reviews);
      expect(afterExpansion?.state.cycle?.reviewLimits).toEqual(preservedCycle?.reviewLimits);
      expect(afterExpansion?.state.cycle?.reviewExpansions).toEqual(preservedCycle?.reviewExpansions);
      expect(afterExpansion?.state.cycle?.plans).toContainEqual(
        expect.objectContaining({
          source: expect.objectContaining({documentHash: preservedCycle?.state.plan.source.documentHash}),
        }),
      );
      const taskView = yield* inspectTaskOnce(readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo}));
      const repeatedTaskView = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
      expect(taskView).toEqual(repeatedTaskView);
      expect(taskView).toMatchObject({status: 'blocked', next: {action: 'blocked'}});
      const stored = yield* f.fs.readFileString(f.statePath());
      const replay = object(
        yield* runNativeTaskAction(f.config, {
          command: 'compact-confirm',
          runId: 'native-run',
          callerCwd: f.repo,
          presentedIntentHash: expandedIntentHash,
          baseBranch: 'main',
          review: {
            documentHash: String(expandedContent.documentHash),
            outcome: 'accepted',
            blockingIssueCount: 0,
          },
        }),
      );
      expect(replay.status).toBe('admitted');
      expect(yield* f.fs.readFileString(f.statePath())).toBe(stored);
      // A changed latest root must fail closed, never fall back to its valid historical root.
      const currentRootUri = String(object(expandedContent.root).uri);
      const originalRoot = yield* f.store.read(f.location, currentRootUri);
      yield* Effect.acquireUseRelease(
        f.store.write(f.location, currentRootUri, originalRoot + '\nUnexpected external edit.\n', {mode: 'replace'}),
        () =>
          Effect.gen(function* () {
            const changedRoot = yield* f.store.read(f.location, currentRootUri);
            const corruptedRead = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo}).pipe(
              Effect.result,
            );
            expect(corruptedRead._tag).toBe('Failure');
            expect(
              (yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo, detail: 'packet'}).pipe(
                Effect.result,
              ))._tag,
            ).toBe('Failure');
            expect(yield* f.fs.readFileString(f.statePath())).toBe(stored);
            expect(yield* f.store.read(f.location, currentRootUri)).toBe(changedRoot);
          }),
        () => f.store.write(f.location, currentRootUri, originalRoot, {mode: 'replace'}),
      );
    }).pipe(run),
  );

  effectIt.effect('returns a missing planning decision without saving compact intent', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* f.init();
      const before = yield* f.fs.readFileString(f.statePath());
      const result = object(
        yield* runNativeTaskAction(f.config, {
          command: 'compact-start',
          runId: 'native-run',
          callerCwd: f.repo,
          intent: {
            title: 'Change fixture refresh behavior',
            currentBehavior: 'Expired fixture entries are returned as current.',
            desiredChange: 'Expired fixture entries are refreshed before return.',
            affectedPaths: ['source.ts'],
            acceptanceCriterion: 'Expired entries refresh before return.',
            verification: 'Exercise expiration and observe the refreshed value.',
            eligibilityRationale: 'An unresolved behavior choice remains.',
            eligibility: {
              status: 'needs-planning',
              missingDecision: 'Choose synchronous refresh or queued refresh.',
              evidenceRefs: ['threadnote://user/test/memories/durable/projects/fixture/cache.md'],
            },
            review: {required: false, reason: 'Not eligible until the decision is resolved.'},
          },
        }),
      );
      expect(result).toMatchObject({
        status: 'needs-planning',
        missingDecision: 'Choose synchronous refresh or queued refresh.',
        evidenceRefs: ['threadnote://user/test/memories/durable/projects/fixture/cache.md'],
      });
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
    }).pipe(run),
  );

  effectIt.effect('accepts the bound checkout when Git reports an alternate root spelling', () =>
    Effect.gen(function* () {
      const f = yield* fixture(['one'], 'local');
      yield* f.mutate('begin-phase', {phaseId: 'one'});
      const fs = yield* FileSystem.FileSystem;
      const executor = yield* CommandExecutor;
      const canonicalRoot = yield* fs.realPath(f.repo);
      const separator = f.path.sep;
      const reportedRoot = canonicalRoot + separator + '.';
      let injectedAlternateRoot = false;
      const alternateRootExecutor = CommandExecutor.of({
        ...executor,
        execute: (executable, args, options) =>
          executor.execute(executable, args, options).pipe(
            Effect.map(result => {
              if (executable !== 'git' || args[0] !== 'rev-parse' || args[1] !== '--show-toplevel') return result;
              injectedAlternateRoot = true;
              return {...result, stdout: reportedRoot};
            }),
          ),
      });
      const work = object(
        yield* runNativeTaskAction(f.config, {
          command: 'work',
          runId: 'native-run',
          callerCwd: f.repo,
          packet,
        }).pipe(Effect.provideService(CommandExecutor, alternateRootExecutor)),
      );
      expect(injectedAlternateRoot).toBe(true);
      expect(work.status).toBe('ready');
      expect(work.phaseId).toBe('one');
    }).pipe(run),
  );

  effectIt.effect('canonicalizes the reported checkout root while refusing a different repository', () =>
    Effect.gen(function* () {
      const f = yield* fixture(['one'], 'local');
      const foreignRepo = yield* f.fs.makeTempDirectoryScoped({prefix: 'threadnote-task-foreign-checkout-'});
      yield* runCommandEffect('git', ['init', foreignRepo]);
      const before = yield* f.fs.readFileString(f.statePath());
      const refusal = yield* runNativeTaskAction(f.config, {
        command: 'work',
        runId: 'native-run',
        callerCwd: foreignRepo,
        packet,
      }).pipe(Effect.result);
      expect(refusal).toMatchObject({failure: {code: expect.stringMatching(/^(?:wrong-checkout|binding-drift)$/u)}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
    }).pipe(run),
  );
});
