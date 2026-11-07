import {provideTestLayer} from '../helpers/effect-layer.js';
import {createHash} from '@threadnote/testing/node-crypto';
import {expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe} from 'vitest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {isLegacyLocalModelMigrationPending, migrateLegacyLocalModels} from '@threadnote/threadnote/migration/models';
import type {LocalModelManifest} from '@threadnote/inference/models/catalog';
import {readModelSelection, writeModelSelection} from '@threadnote/inference/models/selection';

const modelBytes = new TextEncoder().encode('small deterministic legacy GGUF');
const manifest: LocalModelManifest = {
  architecture: 'fixture',
  contextLimit: 128,
  file: 'fixture.gguf',
  id: 'fixture-generation',
  license: 'MIT',
  minimumRamBytes: 1,
  quantization: 'fixture',
  repository: 'example/fixture',
  revision: '0123456789abcdef0123456789abcdef01234567',
  role: 'generation',
  runtime: {nodeLlamaCpp: '3.19.1'},
  sha256: createHash('sha256').update(modelBytes).digest('hex'),
  size: modelBytes.byteLength,
  task: 'test',
  version: 1,
};

describe('legacy local model migration', () => {
  it.effect('adopts, verifies, and selects an already-installed generation model without downloading it', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-model-migration-'});
        const source = path.join(home, 'threadnote', 'models', manifest.file);
        yield* fs.makeDirectory(path.dirname(source), {recursive: true});
        yield* fs.writeFile(source, modelBytes);
        yield* writeModelSelection(home, {
          purposes: {graph: 'embeddinggemma-2-q8', recall: 'qwen3-embedding-0.6b-q8'},
          roles: {embedding: 'bge-small-en-v1.5-q8'},
          version: 1,
        });

        expect(yield* isLegacyLocalModelMigrationPending({home, manifests: [manifest]})).toBe(true);
        expect(yield* migrateLegacyLocalModels({home, manifests: [manifest]})).toEqual({
          action: 'dry_run',
          models: [manifest.id],
        });
        expect(yield* migrateLegacyLocalModels({apply: true, home, manifests: [manifest]})).toEqual({
          action: 'migrated',
          models: [manifest.id],
        });

        const target = path.join(home, 'models', 'generation', manifest.id, `${manifest.sha256}.gguf`);
        expect(Array.from(yield* fs.readFile(target))).toEqual(Array.from(modelBytes));
        expect(yield* fs.exists(source)).toBe(false);
        expect(yield* isLegacyLocalModelMigrationPending({home, manifests: [manifest]})).toBe(false);
        expect(yield* readModelSelection(home)).toEqual({
          purposes: {graph: 'embeddinggemma-2-q8', recall: 'qwen3-embedding-0.6b-q8'},
          roles: {embedding: 'bge-small-en-v1.5-q8', generation: manifest.id},
          version: 1,
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('leaves a checksum-mismatched legacy file in place', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-model-mismatch-'});
        const source = path.join(home, 'threadnote', 'models', manifest.file);
        yield* fs.makeDirectory(path.dirname(source), {recursive: true});
        yield* fs.writeFile(source, new TextEncoder().encode('same-size-but-different-contents!'));

        yield* migrateLegacyLocalModels({apply: true, home, manifests: [manifest]}).pipe(Effect.flip);
        expect(yield* fs.exists(source)).toBe(true);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('rejects a pending legacy-model symlink during eligibility and apply without touching its target', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const system = yield* SystemInfo;
        if (system.platform === 'win32') return;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-model-link-'});
        const externalRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-model-link-target-'});
        const outside = path.join(externalRoot, 'outside-model.gguf');
        const source = path.join(home, 'threadnote', 'models', manifest.file);
        yield* fs.writeFile(outside, modelBytes);
        yield* fs.makeDirectory(path.dirname(source), {recursive: true});
        yield* fs.symlink(outside, source);
        yield* fs.makeDirectory(path.join(home, 'migration'), {recursive: true});
        yield* fs.writeFileString(
          path.join(home, 'migration', 'legacy-local-model-v1.json'),
          `${JSON.stringify({id: 'legacy-local-model-v1', models: [manifest.id], status: 'pending', version: 1})}\n`,
        );

        const eligibility = yield* isLegacyLocalModelMigrationPending({home, manifests: [manifest]}).pipe(Effect.flip);
        const apply = yield* migrateLegacyLocalModels({apply: true, home, manifests: [manifest]}).pipe(Effect.flip);
        expect(String(eligibility)).toContain('must not be a symbolic link');
        expect(String(apply)).toContain('must not be a symbolic link');
        expect(Array.from(yield* fs.readFile(outside))).toEqual(Array.from(modelBytes));
        expect(yield* fs.exists(path.join(home, 'models', manifest.role, manifest.id))).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('rejects symlinked legacy-model parent directories during eligibility and apply', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const system = yield* SystemInfo;
        if (system.platform === 'win32') return;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-model-parent-links-'});
        for (const parent of ['threadnote', 'models'] as const) {
          const home = path.join(root, parent, 'home');
          const external = path.join(root, parent, 'external');
          const externalModel =
            parent === 'threadnote' ? path.join(external, 'models', manifest.file) : path.join(external, manifest.file);
          yield* fs.makeDirectory(path.dirname(externalModel), {recursive: true});
          yield* fs.writeFile(externalModel, modelBytes);
          yield* fs.makeDirectory(home, {recursive: true});
          if (parent === 'threadnote') {
            yield* fs.symlink(external, path.join(home, 'threadnote'));
          } else {
            yield* fs.makeDirectory(path.join(home, 'threadnote'), {recursive: true});
            yield* fs.symlink(external, path.join(home, 'threadnote', 'models'));
          }

          const eligibility = yield* isLegacyLocalModelMigrationPending({home, manifests: [manifest]}).pipe(
            Effect.flip,
          );
          const apply = yield* migrateLegacyLocalModels({apply: true, home, manifests: [manifest]}).pipe(Effect.flip);
          expect(String(eligibility)).toContain('must not be a symbolic link');
          expect(String(apply)).toContain('must not be a symbolic link');
          expect(Array.from(yield* fs.readFile(externalModel))).toEqual(Array.from(modelBytes));
          expect(yield* fs.exists(path.join(home, 'models', manifest.role, manifest.id))).toBe(false);
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('rejects a directory at a legacy model path during eligibility and apply', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-model-directory-'});
        const source = path.join(home, 'threadnote', 'models', manifest.file);
        yield* fs.makeDirectory(source, {recursive: true});

        const eligibility = yield* isLegacyLocalModelMigrationPending({home, manifests: [manifest]}).pipe(Effect.flip);
        const apply = yield* migrateLegacyLocalModels({apply: true, home, manifests: [manifest]}).pipe(Effect.flip);
        expect(String(eligibility)).toContain('must be a regular file');
        expect(String(apply)).toContain('must be a regular file');
        expect((yield* fs.stat(source)).type).toBe('Directory');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});
