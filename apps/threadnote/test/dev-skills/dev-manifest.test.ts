import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {buildDevSkillsManifest} from '../../../../scripts/build.js';
import {loadDevSkillsBundleAt, parseDevSkillsManifest, validDevSkillPath} from '../../src/dev_skills/manifest.js';
import {consumerId, parseHomeIndex, parseRuntimeIndex, parseReceipt} from '../../src/dev_skills/registry.js';
import type {DevSkillsTarget} from '../../src/dev_skills/contract.js';
import {devSkillsTestLayer, fixture, snapshot} from './service-fixture.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('runtime development bundle manifest', () => {
  it('rejects every traversal/absolute/Windows reserved suffix under generated prefixes', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('scripts', 'references', 'nested'), {maxLength: 4}), parts => {
        const prefix = parts.length ? `${parts.join('/')}/` : '';
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
  effectIt.effect('rejects stripped release metadata, incompatible versions and corrupted/extra/missing payload', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      expect(yield* loadDevSkillsBundleAt(f.source, '5.3.0-beta.4', true).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
      });
      expect(yield* loadDevSkillsBundleAt(f.source, '5.2.0').pipe(Effect.result)).toMatchObject({_tag: 'Failure'});
      const bundle = yield* loadDevSkillsBundleAt(f.source, '5.3.0-beta.4');
      expect(() => parseDevSkillsManifest({...bundle.manifest, digest: '0'.repeat(64)})).toThrow();
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
      const enrollment = {...consumer, state: 'enrolled'};
      const homeIndex = {schemaVersion: 1, home, installationRoot, targets: {[id]: enrollment}};
      const runtimeIndex = {schemaVersion: 1, installationRoot, enrollments: {[id]: enrollment}};
      const receipt = {
        schemaVersion: 1,
        skillRoot,
        layout: 'directory',
        manifest: bundle.manifest,
        generations: {[bundle.manifest.digest]: bundle.manifest},
        consumers: {[id]: consumer},
        entrypoints: Object.fromEntries(bundle.manifest.skills.map(skill => [`${skill.id}/SKILL.md`, 'owned content'])),
      };
      expect(parseHomeIndex(JSON.parse(JSON.stringify(homeIndex)))).toEqual(homeIndex);
      expect(parseRuntimeIndex(JSON.parse(JSON.stringify(runtimeIndex)))).toEqual(runtimeIndex);
      expect(parseReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
    }).pipe(provideTestLayer(devSkillsTestLayer)),
  );
});
