import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path, Result, Schema} from 'effect';
import {Command} from 'effect/cli';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import * as fc from 'fast-check';
import {ResourceStore} from '@threadnote/store/resource-store';
import {ResourceRecallInvalidation} from '@threadnote/store/resource/recall-invalidation';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {runCommand} from '../../src/utils.js';
import {StandaloneBrokerLayer} from '../../src/effect/runtime-bootstrap.js';
import {captureConsole} from '../../src/effect/console.js';
import {
  applyShareReconcile,
  makeShareReconcileCommand,
  parseShareReconcilePlan,
  previewShareReconcile,
  runShareReconcile,
} from '../../src/share/reconcile.js';
import type {ShareReconcilePlan} from '../../src/share/reconcile.js';

const invalidated: string[] = [];
const storeLayer = ResourceStore.layer.pipe(
  Layer.provide(
    Layer.succeed(ResourceRecallInvalidation, {
      expire: (_home, _inactive, uris) =>
        Effect.sync(() => {
          invalidated.push(...uris);
        }),
    }),
  ),
  Layer.provide(StandaloneBrokerLayer),
);
const testLayer = Layer.merge(StandaloneBrokerLayer, storeLayer);
const live = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(testLayer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context))))).pipe(
    TestClock.withLive,
  );
const uri = 'threadnote://user/tester/memories/shared/default/durable/projects/example/lease.md';
const neighbor = 'threadnote://user/tester/memories/shared/default/durable/projects/example/neighbor.md';
const relativePath = 'durable/projects/example/lease.md';
const citation = createMemoryCodeCitation({
  version: 1,
  extractorSet: 'test',
  fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
  path: 'src/example.ts',
  repositoryId: 'b'.repeat(64),
  repositoryIdentityKind: 'remote',
  sourceCommit: 'c'.repeat(40),
  sourceDirty: false,
  sourceSnapshotId: 'cgsn_' + 'd'.repeat(40),
  target: {kind: 'file'},
});
const document = (body: string) =>
  [
    'MEMORY',
    'schema_version: 4',
    'kind: durable',
    'status: active',
    'visibility: shared',
    'project: example',
    'topic: lease',
    'memory_id: tn_lease',
    'created_at: 2026-01-01T00:00:00.000Z',
    'relation: depends_on threadnote://memory/tn_neighbor',
    `code_citation: ${JSON.stringify(citation)}`,
    '',
    body,
  ].join('\n');
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-reconcile-'}));
  const worktree = path.join(home, 'repo');
  const file = path.join(worktree, relativePath);
  const teamsFile = path.join(home, 'share', 'teams.json');
  const config = {account: 'local', user: 'tester', agentId: 'test', agentContextHome: home};
  const location = {account: 'local', user: 'tester', home};
  const store = yield* ResourceStore;
  const git = (args: readonly string[]) => runCommand('git', args, {cwd: worktree}).pipe(Effect.map(r => r.stdout));
  yield* fs.makeDirectory(path.dirname(file), {recursive: true});
  yield* fs.makeDirectory(path.dirname(teamsFile), {recursive: true});
  yield* git(['init']);
  yield* git(['config', 'user.email', 'test@example.invalid']);
  yield* git(['config', 'user.name', 'Test']);
  const teams = {
    version: 1,
    defaultTeam: 'default',
    teams: {
      default: {
        name: 'default',
        addedAt: '2026-01-01T00:00:00Z',
        remote: 'https://example.invalid/team.git',
        worktree,
        gitdir: path.join(worktree, '.git'),
      },
    },
  };
  yield* fs.writeFileString(teamsFile, JSON.stringify(teams));
  const approved = document('Approved full body.\n\nSecond paragraph and `literal` details.');
  const old = document('Old native body.');
  yield* fs.writeFileString(file, approved + '\n');
  yield* git(['add', '--', relativePath]);
  yield* git(['commit', '-m', 'approved']);
  yield* store.write(location, uri, old, {mode: 'create'});
  yield* store.write(location, neighbor, 'Unrelated resource bytes.', {mode: 'create'});
  const nativeFile = path.join(home, 'data/local/user/tester/memories/shared/default', relativePath);
  return {fs, path, home, worktree, file, nativeFile, teamsFile, teams, config, location, store, git, approved, old};
});
const reject = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.result,
    Effect.map(result => {
      expect(Result.isFailure(result)).toBe(true);
    }),
  );

