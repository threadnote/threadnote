import {it as effectIt} from '@effect/vitest';
import {Array as Arr, Effect, FileSystem, PlatformError, Record as Rec, Schema, String} from 'effect';
import {Command} from 'effect/cli';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {
  applyDevSkills,
  ensureDevSkills,
  previewDevSkills,
  statusDevSkills,
  prepareDevSkillsRefresh,
  previewDevSkillsRefresh,
  runDevSkillsRefresh,
} from '../../src/dev_skills/index.js';
import {makeDevSkillsCommand} from '../../src/effect/dev_skills_cli.js';
import {handleManagerDevSkillsRequest} from '../../src/manager/dev_skills.js';
import {enablementJournalPath} from '../../src/dev_skills/enablement.js';
import {
  consumerId,
  homeIndexPath,
  physicalDirectory,
  receiptPath,
  runtimeIndexPath,
} from '../../src/dev_skills/registry.js';
import {json} from '../../src/dev_skills/files.js';
import {loadDevSkillsBundleAt} from '../../src/dev_skills/manifest.js';
import {refreshStatePath} from '../../src/dev_skills/refresh_state.js';
import {devSkillsReleaseFixture, devSkillsTestLayer, fixture, snapshot} from './service-fixture.js';
import {historicalBundle, retainedRefreshState} from './historical-refresh-fixture.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const selector = {agent: 'codex'};
const manual = {reinstallMissingStore: true};
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(TestClock.withLive, provideTestLayer(devSkillsTestLayer));
const missing = Effect.fn(function* (flat = false) {
  const f = yield* fixture();
  const selected = {agent: flat ? 'antigravity-cli' : 'codex'};
  const installed = yield* f.run(applyDevSkills(f.config, 'install', selected));
  const store = physicalDirectory(f.path, installed.target.skillRoot);
  yield* f.fs.remove(store, {recursive: true});
  yield* f.fs.makeDirectory(store);
  for (const id of ['dev-spec', 'dev-plan', 'dev-cycle', 'watch-pr'])
    yield* f.fs.remove(f.path.join(installed.target.skillRoot, flat ? `${id}.md` : id), {recursive: true});
  return {...f, selected, installed, store};
});
const enablement = Effect.fn(function* (f: Effect.Success<ReturnType<typeof missing>>) {
  const other = yield* f.run(applyDevSkills(f.config, 'install', {agent: 'claude-code'}));
  const consumer = {home: f.home, installationRoot: f.runtime, target: other.target};
  const homeFile = homeIndexPath(f.path, f.home),
    runtimeFile = runtimeIndexPath(f.path, f.runtime);
  const homeBefore = yield* f.fs.readFileString(homeFile),
    runtimeBefore = yield* f.fs.readFileString(runtimeFile);
  const home = JSON.parse(homeBefore),
    runtime = JSON.parse(runtimeBefore);
  home.targets[other.consumerId].enabled = false;
  runtime.enrollments[other.consumerId].enabled = false;
  return json({
    schemaVersion: 1,
    consumer,
    homeBefore,
    homeAfter: json(home),
    runtimeBefore,
    runtimeAfter: json(runtime),
  });
});

