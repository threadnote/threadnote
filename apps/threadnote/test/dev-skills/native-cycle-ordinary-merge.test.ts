import {Array as EffectArray, String as EffectString, Option as EffectOption, Record as EffectRecord} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  PlatformError,
  Result,
  Schema,
} from 'effect';
import {TestClock} from 'effect/testing';
import {ChildProcessSpawner} from 'effect/process/ChildProcessSpawner';
import {
  nativeCycleSameLabelQualificationLimits,
  withNativeCycleSameLabelQualificationBudget,
} from '../../src/workflow_automation/cycle_merge.js';
import {describe, expect} from 'vitest';
import {CommandExecutor, runCommandEffect} from '@threadnote/platform/command';
import {decodeNativeCycleRuntime} from '@threadnote/workflow-automations/cycle-runtime';
import {NativeCycleSnapshotSchema, type NativeCycleSnapshot} from '@threadnote/workflow-automations/cycle-review';
import {decodeNativeWorkflowState, type NativeWorkflowState} from '@threadnote/workflow-automations/native';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  prepareNativeWorkflowStateWrite,
  readNativeWorkflowState,
  withNativeWorkflowLock,
  writeNativeWorkflowState,
} from '../../src/workflow_automation/store.js';
import {stableJson} from '../../src/workflow_memory/protocol.js';
import {workflowJournalLimits} from '../../src/workflow_memory/journal_codec.js';
import {pinNativeCycleTree} from '../../src/workflow_automation/cycle_git.js';
import {fixture, object, run, windowsCycleFixtureTimeout} from './native-cycle-lifecycle-fixture.js';

const ordinaryMergeFixtureTimeout = windowsCycleFixtureTimeout ?? {timeout: 60_000};

const report = (snapshot: NativeCycleSnapshot, mode: 'full' | 'incremental' = 'full') => ({
  snapshotId: snapshot.snapshotId,
  phaseHash: snapshot.phaseHash,
  snapshotTree: snapshot.tree,
  status: 'complete',
  mode,
  selected: ['correctness', 'simplicity'],
  lanes: [
    {name: 'correctness', status: 'complete'},
    {name: 'simplicity', status: 'complete'},
  ],
  findings: [],
});
const refused = <A, E>(result: Result.Result<A, E>, code?: string) => {
  expect(Result.isFailure(result)).toBe(true);
  if (code && Result.isFailure(result)) expect(result.failure).toMatchObject({code});
};
const syntheticIo = (path: string) =>
  PlatformError.systemError({
    _tag: 'Unknown',
    module: 'FileSystem',
    method: 'rename',
    description: 'Private merge receipt write fault',
    pathOrDescriptor: path,
  });
const retentionRefs = (f: Effect.Success<ReturnType<typeof mergeFixture>>) =>
  f
    .git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/threadnote/'])
    .pipe(Effect.map(result => result.stdout));
const capacityAttempt = (index: number, report: string) => ({
  id: `capacity-${index}`,
  snapshotId: 'prior',
  digest: sha256HexSync(report),
  status: 'invalid' as const,
  message: '',
  report,
});

/** A real valid compressed state one byte below the fixed logical ceiling, not a lowered test limit. */
function nearLogicalCapacity(state: NativeWorkflowState): NativeWorkflowState {
  const cycle = state.cycle!;
  const plan = {...cycle.plans[0], completion: EffectString.repeat(900_000)('x')};
  const attempts = [...cycle.attempts];
  const grown = {
    ...state,
    cycle: {...cycle, plans: [...cycle.plans, ...Array.from({length: 64 - cycle.plans.length}, () => plan)], attempts},
  };
  let remaining =
    workflowJournalLimits.logicalBytes - 1 - new TextEncoder().encode(stableJson(grown) + '\n').byteLength;
  for (let index = 0; remaining > 0; index++) {
    const overhead = new TextEncoder().encode(stableJson(capacityAttempt(index, ''))).byteLength + 1;
    expect(remaining).toBeGreaterThanOrEqual(overhead);
    const length = Math.min(65_536, remaining - overhead);
    attempts.push(capacityAttempt(index, EffectString.repeat(length)('x')));
    remaining -= overhead + length;
  }
  expect(attempts.length).toBeLessThanOrEqual(512);
  expect(new TextEncoder().encode(stableJson(grown) + '\n').byteLength).toBe(workflowJournalLimits.logicalBytes - 1);
  return decodeNativeWorkflowState(grown);
}
const mergeFixture = (large = false) =>
  Effect.gen(function* () {
    const f = yield* fixture(['one', 'two'], 'local', false, false, false);
    yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const feature = "prior";\n');
    yield* f.git(['add', '.']);
    yield* f.git(['commit', '-m', 'Reviewed source']);
    const priorHead = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
    const prior = yield* Schema.decodeUnknownEffect(NativeCycleSnapshotSchema)(
      object(
        (yield* f.mutate('snapshot', {
          phaseId: 'one',
          snapshotId: 'prior',
          acceptedHead: priorHead,
          reason: 'Reviewed committed source',
        })).snapshot,
      ).snapshot,
    );
    yield* f.mutate('validate-review', {
      snapshotId: prior.snapshotId,
      attemptId: 'prior-review',
      report: report(prior),
    });
    const old = decodeNativeCycleRuntime(JSON.parse(yield* f.fs.readFileString(f.statePath())).cycle);
    const owned = [
      'source.ts',
      ...Array.from({length: large ? 178 : 2}, (_, i) => `owned-${EffectString.padStart(3, '0')(String(i))}.ts`),
    ].sort();
    const inherited = Array.from(
      {length: large ? 116 : 2},
      (_, i) => `upstream-${EffectString.padStart(3, '0')(String(i))}.ts`,
    );
    for (const path of owned)
      yield* f.fs.writeFileString(f.path.join(f.repo, path), 'export const feature = "current";\n');
    yield* f.git(['add', '.']);
    yield* f.git(['commit', '-m', 'Current owned implementation']);
    yield* f.git(['checkout', 'main']);
    for (const path of inherited)
      yield* f.fs.writeFileString(f.path.join(f.repo, path), 'export const upstream = true;\n');
    yield* f.git(['add', '.']);
    yield* f.git(['commit', '-m', 'Advanced upstream']);
    const currentBaseHead = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
    yield* f.git(['checkout', 'feature/one']);
    yield* f.git(['merge', '--no-ff', 'main', '-m', 'Ordinary integration']);
    const head = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
    const one = EffectArray.filter(owned, (path, i) => path === 'source.ts' || i % 2 === 0);
    const two = EffectArray.filter(owned, path => !one.includes(path));
    // One permitted upstream path proves incoming is a phase subset, not the complete inherited proof.
    const plan = yield* f.revise({
      phases: EffectArray.map(f.document.phases, phase => ({
        ...phase,
        affectedPaths: phase.id === 'one' ? [...one, inherited[0]] : two,
      })),
    });
    yield* f.mutate('reconcile', {plan, reason: 'Reviewed explicit multi-phase ownership amendment'});
    const fields = {
      protocolVersion: 2,
      phaseId: 'one',
      snapshotId: 'integrated',
      previous: prior.snapshotId,
      acceptedHead: head,
      reason: 'Ordinary ancestry-preserving integration',
      userAuthority: 'Use the reviewed ownership amendment',
      ordinaryMergeQualificationV1: {
        priorHead,
        currentBaseHead,
        currentHead: head,
        fromBaseBranch: 'main',
        planDocumentHash: object(plan.source).documentHash,
        phaseOwnedPaths: [
          {phaseId: 'one', paths: one},
          {phaseId: 'two', paths: two},
        ],
      },
    };
    const read = () =>
      f.fs.readFileString(f.statePath()).pipe(Effect.map(body => decodeNativeCycleRuntime(JSON.parse(body).cycle)));
    const capture = () =>
      Effect.gen(function* () {
        yield* f.mutate('snapshot', fields);
        return (yield* read()).snapshots.at(-1)!.snapshot;
      });
    return {...f, prior, old, owned, inherited, one, two, fields, read, capture, head};
  });

