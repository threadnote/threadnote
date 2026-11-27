import {Array as EffectArray, Effect, FileSystem, Path} from 'effect';
import * as Clock from 'effect/Clock';
import * as EffectOption from 'effect/Option';
import * as EffectString from 'effect/String';
import {Command} from 'effect/cli';
import {SecureRandom} from 'effect/crypto';
import {it as effectIt} from '@effect/vitest';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {describe, expect, it} from 'vitest';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {decodeNativeTaskActionRef, encodeNativeTaskActionRef} from '@threadnote/workflow-automations/task';
import {
  acknowledgeNativeWatch,
  recordNativeWatchDispositions,
  recordNativeWatchLifecycle,
  relayNativeWatch,
} from '@threadnote/workflow-automations/watch';
import {CommandExecutor, runCommandEffect} from '@threadnote/platform/command';
import {EffectMcpServerAdapter} from '../../src/effect/ai/mcp.js';
import {registerWorkflowTaskTool} from '../../src/mcp/server/workflow.js';
import {readNativeTaskView} from '../../src/workflow_automation/task.js';
import {runWorkflowAutomation} from '../../src/workflow_automation/index.js';
import {inCheckout} from '../../src/workflow_automation/task_action_helpers.js';
import {inspectOldBindingOwners} from '../../src/workflow_automation/task_binding_transition.js';
import {nativeWatchRecoveryNext, resolveNativeTaskPrWatch} from '../../src/workflow_automation/task_pr_watch.js';
import {makeNativeTaskPrWatchCommand} from '../../src/effect/workflow_cli.js';
import {runNativeTaskAction as runNativeTaskActionCore} from '../../src/workflow_automation/task_actions.js';
import {readNativeWatch, writeNativeWatch} from '../../src/workflow_automation/watch_store.js';
import {
  consumeNativeWatchNotification,
  nativeWatchNotice,
} from '../../src/workflow_automation/watch_notification_state.js';
import {makeNativeWatchNotifier} from '../../src/workflow_automation/watch_notification.js';
import {applyDevSkills, statusDevSkills} from '../../src/dev_skills/index.js';
import {SystemInfo} from '@threadnote/platform/system';
import {
  nativeCloseoutJournalPath,
  readNativeWorkflowState,
  serializeNativeWorkflowState,
} from '../../src/workflow_automation/store.js';
import {sha256HexSync} from '../../src/workflow_memory/native_digest.js';
import {CurrentNativeJobAutoLaunch, runNativeJobWorker} from '../../src/workflow_automation/native_jobs.js';
import {readNativeCloseoutJournal} from '../../src/workflow_automation/closeout_store.js';
import {decodeJournal} from '../../src/workflow_automation/closeout_request_schema.js';
import {stableJson} from '../../src/workflow_memory/protocol.js';
import {object, run} from './native-cycle-lifecycle-fixture.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {
  windowsRealGitFixtureTimeout,
  cliTestLayer,
  fixture,
  runNativeTaskAction,
  packet,
  proposal,
  attemptSimulatedTaskWatch,
  startSimulatedTaskWatch,
  recoverHistoricalTaskWatch,
  writeSimulatedTaskWatch,
  publishOpenHistoricalPhase,
} from './native-task-actions-fixture.js';

/** Starts a real standalone watch for the PR; only GitHub, the host probe and the collector spawn are simulated. */
const startStandaloneWatch = (
  f: Effect.Success<ReturnType<typeof fixture>>,
  prUrl: string,
  wakeup: {readonly host: 'codex'; readonly executable: string; readonly threadId: string},
) =>
  Effect.gen(function* () {
    const commands = yield* CommandExecutor;
    const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | SecureRandom.SecureRandom>();
    const [, owner, repo, , number] = EffectString.split(new URL(prUrl).pathname, '/');
    const standaloneCommands = CommandExecutor.of({
      ...commands,
      execute: (executable, args, options) =>
        executable === wakeup.executable
          ? Effect.succeed({exitCode: 0, stderr: '', stdout: 'Usage: codex queue\n --thread <T>\n --message <M>\n'})
          : executable === 'gh'
            ? Effect.succeed({
                exitCode: 0,
                stderr: '',
                stdout: JSON.stringify({
                  number: Number(number),
                  url: prUrl,
                  baseRepository: `${owner}/${repo}`,
                  baseBranch: 'main',
                  headBranch: 'feature/one',
                  headSha: EffectString.repeat(40)('a'),
                  state: 'open',
                  merged: false,
                }),
              })
            : commands.execute(executable, args, options),
      spawnDetached: (_executable, args) =>
        Effect.gen(function* () {
          const watchId = args[args.indexOf('--watch-id') + 1];
          const starting = yield* readNativeWatch(f.config, watchId);
          if (!starting?.envelope.collector) return false;
          yield* writeNativeWatch(
            f.config,
            {...starting.envelope, collector: {...starting.envelope.collector, pid: 77777, status: 'running'}},
            starting.revision,
          );
          return true;
        }).pipe(Effect.provide(context), Effect.orDie),
    });
    const system = yield* SystemInfo;
    return object(
      yield* runNativeTaskAction(f.config, {
        command: 'watch-pr',
        operation: 'start',
        callerCwd: f.repo,
        prUrl,
        wakeup,
      }).pipe(
        Effect.provideService(CommandExecutor, standaloneCommands),
        Effect.provideService(SystemInfo, SystemInfo.of({...system, isProcessRunning: pid => pid === 77777})),
      ),
    );
  });