// Independent conservation oracle reads Git's complete status/index and both native resources.
const snapshot = (f: Effect.Success<typeof fixture>) =>
  Effect.gen(function* () {
    return {
      head: yield* f.git(['rev-parse', 'HEAD']),
      index: yield* f.git(['ls-files', '--stage', '-z']),
      indexBytes: new Bun.CryptoHasher('sha256')
        .update(yield* f.fs.readFile(f.path.join(f.worktree, '.git/index')))
        .digest('hex'),
      gitConfig: yield* f.fs.readFileString(f.path.join(f.worktree, '.git/config')),
      status: yield* f.git(['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      source: yield* f.fs.readFileString(f.file),
      target: yield* f.store.read(f.location, uri),
      targetRaw: Array.from(yield* f.fs.readFile(f.nativeFile)),
      neighborRaw: Array.from(yield* f.fs.readFile(f.path.join(f.path.dirname(f.nativeFile), 'neighbor.md'))),
      neighbor: yield* f.store.read(f.location, neighbor),
      teams: yield* f.fs.readFileString(f.teamsFile),
    };
  });

effectIt.effect('previews read-only, imports one full approved memory, rejects replay, and no-ops a fresh plan', () =>
  live(
    Effect.gen(function* () {
      const f = yield* fixture;
      const before = yield* snapshot(f);
      const preview = yield* previewShareReconcile(f.config, uri);
      expect(preview.rawSha256).toBe(new Bun.CryptoHasher('sha256').update(f.approved + '\n').digest('hex'));
      expect(preview.inboundSha256).toBe(new Bun.CryptoHasher('sha256').update(f.approved).digest('hex'));
      expect(yield* snapshot(f)).toEqual(before);
      expect(JSON.stringify(preview)).not.toContain('Approved full body');
      expect(JSON.stringify(preview)).not.toContain('https://example.invalid');
      const invalidationsBefore = invalidated.length;
      expect(yield* applyShareReconcile(f.config, uri, preview, preview.approvalDigest)).toEqual({
        uri,
        status: 'reconciled',
      });
      expect(invalidated.slice(invalidationsBefore)).toContain(uri);
      const after = yield* snapshot(f);
      expect(after).toEqual({
        ...before,
        target: f.approved,
        targetRaw: Array.from(new TextEncoder().encode(f.approved)),
      });
      expect(parseMemoryDocument(uri, after.target)?.metadata).toEqual(parseMemoryDocument(uri, f.approved)?.metadata);
      yield* reject(applyShareReconcile(f.config, uri, preview, preview.approvalDigest));
      const fresh = yield* previewShareReconcile(f.config, uri);
      const invalidationsNow = invalidated.length;
      expect(yield* applyShareReconcile(f.config, uri, fresh, fresh.approvalDigest)).toEqual({
        uri,
        status: 'already-current',
      });
      expect(invalidated.length).toBe(invalidationsNow);
      expect(yield* snapshot(f)).toEqual(after);
    }),
  ),
);

effectIt.effect('requires explicit apply, a saved plan and its exact approval digest', () =>
  live(
    Effect.gen(function* () {
      const f = yield* fixture;
      const before = yield* snapshot(f);
      const preview = yield* captureConsole(runShareReconcile(f.config, uri));
      const plan = JSON.parse(preview.output) as ShareReconcilePlan;
      yield* reject(runShareReconcile(f.config, uri, {apply: true}));
      yield* reject(runShareReconcile(f.config, uri, {plan: 'missing'}));
      yield* reject(applyShareReconcile(f.config, uri, plan, '0'.repeat(64)));
      yield* reject(applyShareReconcile(f.config, neighbor, plan, plan.approvalDigest));
      const planFile = f.path.join(f.home, 'preview.json');
      yield* f.fs.writeFileString(planFile, JSON.stringify({...plan, body: 'untrusted instructions'}));
      yield* reject(
        runShareReconcile(f.config, uri, {apply: true, plan: planFile, approvalDigest: plan.approvalDigest}),
      );
      expect(yield* snapshot(f)).toEqual(before);
      yield* f.fs.writeFileString(planFile, JSON.stringify(plan));
      const applied = yield* captureConsole(
        runShareReconcile(f.config, uri, {apply: true, plan: planFile, approvalDigest: plan.approvalDigest}),
      );
      expect(JSON.parse(applied.output)).toEqual({uri, status: 'reconciled'});
    }),
  ),
);

const drifts = [
  'native-body',
  'native-id',
  'native-created',
  'team',
  'git-config',
  'head',
  'blob',
  'dirty',
  'unrelated-dirty',
  'removed',
  'symlink',
  'missing-native',
] as const;
for (const drift of drifts)
  effectIt.effect(`rejects ${drift} drift without a reconciliation mutation`, () =>
    live(
      Effect.gen(function* () {
        const f = yield* fixture;
        const plan = yield* previewShareReconcile(f.config, uri);
        if (drift === 'native-body') yield* f.fs.writeFileString(f.nativeFile, document('Concurrent edit.'));
        if (drift === 'native-id') yield* f.fs.writeFileString(f.nativeFile, f.old.replace('tn_lease', 'tn_other'));
        if (drift === 'native-created')
          yield* f.fs.writeFileString(f.nativeFile, f.old.replace('2026-01-01T', '2026-01-02T'));
        if (drift === 'team')
          yield* f.fs.writeFileString(f.teamsFile, JSON.stringify({...f.teams, defaultTeam: 'other'}));
        if (drift === 'git-config') yield* f.git(['config', 'test.changed', 'true']);
        if (drift === 'head') yield* f.git(['commit', '--allow-empty', '-m', 'head moved']);
        if (drift === 'blob') {
          yield* f.fs.writeFileString(f.file, document('Changed committed source.'));
          yield* f.git(['add', '--', relativePath]);
          yield* f.git(['commit', '-m', 'new source']);
        }
        if (drift === 'dirty') yield* f.fs.writeFileString(f.file, document('Dirty source.'));
        if (drift === 'unrelated-dirty') yield* f.fs.writeFileString(f.path.join(f.worktree, 'untracked'), 'dirt');
        if (drift === 'removed') yield* f.fs.remove(f.file);
        if (drift === 'symlink') {
          const target = f.path.join(f.home, 'external');
          yield* f.fs.writeFileString(target, f.approved + '\n');
          yield* f.fs.remove(f.file);
          yield* f.fs.symlink(target, f.file);
        }
        if (drift === 'missing-native') yield* f.fs.remove(f.nativeFile);
        const targetBefore = yield* f.fs.readFileString(f.nativeFile).pipe(Effect.option);
        const gitBefore = yield* f.git(['status', '--porcelain=v1', '-z']);
        yield* reject(applyShareReconcile(f.config, uri, plan, plan.approvalDigest));
        expect(yield* f.fs.readFileString(f.nativeFile).pipe(Effect.option)).toEqual(targetBefore);
        expect(yield* f.git(['status', '--porcelain=v1', '-z'])).toBe(gitBefore);
        expect(yield* f.store.read(f.location, neighbor)).toBe('Unrelated resource bytes.');
      }),
    ),
  );

for (const drift of ['native', 'native-id', 'git', 'dirty', 'config'] as const)
  effectIt.effect(`rechecks ${drift} immediately inside writeChecked`, () =>
    live(
      Effect.gen(function* () {
        const f = yield* fixture;
        const plan = yield* previewShareReconcile(f.config, uri);
        const inject = Effect.gen(function* () {
          if (drift === 'native') yield* f.fs.writeFileString(f.nativeFile, document('Edit under account lock.'));
          if (drift === 'native-id') yield* f.fs.writeFileString(f.nativeFile, f.old.replace('tn_lease', 'tn_other'));
          if (drift === 'dirty') yield* f.fs.writeFileString(f.file, document('Dirty at guard.'));
          if (drift === 'git') yield* f.git(['commit', '--allow-empty', '-m', 'head under account lock']);
          if (drift === 'config')
            yield* f.fs.writeFileString(f.teamsFile, JSON.stringify({...f.teams, defaultTeam: 'changed'}));
        }).pipe(Effect.orDie);
        const injectionContext = yield* Effect.context<Effect.Services<typeof inject>>();
        const wrapped = ResourceStore.of({
          ...f.store,
          writeChecked: (location, target, content, options, check) =>
            f.store.writeChecked(
              location,
              target,
              content,
              options,
              inject.pipe(Effect.provide(injectionContext), Effect.andThen(check)),
            ),
        });
        yield* reject(
          applyShareReconcile(f.config, uri, plan, plan.approvalDigest).pipe(
            Effect.provideService(ResourceStore, wrapped),
          ),
        );
        expect(yield* f.store.read(f.location, uri)).toBe(
          drift === 'native'
            ? document('Edit under account lock.')
            : drift === 'native-id'
              ? f.old.replace('tn_lease', 'tn_other')
              : f.old,
        );
        expect(yield* f.store.read(f.location, neighbor)).toBe('Unrelated resource bytes.');
      }),
    ),
  );

const invalidSources = [
  (s: string) => s.replace('created_at: 2026-01-01T00:00:00.000Z', 'created_at: invalid'),
  (s: string) => s.replace('project: example', 'project: other'),
  (s: string) => s.replace('memory_id: tn_lease', 'memory_id: tn_lease\nmemory_id: tn_other'),
  (s: string) => s.replace('status: active', 'status: archived'),
  (s: string) => s.replace('visibility: shared', 'visibility: personal'),
  (s: string) => s.replace('memory_id: tn_lease', 'memory_id: invalid'),
  (s: string) => s.replace('memory_id: tn_lease', 'memory_id: tn_other'),
  (s: string) => s.replace('created_at: 2026-01-01', 'created_at: 2026-01-02'),
  (s: string) => s.replace('created_at: 2026-01-01T00:00:00.000Z\n', ''),
  (s: string) => s.replace('schema_version: 4', 'schema_version: 999'),
  (s: string) => s.replace(`code_citation: ${JSON.stringify(citation)}`, 'code_citation: pending'),
  (s: string) =>
    s.replace(
      'relation: depends_on threadnote://memory/tn_neighbor',
      'relation: depends_on threadnote://user/other/memories/private.md',
    ),
  (s: string) => s.replace('relation: depends_on threadnote://memory/tn_neighbor', 'relation: invalid garbage'),
  (s: string) => s.replace('\n\nApproved', '\nsource_session_id: private-session\n\nApproved'),
];
for (const [index, change] of invalidSources.entries())
  effectIt.effect(`preview and apply reject invalid committed metadata/projection ${index}`, () =>
    live(
      Effect.gen(function* () {
        const f = yield* fixture;
        const plan = yield* previewShareReconcile(f.config, uri);
        yield* f.fs.writeFileString(f.file, change(f.approved));
        yield* f.git(['add', '--', relativePath]);
        yield* f.git(['commit', '-m', 'invalid source']);
        const before = yield* snapshot(f);
        yield* reject(previewShareReconcile(f.config, uri));
        yield* reject(applyShareReconcile(f.config, uri, plan, plan.approvalDigest));
        expect(yield* snapshot(f)).toEqual(before);
      }),
    ),
  );

effectIt.effect('rejects missing committed preimages, native preimages and noncanonical URI selectors', () =>
  live(
    Effect.gen(function* () {
      const f = yield* fixture;
      for (const target of [
        uri + '#anchor',
        uri.replace('/shared/default/', '/'),
        uri.replace('lease.md', '../lease.md'),
        uri.replace('.md', ''),
      ])
        yield* reject(previewShareReconcile(f.config, target));
      yield* f.fs.remove(f.file);
      yield* f.git(['add', '-u']);
      yield* f.git(['commit', '-m', 'remove']);
      yield* reject(previewShareReconcile(f.config, uri));
      expect(yield* f.store.read(f.location, uri)).toBe(f.old);
    }),
  ),
);

effectIt.effect('every required saved field is mandatory and digest-bound', () =>
  live(
    Effect.gen(function* () {
      const f = yield* fixture;
      const plan = yield* previewShareReconcile(f.config, uri);
      const before = yield* snapshot(f);
      for (const key of Object.keys(plan)) {
        const missing: Record<string, unknown> = {...plan};
        delete missing[key];
        yield* reject(applyShareReconcile(f.config, uri, missing, plan.approvalDigest));
        const changed = {
          ...plan,
          [key]: typeof plan[key as keyof ShareReconcilePlan] === 'number' ? 2 : '0'.repeat(64),
        };
        yield* reject(applyShareReconcile(f.config, uri, changed, plan.approvalDigest));
      }
      expect(yield* snapshot(f)).toEqual(before);
    }),
  ),
);

effectIt.effect('rejects an invisible skip-worktree byte edit and invalid UTF-8 committed bytes', () =>
  live(
    Effect.gen(function* () {
      const f = yield* fixture;
      const plan = yield* previewShareReconcile(f.config, uri);
      yield* f.git(['update-index', '--skip-worktree', '--', relativePath]);
      yield* f.fs.writeFileString(f.file, document('Hidden byte drift.'));
      expect(yield* f.git(['status', '--porcelain=v1'])).toBe('');
      yield* reject(previewShareReconcile(f.config, uri));
      yield* reject(applyShareReconcile(f.config, uri, plan, plan.approvalDigest));
      yield* f.git(['update-index', '--no-skip-worktree', '--', relativePath]);
      yield* f.fs.writeFile(f.file, new Uint8Array([0xff, 0xfe, 0x61]));
      yield* f.git(['add', '--', relativePath]);
      yield* f.git(['commit', '-m', 'invalid utf8']);
      yield* reject(previewShareReconcile(f.config, uri));
      expect(yield* f.store.read(f.location, uri)).toBe(f.old);
    }),
  ),
);

effectIt.effect('refuses a committed symlink and missing native preimage without creating a target', () =>
  live(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.remove(f.nativeFile);
      yield* reject(previewShareReconcile(f.config, uri));
      expect(yield* f.fs.exists(f.nativeFile)).toBe(false);
      yield* f.fs.writeFileString(f.nativeFile, f.old);
      yield* f.fs.remove(f.file);
      yield* f.fs.symlink(f.nativeFile, f.file);
      yield* f.git(['add', '--', relativePath]);
      yield* f.git(['commit', '-m', 'symlink']);
      yield* reject(previewShareReconcile(f.config, uri));
      expect(yield* f.store.read(f.location, uri)).toBe(f.old);
    }),
  ),
);

