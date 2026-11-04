import {Array as EffectArray, String as EffectString} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Effect, Result, Schema} from 'effect';
import {describe, expect} from 'vitest';
import {CommandExecutor} from '@threadnote/platform/command';
import {decodeNativeCycleRuntime} from '@threadnote/workflow-automations/cycle-runtime';
import {NativeCycleSnapshotSchema, type NativeCycleSnapshot} from '@threadnote/workflow-automations/cycle-review';
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