describe('ordinary merge native qualification', () => {
  effectIt.effect(
    'preflights the complete state at the real logical codec boundary before creating any pins',
    () =>
      Effect.gen(function* () {
        const f = yield* mergeFixture();
        const stored = (yield* readNativeWorkflowState(f.config, 'native-run'))!;
        const grown = nearLogicalCapacity(stored.state);
        yield* withNativeWorkflowLock(
          f.config,
          'native-run',
          false,
          writeNativeWorkflowState(f.config, grown, stored.revision),
        );
        const before = yield* f.fs.readFileString(f.statePath());
        const journal = yield* f.fs.readFileString(f.journalPath(stored.state.bindingId));
        const refs = yield* retentionRefs(f);
        refused(yield* f.capture().pipe(Effect.result), 'state-capacity');
        expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
        expect(yield* f.fs.readFileString(f.journalPath(stored.state.bindingId))).toBe(journal);
        expect(yield* retentionRefs(f)).toBe(refs);
      }).pipe(run),
    ordinaryMergeFixtureTimeout,
  );

  effectIt.effect(
    'uses the same whole-state preflight for the fixed stored-byte codec ceiling',
    () =>
      Effect.gen(function* () {
        const f = yield* mergeFixture();
        const stored = (yield* readNativeWorkflowState(f.config, 'native-run'))!;
        const before = yield* f.fs.readFileString(f.statePath());
        const refs = yield* retentionRefs(f);
        let seed = 123456789;
        const attempts = [...stored.state.cycle!.attempts];
        for (let index = 0; index < 320; index++) {
          const words = new Uint32Array(12_288);
          for (let word = 0; word < words.length; word++) {
            seed ^= seed << 13;
            seed ^= seed >>> 17;
            seed ^= seed << 5;
            words[word] = seed >>> 0;
          }
          attempts.push(capacityAttempt(index, new Uint8Array(words.buffer).toBase64()));
        }
        const candidate = {...stored.state, cycle: {...stored.state.cycle!, attempts}};
        expect(new TextEncoder().encode(stableJson(candidate)).byteLength).toBeLessThan(
          workflowJournalLimits.logicalBytes,
        );
        refused(yield* prepareNativeWorkflowStateWrite(candidate).pipe(Effect.result), 'state-capacity');
        expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
        expect(yield* retentionRefs(f)).toBe(refs);
      }).pipe(run),
    ordinaryMergeFixtureTimeout,
  );

  effectIt.effect(
    'rolls back only newly created exact refs when failed I/O leaves the original durable state',
    () =>
      Effect.gen(function* () {
        const f = yield* mergeFixture();
        const stored = (yield* readNativeWorkflowState(f.config, 'native-run'))!;
        const tree = EffectString.trim((yield* f.git(['rev-parse', 'HEAD^{tree}'])).stdout);
        const preexisting = yield* pinNativeCycleTree(f.repo, stored.state.bindingId, f.fields.snapshotId, tree);
        const refs = yield* retentionRefs(f);
        const before = yield* f.fs.readFileString(f.statePath());
        const journal = yield* f.fs.readFileString(f.journalPath(stored.state.bindingId));
        const fs = yield* FileSystem.FileSystem;
        const clock = yield* Clock.Clock;
        const stateFile = yield* fs.realPath(f.statePath());
        for (const point of ['write', 'rename']) {
          let injected = false;
          let expiredBy = 0;
          const acquisitionClock: Clock.Clock = {
            currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
            currentTimeMillis: clock.currentTimeMillis,
            currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
            currentTimeNanos: clock.currentTimeNanos,
            monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe() + BigInt(expiredBy) * 1_000_000n,
            monotonicTimeNanos: Effect.suspend(() =>
              clock.monotonicTimeNanos.pipe(Effect.map(time => time + BigInt(expiredBy) * 1_000_000n)),
            ),
            sleep: duration => clock.sleep(duration),
          };
          const failed = FileSystem.FileSystem.of({
            ...fs,
            writeFileString: (path, data, options) =>
              point === 'write' && EffectString.startsWith(stateFile + '.')(path) && EffectString.endsWith('.tmp')(path)
                ? Effect.suspend(() => {
                    injected = true;
                    return Effect.fail(syntheticIo(path));
                  })
                : fs.writeFileString(path, data, options),
            rename: (from, to) =>
              point === 'rename' && to === stateFile
                ? Effect.suspend(() => {
                    injected = true;
                    expiredBy = 31_000;
                    return Effect.fail(syntheticIo(to));
                  })
                : fs.rename(from, to),
          });
          refused(
            yield* withNativeCycleSameLabelQualificationBudget(f.capture()).pipe(
              Effect.provideService(FileSystem.FileSystem, failed),
              Effect.provideService(Clock.Clock, acquisitionClock),
              Effect.result,
            ),
          );
          expect(expiredBy).toBe(point === 'rename' ? 31_000 : 0);
          expect(injected).toBe(true);
          expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
          expect(yield* f.fs.readFileString(f.journalPath(stored.state.bindingId))).toBe(journal);
          expect(yield* retentionRefs(f)).toBe(refs);
          expect(EffectString.trim((yield* f.git(['rev-parse', preexisting])).stdout)).toBe(tree);
        }
        expect((yield* f.capture()).snapshotId).toBe(f.fields.snapshotId);
      }).pipe(run),
    ordinaryMergeFixtureTimeout,
  );

  effectIt.effect(
    'keeps all pins and returns the admitted receipt when rename committed before reporting an I/O failure',
    () =>
      Effect.gen(function* () {
        const f = yield* mergeFixture();
        const fs = yield* FileSystem.FileSystem;
        const stateFile = yield* fs.realPath(f.statePath());
        let injected = false;
        const failed = FileSystem.FileSystem.of({
          ...fs,
          rename: (from, to) =>
            to === stateFile && !injected
              ? Effect.gen(function* () {
                  injected = true;
                  yield* fs.rename(from, to);
                  return yield* syntheticIo(to);
                })
              : fs.rename(from, to),
        });
        const snapshot = yield* f.capture().pipe(Effect.provideService(FileSystem.FileSystem, failed));
        expect(injected).toBe(true);
        expect(snapshot.snapshotId).toBe(f.fields.snapshotId);
        for (const ref of [
          snapshot.pinnedRef,
          snapshot.ordinaryMergeQualificationV1!.priorHeadRef,
          snapshot.ordinaryMergeQualificationV1!.currentHeadRef,
          snapshot.ordinaryMergeQualificationV1!.priorBaseRef,
          snapshot.ordinaryMergeQualificationV1!.currentBaseRef,
        ])
          expect(yield* retentionRefs(f)).toContain(ref);
        expect((yield* f.read()).snapshots.at(-1)!.snapshot).toEqual(snapshot);
      }).pipe(run),
    ordinaryMergeFixtureTimeout,
  );

  effectIt.effect(
    'cancels retained-object reads, final source capture and the final fence before any pin or receipt writes',
    () =>
      Effect.gen(function* () {
        const f = yield* mergeFixture();
        const before = yield* f.fs.readFileString(f.statePath());
        const stored = JSON.parse(before);
        const journal = yield* f.fs.readFileString(f.journalPath(stored.bindingId));
        const refs = yield* retentionRefs(f);
        const executor = yield* CommandExecutor;
        for (const point of ['retained-pin', 'source-renormalize', 'final-fence']) {
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let retentionStarted = false;
          let held = false;
          const beforeCommand = (args: readonly string[]) =>
            Effect.gen(function* () {
              const pinRead =
                args.includes('show-ref') && EffectArray.some(args, arg => EffectString.includes('/merge-prior/')(arg));
              if (pinRead) retentionStarted = true;
              if (
                held ||
                !retentionStarted ||
                !(point === 'retained-pin'
                  ? pinRead
                  : point === 'source-renormalize'
                    ? args.includes('--renormalize')
                    : args.includes(`${f.old.baselines.one.pinnedRef}^{tree}`))
              )
                return;
              held = true;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            });
          const blocked = CommandExecutor.of({
            ...executor,
            execute: (executable, args, options) =>
              beforeCommand(args).pipe(Effect.andThen(executor.execute(executable, args, options))),
            executeBytes: (executable, args, options) =>
              beforeCommand(args).pipe(Effect.andThen(executor.executeBytes!(executable, args, options))),
          });
          yield* Effect.acquireUseRelease(
            f.capture().pipe(Effect.provideService(CommandExecutor, blocked), Effect.forkChild),
            child =>
              Effect.gen(function* () {
                yield* Deferred.await(entered);
                yield* Effect.sync(() => child.interruptUnsafe());
                // Completion while the gate is still closed proves the pre-pin work was interruptible.
                const exit = yield* Fiber.await(child).pipe(Effect.timeout('5 seconds'));
                expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
                expect(held).toBe(true);
                expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
                expect(yield* f.fs.readFileString(f.journalPath(stored.bindingId))).toBe(journal);
                expect(yield* retentionRefs(f)).toBe(refs);
              }),
            child => Deferred.succeed(release, undefined).pipe(Effect.andThen(Fiber.interrupt(child))),
          );
        }
      }).pipe(run),
    ordinaryMergeFixtureTimeout,
  );

  effectIt.effect(
    'settles an in-flight rename before cancellation can race retention cleanup',
    () =>
      Effect.gen(function* () {
        const f = yield* mergeFixture();
        const fs = yield* FileSystem.FileSystem;
        const stateFile = yield* fs.realPath(f.statePath());
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const held = FileSystem.FileSystem.of({
          ...fs,
          rename: (from, to) =>
            to === stateFile
              ? Effect.gen(function* () {
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                  yield* fs.rename(from, to);
                })
              : fs.rename(from, to),
        });
        yield* Effect.acquireUseRelease(
          f.capture().pipe(Effect.provideService(FileSystem.FileSystem, held), Effect.forkChild),
          child =>
            Effect.gen(function* () {
              yield* Deferred.await(entered);
              yield* Effect.sync(() => child.interruptUnsafe());
              yield* Deferred.succeed(release, undefined);
              const exit = yield* Fiber.await(child);
              expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
              const snapshot = (yield* f.read()).snapshots.at(-1)!.snapshot;
              expect(snapshot.snapshotId).toBe(f.fields.snapshotId);
              expect(yield* retentionRefs(f)).toContain(snapshot.pinnedRef);
              expect(yield* retentionRefs(f)).toContain(snapshot.ordinaryMergeQualificationV1!.currentHeadRef);
            }),
          child => Deferred.succeed(release, undefined).pipe(Effect.andThen(Fiber.interrupt(child))),
        );
      }).pipe(run),
    ordinaryMergeFixtureTimeout,
  );

  effectIt.effect(
    'retains uncertain evidence when readback is unavailable, changed, or conditional cleanup loses an exact ref',
    () =>
      Effect.gen(function* () {
        const f = yield* mergeFixture();
        const initialState = yield* f.fs.readFileString(f.statePath());
        // Share only the real prepared ancestry. Distinct IDs isolate retained pins;
        // the state-mutating fault runs last so no scenario needs a state rewind.
        for (const point of ['unreadable', 'changed-ref', 'changed-state']) {
          const fields = {...f.fields, snapshotId: `${f.fields.snapshotId}-${point}`};
          const stored = (yield* readNativeWorkflowState(f.config, 'native-run'))!;
          const before = yield* f.fs.readFileString(f.statePath());
          expect(before).toBe(initialState);
          const journal = yield* f.fs.readFileString(f.journalPath(stored.state.bindingId));
          const priorRefs = yield* retentionRefs(f);
          const fs = yield* FileSystem.FileSystem;
          const stateFile = yield* fs.realPath(f.statePath());
          const executor = yield* CommandExecutor;
          let injected = false;
          const changedRef = `refs/threadnote/cycles/merge-head/${sha256HexSync(JSON.stringify([stored.state.bindingId, 'merge-head', fields.snapshotId]))}`;
          const failed = FileSystem.FileSystem.of({
            ...fs,
            rename: (from, to) =>
              to === stateFile && !injected
                ? Effect.gen(function* () {
                    injected = true;
                    if (point === 'changed-state') {
                      const cycle = stored.state.cycle!;
                      const changed = {
                        ...stored.state,
                        cycle: {
                          ...cycle,
                          state: {
                            ...cycle.state,
                            phases: {
                              ...cycle.state.phases,
                              one: {
                                ...cycle.state.phases.one,
                                reason: 'A separate durable revision superseded the old image',
                              },
                            },
                          },
                        },
                      };
                      yield* fs.writeFileString(to, stableJson(decodeNativeWorkflowState(changed)) + '\n');
                    }
                    if (point === 'changed-ref')
                      yield* f
                        .git(['update-ref', changedRef, f.prior.head])
                        .pipe(Effect.provideService(CommandExecutor, executor), Effect.orDie);
                    return yield* syntheticIo(to);
                  })
                : fs.rename(from, to),
            readFileString: (path, encoding) =>
              point === 'unreadable' && injected && path === stateFile
                ? Effect.fail(syntheticIo(path))
                : fs.readFileString(path, encoding),
          });
          refused(
            yield* f
              .mutate('snapshot', fields)
              .pipe(Effect.provideService(FileSystem.FileSystem, failed), Effect.result),
            'ordinary-merge-recovery-required',
          );
          expect(injected).toBe(true);
          expect(yield* f.fs.readFileString(f.journalPath(stored.state.bindingId))).toBe(journal);
          const refs = yield* retentionRefs(f);
          expect(EffectString.split(EffectString.trim(refs), '\n').length).toBe(
            EffectString.split(EffectString.trim(priorRefs), '\n').length + 5,
          );
          // Later uncertainty must also preserve every earlier exact retained ref.
          expect(EffectString.split(EffectString.trim(refs), '\n')).toEqual(
            expect.arrayContaining(EffectString.split(EffectString.trim(priorRefs), '\n')),
          );
          if (point !== 'changed-state') expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
          expect((yield* f.read()).snapshots.at(-1)!.snapshot.snapshotId).toBe(f.prior.snapshotId);
          if (point === 'changed-ref')
            expect(EffectString.trim((yield* f.git(['rev-parse', changedRef])).stdout)).toBe(f.prior.head);
        }
      }).pipe(run),
    ordinaryMergeFixtureTimeout,
  );

  effectIt.effect(
    'conserves 295=179+116 with a moved same-label base, immutable history and the exact current-base phase patch',
    () =>
      Effect.gen(function* () {
        const f = yield* mergeFixture(true);
        const snapshot = yield* f.capture();
        const proof = snapshot.ordinaryMergeQualificationV1!;
        expect(snapshot.version).toBe(2);
        expect(snapshot.files).toHaveLength(295);
        expect(snapshot.scopeFiles).toHaveLength(179);
        expect(proof.upstreamEvidence).toHaveLength(116);
        expect(proof.inheritedUpstreamOnlyPaths).toEqual(f.inherited);
        expect(proof.fromBaseBranch).toBe(proof.toBaseBranch);
        expect(proof.priorDeclaredBaseHead).toBe(f.prior.declaredBaseHead);
        expect(snapshot.supersedes).toBe(f.prior.snapshotId);
        const runtime = yield* f.read();
        expect(runtime.baselines).toEqual(f.old.baselines);
        expect(runtime.snapshots.slice(0, f.old.snapshots.length)).toEqual(f.old.snapshots);
        expect(runtime.reviews).toEqual(f.old.reviews);
        expect(runtime.attempts).toEqual(f.old.attempts);
        expect(runtime.reviewLimits).toEqual(f.old.reviewLimits);
        expect(runtime.snapshots.at(-1)!.incoming).toHaveLength(115);
        let patch = '';
        let sourceDigest: unknown;
        let offsetBytes = 0;
        for (let pages = 0; ; pages++) {
          expect(pages).toBeLessThan(20);
          const detail = object(
            yield* f.call({
              ...f.base('cycle'),
              command: 'detail',
              snapshotId: snapshot.snapshotId,
              detailKind: 'patch',
              maxBytes: 65_536,
              offsetBytes,
              ...(sourceDigest ? {sourceDigest} : {}),
            }),
          );
          const page = object(detail.page);
          patch += String(page.text);
          if (page.nextOffsetBytes === null) break;
          sourceDigest = page.sourceDigest;
          offsetBytes = Number(page.nextOffsetBytes);
        }
        expect(patch).toBe(
          (yield* f.git([
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--binary',
            snapshot.scopeBase,
            snapshot.tree,
            '--',
            ...EffectArray.map(f.one, path => `:(literal)${path}`),
          ])).stdout,
        );
        expect(patch).toContain('"current"');
        for (const path of [...f.inherited, ...f.two]) expect(patch).not.toContain(`b/${path}`);
        expect(
          (yield* f.mutate('validate-review', {
            snapshotId: snapshot.snapshotId,
            attemptId: 'incremental-refused',
            report: report(snapshot, 'incremental'),
          })).status,
        ).toBe('error');
        expect(
          (yield* f.mutate('validate-review', {
            snapshotId: snapshot.snapshotId,
            attemptId: 'full-current',
            report: report(snapshot),
          })).status,
        ).toBe('ok');
        expect(
          (yield* f.mutate('ready', {
            phaseId: 'one',
            snapshotId: snapshot.snapshotId,
            validation: {
              snapshotTree: snapshot.tree,
              reviewTree: snapshot.tree,
              status: 'passed',
              productState: 'working',
              checks: [{command: 'private integration', result: 'passed', evidence: 'Exact current-base phase patch'}],
              acceptance: [{criterion: 'one works', result: 'passed', evidence: 'Private fixture'}],
            },
          })).status,
        ).toBe('ok');
        for (const [ref, commit] of [
          [proof.priorHeadRef, f.prior.head],
          [proof.currentHeadRef, f.head],
          [proof.priorBaseRef, f.prior.declaredBaseHead],
          [proof.currentBaseRef, snapshot.declaredBaseHead],
        ])
          expect(EffectString.trim((yield* f.git(['rev-parse', ref + '^{commit}'])).stdout)).toBe(commit);
        expect(yield* f.capture()).toEqual(snapshot);
      }).pipe(run),
    ordinaryMergeFixtureTimeout,
  );

  effectIt.effect(
    'rejects unqualified source, forged ownership, missing authority and rebase laundering without writing evidence or refs',
    () =>
      Effect.gen(function* () {
        const f = yield* mergeFixture();
        const before = yield* f.fs.readFileString(f.statePath());
        const refs = (yield* f.git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/threadnote/'])).stdout;
        const input = f.fields.ordinaryMergeQualificationV1;
        const {ordinaryMergeQualificationV1: _proof, ...ordinary} = f.fields;
        for (const fields of [
          {...ordinary, protocolVersion: 1},
          {...f.fields, protocolVersion: 1},
          {...f.fields, userAuthority: undefined},
          {...f.fields, acceptedHead: undefined},
          {...f.fields, ordinaryMergeQualificationV1: {...input, currentBaseHead: f.prior.declaredBaseHead}},
          {...f.fields, ordinaryMergeQualificationV1: {...input, phaseOwnedPaths: input.phaseOwnedPaths.slice(0, 1)}},
          {
            ...f.fields,
            ordinaryMergeQualificationV1: {
              ...input,
              phaseOwnedPaths: [...input.phaseOwnedPaths, input.phaseOwnedPaths[0]],
            },
          },
          {
            ...ordinary,
            protocolVersion: 1,
            baseRequalification: {
              preRebaseHead: f.prior.head,
              ontoHead: input.currentBaseHead,
              rebasedHead: f.head,
              fromBaseBranch: 'main',
            },
          },
        ]) {
          refused(yield* f.mutate('snapshot', fields).pipe(Effect.result));
          expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
          expect((yield* f.git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/threadnote/'])).stdout).toBe(
            refs,
          );
        }
        refused(
          yield* f
            .call({
              ...f.base('cycle'),
              command: 'snapshot',
              ...f.fields,
              expectedRevision: EffectString.repeat(64)('0'),
            })
            .pipe(Effect.result),
          'state-conflict',
        );
        yield* f.fs.writeFileString(f.path.join(f.repo, 'unknown.ts'), 'unreviewed\n');
        refused(yield* f.capture().pipe(Effect.result), 'invalid-ordinary-merge');
        yield* f.git(['add', 'unknown.ts']);
        yield* f.git(['commit', '-m', 'Unreviewed path must remain refused']);
        const unknownHead = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
        refused(
          yield* f
            .mutate('snapshot', {
              ...f.fields,
              acceptedHead: unknownHead,
              ordinaryMergeQualificationV1: {...f.fields.ordinaryMergeQualificationV1, currentHead: unknownHead},
            })
            .pipe(Effect.result),
          'invalid-ordinary-merge',
        );
        expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
        expect((yield* f.git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/threadnote/'])).stdout).toBe(
          refs,
        );
      }).pipe(run),
    ordinaryMergeFixtureTimeout,
  );

  for (const kind of ['base', 'head', 'branch', 'tree', 'prior-pin']) {
    effectIt.effect(
      `fences ${kind} drift after proof construction with no new snapshot, journal or pin writes`,
      () =>
        Effect.gen(function* () {
          const f = yield* mergeFixture();
          yield* f.git(['branch', 'alternate', f.head]);
          const before = yield* f.fs.readFileString(f.statePath());
          const stored = JSON.parse(before);
          const journal = yield* f.fs.readFileString(f.journalPath(stored.bindingId));
          const refs = (yield* f.git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/threadnote/'])).stdout;
          const executor = yield* CommandExecutor;
          const originalSource = yield* f.fs.readFileString(f.path.join(f.repo, 'source.ts'));
          let injected = false;
          const result = yield* f.capture().pipe(
            Effect.provideService(
              CommandExecutor,
              CommandExecutor.of({
                ...executor,
                execute: (executable, args, options) =>
                  executor.execute(executable, args, options).pipe(
                    Effect.tap(() =>
                      Effect.gen(function* () {
                        if (
                          injected ||
                          !args.includes('show-ref') ||
                          !EffectArray.some(args, arg => EffectString.includes('/merge-prior/')(arg))
                        )
                          return;
                        injected = true;
                        if (kind === 'base') yield* f.git(['update-ref', 'refs/heads/main', f.prior.declaredBaseHead]);
                        if (kind === 'head') yield* f.git(['update-ref', 'refs/heads/feature/one', f.prior.head]);
                        if (kind === 'branch') yield* f.git(['symbolic-ref', 'HEAD', 'refs/heads/alternate']);
                        if (kind === 'tree')
                          yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'changed during capture\n');
                        if (kind === 'prior-pin')
                          yield* f.git(['update-ref', f.prior.pinnedRef, f.old.baselines.one.tree]);
                      }).pipe(Effect.provideService(CommandExecutor, executor), Effect.orDie),
                    ),
                  ),
              }),
            ),
            Effect.result,
          );
          expect(injected).toBe(true);
          refused(result, 'source-drift');
          expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
          expect(yield* f.fs.readFileString(f.journalPath(stored.bindingId))).toBe(journal);
          yield* f.git(['symbolic-ref', 'HEAD', 'refs/heads/feature/one']);
          yield* f.git(['update-ref', 'refs/heads/feature/one', f.head]);
          yield* f.git(['update-ref', 'refs/heads/main', f.fields.ordinaryMergeQualificationV1.currentBaseHead]);
          yield* f.git(['update-ref', f.prior.pinnedRef, f.prior.tree]);
          yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), originalSource);
          expect((yield* f.git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/threadnote/'])).stdout).toBe(
            refs,
          );
          expect((yield* f.capture()).ordinaryMergeQualificationV1).toBeDefined();
        }).pipe(run),
      ordinaryMergeFixtureTimeout,
    );
  }
});

const rewrittenBaseFixture = Effect.fn('test.nativeCycle.rewrittenBaseFixture')(function* (
  large = false,
  delivery: 'local' | 'pr' = 'local',
) {
  const f = yield* fixture(['one', 'two'], delivery, false, false, false, undefined, repo =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const git = (args: readonly string[]) => yieldCommand(repo, args);
      yield* git(['checkout', 'main']);
      yield* fs.writeFileString(repo + '/historical.ts', 'export const historical = true;\n');
      yield* git(['add', '.']);
      yield* git(['commit', '-m', 'Historical declared base divergent from phase']);
      yield* git(['checkout', 'feature/one']);
    }),
  );
  const priorPlan = yield* f.revise({
    phases: EffectArray.map(f.document.phases, phase => ({
      ...phase,
      affectedPaths: phase.id === 'one' ? ['source.ts', 'prior-only.ts'] : phase.affectedPaths,
    })),
  });
  yield* f.mutate('reconcile', {
    plan: priorPlan,
    reason: 'Retain exact staged prior-only path in the historical phase contract',
  });
  const root = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
  yield* f.git(['commit', '--allow-empty', '-m', 'Original phase HEAD']);
  const priorHead = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
  yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const stagedOnly = true;\n');
  yield* f.fs.writeFileString(f.path.join(f.repo, 'prior-only.ts'), 'export const stagedOnlyPath = true;\n');
  yield* f.git(['add', 'source.ts', 'prior-only.ts']);
  const prior = yield* Schema.decodeUnknownEffect(NativeCycleSnapshotSchema)(
    object(
      (yield* f.mutate('snapshot', {
        phaseId: 'one',
        snapshotId: 'prior',
        acceptedHead: priorHead,
        reason: 'Retain staged-only prior source',
      })).snapshot,
    ).snapshot,
  );
  yield* f.mutate('validate-review', {snapshotId: prior.snapshotId, attemptId: 'prior-review', report: report(prior)});
  yield* f.mutate('extend-reviews', {
    phaseId: 'one',
    reviewLimit: 10,
    userAuthority: 'Continue the existing review history',
  });
  yield* f.git(['restore', '--staged', '--worktree', 'source.ts']);
  yield* f.git(['rm', '--cached', 'prior-only.ts']);
  yield* f.fs.remove(f.path.join(f.repo, 'prior-only.ts'));
  yield* f.fs.writeFileString(f.path.join(f.repo, 'owned.ts'), 'export const owned = true;\n');
  yield* f.fs.writeFileString(f.path.join(f.repo, 'other-owned.ts'), 'export const otherOwned = true;\n');
  yield* f.git(['add', '.']);
  yield* f.git(['commit', '-m', 'Reconcile staged predecessor into current owned implementation']);
  yield* f.git(['checkout', '-b', 'rewritten', root]);
  yield* f.fs.writeFileString(f.path.join(f.repo, 'upstream.ts'), 'export const rewritten = true;\n');
  for (let index = 0; index < (large ? 410 : 0); index++)
    yield* f.fs.writeFileString(f.path.join(f.repo, `upstream-${index}.ts`), 'export const inherited = true;\n');
  yield* f.git(['add', '.']);
  yield* f.git(['commit', '-m', 'Rewritten published upstream']);
  const rewrittenParentHead = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
  yield* f.git(['commit', '--allow-empty', '-m', 'Equivalent upstream tree with a distinct base identity']);
  const currentBaseHead = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
  yield* f.git(['branch', '-f', 'main', currentBaseHead]);
  yield* f.git(['checkout', 'feature/one']);
  yield* f.git(['merge', '--no-ff', 'main', '-m', 'Preserve phase lineage while integrating rewritten base']);
  yield* f.git(['commit', '--allow-empty', '-m', 'Later descendant of legitimate integration']);
  const head = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
  const currentDocument = {
    ...f.document,
    phases: EffectArray.map(f.document.phases, phase => ({
      ...phase,
      affectedPaths: phase.id === 'one' ? ['owned.ts'] : ['other-owned.ts'],
      contracts: [...phase.contracts, 'Approved qualification prerequisite changes current phase definition.'],
    })),
  };
  // Reuse the authoring save/export boundary with the latest immutable root revision after the initial amendment.
  const priorRoot = object(object(priorPlan.source).root);
  const saved = object(
    object(
      yield* f.call({
        ...f.base('authoring'),
        command: 'save',
        document: currentDocument,
        ready: true,
        uri: priorRoot.uri,
        expectedRevision: priorRoot.revision,
      }),
    ).authoring,
  );
  const plan = object(
    object(
      yield* f.call({
        ...f.base('authoring'),
        command: 'export-dev-cycle',
        uri: object(saved.root).uri,
        delivery,
        bindings: {
          one: {branch: 'feature/one', baseBranch: 'main'},
          two: {branch: 'feature/two', baseBranch: 'main'},
        },
      }),
    ).authoring,
  );
  yield* f.mutate('reconcile', {plan, reason: 'Approved prerequisite retained with original phase history'});
  const read = () =>
    readNativeWorkflowState(f.config, 'native-run').pipe(
      Effect.map(stored => decodeNativeCycleRuntime(stored!.state.cycle)),
    );
  const old = yield* read();
  const predecessorManifest = object(
    yield* f.call({
      ...f.base('cycle'),
      command: 'detail',
      snapshotId: prior.snapshotId,
      detailKind: 'manifest',
      maxBytes: 65536,
    }),
  );
  const predecessorCAS = object(predecessorManifest.sameLabelRebasedBaseCAS);
  expect(predecessorCAS.priorSnapshotId).toBe(prior.snapshotId);
  const fields = {
    protocolVersion: 3,
    phaseId: 'one',
    snapshotId: 'qualified',
    previous: prior.snapshotId,
    acceptedHead: head,
    reason: 'Reconcile same-label upstream rewrite and staged snapshot explicitly',
    userAuthority: 'Integrate the rewritten same-label base in the existing run with all original history retained',
    sameLabelRebasedBaseIntegrationV1: {
      priorSnapshotId: prior.snapshotId,
      expectedPriorEntryDigest: predecessorCAS.expectedPriorEntryDigest,
      expectedPriorReviewDigest: predecessorCAS.expectedPriorReviewDigest,
      currentBaseHead,
      currentHead: head,
      sameBaseBranch: 'main',
      authorityKind: 'same-label-upstream-rebase-integration',
      planDocumentHash: object(plan.source).documentHash,
      phaseOwnedPaths: [
        {phaseId: 'one', paths: ['owned.ts']},
        {phaseId: 'two', paths: ['other-owned.ts']},
      ],
    },
  };
  return {...f, read, old, prior, fields, head, currentBaseHead, rewrittenParentHead};
});
const yieldCommand = (repo: string, args: readonly string[]) => runCommandEffect('git', ['-C', repo, ...args]);