// Useful bounded property: removing or changing ANY required saved field, or adding an
// arbitrary instruction-like field, cannot mutate either store. The oracle snapshots real Git/native bytes.
effectIt.effect.prop(
  'malformed saved data conserves all resources and Git state',
  {
    field: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 12})),
    mode: Schema.Literals(['missing', 'altered', 'extra']),
    text: Schema.String.check(Schema.isMaxLength(32)),
  },
  ({field, mode, text}) =>
    live(
      Effect.gen(function* () {
        const f = yield* fixture;
        const plan = yield* previewShareReconcile(f.config, uri);
        const bad: Record<string, unknown> = {...plan};
        const key = Object.keys(plan)[field];
        if (mode === 'missing') delete bad[key];
        else if (mode === 'altered') bad[key] = `changed:${text}`;
        else bad['instructions:' + text] = text;
        const before = yield* snapshot(f);
        yield* reject(applyShareReconcile(f.config, uri, bad, plan.approvalDigest));
        expect(yield* snapshot(f)).toEqual(before);
      }),
    ),
  {arbitrary: {runs: 12}},
);

// Fast-check exercises the pure data boundary; the exact original preview is the
// independent roundtrip oracle, and all real mutations remain in Effect tests.
effectIt.effect('Fast-check: any JSON key order roundtrips the exact reviewed preview', () =>
  live(
    Effect.gen(function* () {
      const f = yield* fixture;
      const plan = yield* previewShareReconcile(f.config, uri);
      const entries = Object.entries(plan);
      const before = yield* snapshot(f);
      fc.assert(
        fc.property(
          fc.shuffledSubarray(entries, {minLength: entries.length, maxLength: entries.length}),
          fc.integer({min: 0, max: 8}),
          (ordered, indent) => {
            const encoded = JSON.stringify(Object.fromEntries(ordered), undefined, indent);
            expect(parseShareReconcilePlan(JSON.parse(encoded), uri, plan.approvalDigest)).toEqual(plan);
          },
        ),
        {numRuns: 24},
      );
      expect(yield* snapshot(f)).toEqual(before);
    }),
  ),
);