describe('native task actions', () => {
  const prReceiptCase = (maintenance: boolean) =>
    Effect.gen(function* () {
      const f = yield* fixture(['one'], 'pr');
      yield* f.mutate('begin-phase', {phaseId: 'one'});
      const work = object(
        yield* runNativeTaskAction(f.config, {command: 'work', runId: 'native-run', callerCwd: f.repo, packet}),
      );
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "PR worker result";\n');
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'PR worker result']);
      const snapshot = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-snapshot',
          runId: 'native-run',
          callerCwd: f.repo,
          workRef: String(work.workRef),
        }),
      );
      const snapshotRef = String(snapshot.snapshotRef);
      const report = {
        mode: 'full',
        selected: ['correctness', 'simplicity'],
        lanes: [
          {name: 'correctness', status: 'complete'},
          {name: 'simplicity', status: 'complete'},
        ],
        findings: [],
      };
      yield* f.git(['commit', '--allow-empty', '-m', 'Same-tree PR build marker']);
      yield* runNativeTaskAction(f.config, {
        command: 'record-review',
        runId: 'native-run',
        callerCwd: f.repo,
        snapshotRef,
        report,
      });
      const validation = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-validation',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef,
          validation: {
            checks: [{command: 'private PR check', result: 'passed', evidence: 'The scoped test fixture passed.'}],
            acceptance: [{criterion: 'one works', result: 'passed', evidence: 'The implementation meets acceptance.'}],
          },
        }),
      );
      const validationRef = String(validation.validationRef);
      const headSha = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
      const publication = {exemption: 'small-fix', reason: 'Private bounded fixture publication authority.'};
      const openPr = {
        url: 'https://github.com/example/repo/pull/1',
        headSha,
        branch: 'feature/one',
        baseBranch: 'main',
        state: 'open',
      };
      const beforeOpen = yield* f.fs.readFileString(f.statePath());
      const deliveryView = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
      expect(deliveryView.prWatchPrerequisites).toMatchObject({publicationAloneArmsWatch: false});
      expect(deliveryView.prWatchPrerequisites?.required).toContain('host-registration');

      const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
      registerWorkflowTaskTool(mcp, f.config);
      const executor = yield* CommandExecutor;
      const prProvider = CommandExecutor.of({
        ...executor,
        execute: (executable, args, options) =>
          executable === 'gh' &&
          args.includes('--jq') &&
          EffectArray.some(args, arg => EffectString.includes('headSha: .head.sha')(arg))
            ? Effect.succeed({
                exitCode: 0,
                stderr: '',
                stdout: JSON.stringify({
                  number: 1,
                  url: openPr.url,
                  baseRepository: 'example/repo',
                  headRepository: 'example/repo',
                  baseBranch: 'main',
                  headBranch: 'feature/one',
                  headSha,
                  state: 'open',
                  merged: false,
                }),
              })
            : executor.execute(executable, args, options),
      });
      const authority = 'The private fixture user approved this existing PR delivery.';
      const adopt = {
        command: 'deliver-pr',
        runId: 'native-run',
        callerCwd: f.repo,
        validationRef,
        commitEvidence: 'Verified private fixture commit ' + headSha,
        pr: openPr,
        publication,
        userAuthority: authority,
      };
      const {userAuthority: _authority, ...withoutAuthority} = adopt;
      expect(yield* runNativeTaskActionCore(f.config, withoutAuthority).pipe(Effect.result)).toMatchObject({
        failure: {code: 'user-authority-required'},
      });
      for (const changed of [
        {headSha: EffectString.repeat(40)('f')},
        {headRepository: 'untrusted/fork'},
        {baseBranch: 'other-base'},
      ]) {
        const mismatching = CommandExecutor.of({
          ...executor,
          execute: (executable, args, options) =>
            prProvider
              .execute(executable, args, options)
              .pipe(
                Effect.map(result =>
                  executable === 'gh' && EffectArray.some(args, arg => EffectString.includes('headSha: .head.sha')(arg))
                    ? {...result, stdout: JSON.stringify({...JSON.parse(result.stdout), ...changed})}
                    : result,
                ),
              ),
        });
        expect(
          yield* runNativeTaskActionCore(f.config, adopt).pipe(
            Effect.provideService(CommandExecutor, mismatching),
            Effect.result,
          ),
        ).toMatchObject({failure: {code: 'pr-source-mismatch'}});
        expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeOpen);
      }
      let observations = 0;
      const moving = CommandExecutor.of({
        ...executor,
        execute: (executable, args, options) =>
          prProvider.execute(executable, args, options).pipe(
            Effect.map(result => {
              if (
                executable === 'gh' &&
                EffectArray.some(args, arg => EffectString.includes('headSha: .head.sha')(arg)) &&
                ++observations === 2
              )
                return {
                  ...result,
                  stdout: JSON.stringify({...JSON.parse(result.stdout), headSha: EffectString.repeat(40)('e')}),
                };
              return result;
            }),
          ),
      });
      expect(
        yield* runNativeTaskActionCore(f.config, adopt).pipe(
          Effect.provideService(CommandExecutor, moving),
          Effect.result,
        ),
      ).toMatchObject({failure: {code: 'pr-source-mismatch'}});
      expect(observations).toBe(2);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeOpen);
      const provisional = object(
        yield* runNativeTaskActionCore(f.config, adopt).pipe(Effect.provideService(CommandExecutor, prProvider)),
      );
      const retried = object(
        yield* runNativeTaskActionCore(f.config, adopt).pipe(Effect.provideService(CommandExecutor, prProvider)),
      );
      expect(retried.deliveryRef).toBe(provisional.deliveryRef);
      const provisionalReceipt = decodeNativeTaskActionRef(String(provisional.deliveryRef))?.delivery;
      expect(provisionalReceipt).toMatchObject({
        userAuthority: authority,
        providerIdentity: {
          url: openPr.url,
          headRepository: 'example/repo',
          baseRepository: 'example/repo',
          headSha,
        },
      });
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeOpen);
      const watchEnvelope = object(
        yield* mcp
          .invokeTool('workflow_task_deliver', {
            runId: 'native-run',
            callerCwd: f.repo,
            delivery: {
              command: 'pr',
              validationRef,
              userAuthority: authority,
              commitEvidence: 'Verified private fixture commit ' + headSha,
              pr: openPr,
              publication,
            },
          })
          .pipe(Effect.provideService(CommandExecutor, prProvider)),
      );
      const watchCard = object(watchEnvelope.structuredContent);
      expect(watchCard).toMatchObject({
        status: 'watch-required',
        next: {action: 'watch-pr', operation: 'start', validationRef},
      });
      expect(object(watchCard.next).deliveryRef).toBe(watchCard.deliveryRef);
      expect(object(watchCard.next)).not.toHaveProperty('prUrl');
      expect(object(watchCard.next)).not.toHaveProperty('headSha');
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeOpen);
      const provisionalRef = decodeNativeTaskActionRef(String(watchCard.deliveryRef));
      if (!provisionalRef?.delivery?.pr) throw new Error('Expected the provisional PR delivery locator.');
      const forgedDelivery = {
        ...provisionalRef.delivery,
        pr: {...provisionalRef.delivery.pr, url: 'https://github.com/other-owner/other-repo/pull/99'},
        providerIdentity: {
          ...provisionalRef.delivery.providerIdentity!,
          url: 'https://github.com/other-owner/other-repo/pull/99',
          number: 99,
          baseRepository: 'other-owner/other-repo',
          headRepository: 'other-owner/other-repo',
        },
      };
      const forgedDeliveryRef = encodeNativeTaskActionRef({
        ...provisionalRef,
        kind: 'delivery',
        delivery: forgedDelivery,
        payloadDigest: sha256HexSync(stableJson(forgedDelivery)),
      });
      const watchId = `pr-${EffectString.slice(0, 48)(sha256HexSync('native-run\none'))}`;
      const watchPath = f.path.join(
        f.config.agentContextHome,
        'workflow-automations',
        'native-watch-v1',
        watchId + '.json',
      );
      if (maintenance) {
        const standalone = yield* startStandaloneWatch(f, openPr.url, {
          host: 'codex',
          executable: '/usr/bin/codex',
          threadId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        });
        expect(standalone).toMatchObject({status: 'watching', authority: 'monitor-only'});
        // CI edits must not revoke the existing watch route or manufacture validation of the new source.
        const watch = yield* startSimulatedTaskWatch(
          f,
          'native-run',
          'one',
          validationRef,
          String(watchCard.deliveryRef),
          openPr.url,
        );
        // The workflow-bound watch replaces the standalone one, so the session is woken once per PR event.
        expect(watch.result).toMatchObject({
          ok: true,
          value: {
            supersededStandaloneWatchId: standalone.watchId,
            receipt: {pr: {state: 'open'}, watch: {state: 'active'}},
          },
        });
        expect((yield* readNativeWatch(f.config, String(standalone.watchId)))?.envelope).toMatchObject({
          stopRequested: true,
          stopReason: 'superseded',
        });
        yield* writeSimulatedTaskWatch(f, watch.startedWatch, watch, openPr.url, headSha, false);
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "CI maintenance";\n');
        yield* f.git(['add', 'source.ts']);
        yield* f.git(['commit', '-m', 'CI maintenance after validated delivery']);
        for (const operation of ['start', 'complete'] as const) {
          expect(
            yield* runNativeTaskAction(f.config, {
              command: 'watch-pr',
              operation,
              runId: 'native-run',
              callerCwd: f.repo,
              validationRef,
              deliveryRef: String(watchCard.deliveryRef),
              ...(operation === 'start' ? {wakeup: watch.wakeup} : {}),
            }).pipe(Effect.result),
          ).toMatchObject({failure: {code: 'source-drift'}});
        }

        yield* f.mutate('invalidate', {phaseId: 'one', reason: 'CI follow-up source needs separate validation.'});
        const maintenanceRunBytes = yield* f.fs.readFileString(f.statePath());
        const provisionalState = yield* readNativeWorkflowState(f.config, 'native-run');
        const provisionalPhase = provisionalState?.state.cycle?.state.phases.one;
        const validationProof = decodeNativeTaskActionRef(validationRef);
        const retainedProofs = EffectArray.filter(
          provisionalPhase?.history ?? [],
          proof =>
            proof.head === headSha &&
            proof.tree === validationProof?.sourceTree &&
            proof.phaseHash === validationProof?.phaseHash,
        );
        expect(provisionalPhase?.delivery).toBeUndefined();
        expect(retainedProofs.length).toBeGreaterThan(0);
        // The watch start recorded the open PR delivery before the CI change.
        expect(EffectArray.some(retainedProofs, proof => proof.delivery?.watch?.state === 'active')).toBe(true);

        const watchRequest = {
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef,
          deliveryRef: String(watchCard.deliveryRef),
        };
        for (const operation of ['start', 'complete'] as const) {
          expect(
            yield* runNativeTaskAction(f.config, {
              command: 'watch-pr',
              operation,
              ...watchRequest,
              ...(operation === 'start' ? {wakeup: watch.wakeup} : {}),
            }).pipe(Effect.result),
          ).toMatchObject({failure: {code: 'stale-delivery-ref'}});
        }
        const beforeRenew = yield* readNativeWatch(f.config, watchId);
        if (!beforeRenew?.envelope.state.consumer) throw new Error('Expected the exact retained watch consumer.');
        yield* writeNativeWatch(
          f.config,
          {
            ...beforeRenew.envelope,
            state: {
              ...beforeRenew.envelope.state,
              consumer: {
                ...beforeRenew.envelope.state.consumer,
                lastSeenAt: 1,
                leaseUntil: 1 + beforeRenew.envelope.state.consumer.leaseMilliseconds,
              },
            },
          },
          beforeRenew.revision,
        );
        watch.setCollectorAlive(false);
        const renew = (input: object) =>
          runNativeTaskAction(f.config, {command: 'watch-pr', operation: 'renew', ...watchRequest, ...input}).pipe(
            Effect.provideService(CommandExecutor, watch.commands),
            Effect.provideService(SystemInfo, watch.system),
          );
        const beforeRejectedRenew = yield* f.fs.readFileString(watchPath);
        expect(
          yield* renew({wakeup: {...watch.wakeup, threadId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'}}).pipe(
            Effect.result,
          ),
        ).toMatchObject({failure: {code: 'watch-identity-conflict'}});
        watch.setRemoteBase('wrong-base');
        expect(yield* renew({}).pipe(Effect.result)).toMatchObject({failure: {code: 'watch-identity-conflict'}});
        const retargeted = {
          ...provisionalRef.delivery,
          pr: {...provisionalRef.delivery.pr, baseBranch: 'wrong-base'},
          providerIdentity: {...provisionalRef.delivery.providerIdentity!, baseBranch: 'wrong-base'},
        };
        const retargetedRef = encodeNativeTaskActionRef({
          ...provisionalRef,
          kind: 'delivery',
          delivery: retargeted,
          payloadDigest: sha256HexSync(stableJson(retargeted)),
        });
        // The retained canonical receipt binds the base, so a retargeted reference is stale.
        expect(yield* renew({deliveryRef: retargetedRef}).pipe(Effect.result)).toMatchObject({
          failure: {code: 'stale-delivery-ref'},
        });
        watch.setRemoteBase('main');
        expect(yield* f.fs.readFileString(watchPath)).toBe(beforeRejectedRenew);
        const beforeStartup = yield* readNativeWatch(f.config, watchId);
        if (!beforeStartup?.envelope.collector) throw new Error('Expected the retained collector claim.');
        const youngStartup = yield* writeNativeWatch(
          f.config,
          {
            ...beforeStartup.envelope,
            collector: {
              ...beforeStartup.envelope.collector,
              pid: 0,
              status: 'starting',
              startedAt: yield* Clock.currentTimeMillis,
            },
          },
          beforeStartup.revision,
        );
        const youngStartupBytes = yield* f.fs.readFileString(watchPath);
        expect(yield* renew({}).pipe(Effect.result)).toMatchObject({failure: {code: 'collector-starting'}});
        expect(yield* f.fs.readFileString(watchPath)).toBe(youngStartupBytes);
        expect(watch.spawnCount()).toBe(1);
        yield* writeNativeWatch(f.config, beforeStartup.envelope, youngStartup.revision);
        const renewedResponse = object(
          yield* mcp
            .invokeTool('workflow_task_watch_pr', {operation: 'renew', ...watchRequest})
            .pipe(
              Effect.provideService(CommandExecutor, watch.commands),
              Effect.provideService(SystemInfo, watch.system),
            ),
        );
        expect(renewedResponse.isError).not.toBe(true);
        expect(object(renewedResponse.structuredContent).status).toBe('watching');
        expect(watch.spawnCount()).toBe(2);
        expect(watch.hostPreflightCount()).toBe(1);
        const renewed = yield* readNativeWatch(f.config, watchId);
        if (!renewed) throw new Error('Expected the renewed retained watch.');
        expect(renewed.envelope.state.consumer?.leaseUntil).toBeGreaterThan(yield* Clock.currentTimeMillis);
        const {consumer: _oldConsumer, ...beforeRenewState} = beforeRenew.envelope.state;
        const {consumer: _newConsumer, ...afterRenewState} = renewed.envelope.state;
        expect(afterRenewState).toEqual(beforeRenewState);
        expect(renewed.envelope.notification).toEqual(beforeRenew.envelope.notification);
        expect(renewed.envelope.provider).toEqual(beforeRenew.envelope.provider);
        expect(object(yield* renew({})).status).toBe('watching');
        expect(watch.spawnCount()).toBe(2);
        const nativeRenew = {
          protocolVersion: 1,
          executorVersion: 1,
          action: 'watch',
          command: 'renew',
          watchId,
          pr: openPr.url,
          consumerId: watch.consumerId,
          wakeupId: watch.wakeupId,
          wakeup: watch.wakeup,
          baseBranch: 'main',
          headBranch: 'feature/one',
        };
        for (const change of [
          {consumerId: 'foreign-consumer'},
          {pr: 'https://github.com/foreign/repo/pull/99'},
          {watchId: 'missing-renew'},
        ]) {
          expect(
            yield* f
              .call({...nativeRenew, ...change})
              .pipe(
                Effect.provideService(CommandExecutor, watch.commands),
                Effect.provideService(SystemInfo, watch.system),
                Effect.result,
              ),
          ).toMatchObject({failure: {code: change.watchId ? 'watch-not-found' : 'watch-identity-conflict'}});
        }
        expect(yield* readNativeWatch(f.config, 'missing-renew')).toBeUndefined();
        const historicalWatchBytes = yield* f.fs.readFileString(watchPath);
        const decodedValidation = decodeNativeTaskActionRef(validationRef);
        if (!decodedValidation) throw new Error('Expected the canonical validation reference.');
        const foreignValidation = encodeNativeTaskActionRef({
          ...decodedValidation,
          generationHash: EffectString.repeat(64)('f'),
        });
        const foreignRefused = yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'inspect',
          ...watchRequest,
          validationRef: foreignValidation,
        }).pipe(Effect.result);
        expect(foreignRefused).toMatchObject({
          failure: {
            code: 'invalid-delivery-ref',
            next: {tool: 'workflow_task_view', arguments: {runId: 'native-run', callerCwd: f.repo}},
          },
        });
        // A plain view reloads current refs; a phase view is the historical-watch mode.
        if (foreignRefused._tag !== 'Failure') throw new Error('Expected the foreign validation refusal.');
        expect(object(foreignRefused.failure).next).not.toHaveProperty('arguments.phaseId');
        const watchDirectory = f.path.dirname(watchPath);
        const storedWatchBytes = () =>
          Effect.gen(function* () {
            const names = EffectArray.filter(yield* f.fs.readDirectory(watchDirectory), name =>
              EffectString.endsWith('.json')(name),
            ).sort();
            return yield* Effect.forEach(names, name =>
              Effect.map(f.fs.readFileString(f.path.join(watchDirectory, name)), bytes => ({name, bytes})),
            );
          });
        const beforeForgedWatches = yield* storedWatchBytes();
        const beforeForgedRevision = (yield* readNativeWatch(f.config, watchId))?.revision;
        const effects = {provider: 0, host: 0, spawn: 0};
        const readOnlyCommands = CommandExecutor.of({
          ...watch.commands,
          execute: (executable, args, options) => {
            if (executable === 'gh' || executable === watch.wakeup.executable) {
              if (executable === 'gh') effects.provider++;
              else effects.host++;
              return Effect.succeed({
                exitCode: 1,
                stdout: '',
                stderr: 'Read-only watch lookup must not call provider or host.',
              });
            }
            return watch.commands.execute(executable, args, options);
          },
          spawnDetached: () => {
            effects.spawn++;
            return Effect.succeed(false);
          },
        });
        const forgedResult = yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'relay',
          ...watchRequest,
          deliveryRef: forgedDeliveryRef,
        }).pipe(Effect.provideService(CommandExecutor, readOnlyCommands), Effect.result);
        // The retained canonical receipt names another PR, so the forged route fails before any lookup or effect.
        expect(forgedResult).toMatchObject({failure: {code: 'stale-delivery-ref'}});
        expect(effects).toEqual({provider: 0, host: 0, spawn: 0});
        expect(yield* storedWatchBytes()).toEqual(beforeForgedWatches);
        expect((yield* readNativeWatch(f.config, watchId))?.revision).toBe(beforeForgedRevision);
        const missingQualifiedId = `${watchId}-${EffectString.slice(0, 48)(sha256HexSync(forgedDelivery.pr.url))}`;
        expect(yield* readNativeWatch(f.config, missingQualifiedId)).toBeUndefined();
        expect(yield* f.fs.readFileString(f.statePath())).toBe(maintenanceRunBytes);
        expect(yield* f.fs.readFileString(watchPath)).toBe(historicalWatchBytes);
        const inspected = object(
          yield* runNativeTaskAction(f.config, {command: 'watch-pr', operation: 'inspect', ...watchRequest}),
        );
        expect(inspected).toMatchObject({status: 'watch-updated'});
        const noticeRef = String(inspected.noticeRef);
        const relayed = object(
          yield* runNativeTaskAction(f.config, {command: 'watch-pr', operation: 'relay', ...watchRequest, noticeRef}),
        );
        const eventRefs = relayed.eventRefs;
        if (!EffectArray.isArray(eventRefs) || !eventRefs.length)
          throw new Error('Expected the queued historical event.');
        const watchDeliveryRef = String(relayed.watchDeliveryRef);
        const beforeNoticeReuse = yield* readNativeWatch(f.config, watchId);
        if (!beforeNoticeReuse) throw new Error('Expected the exact claimed notice delivery.');
        const beforeNoticeReuseBytes = yield* f.fs.readFileString(watchPath);
        const reusedNotice = yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'disposition',
          ...watchRequest,
          noticeRef,
          watchDeliveryRef,
          dispositions: [
            {
              eventRef: String(eventRefs[0]),
              status: 'blocked',
              reason: 'CI repair remains open.',
              evidence: 'Retained event proof.',
            },
          ],
        }).pipe(Effect.provideService(CommandExecutor, readOnlyCommands), Effect.result);
        expect(reusedNotice).toMatchObject({failure: {code: 'invalid-request'}});
        expect(effects).toEqual({provider: 0, host: 0, spawn: 0});
        expect(yield* f.fs.readFileString(watchPath)).toBe(beforeNoticeReuseBytes);
        const afterNoticeReuse = yield* readNativeWatch(f.config, watchId);
        expect(afterNoticeReuse?.revision).toBe(beforeNoticeReuse.revision);
        expect(afterNoticeReuse?.envelope.state.delivery).toEqual(beforeNoticeReuse.envelope.state.delivery);
        expect(afterNoticeReuse?.envelope.state.acknowledged).toBe(beforeNoticeReuse.envelope.state.acknowledged);
        expect(afterNoticeReuse?.envelope.notification?.outbox).toEqual(
          beforeNoticeReuse.envelope.notification?.outbox,
        );
        expect(yield* f.fs.readFileString(f.statePath())).toBe(maintenanceRunBytes);

        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'disposition',
          ...watchRequest,
          watchDeliveryRef,
          dispositions: [
            {
              eventRef: String(eventRefs[0]),
              status: 'blocked',
              reason: 'CI repair remains open.',
              evidence: 'Retained event proof.',
            },
          ],
        });
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'ack',
          ...watchRequest,
          watchDeliveryRef,
        });
        const beforeWorkRenew = yield* readNativeWatch(f.config, watchId);
        yield* renew({});
        expect((yield* readNativeWatch(f.config, watchId))?.envelope.state.work).toEqual(
          beforeWorkRenew?.envelope.state.work,
        );
        expect(watch.spawnCount()).toBe(2);
        const retainedWork = object(
          yield* runNativeTaskAction(f.config, {command: 'watch-pr', operation: 'work', ...watchRequest}),
        );
        const rows = object(object(retainedWork.result).work).items;
        if (!EffectArray.isArray(rows) || rows.length !== 1)
          throw new Error('Expected one retained historical work row.');
        const eventRef = String(object(rows[0]).eventRef);
        expect(
          object(
            yield* runNativeTaskAction(f.config, {
              command: 'watch-pr',
              operation: 'work-detail',
              ...watchRequest,
              workEventRef: eventRef,
              offsetBytes: 0,
            }),
          ),
        ).toMatchObject({status: 'watch-updated'});
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'work-disposition',
          ...watchRequest,
          dispositions: [
            {eventRef, status: 'resolved', reason: 'CI repair completed.', evidence: 'Owning check passed.'},
          ],
        });
        const maintained = yield* readNativeWatch(f.config, watch.watchId);
        expect(maintained?.envelope.state.consumer).toMatchObject({id: watch.consumerId, wakeupId: watch.wakeupId});
        expect(maintained?.envelope.state.events).toHaveLength(0);
        expect(maintained?.envelope.state.work[0]?.status).toBe('resolved');
        expect(yield* f.fs.readFileString(f.statePath())).toBe(maintenanceRunBytes);
        expect(
          object(yield* runNativeTaskAction(f.config, {command: 'watch-pr', operation: 'stop', ...watchRequest})),
        ).toMatchObject({status: 'watch-updated'});
        const stoppedBytes = yield* f.fs.readFileString(watchPath);
        expect(yield* renew({}).pipe(Effect.result)).toMatchObject({failure: {code: 'watch-stopped'}});
        expect(yield* f.fs.readFileString(watchPath)).toBe(stoppedBytes);
        expect(watch.hostPreflightCount()).toBe(1);
        expect(watch.spawnCount()).toBe(2);
        const removedBeforeLock = CommandExecutor.of({
          ...watch.commands,
          execute: (executable, args, options) =>
            executable === 'gh'
              ? f.fs
                  .remove(watchPath)
                  .pipe(Effect.orDie, Effect.andThen(watch.commands.execute(executable, args, options)))
              : watch.commands.execute(executable, args, options),
        });
        expect(
          yield* runNativeTaskAction(f.config, {command: 'watch-pr', operation: 'renew', ...watchRequest}).pipe(
            Effect.provideService(CommandExecutor, removedBeforeLock),
            Effect.provideService(SystemInfo, watch.system),
            Effect.result,
          ),
        ).toMatchObject({failure: {code: 'watch-not-found'}});
        expect(watch.spawnCount()).toBe(2);
        expect(yield* renew({}).pipe(Effect.result)).toMatchObject({failure: {code: 'watch-not-found'}});
        expect(
          yield* runNativeTaskAction(f.config, {command: 'watch-pr', operation: 'inspect', ...watchRequest}).pipe(
            Effect.result,
          ),
        ).toMatchObject({failure: {code: 'watch-not-found'}});
        expect(yield* f.fs.exists(watchPath)).toBe(false);
        if (!maintained) throw new Error('Expected the retained watch before terminal qualification.');
        yield* writeNativeWatch(
          f.config,
          {...maintained.envelope, state: {...maintained.envelope.state, prState: 'merged'}},
          null,
        );
        const terminalBytes = yield* f.fs.readFileString(watchPath);
        expect(object(yield* renew({})).status).toBe('terminal-empty');
        expect(yield* f.fs.readFileString(watchPath)).toBe(terminalBytes);
        expect(watch.hostPreflightCount()).toBe(1);
        expect(watch.spawnCount()).toBe(2);
        return;
      }
      const forgedStart = yield* attemptSimulatedTaskWatch(
        f,
        'native-run',
        'one',
        validationRef,
        forgedDeliveryRef,
        forgedDelivery.pr.url,
      );
      expect(forgedStart.result).toMatchObject({ok: false, failure: {code: 'base-ref-unverified'}});
      expect(forgedStart.collectorSpawns).toBe(0);
      expect(forgedStart.startedWatch).toBeUndefined();
      expect(yield* f.fs.exists(watchPath)).toBe(false);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeOpen);
      expect(
        yield* runNativeTaskAction(f.config, {
          command: 'finish',
          runId: 'native-run',
          callerCwd: f.repo,
          proposal,
        }).pipe(Effect.result),
      ).toMatchObject({failure: {code: 'finish-scope'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeOpen);

      yield* f.fs.writeFileString(
        f.path.join(f.repo, 'source.ts'),
        'export const fixture = "changed after validation";\n',
      );
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'Change after validation']);
      const beforeStale = yield* f.fs.readFileString(f.statePath());
      const stale = yield* runNativeTaskAction(f.config, {
        command: 'deliver-pr',
        runId: 'native-run',
        callerCwd: f.repo,
        validationRef,
        commitEvidence: 'Verified private fixture commit ' + headSha,
        pr: {...openPr, state: 'merged'},
        publication,
      }).pipe(Effect.result);
      expect(stale).toMatchObject({failure: {code: 'source-drift'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeStale);
      yield* f.git(['reset', '--hard', 'HEAD~1']);

      const mergedPr = {...openPr, state: 'merged' as const};
      const delivered = object(
        yield* runNativeTaskAction(f.config, {
          command: 'deliver-pr',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef,
          commitEvidence: 'Verified private fixture commit ' + headSha,
          pr: mergedPr,
          publication,
        }),
      );
      expect(delivered).toMatchObject({
        status: 'delivered',
        replayed: false,
        receipt: {delivery: 'pr', pr: mergedPr, publication},
      });
      const afterDelivery = yield* f.fs.readFileString(f.statePath());
      const replay = object(
        yield* runNativeTaskAction(f.config, {
          command: 'deliver-pr',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef: String(delivered.deliveryRef),
          commitEvidence: 'Verified private fixture commit ' + headSha,
          pr: mergedPr,
          publication,
        }),
      );
      expect(replay).toMatchObject({status: 'delivered', replayed: true, receipt: delivered.receipt});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(afterDelivery);
      const changedAuthority = yield* runNativeTaskAction(f.config, {
        command: 'deliver-pr',
        runId: 'native-run',
        callerCwd: f.repo,
        validationRef: String(delivered.deliveryRef),
        commitEvidence: 'Verified private fixture commit ' + headSha,
        pr: mergedPr,
        publication,
        userAuthority: 'A different user statement cannot replace retained delivery authority.',
      }).pipe(Effect.result);
      expect(changedAuthority).toMatchObject({failure: {code: 'delivery-conflict'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(afterDelivery);
    }).pipe(run);

  effectIt.effect('prepares and records only an exact approved PR receipt, returning a watch card for open PRs', () =>
    prReceiptCase(false),
  );

  effectIt.effect('maintains an existing PR watch through unvalidated CI source changes', () => prReceiptCase(true));

  effectIt.effect('delivers a PR whose commit carries a dirty-validated tree after a failed start record', () =>
    Effect.gen(function* () {
      const f = yield* fixture(['one'], 'pr', false, false, true, undefined, undefined, {}, {policy: 'standard'});
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "dirty validated";\n');
      const snapshotRef = String(
        object(
          yield* runNativeTaskAction(f.config, {
            command: 'record-snapshot',
            runId: 'native-run',
            callerCwd: f.repo,
          }),
        ).snapshotRef,
      );
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
      const validationRef = String(
        object(
          yield* runNativeTaskAction(f.config, {
            command: 'record-validation',
            runId: 'native-run',
            callerCwd: f.repo,
            snapshotRef,
            validation: {
              checks: [{command: 'private PR check', result: 'passed', evidence: 'The scoped test fixture passed.'}],
              acceptance: [
                {criterion: 'one works', result: 'passed', evidence: 'The implementation meets acceptance.'},
              ],
            },
          }),
        ).validationRef,
      );
      const validatedHead = (yield* readNativeWorkflowState(f.config, 'native-run'))?.state.cycle?.state.phases.one
        ?.head;
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'Commit the validated tree']);
      const headSha = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
      expect(headSha).not.toBe(validatedHead);
      // Recording the committed, unchanged tree does not reopen the validated phase.
      expect(
        object(
          yield* runNativeTaskAction(f.config, {
            command: 'record-snapshot',
            runId: 'native-run',
            callerCwd: f.repo,
          }),
        ),
      ).toMatchObject({status: 'unchanged', phaseId: 'one'});
      const pr = {
        url: 'https://github.com/example/repo/pull/5',
        headSha,
        branch: 'feature/one',
        baseBranch: 'main',
        state: 'open' as const,
      };
      const delivered = object(
        yield* runNativeTaskAction(f.config, {
          command: 'deliver-pr',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef,
          commitEvidence: `Private fixture commit ${headSha}`,
          pr,
          publication: {exemption: 'small-fix', reason: 'Private bounded fixture publication authority.'},
        }),
      );
      expect(delivered).toMatchObject({status: 'watch-required', next: {operation: 'start'}});
      const deliveryRef = String(delivered.deliveryRef);
      // The hint's own arguments plus a wakeup must be a valid task-bound start, not a standalone-mode mix.
      const {action: _action, expectedConsumer: _consumer, ...hintFields} = object(delivered.next);
      const source = f.path.join(f.repo, 'source.ts');
      // The source drifts after the watch starts, so the start cannot record the delivery.
      const watch = yield* attemptSimulatedTaskWatch(
        f,
        'native-run',
        'one',
        validationRef,
        deliveryRef,
        pr.url,
        undefined,
        f.fs.writeFileString(source, 'export const fixture = "drift";\n').pipe(Effect.orDie),
        hintFields,
      );
      expect(watch.result).toMatchObject({
        ok: true,
        value: {
          status: 'watching',
          hostReceipt: null,
          delivery: {recorded: false, code: 'source-drift'},
          next: {action: 'watch-pr', operation: 'complete', validationRef, deliveryRef},
        },
      });
      const route = {command: 'watch-pr', runId: 'native-run', callerCwd: f.repo, validationRef, deliveryRef};
      // The running watch stays usable with the start refs before its delivery is recorded.
      expect(object(yield* runNativeTaskAction(f.config, {...route, operation: 'inspect'}))).toMatchObject({
        status: 'watch-updated',
      });
      yield* f.git(['checkout', '--', 'source.ts']);
      const completed = object(yield* runNativeTaskAction(f.config, {...route, operation: 'complete'}));
      expect(completed).toMatchObject({status: 'delivered', replayed: false, receipt: {headSha, pr: {headSha}}});
      const phase = (yield* readNativeWorkflowState(f.config, 'native-run'))?.state.cycle?.state.phases.one;
      expect(phase).toMatchObject({status: 'published', head: headSha, delivery: {headSha, watch: {state: 'active'}}});
      expect(phase?.delivery?.watch?.evidence).toContain(`consumer:${watch.consumerId}`);
      // The validation reference from before the commit still routes the recorded watch.
      expect(
        object(
          yield* runNativeTaskAction(f.config, {
            ...route,
            operation: 'inspect',
            deliveryRef: String(completed.deliveryRef),
          }),
        ),
      ).toMatchObject({status: 'watch-updated'});
    }).pipe(run),
  );

  effectIt.effect('refuses provisional watches for a local plan or a phase without validation', () =>
    Effect.gen(function* () {
      for (const scenario of [
        {delivery: 'local' as const, reviewed: true, code: 'delivery-scope'},
        {delivery: 'pr' as const, reviewed: false},
      ]) {
        const f = yield* fixture(['one'], scenario.delivery);
        yield* f.mutate('begin-phase', {phaseId: 'one'});
        const work = object(
          yield* runNativeTaskAction(f.config, {command: 'work', runId: 'native-run', callerCwd: f.repo, packet}),
        );
        yield* f.fs.writeFileString(
          f.path.join(f.repo, 'source.ts'),
          `export const fixture = "${scenario.delivery}";\n`,
        );
        yield* f.git(['add', 'source.ts']);
        yield* f.git(['commit', '-m', `${scenario.delivery} provisional watch fixture`]);
        const snapshot = object(
          yield* runNativeTaskAction(f.config, {
            command: 'record-snapshot',
            runId: 'native-run',
            callerCwd: f.repo,
            workRef: String(work.workRef),
          }),
        );
        const snapshotRef = String(snapshot.snapshotRef);
        let validationRef: string;
        if (scenario.reviewed) {
          const report = {
            mode: 'full',
            selected: ['correctness', 'simplicity'],
            lanes: [
              {name: 'correctness', status: 'complete'},
              {name: 'simplicity', status: 'complete'},
            ],
            findings: [],
          };
          yield* runNativeTaskAction(f.config, {
            command: 'record-review',
            runId: 'native-run',
            callerCwd: f.repo,
            snapshotRef,
            report,
          });
          const validation = object(
            yield* runNativeTaskAction(f.config, {
              command: 'record-validation',
              runId: 'native-run',
              callerCwd: f.repo,
              snapshotRef,
              validation: {
                checks: [{command: 'fixture check', result: 'passed', evidence: 'Private test evidence.'}],
                acceptance: [{criterion: 'one works', result: 'passed', evidence: 'Committed fixture source.'}],
              },
            }),
          );
          validationRef = String(validation.validationRef);
        } else {
          const snapshotAction = decodeNativeTaskActionRef(snapshotRef);
          if (!snapshotAction) throw new Error('Expected the pre-validation snapshot reference.');
          validationRef = encodeNativeTaskActionRef({
            ...snapshotAction,
            kind: 'validation',
            payloadDigest: sha256HexSync('forged missing validation'),
          });
        }
        const validationAction = decodeNativeTaskActionRef(validationRef);
        if (!validationAction?.sourceHead || !validationAction.sourceTree || !validationAction.phaseHash)
          throw new Error('Expected the task reference to bind the fixture source.');
        const delivery = {
          phaseId: 'one',
          phaseHash: validationAction.phaseHash,
          delivery: 'pr' as const,
          headSha: validationAction.sourceHead,
          validatedTree: validationAction.sourceTree,
          commitEvidence: 'Private fixture commit.',
          pr: {
            url: 'https://github.com/example/repo/pull/88',
            headSha: validationAction.sourceHead,
            branch: 'feature/one',
            baseBranch: 'main',
            state: 'open' as const,
          },
          publication: {exemption: 'small-fix' as const, reason: 'Private fixture authority.'},
        };
        const deliveryRef = encodeNativeTaskActionRef({
          ...validationAction,
          kind: 'delivery',
          delivery,
          payloadDigest: sha256HexSync(stableJson(delivery)),
        });
        const before = yield* f.fs.readFileString(f.statePath());
        if (!scenario.reviewed) {
          const unvalidated = (yield* readNativeWorkflowState(f.config, 'native-run'))?.state.cycle?.state.phases.one;
          expect(unvalidated?.validation).toBeUndefined();
        }
        const attempt = yield* attemptSimulatedTaskWatch(
          f,
          'native-run',
          'one',
          validationRef,
          deliveryRef,
          delivery.pr.url,
        );
        expect(attempt.result.ok, `${scenario.delivery} reviewed=${scenario.reviewed}`).toBe(false);
        if (!attempt.result.ok && 'code' in scenario)
          expect(attempt.result.failure).toMatchObject({code: scenario.code});
        expect(attempt.collectorSpawns).toBe(0);
        expect(attempt.startedWatch).toBeUndefined();
        expect(
          yield* f.fs.exists(
            f.path.join(
              f.config.agentContextHome,
              'workflow-automations',
              'native-watch-v1',
              attempt.watchId + '.json',
            ),
          ),
        ).toBe(false);
        expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
      }
    }).pipe(run),
  );

  effectIt.effect('delivers each dependent PR phase from its exact validation reference', () =>
    Effect.gen(function* () {
      const f = yield* fixture(['one', 'two'], 'pr');
      const deliverPhase = (phaseId: 'one' | 'two', branch: string, baseBranch: string) =>
        Effect.gen(function* () {
          yield* f.mutate('begin-phase', {phaseId});
          const work = object(
            yield* runNativeTaskAction(f.config, {
              command: 'work',
              runId: 'native-run',
              callerCwd: f.repo,
              packet,
            }),
          );
          yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), `export const fixture = "phase ${phaseId}";\n`);
          yield* f.git(['add', 'source.ts']);
          yield* f.git(['commit', '-m', `Phase ${phaseId}`]);
          const snapshot = object(
            yield* runNativeTaskAction(f.config, {
              command: 'record-snapshot',
              runId: 'native-run',
              callerCwd: f.repo,
              workRef: String(work.workRef),
            }),
          );
          const snapshotRef = String(snapshot.snapshotRef);
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
          const validation = object(
            yield* runNativeTaskAction(f.config, {
              command: 'record-validation',
              runId: 'native-run',
              callerCwd: f.repo,
              snapshotRef,
              validation: {
                checks: [{command: `phase ${phaseId} check`, result: 'passed', evidence: 'Private fixture passed.'}],
                acceptance: [
                  {criterion: `${phaseId} works`, result: 'passed', evidence: `Phase ${phaseId} source is committed.`},
                ],
              },
            }),
          );
          const headSha = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
          const deliveryRequest = {
            command: 'deliver-pr' as const,
            runId: 'native-run',
            callerCwd: f.repo,
            validationRef: String(validation.validationRef),
            commitEvidence: `Private fixture commit ${headSha}`,
            pr: {
              url: `https://github.com/example/repo/pull/${phaseId === 'one' ? '11' : '12'}`,
              headSha,
              branch,
              baseBranch,
              state: 'merged' as const,
            },
            publication: {exemption: 'small-fix' as const, reason: `Private ${phaseId} phase authority input.`},
          };
          const delivered = object(yield* runNativeTaskAction(f.config, deliveryRequest));
          const beforeReplay = yield* f.fs.readFileString(f.statePath());
          const replay = object(yield* runNativeTaskAction(f.config, deliveryRequest));
          expect(replay).toMatchObject({status: 'delivered', replayed: true, receipt: delivered.receipt});
          // A replay that omits publication keeps the stored receipt's publication.
          const {publication: _publication, ...withoutPublication} = deliveryRequest;
          expect(object(yield* runNativeTaskAction(f.config, withoutPublication))).toEqual(replay);
          expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeReplay);
          return {deliveryRequest, delivered};
        });

      const first = yield* deliverPhase('one', 'feature/one', 'main');
      expect(first.delivered).toMatchObject({status: 'delivered', receipt: {phaseId: 'one', pr: {state: 'merged'}}});
      yield* f.git(['checkout', '-b', 'feature/two']);
      yield* f.mutate('begin-phase', {phaseId: 'two'});
      const second = yield* deliverPhase('two', 'feature/two', 'feature/one');
      expect(second.delivered).toMatchObject({status: 'delivered', receipt: {phaseId: 'two', pr: {state: 'merged'}}});
      const beforeHistoricalReplay = yield* f.fs.readFileString(f.statePath());
      const historicalReplay = object(yield* runNativeTaskAction(f.config, first.deliveryRequest));
      expect(historicalReplay).toMatchObject({status: 'delivered', replayed: true, receipt: first.delivered.receipt});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeHistoricalReplay);
      const stored = yield* readNativeWorkflowState(f.config, 'native-run');
      expect(stored?.state.cycle?.state.phases.one?.delivery?.phaseId).toBe('one');
      expect(stored?.state.cycle?.state.phases.two?.delivery?.phaseId).toBe('two');
      const beforeBlockedCloseout = yield* f.fs.readFileString(f.statePath());
      const missingWatch = yield* runNativeTaskAction(f.config, {
        command: 'finish',
        runId: 'native-run',
        callerCwd: f.repo,
        proposal,
      }).pipe(Effect.result);
      expect(missingWatch).toMatchObject({failure: {code: 'finish-scope'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeBlockedCloseout);
    }).pipe(run),
  );

  effectIt.effect('delivers and watches a PR phase without publication evidence after acceptance by ID', () =>
    Effect.gen(function* () {
      const f = yield* fixture(['one'], 'pr');
      yield* f.mutate('begin-phase', {phaseId: 'one'});
      const work = object(
        yield* runNativeTaskAction(f.config, {command: 'work', runId: 'native-run', callerCwd: f.repo, packet}),
      );
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "no publication";\n');
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'Phase one']);
      const snapshot = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-snapshot',
          runId: 'native-run',
          callerCwd: f.repo,
          workRef: String(work.workRef),
        }),
      );
      const snapshotRef = String(snapshot.snapshotRef);
      // Omitted lanes record every selected lane as complete.
      expect(
        yield* runNativeTaskAction(f.config, {
          command: 'record-review',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef,
          report: {mode: 'full', selected: ['correctness', 'simplicity'], findings: []},
        }),
      ).toMatchObject({status: 'recorded'});
      const validation = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-validation',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef,
          validation: {
            checks: [{command: 'phase one check', result: 'passed', evidence: 'Private fixture passed.'}],
            acceptance: [{id: 'accept-one', result: 'passed', evidence: 'Phase one source is committed.'}],
          },
        }),
      );
      expect(validation).toMatchObject({validation: {acceptance: [{criterion: 'one works'}]}});
      const headSha = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
      const pr = {
        url: 'https://github.com/example/repo/pull/41',
        headSha,
        branch: 'feature/one',
        baseBranch: 'main',
        state: 'open' as const,
      };
      const deliveryRequest = {
        command: 'deliver-pr',
        runId: 'native-run',
        callerCwd: f.repo,
        validationRef: String(validation.validationRef),
        commitEvidence: `Private fixture commit ${headSha}`,
        pr,
      };
      // A supplied publication is still checked against the exact source head.
      const beforeStale = yield* f.fs.readFileString(f.statePath());
      const stalePublication = {
        state: 'published',
        team: 'default',
        uri: 'threadnote://default/memories/shared/default/feature',
        revision: EffectString.repeat(64)('a'),
        currentHead: EffectString.repeat(40)('f'),
        remoteCommit: EffectString.repeat(40)('f'),
        evidence: 'Private stale publication receipt.',
      };
      expect(
        yield* runNativeTaskAction(f.config, {...deliveryRequest, publication: stalePublication}).pipe(Effect.result),
      ).toMatchObject({failure: {code: 'invalid-cycle-packet'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeStale);
      const delivered = object(yield* runNativeTaskAction(f.config, deliveryRequest));
      expect(delivered).toMatchObject({status: 'watch-required', next: {action: 'watch-pr'}});
      const watch = yield* startSimulatedTaskWatch(
        f,
        'native-run',
        'one',
        String(validation.validationRef),
        String(delivered.deliveryRef),
        pr.url,
      );
      expect(watch.result).toMatchObject({ok: true, value: {receipt: {pr, watch: {state: 'active'}}}});
      const receipt = (yield* readNativeWorkflowState(f.config, 'native-run'))?.state.cycle?.state.phases.one?.delivery;
      expect(receipt).toMatchObject({delivery: 'pr', pr: {state: 'open'}});
      expect(receipt).not.toHaveProperty('publication');
    }).pipe(run),
  );

  effectIt.effect(
    'stales a task page when an earlier historical watch loses eligibility without a run revision change',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(
          ['one', 'two', 'three'],
          'pr',
          false,
          false,
          true,
          {
            one: {branch: 'feature/one', baseBranch: 'origin/main'},
            two: {branch: 'feature/two', baseBranch: 'feature/one'},
            three: {branch: 'feature/three', baseBranch: 'feature/two'},
          },
          repo =>
            Effect.gen(function* () {
              yield* runCommandEffect('git', [
                '-C',
                repo,
                'remote',
                'add',
                'origin',
                'https://github.com/example/repo.git',
              ]);
              yield* runCommandEffect('git', ['-C', repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD']);
            }),
          {three: Array.from({length: 20}, (_, index) => `scope/${index}.ts`)},
          {},
        );

        const p1 = yield* publishOpenHistoricalPhase(f, 'one', 'origin/main', 31);
        yield* f.git(['checkout', '-b', 'feature/two']);
        yield* f.mutate('begin-phase', {phaseId: 'two'});
        const p2 = yield* publishOpenHistoricalPhase(f, 'two', 'feature/one', 32, false);
        yield* f.git(['checkout', '-b', 'feature/three']);
        yield* f.mutate('begin-phase', {phaseId: 'three'});

        const pageOne = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
        expect(EffectArray.map(pageOne.historicalWatches ?? [], item => item.phaseId)).toEqual(['one', 'two']);
        expect(pageOne.page.nextCursor).toBeDefined();
        expect(pageOne.page.limit).toBe(16);
        const beforeRevision = (yield* readNativeWorkflowState(f.config, 'native-run'))?.revision;
        const beforeState = yield* f.fs.readFileString(f.statePath());
        const earlierWatch = yield* readNativeWatch(f.config, p1.watchId);
        if (!earlierWatch?.envelope.collector) throw new Error('Expected the P1 active collector readback.');

        yield* writeNativeWatch(
          f.config,
          {
            ...earlierWatch.envelope,
            stopRequested: true,
            collector: {
              ...earlierWatch.envelope.collector,
              status: 'stopped',
              reason: 'fixture-eligibility-change',
            },
          },
          earlierWatch.revision,
        );
        expect((yield* readNativeWorkflowState(f.config, 'native-run'))?.revision).toBe(beforeRevision);
        expect((yield* readNativeWatch(f.config, p2.watchId))?.envelope.collector?.status).toBe('running');

        const continuation = yield* readNativeTaskView(f.config, {
          runId: 'native-run',
          callerCwd: f.repo,
          cursor: pageOne.page.nextCursor!,
        }).pipe(Effect.result);
        expect(continuation).toMatchObject({failure: {code: 'stale-cursor'}});
        const refreshed = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
        expect(EffectArray.map(refreshed.historicalWatches ?? [], item => item.phaseId)).toEqual(['two']);
        expect(refreshed.revision).toBe(beforeRevision);
        expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeState);
      }).pipe(run),
  );

  effectIt.effect('routes a stale accepted review to fresh work while retaining current validation and delivery', () =>
    Effect.gen(function* () {
      const f = yield* fixture(['one'], 'local');
      yield* f.mutate('begin-phase', {phaseId: 'one'});
      const firstWork = object(
        yield* runNativeTaskAction(f.config, {
          command: 'work',
          runId: 'native-run',
          callerCwd: f.repo,
          packet,
        }),
      );
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "first result";\n');
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'First result']);
      const first = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-snapshot',
          runId: 'native-run',
          callerCwd: f.repo,
          workRef: String(firstWork.workRef),
        }),
      );
      const report = {
        mode: 'full',
        selected: ['correctness', 'simplicity'],
        lanes: [
          {name: 'correctness', status: 'complete'},
          {name: 'simplicity', status: 'complete'},
        ],
        findings: [],
      };
      const firstReview = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-review',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef: String(first.snapshotRef),
          report,
        }),
      );
      expect(firstReview.status).toBe('recorded');
      const card = () => readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
      expect(yield* card()).toMatchObject({
        next: {action: 'validate', snapshotId: object(object(first.snapshot).snapshot).snapshotId},
      });
      yield* f.git(['commit', '--allow-empty', '-m', 'Same tree']);
      expect(yield* card()).toMatchObject({next: {action: 'validate'}});
      const originalBase = EffectString.trim((yield* f.git(['rev-parse', 'main'])).stdout);
      const advancedBase = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
      yield* f.git(['update-ref', 'refs/heads/main', advancedBase]);
      expect(yield* card()).toMatchObject({status: 'ready', next: {action: 'implement', phaseId: 'one'}});
      yield* f.git(['update-ref', 'refs/heads/main', originalBase]);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "revised result";\n');
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'Revised result']);
      expect(yield* card()).toMatchObject({status: 'ready', next: {action: 'implement', phaseId: 'one'}});
      const reindexed = yield* (yield* CodeGraphIndexer).index({cwd: f.repo, threadnoteHome: f.home});
      expect(reindexed.snapshot.state).toBe('ready');
      const nextWork = object(
        yield* runNativeTaskAction(f.config, {
          command: 'work',
          runId: 'native-run',
          callerCwd: f.repo,
          packet,
        }),
      );
      expect(nextWork.workRef).not.toBe(firstWork.workRef);
      const nextSnapshot = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-snapshot',
          runId: 'native-run',
          callerCwd: f.repo,
          workRef: String(nextWork.workRef),
          reason: 'The committed implementation changed after the first accepted review.',
        }),
      );
      expect(nextSnapshot).toMatchObject({status: 'recorded', replayed: false});
      const nextReview = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-review',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef: String(nextSnapshot.snapshotRef),
          report: {...report, mode: 'incremental'},
        }),
      );
      expect(nextReview.status).toBe('recorded');
      expect(yield* card()).toMatchObject({next: {action: 'validate'}});
      const validated = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-validation',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef: String(nextReview.snapshotRef),
          validation: {
            checks: [{command: 'focused fixture check', result: 'passed', evidence: 'The revised source passed.'}],
            acceptance: [{criterion: 'one works', result: 'passed', evidence: 'The revised source works.'}],
          },
        }),
      );
      expect(validated.status).toBe('recorded');
      expect(yield* card()).toMatchObject({next: {action: 'deliver', phaseId: 'one'}});
    }).pipe(run),
  );

  // prettier-ignore
  effectIt.effect('continues a nonterminal P1 watch after P2 advances and closes out both terminal receipts', () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        ['one', 'two'],
        'pr',
        false,
        false,
        true,
        {
          one: {branch: 'feature/one', baseBranch: 'origin/main'},
          two: {branch: 'feature/two', baseBranch: 'feature/one'},
        },
        repo =>
          Effect.gen(function* () {
            yield* runCommandEffect('git', [
              '-C',
              repo,
              'remote',
              'add',
              'origin',
              'https://github.com/example/repo.git',
            ]);
            yield* runCommandEffect('git', ['-C', repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD']);
          }),
      );
      const prepareOpenPr = (phaseId: 'one' | 'two') =>
        Effect.gen(function* () {
          yield* f.mutate('begin-phase', {phaseId});
          const work = object(
            yield* runNativeTaskAction(f.config, {
              command: 'work',
              runId: 'native-run',
              callerCwd: f.repo,
              packet,
            }),
          );
          return {workRef: String(work.workRef)};
        });
      const commitPhase = (phaseId: 'one' | 'two', workRef: string) =>
        Effect.gen(function* () {
          yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), `export const fixture = "phase ${phaseId}";\n`);
          yield* f.git(['add', 'source.ts']);
          yield* f.git(['commit', '-m', `Phase ${phaseId}`]);
          const snapshot = object(
            yield* runNativeTaskAction(f.config, {
              command: 'record-snapshot',
              runId: 'native-run',
              callerCwd: f.repo,
              workRef,
            }),
          );
          const snapshotRef = String(snapshot.snapshotRef);
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
          if (phaseId === 'one') yield* f.git(['commit', '--allow-empty', '-m', 'Same-tree P1 build marker']);
          const validation = object(
            yield* runNativeTaskAction(f.config, {
              command: 'record-validation',
              runId: 'native-run',
              callerCwd: f.repo,
              snapshotRef,
              validation: {
                checks: [
                  {command: `phase ${phaseId} check`, result: 'passed', evidence: 'Private simulated check passed.'},
                ],
                acceptance: [
                  {criterion: `${phaseId} works`, result: 'passed', evidence: `Phase ${phaseId} source is committed.`},
                ],
              },
            }),
          );
          const headSha = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
          const pr = {
            url: `https://github.com/example/repo/pull/${phaseId === 'one' ? '21' : '22'}`,
            headSha,
            branch: phaseId === 'one' ? 'feature/one' : 'feature/two',
            baseBranch: phaseId === 'one' ? 'main' : 'feature/one',
            state: 'open' as const,
          };
          const publication = {exemption: 'small-fix' as const, reason: `Private ${phaseId} simulated authority.`};
          const delivered = object(
            yield* runNativeTaskAction(f.config, {
              command: 'deliver-pr',
              runId: 'native-run',
              callerCwd: f.repo,
              validationRef: String(validation.validationRef),
              commitEvidence: `Private simulated commit ${headSha}`,
              pr,
              publication,
            }),
          );
          expect(delivered).toMatchObject({status: 'watch-required', next: {action: 'watch-pr'}});
          return {
            validationRef: String(validation.validationRef),
            deliveryRef: String(delivered.deliveryRef),
            headSha,
            pr,
            publication,
          };
        });

      const p1Work = yield* prepareOpenPr('one');
      const publishedP1 = yield* commitPhase('one', p1Work.workRef);
      const p1Watch = yield* startSimulatedTaskWatch(
        f,
        'native-run',
        'one',
        publishedP1.validationRef,
        publishedP1.deliveryRef,
        publishedP1.pr.url,
      );
      // A started watch records the open PR delivery at once, so P2 can begin without a PR event.
      expect(p1Watch.result).toMatchObject({
        ok: true,
        value: {
          status: 'watching',
          receipt: {pr: {...publishedP1.pr, state: 'open'}, watch: {state: 'active'}},
          next: {action: 'implement', phaseId: 'two'},
        },
      });
      yield* writeSimulatedTaskWatch(f, p1Watch.startedWatch, p1Watch, publishedP1.pr.url, publishedP1.headSha, false);
      const provisionalWatchPath = f.path.join(
        f.config.agentContextHome,
        'workflow-automations',
        'native-watch-v1',
        p1Watch.watchId + '.json',
      );
      const provisionalWatchBytes = yield* f.fs.readFileString(provisionalWatchPath);
      const provisionalWorkflowBytes = yield* f.fs.readFileString(f.statePath());
      const originalSource = yield* f.fs.readFileString(f.path.join(f.repo, 'source.ts'));
      yield* f.fs.writeFileString(
        f.path.join(f.repo, 'source.ts'),
        `${originalSource}\n// provisional source was revoked before canonical delivery\n`,
      );
      const refusedProvisionalStart = yield* attemptSimulatedTaskWatch(f, 'native-run', 'one', publishedP1.validationRef, publishedP1.deliveryRef, publishedP1.pr.url);
      expect(refusedProvisionalStart.result).toMatchObject({ok: false, failure: {code: 'source-drift'}});
      // The start recorded the open PR delivery, so complete only reads back that receipt.
      expect(object(yield* runNativeTaskAction(f.config, {command: 'watch-pr', operation: 'complete', runId: 'native-run', callerCwd: f.repo,
        validationRef: publishedP1.validationRef, deliveryRef: publishedP1.deliveryRef}))).toMatchObject({status: 'delivered', replayed: true});
      expect(object(yield* runNativeTaskAction(f.config, {command: 'watch-pr', operation: 'inspect', runId: 'native-run', callerCwd: f.repo,
        validationRef: publishedP1.validationRef, deliveryRef: publishedP1.deliveryRef}))).toMatchObject({status: 'watch-updated'});
      expect(yield* f.fs.readFileString(provisionalWatchPath)).toBe(provisionalWatchBytes);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(provisionalWorkflowBytes);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), originalSource);
      const p1Open = object(
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'complete',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef: publishedP1.validationRef,
          deliveryRef: publishedP1.deliveryRef,
        }),
      );
      expect(p1Open).toMatchObject({
        status: 'delivered',
        receipt: {pr: {...publishedP1.pr, state: 'open'}, watch: {state: 'active'}},
      });
      const p1Published = yield* readNativeWorkflowState(f.config, 'native-run');
      expect(p1Published?.state.cycle?.state.phases.one).toMatchObject({
        status: 'published',
        delivery: {pr: {state: 'open'}},
      });
      expect(yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo})).toMatchObject({
        status: 'ready',
        next: {action: 'implement', phaseId: 'two'},
        historicalWatches: [{phaseId: 'one', prUrl: publishedP1.pr.url}],
      });
      const p1 = {headSha: publishedP1.headSha, pr: publishedP1.pr};

      yield* f.git(['checkout', '-b', 'feature/two']);
      yield* f.mutate('begin-phase', {phaseId: 'two'});
      yield* f.fs.writeFileString(
        f.path.join(f.repo, 'source.ts'),
        'export const fixture = "phase two source changed";\n',
      );
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'P2 source change']);
      const p2Head = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
      expect(p2Head).not.toBe(p1.headSha);

      // New resume scope: only the run/caller are known; discover P1 and its refs through typed views.
      let recoveredP1 = yield* recoverHistoricalTaskWatch(f, 'native-run');
      expect(recoveredP1.phaseId).toBe('one');
      const p1WatchPath = f.path.join(
        f.config.agentContextHome,
        'workflow-automations',
        'native-watch-v1',
        recoveredP1.watchId + '.json',
      );
      const beforeWrongPhase = yield* f.fs.readFileString(p1WatchPath);
      const beforeBadSelection = yield* f.fs.readFileString(f.statePath());
      const unknownPhase = yield* readNativeTaskView(f.config, {
        runId: 'native-run',
        callerCwd: f.repo,
        phaseId: 'unknown-phase',
      }).pipe(Effect.result);
      expect(unknownPhase).toMatchObject({failure: {code: 'historical-phase-not-found'}});
      const currentPhaseSelection = yield* readNativeTaskView(f.config, {
        runId: 'native-run',
        callerCwd: f.repo,
        phaseId: 'two',
      }).pipe(Effect.result);
      expect(currentPhaseSelection).toMatchObject({failure: {code: 'historical-phase-not-listed'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeBadSelection);
      expect(yield* f.fs.readFileString(p1WatchPath)).toBe(beforeWrongPhase);
      const decodedP1Validation = decodeNativeTaskActionRef(recoveredP1.validationRef);
      if (!decodedP1Validation) throw new Error('Expected the recovered exact P1 validation reference.');
      const wrongPhase = yield* runNativeTaskAction(f.config, {
        command: 'watch-pr',
        operation: 'relay',
        noticeRef: recoveredP1.noticeRef,
        runId: 'native-run',
        callerCwd: f.repo,
        validationRef: encodeNativeTaskActionRef({
          ...decodedP1Validation,
          phaseId: 'two',
        }),
        deliveryRef: recoveredP1.deliveryRef,
      }).pipe(Effect.result);
      expect(wrongPhase._tag).toBe('Failure');
      expect(
        yield* f.fs.readFileString(
          f.path.join(
            f.config.agentContextHome,
            'workflow-automations',
            'native-watch-v1',
            recoveredP1.watchId + '.json',
          ),
        ),
      ).toBe(beforeWrongPhase);
      const noticeRef = decodeNativeTaskActionRef(recoveredP1.noticeRef);
      if (!noticeRef) throw new Error('Expected the exact recovered P1 notice reference.');
      const foreignConsumer = yield* runNativeTaskAction(f.config, {
        command: 'watch-pr',
        operation: 'relay',
        noticeRef: encodeNativeTaskActionRef({...noticeRef, consumerId: noticeRef.consumerId + '-foreign'}),
        runId: 'native-run',
        callerCwd: f.repo,
        validationRef: recoveredP1.validationRef,
        deliveryRef: recoveredP1.deliveryRef,
      }).pipe(Effect.result);
      expect(foreignConsumer).toMatchObject({failure: {code: 'foreign-notice-route'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeBadSelection);
      expect(yield* f.fs.readFileString(p1WatchPath)).toBe(beforeWrongPhase);

      const relayed = object(
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'relay',
          noticeRef: recoveredP1.noticeRef,
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef: recoveredP1.validationRef,
          deliveryRef: recoveredP1.deliveryRef,
        }),
      );
      expect(relayed).toMatchObject({status: 'watch-updated'});
      const eventRefs: unknown[] = EffectArray.isArray(relayed.eventRefs) ? relayed.eventRefs : [];
      if (typeof eventRefs[0] !== 'string') throw new Error('Expected the historical P1 event reference.');
      const p1WatchDeliveryRef = String(relayed.watchDeliveryRef);
      yield* runNativeTaskAction(f.config, {
        command: 'watch-pr',
        operation: 'disposition',
        watchDeliveryRef: p1WatchDeliveryRef,
        dispositions: [
          {
            eventRef: eventRefs[0],
            status: 'open',
            reason: 'P1 review follow-up remains open.',
            evidence: 'Explicit synthetic watch event disposition.',
          },
        ],
        runId: 'native-run',
        callerCwd: f.repo,
        validationRef: recoveredP1.validationRef,
        deliveryRef: recoveredP1.deliveryRef,
      });
      yield* runNativeTaskAction(f.config, {
        command: 'watch-pr',
        operation: 'ack',
        watchDeliveryRef: p1WatchDeliveryRef,
        runId: 'native-run',
        callerCwd: f.repo,
        validationRef: recoveredP1.validationRef,
        deliveryRef: recoveredP1.deliveryRef,
      });
      const p1AfterAck = yield* readNativeWatch(f.config, recoveredP1.watchId);
      if (!p1AfterAck) throw new Error('Expected the historical P1 watch readback.');
      const p1Collector = p1AfterAck.envelope.collector;
      if (!p1Collector) throw new Error('Expected the P1 collector terminal record.');
      const p1Terminal = {
        ...p1AfterAck.envelope,
        state: {...p1AfterAck.envelope.state, prState: 'merged' as const},
        collector: {...p1Collector, status: 'terminal' as const, reason: 'merged' as const},
      };
      yield* writeNativeWatch(f.config, p1Terminal, p1AfterAck.revision);
      const p1TerminalReadback = yield* readNativeWatch(f.config, recoveredP1.watchId);
      if (!p1TerminalReadback) throw new Error('Expected the terminal P1 watch readback for join checks.');
      const freshTerminalView = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
      expect(freshTerminalView).toMatchObject({
        status: 'ready',
        next: {action: 'implement', phaseId: 'two'},
        historicalWatches: [{phaseId: 'one', prUrl: publishedP1.pr.url}],
      });
      // Resume from only the run and caller after the collector is terminal; task-view must keep
      // exposing the still-published canonical P1 continuation until native completion is recorded.
      recoveredP1 = yield* recoverHistoricalTaskWatch(f, 'native-run');
      expect(recoveredP1.phaseId).toBe('one');
      const refuseHistoricalCompletion = (label: string, code: string) =>
        Effect.gen(function* () {
          const workflowBytes = yield* f.fs.readFileString(f.statePath());
          const watchBytes = yield* f.fs.readFileString(p1WatchPath);
          const result = yield* runNativeTaskAction(f.config, {
            command: 'watch-pr',
            operation: 'complete',
            runId: 'native-run',
            callerCwd: f.repo,
            validationRef: recoveredP1.validationRef,
            deliveryRef: recoveredP1.deliveryRef,
          }).pipe(Effect.result);
          expect(result, label).toMatchObject({failure: {code}});
          expect(yield* f.fs.readFileString(f.statePath())).toBe(workflowBytes);
          expect(yield* f.fs.readFileString(p1WatchPath)).toBe(watchBytes);
        });

      const p1ProofBeforeMerge = (yield* readNativeWorkflowState(f.config, 'native-run'))?.state.cycle?.state.phases
        .one;
      if (p1ProofBeforeMerge?.delivery?.delivery !== 'pr' || !p1ProofBeforeMerge.delivery.pr)
        throw new Error('Expected the canonical open P1 PR receipt before historical completion.');
      const p1CanonicalBaseBinding = p1ProofBeforeMerge.delivery.pr.baseRefBinding;
      expect(p1CanonicalBaseBinding).toMatchObject({
        ref: 'refs/remotes/origin/main',
        remote: 'origin',
        repository: 'https://github.com/example/repo',
      });

      const p1Tree = EffectString.trim((yield* f.git(['rev-parse', p1.headSha + '^{tree}'])).stdout);
      const sameTreeCommit = EffectString.trim(
        (yield* f.git(['commit-tree', p1Tree, '-p', p1.headSha, '-m', 'P1 same-tree identity fixture'])).stdout,
      );
      const historicalBranchMismatches = [
        {name: 'old branch commit changed with its reviewed tree retained', head: sameTreeCommit},
        {name: 'old branch commit and reviewed tree both changed', head: p2Head},
      ];
      for (const mismatch of historicalBranchMismatches) {
        yield* f.git(['update-ref', 'refs/heads/feature/one', mismatch.head, p1.headSha]);
        yield* refuseHistoricalCompletion(mismatch.name, 'source-drift');
        yield* f.git(['update-ref', 'refs/heads/feature/one', p1.headSha, mismatch.head]);
      }

      yield* f.git(['remote', 'set-url', 'origin', 'https://github.com/example/other-repo.git']);
      yield* refuseHistoricalCompletion('canonical base repository mismatch', 'base-ref-unverified');
      yield* f.git(['remote', 'set-url', 'origin', 'https://github.com/example/repo.git']);

      const terminalEnvelope = p1TerminalReadback.envelope;
      const terminalConsumer = terminalEnvelope.state.consumer;
      const terminalNotification = terminalEnvelope.notification;
      if (!terminalConsumer || !terminalNotification)
        throw new Error('Expected P1 terminal consumer and host notification evidence.');
      const noHostReceipt = {
        ...terminalEnvelope,
        notification: {
          ...(({lastReceipt: _lastReceipt, ...rest}) => rest)(terminalNotification),
          outbox: null,
        },
      };
      const incompleteSources = {
        ...terminalEnvelope,
        state: {
          ...terminalEnvelope.state,
          sources: EffectArray.map(terminalEnvelope.state.sources, source => {
            if (source.source !== 'statuses') return source;
            const {lastCompleteAt: _lastCompleteAt, ...incomplete} = source;
            return incomplete;
          }),
        },
      };
      const watchJoinMismatches = [
        {name: 'missing host receipt', envelope: noHostReceipt, code: 'watch-not-ready'},
        {name: 'incomplete historical watch sources', envelope: incompleteSources, code: 'watch-not-ready'},
      ];
      for (const mismatch of watchJoinMismatches) {
        const currentWatch = yield* readNativeWatch(f.config, recoveredP1.watchId);
        if (!currentWatch) throw new Error('Expected P1 watch before a table-driven identity mismatch.');
        const altered = yield* writeNativeWatch(f.config, mismatch.envelope, currentWatch.revision);
        yield* refuseHistoricalCompletion(mismatch.name, mismatch.code);
        const afterRefusal = yield* readNativeWatch(f.config, recoveredP1.watchId);
        if (!afterRefusal) throw new Error('Expected P1 watch after a rejected identity mismatch.');
        yield* writeNativeWatch(f.config, currentWatch.envelope, afterRefusal.revision);
        expect(altered.revision).not.toBe(currentWatch.revision);
      }

      // A legitimate base advancement after P1 merges preserves the canonical ref/repository binding.
      yield* f.git(['update-ref', 'refs/remotes/origin/main', p1.headSha]);
      const p1Merged = object(
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'complete',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef: recoveredP1.validationRef,
          deliveryRef: recoveredP1.deliveryRef,
        }),
      );
      expect(p1Merged).toMatchObject({
        status: 'delivered',
        receipt: {phaseId: 'one', pr: {...p1.pr, state: 'merged'}, watch: {state: 'terminal'}},
      });
      const afterP1Merge = yield* readNativeWorkflowState(f.config, 'native-run');
      expect(afterP1Merge?.state.cycle?.state.phases.one?.status).toBe('merged');
      expect(afterP1Merge?.state.cycle?.state.phases.one?.delivery?.pr?.baseRefBinding).toEqual(p1CanonicalBaseBinding);
      expect(
        (yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo})).historicalWatches,
      ).toBeUndefined();
      expect(EffectString.trim((yield* f.git(['branch', '--show-current'])).stdout)).toBe('feature/two');
      expect(EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout)).toBe(p2Head);

      const p1WorkflowBytesAfterMerge = yield* f.fs.readFileString(f.statePath());
      const p1WatchBytesAfterMerge = yield* f.fs.readFileString(p1WatchPath);
      const closeoutFile = yield* nativeCloseoutJournalPath(f.config, 'native-run');
      const closeoutBytesAfterMerge = (yield* f.fs.exists(closeoutFile))
        ? yield* f.fs.readFileString(closeoutFile)
        : undefined;
      const historicalP1Replay = object(
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'complete',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef: recoveredP1.validationRef,
          deliveryRef: recoveredP1.deliveryRef,
        }),
      );
      expect(historicalP1Replay).toMatchObject({
        status: 'delivered',
        replayed: true,
        receipt: p1Merged.receipt,
        deliveryRef: p1Merged.deliveryRef,
      });
      expect(yield* f.fs.readFileString(f.statePath())).toBe(p1WorkflowBytesAfterMerge);
      expect(yield* f.fs.readFileString(p1WatchPath)).toBe(p1WatchBytesAfterMerge);
      expect((yield* f.fs.exists(closeoutFile)) ? yield* f.fs.readFileString(closeoutFile) : undefined).toBe(
        closeoutBytesAfterMerge,
      );
      expect(yield* readNativeCloseoutJournal(f.config, 'native-run', decodeJournal)).toBeUndefined();

      const p2Work = object(
        yield* runNativeTaskAction(f.config, {
          command: 'work',
          runId: 'native-run',
          callerCwd: f.repo,
          packet,
        }),
      );
      const p2Snapshot = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-snapshot',
          runId: 'native-run',
          callerCwd: f.repo,
          workRef: String(p2Work.workRef),
        }),
      );
      const p2SnapshotRef = String(p2Snapshot.snapshotRef);
      yield* runNativeTaskAction(f.config, {
        command: 'record-review',
        runId: 'native-run',
        callerCwd: f.repo,
        snapshotRef: p2SnapshotRef,
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
      const p2Validation = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-validation',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef: p2SnapshotRef,
          validation: {
            checks: [{command: 'phase two check', result: 'passed', evidence: 'Private P2 simulated check passed.'}],
            acceptance: [{criterion: 'two works', result: 'passed', evidence: 'P2 source is committed.'}],
          },
        }),
      );
      const p2Open = object(
        yield* runNativeTaskAction(f.config, {
          command: 'deliver-pr',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef: String(p2Validation.validationRef),
          commitEvidence: `Private simulated commit ${p2Head}`,
          pr: {
            url: 'https://github.com/example/repo/pull/22',
            headSha: p2Head,
            branch: 'feature/two',
            baseBranch: 'feature/one',
            state: 'open',
          },
          publication: {exemption: 'small-fix', reason: 'Private P2 simulated authority.'},
        }),
      );
      const p2ValidationRef = String(p2Validation.validationRef);
      const p2DeliveryRef = String(p2Open.deliveryRef);
      const p2Watch = yield* startSimulatedTaskWatch(
        f,
        'native-run',
        'two',
        p2ValidationRef,
        p2DeliveryRef,
        'https://github.com/example/repo/pull/22',
      );
      yield* writeSimulatedTaskWatch(
        f,
        p2Watch.startedWatch,
        p2Watch,
        'https://github.com/example/repo/pull/22',
        p2Head,
        false,
      );
      const p2Published = object(
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'complete',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef: p2ValidationRef,
          deliveryRef: p2DeliveryRef,
        }),
      );
      expect(p2Published).toMatchObject({
        status: 'delivered',
        receipt: {pr: {state: 'open'}, watch: {state: 'active'}},
      });
      const p2CurrentWatch = yield* readNativeWatch(f.config, p2Watch.watchId);
      if (!p2CurrentWatch) throw new Error('Expected the P2 simulated watch readback.');
      const p2Collector = p2CurrentWatch.envelope.collector;
      if (!p2Collector) throw new Error('Expected the P2 collector terminal record.');
      const p2MergedEnvelope = {
        ...p2CurrentWatch.envelope,
        state: {...p2CurrentWatch.envelope.state, prState: 'merged' as const},
        collector: {...p2Collector, status: 'terminal' as const, reason: 'merged' as const},
      };
      yield* writeNativeWatch(f.config, p2MergedEnvelope, p2CurrentWatch.revision);
      const p2Merged = object(
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'complete',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef: p2ValidationRef,
          deliveryRef: p2DeliveryRef,
        }),
      );
      expect(p2Merged).toMatchObject({
        status: 'delivered',
        receipt: {phaseId: 'two', pr: {state: 'merged'}, watch: {state: 'terminal'}},
      });
      const p2Stored = yield* readNativeWorkflowState(f.config, 'native-run');
      expect(p2Stored?.state.cycle?.state.phases.two?.status).toBe('merged');

      const p1WatchReadback = yield* readNativeWatch(f.config, recoveredP1.watchId);
      if (!p1WatchReadback) throw new Error('Expected the terminal P1 canonical watch.');
      const missingSourceEnvelope = {
        ...p1WatchReadback.envelope,
        state: {
          ...p1WatchReadback.envelope.state,
          sources: EffectArray.filter(p1WatchReadback.envelope.state.sources, item => item.source !== 'statuses'),
        },
      };
      const missingSourceWatch = yield* writeNativeWatch(f.config, missingSourceEnvelope, p1WatchReadback.revision);
      const stateBeforeMissingWatchCloseout = yield* f.fs.readFileString(f.statePath());
      const missingP1WatchCloseout = yield* runNativeTaskAction(f.config, {
        command: 'finish',
        runId: 'native-run',
        callerCwd: f.repo,
        proposal,
      }).pipe(Effect.result);
      expect(missingP1WatchCloseout).toMatchObject({failure: {code: 'finish-scope'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(stateBeforeMissingWatchCloseout);
      yield* writeNativeWatch(f.config, p1WatchReadback.envelope, missingSourceWatch.revision);

      const multiPhaseProposal = {
        ...proposal,
        phaseEvidence: [
          ...proposal.phaseEvidence,
          {id: 'two', acceptance: [{criterion: 'two works', evidence: 'The P2 source was committed and reviewed.'}]},
        ],
      };
      const closeout = object(
        yield* runNativeTaskAction(f.config, {
          command: 'finish',
          runId: 'native-run',
          callerCwd: f.repo,
          proposal: multiPhaseProposal,
        }).pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false)),
      );
      expect(closeout).toMatchObject({status: 'pending', stage: 'prepare'});
      const prepareJobId = decodeNativeTaskActionRef(String(closeout.prepareRef))?.jobId;
      if (!prepareJobId) throw new Error('Expected the exact all-phase closeout prepare job.');
      expect(object(yield* runNativeJobWorker(f.config, 'native-run', prepareJobId, f.call)).status).toBe('completed');
      const journal = yield* readNativeCloseoutJournal(f.config, 'native-run', decodeJournal);
      // P2's pending comment was never relayed before its merge, so closeout keeps it as open work.
      expect(journal?.state.proposal.watchWork).toMatchObject([
        {eventId: recoveredP1.watchId + ':1', status: 'open', evidence: 'Explicit synthetic watch event disposition.'},
        {
          status: 'open',
          reason: 'Undelivered watch event at merge.',
          evidence: 'https://github.com/example/repo/pull/22',
          event: {source: 'comments', kind: 'comment'},
        },
      ]);
      const finishing = object(
        yield* runNativeTaskAction(f.config, {
          command: 'finish',
          runId: 'native-run',
          callerCwd: f.repo,
          proposal: multiPhaseProposal,
          prepareRef: String(closeout.prepareRef),
        }).pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false)),
      );
      expect(finishing).toMatchObject({status: 'pending', stage: 'finish'});
      const finishJobId = decodeNativeTaskActionRef(String(finishing.finishRef))?.jobId;
      if (!finishJobId) throw new Error('Expected the exact all-phase closeout finish job.');
      expect(object(yield* runNativeJobWorker(f.config, 'native-run', finishJobId, f.call)).status).toBe('completed');
      const completed = object(
        yield* runNativeTaskAction(f.config, {
          command: 'finish',
          runId: 'native-run',
          callerCwd: f.repo,
          finishRef: String(finishing.finishRef),
        }).pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false)),
      );
      expect(completed).toMatchObject({status: 'complete'});
      const finalJournal = yield* readNativeCloseoutJournal(f.config, 'native-run', decodeJournal);
      expect(finalJournal?.state.status).toBe('complete');
      expect(finalJournal?.state.proposal.watchWork).toMatchObject([
        {eventId: recoveredP1.watchId + ':1', status: 'open'},
        {status: 'open', reason: 'Undelivered watch event at merge.'},
      ]);
      expect((yield* readNativeWatch(f.config, recoveredP1.watchId))?.envelope.state.prState).toBe('merged');
      expect((yield* readNativeWatch(f.config, p2Watch.watchId))?.envelope.state.prState).toBe('merged');
      const finalState = yield* readNativeWorkflowState(f.config, 'native-run');
      expect(finalState?.state.cycle?.state.phases.one?.delivery?.watch).toMatchObject({
        state: 'terminal',
        consumerId: recoveredP1.consumerId,
      });
      expect(finalState?.state.cycle?.state.phases.two?.delivery?.watch).toMatchObject({
        state: 'terminal',
        consumerId: p2Watch.consumerId,
      });
    }).pipe(run),
    windowsRealGitFixtureTimeout,
  );

  effectIt.effect('parses the maintenance validation reference for workflow watch completion', () =>
    Effect.gen(function* () {
      const root = Command.make('workflow-automation').pipe(
        Command.withSubcommands([
          makeNativeTaskPrWatchCommand(options =>
            Effect.sync(() => {
              expect(options).toMatchObject({
                operation: 'complete',
                maintenanceValidationRef: 'opaque-maintenance-reference',
              });
            }),
          ),
        ]),
      );
      yield* Command.runWith(root, {version: 'fixture'})([
        'watch-pr',
        '--caller-cwd',
        '/fixture',
        '--operation',
        'complete',
        '--maintenance-validation-ref',
        'opaque-maintenance-reference',
      ]);
    }).pipe(provideTestLayer(cliTestLayer)),
  );

  effectIt.effect(
    'finishes a three-phase PR stack after both dependent PRs retarget to the merge branch',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(['one', 'two', 'three'], 'pr', false, false, true, {
          one: {branch: 'feature/one', baseBranch: 'main'},
          two: {branch: 'feature/two', baseBranch: 'origin/feature/one'},
          three: {branch: 'feature/three', baseBranch: 'feature/two'},
        });
        const gitOutput = (args: readonly string[]) =>
          f.git(args).pipe(Effect.map(result => EffectString.trim(result.stdout)));
        const phases = yield* Effect.forEach(
          [
            ['one', 'main', 1158],
            ['two', 'feature/one', 1161],
            ['three', 'feature/two', 1162],
          ] as const,
          ([id, originalBase, number]) =>
            Effect.gen(function* () {
              const branch = `feature/${id}`;
              if (id !== 'one') yield* f.git(['checkout', '-b', branch]);
              if (id === 'two') yield* f.git(['update-ref', 'refs/remotes/origin/feature/one', 'feature/one']);
              const watch = yield* publishOpenHistoricalPhase(f, id, originalBase, number);
              const headSha = yield* gitOutput(['rev-parse', 'HEAD']);
              const prUrl = `https://github.com/example/repo/pull/${number}`;
              const current = yield* readNativeWatch(f.config, watch.watchId);
              if (!current) throw new Error('Expected the active watch for the published phase.');
              yield* writeSimulatedTaskWatch(f, current, watch, prUrl, headSha, true);
              return {
                id,
                originalBase,
                watch,
                provider: {
                  number,
                  url: prUrl,
                  baseRepository: 'example/repo',
                  headRepository: 'example/repo',
                  baseBranch: 'main',
                  headBranch: branch,
                  headSha,
                  state: 'closed',
                  merged: true,
                  mergeCommit: '',
                },
              };
            }),
        );

        const [first, second, third] = phases;
        yield* f.git(['checkout', 'main']);
        const published = yield* readNativeWorkflowState(f.config, 'native-run');
        for (const phase of phases) {
          yield* f.git(['merge', '--no-ff', phase.provider.headBranch, '-m', `Merge PR ${phase.provider.number}`]);
          phase.provider.mergeCommit = yield* gitOutput(['rev-parse', 'HEAD']);
          expect(yield* gitOutput(['rev-parse', 'HEAD^{tree}']), `validated merge tree for phase ${phase.id}`).toBe(
            published?.state.cycle?.state.phases[phase.id]?.delivery?.validatedTree,
          );
        }
        const commands = yield* CommandExecutor;
        const reads: number[] = [];
        let onRead: (() => Effect.Effect<void>) | undefined;
        const withProvider = <A, E, R>(program: Effect.Effect<A, E, R>, overrides: Readonly<Record<number, object>>) =>
          program.pipe(
            Effect.provideService(
              CommandExecutor,
              CommandExecutor.of({
                ...commands,
                execute: (executable, args, options) => {
                  if (executable === 'gh') {
                    const observed = EffectOption.getOrUndefined(
                      EffectArray.findFirst(phases, candidate =>
                        args.includes(`repos/example/repo/pulls/${candidate.provider.number}`),
                      ),
                    );
                    if (observed) {
                      reads.push(observed.provider.number);
                      return (onRead?.() ?? Effect.void).pipe(
                        Effect.as({
                          exitCode: 0,
                          stderr: '',
                          stdout: JSON.stringify({...observed.provider, ...overrides[observed.provider.number]}),
                        }),
                      );
                    }
                  }
                  return commands.execute(executable, args, options);
                },
              }),
            ),
          );
        const completionRequest = (phase: (typeof phases)[number]) => ({
          operation: 'complete' as const,
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef: phase.watch.validationRef,
          deliveryRef: phase.watch.deliveryRef,
        });
        const complete = (
          phase: (typeof phases)[number],
          overrides: Readonly<Record<number, object>> = {},
          maintenanceValidationRef?: string,
        ) =>
          withProvider(
            runNativeTaskActionCore(f.config, {
              command: 'watch-pr',
              ...completionRequest(phase),
              ...(maintenanceValidationRef === undefined ? {} : {maintenanceValidationRef}),
            }),
            overrides,
          );
        const refuse = (phase: (typeof phases)[number], reason: string, overrides?: Readonly<Record<number, object>>) =>
          Effect.gen(function* () {
            const before = yield* f.fs.readFileString(f.statePath());
            const result = yield* complete(phase, overrides).pipe(Effect.result);
            if (result._tag !== 'Failure') throw new Error(`Expected phase ${phase.id} delivery refusal: ${reason}.`);
            expect(result.failure.code, result.failure.message).toBe('pr-source-mismatch');
            expect(result.failure.message).toContain(reason);
            expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
          });
        const refuseExpirationDuringCompletion = (phase: (typeof phases)[number]) =>
          Effect.gen(function* () {
            const terminalWatch = yield* readNativeWatch(f.config, phase.watch.watchId);
            const leaseUntil = terminalWatch?.envelope.state.consumer?.leaseUntil;
            if (!leaseUntil) throw new Error('Expected a live consumer lease.');
            const clock = yield* Clock.Clock;
            let expired = false;
            onRead = () =>
              Effect.sync(() => {
                expired = true;
              });
            const beforeExpiration = yield* f.fs.readFileString(f.statePath());
            expect(
              yield* complete(phase).pipe(
                Effect.provideService(Clock.Clock, {
                  currentTimeMillisUnsafe: () => (expired ? leaseUntil : clock.currentTimeMillisUnsafe()),
                  currentTimeMillis: Effect.suspend(() =>
                    expired ? Effect.succeed(leaseUntil) : clock.currentTimeMillis,
                  ),
                  currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
                  currentTimeNanos: clock.currentTimeNanos,
                  monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
                  monotonicTimeNanos: clock.monotonicTimeNanos,
                  sleep: duration => clock.sleep(duration),
                }),
                Effect.result,
              ),
            ).toMatchObject({failure: {code: 'watch-not-ready'}});
            expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeExpiration);
            onRead = undefined;
          });
        const expiredTerminalWatch = (phase: (typeof phases)[number]) =>
          Effect.gen(function* () {
            const watch = yield* readNativeWatch(f.config, phase.watch.watchId);
            const owner = watch?.envelope.state.consumer;
            const notification = watch?.envelope.notification;
            const outbox = notification?.outbox;
            if (!watch || !owner || !notification || !outbox?.attemptId)
              throw new Error('Expected the owned terminal watch and queued host receipt.');
            const now = yield* Clock.currentTimeMillis;
            const {state} = watch.envelope;
            const event = state.events[0];
            const sequence = state.nextSequence;
            const terminal = {
              ...event,
              sequence,
              id: `${state.watchId}:${sequence}`,
              source: 'watch' as const,
              kind: 'merged',
              key: state.watchId,
              version: sha256HexSync(`state:merged:${state.head}`),
              head: state.head,
            };
            const relayed = relayNativeWatch(
              {...state, events: [event, terminal], nextSequence: sequence + 1},
              owner.id,
              now,
            );
            if (!relayed.delivery) throw new Error('Expected the terminal merge event to be relayed.');
            const resolved = recordNativeWatchDispositions(
              relayed.state,
              owner.id,
              relayed.delivery.id,
              [
                {
                  eventId: event.id,
                  status: 'ignored',
                  reason: 'The earlier comment needs no action.',
                  evidence: phase.provider.url,
                },
                {
                  eventId: terminal.id,
                  status: 'resolved',
                  reason: 'The PR merge is verified.',
                  evidence: phase.provider.url,
                },
              ],
              now,
            );
            const acknowledged = acknowledgeNativeWatch(resolved, owner.id, relayed.delivery.id, now);
            const expired = {...owner, lastSeenAt: now - owner.leaseMilliseconds - 1, leaseUntil: now - 1};
            const envelope = {
              ...watch.envelope,
              notification:
                phase.id === 'three'
                  ? consumeNativeWatchNotification(notification, resolved, {
                      consumerId: owner.id,
                      wakeupId: owner.wakeupId,
                      eventKey: outbox.key,
                      attemptId: outbox.attemptId,
                    })
                  : {
                      ...notification,
                      notifiedThrough: event.sequence,
                      lastReceipt: {
                        key: outbox.key,
                        receipt: outbox.attemptId,
                        attemptId: outbox.attemptId,
                        kind: 'queued-message' as const,
                        at: now,
                      },
                      outbox: {
                        ...outbox,
                        key: `${state.watchId}:${sequence}:${sequence}`,
                        first: sequence,
                        last: sequence,
                      },
                    },
            };
            return {
              watch,
              acknowledged: {...envelope, state: {...acknowledged, consumer: expired}},
              unacknowledged: {...envelope, state: {...resolved, consumer: expired}},
            };
          });
        const writeAcknowledgedExpiredWatch = (phase: (typeof phases)[number]) =>
          Effect.gen(function* () {
            const {watch, acknowledged} = yield* expiredTerminalWatch(phase);
            let revision = watch.revision;
            if (phase.id === 'three') {
              const earlierNotice = watch.envelope.notification;
              const covered = acknowledged.notification?.outbox;
              expect(covered?.last).toBeLessThan(acknowledged.state.acknowledged);
              expect(covered?.consumedThrough).toBe(acknowledged.state.acknowledged);
              const before = yield* f.fs.readFileString(f.statePath());
              const unchangedNotice = yield* writeNativeWatch(
                f.config,
                {...acknowledged, notification: earlierNotice},
                revision,
              );
              revision = unchangedNotice.revision;
              expect(yield* complete(phase).pipe(Effect.result)).toMatchObject({failure: {code: 'watch-not-ready'}});
              expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
            }
            const pendingWork =
              phase.id === 'three'
                ? {
                    ...acknowledged,
                    state: {
                      ...acknowledged.state,
                      work: EffectArray.map(acknowledged.state.work, item =>
                        item.event.kind === 'merged' ? item : {...item, status: 'blocked' as const},
                      ),
                    },
                  }
                : acknowledged;
            yield* writeNativeWatch(f.config, pendingWork, revision);
            const receipt = acknowledged.notification?.outbox?.receipt;
            if (phase.id === 'three') {
              const collector = watch.envelope.collector;
              if (!collector) throw new Error('Expected the terminal collector receipt.');
              const notifier = yield* makeNativeWatchNotifier(f.config, phase.watch.watchId, collector.token);
              yield* notifier.tick();
              const retained = yield* readNativeWatch(f.config, phase.watch.watchId);
              const notification = retained?.envelope.notification;
              const outbox = notification?.outbox;
              if (!retained || !notification || !outbox?.receipt || !outbox.attemptId)
                throw new Error('Expected the retained coalesced host receipt.');
              expect(outbox).toEqual(acknowledged.notification?.outbox);
              expect(yield* complete(phase).pipe(Effect.result)).toMatchObject({failure: {code: 'watch-not-ready'}});
              const settled = yield* writeNativeWatch(f.config, acknowledged, retained.revision);
              const legacy = yield* writeNativeWatch(
                f.config,
                {
                  ...settled.envelope,
                  notification: {
                    ...notification,
                    notifiedThrough: acknowledged.state.acknowledged,
                    outbox: null,
                    lastReceipt: {
                      key: outbox.key,
                      receipt: outbox.receipt,
                      attemptId: outbox.attemptId,
                      kind: 'queued-message',
                      at: outbox.createdAt,
                    },
                  },
                },
                settled.revision,
              );
              expect(yield* complete(phase).pipe(Effect.result)).toMatchObject({failure: {code: 'watch-not-ready'}});
              yield* writeNativeWatch(f.config, settled.envelope, legacy.revision);
            }
            return receipt;
          });
        yield* refuse(second, 'no distinct canonical merged PR receipt');
        yield* refuseExpirationDuringCompletion(first);
        yield* writeAcknowledgedExpiredWatch(first);
        expect(object(yield* complete(first))).toMatchObject({
          status: 'delivered',
          receipt: {pr: {baseBranch: 'main', state: 'merged'}},
        });

        const workflow = yield* readNativeWorkflowState(f.config, 'native-run');
        const canonical = workflow?.state.cycle?.state.phases.two.delivery;
        if (!canonical?.pr || !canonical.watch) throw new Error('Expected the open PR delivery.');
        const beforeRawDelivery = yield* f.fs.readFileString(f.statePath());
        const raw = yield* withProvider(
          f.mutate('record-delivery', {
            phaseId: 'two',
            publication: canonical.publication,
            delivery: {
              ...canonical,
              pr: {...canonical.pr, state: 'merged'},
              watch: {...canonical.watch, state: 'terminal', evidence: 'caller-controlled terminal watch'},
            },
          }),
          {},
        ).pipe(Effect.result);
        expect(raw).toMatchObject({failure: {code: 'pr-source-mismatch'}});
        expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeRawDelivery);

        const firstParent = yield* gitOutput(['rev-parse', first.provider.mergeCommit + '^1']);
        const sideMerge = yield* gitOutput([
          'commit-tree',
          second.provider.mergeCommit + '^{tree}',
          '-p',
          firstParent,
          '-p',
          first.provider.mergeCommit,
          '-m',
          'Same result tree, predecessor only on side history',
        ]);
        yield* refuse(second, 'target-side history', {[second.provider.number]: {mergeCommit: sideMerge}});
        yield* refuse(second, 'differs from the validated phase tree', {
          [second.provider.number]: {mergeCommit: first.provider.mergeCommit},
        });
        yield* refuse(second, 'Git could not read commit', {
          [second.provider.number]: {
            mergeCommit: yield* gitOutput(['rev-parse', second.provider.mergeCommit + '^{tree}']),
          },
        });
        yield* refuse(second, 'GitHub did not return the merge commit', {
          [second.provider.number]: {mergeCommit: null},
        });
        yield* refuse(second, 'same GitHub repository and target branch', {
          [second.provider.number]: {baseBranch: 'release'},
        });
        yield* refuse(second, 'GitHub did not return the merge commit for predecessor one', {
          [first.provider.number]: {mergeCommit: null},
        });
        yield* refuse(second, 'remote PR repository, branches, state and exact head', {
          [second.provider.number]: {headBranch: 'unrelated'},
        });
        yield* refuse(third, 'no distinct canonical merged PR receipt');
        yield* refuseExpirationDuringCompletion(second);
        const {watch: liveSecond, acknowledged, unacknowledged} = yield* expiredTerminalWatch(second);
        const expiredSecond = yield* writeNativeWatch(f.config, unacknowledged, liveSecond.revision);
        const beforeUnacknowledged = yield* f.fs.readFileString(f.statePath());
        expect(yield* complete(second).pipe(Effect.result)).toMatchObject({failure: {code: 'watch-not-ready'}});
        expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeUnacknowledged);
        const oldNotification = acknowledged.notification;
        if (!oldNotification) throw new Error('Expected the terminal notice.');
        let incompleteRevision = expiredSecond.revision;
        for (const incomplete of [
          {...acknowledged, notification: {...oldNotification, recoveryRequested: true}},
          {
            ...acknowledged,
            state: {
              ...acknowledged.state,
              work: EffectArray.map(acknowledged.state.work, item =>
                item.event.kind === 'merged' ? item : {...item, status: 'blocked' as const},
              ),
            },
          },
        ]) {
          const storedIncomplete = yield* writeNativeWatch(f.config, incomplete, incompleteRevision);
          incompleteRevision = storedIncomplete.revision;
          expect(yield* complete(second).pipe(Effect.result)).toMatchObject({failure: {code: 'watch-not-ready'}});
          expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeUnacknowledged);
        }
        yield* writeNativeWatch(f.config, acknowledged, incompleteRevision);

        // Create independent canonical maintenance evidence on the final phase's original published head.
        const deliverMaintenance = Effect.gen(function* () {
          const runId = 'maintenance-run';
          const phaseId = 'three';
          const project = 'maintenance-fixture';
          const baseBranch = 'maintenance-base';
          const originalHead = third.provider.headSha;
          yield* f.git(['branch', baseBranch, originalHead]);
          const branch = 'maintenance-work';
          const checkout = f.path.join(f.path.dirname(f.repo), 'maintenance-repo');
          yield* f.git(['worktree', 'add', '-b', branch, checkout, originalHead]);
          const call = (input: unknown) =>
            inCheckout(runWorkflowAutomation(f.config, input), checkout).pipe(
              Effect.map(result => ('cycle' in result ? result.cycle : result)),
            );
          yield* call({
            ...f.base('init', runId),
            project,
            featureId: 'feature',
            profile: 'desktop',
          });
          const authoring = f.base('authoring', runId);
          const document = {
            ...f.document,
            project,
            phases: EffectArray.filter(f.document.phases, phase => phase.id === phaseId),
            decisions: EffectArray.map(f.document.decisions, decision => ({...decision, affectedPhases: [phaseId]})),
          };
          const saved = object(
            object(yield* call({...authoring, command: 'save', document, ready: true, expectedRevision: null}))
              .authoring,
          );
          const plan = object(
            object(
              yield* call({
                ...authoring,
                command: 'export-dev-cycle',
                uri: object(saved.root).uri,
                delivery: 'commit',
                bindings: {[phaseId]: {branch, baseBranch}},
              }),
            ).authoring,
          );
          const cycle = f.base('cycle', runId);
          const initialize = object(yield* call({...cycle, command: 'inspect'}));
          const initialized = object(
            yield* call({
              ...cycle,
              command: 'init',
              plan,
              expectedRevision: initialize.revision,
            }),
          );
          yield* call({...cycle, command: 'begin-phase', phaseId, expectedRevision: initialized.revision});
          const maintenanceAction = (fields: object) =>
            runNativeTaskActionCore(f.config, {runId, callerCwd: checkout, ...fields}).pipe(Effect.map(object));
          const work = yield* maintenanceAction({command: 'work', packet});
          yield* f.fs.writeFileString(f.path.join(checkout, 'source.ts'), 'export const fixture = "maintained";\n');
          yield* runCommandEffect('git', ['-C', checkout, 'commit', '-am', 'Maintenance after publication']);
          const maintainedHead = yield* gitOutput(['rev-parse', branch]);
          const snapshot = yield* maintenanceAction({command: 'record-snapshot', workRef: work.workRef});
          const snapshotRef = snapshot.snapshotRef;
          yield* maintenanceAction({
            command: 'record-review',
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
          const validation = yield* maintenanceAction({
            command: 'record-validation',
            snapshotRef,
            validation: {
              checks: [{command: 'private maintenance check', result: 'passed', evidence: 'The fixture check passed.'}],
              acceptance: [
                {criterion: 'three works', result: 'passed', evidence: 'The maintained source was reviewed.'},
              ],
            },
          });
          const validationRef = String(validation.validationRef);
          const delivered = yield* maintenanceAction({
            command: 'deliver-commit',
            validationRef,
            commitEvidence: `Verified private maintenance commit ${maintainedHead}`,
          });
          expect(delivered).toMatchObject({status: 'delivered', receipt: {headSha: maintainedHead}});
          const originalMerge = third.provider.mergeCommit;
          third.provider.headSha = maintainedHead;
          third.provider.mergeCommit = yield* gitOutput([
            'commit-tree',
            maintainedHead + '^{tree}',
            '-p',
            second.provider.mergeCommit,
            '-p',
            maintainedHead,
            '-m',
            'Merge maintained PR',
          ]);
          const current = yield* readNativeWatch(f.config, third.watch.watchId);
          if (!current) throw new Error('Expected the original PR watch.');
          yield* writeSimulatedTaskWatch(f, current, third.watch, third.provider.url, maintainedHead, true);
          return {
            validationRef,
            deliveryRef: String(delivered.deliveryRef),
            originalMerge,
            runId,
            source: f.path.join(checkout, 'source.ts'),
          };
        });
        for (const phase of [second, third]) {
          const maintenance = phase.id === 'three' ? yield* deliverMaintenance : undefined;
          const predecessor = phase.id === 'two' ? first : second;
          const pruned = phase.id === 'two' ? 'refs/remotes/origin/feature/one' : 'refs/heads/feature/two';
          yield* f.git(['update-ref', '-d', pruned]);
          if (phase.id === 'two')
            expect(
              yield* complete(second, {
                [second.provider.number]: {baseBranch: second.originalBase},
              }).pipe(Effect.result),
            ).toMatchObject({failure: {code: 'base-ref-unverified'}});
          const receipt =
            phase.id === 'two'
              ? acknowledged.notification?.outbox?.receipt
              : yield* writeAcknowledgedExpiredWatch(phase);
          if (!receipt) throw new Error('Expected the merged terminal host receipt.');
          reads.length = 0;
          const before = (yield* readNativeWorkflowState(f.config, 'native-run'))?.state.cycle?.state.phases[phase.id]
            ?.delivery;
          expect(before?.pr?.baseBranch).toBe(phase.originalBase);
          expect(before?.pr?.state).toBe('open');
          if (maintenance) {
            const beforeAttempt = yield* f.fs.readFileString(f.statePath());
            expect(yield* complete(phase).pipe(Effect.result)).toMatchObject({
              failure: {code: 'pr-source-mismatch'},
            });
            expect(yield* complete(phase, {}, maintenance.deliveryRef).pipe(Effect.result)).toMatchObject({
              failure: {code: 'maintenance-proof-unverified'},
            });
            expect(
              yield* complete(
                phase,
                {[phase.provider.number]: {mergeCommit: maintenance.originalMerge}},
                maintenance.validationRef,
              ).pipe(Effect.result),
            ).toMatchObject({failure: {code: 'maintenance-proof-unverified'}});
            const refuseProof = <R>(
              attempt: Effect.Effect<unknown, {readonly code: string; readonly message: string}, R>,
              reason: string,
            ) =>
              Effect.gen(function* () {
                const result = yield* attempt.pipe(Effect.result);
                if (result._tag !== 'Failure') throw new Error(`Expected maintenance proof refusal: ${reason}.`);
                expect(result.failure.code, result.failure.message).toBe('maintenance-proof-unverified');
                expect(result.failure.message).toContain(reason);
                expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeAttempt);
              });
            const attempt = complete(phase, {}, maintenance.validationRef);
            const donor = (yield* readNativeWorkflowState(f.config, maintenance.runId))?.state;
            const cycle = donor?.cycle;
            if (!donor || !cycle) throw new Error('Expected the commit-delivered donor run.');
            const baseline = cycle.baselines[phase.id];
            if (!baseline) throw new Error('Expected the maintenance snapshot baseline.');
            const donorFile = f.statePath(maintenance.runId);
            const donorBytes = yield* f.fs.readFileString(donorFile);
            const foreign = f.path.join(f.path.dirname(f.repo), 'foreign-repo');
            yield* f.git(['clone', '--quiet', f.repo, foreign]);
            for (const [candidate, reason] of [
              [
                {
                  ...cycle,
                  snapshots: EffectArray.map(cycle.snapshots, entry => ({
                    ...entry,
                    snapshot: {...entry.snapshot, scopeBase: entry.snapshot.tree},
                  })),
                },
                'original delivered PR head as its comparison base',
              ],
              [{...cycle, reviews: []}, 'independent review with no blocker or waiver'],
              [
                {
                  ...cycle,
                  baselines: {...cycle.baselines, [phase.id]: {...baseline, repo: foreign}},
                  snapshots: EffectArray.map(cycle.snapshots, entry => ({
                    ...entry,
                    snapshot: {...entry.snapshot, repo: foreign},
                  })),
                },
                'different Git repository',
              ],
            ] as const) {
              yield* f.fs.writeFileString(donorFile, serializeNativeWorkflowState({...donor, cycle: candidate}));
              yield* refuseProof(attempt, reason).pipe(
                Effect.ensuring(f.fs.writeFileString(donorFile, donorBytes).pipe(Effect.orDie)),
              );
            }
            const cleanSource = yield* f.fs.readFileString(maintenance.source);
            const dirtyDonor = f.fs.writeFileString(maintenance.source, cleanSource + '// uncommitted edit\n');
            const restoreDonor = f.fs.writeFileString(maintenance.source, cleanSource).pipe(Effect.orDie);
            yield* dirtyDonor;
            yield* refuseProof(attempt, 'maintenance checkout must remain clean').pipe(Effect.ensuring(restoreDonor));
            reads.length = 0;
            onRead = () => dirtyDonor.pipe(Effect.orDie);
            yield* refuseProof(attempt, 'maintenance checkout must remain clean').pipe(
              Effect.ensuring(restoreDonor),
              Effect.ensuring(
                Effect.sync(() => {
                  onRead = undefined;
                }),
              ),
            );
            expect(reads).toEqual([phase.provider.number, predecessor.provider.number]);
            reads.length = 0;
          }
          const completeOverMcp = (maintenanceValidationRef: string) =>
            Effect.gen(function* () {
              const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
              registerWorkflowTaskTool(mcp, f.config);
              const response = yield* withProvider(
                mcp.invokeTool('workflow_task_watch_pr', {...completionRequest(phase), maintenanceValidationRef}),
                {},
              );
              expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
              return object(response.structuredContent);
            });
          const completed = maintenance
            ? yield* completeOverMcp(maintenance.validationRef)
            : object(yield* complete(phase));
          expect(completed).toMatchObject({
            status: 'delivered',
            receipt: {
              headSha: before?.headSha,
              validatedTree: before?.validatedTree,
              pr: {...before?.pr, state: 'merged'},
              providerIdentity: before?.providerIdentity,
              userAuthority: before?.userAuthority,
              watch: {
                state: 'terminal',
                consumerId: phase.watch.consumerId,
                headSha: phase.provider.headSha,
                evidence: expect.stringContaining(`;host-receipt:${receipt}`),
              },
            },
          });
          if (maintenance) {
            expect(object(object(completed.receipt).watch).evidence).toContain(
              ';maintenance-proof:maintenance-run:three:',
            );
          }
          expect(reads).toEqual([phase.provider.number, predecessor.provider.number]);
          const replay = maintenance
            ? yield* completeOverMcp(maintenance.validationRef)
            : object(yield* complete(phase));
          expect(replay).toMatchObject({status: 'delivered', replayed: true, receipt: completed.receipt});
          expect(reads).toEqual([phase.provider.number, predecessor.provider.number]);
        }
        const request = {
          command: 'finish' as const,
          runId: 'native-run',
          callerCwd: f.repo,
          proposal: {
            ...proposal,
            phaseEvidence: EffectArray.map(phases, phase => ({
              id: phase.id,
              acceptance: [
                {
                  criterion: phase.id + ' works',
                  evidence:
                    phase.id === 'three'
                      ? 'The merge matches the independently reviewed maintenance tree.'
                      : 'The exact validated source merged.',
                },
              ],
            })),
          },
        };
        const finish = (input: {prepareRef?: string; finishRef?: string}) => {
          const {proposal: closeoutProposal, ...base} = request;
          return runNativeTaskAction(f.config, {
            ...base,
            ...input,
            ...(input.finishRef ? {} : {proposal: closeoutProposal}),
          }).pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false), Effect.map(object));
        };
        const prepare = yield* finish({});
        expect(prepare).toMatchObject({status: 'pending', stage: 'prepare'});
        const prepareRef = String(prepare.prepareRef);
        const prepareJobId = decodeNativeTaskActionRef(prepareRef)?.jobId;
        if (!prepareJobId) throw new Error('Expected a closeout prepare job.');
        expect(object(yield* runNativeJobWorker(f.config, 'native-run', prepareJobId, f.call)).status).toBe(
          'completed',
        );
        const finishing = yield* finish({prepareRef});
        expect(finishing).toMatchObject({status: 'pending', stage: 'finish'});
        const finishRef = String(finishing.finishRef);
        const finishJobId = decodeNativeTaskActionRef(finishRef)?.jobId;
        if (!finishJobId) throw new Error('Expected a closeout finish job.');
        expect(object(yield* runNativeJobWorker(f.config, 'native-run', finishJobId, f.call)).status).toBe('completed');
        expect(yield* finish({finishRef})).toMatchObject({status: 'complete'});
      }).pipe(run),
    process.platform === 'win32' ? {timeout: 180_000} : windowsRealGitFixtureTimeout,
  );

  effectIt.effect(
    'completes and closes out every phase of one PR merged above the last phase head',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(['one', 'two'], 'pr', false, false, false, {
          one: {branch: 'feature/one', baseBranch: 'main'},
          two: {branch: 'feature/one', baseBranch: 'main'},
        });
        const head = () => f.git(['rev-parse', 'HEAD']).pipe(Effect.map(result => EffectString.trim(result.stdout)));
        const p1 = yield* publishOpenHistoricalPhase(f, 'one', 'main', 75);
        const p1Head = yield* head();
        yield* f.mutate('begin-phase', {phaseId: 'two'});
        const p2 = yield* publishOpenHistoricalPhase(f, 'two', 'main', 75, false, undefined, 'feature/one');
        const p2Head = yield* head();
        // The final PR commit was pushed elsewhere, so the local branch stays at the phase two head.
        const mergedHead = EffectString.trim(
          (yield* f.git(['commit-tree', `${p2Head}^{tree}`, '-p', p2Head, '-m', 'Pushed from elsewhere'])).stdout,
        );
        for (const phase of [p1, p2]) {
          const current = yield* readNativeWatch(f.config, phase.watchId);
          if (!current?.envelope.collector) throw new Error('Expected each phase watch.');
          yield* writeNativeWatch(
            f.config,
            {
              ...current.envelope,
              state: {...current.envelope.state, head: mergedHead, prState: 'merged'},
              collector: {...current.envelope.collector, status: 'terminal', reason: 'merged'},
            },
            current.revision,
          );
          expect(
            object(
              yield* runNativeTaskAction(f.config, {
                command: 'watch-pr',
                operation: 'complete',
                runId: 'native-run',
                callerCwd: f.repo,
                validationRef: phase.validationRef,
                deliveryRef: phase.deliveryRef,
              }),
            ),
          ).toMatchObject({status: 'delivered', receipt: {watch: {headSha: mergedHead, state: 'terminal'}}});
        }
        const phases = (yield* readNativeWorkflowState(f.config, 'native-run'))?.state.cycle?.state.phases;
        expect(phases?.one?.delivery?.headSha).toBe(p1Head);
        expect(phases?.two?.delivery?.headSha).toBe(p2Head);
        const closeout = object(
          yield* runNativeTaskAction(f.config, {
            command: 'finish',
            runId: 'native-run',
            callerCwd: f.repo,
            proposal: {
              ...proposal,
              phaseEvidence: [
                ...proposal.phaseEvidence,
                {id: 'two', acceptance: [{criterion: 'two works', evidence: 'Observed the committed P2 source.'}]},
              ],
            },
          }).pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false)),
        );
        expect(closeout).toMatchObject({status: 'pending', stage: 'prepare'});
      }).pipe(run),
    windowsRealGitFixtureTimeout,
  );

  effectIt.effect(
    'records a ready merged watch receipt during finish and names a missing watch prerequisite',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(['one'], 'pr');
        const published = yield* publishOpenHistoricalPhase(f, 'one', 'main', 76);
        const finish = runNativeTaskAction(f.config, {
          command: 'finish',
          runId: 'native-run',
          callerCwd: f.repo,
          proposal,
        }).pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false));
        const beforeMerge = yield* f.fs.readFileString(f.statePath());
        expect(yield* finish.pipe(Effect.result)).toMatchObject({
          failure: {
            code: 'finish-scope',
            message: expect.stringContaining('is not merged yet'),
            next: {
              tool: 'workflow_task_watch_pr',
              command: 'inspect',
              arguments: {
                operation: 'inspect',
                runId: 'native-run',
                validationRef: expect.any(String),
                deliveryRef: expect.any(String),
              },
            },
          },
        });
        expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeMerge);
        const current = yield* readNativeWatch(f.config, published.watchId);
        if (!current?.envelope.collector || !current.envelope.state.consumer)
          throw new Error('Expected the published phase watch.');
        const mergedState = {...current.envelope.state, prState: 'merged' as const};
        const sweeping = yield* writeNativeWatch(
          f.config,
          {...current.envelope, state: mergedState, collector: {...current.envelope.collector, status: 'running'}},
          current.revision,
        );
        expect(yield* finish.pipe(Effect.result)).toMatchObject({
          failure: {
            code: 'finish-scope',
            message: expect.stringContaining('has not finished its terminal merged sweep'),
            next: {tool: 'workflow_task_watch_pr', command: 'inspect'},
          },
        });
        expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeMerge);
        // No separate renew or complete: finish settles the merged watch through the same guarded routes,
        // including their provider observations of the PR.
        const executor = yield* CommandExecutor;
        const mergedProvider = CommandExecutor.of({
          ...executor,
          execute: (executable, args, options) =>
            executable === 'gh' && args.includes('--jq')
              ? Effect.succeed({
                  exitCode: 0,
                  stderr: '',
                  stdout: JSON.stringify({
                    number: 76,
                    url: 'https://github.com/example/repo/pull/76',
                    baseRepository: 'example/repo',
                    headRepository: 'example/repo',
                    baseBranch: 'main',
                    headBranch: 'feature/one',
                    headSha: current.envelope.state.head,
                    state: 'closed',
                    merged: true,
                  }),
                })
              : executor.execute(executable, args, options),
        });
        const watchEvent = (
          sequence: number,
          fields: {readonly source: 'reviews' | 'checks' | 'watch'; readonly kind: string},
        ) => ({
          sequence,
          id: `${mergedState.watchId}:${sequence}`,
          key: `key-${sequence}`,
          version: EffectString.repeat(64)('b'),
          at: sequence,
          removed: false,
          ...fields,
        });
        // A merged watch whose notice has no host receipt yet cannot record its terminal receipt.
        if (!current.envelope.notification) throw new Error('Expected the registered host notification.');
        const {lastReceipt: _lastReceipt, ...unreceipted} = current.envelope.notification;
        const liveAt = yield* Clock.currentTimeMillis;
        const awaitingReceipt = yield* writeNativeWatch(
          f.config,
          {
            ...current.envelope,
            state: {
              ...mergedState,
              consumer: {
                ...current.envelope.state.consumer,
                lastSeenAt: liveAt,
                leaseUntil: liveAt + current.envelope.state.consumer.leaseMilliseconds,
              },
            },
            collector: {...current.envelope.collector, status: 'terminal', reason: 'merged'},
            notification: {...unreceipted, outbox: null},
          },
          sweeping.revision,
        );
        expect(yield* finish.pipe(Effect.result)).toMatchObject({
          failure: {
            code: 'finish-scope',
            message: expect.stringContaining('has no host receipt yet'),
            next: {tool: 'workflow_task_watch_pr', command: 'inspect'},
          },
        });
        expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeMerge);
        // At merge the lease has expired and 130 acknowledged rows remain open: more than closeout can carry.
        const openWork = EffectArray.makeBy(130, index => ({
          eventId: `${mergedState.watchId}:${index + 1}`,
          status: 'open' as const,
          reason: 'Open review follow-up.',
          evidence: 'Synthetic open watch work.',
          event: watchEvent(index + 1, {source: 'reviews', kind: 'review'}),
          at: index + 1,
        }));
        yield* writeNativeWatch(
          f.config,
          {
            ...current.envelope,
            state: {
              ...mergedState,
              nextSequence: 131,
              acknowledged: 130,
              lastAck: '1:130',
              delivery: null,
              events: [],
              work: openWork,
              consumer: {
                ...current.envelope.state.consumer,
                lastSeenAt: 1,
                leaseUntil: 1 + current.envelope.state.consumer.leaseMilliseconds,
              },
            },
            collector: {...current.envelope.collector, status: 'terminal', reason: 'merged'},
          },
          awaitingReceipt.revision,
        );
        expect(yield* finish.pipe(Effect.provideService(CommandExecutor, mergedProvider), Effect.result)).toMatchObject(
          {
            failure: {
              code: 'closeout-watch-work-overflow',
              message: expect.stringContaining('130 open watch work rows'),
              next: {tool: 'workflow_task_watch_pr', command: 'work', arguments: {operation: 'work', workOffset: 0}},
            },
          },
        );
        // The refused finish still renewed the lease and recorded the terminal receipt.
        expect(
          (yield* readNativeWorkflowState(f.config, 'native-run'))?.state.cycle?.state.phases.one?.delivery,
        ).toMatchObject({pr: {state: 'merged'}, watch: {state: 'terminal'}});
        const renewed = yield* readNativeWatch(f.config, published.watchId);
        if (!renewed) throw new Error('Expected the renewed merged watch.');
        expect(renewed.envelope.state.consumer?.leaseUntil).toBeGreaterThan(yield* Clock.currentTimeMillis);
        // The work is settled, but a later backlog was never relayed: CI progress and head moves are not work, and
        // twenty actionable events keep sixteen rows and one aggregate row.
        const failedCheck = {
          ...watchEvent(133, {source: 'checks', kind: 'ci_error'}),
          summary: 'unit: failure | FAIL apps/x.test.ts > keeps limits',
        };
        const reviews = EffectArray.makeBy(19, index => watchEvent(134 + index, {source: 'reviews', kind: 'review'}));
        const backlog = [
          {...watchEvent(131, {source: 'checks', kind: 'ci_complete'}), ready: false as const},
          watchEvent(132, {source: 'watch', kind: 'head_changed'}),
          failedCheck,
          ...reviews,
        ];
        yield* writeNativeWatch(
          f.config,
          {
            ...renewed.envelope,
            state: {
              ...renewed.envelope.state,
              nextSequence: 131 + backlog.length,
              events: backlog,
              work: EffectArray.map(openWork, item => ({...item, status: 'resolved' as const})),
            },
          },
          renewed.revision,
        );
        const closeout = object(yield* finish.pipe(Effect.provideService(CommandExecutor, mergedProvider)));
        expect(closeout).toMatchObject({status: 'pending', stage: 'prepare'});
        const prepareJobId = decodeNativeTaskActionRef(String(closeout.prepareRef))?.jobId;
        if (!prepareJobId) throw new Error('Expected an opaque closeout prepare reference.');
        expect(object(yield* runNativeJobWorker(f.config, 'native-run', prepareJobId, f.call)).status).toBe(
          'completed',
        );
        const journal = yield* readNativeCloseoutJournal(f.config, 'native-run', decodeJournal);
        const {summary: _summary, ...carriedCheck} = failedCheck;
        const carried = (event: (typeof reviews)[number] | typeof carriedCheck, reason: string) => ({
          eventId: event.id,
          status: 'open',
          reason,
          evidence: 'https://github.com/example/repo/pull/76',
          event,
          at: event.at,
        });
        // The untrusted CI summary stays on the live watch; the closeout row never carries it.
        expect(journal?.state.proposal.watchWork).toEqual([
          ...EffectArray.map([carriedCheck, ...reviews.slice(0, 15)], event =>
            carried(event, 'Undelivered watch event at merge.'),
          ),
          carried(
            reviews[15],
            `4 more undelivered watch events (${reviews[15].id}..${reviews[18].id}); inspect the watch.`,
          ),
        ]);
      }).pipe(run),
    windowsRealGitFixtureTimeout,
  );

  effectIt.effect(
    'completes and closes out a merged PR whose head descends from the delivered phase head',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(['one'], 'pr');
        const published = yield* publishOpenHistoricalPhase(f, 'one', 'main', 74);
        const head = () => f.git(['rev-parse', 'HEAD']).pipe(Effect.map(result => EffectString.trim(result.stdout)));
        const deliveredHead = yield* head();
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "maintenance";\n');
        yield* f.git(['commit', '-am', 'Reviewed maintenance after delivery']);
        const mergedHead = yield* head();
        const mergeAt = (watchHead: string, ambiguousLaterWake = false) =>
          Effect.gen(function* () {
            const current = yield* readNativeWatch(f.config, published.watchId);
            const outbox = current?.envelope.notification?.outbox;
            if (!current?.envelope.collector || !current.envelope.notification || !outbox?.receipt || !outbox.attemptId)
              throw new Error('Expected the published phase watch and its queued host receipt.');
            const state = {...current.envelope.state, head: watchHead, prState: 'merged' as const};
            // The earlier wake has a real receipt; a later wake became ambiguous when its collector stopped.
            const later = recordNativeWatchLifecycle(state, 'watcher_stopped', 'collector-replaced', outbox.createdAt);
            yield* writeNativeWatch(
              f.config,
              {
                ...current.envelope,
                state: ambiguousLaterWake ? later : state,
                collector: {...current.envelope.collector, status: 'terminal', reason: 'merged'},
                ...(ambiguousLaterWake
                  ? {
                      notification: {
                        ...current.envelope.notification,
                        notifiedThrough: outbox.last,
                        lastReceipt: {
                          key: outbox.key,
                          receipt: outbox.receipt,
                          attemptId: outbox.attemptId,
                          kind: 'queued-message' as const,
                          at: outbox.createdAt,
                        },
                        outbox: {
                          key: `${published.watchId}:${later.nextSequence - 1}:${later.nextSequence - 1}`,
                          first: later.nextSequence - 1,
                          last: later.nextSequence - 1,
                          createdAt: outbox.createdAt,
                          attempts: 1,
                          nextAttemptAt: outbox.createdAt,
                          attemptId: outbox.attemptId,
                          collectorToken: current.envelope.collector.token,
                          status: 'failed' as const,
                          error: 'host-delivery-ambiguous' as const,
                          consumedThrough: 0,
                        },
                      },
                    }
                  : {}),
              },
              current.revision,
            );
          });
        const complete = runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'complete',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef: published.validationRef,
          deliveryRef: published.deliveryRef,
        });
        const unrelated = EffectString.trim(
          (yield* f.git(['commit-tree', `${deliveredHead}^{tree}`, '-p', `${deliveredHead}^`, '-m', 'Rewritten PR']))
            .stdout,
        );
        yield* mergeAt(unrelated);
        const before = yield* f.fs.readFileString(f.statePath());
        expect(yield* complete.pipe(Effect.result)).toMatchObject({failure: {code: 'merged-head-mismatch'}});
        const missing = EffectString.repeat(40)('f');
        yield* mergeAt(missing);
        const unavailable = yield* complete.pipe(Effect.result);
        expect(unavailable).toMatchObject({failure: {code: 'merged-head-unavailable'}});
        expect(JSON.stringify(unavailable)).toContain(missing);
        expect(yield* f.fs.readFileString(f.statePath())).toBe(before);

        // The task route recovers the ambiguous wake of the merged watch with exactly one host notice.
        yield* mergeAt(mergedHead, true);
        published.setCollectorAlive(false);
        const hostNotices: string[] = [];
        const host = CommandExecutor.of({
          ...published.commands,
          execute: (executable, args, options) => {
            if (executable !== published.wakeup.executable || args[0] !== 'queue' || args[1] === '--help')
              return published.commands.execute(executable, args, options);
            hostNotices.push(args[4] ?? '');
            return Effect.succeed({
              exitCode: 0,
              stderr: '',
              stdout: `Queued message dddddddd-dddd-4ddd-8ddd-dddddddddddd for thread ${published.wakeup.threadId}.\n`,
            });
          },
        });
        const recovered = object(
          yield* runNativeTaskAction(f.config, {
            command: 'watch-pr',
            operation: 'renew',
            recoverWakeup: true,
            runId: 'native-run',
            callerCwd: f.repo,
            validationRef: published.validationRef,
            deliveryRef: published.deliveryRef,
          }).pipe(Effect.provideService(CommandExecutor, host), Effect.provideService(SystemInfo, published.system)),
        );
        expect(recovered).toMatchObject({status: 'watching'});
        expect(hostNotices).toHaveLength(1);
        expect((yield* readNativeWatch(f.config, published.watchId))?.envelope.notification?.outbox).toMatchObject({
          status: 'queued',
          receipt: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        });
        const noticed = yield* readNativeWatch(f.config, published.watchId);
        const arrivedRoute = /^Threadnote watch event\. Route=(\{[^}]+\})\./u.exec(hostNotices[0]);
        if (!noticed || !arrivedRoute) throw new Error('Expected the exact route sent to the host.');
        const noticeRoute = object(JSON.parse(arrivedRoute[1]));
        const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
        registerWorkflowTaskTool(mcp, f.config);
        const viewRequest = {runId: 'native-run', callerCwd: f.repo, phaseId: 'one', noticeRoute: arrivedRoute[1]};
        const exactNotice = () => mcp.invokeTool('workflow_task_view', viewRequest);
        const recoveredNotice = yield* exactNotice();
        expect(recoveredNotice.structuredContent).toMatchObject({
          status: 'notice-recovered',
          continuation: {
            action: 'watch-pr',
            validationRef: published.validationRef,
            noticeRef: expect.any(String),
          },
        });
        for (const foreign of [
          {...noticeRoute, eventKey: String(noticeRoute.eventKey) + ':foreign'},
          {...noticeRoute, attemptId: 'another-attempt'},
          {...noticeRoute, home: f.repo},
        ]) {
          const foreignNotice = yield* mcp
            .invokeTool('workflow_task_view', {...viewRequest, noticeRoute: JSON.stringify(foreign)})
            .pipe(Effect.result);
          expect(foreignNotice).toMatchObject({failure: {code: 'foreign-notice-route'}});
        }
        const malformed = yield* mcp
          .invokeTool('workflow_task_view', {...viewRequest, noticeRoute: '{'})
          .pipe(Effect.result);
        expect(malformed).toMatchObject({failure: {code: 'invalid-request'}});
        expect((yield* readNativeWatch(f.config, published.watchId))?.revision).toBe(noticed?.revision);
        expect(yield* f.fs.readFileString(f.statePath())).toBe(before);

        expect(object(yield* complete)).toMatchObject({
          status: 'delivered',
          receipt: {
            headSha: deliveredHead,
            pr: {headSha: deliveredHead, state: 'merged'},
            watch: {headSha: mergedHead, state: 'terminal'},
          },
        });
        const mergedNotice = object((yield* exactNotice()).structuredContent);
        expect(mergedNotice.status).toBe('notice-recovered');
        const continuation = object(mergedNotice.continuation);
        const watchRequest = {
          command: 'watch-pr' as const,
          runId: viewRequest.runId,
          callerCwd: viewRequest.callerCwd,
          validationRef: String(continuation.validationRef),
          deliveryRef: String(continuation.deliveryRef),
        };
        expect(object(yield* runNativeTaskAction(f.config, {...watchRequest, operation: 'inspect'}))).toMatchObject({
          status: 'watch-updated',
          watchId: published.watchId,
        });
        // A resumed binding compares the merged receipt with its terminal watch head, not the phase head.
        const owners = yield* inspectOldBindingOwners(
          f.config,
          (yield* readNativeWorkflowState(f.config, 'native-run'))!,
        );
        expect(JSON.stringify(owners.unresolved)).not.toContain('watch-source-head-mismatch');
        const closeout = object(
          yield* runNativeTaskAction(f.config, {
            command: 'finish',
            runId: 'native-run',
            callerCwd: f.repo,
            proposal,
          }).pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false)),
        );
        expect(closeout).toMatchObject({status: 'pending', stage: 'prepare'});
        const relayed = object(
          yield* runNativeTaskAction(f.config, {
            ...watchRequest,
            operation: 'relay',
            noticeRef: String(continuation.noticeRef),
          }),
        );
        expect(relayed).toMatchObject({
          status: 'watch-updated',
          watchId: published.watchId,
          watchDeliveryRef: expect.any(String),
          eventRefs: expect.arrayContaining([expect.any(String)]),
        });
        const pending = yield* readNativeWatch(f.config, published.watchId);
        if (!pending) throw new Error('Expected the terminal watch before simulating a drained arrival.');
        const drained = yield* writeNativeWatch(
          f.config,
          {
            ...pending.envelope,
            state: {
              ...pending.envelope.state,
              events: [],
              delivery: null,
              work: [],
              acknowledged: pending.envelope.state.nextSequence - 1,
            },
          },
          pending.revision,
        );
        const terminalRun = yield* f.fs.readFileString(f.statePath());
        expect((yield* exactNotice()).structuredContent).toEqual({
          status: 'terminal-empty',
          watchId: published.watchId,
          prUrl: noticed.envelope.state.pr,
          revision: drained.revision,
        });
        expect((yield* readNativeWatch(f.config, published.watchId))?.revision).toBe(drained.revision);
        expect(yield* f.fs.readFileString(f.statePath())).toBe(terminalRun);
      }).pipe(run),
    windowsRealGitFixtureTimeout,
  );

  effectIt.effect('drains an old binding only after its job and PR watch owner receipts settle', () =>
    Effect.gen(function* () {
      const priorDigest = EffectString.repeat(64)('b');
      const f = yield* fixture(
        ['one'],
        'pr',
        false,
        false,
        true,
        undefined,
        undefined,
        {},
        {
          generation: priorDigest,
          project: 'repo',
        },
      );
      yield* f.git(['remote', 'set-url', 'origin', 'https://github.com/example/repo.git']);
      const system = yield* SystemInfo;
      const repo = yield* f.fs.realPath(f.repo);
      const home = yield* f.fs.realPath(f.home);
      const taskConfig = {...f.config, agentContextHome: home, manifestPath: f.path.join(home, 'manifest.json')};
      const taskSystem = {...system, currentDirectory: () => repo, homeDirectory: home};
      yield* applyDevSkills(taskConfig, 'install', {agent: 'codex'}).pipe(
        Effect.provideService(SystemInfo, taskSystem),
      );
      const installed = yield* statusDevSkills(taskConfig, {agent: 'codex'}).pipe(
        Effect.provideService(SystemInfo, taskSystem),
      );
      expect(installed.targets[0]?.installedDigest).toBe(installed.bundle.digest);
      expect(priorDigest).not.toBe(installed.bundle.digest);
      yield* f.mutate('begin-phase', {phaseId: 'one'});
      const work = object(
        yield* runNativeTaskAction(f.config, {command: 'work', runId: 'native-run', callerCwd: f.repo, packet}),
      );
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "watched PR result";\n');
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'Watched PR result']);
      const snapshot = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-snapshot',
          runId: 'native-run',
          callerCwd: f.repo,
          workRef: String(work.workRef),
        }),
      );
      const snapshotRef = String(snapshot.snapshotRef);
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
      yield* f.git(['commit', '--allow-empty', '-m', 'Same-tree watch build marker']);
      const validation = object(
        yield* runNativeTaskAction(f.config, {
          command: 'record-validation',
          runId: 'native-run',
          callerCwd: f.repo,
          snapshotRef,
          validation: {
            checks: [{command: 'private PR check', result: 'passed', evidence: 'Private test fixture passed.'}],
            acceptance: [
              {criterion: 'one works', result: 'passed', evidence: 'The committed change meets acceptance.'},
            ],
          },
        }),
      );
      const validationRef = String(validation.validationRef);
      const headSha = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
      const pr = {
        url: 'https://github.com/example/repo/pull/2',
        headSha,
        branch: 'feature/one',
        baseBranch: 'main',
        state: 'open',
      };
      const publication = {exemption: 'small-fix', reason: 'Private fixture authority input.'};
      const card = object(
        yield* runNativeTaskAction(f.config, {
          command: 'deliver-pr',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef,
          commitEvidence: 'Private fixture commit ' + headSha,
          pr,
          publication,
        }),
      );
      const deliveryRef = String(card.deliveryRef);
      const watchIdentity = EffectString.slice(0, 48)(sha256HexSync('native-run\none'));
      const watchId = 'pr-' + watchIdentity;
      const consumerId = 'task-' + watchIdentity;
      const wakeupId = consumerId;
      const now = yield* Clock.currentTimeMillis;
      const wakeup = {
        host: 'codex' as const,
        executable: '/usr/bin/codex',
        threadId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      };
      const watchFile = f.path.join(
        f.config.agentContextHome,
        'workflow-automations',
        'native-watch-v1',
        watchId + '.json',
      );
      const missingHost = yield* runNativeTaskAction(f.config, {
        command: 'watch-pr',
        operation: 'start',
        runId: 'native-run',
        callerCwd: f.repo,
        validationRef,
        deliveryRef,
      }).pipe(Effect.result);
      expect(missingHost).toMatchObject({failure: {code: 'host-registration-required'}});
      expect(yield* readNativeWatch(f.config, watchId)).toBeUndefined();
      const discoveryState = yield* f.fs.readFileString(f.statePath());
      const discoveryCommandService = yield* CommandExecutor;
      const discoverySystemService = yield* SystemInfo;
      const discoveryCommands = CommandExecutor.of({
        ...discoveryCommandService,
        execute: (executable, args, options) =>
          EffectString.startsWith('/canonical-codex/')(executable) && args[0] === 'queue' && args[1] === '--help'
            ? Effect.succeed({
                exitCode: 0,
                stderr: '',
                stdout:
                  'Usage: codex queue [OPTIONS]\n\nOptions:\n      --thread <THREAD>\n          Thread UUID\n      --message <MESSAGE>\n          Message body\n',
              })
            : discoveryCommandService.execute(executable, args, options),
      });
      const discoveryFileSystem = FileSystem.FileSystem.of({
        ...f.fs,
        realPath: candidate => {
          if (candidate === f.home + '/.local/bin/codex') return Effect.succeed('/canonical-codex/home/codex');
          if (candidate === '/usr/local/bin/codex') return Effect.succeed('/canonical-codex/local/codex');
          if (candidate === '/usr/bin/codex') return Effect.succeed('/canonical-codex/system/codex');
          return f.fs.realPath(candidate);
        },
      });
      const discoverySystem = SystemInfo.of({...discoverySystemService, platform: 'linux', homeDirectory: f.home});
      const ambiguousDiscovery = yield* runNativeTaskAction(f.config, {
        command: 'watch-pr',
        operation: 'start',
        runId: 'native-run',
        callerCwd: f.repo,
        validationRef,
        deliveryRef,
        wakeup: {host: 'codex', threadId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'},
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, discoveryFileSystem),
        Effect.provideService(CommandExecutor, discoveryCommands),
        Effect.provideService(SystemInfo, discoverySystem),
        Effect.result,
      );
      expect(ambiguousDiscovery).toMatchObject({failure: {code: 'host-queue-incompatible'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(discoveryState);
      expect(yield* readNativeWatch(f.config, watchId)).toBeUndefined();
      // Process-boundary adapter: simulate a detached collector's startup acknowledgement without
      // launching a process or contacting a provider. This exercises the real task start and watch engine.
      const commands = yield* CommandExecutor;
      const watchSystem = yield* SystemInfo;
      const processAdapterContext = yield* Effect.context<
        FileSystem.FileSystem | Path.Path | SecureRandom.SecureRandom
      >();
      let spawnCalls = 0;
      let preflightCalls = 0;
      let collectorAlive = true;
      const fakeCommands = CommandExecutor.of({
        ...commands,
        execute: (executable, args, options) => {
          if (executable === wakeup.executable && args.length === 2 && args[0] === 'queue' && args[1] === '--help') {
            preflightCalls += 1;
            return Effect.succeed({
              exitCode: 0,
              stderr: '',
              stdout:
                'Usage: codex queue [OPTIONS]\n\nOptions:\n      --thread <THREAD>\n          Thread UUID\n      --message <MESSAGE>\n          Message body\n',
            });
          }
          return commands.execute(executable, args, options);
        },
        spawnDetached: () =>
          Effect.gen(function* () {
            spawnCalls += 1;
            collectorAlive = true;
            const starting = yield* readNativeWatch(f.config, watchId);
            if (!starting?.envelope.collector) return false;
            yield* writeNativeWatch(
              f.config,
              {
                ...starting.envelope,
                collector: {
                  ...starting.envelope.collector,
                  pid: 77777,
                  startIdentity: 'fixture-process',
                  status: 'running',
                },
              },
              starting.revision,
            );
            return true;
          }).pipe(
            Effect.provide(processAdapterContext),
            Effect.orElseSucceed(() => false),
          ),
      });
      const fakeSystem = SystemInfo.of({
        ...watchSystem,
        isProcessRunning: pid => pid === 77777 && collectorAlive,
        processStartIdentity: () => Effect.succeed(EffectOption.getOrUndefined(EffectOption.none<string>())),
        canonicalProcessStartIdentity: () => Effect.succeed(EffectOption.getOrUndefined(EffectOption.none<string>())),
      });
      const runBytesBeforeStart = yield* f.fs.readFileString(f.statePath());
      const started = object(
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'start',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef,
          deliveryRef,
          wakeup,
        }).pipe(Effect.provideService(CommandExecutor, fakeCommands), Effect.provideService(SystemInfo, fakeSystem)),
      );
      expect(started).toMatchObject({
        status: 'watching',
        watchId,
        prUrl: pr.url,
        consumerId,
        hostReceipt: null,
        receipt: {pr: {state: 'open'}, watch: {state: 'active'}},
      });
      expect(spawnCalls).toBe(1);
      expect(preflightCalls).toBe(1);
      let startedWatch = yield* readNativeWatch(f.config, watchId);
      if (!startedWatch) throw new Error('The task watch start did not persist canonical watch state.');
      expect(startedWatch.envelope.state.pr).toBe(pr.url);
      expect(startedWatch.envelope.state.consumer).toMatchObject({id: consumerId, wakeupId});
      expect(startedWatch.envelope.notification?.target).toEqual(wakeup);
      expect(startedWatch.envelope.collector).toMatchObject({status: 'running', pid: 77777});
      // Simulate a start that stopped after the watch started and before it recorded the delivery.
      yield* f.fs.writeFileString(f.statePath(), runBytesBeforeStart);
      const provisionalState = yield* readNativeWorkflowState(taskConfig, 'native-run');
      expect(provisionalState?.state.cycle?.state.phases.one?.delivery).toBeUndefined();
      const recoveryInput = {runId: 'native-run', callerCwd: repo, phaseId: 'one'};
      const watchBytesBeforeRecovery = yield* f.fs.readFileString(watchFile);
      const foreignRecovery = new EffectMcpServerAdapter('test', '1', 'fixture');
      registerWorkflowTaskTool(foreignRecovery, taskConfig);
      const foreignResult = yield* foreignRecovery
        .invokeTool('workflow_task_watch_pr', {
          ...recoveryInput,
          runId: 'foreign-run',
          operation: 'inspect',
        })
        .pipe(Effect.result);
      expect(foreignResult._tag).toBe('Failure');
      expect(yield* f.fs.readFileString(watchFile)).toBe(watchBytesBeforeRecovery);
      const wrongPhaseResult = yield* foreignRecovery
        .invokeTool('workflow_task_watch_pr', {
          ...recoveryInput,
          phaseId: 'foreign-phase',
          operation: 'stop',
        })
        .pipe(Effect.result);
      expect(wrongPhaseResult._tag).toBe('Failure');
      expect(yield* f.fs.readFileString(watchFile)).toBe(watchBytesBeforeRecovery);
      const freshInspect = new EffectMcpServerAdapter('test', '1', 'fixture');
      registerWorkflowTaskTool(freshInspect, taskConfig);
      const inspected = object(
        object(
          yield* freshInspect.invokeTool('workflow_task_watch_pr', {
            ...recoveryInput,
            operation: 'inspect',
          }),
        ).structuredContent,
      );
      expect(inspected).toMatchObject({status: 'watch-updated', operation: 'inspect', watchId});
      expect(yield* f.fs.readFileString(watchFile)).toBe(watchBytesBeforeRecovery);
      const freshStop = new EffectMcpServerAdapter('test', '1', 'fixture');
      registerWorkflowTaskTool(freshStop, taskConfig);
      const stopped = object(
        object(
          yield* freshStop.invokeTool('workflow_task_watch_pr', {
            ...recoveryInput,
            operation: 'stop',
          }),
        ).structuredContent,
      );
      expect(stopped).toMatchObject({status: 'watch-updated', operation: 'stop', watchId});
      startedWatch = yield* readNativeWatch(f.config, watchId);
      expect(startedWatch?.envelope.stopRequested).toBe(true);
      if (!startedWatch) throw new Error('The recovered provisional watch disappeared.');
      const cutoverMcp = new EffectMcpServerAdapter('test', '1', 'fixture');
      registerWorkflowTaskTool(cutoverMcp, taskConfig);
      const cutoverInput = {
        callerCwd: repo,
        featureName: 'feature',
        installationTarget: 'codex',
        taskRef: 'native-run',
        intent: {
          title: 'feature',
          currentBehavior: 'The old run remains inspectable.',
          desiredChange: 'The old run receives an explicit drain outcome.',
          affectedPaths: ['source.ts'],
          acceptanceCriterion: 'The old binding and canonical history remain unchanged.',
          verification: 'Read the transition outcome and exact watch owner.',
          eligibilityRationale: 'One fixture task validates a bounded safe cutover.',
          eligibility: {status: 'eligible' as const},
          review: {required: false, reason: 'Private cutover fixture.'},
        },
      };
      const observeCutover = () =>
        Effect.gen(function* () {
          const response = object(
            yield* cutoverMcp
              .invokeTool('workflow_task_start', cutoverInput)
              .pipe(Effect.provideService(SystemInfo, fakeSystem)),
          );
          if (response.isError === true) throw new Error('The typed task-start cutover read was refused.');
          return object(response.structuredContent);
        });
      const provisionalRunBytes = yield* f.fs.readFileString(f.statePath());
      const provisionalOwners = yield* observeCutover();
      expect(provisionalOwners).toMatchObject({status: 'binding-transition', outcome: 'needs-drain'});
      expect(provisionalOwners.owners).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            owner: 'watch',
            watchId,
            status: 'needs-drain',
            reasons: expect.arrayContaining(['collector-still-owned-or-unverifiable']),
          }),
        ]),
      );
      expect(yield* f.fs.readFileString(f.statePath())).toBe(provisionalRunBytes);
      const event = {
        sequence: 1,
        id: watchId + ':1',
        source: 'comments' as const,
        kind: 'comment',
        key: 'comment-1',
        version: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        url: pr.url,
        at: now,
        removed: false,
      };
      const attemptId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
      const receiptId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
      const initialSources = EffectArray.map(
        ['comments', 'reviews', 'threads', 'checks', 'statuses'] as const,
        source => ({source, items: [], lastCompleteAt: now}),
      );
      yield* writeNativeWatch(
        f.config,
        {
          ...startedWatch.envelope,
          state: {
            ...startedWatch.envelope.state,
            head: headSha,
            prState: 'open',
            nextSequence: 2,
            acknowledged: 0,
            events: [event],
            sources: initialSources,
          },
          notification: {
            ...startedWatch.envelope.notification!,
            lastConsumerAt: now,
            outbox: {
              key: watchId + ':1:1',
              first: 1,
              last: 1,
              createdAt: now,
              attempts: 1,
              nextAttemptAt: now,
              attemptId,
              collectorToken: startedWatch.envelope.collector!.token,
              status: 'queued',
              receipt: receiptId,
              consumedThrough: 0,
            },
          },
        },
        startedWatch.revision,
      );
      startedWatch = yield* readNativeWatch(f.config, watchId);
      if (!startedWatch) throw new Error('The simulated host and provider input did not persist the open PR watch.');
      const openDelivery = object(
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'complete',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef,
          deliveryRef,
        }).pipe(Effect.provideService(SystemInfo, fakeSystem)),
      );
      expect(openDelivery).toMatchObject({
        status: 'delivered',
        receipt: {delivery: 'pr', pr: {...pr, state: 'open'}, watch: {state: 'active', consumerId}},
      });

      const root = object(object(f.exported.source).root);
      const acceptedJob = object(
        yield* f
          .call({
            ...f.base('job'),
            command: 'submit',
            work: {
              ...f.base('authoring'),
              command: 'save',
              document: f.document,
              ready: true,
              uri: root.uri,
              expectedRevision: root.revision,
            },
          })
          .pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false)),
      );
      expect(acceptedJob.status).toBe('accepted');
      const jobId = String(acceptedJob.jobId);
      const oldRunBytes = yield* f.fs.readFileString(f.statePath());
      const beforeOwnerDrain = yield* observeCutover();
      expect(beforeOwnerDrain).toMatchObject({
        status: 'binding-transition',
        outcome: 'needs-drain',
        binding: {generation: priorDigest},
      });
      expect(beforeOwnerDrain.owners).toEqual(
        expect.arrayContaining([
          expect.objectContaining({owner: 'job', jobId, status: 'accepted'}),
          expect.objectContaining({owner: 'watch', watchId, status: 'needs-drain'}),
        ]),
      );
      expect(yield* f.fs.readFileString(f.statePath())).toBe(oldRunBytes);

      const cancelAcceptedJob = object(yield* f.call({...f.base('job'), command: 'cancel', jobId}));
      expect(cancelAcceptedJob.stopRequested).toBe(true);
      const afterCancelOnly = yield* observeCutover();
      expect(afterCancelOnly.outcome).toBe('needs-drain');
      expect(afterCancelOnly.owners).toEqual(
        expect.arrayContaining([expect.objectContaining({owner: 'job', jobId, stopRequested: true})]),
      );
      const stoppedJob = object(yield* runNativeJobWorker(f.config, 'native-run', jobId, f.call));
      expect(stoppedJob.status).toBe('stopped-with-progress');
      const stoppedJobStatus = object(yield* f.call({...f.base('job'), command: 'status', jobId}));
      expect(stoppedJobStatus.status).toBe('stopped-with-progress');
      const stoppedJobOutcome = yield* observeCutover();
      expect(stoppedJobOutcome.outcome).toBe('needs-drain');
      expect(stoppedJobOutcome.owners).toEqual(
        expect.arrayContaining([expect.objectContaining({owner: 'job', jobId, status: 'stopped-with-progress'})]),
      );

      yield* runNativeTaskAction(f.config, {
        command: 'watch-pr',
        operation: 'stop',
        runId: 'native-run',
        callerCwd: f.repo,
        validationRef,
        deliveryRef,
      }).pipe(Effect.provideService(SystemInfo, fakeSystem));
      const stopRequestedWatch = yield* readNativeWatch(f.config, watchId);
      if (!stopRequestedWatch) throw new Error('The stopped watch receipt disappeared.');
      expect(stopRequestedWatch.envelope.stopRequested).toBe(true);
      collectorAlive = false;
      // The fake owned collector observes stop and persists its stopped receipt; no real process is signaled.
      yield* writeNativeWatch(
        f.config,
        {
          ...stopRequestedWatch.envelope,
          collector: {...stopRequestedWatch.envelope.collector!, status: 'stopped', reason: 'stop-requested'},
        },
        stopRequestedWatch.revision,
      );
      const stoppedCollector = yield* readNativeWatch(f.config, watchId);
      expect(stoppedCollector?.envelope.collector?.status).toBe('stopped');
      const stopObservedOutcome = yield* observeCutover();
      expect(stopObservedOutcome.outcome).toBe('needs-drain');
      expect(stopObservedOutcome.owners).toEqual(
        expect.arrayContaining([
          expect.objectContaining({owner: 'watch', watchId, status: 'needs-drain'}),
          expect.objectContaining({owner: 'job', jobId, status: 'stopped-with-progress'}),
        ]),
      );

      const resumedJob = object(
        yield* f
          .call({...f.base('job'), command: 'resume', jobId})
          .pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false)),
      );
      expect(resumedJob.status).toBe('accepted');
      const completedJob = object(yield* runNativeJobWorker(f.config, 'native-run', jobId, f.call));
      expect(completedJob.status).toBe('completed');
      const completedJobReadback = object(yield* f.call({...f.base('job'), command: 'result', jobId}));
      expect(completedJobReadback.status).toBe('completed');
      expect(completedJobReadback).toHaveProperty('result');
      collectorAlive = false;
      const stoppedWatchContinuation = object(
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'start',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef,
          deliveryRef,
          wakeup,
        }).pipe(Effect.provideService(CommandExecutor, fakeCommands), Effect.provideService(SystemInfo, fakeSystem)),
      );
      expect(stoppedWatchContinuation.status).toBe('watching');
      expect(spawnCalls).toBe(2);
      startedWatch = yield* readNativeWatch(f.config, watchId);
      if (!startedWatch) throw new Error('The continued task watch did not persist its owner receipt.');
      const continuedOutcome = yield* observeCutover();
      expect(continuedOutcome.outcome).toBe('needs-drain');
      expect(continuedOutcome.owners).toEqual(
        expect.arrayContaining([expect.objectContaining({owner: 'watch', watchId, status: 'needs-drain'})]),
      );
      const state = {
        ...startedWatch.envelope.state,
        head: headSha,
        prState: 'merged' as const,
        nextSequence: 2,
        acknowledged: 0,
        events: [event],
        sources: EffectArray.map(['comments', 'reviews', 'threads', 'checks', 'statuses'] as const, source => ({
          source,
          items: [],
          lastCompleteAt: now,
        })),
      };
      // Test-only host adapter receipt: this fixture never contacts GitHub or an external host.
      collectorAlive = false;
      yield* writeNativeWatch(
        f.config,
        {
          ...startedWatch.envelope,
          state,
          collector: {
            ...startedWatch.envelope.collector!,
            status: 'terminal',
            reason: 'merged',
            consecutiveErrors: 0,
          },
          notification: {
            consumerId,
            wakeupId,
            target: wakeup,
            notifiedThrough: 0,
            lastConsumerAt: now,
            outbox: {
              key: watchId + ':1:1',
              first: 1,
              last: 1,
              createdAt: now,
              attempts: 1,
              nextAttemptAt: now,
              attemptId,
              collectorToken: startedWatch.envelope.collector!.token,
              status: 'queued',
              receipt: receiptId,
              consumedThrough: 0,
            },
          },
        },
        startedWatch.revision,
      );
      const before = yield* f.fs.readFileString(f.statePath());
      const taskState = yield* readNativeWorkflowState(f.config, 'native-run');
      if (!taskState) throw new Error('Expected a current native task.');
      const beforeForeignHost = yield* f.fs.readFileString(watchFile);
      const foreignHost = yield* runNativeTaskAction(f.config, {
        command: 'watch-pr',
        operation: 'start',
        runId: 'native-run',
        callerCwd: f.repo,
        validationRef,
        deliveryRef,
        wakeup: {...wakeup, threadId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'},
      }).pipe(
        Effect.provideService(CommandExecutor, fakeCommands),
        Effect.provideService(SystemInfo, fakeSystem),
        Effect.result,
      );
      expect(foreignHost).toMatchObject({failure: {code: 'wakeup-recovery-required'}});
      expect(yield* f.fs.readFileString(watchFile)).toBe(beforeForeignHost);
      const noticeRef = encodeNativeTaskActionRef({
        version: 1,
        kind: 'delivery',
        runId: 'native-run',
        generationHash: sha256HexSync(taskState.state.generation),
        watchId,
        consumerId,
        wakeupId,
        eventKey: watchId + ':1:1',
        watchAttemptId: attemptId,
      });
      const beforeForeignNotice = yield* f.fs.readFileString(watchFile);
      const foreignNotice = encodeNativeTaskActionRef({
        version: 1,
        kind: 'delivery',
        runId: 'native-run',
        generationHash: sha256HexSync(taskState.state.generation),
        watchId,
        consumerId,
        wakeupId,
        eventKey: watchId + ':2:2',
        watchAttemptId: attemptId,
      });
      expect(
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'relay',
          noticeRef: foreignNotice,
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef,
          deliveryRef,
        }).pipe(Effect.result),
      ).toMatchObject({failure: {code: 'foreign-notice-route'}});
      expect(yield* f.fs.readFileString(watchFile)).toBe(beforeForeignNotice);
      const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
      registerWorkflowTaskTool(mcp, f.config);
      const relayed = object(
        object(
          yield* mcp.invokeTool('workflow_task_watch_pr', {
            operation: 'relay',
            noticeRef,
            runId: 'native-run',
            callerCwd: f.repo,
            validationRef,
            deliveryRef,
          }),
        ).structuredContent,
      );
      expect(relayed).toMatchObject({
        status: 'watch-updated',
        result: {delivery: {id: expect.any(String), events: [{id: watchId + ':1'}]}},
        eventRefs: [expect.any(String)],
      });
      const watchDeliveryRef = String(relayed.watchDeliveryRef);
      const eventRefs: unknown[] = EffectArray.isArray(relayed.eventRefs) ? relayed.eventRefs : [];
      if (typeof eventRefs[0] !== 'string') throw new Error('Expected an opaque event reference.');
      yield* runNativeTaskAction(f.config, {
        command: 'watch-pr',
        operation: 'disposition',
        watchDeliveryRef,
        dispositions: [
          {
            eventRef: eventRefs[0],
            status: 'open',
            reason: 'Review follow-up remains open.',
            evidence: 'Private fixture event.',
          },
        ],
        runId: 'native-run',
        callerCwd: f.repo,
        validationRef,
        deliveryRef,
      });
      const acked = object(
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'ack',
          watchDeliveryRef,
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef,
          deliveryRef,
        }),
      );
      expect(acked.status).toBe('watch-updated');
      let afterAck = yield* readNativeWatch(f.config, watchId);
      expect(afterAck?.envelope.state.work).toMatchObject([{eventId: watchId + ':1', status: 'open'}]);
      expect(afterAck?.envelope.state.acknowledged).toBe(1);
      expect(afterAck?.envelope.notification?.outbox).toMatchObject({
        status: 'queued',
        receipt: receiptId,
        consumedThrough: 1,
      });
      yield* runNativeTaskAction(f.config, {
        command: 'watch-pr',
        operation: 'work-disposition',
        runId: 'native-run',
        callerCwd: f.repo,
        validationRef,
        deliveryRef,
        watchDeliveryRef,
        dispositions: [
          {
            eventRef: String(eventRefs[0]),
            status: 'open',
            reason: 'Review follow-up remains open.',
            evidence: 'Private fixture event.',
          },
        ],
      });
      afterAck = yield* readNativeWatch(f.config, watchId);
      if (!afterAck) throw new Error('Expected the ACKed watch.');
      // Simulate another provider page, then retain its rows through the public task protocol.
      const expectedIds = Array.from({length: 19}, (_, index) => watchId + ':' + (index + 1));
      const largeReason = EffectString.repeat(256)('"\\é猫');
      const largeEvidence = EffectString.repeat(512)('😀\\n');
      yield* writeNativeWatch(
        f.config,
        {
          ...afterAck.envelope,
          notification: {
            ...afterAck.envelope.notification!,
            // The fake collector finalizes the first actual host receipt after notice readback and ACK.
            notifiedThrough: 1,
            lastReceipt: {key: watchId + ':1:1', receipt: receiptId, attemptId, kind: 'queued-message', at: now},
            outbox: {
              ...afterAck.envelope.notification!.outbox!,
              key: watchId + ':2:19',
              attemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              receipt: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              first: 2,
              last: 19,
              consumedThrough: 0,
            },
          },
          state: {
            ...afterAck.envelope.state,
            nextSequence: 20,
            events: EffectArray.map(expectedIds.slice(1), (id, index) => ({
              ...event,
              id,
              sequence: index + 2,
              key: 'comment-' + (index + 2),
              ...(index === 0 ? {url: 'https://github.com/acme/repo/issues/1#' + EffectString.repeat(1980)('x')} : {}),
            })),
          },
        },
        afterAck.revision,
      );
      const watchRequest = {runId: 'native-run', callerCwd: f.repo, validationRef, deliveryRef};
      const arrival = object(
        yield* runNativeTaskAction(f.config, {command: 'watch-pr', operation: 'inspect', ...watchRequest}),
      );
      for (;;) {
        const relay = object(
          yield* runNativeTaskAction(f.config, {
            command: 'watch-pr',
            operation: 'relay',
            ...watchRequest,
            noticeRef: String(arrival.noticeRef),
          }),
        );
        const refs = relay.eventRefs;
        if (!EffectArray.isArray(refs) || !refs.length) break;
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'disposition',
          ...watchRequest,
          watchDeliveryRef: String(relay.watchDeliveryRef),
          dispositions: EffectArray.map(refs, ref => ({
            eventRef: String(ref),
            status: 'blocked',
            reason:
              decodeNativeTaskActionRef(String(ref))?.watchEventId === expectedIds[1]
                ? largeReason
                : 'Retained follow-up',
            evidence:
              decodeNativeTaskActionRef(String(ref))?.watchEventId === expectedIds[1]
                ? largeEvidence
                : 'Fixture provider page',
          })),
        });
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'ack',
          ...watchRequest,
          watchDeliveryRef: String(relay.watchDeliveryRef),
        });
      }
      const settled = yield* readNativeWatch(f.config, watchId);
      if (!settled) throw new Error('Expected the retained work.');
      // A stopped collector must not prevent retained work resolution or be relaunched by it.
      yield* writeNativeWatch(
        f.config,
        {...settled.envelope, collector: {...settled.envelope.collector!, status: 'stopped'}},
        settled.revision,
      );
      const spawnsBeforeWork = spawnCalls;
      const seen: string[] = [];
      let workOffset = 0;
      let workViewDigest: string | undefined;
      let retainedRef = '';
      let detailContinuation: Record<string, unknown> | undefined;
      let pageCount = 0;
      for (;;) {
        const response = object(
          yield* mcp.invokeTool('workflow_task_watch_pr', {
            operation: 'work',
            ...watchRequest,
            workOffset,
            ...(workViewDigest ? {workViewDigest} : {}),
          }),
        );
        expect(response.isError).not.toBe(true);
        const content = object(response.structuredContent);
        expect(new TextEncoder().encode(JSON.stringify(content)).byteLength).toBeLessThanOrEqual(8192);
        const page = object(object(content.result).work);
        workViewDigest = String(page.workViewDigest);
        const rows = EffectArray.isArray(page.items) ? page.items : [];
        for (const row of rows) {
          const item = object(row);
          seen.push(String(item.eventId));
          if (!retainedRef) retainedRef = String(item.eventRef);
          if (item.eventId === expectedIds[1]) detailContinuation = object(item.detail);
        }
        pageCount += 1;
        if (page.nextOffset === null) break;
        workOffset = Number(page.nextOffset);
      }
      let cliPage: Record<string, unknown> | undefined;
      const workCli = Command.make('workflow-automation').pipe(
        Command.withSubcommands([
          makeNativeTaskPrWatchCommand(options =>
            runNativeTaskAction(f.config, {
              command: 'watch-pr',
              ...watchRequest,
              operation: options.operation,
              ...(options.workOffset === undefined ? {} : {workOffset: options.workOffset}),
              ...(options.workViewDigest === undefined ? {} : {workViewDigest: options.workViewDigest}),
              ...(options.workEventRef === undefined ? {} : {workEventRef: options.workEventRef}),
              ...(options.offsetBytes === undefined ? {} : {offsetBytes: options.offsetBytes}),
              ...(options.sourceDigest === undefined ? {} : {sourceDigest: options.sourceDigest}),
            }).pipe(
              Effect.tap(value =>
                Effect.sync(() => {
                  cliPage = object(value);
                }),
              ),
              Effect.asVoid,
            ),
          ),
        ]),
      );
      yield* Command.runWith(workCli, {version: 'fixture'})([
        'watch-pr',
        '--run-id',
        'native-run',
        '--caller-cwd',
        f.repo,
        '--operation',
        'work',
        '--work-offset',
        '1',
        '--work-view-digest',
        String(workViewDigest),
      ]);
      expect(object(object(cliPage?.result).work).offset).toBe(1);
      expect(pageCount).toBeGreaterThan(1);
      expect(seen).toEqual(expectedIds);
      if (!detailContinuation) throw new Error('Expected an executable retained work detail continuation.');
      expect(detailContinuation).toEqual({
        operation: 'work-detail',
        workEventRef: expect.any(String),
        offsetBytes: 0,
        sourceDigest: expect.any(String),
      });
      const expectedDetailRow = EffectOption.getOrThrow(
        EffectArray.findFirst(settled.envelope.state.work, row => row.eventId === expectedIds[1]),
      );
      const expectedDetailText = stableJson(expectedDetailRow);
      const expectedDetailBytes = new TextEncoder().encode(expectedDetailText);
      const beforeDetails = yield* f.fs.readFileString(watchFile);
      const chunks: string[] = [];
      let continuation = detailContinuation;
      let detailPageCount = 0;
      for (;;) {
        let content: Record<string, unknown>;
        if (detailPageCount % 2 === 0) {
          const response = object(yield* mcp.invokeTool('workflow_task_watch_pr', {...watchRequest, ...continuation}));
          expect(response.isError).not.toBe(true);
          content = object(response.structuredContent);
        } else {
          yield* Command.runWith(workCli, {version: 'fixture'})([
            'watch-pr',
            '--run-id',
            'native-run',
            '--caller-cwd',
            f.repo,
            '--operation',
            String(continuation.operation),
            '--work-event-ref',
            String(continuation.workEventRef),
            '--offset-bytes',
            String(continuation.offsetBytes),
            '--source-digest',
            String(continuation.sourceDigest),
          ]);
          content = object(cliPage);
        }
        expect(new TextEncoder().encode(JSON.stringify(content)).byteLength).toBeLessThanOrEqual(8192);
        const page = object(object(content.result).workDetail);
        expect(page.sourceDigest).toBe(sha256HexSync(expectedDetailText));
        expect(page.totalBytes).toBe(expectedDetailBytes.byteLength);
        expect(page.offsetBytes).toBe(continuation.offsetBytes);
        const text = String(page.text);
        chunks.push(text);
        const end = Number(page.offsetBytes) + new TextEncoder().encode(text).byteLength;
        expect(
          new TextDecoder('utf-8', {fatal: true}).decode(expectedDetailBytes.subarray(Number(page.offsetBytes), end)),
        ).toBe(text);
        detailPageCount += 1;
        if (page.nextOffsetBytes === null) {
          expect(end).toBe(expectedDetailBytes.byteLength);
          break;
        }
        expect(page.nextOffsetBytes).toBe(end);
        continuation = {...continuation, offsetBytes: page.nextOffsetBytes, sourceDigest: page.sourceDigest};
      }
      expect(detailPageCount).toBeGreaterThan(2);
      expect(EffectArray.join(chunks, '')).toBe(expectedDetailText);
      expect(JSON.parse(EffectArray.join(chunks, ''))).toEqual(expectedDetailRow);
      expect(yield* f.fs.readFileString(watchFile)).toBe(beforeDetails);
      expect(spawnCalls).toBe(spawnsBeforeWork);
      const detailRef = decodeNativeTaskActionRef(String(detailContinuation.workEventRef));
      if (!detailRef) throw new Error('Expected the returned opaque detail row reference.');
      const splitOffset = EffectOption.getOrThrow(
        EffectArray.findFirstIndex(Array.from(expectedDetailBytes), byte => (byte & 0xc0) === 0x80),
      );
      for (const invalid of [
        {...detailContinuation, sourceDigest: EffectString.repeat(64)('a')},
        {...detailContinuation, offsetBytes: expectedDetailBytes.byteLength + 1},
        {...detailContinuation, offsetBytes: splitOffset},
        {...detailContinuation, workEventRef: encodeNativeTaskActionRef({...detailRef, consumerId: 'foreign'})},
        {
          ...detailContinuation,
          workEventRef: encodeNativeTaskActionRef({...detailRef, workRowDigest: EffectString.repeat(64)('a')}),
        },
      ]) {
        expect(
          (yield* mcp.invokeTool('workflow_task_watch_pr', {...watchRequest, ...invalid}).pipe(Effect.result))._tag,
        ).toBe('Failure');
        expect(yield* f.fs.readFileString(watchFile)).toBe(beforeDetails);
      }
      const beforeInvalid = yield* f.fs.readFileString(watchFile);
      const ref = decodeNativeTaskActionRef(retainedRef);
      if (!ref) throw new Error('Expected a returned retained work reference.');
      const disposition = {
        eventRef: retainedRef,
        status: 'resolved' as const,
        reason: 'Settled follow-up',
        evidence: 'Fixture handled',
      };
      for (const dispositions of [
        [{...disposition, reason: 'Invalid\ncontrol'}],
        [disposition, disposition],
        [disposition, {...disposition, eventRef: String(eventRefs[0])}],
        [disposition, {...disposition, eventRef: encodeNativeTaskActionRef({...ref, consumerId: 'foreign'})}],
        [{...disposition, eventRef: encodeNativeTaskActionRef({...ref, workRowDigest: EffectString.repeat(64)('a')})}],
      ]) {
        expect(
          (yield* runNativeTaskAction(f.config, {
            command: 'watch-pr',
            operation: 'work-disposition',
            ...watchRequest,
            dispositions,
          }).pipe(Effect.result))._tag,
        ).toBe('Failure');
        expect(yield* f.fs.readFileString(watchFile)).toBe(beforeInvalid);
      }
      const beforeExpiry = yield* readNativeWatch(f.config, watchId);
      if (!beforeExpiry?.envelope.state.consumer) throw new Error('Expected the bound consumer.');
      const liveConsumer = beforeExpiry.envelope.state.consumer;
      yield* writeNativeWatch(
        f.config,
        {
          ...beforeExpiry.envelope,
          state: {
            ...beforeExpiry.envelope.state,
            consumer: {...liveConsumer, lastSeenAt: 0, leaseUntil: liveConsumer.leaseMilliseconds},
          },
        },
        beforeExpiry.revision,
      );
      const expiredBytes = yield* f.fs.readFileString(watchFile);
      const expiredDetail = object(
        yield* mcp.invokeTool('workflow_task_watch_pr', {...watchRequest, ...detailContinuation}),
      );
      expect(expiredDetail.isError).not.toBe(true);
      expect(yield* f.fs.readFileString(watchFile)).toBe(expiredBytes);
      expect(
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'work-disposition',
          ...watchRequest,
          dispositions: [disposition],
        }).pipe(Effect.result),
      ).toMatchObject({
        failure: {
          code: 'invalid-watch',
          message: expect.stringContaining('does not own a live lease'),
          next: {tool: 'workflow_task_watch_pr', command: 'renew', arguments: {operation: 'renew'}},
        },
      });
      expect(yield* f.fs.readFileString(watchFile)).toBe(expiredBytes);
      const expiredWatch = yield* readNativeWatch(f.config, watchId);
      if (!expiredWatch) throw new Error('Expected the expired watch.');
      yield* writeNativeWatch(
        f.config,
        {...expiredWatch.envelope, state: {...expiredWatch.envelope.state, consumer: liveConsumer}},
        expiredWatch.revision,
      );
      // Collector-only revision changes do not stale an otherwise identical complete work view.
      const collectorChurn = yield* readNativeWatch(f.config, watchId);
      if (!collectorChurn) throw new Error('Expected watch before collector churn.');
      yield* writeNativeWatch(
        f.config,
        {
          ...collectorChurn.envelope,
          metrics: {
            ...collectorChurn.envelope.metrics,
            consumerReads: collectorChurn.envelope.metrics.consumerReads + 1,
          },
        },
        collectorChurn.revision,
      );
      yield* runNativeTaskAction(f.config, {
        command: 'watch-pr',
        operation: 'work-disposition',
        ...watchRequest,
        dispositions: [disposition],
      });
      const beforeStale = yield* f.fs.readFileString(watchFile);
      // A continuation with a superseded view digest starts a fresh view instead of failing.
      const restartedPage = object(
        object(
          object(
            yield* runNativeTaskAction(f.config, {
              command: 'watch-pr',
              operation: 'work',
              ...watchRequest,
              workOffset: 1,
              workViewDigest,
            }),
          ).result,
        ).work,
      );
      expect(restartedPage).toMatchObject({offset: 0, restarted: true});
      expect(restartedPage.workViewDigest).not.toBe(workViewDigest);
      // The changed row's reference is stale and recovers by reloading work, never by task finish.
      expect(
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'work-disposition',
          ...watchRequest,
          dispositions: [disposition],
        }).pipe(Effect.result),
      ).toMatchObject({
        failure: {
          code: 'stale-watch-event-ref',
          next: {tool: 'workflow_task_watch_pr', command: 'work', arguments: {operation: 'work', workOffset: 0}},
        },
      });
      expect(yield* f.fs.readFileString(watchFile)).toBe(beforeStale);
      // An unchanged row keeps its reference after another row changed.
      expect(
        object(yield* mcp.invokeTool('workflow_task_watch_pr', {...watchRequest, ...detailContinuation})).isError,
      ).not.toBe(true);
      expect(yield* f.fs.readFileString(watchFile)).toBe(beforeStale);
      yield* runNativeTaskAction(f.config, {
        command: 'watch-pr',
        operation: 'work-disposition',
        ...watchRequest,
        dispositions: [{...disposition, eventRef: String(detailContinuation.workEventRef)}],
      });
      expect(
        EffectArray.findFirst(
          (yield* readNativeWatch(f.config, watchId))?.envelope.state.work ?? [],
          row => row.eventId === expectedIds[1],
        ).pipe(
          EffectOption.map(row => row.status),
          EffectOption.getOrUndefined,
        ),
      ).toBe('resolved');
      // Read each fresh view after mutation and settle the remaining rows without a delivery ID.
      for (;;) {
        const content = object(
          yield* runNativeTaskAction(f.config, {command: 'watch-pr', operation: 'work', ...watchRequest}),
        );
        const page = object(object(content.result).work);
        const rows = EffectArray.filter(
          EffectArray.isArray(page.items) ? page.items : [],
          row => object(row).status === 'open' || object(row).status === 'blocked',
        );
        if (!rows.length) break;
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'work-disposition',
          ...watchRequest,
          dispositions: EffectArray.map(rows, row => ({...disposition, eventRef: String(object(row).eventRef)})),
        });
      }
      expect(
        EffectArray.every(
          (yield* readNativeWatch(f.config, watchId))?.envelope.state.work ?? [],
          row => row.status === 'resolved',
        ),
      ).toBe(true);
      expect(spawnCalls).toBe(spawnsBeforeWork);
      const afterWork = yield* readNativeWatch(f.config, watchId);
      if (!afterWork) throw new Error('Expected the settled watch.');
      yield* writeNativeWatch(
        f.config,
        {...afterWork.envelope, collector: settled.envelope.collector},
        afterWork.revision,
      );
      const cycleBeforeSourceDrift = yield* f.fs.readFileString(f.statePath());
      const watchBeforeSourceDrift = yield* f.fs.readFileString(watchFile);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "drifted after watch";\n');
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'published branch source drift']);
      const sourceDrift = yield* runNativeTaskAction(f.config, {
        command: 'watch-pr',
        operation: 'complete',
        runId: 'native-run',
        callerCwd: f.repo,
        validationRef,
        deliveryRef,
      }).pipe(Effect.result);
      expect(sourceDrift._tag).toBe('Failure');
      expect(yield* f.fs.readFileString(f.statePath())).toBe(cycleBeforeSourceDrift);
      expect(yield* f.fs.readFileString(watchFile)).toBe(watchBeforeSourceDrift);
      yield* f.git(['reset', '--hard', headSha]);
      const completed = object(
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'complete',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef,
          deliveryRef,
        }),
      );
      expect(completed).toMatchObject({
        status: 'delivered',
        receipt: {
          delivery: 'pr',
          pr: {...pr, state: 'merged'},
          publication,
          watch: {prUrl: pr.url, headSha, state: 'terminal', consumerId},
        },
      });
      expect(yield* f.fs.readFileString(f.statePath())).not.toBe(before);
      const stored = yield* readNativeWatch(f.config, watchId);
      expect(stored?.envelope.state.pr).toBe(pr.url);
      expect(stored?.envelope.state.head).toBe(headSha);
      expect(stored?.envelope.state.consumer?.id).toBe(consumerId);
      collectorAlive = false;
      const drainedInputBytes = yield* f.fs.readFileString(f.statePath());
      const drainedJournalBytes = yield* f.fs.readFileString(f.journalPath(taskState.state.bindingId));
      const beforeDrainedState = yield* readNativeWorkflowState(taskConfig, 'native-run');
      const drained = yield* observeCutover();
      expect(drained).toMatchObject({
        status: 'binding-transition',
        outcome: 'drained',
        binding: {
          runId: 'native-run',
          generation: priorDigest,
          bindingId: taskState.state.bindingId,
        },
        selectedTarget: {installedDigest: installed.bundle.digest},
        owners: [],
      });
      expect(yield* f.fs.readFileString(f.statePath())).toBe(drainedInputBytes);
      expect(yield* f.fs.readFileString(f.journalPath(taskState.state.bindingId))).toBe(drainedJournalBytes);
      const afterDrainedState = yield* readNativeWorkflowState(taskConfig, 'native-run');
      expect(afterDrainedState?.state.generation).toBe(priorDigest);
      expect(afterDrainedState?.state.bindingId).toBe(taskState.state.bindingId);
      expect(afterDrainedState?.state.operations).toEqual(beforeDrainedState?.state.operations);
      expect(yield* observeCutover()).toEqual(drained);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(drainedInputBytes);
      expect(stored?.envelope.notification?.outbox?.receipt).toBe('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
      const closeout = object(
        yield* runNativeTaskAction(f.config, {
          command: 'finish',
          runId: 'native-run',
          callerCwd: f.repo,
          proposal,
        }).pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false)),
      );
      expect(closeout).toMatchObject({status: 'pending', stage: 'prepare'});
      const prepareJobId = decodeNativeTaskActionRef(String(closeout.prepareRef))?.jobId;
      if (!prepareJobId) throw new Error('Expected an opaque closeout prepare reference.');
      expect(object(yield* runNativeJobWorker(f.config, 'native-run', prepareJobId, f.call)).status).toBe('completed');
      const journal = yield* readNativeCloseoutJournal(f.config, 'native-run', decodeJournal);
      expect(journal?.state.proposal.watchWork).toEqual([]);
      const finishing = object(
        yield* runNativeTaskAction(f.config, {
          command: 'finish',
          runId: 'native-run',
          callerCwd: f.repo,
          proposal,
          prepareRef: String(closeout.prepareRef),
        }).pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false)),
      );
      expect(finishing).toMatchObject({status: 'pending', stage: 'finish'});
      const finishJobId = decodeNativeTaskActionRef(String(finishing.finishRef))?.jobId;
      if (!finishJobId) throw new Error('Expected an opaque closeout finish reference.');
      expect(object(yield* runNativeJobWorker(f.config, 'native-run', finishJobId, f.call)).status).toBe('completed');
      const closeoutCompleted = object(
        yield* runNativeTaskAction(f.config, {
          command: 'finish',
          runId: 'native-run',
          callerCwd: f.repo,
          finishRef: String(finishing.finishRef),
        }).pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false)),
      );
      expect(closeoutCompleted).toMatchObject({status: 'complete'});
      const closed = yield* readNativeCloseoutJournal(f.config, 'native-run', decodeJournal);
      expect(closed?.state.status).toBe('complete');
      expect(closed?.state.proposal.watchWork).toEqual([]);
      const terminal = yield* readNativeWatch(f.config, watchId);
      if (!terminal) throw new Error('Expected a terminal canonical watch.');
      const empty = {...terminal.envelope, state: {...terminal.envelope.state, work: []}};
      yield* writeNativeWatch(f.config, empty, terminal.revision);
      const terminalBytes = yield* f.fs.readFileString(watchFile);
      for (const operation of ['relay', 'ack', 'disposition'] as const) {
        const result = object(
          yield* runNativeTaskAction(f.config, {
            command: 'watch-pr',
            operation,
            watchDeliveryRef,
            runId: 'native-run',
            callerCwd: f.repo,
            validationRef,
            deliveryRef,
          }),
        );
        expect(result.status).toBe('terminal-empty');
        expect(yield* f.fs.readFileString(watchFile)).toBe(terminalBytes);
      }
    }).pipe(run, provideTestLayer(cliTestLayer)),
  );

  effectIt.effect(
    'rejects forged receipt consumers before admitting another same-PR watch',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(['one'], 'pr');
        const existing = yield* publishOpenHistoricalPhase(f, 'one', 'main', 73);
        const stored = yield* readNativeWorkflowState(f.config, 'native-run');
        const receipt = stored?.state.cycle?.state.phases.one?.delivery;
        const decoded = decodeNativeTaskActionRef(existing.deliveryRef);
        if (!receipt?.watch || !decoded?.delivery) throw new Error('Expected the genuine canonical delivery and ref.');
        const consumerId = `${existing.consumerId}-${EffectString.slice(0, 48)(sha256HexSync(existing.prUrl))}`;
        const forged = {...decoded.delivery, watch: {...receipt.watch, consumerId}};
        const deliveryRef = encodeNativeTaskActionRef({
          ...decoded,
          delivery: forged,
          payloadDigest: sha256HexSync(stableJson(forged)),
        });
        const sourceBefore = yield* f.fs.readFileString(f.statePath());
        const watchPath = f.path.join(f.home, 'workflow-automations', 'native-watch-v1', existing.watchId + '.json');
        const watchBefore = yield* f.fs.readFileString(watchPath);
        const commands = yield* CommandExecutor;
        let effects = 0;
        const trapped = CommandExecutor.of({
          ...commands,
          execute: (executable, args, options) => {
            if (executable === 'gh' || executable === '/usr/bin/codex') {
              effects++;
              return Effect.succeed({
                exitCode: 1,
                stdout: '',
                stderr: 'Forged watch identity must be rejected before effects.',
              });
            }
            return commands.execute(executable, args, options);
          },
          spawnDetached: () => {
            effects++;
            return Effect.succeed(false);
          },
        });
        if (!decoded.delivery.pr) throw new Error('Expected the canonical PR identity.');
        const foreignUrl = 'https://github.com/other-owner/other-repo/pull/99';
        const urlForged = {
          ...decoded.delivery,
          pr: {...decoded.delivery.pr, url: foreignUrl},
          providerIdentity: {
            ...decoded.delivery.providerIdentity!,
            url: foreignUrl,
            number: 99,
            baseRepository: 'other-owner/other-repo',
            headRepository: 'other-owner/other-repo',
          },
        };
        const urlForgedRef = encodeNativeTaskActionRef({
          ...decoded,
          delivery: urlForged,
          payloadDigest: sha256HexSync(stableJson(urlForged)),
        });
        let watchLookups = 0;
        const lookupCountingFs = {
          ...f.fs,
          stat: (file: string) => {
            if (/[\\/]native-watch-v1(?:[\\/]|$)/u.test(file)) watchLookups++;
            return f.fs.stat(file);
          },
        };
        const canonicalUrlResult = yield* runNativeTaskActionCore(f.config, {
          command: 'watch-pr',
          operation: 'inspect',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef: existing.validationRef,
          deliveryRef: urlForgedRef,
        }).pipe(
          Effect.provideService(CommandExecutor, trapped),
          Effect.provideService(FileSystem.FileSystem, lookupCountingFs),
          Effect.result,
        );
        expect(canonicalUrlResult).toMatchObject({failure: {code: 'stale-delivery-ref'}});
        expect(watchLookups).toBe(0);
        expect(effects).toBe(0);
        expect(yield* f.fs.readFileString(f.statePath())).toBe(sourceBefore);
        expect(yield* f.fs.readFileString(watchPath)).toBe(watchBefore);
        const foreignQualifiedId = `${existing.watchId}-${EffectString.slice(0, 48)(sha256HexSync(foreignUrl))}`;
        expect(yield* readNativeWatch(f.config, foreignQualifiedId)).toBeUndefined();
        const result = yield* runNativeTaskActionCore(f.config, {
          command: 'watch-pr',
          operation: 'start',
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef: existing.validationRef,
          deliveryRef,
          wakeup: {...existing.wakeup, threadId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'},
        }).pipe(Effect.provideService(CommandExecutor, trapped), Effect.result);
        expect({effects, result}).toMatchObject({effects: 0, result: {failure: {code: 'watch-identity-conflict'}}});
        expect(yield* f.fs.readFileString(f.statePath())).toBe(sourceBefore);
        expect(yield* f.fs.readFileString(watchPath)).toBe(watchBefore);
        expect(yield* readNativeWatch(f.config, `pr-${EffectString.slice(5)(consumerId)}`)).toBeUndefined();
        const observed = yield* readNativeWatch(f.config, existing.watchId);
        if (!observed?.envelope.state.consumer || !observed.envelope.notification)
          throw new Error('Expected its bound consumer.');
        yield* writeNativeWatch(
          f.config,
          {
            ...observed.envelope,
            state: {
              ...observed.envelope.state,
              consumer: {...observed.envelope.state.consumer, id: 'foreign', wakeupId: 'foreign'},
            },
            notification: {...observed.envelope.notification, consumerId: 'foreign', wakeupId: 'foreign'},
          },
          observed.revision,
        );
        const foreignBytes = yield* f.fs.readFileString(watchPath);
        expect(
          yield* resolveNativeTaskPrWatch(
            f.config,
            'native-run',
            'one',
            'https://github.com/example/repo/pull/74',
          ).pipe(Effect.result),
        ).toMatchObject({failure: {code: 'watch-identity-conflict'}});
        expect(yield* f.fs.readFileString(watchPath)).toBe(foreignBytes);
        const foreign = yield* readNativeWatch(f.config, existing.watchId);
        if (!foreign) throw new Error('Expected the occupied legacy identity.');
        yield* writeNativeWatch(f.config, observed.envelope, foreign.revision);
        const restored = yield* readNativeWatch(f.config, existing.watchId);
        if (!restored) throw new Error('Expected the restored legacy watch.');
        const {notification: _notification, ...withoutNotification} = restored.envelope;
        yield* writeNativeWatch(
          f.config,
          {...withoutNotification, state: {...restored.envelope.state, consumer: null}},
          restored.revision,
        );
        const unboundBytes = yield* f.fs.readFileString(watchPath);
        expect(yield* resolveNativeTaskPrWatch(f.config, 'native-run', 'one', existing.prUrl)).toMatchObject({
          watchId: existing.watchId,
        });
        expect(
          yield* resolveNativeTaskPrWatch(
            f.config,
            'native-run',
            'one',
            'https://github.com/example/repo/pull/74',
          ).pipe(Effect.result),
        ).toMatchObject({failure: {code: 'watch-identity-conflict'}});
        expect(yield* f.fs.readFileString(watchPath)).toBe(unboundBytes);
        const unbound = yield* readNativeWatch(f.config, existing.watchId);
        if (!unbound) throw new Error('Expected the unbound legacy watch.');
        yield* writeNativeWatch(f.config, restored.envelope, unbound.revision);
      }).pipe(run),
    windowsRealGitFixtureTimeout,
  );

  effectIt.effect(
    'keeps sequential same-phase PR watches separate and retains their exact old routes',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(['one'], 'pr');
        const old = yield* publishOpenHistoricalPhase(f, 'one', 'main', 71);
        const oldCurrent = yield* readNativeWatch(f.config, old.watchId);
        if (!oldCurrent) throw new Error('Expected the first canonical watch.');
        const arrival = yield* writeSimulatedTaskWatch(
          f,
          oldCurrent,
          old,
          old.prUrl,
          oldCurrent.envelope.state.head!,
          true,
        );
        const terminalOld = yield* readNativeWatch(f.config, old.watchId);
        if (!terminalOld) throw new Error('Expected the terminal watch.');
        yield* writeNativeWatch(
          f.config,
          {
            ...terminalOld.envelope,
            state: {
              ...terminalOld.envelope.state,
              work: [
                {
                  eventId: arrival.event.id,
                  status: 'open',
                  reason: 'The original repair remains open.',
                  evidence: 'Retained before the followup PR starts.',
                  event: arrival.event,
                  at: arrival.event.at,
                },
              ],
            },
          },
          terminalOld.revision,
        );
        const oldRoute = {
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef: old.validationRef,
          deliveryRef: old.deliveryRef,
        };
        const oldInspection = object(
          yield* runNativeTaskAction(f.config, {command: 'watch-pr', operation: 'inspect', ...oldRoute}),
        );
        const oldNoticeRef = String(oldInspection.noticeRef);
        const reopen = () =>
          Effect.gen(function* () {
            const current = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
            yield* runNativeTaskAction(f.config, {
              command: 'reopen',
              runId: 'native-run',
              callerCwd: f.repo,
              taskRef: String(current.taskRef),
              phaseId: 'one',
              reason: 'A separately approved followup needs fresh source proof.',
            });
          });
        yield* reopen();
        const watchFile = (id: string) => f.path.join(f.home, 'workflow-automations', 'native-watch-v1', id + '.json');
        const oldBytes = yield* f.fs.readFileString(watchFile(old.watchId));
        const expectedWatchId = `${old.watchId}-${EffectString.slice(0, 48)(sha256HexSync('https://github.com/example/repo/pull/72'))}`;
        const next = yield* publishOpenHistoricalPhase(f, 'one', 'main', 72, false, {
          watchId: expectedWatchId,
          source: 'one followup',
        });
        expect(next.watchId).toBe(expectedWatchId);
        expect(next.watchId).not.toBe(old.watchId);
        expect(yield* f.fs.readFileString(watchFile(old.watchId))).toBe(oldBytes);
        const nextRoute = {
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef: next.validationRef,
          deliveryRef: next.deliveryRef,
        };
        const nextInspection = object(
          yield* runNativeTaskAction(f.config, {command: 'watch-pr', operation: 'inspect', ...nextRoute}),
        );
        const nextRelay = object(
          yield* runNativeTaskAction(f.config, {
            command: 'watch-pr',
            operation: 'relay',
            ...nextRoute,
            noticeRef: String(nextInspection.noticeRef),
          }),
        );
        const nextRefs = nextRelay.eventRefs;
        if (!EffectArray.isArray(nextRefs) || nextRefs.length !== 1)
          throw new Error('Expected the qualified watch event.');
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'disposition',
          ...nextRoute,
          watchDeliveryRef: String(nextRelay.watchDeliveryRef),
          dispositions: [
            {
              eventRef: String(nextRefs[0]),
              status: 'resolved',
              reason: 'The followup event was independently handled.',
              evidence: 'This is the qualified PR event route.',
            },
          ],
        });
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'ack',
          ...nextRoute,
          watchDeliveryRef: String(nextRelay.watchDeliveryRef),
        });
        const nextWork = object(
          yield* runNativeTaskAction(f.config, {command: 'watch-pr', operation: 'work', ...nextRoute}),
        );
        expect(object(object(nextWork.result).work).items).toMatchObject([
          {eventId: expectedWatchId + ':1', status: 'resolved'},
        ]);
        expect(
          yield* runNativeTaskAction(f.config, {
            command: 'watch-pr',
            operation: 'relay',
            ...nextRoute,
            noticeRef: oldNoticeRef,
          }).pipe(Effect.result),
        ).toMatchObject({failure: {code: 'foreign-notice-route'}});
        expect(yield* f.fs.readFileString(watchFile(old.watchId))).toBe(oldBytes);
        expect(
          object(yield* runNativeTaskAction(f.config, {command: 'watch-pr', operation: 'inspect', ...oldRoute})),
        ).toMatchObject({status: 'watch-updated', watchId: old.watchId});
        const relayed = object(
          yield* runNativeTaskAction(f.config, {
            command: 'watch-pr',
            operation: 'relay',
            ...oldRoute,
            noticeRef: oldNoticeRef,
          }),
        );
        const refs = relayed.eventRefs;
        if (!EffectArray.isArray(refs) || refs.length !== 1) throw new Error('Expected the exact old queued event.');
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'disposition',
          ...oldRoute,
          watchDeliveryRef: String(relayed.watchDeliveryRef),
          dispositions: [
            {
              eventRef: String(refs[0]),
              status: 'open',
              reason: 'The previous PR still has unresolved work.',
              evidence: 'The successor preserves that separate owner.',
            },
          ],
        });
        yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          operation: 'ack',
          ...oldRoute,
          watchDeliveryRef: String(relayed.watchDeliveryRef),
        });
        const oldWork = object(
          yield* runNativeTaskAction(f.config, {command: 'watch-pr', operation: 'work', ...oldRoute}),
        );
        expect(object(object(oldWork.result).work).items).toMatchObject([{eventId: arrival.event.id, status: 'open'}]);
        const afterOld = yield* f.fs.readFileString(watchFile(old.watchId));
        const liveRetry = yield* attemptSimulatedTaskWatch(
          f,
          'native-run',
          'one',
          next.validationRef,
          next.deliveryRef,
          next.prUrl,
          expectedWatchId,
        );
        expect(liveRetry.result).toMatchObject({ok: false, failure: {code: 'collector-busy'}});
        const beforeRestart = yield* readNativeWatch(f.config, expectedWatchId);
        if (!beforeRestart?.envelope.collector) throw new Error('Expected its live collector.');
        yield* writeNativeWatch(
          f.config,
          {...beforeRestart.envelope, collector: {...beforeRestart.envelope.collector, pid: 0, status: 'blocked'}},
          beforeRestart.revision,
        );
        const restarted = yield* attemptSimulatedTaskWatch(
          f,
          'native-run',
          'one',
          next.validationRef,
          next.deliveryRef,
          next.prUrl,
          expectedWatchId,
        );
        expect(restarted.result).toMatchObject({
          ok: true,
          value: {watchId: expectedWatchId, consumerId: next.consumerId},
        });
        // The phase already holds a canonical PR receipt, so the replayed start needs no follow-up complete.
        expect(restarted.result).not.toHaveProperty(['value', 'next']);
        expect(yield* f.fs.readFileString(watchFile(old.watchId))).toBe(afterOld);
        const projected = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
        expect(projected.historicalWatches).toMatchObject([{phaseId: 'one', prUrl: next.prUrl}]);
        const selected = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo, phaseId: 'one'});
        expect(selected.historicalWatch).toMatchObject({prUrl: next.prUrl, consumerId: next.consumerId});
        // A fresh reviewed HEAD of the same PR keeps its qualified watch, rather than minting a source-specific ID.
        yield* reopen();
        const previousHeadWatch = yield* readNativeWatch(f.config, expectedWatchId);
        if (!previousHeadWatch?.envelope.collector) throw new Error('Expected the retained same-PR collector.');
        yield* writeNativeWatch(
          f.config,
          {
            ...previousHeadWatch.envelope,
            collector: {...previousHeadWatch.envelope.collector, pid: 0, status: 'blocked'},
          },
          previousHeadWatch.revision,
        );
        const updated = yield* publishOpenHistoricalPhase(f, 'one', 'main', 72, false, {
          watchId: expectedWatchId,
          source: 'one updated head',
          ambiguousRecovery: true,
        });
        expect(updated.watchId).toBe(next.watchId);
        expect(updated.consumerId).toBe(next.consumerId);
        expect(yield* f.fs.readFileString(watchFile(old.watchId))).toBe(afterOld);
        const updatedRoute = {
          runId: 'native-run',
          callerCwd: f.repo,
          validationRef: updated.validationRef,
          deliveryRef: updated.deliveryRef,
        };
        expect(
          object(
            yield* runNativeTaskAction(f.config, {command: 'watch-pr', operation: 'renew', ...updatedRoute}).pipe(
              Effect.provideService(CommandExecutor, updated.commands),
              Effect.provideService(SystemInfo, updated.system),
            ),
          ),
        ).toMatchObject({status: 'watching', watchId: expectedWatchId, consumerId: next.consumerId});
        const canonical = yield* readNativeWorkflowState(f.config, 'native-run');
        if (!canonical) throw new Error('Expected the canonical run.');
        const owners = yield* inspectOldBindingOwners(f.config, canonical);
        expect(new Set(EffectArray.map(owners.watches, watch => watch.watchId))).toEqual(
          new Set([old.watchId, expectedWatchId]),
        );
        expect(owners.unresolved).toEqual(
          expect.arrayContaining([
            expect.objectContaining({watchId: old.watchId, reasons: expect.arrayContaining(['watch-work-open'])}),
          ]),
        );
        const currentHead = canonical.state.cycle?.state.phases.one?.head;
        if (!currentHead) throw new Error('Expected the current canonical head.');
        const currentWatch = yield* readNativeWatch(f.config, expectedWatchId);
        const notification = currentWatch?.envelope.notification;
        if (!currentWatch || !notification?.outbox) throw new Error('Expected the qualified watch notice.');
        const notice = nativeWatchNotice(
          {
            home: f.config.agentContextHome,
            watchId: expectedWatchId,
            consumerId: notification.consumerId,
            wakeupId: notification.wakeupId,
          },
          notification.outbox,
        );
        const arrivedRoute = /^Threadnote watch event\. Route=(\{[^}]+\})\./u.exec(notice);
        if (!arrivedRoute) throw new Error('Expected the qualified notice route.');
        const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
        registerWorkflowTaskTool(mcp, f.config);
        const runBeforeNotice = yield* f.fs.readFileString(f.statePath());
        const watchBeforeNotice = yield* f.fs.readFileString(watchFile(expectedWatchId));
        const recovered = yield* mcp.invokeTool('workflow_task_view', {
          runId: updatedRoute.runId,
          callerCwd: updatedRoute.callerCwd,
          phaseId: 'one',
          noticeRoute: arrivedRoute[1],
        });
        expect(recovered.structuredContent).toMatchObject({
          status: 'notice-recovered',
          continuation: {validationRef: updated.validationRef, noticeRef: expect.any(String)},
        });
        const continuation = object(object(recovered.structuredContent).continuation);
        expect(decodeNativeTaskActionRef(String(continuation.deliveryRef))?.delivery?.headSha).toBe(currentHead);
        expect(yield* f.fs.readFileString(f.statePath())).toBe(runBeforeNotice);
        expect(yield* f.fs.readFileString(watchFile(expectedWatchId))).toBe(watchBeforeNotice);
        yield* writeSimulatedTaskWatch(f, currentWatch, updated, updated.prUrl, currentHead, true);
        yield* runNativeTaskAction(f.config, {command: 'watch-pr', operation: 'complete', ...updatedRoute});
        const beforeFinish = yield* f.fs.readFileString(f.statePath());
        const settledOld = yield* readNativeWatch(f.config, old.watchId);
        if (!settledOld?.envelope.collector) throw new Error('Expected the retained collector.');
        yield* writeNativeWatch(
          f.config,
          {
            ...settledOld.envelope,
            state: {...settledOld.envelope.state, prState: 'open'},
            collector: {...settledOld.envelope.collector, status: 'running'},
          },
          settledOld.revision,
        );
        expect(
          yield* runNativeTaskAction(f.config, {
            command: 'finish',
            runId: 'native-run',
            callerCwd: f.repo,
            proposal,
          }).pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false), Effect.result),
        ).toMatchObject({failure: {code: 'finish-scope'}});
        const unsettled = yield* readNativeWatch(f.config, old.watchId);
        if (!unsettled) throw new Error('Expected the unsettled old watch.');
        yield* writeNativeWatch(f.config, settledOld.envelope, unsettled.revision);
        expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeFinish);
        const failingFs = {
          ...f.fs,
          readDirectory: (path: string) =>
            EffectString.endsWith('native-watch-v1')(path)
              ? Effect.succeed(Array.from({length: 4097}, (_, index) => `unrelated-${index}`))
              : f.fs.readDirectory(path),
        };
        expect(
          (yield* inspectOldBindingOwners(f.config, canonical).pipe(
            Effect.provideService(FileSystem.FileSystem, failingFs),
          )).unresolved,
        ).toEqual(expect.arrayContaining([expect.objectContaining({owner: 'watch-inventory', status: 'unavailable'})]));
        expect(
          yield* runNativeTaskAction(f.config, {
            command: 'finish',
            runId: 'native-run',
            callerCwd: f.repo,
            proposal,
          }).pipe(
            Effect.provideService(CurrentNativeJobAutoLaunch, false),
            Effect.provideService(FileSystem.FileSystem, failingFs),
            Effect.result,
          ),
        ).toMatchObject({failure: {code: 'watch-inventory-capacity'}});
        const finishing = object(
          yield* runNativeTaskAction(f.config, {
            command: 'finish',
            runId: 'native-run',
            callerCwd: f.repo,
            proposal,
          }).pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false)),
        );
        const jobId = decodeNativeTaskActionRef(String(finishing.prepareRef))?.jobId;
        if (!jobId) throw new Error('Expected the existing closeout prepare job.');
        expect(object(yield* runNativeJobWorker(f.config, 'native-run', jobId, f.call)).status).toBe('completed');
        const journal = yield* readNativeCloseoutJournal(f.config, 'native-run', decodeJournal);
        expect(journal?.state.proposal.watchWork).toEqual(
          expect.arrayContaining([
            expect.objectContaining({eventId: arrival.event.id, status: 'open', event: arrival.event}),
          ]),
        );
        expect((yield* readNativeWatch(f.config, old.watchId))?.envelope.state.work).toMatchObject([
          {eventId: arrival.event.id, status: 'open'},
        ]);
      }).pipe(run),
    windowsRealGitFixtureTimeout,
  );
});