describe('same-label rewritten-base native qualification', () => {
  effectIt.effect(
    'retains legacy staged snapshots and historical scope while forcing full current-base review without resetting history',
    () =>
      Effect.gen(function* () {
        const f = yield* rewrittenBaseFixture(true);
        expect(f.prior.scopeBase).not.toBe(
          EffectString.trim((yield* f.git(['rev-parse', f.prior.declaredBaseHead + '^{tree}'])).stdout),
        );
        expect(f.prior.tree).not.toBe(
          EffectString.trim((yield* f.git(['rev-parse', f.prior.head + '^{tree}'])).stdout),
        );
        const spawner = yield* ChildProcessSpawner;
        let measuring = false,
          finished = false,
          trackedExecution = false;
        let commands = 0,
          argumentBytes = 0,
          outputBytes = 0,
          started = 0,
          elapsedMs = 0;
        const ownedChildren = new Set<number>();
        const captureTrees: {baseTree: string; tree: string}[] = [];
        const treeBatches: Record<string, {batches: number; pathArguments: number; paths: Set<string>}> = {};
        const noteCommand = (args: readonly string[]) =>
          Effect.gen(function* () {
            if (!measuring && !finished && args.includes('--show-toplevel')) {
              measuring = true;
              started = yield* Clock.currentTimeMillis;
            }
            trackedExecution = measuring;
            if (!measuring) return;
            commands++;
            argumentBytes += EffectArray.reduce(
              args,
              0,
              (total, arg) => total + new TextEncoder().encode(arg).byteLength + 1,
            );
            const objects = EffectArray.filter(args, arg => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(arg));
            if (args.includes('diff') && args.includes('--raw'))
              captureTrees.push({baseTree: objects[0], tree: objects[1]});
            if (args.includes('ls-tree')) {
              const tree = objects[0];
              const batch = (treeBatches[tree] ??= {batches: 0, pathArguments: 0, paths: new Set()});
              const paths = EffectArray.filter(args, arg => EffectString.startsWith(':(literal)')(arg));
              batch.batches++;
              batch.pathArguments += paths.length;
              for (const path of paths) batch.paths.add(EffectString.slice(10)(path));
            }
            if (args.includes('update-ref') && args.includes('--stdin')) {
              elapsedMs = (yield* Clock.currentTimeMillis) - started;
              measuring = false;
              finished = true;
            }
          });
        const measuredSpawner = ChildProcessSpawner.of({
          ...spawner,
          spawn: command =>
            spawner.spawn(command).pipe(
              Effect.tap(handle =>
                Effect.sync(() => {
                  if (trackedExecution) ownedChildren.add(Number(handle.pid));
                }),
              ),
            ),
        });
        const executorContext = yield* Layer.build(Layer.fresh(CommandExecutor.layer)).pipe(
          Effect.provideService(ChildProcessSpawner, measuredSpawner),
        );
        const executor = Context.get(executorContext, CommandExecutor);
        const measured = CommandExecutor.of({
          ...executor,
          execute: (executable, args, options) =>
            Effect.gen(function* () {
              yield* noteCommand(args);
              const result = yield* executor.execute(executable, args, options);
              if (measuring) outputBytes += new TextEncoder().encode(result.stdout + result.stderr).byteLength;
              return result;
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  trackedExecution = false;
                }),
              ),
            ),
          executeBytes: (executable, args, options) =>
            Effect.gen(function* () {
              yield* noteCommand(args);
              const result = yield* executor.executeBytes!(executable, args, options);
              if (measuring)
                outputBytes += result.stdout.byteLength + new TextEncoder().encode(result.stderr).byteLength;
              return result;
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  trackedExecution = false;
                }),
              ),
            ),
        });
        let preparedBytes = 0;
        const fs = yield* FileSystem.FileSystem;
        const stateFile = yield* fs.realPath(f.statePath());
        const measuredFs = FileSystem.FileSystem.of({
          ...fs,
          writeFileString: (path, data, options) => {
            if (EffectString.startsWith(stateFile + '.')(path) && EffectString.endsWith('.tmp')(path))
              preparedBytes = new TextEncoder().encode(data).byteLength;
            return fs.writeFileString(path, data, options);
          },
        });
        const admitted = yield* f
          .mutate('snapshot', f.fields)
          .pipe(
            Effect.provideService(CommandExecutor, measured),
            Effect.provideService(ChildProcessSpawner, measuredSpawner),
            Effect.provideService(FileSystem.FileSystem, measuredFs),
          );
        expect(finished).toBe(true);
        expect(commands).toBeLessThanOrEqual(nativeCycleSameLabelQualificationLimits.commands);
        expect(ownedChildren.size, 'observed native child spawns').toBeGreaterThan(0);
        expect(preparedBytes, 'observed prepared state bytes').toBeGreaterThan(0);

        expect(admitted.status).not.toBe('error');
        const snapshot = (yield* f.read()).snapshots.at(-1)!.snapshot;
        expect(snapshot.snapshotId).toBe(f.fields.snapshotId);
        const proof = snapshot.sameLabelRebasedBaseIntegrationV1!;
        expect(snapshot.version).toBe(3);
        expect(snapshot.supersedes).toBe(f.prior.snapshotId);
        expect(snapshot.phaseHash).not.toBe(f.prior.phaseHash);
        expect(proof.priorScopeBase).toBe(f.prior.scopeBase);
        expect(proof.priorDeclaredBaseHead).toBe(f.prior.declaredBaseHead);
        expect(proof.historicalMergeBases).not.toContain(f.prior.declaredBaseHead);
        expect(proof.reconciliationPaths).toContain('source.ts');
        expect(f.prior.files).toContain('prior-only.ts');
        expect(
          EffectString.trim((yield* f.git(['ls-tree', '-r', f.old.baselines.one.tree, '--', 'prior-only.ts'])).stdout),
        ).toBe('');
        expect(
          EffectString.trim((yield* f.git(['ls-tree', '-r', f.currentBaseHead, '--', 'prior-only.ts'])).stdout),
        ).toBe('');
        expect(proof.reconciliationPaths).toContain('prior-only.ts');
        expect(snapshot.files).not.toContain('prior-only.ts');
        const removed = EffectOption.getOrUndefined(
          EffectArray.findFirst(proof.reconciliationEvidence, item => item.path === 'prior-only.ts'),
        );
        expect(removed).toMatchObject({
          baseline: {mode: '000000'},
          currentBase: {mode: '000000'},
          prior: {mode: '100644'},
          head: {mode: '000000'},
        });

        expect(snapshot.files).not.toContain('source.ts');
        expect(proof.phaseOwnedPaths).toEqual([
          {phaseId: 'one', paths: ['owned.ts']},
          {phaseId: 'two', paths: ['other-owned.ts']},
        ]);
        const current = yield* f.read();
        for (const key of ['baselines', 'reviews', 'attempts', 'reviewLimits', 'reviewExpansions', 'plans'] as const)
          expect(current[key]).toEqual(f.old[key]);
        expect(current.snapshots.slice(0, -1)).toEqual(f.old.snapshots);
        expect(current.state).toEqual(f.old.state);
        const detail = object(
          yield* f.call({
            ...f.base('cycle'),
            command: 'detail',
            snapshotId: snapshot.snapshotId,
            detailKind: 'patch',
            maxBytes: 65_536,
          }),
        );
        expect(JSON.stringify(detail)).toContain('stagedOnly');
        expect(JSON.stringify(detail)).toContain('owned.ts');
        const treeRoles = {
          baseline: proof.baselineTree,
          historicalDeclaredBase: proof.priorDeclaredBaseTree,
          actualPriorScope: proof.priorScopeBase,
          priorSnapshot: proof.priorTree,
          currentBase: proof.currentBaseTree,
          current: snapshot.tree,
        };
        const cost = {
          evidenceAdmissions: commands,
          actualOwnedChildren: ownedChildren.size,
          argumentBytes,
          outputBytes,
          elapsedMs,
          retentionAdmissionIncluded: true,
          captures: EffectArray.map(captureTrees, (capture, index) => ({
            ...capture,
            kind:
              index === captureTrees.length - 1
                ? 'closing'
                : capture.baseTree === proof.baselineTree
                  ? 'opening-baseline'
                  : capture.baseTree === proof.currentBaseTree
                    ? 'current-base'
                    : 'prior-reconciliation',
          })),
          treeRoles,
          uniqueTreeLookups: EffectArray.map(EffectRecord.toEntries(treeBatches), ([tree, batch]) => ({
            tree,
            batches: batch.batches,
            pathArguments: batch.pathArguments,
            uniquePaths: batch.paths.size,
          })),
          receiptBytes: new TextEncoder().encode(stableJson(proof)).byteLength,
          preparedStoredBytes: preparedBytes,
          preparedLogicalBytes: new TextEncoder().encode(
            stableJson((yield* readNativeWorkflowState(f.config, 'native-run'))!.state) + '\n',
          ).byteLength,
          detailPageBytes: new TextEncoder().encode(JSON.stringify(detail)).byteLength,
          detailExportTotalBytes: object(detail.page).totalBytes,
        };
        yield* Effect.sync(() => process.stdout.write('SAME_LABEL_QUALIFICATION_COST ' + JSON.stringify(cost) + '\n'));

        const beforeRetry = yield* f.fs.readFileString(f.statePath());
        yield* f.mutate('snapshot', f.fields);
        expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeRetry);
        expect(
          (yield* f.mutate('validate-review', {
            snapshotId: snapshot.snapshotId,
            attemptId: 'incremental',
            report: report(snapshot, 'incremental'),
          })).status,
        ).toBe('error');
        yield* f.mutate('validate-review', {
          snapshotId: snapshot.snapshotId,
          attemptId: 'current-full',
          report: report(snapshot),
        });
        expect((yield* f.read()).reviews).toHaveLength(f.old.reviews.length + 1);
        yield* f.mutate('ready', {
          phaseId: 'one',
          snapshotId: snapshot.snapshotId,
          validation: {
            snapshotTree: snapshot.tree,
            reviewTree: snapshot.tree,
            status: 'passed',
            productState: 'working',
            checks: [{command: 'private integration', result: 'passed', evidence: 'Exact qualified source'}],
            acceptance: [{criterion: 'one works', result: 'passed', evidence: 'Private fixture'}],
          },
        });
        expect(object(yield* f.call({...f.base('cycle'), command: 'publication-ready', phaseId: 'one'})).status).toBe(
          'ok',
        );
        yield* f.git(['update-ref', 'refs/heads/main', f.prior.head]);
        refused(yield* f.call({...f.base('cycle'), command: 'publication-ready', phaseId: 'one'}).pipe(Effect.result));
        const check = () => f.call({...f.base('cycle'), command: 'check', snapshotId: snapshot.snapshotId});
        // C001: plain check enforces the qualified branch/base without a phase argument.
        refused(yield* check().pipe(Effect.result));
        yield* f.git(['update-ref', 'refs/heads/main', f.currentBaseHead]);
        yield* f.git(['checkout', '-b', 'same-head-alias', f.head]);
        refused(yield* check().pipe(Effect.result));
        yield* f.git(['checkout', 'feature/one']);
        // C002: the historical declared-base commit pin is independent of the staged snapshot tree pin.
        yield* f.git(['update-ref', '-d', proof.priorBaseRef]);
        refused(yield* check().pipe(Effect.result));
        yield* f.git(['update-ref', proof.priorBaseRef, proof.priorDeclaredBaseHead]);
        expect(object(yield* check()).status).toBe('unchanged');
        // NQ01-SEC001: a distinct rewritten base with the same tree must retire old ready H/T evidence.
        const readyRuntime = yield* f.read();
        const oldReady = readyRuntime.state.phases.one;
        yield* f.git(['update-ref', 'refs/heads/main', f.rewrittenParentHead]);
        const repeatCAS = object(
          object(
            yield* f.call({
              ...f.base('cycle'),
              command: 'detail',
              snapshotId: snapshot.snapshotId,
              detailKind: 'manifest',
              maxBytes: 65536,
            }),
          ).sameLabelRebasedBaseCAS,
        );
        const repeatFields = {
          ...f.fields,
          snapshotId: 'qualified-same-source',
          previous: snapshot.snapshotId,
          sameLabelRebasedBaseIntegrationV1: {
            ...f.fields.sameLabelRebasedBaseIntegrationV1,
            priorSnapshotId: snapshot.snapshotId,
            currentBaseHead: f.rewrittenParentHead,
            expectedPriorEntryDigest: repeatCAS.expectedPriorEntryDigest,
            expectedPriorReviewDigest: repeatCAS.expectedPriorReviewDigest,
          },
        };
        yield* f.mutate('snapshot', repeatFields);
        const repeated = yield* f.read();
        const repeatedSnapshot = repeated.snapshots.at(-1)!.snapshot;
        expect(repeatedSnapshot.head).toBe(snapshot.head);
        expect(repeatedSnapshot.tree).toBe(snapshot.tree);
        expect(repeatedSnapshot.declaredBaseHead).not.toBe(snapshot.declaredBaseHead);
        expect(repeated.state.phases.one.validation).toBeUndefined();
        expect(repeated.state.phases.one.history?.at(-1)?.validation).toEqual(oldReady.validation);
        expect(repeated.snapshots.slice(0, -1)).toEqual(readyRuntime.snapshots);
        expect(repeated.attempts).toEqual(readyRuntime.attempts);
        expect(repeated.reviews).toEqual(readyRuntime.reviews);
        const blockedReport = {
          ...report(repeatedSnapshot),
          findings: [
            {
              id: 'SEC001-blocker',
              file: 'owned.ts',
              line: 1,
              body: 'The current candidate has a concrete blocker.',
              trigger: 'Exercise current source.',
              impact: 'The operation fails.',
              evidence: 'Private retained regression report.',
              severity: 'important',
              category: 'security',
              confidence: 99,
              state: 'new',
            },
          ],
        };
        expect(
          (yield* f.mutate('validate-review', {
            snapshotId: repeatedSnapshot.snapshotId,
            attemptId: 'blocked-current-full',
            report: blockedReport,
          })).status,
        ).toBe('ok');
        refused(yield* f.call({...f.base('cycle'), command: 'publication-ready', phaseId: 'one'}).pipe(Effect.result));
        refused(yield* f.mutate('record-delivery', {phaseId: 'one'}).pipe(Effect.result));
        refused(
          yield* f
            .mutate('ready', {phaseId: 'one', snapshotId: repeatedSnapshot.snapshotId, validation: oldReady.validation})
            .pipe(Effect.result),
          'review-blocked',
        );
        expect((yield* f.read()).state.phases.one.validation).toBeUndefined();
      }).pipe(run),
    ordinaryMergeFixtureTimeout,
  );

  effectIt.effect(
    'completes a published manifest3 PR after active checkout and declared base advance',
    () =>
      Effect.gen(function* () {
        const f = yield* rewrittenBaseFixture(false, 'pr');
        yield* f.mutate('snapshot', f.fields);
        const snapshot = (yield* f.read()).snapshots.at(-1)!.snapshot;
        yield* f.mutate('validate-review', {
          snapshotId: snapshot.snapshotId,
          attemptId: 'full-qualified',
          report: report(snapshot),
        });
        yield* f.mutate('ready', {
          phaseId: 'one',
          snapshotId: snapshot.snapshotId,
          validation: {
            snapshotTree: snapshot.tree,
            reviewTree: snapshot.tree,
            status: 'passed',
            productState: 'working',
            checks: [{command: 'private fixture', result: 'passed', evidence: 'Exact qualified source'}],
            acceptance: [{criterion: 'one works', result: 'passed', evidence: 'Private fixture'}],
          },
        });
        const publication = {exemption: 'maintenance', reason: 'Private synthetic fixture.'};
        const delivery = {
          phaseId: 'one',
          phaseHash: snapshot.phaseHash,
          delivery: 'pr',
          headSha: snapshot.head,
          validatedTree: snapshot.tree,
          commitEvidence: 'Private clean committed fixture.',
          pr: {
            url: 'https://github.com/example/repo/pull/1',
            headSha: snapshot.head,
            branch: 'feature/one',
            baseBranch: 'main',
            state: 'open',
          },
          watch: {
            prUrl: 'https://github.com/example/repo/pull/1',
            headSha: snapshot.head,
            state: 'active',
            stateDir: f.path.join(f.root, 'watch'),
            consumerKind: 'orchestrator',
            consumerId: 'fixture',
            evidence: 'Private synthetic owned watch receipt.',
          },
        };
        yield* f.mutate('record-delivery', {phaseId: 'one', publication, delivery});
        const published = yield* f.read();
        const prior = published.state.phases.one.delivery!;
        yield* f.git(['checkout', 'main']);
        yield* f.fs.writeFileString(f.path.join(f.repo, 'later-base.ts'), 'export const later = true;\n');
        yield* f.git(['add', '.']);
        yield* f.git(['commit', '-m', 'Later base after publication']);
        const merged = {
          ...prior,
          pr: {...prior.pr!, state: 'merged'},
          watch: {...prior.watch!, state: 'terminal', evidence: 'Private owned watch observed the historical merge.'},
        };
        expect((yield* f.mutate('record-delivery', {phaseId: 'one', publication, delivery: merged})).status).toBe('ok');
        const completed = yield* f.read();
        expect(completed.state.phases.one.status).toBe('merged');
        expect(completed.snapshots).toEqual(published.snapshots);
        expect(completed.reviews).toEqual(published.reviews);
        expect(completed.attempts).toEqual(published.attempts);
      }).pipe(run),
    ordinaryMergeFixtureTimeout,
  );

  effectIt.effect(
    'refuses forged provenance, identities, owners, authority and source drift before surviving pin or state changes',
    () =>
      Effect.gen(function* () {
        const f = yield* rewrittenBaseFixture();
        const before = yield* f.fs.readFileString(f.statePath());
        const refs = EffectString.trim(
          (yield* f.git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/threadnote/'])).stdout,
        );
        const witness = f.fields.sameLabelRebasedBaseIntegrationV1;
        for (const patch of [
          {protocolVersion: 2},
          {userAuthority: ' '},
          {previous: 'missing'},
          {acceptedHead: f.prior.head},
          {sameLabelRebasedBaseIntegrationV1: {...witness, expectedPriorEntryDigest: EffectString.repeat(64)('f')}},
          {sameLabelRebasedBaseIntegrationV1: {...witness, expectedPriorReviewDigest: EffectString.repeat(64)('f')}},
          {sameLabelRebasedBaseIntegrationV1: {...witness, sameBaseBranch: 'other'}},
          {sameLabelRebasedBaseIntegrationV1: {...witness, phaseOwnedPaths: []}},
          {sameLabelRebasedBaseIntegrationV1: {...witness, currentHead: f.prior.head}},
          {sameLabelRebasedBaseIntegrationV1: {...witness, authorityKind: 'ordinary-merge'}},
        ]) {
          refused(yield* f.mutate('snapshot', {...f.fields, ...patch}).pipe(Effect.result));
          expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
          expect(
            EffectString.trim(
              (yield* f.git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/threadnote/'])).stdout,
            ),
          ).toBe(refs);
        }
        yield* f.git(['checkout', 'rewritten']);
        refused(yield* f.mutate('snapshot', f.fields).pipe(Effect.result));
        yield* f.git(['checkout', 'feature/one']);
        yield* f.git(['update-ref', 'refs/heads/main', f.prior.head]);
        refused(yield* f.mutate('snapshot', f.fields).pipe(Effect.result));
        yield* f.git(['update-ref', 'refs/heads/main', f.currentBaseHead]);
        yield* f.git(['update-ref', f.prior.pinnedRef, f.prior.scopeBase]);
        refused(yield* f.mutate('snapshot', f.fields).pipe(Effect.result));
        yield* f.git(['update-ref', f.prior.pinnedRef, f.prior.tree]);
        const executor = yield* CommandExecutor;
        let moved = false;
        const raced = CommandExecutor.of({
          ...executor,
          execute: (executable, args, options) =>
            Effect.gen(function* () {
              if (
                !moved &&
                args.includes('show-ref') &&
                EffectArray.some(args, arg => EffectString.includes('/merge-prior/')(arg))
              ) {
                moved = true;
                yield* executor.execute('git', ['-C', f.repo, 'update-ref', 'refs/heads/main', f.prior.head]);
              }
              return yield* executor.execute(executable, args, options);
            }),
        });
        refused(
          yield* f.mutate('snapshot', f.fields).pipe(Effect.provideService(CommandExecutor, raced), Effect.result),
        );
        expect(moved).toBe(true);
        yield* f.git(['update-ref', 'refs/heads/main', f.currentBaseHead]);
        expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
        expect(
          EffectString.trim(
            (yield* f.git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/threadnote/'])).stdout,
          ),
        ).toBe(refs);
        yield* f.fs.writeFileString(f.path.join(f.repo, 'owned.ts'), 'dirty\n');
        yield* f.git(['add', 'owned.ts']);
        refused(yield* f.mutate('snapshot', f.fields).pipe(Effect.result));
        expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
      }).pipe(run),
    ordinaryMergeFixtureTimeout,
  );
});

effectIt.effect('bounds aggregate command, argument, output and deadline acquisition before retention admission', () =>
  Effect.gen(function* () {
    const empty = {exitCode: 0, stdout: '', stderr: ''};
    let executed = 0,
      mutations = 0;
    const executor = CommandExecutor.of({
      execute: (_executable, args) =>
        Effect.sync(() => {
          executed++;
          if (args.includes('update-ref')) mutations++;
          return empty;
        }),
      executeStreaming: () => Effect.succeed(empty),
    });
    const commands = Effect.gen(function* () {
      for (let i = 0; i < 64; i++) yield* runCommandEffect('git', ['read']);
      yield* withNativeCycleSameLabelQualificationBudget(
        Effect.gen(function* () {
          for (let i = 0; i < 64; i++) yield* runCommandEffect('git', ['nested-read']);
        }),
      );
      yield* runCommandEffect('git', ['update-ref', '--stdin']);
    });
    refused(
      yield* withNativeCycleSameLabelQualificationBudget(commands).pipe(
        Effect.provideService(CommandExecutor, executor),
        Effect.result,
      ),
    );
    expect(executed).toBe(128);
    expect(mutations).toBe(0);
    executed = 0;
    refused(
      yield* withNativeCycleSameLabelQualificationBudget(
        runCommandEffect('git', [EffectString.repeat(1_048_576)('x')]),
      ).pipe(Effect.provideService(CommandExecutor, executor), Effect.result),
    );
    expect(executed).toBe(0);
    const multibyte = EffectString.repeat(262_143)('é');
    expect(new TextEncoder().encode(multibyte).byteLength).toBe(524_286);
    const cumulative = Effect.gen(function* () {
      yield* runCommandEffect('git', [multibyte]);
      yield* runCommandEffect('git', [multibyte]);
      yield* runCommandEffect('git', ['x']); // Exactly1048576UTF-8 argv bytes including argument terminators.
      yield* runCommandEffect('git', ['y']);
    });
    refused(
      yield* withNativeCycleSameLabelQualificationBudget(cumulative).pipe(
        Effect.provideService(CommandExecutor, executor),
        Effect.result,
      ),
    );
    expect(executed).toBe(3);
    executed = 0;
    const output = CommandExecutor.of({
      ...executor,
      execute: () =>
        Effect.sync(() => {
          executed++;
          return {
            exitCode: 0,
            stdout: EffectString.repeat(4_194_304)('x'),
            stderr: EffectString.repeat(4_194_304)('y'),
          };
        }),
    });
    refused(
      yield* withNativeCycleSameLabelQualificationBudget(
        runCommandEffect('git', ['read']).pipe(Effect.andThen(runCommandEffect('git', ['next']))),
      ).pipe(Effect.provideService(CommandExecutor, output), Effect.result),
    );
    expect(executed).toBe(1);
    const expired = CommandExecutor.of({
      ...executor,
      execute: () => TestClock.adjust('30 seconds').pipe(Effect.as(empty)),
    });
    refused(
      yield* withNativeCycleSameLabelQualificationBudget(runCommandEffect('git', ['read'])).pipe(
        Effect.provideService(CommandExecutor, expired),
        Effect.result,
      ),
    );
    const options: {timeoutMs?: number; maxOutputBytes?: number}[] = [];
    const remaining = CommandExecutor.of({
      ...executor,
      execute: (_executable, _args, option) =>
        Effect.sync(() => options.push(option ?? {})).pipe(
          Effect.andThen(TestClock.adjust('1 second')),
          Effect.as({...empty, stdout: 'read'}),
        ),
    });
    yield* withNativeCycleSameLabelQualificationBudget(
      runCommandEffect('git', ['one']).pipe(Effect.andThen(runCommandEffect('git', ['two']))),
    ).pipe(Effect.provideService(CommandExecutor, remaining));
    expect(options[0].timeoutMs).toBe(30_000);
    expect(options[1].timeoutMs).toBe(29_000);
    expect(options[0].maxOutputBytes).toBe(4_194_304);
    expect(options[1].maxOutputBytes).toBe(4_194_302);
  }),
);