// F001: the oracle reads the private fixture's bytes directly, independently of
// ResourceStore text decoding, so leading UTF-8 BOM changes cannot disappear.
for (const timing of ['before-apply', 'inside-guard'] as const) {
  for (const change of ['add', 'remove'] as const) {
    effectIt.effect(`F001 rejects native BOM ${change} ${timing} and conserves raw bytes`, () =>
      live(
        Effect.gen(function* () {
          const f = yield* fixture;
          const initial = new TextEncoder().encode((change === 'remove' ? '\uFEFF' : '') + f.old);
          const changed = new TextEncoder().encode((change === 'add' ? '\uFEFF' : '') + f.old);
          yield* f.fs.writeFile(f.nativeFile, initial);
          const plan = yield* previewShareReconcile(f.config, uri);
          expect(plan.nativeSha256).toBe(new Bun.CryptoHasher('sha256').update(initial).digest('hex'));
          const before = yield* snapshot(f);
          const invalidationsBefore = invalidated.length;
          const wrapped = ResourceStore.of({
            ...f.store,
            writeChecked: (location, target, content, options, check) =>
              f.store.writeChecked(
                location,
                target,
                content,
                options,
                f.fs.writeFile(f.nativeFile, changed).pipe(Effect.orDie, Effect.andThen(check)),
              ),
          });
          if (timing === 'before-apply') yield* f.fs.writeFile(f.nativeFile, changed);
          yield* reject(
            applyShareReconcile(f.config, uri, plan, plan.approvalDigest).pipe(
              Effect.provideService(ResourceStore, timing === 'inside-guard' ? wrapped : f.store),
            ),
          );
          expect(Array.from(yield* f.fs.readFile(f.nativeFile))).toEqual(Array.from(changed));
          expect(yield* snapshot(f)).toEqual({...before, targetRaw: Array.from(changed)});
          expect(invalidated.length).toBe(invalidationsBefore);
        }),
      ),
    );
  }
}

