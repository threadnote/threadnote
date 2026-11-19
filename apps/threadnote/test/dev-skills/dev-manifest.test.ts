import {Array as EffectArray} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Effect, Path} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {buildDevSkillsManifest, localMarkdownLinks} from '../../../../scripts/build.js';
import {generationRoot, isOwnedRendering, renderEntrypoints} from '../../src/dev_skills/inspection.js';
import {loadDevSkillsBundleAt, parseDevSkillsManifest, validDevSkillPath} from '../../src/dev_skills/manifest.js';
import {consumerId, parseHomeIndex, parseRuntimeIndex, parseReceipt} from '../../src/dev_skills/registry.js';
import type {DevSkillsTarget} from '../../src/dev_skills/contract.js';
import {devSkillsTestLayer, fixture, snapshot} from './service-fixture.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {win32} from '@threadnote/testing/node-path';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('runtime development bundle manifest', () => {
  it('rejects every traversal/absolute/Windows reserved suffix under generated prefixes', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('scripts', 'references', 'nested'), {maxLength: 4}), parts => {
        const prefix = parts.length ? `${EffectArray.join(parts, '/')}/` : '';
        for (const invalid of ['../file', './file', '/file', 'C:\\file', 'con.py', 'nul', 'a//b', 'file.'])
          expect(validDevSkillPath(prefix + invalid)).toBe(false);
        expect(validDevSkillPath(prefix + 'helper.py')).toBe(true);
      }),
      {numRuns: 30},
    );
  });
  effectIt.effect('matches the independent release builder and preserves source bytes without writes', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const before = yield* snapshot(f.root);
      const bundle = yield* loadDevSkillsBundleAt(f.source, '5.3.0-beta.4');
      expect(bundle.manifest).toEqual(yield* buildDevSkillsManifest(f.source, '5.3.0-beta.4'));
      expect(Buffer.from(bundle.files['dev-spec/scripts/helper.py'], 'base64').toString()).toContain(
        '{{THREADNOTE_SKILL_ROOT}}',
      );
      expect(yield* snapshot(f.root)).toEqual(before);
      yield* f.fs.writeFileString(f.manifest, JSON.stringify(bundle.manifest));
      expect((yield* loadDevSkillsBundleAt(f.source, '5.3.0-beta.4', true)).manifest).toEqual(bundle.manifest);
    }).pipe(provideTestLayer(devSkillsTestLayer)),
  );
  effectIt.effect('rejects a skill link that does not resolve from its rendered generation', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      for (const [relative, target, accepted] of [
        ['SKILL.md', 'references/notes.md', false],
        ['SKILL.md', '<references/notes.md>', false],
        ['SKILL.md', '{{THREADNOTE_SKILL_ROOT}}/references/missing.md', false],
        ['SKILL.md', '<{{THREADNOTE_SKILL_ROOT}}/references/notes.md#part>', true],
        ['SKILL.md', '{{THREADNOTE_BUNDLE_ROOT}}/watch-pr/SKILL.md', false],
        ['SKILL.md', 'https://example.com/guide', true],
        ['references/notes.md', '../../watch-pr/SKILL.md', false],
        ['references/notes.md', '../scripts/helper.py', true],
      ] as const) {
        const file = f.path.join(f.source, 'config/agent-skills/dev-plan', relative);
        const base = yield* f.fs.readFileString(file);
        yield* f.fs.writeFileString(file, `${base}[link](${target})\n`);
        const built = yield* buildDevSkillsManifest(f.source, '5.3.0-beta.4').pipe(Effect.result);
        yield* f.fs.writeFileString(file, base);
        expect(built._tag, `${relative}: ${target}`).toBe(accepted ? 'Success' : 'Failure');
      }
    }).pipe(provideTestLayer(devSkillsTestLayer)),
  );
  effectIt.effect('renders the shipped writing link to a generation file under a skill root with a space', () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const bundle = yield* loadDevSkillsBundleAt(process.cwd(), '5.3.0-beta.7', false);
      const skillRoot = path.resolve('Application Support', 'skills');
      const generation = generationRoot(path, skillRoot, bundle.manifest.digest);
      const target: DevSkillsTarget = {
        surfaceId: 'claude-code',
        agentId: 'claude',
        profile: 'desktop',
        scope: 'user',
        skillRoot,
        discoveryRoots: [skillRoot],
        layout: 'directory',
      };
      const [writing] = EffectArray.filter(
        localMarkdownLinks(renderEntrypoints(path, target, bundle)['dev-plan/SKILL.md']),
        link => Effect2.pipe(link, EffectString.endsWith('references/writing.md')),
      );
      expect(path.isAbsolute(writing)).toBe(true);
      expect(path.resolve(writing)).toBe(path.join(generation, 'dev-plan/references/writing.md'));
      expect(bundle.manifest.hashes).toHaveProperty(['dev-plan/references/writing.md']);
    }).pipe(provideTestLayer(devSkillsTestLayer)),
  );
  effectIt.effect('renders Windows skill roots as escape-free link destinations and keeps native receipts owned', () =>
    Effect.gen(function* () {
      const native = yield* Path.Path;
      const path = Path.make({...win32, fromFileUrl: native.fromFileUrl, toFileUrl: native.toFileUrl});
      const bundle = yield* loadDevSkillsBundleAt(process.cwd(), '5.3.0-beta.7', false);
      const skillRoot = 'C:\\Users\\me\\.claude\\skills';
      const target: DevSkillsTarget = {
        surfaceId: 'claude-code',
        agentId: 'claude',
        profile: 'desktop',
        scope: 'user',
        skillRoot,
        discoveryRoots: [skillRoot],
        layout: 'directory',
      };
      const rendered = renderEntrypoints(path, target, bundle);
      const [writing] = EffectArray.filter(localMarkdownLinks(rendered['dev-plan/SKILL.md']), link =>
        Effect2.pipe(link, EffectString.endsWith('references/writing.md')),
      );
      expect(writing).not.toContain('\\');
      expect(win32.resolve(writing)).toBe(
        win32.join(generationRoot(path, skillRoot, bundle.manifest.digest), 'dev-plan', 'references', 'writing.md'),
      );
      const legacy = renderEntrypoints(path, target, bundle, '\\');
      expect(legacy['dev-plan/SKILL.md']).toContain(win32.join(skillRoot, '.threadnote-dev-skills'));
      expect(isOwnedRendering(path, target, bundle, rendered)).toBe(true);
      expect(isOwnedRendering(path, target, bundle, legacy)).toBe(true);
      expect(
        isOwnedRendering(path, target, bundle, {...rendered, 'dev-plan/SKILL.md': `${rendered['dev-plan/SKILL.md']}x`}),
      ).toBe(false);
    }).pipe(provideTestLayer(devSkillsTestLayer)),
  );
  effectIt.effect('rejects stripped release metadata, incompatible versions and corrupted/extra/missing payload', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      expect(yield* loadDevSkillsBundleAt(f.source, '5.3.0-beta.4', true).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
      });
      expect(yield* loadDevSkillsBundleAt(f.source, '5.2.0').pipe(Effect.result)).toMatchObject({_tag: 'Failure'});
      const bundle = yield* loadDevSkillsBundleAt(f.source, '5.3.0-beta.4');
      expect(() =>
        parseDevSkillsManifest({...bundle.manifest, digest: Effect2.pipe('0', EffectString.repeat(64))}),
      ).toThrow();
      yield* f.fs.writeFileString(f.manifest, JSON.stringify(bundle.manifest));
      const file = f.path.join(f.source, 'config/agent-skills/dev-plan/scripts/helper.py');
      yield* f.fs.writeFileString(file, 'corrupted');
      expect(yield* loadDevSkillsBundleAt(f.source, '5.3.0-beta.4').pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
      });
      yield* f.fs.writeFileString(file, Buffer.from(bundle.files['dev-plan/scripts/helper.py'], 'base64').toString());
      const extra = f.path.join(f.source, 'config/agent-skills/dev-plan/extra');
      yield* f.fs.writeFileString(extra, 'unlisted');
      expect(yield* loadDevSkillsBundleAt(f.source, '5.3.0-beta.4').pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
      });
      yield* f.fs.remove(extra);
      yield* f.fs.remove(file);
      expect(yield* loadDevSkillsBundleAt(f.source, '5.3.0-beta.4').pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
      });
    }).pipe(provideTestLayer(devSkillsTestLayer)),
  );
  effectIt.effect('round-trips canonical native Windows UNC roots through all ownership indexes', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const bundle = yield* loadDevSkillsBundleAt(f.source, '5.3.0-beta.4');
      const home = '\\\\server\\share\\threadnote-home';
      const installationRoot = '\\\\server\\share\\runtime';
      const skillRoot = '\\\\server\\share\\agent\\skills';
      const target: DevSkillsTarget = {
        surfaceId: 'omp-agent',
        agentId: 'omp',
        profile: 'desktop',
        scope: 'user',
        skillRoot,
        discoveryRoots: [skillRoot],
        layout: 'directory',
      };
      const consumer = {home, installationRoot, target};
      const id = consumerId(consumer);
      const receipt = {
        schemaVersion: 1,
        skillRoot,
        layout: 'directory',
        manifest: bundle.manifest,
        generations: {[bundle.manifest.digest]: bundle.manifest},
        consumers: {[id]: consumer},
        entrypoints: EffectRecord.fromEntries(
          EffectArray.map(bundle.manifest.skills, skill => [`${skill.id}/SKILL.md`, 'owned content']),
        ),
      };
      for (const state of ['enrolled', 'removed'] as const) {
        const enrollment = {...consumer, state};
        const homeIndex = {schemaVersion: 1, home, installationRoot, targets: {[id]: enrollment}};
        const runtimeIndex = {schemaVersion: 1, installationRoot, enrollments: {[id]: enrollment}};
        const beforeHome = JSON.stringify(homeIndex);
        const beforeRuntime = JSON.stringify(runtimeIndex);
        const normalizedEnrollment = {...enrollment, enabled: state === 'enrolled'};
        const expectedHome = {...homeIndex, schemaVersion: 2, targets: {[id]: normalizedEnrollment}};
        const expectedRuntime = {...runtimeIndex, schemaVersion: 2, enrollments: {[id]: normalizedEnrollment}};
        expect(parseHomeIndex(homeIndex)).toEqual(expectedHome);
        expect(parseRuntimeIndex(runtimeIndex)).toEqual(expectedRuntime);
        expect(JSON.stringify(homeIndex)).toBe(beforeHome);
        expect(JSON.stringify(runtimeIndex)).toBe(beforeRuntime);
        expect(parseHomeIndex(JSON.parse(JSON.stringify(expectedHome)))).toEqual(expectedHome);
        expect(parseRuntimeIndex(JSON.parse(JSON.stringify(expectedRuntime)))).toEqual(expectedRuntime);
      }
      expect(parseReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
    }).pipe(provideTestLayer(devSkillsTestLayer)),
  );
});
