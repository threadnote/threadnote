import {Array as EffectArray, Option as EffectOption} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {applyDevSkills, previewDevSkills} from '../../src/dev_skills/index.js';
import {hash, json} from '../../src/dev_skills/files.js';
import {generationRoot, renderEntrypoints} from '../../src/dev_skills/inspection.js';
import {
  loadDevSkillsBundleAt,
  parseDevSkillsManifest,
  parseHistoricalDevSkillsManifest,
} from '../../src/dev_skills/manifest.js';
import {homeIndexPath, journalPath, parseReceipt, receiptPath} from '../../src/dev_skills/registry.js';
import {devSkillsTestLayer, fixture, snapshot} from './service-fixture.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import type {DevSkillMember} from '../../src/dev_skills/contract.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

function parseChangedJournal(value: unknown): {changes: {path: string}[]} {
  if (typeof value !== 'object' || value === null || !('changes' in value) || !EffectArray.isArray(value.changes))
    throw new Error('Expected a workflow journal with changes');
  const changes = EffectArray.map(value.changes, change => {
    if (typeof change !== 'object' || change === null || !('path' in change) || typeof change.path !== 'string')
      throw new Error('Expected a workflow journal change path');
    return {path: change.path};
  });
  return {...value, changes};
}

const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(TestClock.withLive, provideTestLayer(devSkillsTestLayer));
const historical = Effect.fn(function* (
  flat = false,
  count = 1,
  retiredSupportFiles: 'full' | 'entrypoint-only' = 'full',
) {
  const f = yield* fixture();
  const selector = {agent: flat ? 'antigravity-cli' : 'codex'};
  const installed = yield* f.run(applyDevSkills(f.config, 'install', selector));
  const other = {
    ...f.config,
    agentContextHome: f.path.join(f.root, 'other-home'),
  };
  yield* f.run(applyDevSkills(other, 'install', selector));
  const current = yield* loadDevSkillsBundleAt(f.source, '5.3.0-beta.4');
  const support = EffectOption.getOrUndefined(
    EffectArray.findFirst(current.manifest.skills, skill => skill.id === 'watch-pr'),
  )!;
  const retiredSupport = retiredSupportFiles === 'entrypoint-only' ? {...support, files: ['SKILL.md']} : support;
  const retiredIds = Array.from({length: count}, (_, index) => `dev-retired-${String.fromCharCode(97 + index)}`);
  const skills = [
    ...EffectArray.filter(current.manifest.skills, skill => skill.role === 'primary'),
    ...EffectArray.map(retiredIds, id => ({...retiredSupport, id})),
  ].sort((a, b) => Effect2.pipe(a.id, EffectString.localeCompare(b.id)));
  const files: Record<string, string> = {};
  const hashes: Record<string, string> = {};
  for (const skill of skills)
    for (const file of skill.files) {
      const original = current.files[`${skill.role === 'support' ? 'watch-pr' : skill.id}/${file}`];
      const content =
        file === 'SKILL.md' && skill.role === 'support'
          ? Buffer.from(
              Effect2.pipe(Buffer.from(original, 'base64').toString(), EffectString.replaceAll('watch-pr', skill.id)),
            ).toString('base64')
          : original;
      files[`${skill.id}/${file}`] = content;
      hashes[`${skill.id}/${file}`] = hash(Buffer.from(content, 'base64'));
    }
  const {digest: _digest, ...base} = current.manifest;
  const candidate = {...base, skills, hashes};
  const manifest = parseHistoricalDevSkillsManifest({
    ...candidate,
    digest: hash(JSON.stringify(candidate)),
  });
  expect(() => parseDevSkillsManifest(manifest)).toThrow();
  const generation = generationRoot(f.path, installed.target.skillRoot, manifest.digest);
  for (const [relative, content] of EffectRecord.toEntries(files)) {
    const file = f.path.join(generation, relative);
    yield* f.fs.makeDirectory(f.path.dirname(file), {recursive: true});
    yield* f.fs.writeFile(file, Buffer.from(content, 'base64'));
  }
  const receiptFile = receiptPath(f.path, installed.target.skillRoot);
  const originalReceipt = parseReceipt(JSON.parse(yield* f.fs.readFileString(receiptFile)));
  for (const relative of EffectRecord.keys(originalReceipt.entrypoints))
    yield* f.fs.remove(f.path.join(installed.target.skillRoot, relative));
  const entrypoints = renderEntrypoints(f.path, installed.target, {
    manifest,
    files,
  });
  for (const [relative, content] of EffectRecord.toEntries(entrypoints)) {
    const file = f.path.join(installed.target.skillRoot, relative);
    yield* f.fs.makeDirectory(f.path.dirname(file), {recursive: true});
    yield* f.fs.writeFileString(file, content);
  }
  const receipt = {
    ...originalReceipt,
    manifest,
    generations: {
      ...originalReceipt.generations,
      [manifest.digest]: manifest,
    },
    entrypoints,
  };
  yield* f.fs.writeFileString(receiptFile, json(receipt));
  return {
    ...f,
    selector,
    other,
    installed,
    manifest,
    receipt,
    receiptFile,
    generation,
    retiredIds,
  };
});