effectIt.effect('F001 refuses malformed native UTF-8 without changing any bytes', () =>
  live(
    Effect.gen(function* () {
      const f = yield* fixture;
      const plan = yield* previewShareReconcile(f.config, uri);
      const valid = new TextEncoder().encode(f.old);
      const malformed = new Uint8Array(valid.length + 1);
      malformed.set(valid);
      malformed[valid.length] = 0xff;
      yield* f.fs.writeFile(f.nativeFile, malformed);
      const before = yield* snapshot(f);
      yield* reject(previewShareReconcile(f.config, uri));
      yield* reject(applyShareReconcile(f.config, uri, plan, plan.approvalDigest));
      expect(yield* snapshot(f)).toEqual(before);
    }),
  ),
);

effectIt.effect('F001 accepts valid literal U+FFFD and preserves the exact native hash', () =>
  live(
    Effect.gen(function* () {
      const f = yield* fixture;
      const valid = new TextEncoder().encode(document('Valid literal replacement character: \uFFFD'));
      yield* f.fs.writeFile(f.nativeFile, valid);
      const plan = yield* previewShareReconcile(f.config, uri);
      expect(plan.nativeSha256).toBe(new Bun.CryptoHasher('sha256').update(valid).digest('hex'));
      expect(yield* applyShareReconcile(f.config, uri, plan, plan.approvalDigest)).toEqual({uri, status: 'reconciled'});
      expect(Array.from(yield* f.fs.readFile(f.nativeFile))).toEqual(Array.from(new TextEncoder().encode(f.approved)));
    }),
  ),
);