describe('explicit manual missing-store reinstall', () => {
  for (const flat of [false, true])
    effectIt.effect(`creates only new current ownership for ${flat ? 'flat' : 'directory'} discovery`, () =>
      Effect.gen(function* () {
        const f = yield* missing(flat);
        const old = retainedRefreshState(
          f.path,
          historicalBundle(yield* loadDevSkillsBundleAt(f.source, '5.3.0-beta.7')),
          [{home: f.home, installationRoot: f.runtime, target: f.installed.target}],
        );
        const oldBytes = json(old);
        yield* f.fs.writeFileString(refreshStatePath(f.path, f.runtime), oldBytes);
        const personal = f.path.join(f.installed.target.skillRoot, 'personal-guidance.md');
        yield* f.fs.writeFileString(personal, 'personal guidance');
        const before = yield* snapshot(f.root);
        expect((yield* f.run(statusDevSkills(f.config, f.selected))).targets[0]).toMatchObject({
          installationState: 'incomplete',
          enabled: true,
        });
        expect((yield* f.run(previewDevSkills(f.config, 'install', f.selected))).canApply).toBe(false);
        const preview = yield* f.run(previewDevSkills(f.config, 'install', f.selected, manual));
        expect(preview.canApply).toBe(true);
        expect(
          Arr.filter(preview.changes, change => String.endsWith(flat ? '.md' : 'SKILL.md')(change.path)),
        ).toHaveLength(4);
        expect(
          Arr.every(
            preview.changes,
            change =>
              change.beforeHash === null ||
              [homeIndexPath(f.path, f.home), runtimeIndexPath(f.path, f.runtime)].includes(change.path),
          ),
        ).toBe(true);
        expect(yield* snapshot(f.root)).toEqual(before);
        const result = yield* f.run(
          applyDevSkills(f.config, 'install', f.selected, {...manual, expectedDigest: preview.previewDigest}),
        );
        expect(result).toMatchObject({applied: true, recovered: false});
        const receipt = JSON.parse(yield* f.fs.readFileString(receiptPath(f.path, f.installed.target.skillRoot)));
        expect(Rec.keys(receipt.generations)).toEqual([result.bundleDigest]);
        expect(Rec.keys(receipt.consumers)).toEqual([result.consumerId]);
        expect((yield* f.run(statusDevSkills(f.config, f.selected))).targets[0].installationState).toBe('current');
        const release = yield* devSkillsReleaseFixture(f, '5.3.0-beta.10');
        const update = yield* f.run(previewDevSkillsRefresh(f.config, release));
        const prepared = yield* f.run(
          prepareDevSkillsRefresh(f.config, update, {expectedDigest: update.previewDigest}),
        );
        yield* release.activate;
        expect((yield* release.run(runDevSkillsRefresh(f.config, prepared.intentId))).repairRequired).toBe(false);
        expect(
          yield* f.fs.readFileString(f.path.join(f.runtime, 'dev-skills-refresh-history', `${old.intentId}.json`)),
        ).toBe(oldBytes);
        expect(yield* f.fs.readFileString(personal)).toBe('personal guidance');
      }).pipe(provide),
    );

  effectIt.effect('opts in only at the actual manual CLI and Manager install boundaries', () =>
    Effect.gen(function* () {
      const f = yield* missing();
      const before = yield* snapshot(f.root);
      const root = Command.make('threadnote');
      const command = root.pipe(
        Command.withSubcommands([makeDevSkillsCommand(program => Effect.flatMap(root, () => program(f.config)))]),
      );
      yield* f.run(
        Command.runWith(command, {version: 'fixture'})([
          'dev-skills',
          'install',
          '--agent',
          'codex',
          '--dry-run',
          '--json',
        ]),
      );
      expect(yield* snapshot(f.root)).toEqual(before);
      const request = (route: string, body: Record<string, unknown>) =>
        f.run(
          handleManagerDevSkillsRequest({
            config: f.config,
            method: 'POST',
            url: new URL(`http://127.0.0.1/api/dev-skills/${route}`),
            body: Effect.succeed(body),
          }),
        );
      const preview = yield* request('preview', {action: 'install', selector});
      expect(preview).toMatchObject({status: 200, body: {canApply: true}});
      expect(yield* snapshot(f.root)).toEqual(before);
      const digest = (yield* Schema.decodeUnknownEffect(Schema.Struct({previewDigest: Schema.String}))(preview!.body))
        .previewDigest;
      expect(
        yield* request('apply', {action: 'install', selector, previewDigest: digest, confirm: true}),
      ).toMatchObject({
        status: 200,
        body: {result: {applied: true}, status: {targets: [{installationState: 'current'}]}},
      });
    }).pipe(provide),
  );

  effectIt.effect('keeps public install, setup, status and automatic refresh from acquiring missing ownership', () =>
    Effect.gen(function* () {
      const f = yield* missing();
      const before = yield* snapshot(f.root);
      expect(yield* f.run(applyDevSkills(f.config, 'install', selector)).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
      });
      yield* f.run(statusDevSkills(f.config, selector));
      expect(yield* snapshot(f.root)).toEqual(before);
      expect(
        yield* f.run(ensureDevSkills(f.config, selector, {mode: 'setup', choice: 'default', operationId: 'no-repair'})),
      ).toMatchObject({state: 'pending', createdConsumer: false});
      const afterSetup = yield* snapshot(f.root);
      for (const [file, bytes] of Rec.toEntries(before)) expect(afterSetup[file]).toBe(bytes);
      expect(
        Arr.every(
          Arr.filter(Rec.keys(afterSetup), file => !(file in before)),
          file => file === 'home/dev-skills/ensure' || String.startsWith('home/dev-skills/ensure/')(file),
        ),
      ).toBe(true);
      const release = yield* devSkillsReleaseFixture(f, '5.3.0-beta.10');
      const preview = yield* f.run(previewDevSkillsRefresh(f.config, release));
      const intent = yield* f.run(prepareDevSkillsRefresh(f.config, preview, {expectedDigest: preview.previewDigest}));
      yield* release.activate;
      const physical = yield* snapshot(f.host);
      expect((yield* release.run(runDevSkillsRefresh(f.config, intent.intentId))).repairRequired).toBe(true);
      expect(yield* snapshot(f.host)).toEqual(physical);
    }).pipe(provide),
  );

  for (const location of ['store', 'workflow', 'entrypoint', 'ancestor'] as const)
    effectIt.effect(`rejects a ${location} symlink without changing its target`, () =>
      Effect.gen(function* () {
        const f = yield* missing();
        const outside = f.path.join(f.root, 'outside');
        yield* f.fs.makeDirectory(outside);
        const untouched = f.path.join(outside, 'personal.txt');
        yield* f.fs.writeFileString(untouched, 'personal');
        const link =
          location === 'store'
            ? f.store
            : location === 'workflow'
              ? f.path.join(f.installed.target.skillRoot, 'dev-plan')
              : location === 'entrypoint'
                ? f.path.join(f.installed.target.skillRoot, 'dev-plan', 'SKILL.md')
                : f.path.join(f.host, '.agents');
        if (location === 'store' || location === 'ancestor') yield* f.fs.remove(link, {recursive: true});
        yield* f.fs.makeDirectory(f.path.dirname(link), {recursive: true});
        yield* f.fs.symlink(location === 'entrypoint' ? f.path.join(outside, 'missing') : outside, link);
        expect(yield* f.run(applyDevSkills(f.config, 'install', selector, manual)).pipe(Effect.result)).toMatchObject({
          _tag: 'Failure',
        });
        expect(yield* f.fs.readLink(link)).toBe(location === 'entrypoint' ? f.path.join(outside, 'missing') : outside);
        expect(yield* f.fs.readFileString(untouched)).toBe('personal');
        expect(yield* f.fs.readDirectory(outside)).toEqual(['personal.txt']);
      }).pipe(provide),
    );

  effectIt.effect('propagates directory I/O failures instead of treating the store as absent', () =>
    Effect.gen(function* () {
      const f = yield* missing();
      const before = yield* snapshot(f.root);
      const error = PlatformError.systemError({
        _tag: 'PermissionDenied',
        module: 'FileSystem',
        method: 'readDirectory',
        pathOrDescriptor: f.store,
      });
      const fs = FileSystem.FileSystem.of({
        ...f.fs,
        readDirectory: file => (file === f.store ? Effect.fail(error) : f.fs.readDirectory(file)),
      });
      expect(
        yield* f
          .run(applyDevSkills(f.config, 'install', selector, manual))
          .pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.result),
      ).toMatchObject({_tag: 'Failure', failure: error});
      expect(yield* snapshot(f.root)).toEqual(before);
    }).pipe(provide),
  );

  effectIt.effect('blocks restore plus cross-target enablement before replaying either journal', () =>
    Effect.gen(function* () {
      const f = yield* missing();
      const journal = yield* enablement(f);
      yield* f.fs.writeFileString(enablementJournalPath(f.path, f.home), journal);
      yield* f.fs.writeFileString(f.path.join(f.store, 'restore-journal.json'), 'pending original restoration');
      const before = yield* snapshot(f.root);
      expect(yield* f.run(applyDevSkills(f.config, 'install', selector, manual)).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
        failure: {code: 'installation-conflict'},
      });
      expect(yield* snapshot(f.root)).toEqual(before);
    }).pipe(provide),
  );

  effectIt.effect.prop(
    'refuses every surviving managed store or workflow entry without changing any bytes',
    {
      kind: Schema.Literals([
        'unknown-file',
        'unknown-directory',
        'generation',
        'staging',
        'lock',
        'discovery-file',
        'discovery-directory',
        'physical-journal',
        'restore-journal',
      ]),
      member: Schema.Literals(['dev-spec', 'dev-plan', 'dev-cycle', 'watch-pr']),
      suffix: Schema.String.check(Schema.isPattern(/^[a-d]{1,8}$/u)),
      payload: Schema.String.check(Schema.isMaxLength(80)),
    },
    ({kind, member, suffix, payload}) =>
      Effect.gen(function* () {
        const f = yield* missing();
        const destination =
          kind === 'discovery-file'
            ? f.path.join(f.installed.target.skillRoot, member, 'SKILL.md')
            : kind === 'discovery-directory'
              ? f.path.join(f.installed.target.skillRoot, member, `unknown-${suffix}`)
              : f.path.join(
                  f.store,
                  (
                    {
                      'unknown-file': `unknown-${suffix}`,
                      'unknown-directory': `unknown-${suffix}`,
                      generation: 'generations/orphan',
                      staging: 'orphan.staging',
                      lock: '.mutation.lock',
                      'physical-journal': 'journal.json',
                      'restore-journal': 'restore-journal.json',
                    } as Record<string, string>
                  )[kind],
                );
        if (['unknown-directory', 'generation', 'staging', 'discovery-directory'].includes(kind))
          yield* f.fs.makeDirectory(destination, {recursive: true});
        else {
          yield* f.fs.makeDirectory(f.path.dirname(destination), {recursive: true});
          yield* f.fs.writeFileString(destination, payload);
        }
        const before = yield* snapshot(f.root);
        const preview = yield* f.run(previewDevSkills(f.config, 'install', selector, manual));
        expect(preview.canApply).toBe(false);
        // Original physical journals retain their separate recovery path; malformed ones fail closed.
        expect(yield* f.run(applyDevSkills(f.config, 'install', selector, manual)).pipe(Effect.result)).toMatchObject({
          _tag: 'Failure',
        });
        expect(yield* snapshot(f.root)).toEqual(before);
      }).pipe(provide),
    {arbitrary: {runs: 18}},
  );

  for (const mismatch of ['missing-runtime', 'different-target', 'removed', 'foreign-disabled'] as const)
    effectIt.effect(`refuses ${mismatch} enrollment`, () =>
      Effect.gen(function* () {
        const f = yield* missing();
        const homeFile = homeIndexPath(f.path, f.home),
          runtimeFile = runtimeIndexPath(f.path, f.runtime);
        const home = JSON.parse(yield* f.fs.readFileString(homeFile)),
          runtime = JSON.parse(yield* f.fs.readFileString(runtimeFile));
        if (mismatch === 'missing-runtime') delete runtime.enrollments[f.installed.consumerId];
        if (mismatch === 'different-target') runtime.enrollments[f.installed.consumerId].target.discoveryRoots = [];
        if (mismatch === 'removed') {
          home.targets[f.installed.consumerId].state = runtime.enrollments[f.installed.consumerId].state = 'removed';
          home.targets[f.installed.consumerId].enabled = runtime.enrollments[f.installed.consumerId].enabled = false;
        }
        if (mismatch === 'foreign-disabled') {
          const foreign = {
            ...home.targets[f.installed.consumerId],
            home: f.path.join(f.root, 'foreign'),
            enabled: false,
          };
          runtime.enrollments[consumerId(foreign)] = foreign;
        }
        yield* f.fs.writeFileString(homeFile, json(home));
        yield* f.fs.writeFileString(runtimeFile, json(runtime));
        const before = yield* snapshot(f.root);
        expect(yield* f.run(applyDevSkills(f.config, 'install', selector, manual)).pipe(Effect.result)).toMatchObject({
          _tag: 'Failure',
        });
        expect(yield* snapshot(f.root)).toEqual(before);
      }).pipe(provide),
    );

  for (const alias of [false, true])
    effectIt.effect(
      `refuses an unregistered home sharing another enrollment's ${alias ? 'aliased' : 'canonical'} empty target`,
      () =>
        Effect.gen(function* () {
          const f = yield* missing();
          if (alias) {
            const link = f.path.join(f.root, 'store-alias');
            yield* f.fs.symlink(f.installed.target.skillRoot, link);
            for (const kind of ['home', 'runtime'] as const) {
              const file = kind === 'home' ? homeIndexPath(f.path, f.home) : runtimeIndexPath(f.path, f.runtime);
              const index = JSON.parse(yield* f.fs.readFileString(file));
              const entries = kind === 'home' ? index.targets : index.enrollments;
              entries[f.installed.consumerId].target.skillRoot = link;
              yield* f.fs.writeFileString(file, json(index));
            }
          }
          const other = {...f.config, agentContextHome: f.path.join(f.root, 'unregistered-home')};
          const before = yield* snapshot(f.root);
          for (const options of [{}, manual]) {
            const preview = yield* f.run(previewDevSkills(other, 'install', selector, options));
            expect(preview.target.skillRoot).toBe(f.installed.target.skillRoot);
            expect(preview.consumerId).not.toBe(f.installed.consumerId);
            expect(preview.canApply).toBe(false);
            expect(yield* f.run(applyDevSkills(other, 'install', selector, options)).pipe(Effect.result)).toMatchObject(
              {_tag: 'Failure', failure: {code: 'installation-conflict'}},
            );
            expect(yield* snapshot(f.root)).toEqual(before);
          }
        }).pipe(provide),
    );

  effectIt.effect('refuses an absent foreign root beneath an aliased existing ancestor', () =>
    Effect.gen(function* () {
      const f = yield* missing();
      yield* f.fs.remove(f.installed.target.skillRoot, {recursive: true});
      const link = f.path.join(f.root, 'parent-alias');
      yield* f.fs.symlink(f.path.dirname(f.installed.target.skillRoot), link);
      const file = runtimeIndexPath(f.path, f.runtime);
      const runtime = JSON.parse(yield* f.fs.readFileString(file));
      runtime.enrollments[f.installed.consumerId].target.skillRoot = f.path.join(link, 'skills');
      yield* f.fs.writeFileString(file, json(runtime));
      const other = {...f.config, agentContextHome: f.path.join(f.root, 'unregistered-home')};
      const before = yield* snapshot(f.root);
      for (const options of [{}, manual]) {
        expect(yield* f.run(previewDevSkills(other, 'install', selector, options)).pipe(Effect.result)).toMatchObject({
          _tag: 'Failure',
          failure: {code: 'unsafe-path'},
        });
        expect(yield* f.run(applyDevSkills(other, 'install', selector, options)).pipe(Effect.result)).toMatchObject({
          _tag: 'Failure',
          failure: {code: 'unsafe-path'},
        });
        expect(yield* snapshot(f.root)).toEqual(before);
      }
      expect(yield* f.fs.exists(f.installed.target.skillRoot)).toBe(false);
    }).pipe(provide),
  );

  for (const boundary of ['before', 'home-lock', 'physical-lock'] as const)
    effectIt.effect(`refuses pending cross-target enablement ${boundary} without replay`, () =>
      Effect.gen(function* () {
        const f = yield* missing();
        const journal = yield* enablement(f);
        const file = enablementJournalPath(f.path, f.home);
        const preview = yield* f.run(previewDevSkills(f.config, 'install', selector, manual));
        let injected = false;
        if (boundary === 'before') {
          yield* f.fs.writeFileString(file, journal);
          injected = true;
        }
        const baselineHome = yield* f.fs.readFileString(homeIndexPath(f.path, f.home));
        const baselineRuntime = yield* f.fs.readFileString(runtimeIndexPath(f.path, f.runtime));
        const fs = FileSystem.FileSystem.of({
          ...f.fs,
          writeFileString: (name, content, options) => {
            const lock =
              boundary === 'home-lock' ? `${f.home}.setup-mutation.lock` : f.path.join(f.store, '.mutation.lock');
            if (!injected && name === lock) {
              injected = true;
              return f.fs
                .writeFileString(file, journal)
                .pipe(Effect.andThen(f.fs.writeFileString(name, content, options)));
            }
            return f.fs.writeFileString(name, content, options);
          },
        });
        expect(
          yield* f
            .run(
              applyDevSkills(f.config, 'install', selector, {
                ...manual,
                ...(boundary === 'before' ? {} : {expectedDigest: preview.previewDigest}),
              }),
            )
            .pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.result),
        ).toMatchObject({_tag: 'Failure'});
        expect(injected).toBe(true);
        expect(yield* f.fs.readFileString(file)).toBe(journal);
        expect(yield* f.fs.readFileString(homeIndexPath(f.path, f.home))).toBe(baselineHome);
        expect(yield* f.fs.readFileString(runtimeIndexPath(f.path, f.runtime))).toBe(baselineRuntime);
        expect(yield* f.fs.exists(receiptPath(f.path, f.installed.target.skillRoot))).toBe(false);
      }).pipe(provide),
    );

  effectIt.effect('rejects fresh physical inventory drift after preview and before the physical lock', () =>
    Effect.gen(function* () {
      const f = yield* missing();
      const preview = yield* f.run(previewDevSkills(f.config, 'install', selector, manual));
      const unexpected = f.path.join(f.store, 'appeared');
      let injected = false;
      const fs = FileSystem.FileSystem.of({
        ...f.fs,
        writeFileString: (file, content, options) => {
          if (!injected && file === f.path.join(f.store, '.mutation.lock')) {
            injected = true;
            return f.fs
              .writeFileString(unexpected, 'third-party')
              .pipe(Effect.andThen(f.fs.writeFileString(file, content, options)));
          }
          return f.fs.writeFileString(file, content, options);
        },
      });
      expect(
        yield* f
          .run(applyDevSkills(f.config, 'install', selector, {...manual, expectedDigest: preview.previewDigest}))
          .pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.result),
      ).toMatchObject({_tag: 'Failure', failure: {code: 'stale-preview'}});
      expect(injected).toBe(true);
      expect(yield* f.fs.readFileString(unexpected)).toBe('third-party');
      expect(yield* f.fs.exists(receiptPath(f.path, f.installed.target.skillRoot))).toBe(false);
    }).pipe(provide),
  );

  effectIt.effect(
    'never gains missing-store authority when an ordinary install loses its ownership while waiting',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const installed = yield* f.run(applyDevSkills(f.config, 'install', selector));
        let removed = false;
        const store = physicalDirectory(f.path, installed.target.skillRoot);
        const fs = FileSystem.FileSystem.of({
          ...f.fs,
          writeFileString: (file, bytes, options) => {
            if (!removed && file === `${f.home}.setup-mutation.lock`) {
              removed = true;
              return Effect.gen(function* () {
                yield* f.fs.remove(store, {recursive: true});
                for (const id of ['dev-spec', 'dev-plan', 'dev-cycle', 'watch-pr'])
                  yield* f.fs.remove(f.path.join(installed.target.skillRoot, id), {recursive: true});
                yield* f.fs.writeFileString(file, bytes, options);
              });
            }
            return f.fs.writeFileString(file, bytes, options);
          },
        });
        expect(
          yield* f
            .run(applyDevSkills(f.config, 'install', selector, manual))
            .pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.result),
        ).toMatchObject({_tag: 'Failure', failure: {code: 'stale-preview'}});
        expect(removed).toBe(true);
        expect(yield* f.fs.exists(receiptPath(f.path, installed.target.skillRoot))).toBe(false);
        expect(yield* f.fs.readDirectory(store)).toEqual([]);
      }).pipe(provide),
  );
});
