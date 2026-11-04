import {Array as EffectArray, String as EffectString} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Cause, Deferred, Effect, Exit, Fiber, FileSystem, PlatformError, Result, Schema} from 'effect';
import {describe, expect} from 'vitest';
import {CommandExecutor} from '@threadnote/platform/command';
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
import {fixture, object, run} from './native-cycle-lifecycle-fixture.js';

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
    {timeout: 60_000},
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
    {timeout: 60_000},
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
        const stateFile = yield* fs.realPath(f.statePath());
        for (const point of ['write', 'rename']) {
          let injected = false;
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
                    return Effect.fail(syntheticIo(to));
                  })
                : fs.rename(from, to),
          });
          refused(yield* f.capture().pipe(Effect.provideService(FileSystem.FileSystem, failed), Effect.result));
          expect(injected).toBe(true);
          expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
          expect(yield* f.fs.readFileString(f.journalPath(stored.state.bindingId))).toBe(journal);
          expect(yield* retentionRefs(f)).toBe(refs);
          expect(EffectString.trim((yield* f.git(['rev-parse', preexisting])).stdout)).toBe(tree);
        }
        expect((yield* f.capture()).snapshotId).toBe(f.fields.snapshotId);
      }).pipe(run),
    {timeout: 60_000},
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
    {timeout: 60_000},
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
    {timeout: 60_000},
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
    {timeout: 60_000},
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
    {timeout: 60_000},
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
    {timeout: 60_000},
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
    {timeout: 60_000},
  );

  effectIt.effect(
    'fences base, HEAD, phase branch, working tree and prior pin drift after proof construction with no new snapshot, journal or pin writes',
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
        for (const kind of ['base', 'head', 'branch', 'tree', 'prior-pin']) {
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
        }
        expect((yield* f.capture()).ordinaryMergeQualificationV1).toBeDefined();
      }).pipe(run),
    {timeout: 60_000},
  );
});
