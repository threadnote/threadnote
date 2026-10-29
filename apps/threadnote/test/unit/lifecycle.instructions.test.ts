import {Array as EffectArray, Option as EffectOption} from 'effect';
import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe} from 'vitest';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {commandShimCheck, installCommandShim, renderCommandShim} from '@threadnote/threadnote/command-shim';
import {runCommandEffect} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {runInstall} from '@threadnote/threadnote/lifecycle';
import {BUILTIN_MODEL_MANIFESTS, CORE_EMBEDDING_MODEL_ID} from '@threadnote/inference/models/builtin';
import {LocalModelStore, type LocalModelStoreShape} from '@threadnote/inference/models/store';
import type {RuntimeConfig} from '@threadnote/workspace/config';

const embeddingManifest = EffectOption.getOrUndefined(
  EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, model => model.id === CORE_EMBEDDING_MODEL_ID),
)!;

describe('agent instruction lifecycle', () => {
  it.effect(
    'core install leaves every host instruction surface untouched',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const system = yield* SystemInfo;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-instructions-'});
          const userHome = path.join(root, 'user');
          const threadnoteHome = path.join(userHome, '.threadnote');
          const config: RuntimeConfig = {
            account: 'local',
            agentContextHome: threadnoteHome,
            agentId: 'threadnote',
            manifestPath: path.join(threadnoteHome, 'seed-manifest.yaml'),
            user: 'tester',
          };
          const testSystem = SystemInfo.of({
            ...system,
            environment: () => ({...system.environment(), NVM_DIR: undefined, NVM_HOME: undefined}),
            homeDirectory: userHome,
          });
          const modelPath = path.join(threadnoteHome, 'models', 'embedding', embeddingManifest.id, 'fixture.gguf');
          const installation = {
            bytes: embeddingManifest.size,
            installed: true,
            modelId: embeddingManifest.id,
            partialBytes: 0,
            path: modelPath,
            verified: true,
          };
          const modelStore = LocalModelStore.of({
            install: () => Effect.succeed({...installation, resumed: false, sourceUrl: 'fixture://embedding'}),
            path: () => modelPath,
            remove: () => Effect.succeed(false),
            status: () => Effect.succeed(installation),
            verify: () => Effect.succeed(installation),
          } satisfies LocalModelStoreShape);
          const modelRuntime = LocalModelRuntime.of({
            diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 4}),
            embedMany: ({inputs, manifest}) =>
              Effect.succeed(
                EffectArray.map(inputs, () => [1, ...new Array<number>((manifest.dimensions ?? 1) - 1).fill(0)]),
              ),
            generate: () => Effect.die(TestError.make({message: 'Unexpected generation'})),
            rerank: () => Effect.die(TestError.make({message: 'Unexpected reranking'})),
          });
          const commandShim = path.join(userHome, '.local', 'bin', 'threadnote');
          const legacyCursorRule = path.join(userHome, '.cursor', 'rules', 'threadnote.md');
          const legacyCursorMdcRule = path.join(userHome, '.cursor', 'rules', 'threadnote.mdc');
          yield* fs.makeDirectory(path.dirname(legacyCursorRule), {recursive: true});
          const legacyCursorContent = EffectArray.join(
            [
              'Preserve this user-authored note.',
              '',
              '<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->',
              'Stale Threadnote instructions.',
              '<!-- END THREADNOTE USER INSTRUCTIONS -->',
            ],
            '\n',
          );
          const legacyCursorMdcContent = EffectArray.join(
            [
              '---',
              'alwaysApply: true',
              '---',
              '<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->',
              'Stale Threadnote instructions.',
              '<!-- END THREADNOTE USER INSTRUCTIONS -->',
            ],
            '\n',
          );
          yield* fs.writeFileString(legacyCursorRule, legacyCursorContent);
          yield* fs.writeFileString(legacyCursorMdcRule, legacyCursorMdcContent);
          if (system.platform !== 'win32') {
            yield* fs.makeDirectory(path.dirname(commandShim), {recursive: true});
            yield* fs.writeFileString(
              commandShim,
              EffectArray.join(
                [
                  '#!/usr/bin/env bash',
                  '# Generated by threadnote',
                  'THREADNOTE_ROOT=/stale/nvm/versions/node/v22.21.1/lib/node_modules/threadnote',
                ],
                '\n',
              ),
              {mode: 0o755},
            );
          }
          const installed = yield* captureConsole(runInstall(config, {printNextSteps: false, start: false})).pipe(
            Effect.provideService(SystemInfo, testSystem),
            Effect.provideService(LocalModelStore, modelStore),
            Effect.provideService(LocalModelRuntime, modelRuntime),
          );

          expect(installed.output).toContain('Building lexical recall index from canonical documents.');
          expect(installed.output).toContain(
            'Building lexical recall index: 0/0 changed document(s) indexed (100%; 0 canonical document(s) scanned).',
          );
          expect(installed.output).toContain(
            'Writing lexical recall postings: 0/0 changed document(s) (100%), 0 stale document(s) removed.',
          );
          expect(installed.output).toContain('Activating lexical recall index with 0 document(s).');
          expect(installed.output).toContain(
            `Preparing vector recall index for 0 lexical document(s) with ${embeddingManifest.id}.`,
          );
          expect(installed.output).toContain(
            'Building vector recall index: 0/0 new chunk(s) embedded (100%), 0 unchanged chunk(s) reused.',
          );
          expect(installed.output).toContain('Activating vector recall index with 0 chunk(s).');
          if (system.platform !== 'win32') {
            expect(installed.output).toContain(`Wrote command launcher: ${commandShim}`);
            const commandShimContent = yield* fs.readFileString(commandShim);
            expect(commandShimContent).not.toContain('/stale/nvm/versions/node/v22.21.1');
            expect(commandShimContent).toContain('Threadnote standalone executable is missing');
            expect((yield* commandShimCheck().pipe(Effect.provideService(SystemInfo, testSystem))).status).toBe('ok');
          }
          expect(installed.output).not.toContain('agent instructions');
          expect(yield* fs.exists(path.join(userHome, '.codex', 'AGENTS.md'))).toBe(false);
          expect(yield* fs.exists(path.join(userHome, '.claude', 'CLAUDE.md'))).toBe(false);
          expect(yield* fs.exists(path.join(userHome, '.copilot', 'instructions', 'threadnote.instructions.md'))).toBe(
            false,
          );
          expect(yield* fs.readFileString(legacyCursorRule)).toBe(legacyCursorContent);
          expect(yield* fs.readFileString(legacyCursorMdcRule)).toBe(legacyCursorMdcContent);

          if (system.platform !== 'win32') {
            const missingTargetShim = path.join(root, 'missing-target-threadnote');
            yield* fs.writeFileString(missingTargetShim, yield* renderCommandShim(path.join(root, 'missing-package')), {
              mode: 0o755,
            });
            const missingTarget = yield* runCommandEffect('/bin/bash', [missingTargetShim, 'recall'], {
              allowFailure: true,
            });
            expect(missingTarget.exitCode).toBe(127);
            expect(missingTarget.stderr).toContain('Threadnote standalone executable is missing');
            expect(missingTarget.stderr).not.toContain('Cannot find module');
          }
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    30_000,
  );

  it.effect('preserves an unmanaged launcher even when its body mentions the managed marker', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        if (system.platform === 'win32') return;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-unmanaged-shim-'});
        const binDirectory = path.join(root, 'bin');
        const commandShim = path.join(binDirectory, 'threadnote');
        const content = '#!/usr/bin/env bash\necho "Generated by threadnote is documentation, not ownership"\n';
        yield* fs.makeDirectory(binDirectory, {recursive: true});
        yield* fs.writeFileString(commandShim, content, {mode: 0o755});
        const testSystem = SystemInfo.of({
          ...system,
          environment: () => ({...system.environment(), THREADNOTE_BIN_DIR: binDirectory}),
          homeDirectory: root,
        });

        const result = yield* captureConsole(installCommandShim(false)).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );

        expect(result.output).toContain(`WARN not overwriting unmanaged command launcher: ${commandShim}`);
        expect(yield* fs.readFileString(commandShim)).toBe(content);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});