effectIt.effect(
  'rejects mixed watch proof routes and candidate completion without mutating canonical state',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(['one'], 'local');
      const before = yield* f.fs.readFileString(f.statePath());
      const commands = yield* CommandExecutor;
      let forbiddenEffects = 0;
      const guardedCommands = CommandExecutor.of({
        ...commands,
        execute: (executable, args, options) => {
          if (executable === 'gh' || executable === '/fixture/codex') {
            forbiddenEffects++;
            return Effect.die('Unexpected provider or host call for mixed watch proof.');
          }
          return commands.execute(executable, args, options);
        },
        spawnDetached: () =>
          Effect.sync(() => {
            forbiddenEffects++;
            return false;
          }),
      });
      const invoke = (fields: object) =>
        runNativeTaskAction(f.config, {
          command: 'watch-pr',
          runId: 'native-run',
          callerCwd: f.repo,
          operation: 'inspect',
          ...fields,
        }).pipe(Effect.provideService(CommandExecutor, guardedCommands), Effect.result);
      for (const standalone of [{prUrl: 'https://github.com/example/repo/pull/1'}, {watchRef: 'standalone'}])
        expect(yield* invoke({...standalone, candidateWatchRef: 'candidate'})).toMatchObject({
          failure: {code: 'invalid-request'},
        });
      for (const proof of [
        {snapshotRef: 'candidate'},
        {candidateWatchRef: 'candidate'},
        {supplementalRef: 'publication'},
        {pr: 'https://github.com/example/repo/pull/1'},
      ]) {
        const standalone = yield* runNativeTaskAction(f.config, {
          command: 'watch-pr',
          callerCwd: f.repo,
          operation: 'start',
          prUrl: 'https://github.com/example/repo/pull/1',
          wakeup: {host: 'codex', executable: '/fixture/codex', threadId: '11111111-1111-4111-8111-111111111111'},
          ...proof,
        }).pipe(Effect.provideService(CommandExecutor, guardedCommands), Effect.result);
        expect(standalone).toMatchObject({failure: {code: 'invalid-request'}});
      }
      expect(forbiddenEffects).toBe(0);
      expect(yield* invoke({candidateWatchRef: 'candidate', supplementalRef: 'publication'})).toMatchObject({
        failure: {code: 'watch-proof-conflict'},
      });
      expect(
        yield* invoke({snapshotRef: 'candidate', validationRef: 'validation', deliveryRef: 'delivery'}),
      ).toMatchObject({failure: {code: 'watch-proof-conflict'}});
      expect(yield* invoke({candidateWatchRef: 'candidate', operation: 'complete'})).toMatchObject({
        failure: {code: 'candidate-diagnostic-only'},
      });
      expect(yield* invoke({supplementalRef: 'candidate'})).toMatchObject({
        failure: {code: 'invalid-supplemental-ref'},
      });
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
    }).pipe(run),
  windowsRealGitFixtureTimeout,
);

