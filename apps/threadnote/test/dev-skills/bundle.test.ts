import {Array as EffectArray} from 'effect';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {buildDevSkillsManifest, validDevSkillPath} from '../../../../scripts/build.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {AGENT_SKILLS} from '../../src/agent_integration/skills.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const ids = ['dev-spec', 'dev-plan', 'dev-cycle', 'watch-pr'];
const sourceManifest = () => ({
  schemaVersion: 2,
  nativeRequirements: {
    executorVersion: 1,
    authoringVersion: 1,
    cycleVersion: 1,
    watchVersion: 1,
    closeoutVersion: 1,
  },
  workflowProtocol: 1,
  stateSchema: 1,
  minimumRuntime: '5.3.0-beta.4',
  skills: EffectArray.map(ids, id => ({
    id,
    role: id === 'watch-pr' ? 'support' : 'primary',
    files: ['SKILL.md', 'references/helper.md'],
  })),
});

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote bundle '});
  const manifest = sourceManifest();
  for (const member of manifest.skills) {
    const directory = path.join(root, 'config', 'agent-skills', member.id);
    yield* fs.makeDirectory(path.join(directory, 'references'), {recursive: true});
    yield* fs.writeFileString(path.join(directory, 'SKILL.md'), `---\nname: ${member.id}\n---\nWorkflow`);
    yield* fs.writeFileString(path.join(directory, 'references', 'helper.md'), 'Fixture reference\n');
  }
  const manifestPath = path.join(root, 'config', 'dev-skills.json');
  yield* fs.writeFileString(manifestPath, JSON.stringify(manifest));
  return {root, manifest, manifestPath};
});

describe('first-party development bundle', () => {
  it('keeps low-level core skills independent from the workflow bundle', () => {
    expect(AGENT_SKILLS).toEqual([
      'threadnote-context',
      'threadnote-code-graph',
      'threadnote-memory',
      'threadnote-health',
    ]);
  });

  it('rejects escaping and nonportable paths for every generated prefix', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('scripts', 'references', 'nested'), {maxLength: 4}), parts => {
        const prefix = parts.length ? `${EffectArray.join(parts, '/')}/` : '';
        expect(validDevSkillPath(`${prefix}helper.py`)).toBe(true);
        for (const suffix of [
          '../escape',
          '/absolute',
          'C:\\escape',
          'nul.py',
          'CON',
          'file.',
          '__pycache__/x.pyc',
          '.git/config',
          'a//b',
        ]) {
          expect(validDevSkillPath(prefix + suffix)).toBe(false);
        }
      }),
      {numRuns: 40},
    );
  });

  effectIt.effect('binds every shipped file and release to a deterministic digest', () =>
    Effect.gen(function* () {
      const {root, manifest, manifestPath} = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const first = yield* buildDevSkillsManifest(root, '5.3.0-beta.4');
      yield* fs.writeFileString(
        manifestPath,
        JSON.stringify({
          ...manifest,
          skills: EffectArray.map([...manifest.skills].reverse(), member => ({
            ...member,
            files: [...member.files].reverse(),
          })),
        }),
      );
      expect(yield* buildDevSkillsManifest(root, '5.3.0-beta.4')).toEqual(first);
      expect(EffectRecord.keys(first.hashes)).toHaveLength(8);
      expect(first.digest).toMatch(/^[a-f0-9]{64}$/u);
      expect((yield* buildDevSkillsManifest(root, '5.3.0-beta.5')).digest).not.toBe(first.digest);
      const path = yield* Path.Path;
      yield* fs.writeFileString(
        path.join(root, 'config', 'agent-skills', 'dev-spec', 'references', 'helper.md'),
        'Changed fixture reference\n',
      );
      expect((yield* buildDevSkillsManifest(root, '5.3.0-beta.4')).digest).not.toBe(first.digest);
    }).pipe(provideTestLayer(BunServices.layer)),
  );

  effectIt.effect('rejects missing, unlisted and case-colliding bundle members', () =>
    Effect.gen(function* () {
      const {root, manifest, manifestPath} = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const expectFailure = () =>
        buildDevSkillsManifest(root, '5.3.0-beta.4').pipe(
          Effect.flip,
          Effect.map(error => expect(error).toBeDefined()),
        );
      yield* fs.writeFileString(manifestPath, JSON.stringify({...manifest, skills: manifest.skills.slice(1)}));
      yield* expectFailure();
      yield* fs.writeFileString(manifestPath, JSON.stringify(manifest));
      const extra = path.join(root, 'config', 'agent-skills', 'dev-spec', 'extra.txt');
      yield* fs.writeFileString(extra, 'not in release inventory');
      yield* expectFailure();
      yield* fs.remove(extra);
      manifest.skills[0].files.push('references/HELPER.md');
      yield* fs.writeFileString(manifestPath, JSON.stringify(manifest));
      yield* expectFailure();
      manifest.skills[0].files.pop();
      yield* fs.writeFileString(manifestPath, JSON.stringify(manifest));
      yield* fs.remove(path.join(root, 'config', 'agent-skills', 'dev-plan', 'SKILL.md'));
      yield* expectFailure();
    }).pipe(provideTestLayer(BunServices.layer)),
  );

  effectIt.effect('validates the real first-party product inventory', () =>
    Effect.gen(function* () {
      const manifest = yield* buildDevSkillsManifest(process.cwd(), '5.3.0-beta.4');
      expect(
        EffectArray.map(
          EffectArray.filter(manifest.skills, skill => skill.role === 'primary'),
          skill => skill.id,
        ),
      ).toEqual(['dev-cycle', 'dev-plan', 'dev-spec']);
      expect(manifest.nativeRequirements).toEqual(sourceManifest().nativeRequirements);
      expect(manifest.prerequisites).not.toHaveProperty('python');
      expect(
        EffectArray.some(EffectRecord.keys(manifest.hashes), file => Effect2.pipe(file, EffectString.endsWith('.py'))),
      ).toBe(false);
      expect(manifest.hashes['dev-plan/references/native-authoring.md']).toMatch(/^[a-f0-9]{64}$/u);
      expect(manifest.hashes['watch-pr/references/background-worker.md']).toMatch(/^[a-f0-9]{64}$/u);
    }).pipe(provideTestLayer(BunServices.layer)),
  );

  effectIt.effect.skipIf(process.platform === 'win32')(
    'rejects a payload or manifest symlink even when it points at valid content',
    () =>
      Effect.gen(function* () {
        const {root, manifestPath} = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const helper = path.join(root, 'config', 'agent-skills', 'dev-plan', 'references', 'helper.md');
        const outside = path.join(root, 'outside.md');
        yield* fs.rename(helper, outside);
        yield* fs.symlink(outside, helper);
        expect(yield* buildDevSkillsManifest(root, '5.3.0-beta.4').pipe(Effect.flip)).toBeDefined();
        yield* fs.remove(helper);
        yield* fs.rename(outside, helper);
        yield* fs.rename(manifestPath, path.join(root, 'outside.json'));
        yield* fs.symlink(path.join(root, 'outside.json'), manifestPath);
        expect(yield* buildDevSkillsManifest(root, '5.3.0-beta.4').pipe(Effect.flip)).toBeDefined();
      }).pipe(provideTestLayer(BunServices.layer)),
  );
});