effectIt.effect('F001 does not report BOM-only native content as already-current', () =>
  live(
    Effect.gen(function* () {
      const f = yield* fixture;
      const initial = new TextEncoder().encode('\uFEFF' + f.approved);
      yield* f.fs.writeFile(f.nativeFile, initial);
      const plan = yield* previewShareReconcile(f.config, uri);
      expect(plan.nativeSha256).toBe(new Bun.CryptoHasher('sha256').update(initial).digest('hex'));
      expect(yield* applyShareReconcile(f.config, uri, plan, plan.approvalDigest)).toEqual({uri, status: 'reconciled'});
      expect(Array.from(yield* f.fs.readFile(f.nativeFile))).toEqual(Array.from(new TextEncoder().encode(f.approved)));
    }),
  ),
);

for (const change of ['grow', 'shrink'] as const)
  effectIt.effect(`F001 refuses native size ${change} between stat and bounded read`, () =>
    live(
      Effect.gen(function* () {
        const f = yield* fixture;
        const changed = new TextEncoder().encode(document(change === 'grow' ? 'Longer changed native body.' : 'X'));
        const wrapped = ResourceStore.of({
          ...f.store,
          readBounded: (location, target, maximumBytes) =>
            f.fs
              .writeFile(f.nativeFile, changed)
              .pipe(Effect.orDie, Effect.andThen(f.store.readBounded(location, target, maximumBytes))),
        });
        yield* reject(previewShareReconcile(f.config, uri).pipe(Effect.provideService(ResourceStore, wrapped)));
        expect(Array.from(yield* f.fs.readFile(f.nativeFile))).toEqual(Array.from(changed));
        expect(yield* f.store.read(f.location, neighbor)).toBe('Unrelated resource bytes.');
      }),
    ),
  );