describe('watch refusal recovery', () => {
  const identity = {runId: 'native-run', callerCwd: '/checkout', validationRef: 'v', deliveryRef: 'd'};
  const refusal = (code: string, message = 'Refused.') => WorkflowAutomationError.make({code, message});
  it('routes delivery authority, stale deliveries and route-bound leases to their own recovery', () => {
    expect(
      nativeWatchRecoveryNext({...identity, operation: 'complete'}, refusal('user-authority-required')),
    ).toMatchObject({tool: 'workflow_task_deliver', command: 'deliver-pr'});
    const relay = nativeWatchRecoveryNext(
      {...identity, operation: 'ack', watchDeliveryRef: 'stale'},
      refusal('stale-watch-delivery-ref'),
    );
    expect(relay).toMatchObject({tool: 'workflow_task_watch_pr', command: 'relay', arguments: {operation: 'relay'}});
    expect(relay?.arguments).not.toHaveProperty('watchDeliveryRef');
    expect(
      nativeWatchRecoveryNext(
        {runId: 'native-run', callerCwd: '/checkout', candidateWatchRef: 'c', operation: 'work-disposition'},
        refusal('invalid-watch', 'Watch consumer does not own a live lease.'),
      ),
    ).toMatchObject({command: 'inspect', arguments: {candidateWatchRef: 'c'}});
    expect(
      nativeWatchRecoveryNext({...identity, operation: 'inspect'}, refusal('provisional-watch-not-eligible')),
    ).toBeUndefined();
  });
});
