import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Schema} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {
  applyDevSkills,
  listDevSkills,
  previewDevSkills,
  removeOwnedDevSkills,
  statusDevSkills,
  withDevSkillsMutationLease,
  type DevSkillsMutationLease,
} from '../../src/dev_skills/index.js';
import {loadDevSkillsBundleAt} from '../../src/dev_skills/manifest.js';
import {generationRoot, renderEntrypoints} from '../../src/dev_skills/inspection.js';
import {homeIndexPath, receiptPath} from '../../src/dev_skills/registry.js';
import {devSkillsTestLayer, fixture, snapshot} from './service-fixture.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const selector = {agent: 'codex'};
const testLayer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(TestClock.withLive, provideTestLayer(devSkillsTestLayer));
describe('development skills lifecycle', () => {
  effectIt.effect('pure previews and unsupported attempts leave absent homes and all bytes untouched', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const before = yield* snapshot(f.root);
      const first = yield* f.run(previewDevSkills(f.config, 'install', selector));
      expect(first).toMatchObject({canApply: true, installationState: 'absent'});
      expect((yield* f.run(previewDevSkills(f.config, 'install', selector))).previewDigest).toBe(first.previewDigest);
      yield* f.run(listDevSkills(f.config));
      yield* f.run(statusDevSkills(f.config, selector));
      yield* f.run(removeOwnedDevSkills(f.config, {dryRun: true}));
      expect(yield* f.run(applyDevSkills(f.config, 'install', {agent: 'continue'})).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
      });
      expect(yield* snapshot(f.root)).toEqual(before);
    }).pipe(testLayer),
  );
  effectIt.effect('installs complete copied generations, renders only entrypoints and repeats without changes', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const result = yield* f.run(applyDevSkills(f.config, 'install', selector));
      expect(result.applied).toBe(true);
      const bundle = yield* loadDevSkillsBundleAt(f.source, '5.3.0-beta.4');
      const root = generationRoot(f.path, result.target.skillRoot, bundle.manifest.digest);
      for (const [file, content] of Object.entries(bundle.files))
        expect(Buffer.from(yield* f.fs.readFile(f.path.join(root, file))).toString('base64')).toBe(content);
      expect(yield* f.fs.readFileString(f.path.join(result.target.skillRoot, 'dev-plan/SKILL.md'))).toContain(root);
      const before = yield* snapshot(f.root);
      expect((yield* f.run(applyDevSkills(f.config, 'install', selector))).applied).toBe(false);
      expect(yield* snapshot(f.root)).toEqual(before);
    }).pipe(testLayer),
  );
  effectIt.effect(
    'shares one generation across homes, pins roots, updates explicitly and tombstones final removal',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const first = yield* f.run(applyDevSkills(f.config, 'install', selector));
        const secondConfig = {...f.config, agentContextHome: f.path.join(f.root, 'second')};
        yield* f.run(applyDevSkills(secondConfig, 'install', {agent: 'amp'}));
        const secondBefore = yield* f.fs.readFileString(homeIndexPath(f.path, secondConfig.agentContextHome));
        yield* f.fs.writeFileString(
          f.path.join(f.source, 'config/agent-skills/dev-spec/scripts/helper.py'),
          'print("next release")\n',
        );
        expect(yield* f.run(applyDevSkills(f.config, 'install', selector)).pipe(Effect.result)).toMatchObject({
          _tag: 'Failure',
        });
        const updated = yield* f.run(applyDevSkills(f.config, 'update', selector));
        expect(updated.consumers).toHaveLength(2);
        expect(yield* f.fs.readFileString(homeIndexPath(f.path, secondConfig.agentContextHome))).toBe(secondBefore);
        expect((yield* f.run(statusDevSkills(secondConfig, {agent: 'amp'}))).targets[0].installedDigest).toBe(
          updated.bundleDigest,
        );
        expect(yield* f.fs.exists(generationRoot(f.path, first.target.skillRoot, first.bundleDigest))).toBe(true);
        f.environment.THREADNOTE_INSTALL_ROOT = f.path.join(f.root, 'changed-runtime');
        yield* f.run(applyDevSkills(f.config, 'remove', selector));
        expect(yield* f.fs.exists(f.path.join(first.target.skillRoot, 'dev-plan/SKILL.md'))).toBe(true);
        yield* f.run(applyDevSkills(secondConfig, 'remove', {agent: 'amp'}));
        expect(yield* f.fs.exists(f.path.join(first.target.skillRoot, 'dev-plan/SKILL.md'))).toBe(false);
        expect(yield* f.fs.exists(generationRoot(f.path, first.target.skillRoot, first.bundleDigest))).toBe(true);
        expect(yield* f.fs.exists(f.path.join(f.root, 'changed-runtime'))).toBe(false);
        expect(yield* f.fs.readFileString(f.path.join(f.runtime, 'dev-skills-enrollment.json'))).toContain('"removed"');
      }).pipe(testLayer),
  );
  effectIt.effect('rejects stale previews and refuses to adopt existing identical entrypoints', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const preview = yield* f.run(previewDevSkills(f.config, 'install', selector));
      const root = preview.target.skillRoot;
      yield* f.fs.makeDirectory(f.path.join(root, 'dev-spec'), {recursive: true});
      const bundle = yield* loadDevSkillsBundleAt(f.source, '5.3.0-beta.4');
      yield* f.fs.writeFileString(
        f.path.join(root, 'dev-spec/SKILL.md'),
        renderEntrypoints(f.path, preview.target, bundle)['dev-spec/SKILL.md'],
      );
      const before = yield* snapshot(f.root);
      expect(
        yield* f
          .run(applyDevSkills(f.config, 'install', selector, {expectedDigest: preview.previewDigest}))
          .pipe(Effect.result),
      ).toMatchObject({_tag: 'Failure', failure: {code: 'stale-preview'}});
      expect(yield* snapshot(f.root)).toEqual(before);
      expect((yield* f.run(previewDevSkills(f.config, 'install', selector))).issues).toContainEqual(
        expect.objectContaining({code: 'unmanaged'}),
      );
    }).pipe(testLayer),
  );
  effectIt.effect('preserves edited entrypoints and unknown resource files during removal', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const installed = yield* f.run(applyDevSkills(f.config, 'install', selector));
      const file = f.path.join(installed.target.skillRoot, 'dev-plan/SKILL.md');
      const extra = f.path.join(installed.target.skillRoot, 'dev-spec/keep.txt');
      yield* f.fs.writeFileString(file, 'user edit');
      yield* f.fs.writeFileString(extra, 'unowned bytes');
      expect(yield* f.run(applyDevSkills(f.config, 'update', selector)).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
      });
      const removed = yield* f.run(removeOwnedDevSkills(f.config, {dryRun: false}));
      expect(removed[0]).toMatchObject({retainedPaths: expect.arrayContaining([file, extra])});
      expect(yield* f.fs.readFileString(file)).toBe('user edit');
      expect(yield* f.fs.readFileString(extra)).toBe('unowned bytes');
    }).pipe(testLayer),
  );
  for (const point of ['generation', 'entrypoint', 'receipt', 'home-index', 'runtime-index'])
    effectIt.effect(`recovers exact persisted intent after ${point} response loss`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        let injected = false;
        const brokenFs = FileSystem.FileSystem.of({
          ...f.fs,
          rename: (from, to) => {
            const portable = to.replaceAll('\\', '/');
            const matches =
              point === 'generation'
                ? /generations\/[a-f0-9]{64}$/u.test(portable)
                : point === 'entrypoint'
                  ? to.replaceAll('\\', '/').endsWith('/dev-spec/SKILL.md')
                  : point === 'receipt'
                    ? to.replaceAll('\\', '/').endsWith('/receipt.json')
                    : point === 'home-index'
                      ? to === homeIndexPath(f.path, f.home)
                      : to.replaceAll('\\', '/').endsWith('/dev-skills-enrollment.json');
            if (!injected && matches) {
              injected = true;
              return f.fs.rename(from, to).pipe(Effect.andThen(f.fs.rename(f.path.join(f.root, 'missing'), to)));
            }
            return f.fs.rename(from, to);
          },
        });
        expect(
          yield* f
            .run(applyDevSkills(f.config, 'install', selector))
            .pipe(Effect.provideService(FileSystem.FileSystem, brokenFs), Effect.result),
        ).toMatchObject({_tag: 'Failure'});
        expect(injected).toBe(true);
        expect((yield* f.run(statusDevSkills(f.config, selector))).targets[0].installationState).toBe(
          'recovery-needed',
        );
        const recovered = yield* f.run(applyDevSkills(f.config, 'install', selector));
        expect(recovered.recovered).toBe(true);
        expect((yield* f.run(statusDevSkills(f.config, selector))).targets[0].installationState).toBe('current');
        expect((yield* f.run(applyDevSkills(f.config, 'install', selector))).applied).toBe(false);
      }).pipe(testLayer),
    );
  effectIt.effect('uses only the captured source after release pruning', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      let pruned = false;
      const pruningFs = FileSystem.FileSystem.of({
        ...f.fs,
        rename: (from, to) => {
          if (!pruned && to.replaceAll('\\', '/').endsWith('/journal.json')) {
            pruned = true;
            return f.fs.rename(from, to).pipe(Effect.andThen(f.fs.remove(f.source, {recursive: true})));
          }
          return f.fs.rename(from, to);
        },
      });
      expect(
        (yield* f
          .run(applyDevSkills(f.config, 'install', selector))
          .pipe(Effect.provideService(FileSystem.FileSystem, pruningFs))).applied,
      ).toBe(true);
      expect(pruned).toBe(true);
      const receipt = JSON.parse(
        yield* f.fs.readFileString(receiptPath(f.path, f.path.join(f.host, '.agents/skills'))),
      );
      expect(Object.keys(receipt.consumers)).toHaveLength(1);
    }).pipe(testLayer),
  );
  effectIt.effect('validates opaque active leases and nests full uninstall without taking the home lock again', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.run(applyDevSkills(f.config, 'install', selector));
      let expired: DevSkillsMutationLease | undefined;
      yield* f.run(
        withDevSkillsMutationLease(f.config, lease => {
          expired = lease;
          return removeOwnedDevSkills(f.config, {dryRun: false, lease});
        }),
      );
      expect(
        yield* f.run(applyDevSkills(f.config, 'install', selector, {lease: expired})).pipe(Effect.result),
      ).toMatchObject({_tag: 'Failure', failure: {code: 'invalid-lease'}});
    }).pipe(testLayer),
  );
  effectIt.effect.prop(
    'preserves arbitrary unrelated bytes and repeated installation',
    {bytes: Schema.Array(Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 255}))).check(Schema.isMaxLength(80))},
    ({bytes}) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const unrelated = f.path.join(f.host, '.agents/skills/other/keep.bin');
        yield* f.fs.makeDirectory(f.path.dirname(unrelated), {recursive: true});
        yield* f.fs.writeFile(unrelated, Uint8Array.from(bytes));
        yield* f.run(applyDevSkills(f.config, 'install', selector));
        expect((yield* f.run(applyDevSkills(f.config, 'install', selector))).applied).toBe(false);
        yield* f.run(applyDevSkills(f.config, 'remove', selector));
        expect(Array.from(yield* f.fs.readFile(unrelated))).toEqual(bytes);
      }).pipe(testLayer),
    {arbitrary: {runs: 8}},
  );
  effectIt.effect('renders flat targets and keeps changed OMP environment roots pinned', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const flat = yield* f.run(applyDevSkills(f.config, 'install', {agent: 'antigravity-cli'}));
      expect(yield* f.fs.exists(f.path.join(flat.target.skillRoot, 'dev-plan.md'))).toBe(true);
      expect(yield* f.fs.exists(f.path.join(flat.target.skillRoot, 'dev-plan/SKILL.md'))).toBe(false);
      f.environment.PI_CODING_AGENT_DIR = f.path.join(f.host, 'first-omp');
      const omp = yield* f.run(applyDevSkills(f.config, 'install', {agent: 'omp'}));
      f.environment.PI_CODING_AGENT_DIR = f.path.join(f.host, 'second-omp');
      expect((yield* f.run(statusDevSkills(f.config, {agent: 'omp'}))).targets[0].target.skillRoot).toBe(
        omp.target.skillRoot,
      );
      yield* f.run(applyDevSkills(f.config, 'update', {agent: 'omp'}));
      yield* f.run(applyDevSkills(f.config, 'remove', {agent: 'omp'}));
      expect(yield* f.fs.exists(f.path.join(f.host, 'second-omp'))).toBe(false);
    }).pipe(testLayer),
  );
  effectIt.effect('reports both alternate native and bounded legacy pack duplicate names without adopting them', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const direct = f.path.join(f.host, '.codex/skills/dev-plan/SKILL.md');
      const nested = f.path.join(f.host, '.agents/skills/threadnote-packs/default/workflows/dev-spec/SKILL.md');
      for (const [file, id] of [
        [direct, 'dev-plan'],
        [nested, 'dev-spec'],
      ]) {
        yield* f.fs.makeDirectory(f.path.dirname(file), {recursive: true});
        yield* f.fs.writeFileString(file, `---\nname: ${id}\n---\nmanual`);
      }
      const before = yield* snapshot(f.root);
      const preview = yield* f.run(previewDevSkills(f.config, 'install', selector));
      expect(preview.canApply).toBe(false);
      expect(
        preview.issues
          .filter(issue => issue.code === 'duplicate')
          .map(issue => issue.path)
          .sort(),
      ).toEqual([direct, nested].sort());
      expect(yield* f.run(applyDevSkills(f.config, 'install', selector)).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
      });
      expect(yield* snapshot(f.root)).toEqual(before);
    }).pipe(testLayer),
  );
  effectIt.effect('preserves modified immutable resources and never rehashes them into ownership', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const installed = yield* f.run(applyDevSkills(f.config, 'install', selector));
      const extra = f.path.join(
        generationRoot(f.path, installed.target.skillRoot, installed.bundleDigest),
        'dev-spec/extra.txt',
      );
      yield* f.fs.writeFileString(extra, 'unknown immutable-generation bytes');
      const before = yield* snapshot(f.root);
      expect(yield* f.run(applyDevSkills(f.config, 'update', selector)).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
      });
      expect(yield* snapshot(f.root)).toEqual(before);
      yield* f.run(applyDevSkills(f.config, 'remove', selector));
      expect(yield* f.fs.readFileString(extra)).toBe('unknown immutable-generation bytes');
    }).pipe(testLayer),
  );
  effectIt.effect('preserves conflicts and blocks another home from completing an interrupted intent', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      let failed = false;
      const failing = FileSystem.FileSystem.of({
        ...f.fs,
        rename: (from, to) => {
          if (!failed && f.path.basename(to) === 'receipt.json') {
            failed = true;
            return f.fs.rename(f.path.join(f.root, 'missing'), to);
          }
          return f.fs.rename(from, to);
        },
      });
      expect(
        yield* f
          .run(applyDevSkills(f.config, 'install', selector))
          .pipe(Effect.provideService(FileSystem.FileSystem, failing), Effect.result),
      ).toMatchObject({_tag: 'Failure'});
      const other = {...f.config, agentContextHome: f.path.join(f.root, 'another-home')};
      const before = yield* snapshot(f.root);
      expect(yield* f.run(applyDevSkills(other, 'install', selector)).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
        failure: {code: 'recovery-needed'},
      });
      expect(yield* snapshot(f.root)).toEqual(before);
      const edited = f.path.join(f.host, '.agents/skills/dev-spec/SKILL.md');
      yield* f.fs.writeFileString(edited, 'concurrent manual edit');
      const conflict = yield* snapshot(f.root);
      expect(yield* f.run(applyDevSkills(f.config, 'install', selector)).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
        failure: {code: 'recovery-conflict'},
      });
      expect(yield* snapshot(f.root)).toEqual(conflict);
    }).pipe(testLayer),
  );
  effectIt.effect.skipIf(process.platform === 'win32')(
    'rejects symlink ancestors before creating any owned state',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const outside = f.path.join(f.root, 'outside');
        yield* f.fs.makeDirectory(outside);
        yield* f.fs.symlink(outside, f.path.join(f.host, '.agents'));
        expect(yield* f.run(applyDevSkills(f.config, 'install', selector)).pipe(Effect.result)).toMatchObject({
          _tag: 'Failure',
          failure: {code: 'unsafe-path'},
        });
        expect(yield* f.fs.readDirectory(outside)).toEqual([]);
        expect(yield* f.fs.exists(f.home)).toBe(false);
        expect(yield* f.fs.exists(f.runtime)).toBe(false);
      }).pipe(testLayer),
  );
  effectIt.effect(
    'serializes different runtime coordinators at a shared physical root and honors removed enrollment',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const other = {...f.config, agentContextHome: f.path.join(f.root, 'other-home')};
        const otherSystem = SystemInfo.of({
          ...f.system,
          environment: () => ({...f.environment, THREADNOTE_INSTALL_ROOT: f.path.join(f.root, 'other-runtime')}),
        });
        yield* Effect.all(
          [
            f.run(applyDevSkills(f.config, 'install', selector)),
            f.run(
              applyDevSkills(other, 'install', {agent: 'amp'}).pipe(Effect.provideService(SystemInfo, otherSystem)),
            ),
          ],
          {concurrency: 2},
        );
        const status = yield* f.run(statusDevSkills(f.config, selector));
        expect(status.targets[0].consumers).toHaveLength(2);
        const otherBefore = yield* f.fs.readFileString(homeIndexPath(f.path, other.agentContextHome));
        yield* f.run(applyDevSkills(f.config, 'remove', selector));
        const before = yield* snapshot(f.root);
        expect(yield* f.run(applyDevSkills(f.config, 'update', selector)).pipe(Effect.result)).toMatchObject({
          _tag: 'Failure',
        });
        expect(yield* snapshot(f.root)).toEqual(before);
        expect(yield* f.fs.readFileString(homeIndexPath(f.path, other.agentContextHome))).toBe(otherBefore);
        expect(yield* f.fs.exists(f.path.join(status.targets[0].target.skillRoot, 'dev-spec/SKILL.md'))).toBe(true);
      }).pipe(testLayer),
  );
  effectIt.effect('rejects a journal that tries to overwrite another consumer enrollment', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      let failed = false;
      const failing = FileSystem.FileSystem.of({
        ...f.fs,
        rename: (from, to) => {
          if (!failed && to.replaceAll('\\', '/').endsWith('/dev-spec/SKILL.md')) {
            failed = true;
            return f.fs.rename(f.path.join(f.root, 'missing'), to);
          }
          return f.fs.rename(from, to);
        },
      });
      expect(
        yield* f
          .run(applyDevSkills(f.config, 'install', selector))
          .pipe(Effect.provideService(FileSystem.FileSystem, failing), Effect.result),
      ).toMatchObject({_tag: 'Failure'});
      const journalFile = f.path.join(f.host, '.agents/skills/.threadnote-dev-skills/journal.json');
      const journal = JSON.parse(yield* f.fs.readFileString(journalFile));
      const change = journal.changes.find((item: {path: string}) => item.path === homeIndexPath(f.path, f.home));
      const index = JSON.parse(change.after);
      index.targets = {};
      change.after = JSON.stringify(index);
      yield* f.fs.writeFileString(journalFile, JSON.stringify(journal));
      const before = yield* snapshot(f.root);
      expect(yield* f.run(applyDevSkills(f.config, 'install', selector)).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
        failure: {code: 'invalid-state'},
      });
      expect(yield* snapshot(f.root)).toEqual(before);
    }).pipe(testLayer),
  );
  effectIt.effect('expires a leaked lease even when its callback throws synchronously', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      let expired: DevSkillsMutationLease | undefined;
      yield* f
        .run(
          withDevSkillsMutationLease(f.config, (lease): Effect.Effect<never> => {
            expired = lease;
            throw new Error('Synchronous callback failure');
          }),
        )
        .pipe(Effect.exit);
      const before = yield* snapshot(f.root);
      expect(
        yield* f.run(applyDevSkills(f.config, 'install', selector, {lease: expired})).pipe(Effect.result),
      ).toMatchObject({_tag: 'Failure', failure: {code: 'invalid-lease'}});
      expect(yield* snapshot(f.root)).toEqual(before);
    }).pipe(testLayer),
  );
  effectIt.effect('keeps multiple projects and local/project consumers independently enrolled', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const firstProject = f.path.join(f.root, 'repo-one');
      const secondProject = f.path.join(f.root, 'repo-two');
      yield* f.fs.makeDirectory(firstProject);
      yield* f.fs.makeDirectory(secondProject);
      const first = yield* f.run(applyDevSkills(f.config, 'install', {agent: 'roo', cwd: firstProject}));
      const second = yield* f.run(applyDevSkills(f.config, 'install', {agent: 'roo', cwd: secondProject}));
      expect(first.consumerId).not.toBe(second.consumerId);
      expect(first.target.skillRoot).not.toBe(second.target.skillRoot);
      const project = yield* f.run(
        applyDevSkills(f.config, 'install', {agent: 'devin-local', scope: 'project', cwd: firstProject}),
      );
      const local = yield* f.run(
        applyDevSkills(f.config, 'install', {agent: 'devin-local', scope: 'local', cwd: firstProject}),
      );
      expect(project.consumerId).not.toBe(local.consumerId);
      expect(project.target.skillRoot).toBe(local.target.skillRoot);
      yield* f.run(applyDevSkills(f.config, 'remove', {agent: 'devin-local', scope: 'project', cwd: firstProject}));
      expect(yield* f.fs.exists(f.path.join(local.target.skillRoot, 'dev-spec/SKILL.md'))).toBe(true);
      expect((yield* f.run(statusDevSkills(f.config))).targets).toHaveLength(4);
      yield* f.run(removeOwnedDevSkills(f.config, {dryRun: false}));
      expect(yield* f.fs.exists(f.path.join(first.target.skillRoot, 'dev-spec/SKILL.md'))).toBe(false);
      expect(yield* f.fs.exists(f.path.join(second.target.skillRoot, 'dev-spec/SKILL.md'))).toBe(false);
    }).pipe(testLayer),
  );
  effectIt.effect.skipIf(process.platform === 'win32')(
    'reports an unreadable core prerequisite without failing a valid bundle installation',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const core = f.path.join(f.host, '.agents/skills/threadnote-context');
        yield* f.fs.makeDirectory(core, {recursive: true});
        yield* f.fs.symlink(f.path.join(f.root, 'missing-core.md'), f.path.join(core, 'SKILL.md'));
        const installed = yield* f.run(applyDevSkills(f.config, 'install', selector));
        expect(installed.applied).toBe(true);
        expect(installed.readiness?.planning.reasons).toContainEqual(
          expect.objectContaining({code: 'core-integration-unreadable'}),
        );
      }).pipe(testLayer),
  );
});