effectIt.effect('F001 exact readback catches a BOM added after the checked replacement', () =>
  live(
    Effect.gen(function* () {
      const f = yield* fixture;
      const plan = yield* previewShareReconcile(f.config, uri);
      const changed = new TextEncoder().encode('\uFEFF' + f.approved);
      const wrapped = ResourceStore.of({
        ...f.store,
        writeChecked: (location, target, content, options, check) =>
          f.store
            .writeChecked(location, target, content, options, check)
            .pipe(Effect.tap(() => f.fs.writeFile(f.nativeFile, changed).pipe(Effect.orDie))),
      });
      yield* reject(
        applyShareReconcile(f.config, uri, plan, plan.approvalDigest).pipe(
          Effect.provideService(ResourceStore, wrapped),
        ),
      );
      expect(Array.from(yield* f.fs.readFile(f.nativeFile))).toEqual(Array.from(changed));
      expect(yield* f.store.read(f.location, neighbor)).toBe('Unrelated resource bytes.');
    }),
  ),
);

effectIt.effect('reconciliation command factory preserves parsing and public help', () =>
  live(
    Effect.gen(function* () {
      const calls: unknown[] = [];
      const command = makeShareReconcileCommand((target, options) =>
        Effect.sync(() => {
          calls.push({target, options});
        }),
      );
      const run = Command.runWith(command, {version: 'test'});
      yield* run([uri]);
      yield* run([uri, '--apply', '--plan', 'reviewed-preview.json', '--approval-digest', 'a'.repeat(64)]);
      expect(calls).toEqual([
        {target: uri, options: {apply: false, plan: undefined, approvalDigest: undefined}},
        {target: uri, options: {apply: true, plan: 'reviewed-preview.json', approvalDigest: 'a'.repeat(64)}},
      ]);
      const help = yield* captureConsole(run(['--help']));
      expect(help.output).toContain('Preview or apply one guarded committed shared memory import');
      for (const flag of ['canonical-shared-uri', '--apply', '--plan', '--approval-digest'])
        expect(help.output).toContain(flag);
      expect(calls).toHaveLength(2);
    }),
  ),
);