describe('bounded historical support retirement', () => {
  for (const flat of [false, true])
    for (const edited of [false, true]) {
      effectIt.effect(
        `${flat ? 'flat' : 'directory'} refresh retires the full support bound and preserves ${edited ? 'edited' : 'unchanged'} history`,
        () =>
          Effect.gen(function* () {
            const f = yield* historical(flat, 16, 'entrypoint-only');
            const relative = flat ? `${f.retiredIds[0]}.md` : `${f.retiredIds[0]}/SKILL.md`;
            const retired = f.path.join(f.installed.target.skillRoot, relative);
            if (edited) yield* f.fs.writeFileString(retired, 'user-edited historical workflow');
            const unrelated = f.path.join(f.installed.target.skillRoot, 'unmanaged.txt');
            yield* f.fs.writeFileString(unrelated, 'unmanaged');
            const oldHelpers = yield* snapshot(f.generation);
            const otherIndex = yield* f.fs.readFileString(homeIndexPath(f.path, f.other.agentContextHome));
            const preview = yield* f.run(previewDevSkills(f.config, 'update', f.selector));
            expect(preview.canApply).toBe(true);
            const result = yield* f.run(
              applyDevSkills(f.config, 'update', f.selector, {
                expectedDigest: preview.previewDigest,
              }),
            );
            for (const id of f.retiredIds) {
              const file = f.path.join(f.installed.target.skillRoot, flat ? `${id}.md` : `${id}/SKILL.md`);
              expect(yield* f.fs.exists(file)).toBe(edited && file === retired);
            }
            if (edited) {
              expect(result.retainedPaths).toContain(retired);
              expect(yield* f.fs.readFileString(retired)).toBe('user-edited historical workflow');
            }
            expect(yield* snapshot(f.generation)).toEqual(oldHelpers);
            expect(yield* f.fs.readFileString(unrelated)).toBe('unmanaged');
            expect(yield* f.fs.readFileString(homeIndexPath(f.path, f.other.agentContextHome))).toBe(otherIndex);
            const receipt = parseReceipt(JSON.parse(yield* f.fs.readFileString(f.receiptFile)));
            expect(EffectRecord.keys(receipt.consumers)).toHaveLength(2);
            expect(EffectRecord.keys(receipt.entrypoints)).toHaveLength(4);
            expect(
              yield* f.fs.exists(f.path.join(f.installed.target.skillRoot, flat ? 'watch-pr.md' : 'watch-pr/SKILL.md')),
            ).toBe(true);
            expect((yield* f.run(applyDevSkills(f.config, 'update', f.selector))).applied).toBe(false);
          }).pipe(provide),
      );
    }

  for (const corruption of ['copied-bytes', 'rendered-authority']) {
    effectIt.effect(`rejects ${corruption} without retiring historical ownership`, () =>
      Effect.gen(function* () {
        const f = yield* historical();
        if (corruption === 'copied-bytes')
          yield* f.fs.writeFileString(f.path.join(f.generation, f.retiredIds[0], 'scripts/helper.py'), 'corrupt');
        else {
          const relative = `${f.retiredIds[0]}/SKILL.md`;
          const entrypoints = {
            ...f.receipt.entrypoints,
            [relative]: 'fabricated owner text',
          };
          yield* f.fs.writeFileString(f.receiptFile, json({...f.receipt, entrypoints}));
          yield* f.fs.writeFileString(f.path.join(f.installed.target.skillRoot, relative), entrypoints[relative]);
        }
        const before = yield* snapshot(f.root);
        for (const action of ['update', 'remove'] as const)
          expect(yield* f.run(applyDevSkills(f.config, action, f.selector)).pipe(Effect.result)).toMatchObject({
            _tag: 'Failure',
          });
        expect(yield* snapshot(f.root)).toEqual(before);
      }).pipe(provide),
    );
  }

  effectIt.effect('checks omitted obsolete discovery writes before recovery changes or retires its journal', () =>
    Effect.gen(function* () {
      const f = yield* historical();
      let failed = false;
      const failing = FileSystem.FileSystem.of({
        ...f.fs,
        rename: (from, to) => {
          if (!failed && f.path.basename(to) === 'journal.json') {
            failed = true;
            return f.fs.rename(from, to).pipe(Effect.andThen(f.fs.rename(f.path.join(f.root, 'missing'), to)));
          }
          return f.fs.rename(from, to);
        },
      });
      expect(
        yield* f
          .run(applyDevSkills(f.config, 'update', f.selector))
          .pipe(Effect.provideService(FileSystem.FileSystem, failing), Effect.result),
      ).toMatchObject({_tag: 'Failure'});
      const file = journalPath(f.path, f.installed.target.skillRoot);
      const journal = parseChangedJournal(JSON.parse(yield* f.fs.readFileString(file)));
      journal.changes = EffectArray.filter(
        journal.changes,
        change => change.path !== f.path.join(f.installed.target.skillRoot, f.retiredIds[0], 'SKILL.md'),
      );
      yield* f.fs.writeFileString(file, JSON.stringify(journal));
      const before = yield* snapshot(f.root);
      expect(yield* f.run(applyDevSkills(f.config, 'update', f.selector)).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
        failure: {code: 'invalid-state'},
      });
      expect(yield* snapshot(f.root)).toEqual(before);
    }).pipe(provide),
  );

  effectIt.effect('resumes after an obsolete flat entrypoint deletion response is lost', () =>
    Effect.gen(function* () {
      const f = yield* historical(true);
      const retired = f.path.join(f.installed.target.skillRoot, `${f.retiredIds[0]}.md`);
      let failed = false;
      const failing = FileSystem.FileSystem.of({
        ...f.fs,
        remove: (file, options) => {
          if (!failed && file === retired) {
            failed = true;
            return f.fs.remove(file, options).pipe(Effect.andThen(f.fs.rename(f.path.join(f.root, 'missing'), file)));
          }
          return f.fs.remove(file, options);
        },
      });
      expect(
        yield* f
          .run(applyDevSkills(f.config, 'update', f.selector))
          .pipe(Effect.provideService(FileSystem.FileSystem, failing), Effect.result),
      ).toMatchObject({_tag: 'Failure'});
      expect(failed).toBe(true);
      expect(yield* f.fs.exists(retired)).toBe(false);
      expect(yield* f.run(applyDevSkills(f.config, 'update', f.selector))).toMatchObject({recovered: true});
      expect(yield* f.fs.exists(journalPath(f.path, f.installed.target.skillRoot))).toBe(false);
      expect(yield* f.fs.exists(f.path.join(f.installed.target.skillRoot, 'watch-pr.md'))).toBe(true);
    }).pipe(provide),
  );

  effectIt.effect('rejects core names, arbitrary aliases, paths, reserved names and duplicate support identities', () =>
    Effect.gen(function* () {
      const f = yield* historical();
      const member = EffectOption.getOrUndefined(
        EffectArray.findFirst(f.manifest.skills, skill => skill.role === 'support'),
      )!;
      const withSkills = (members: readonly DevSkillMember[]) => {
        const skills = [...members].sort((a, b) => Effect2.pipe(a.id, EffectString.localeCompare(b.id)));
        const hashes = EffectRecord.fromEntries(
          EffectArray.flatMap(skills, skill =>
            EffectArray.map(skill.files, (file): readonly [string, string | undefined] => [
              `${skill.id}/${file}`,
              f.manifest.hashes[`${skill.role === 'support' ? member.id : skill.id}/${file}`],
            ]),
          ),
        );
        const {digest: _digest, ...base} = f.manifest;
        const value = {...base, skills, hashes};
        return {...value, digest: hash(JSON.stringify(value))};
      };
      for (const id of [
        'threadnote',
        'threadnote-context',
        'threadnote-memory',
        'watch',
        '../dev-retired',
        '/dev-retired',
        'con',
        'nul',
        'dev-retired.',
        'Dev-retired-a',
      ]) {
        expect(() =>
          parseHistoricalDevSkillsManifest(
            withSkills([...EffectArray.filter(f.manifest.skills, skill => skill.role === 'primary'), {...member, id}]),
          ),
        ).toThrow();
      }
      expect(() => parseHistoricalDevSkillsManifest(withSkills([...f.manifest.skills, member]))).toThrow();
      expect(() =>
        parseHistoricalDevSkillsManifest(
          withSkills([
            ...f.manifest.skills,
            {
              ...member,
              id: Effect2.pipe(member.id, EffectString.toUpperCase),
            },
          ]),
        ),
      ).toThrow();
      expect(() =>
        parseReceipt({
          ...f.receipt,
          entrypoints: {
            ...f.receipt.entrypoints,
            'threadnote-context/SKILL.md': 'unowned',
          },
        }),
      ).toThrow();
      expect(() =>
        parseHistoricalDevSkillsManifest({
          ...f.manifest,
          digest: Effect2.pipe('0', EffectString.repeat(64)),
        }),
      ).toThrow();
    }).pipe(provide),
  );
});
