import {Array as EffectArray} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {it as effectIt} from '@effect/vitest';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, Option} from 'effect';
import {describe, expect, it} from 'vitest';
import {createRepositoryFactResolver} from '@threadnote/graph/extractor';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '@threadnote/graph/languages/registry';
import {TreeSitterRuntime} from '@threadnote/graph/tree_sitter/runtime';
import type {CodeGraphFileFacts, CodeGraphInventoryFile} from '@threadnote/graph/types';
import {createWorkspaceAttributor} from '@threadnote/graph/workspace';

describe('Bazel/Starlark code graph language pack', () => {
  it('recognizes Bazel workspace, package, Starlark, and rc files without claiming ordinary Bazel-named files', () => {
    const expected = new Map([
      ['WORKSPACE', 'bazel-workspace'],
      ['nested/WORKSPACE.bazel', 'bazel-workspace'],
      ['MODULE.bazel', 'bazel-module'],
      ['app/BUILD', 'bazel-build'],
      ['app/BUILD.bazel', 'bazel-build'],
      ['tools/defs.bzl', 'starlark'],
      ['.aspect/format.axl', 'starlark'],
      ['config/ci.bazelrc', 'bazelrc'],
    ]);
    for (const [path, language] of expected) {
      expect(BUILTIN_LANGUAGE_PACK_REGISTRY.match(path), path).toMatchObject({_tag: 'Some', value: {language}});
    }
    expect(BUILTIN_LANGUAGE_PACK_REGISTRY.match('src/build.ts')).toMatchObject({
      _tag: 'Some',
      value: {language: 'typescript'},
    });
  });

  effectIt.effect('extracts typed AXL Starlark defs, loads, assignments, and calls like .bzl sources', () =>
    Effect.gen(function* () {
      const facts = yield* runExtraction(
        bazelFile(
          '.aspect/mycmd.axl',
          EffectArray.join(
            [
              'load("//tools:defs.bzl", "helper")',
              '',
              'def impl(ctx: TaskContext) -> int:',
              '    helper()',
              '    return 0',
              '',
              'mycmd = task(',
              '    implementation = impl,',
              '    args = {',
              '        "target_pattern": args.positional(default = ["..."]),',
              '    },',
              ')',
            ],
            '\n',
          ),
        ),
        [],
      );

      expect(EffectArray.map(facts.symbols, symbol => [symbol.kind, symbol.qualifiedName])).toEqual(
        expect.arrayContaining([
          ['function', '//.aspect:mycmd.axl%impl'],
          ['constant', '//.aspect:mycmd.axl%mycmd'],
        ]),
      );
      expect(EffectArray.map(facts.edges, edge => [edge.relation, edge.targetName])).toEqual(
        expect.arrayContaining([
          ['imports', '//tools:defs.bzl'],
          ['calls', 'helper'],
          ['calls', 'task'],
          ['calls', 'args.positional'],
        ]),
      );
    }),
  );

  effectIt.effect(
    'extracts and resolves Starlark loads, calls, targets, local deps, cross-package deps, and external labels',
    () =>
      Effect.gen(function* () {
        const files = [
          bazelFile('MODULE.bazel', 'module(name = "commerce")'),
          bazelFile('tools/BUILD.bazel', 'exports_files(["defs.bzl"])'),
          bazelFile(
            'tools/defs.bzl',
            `
          def app_rule(name, deps = []):
              native.ts_library(name = name, deps = deps)

          def helper():
              print("ready")
        `,
          ),
          bazelFile('libs/core/BUILD', 'ts_library(name = "core", srcs = ["core.ts"])'),
          bazelFile(
            'apps/api/BUILD.bazel',
            `
          load("//tools:defs.bzl", "app_rule")

          genrule(
              name = "generated",
              outs = ["generated.ts"],
              cmd = "touch $@",
          )

          app_rule(
              name = "api",
              deps = [
                  ":generated",
                  "//libs/core:core",
                  "@rules_ts//ts:toolchain",
              ],
          )
        `,
          ),
        ];
        const workspace = yield* BUILTIN_LANGUAGE_PACK_REGISTRY.discoverWorkspace(files);
        const extracted = yield* Effect.forEach(files, file => runExtraction(file, workspace.projects), {
          concurrency: 'unbounded',
        });
        const attributed = createWorkspaceAttributor(workspace)(extracted);
        const resolved = createRepositoryFactResolver(attributed, files).resolve(attributed);
        const build = Option.getOrUndefined(
          EffectArray.findFirst(resolved, file => file.path === 'apps/api/BUILD.bazel'),
        )!;
        const definitions = Option.getOrUndefined(
          EffectArray.findFirst(resolved, file => file.path === 'tools/defs.bzl'),
        )!;
        const core = Option.getOrUndefined(
          EffectArray.findFirst(
            Option.getOrUndefined(EffectArray.findFirst(resolved, file => file.path === 'libs/core/BUILD'))!.symbols,
            symbol => symbol.qualifiedName === '//libs/core:core',
          ),
        )!;
        const generated = Option.getOrUndefined(
          EffectArray.findFirst(build.symbols, symbol => symbol.qualifiedName === '//apps/api:generated'),
        )!;
        const appRule = Option.getOrUndefined(
          EffectArray.findFirst(definitions.symbols, symbol => symbol.qualifiedName === '//tools:defs.bzl%app_rule'),
        )!;
        const api = Option.getOrUndefined(
          EffectArray.findFirst(build.symbols, symbol => symbol.qualifiedName === '//apps/api:api'),
        )!;

        expect(EffectArray.map(build.symbols, symbol => [symbol.kind, symbol.qualifiedName])).toEqual(
          expect.arrayContaining([
            ['target', '//apps/api:generated'],
            ['target', '//apps/api:api'],
          ]),
        );
        expect(EffectArray.map(definitions.symbols, symbol => [symbol.kind, symbol.qualifiedName])).toEqual(
          expect.arrayContaining([
            ['function', '//tools:defs.bzl%app_rule'],
            ['function', '//tools:defs.bzl%helper'],
          ]),
        );
        expect(build.edges).toContainEqual(
          expect.objectContaining({relation: 'depends_on', sourceId: api.id, targetId: generated.id}),
        );
        expect(build.edges).toContainEqual(
          expect.objectContaining({relation: 'depends_on', sourceId: api.id, targetId: core.id}),
        );
        expect(build.edges).toContainEqual(
          expect.objectContaining({relation: 'calls', sourceId: api.id, targetId: appRule.id}),
        );
        expect(build.edges).toContainEqual(
          expect.objectContaining({
            provenance: 'declared',
            relation: 'depends_on',
            sourceId: api.id,
            targetName: '@rules_ts//ts:toolchain',
          }),
        );
        expect(
          Option.getOrUndefined(
            EffectArray.findFirst(
              build.edges,
              edge =>
                edge.sourceId === api.id &&
                edge.targetName === '@rules_ts//ts:toolchain' &&
                edge.relation === 'depends_on',
            ),
          )?.targetId,
        ).toBeUndefined();
      }),
  );

  effectIt.effect(
    'merges colocated Node and Bazel components while retaining Bazel attribution and isolated roots',
    () =>
      Effect.gen(function* () {
        const files = [
          bazelFile(
            'package.json',
            JSON.stringify({name: '@acme/root', workspaces: ['apps/*', 'packages/*']}),
            'npm-manifest',
          ),
          bazelFile('apps/mobile/package.json', JSON.stringify({name: '@acme/mobile'}), 'npm-manifest'),
          bazelFile('apps/mobile/MODULE.bazel', 'module(name = "mobile")'),
          bazelFile('apps/mobile/BUILD.bazel', 'kt_jvm_library(name = "mobile", srcs = ["src/main/kotlin/App.kt"])'),
          bazelFile('apps/mobile/vendor/tool/MODULE.bazel', 'module(name = "vendor_tool")'),
          bazelFile('apps/mobile/vendor/tool/BUILD', 'java_library(name = "tool", srcs = ["Tool.java"])'),
          bazelFile('packages/shared/BUILD', 'ts_library(name = "shared", srcs = ["index.ts"])'),
        ];
        const workspace = yield* BUILTIN_LANGUAGE_PACK_REGISTRY.discoverWorkspace(files);
        const mobile = Option.getOrUndefined(
          EffectArray.findFirst(workspace.projects, project => project.root === 'apps/mobile'),
        )!;
        const nestedBazel = Option.getOrUndefined(
          EffectArray.findFirst(
            workspace.projects,
            project => project.root === 'apps/mobile/vendor/tool' && project.resolutionDomain === 'bazel',
          ),
        )!;
        const integratedBazel = Option.getOrUndefined(
          EffectArray.findFirst(
            workspace.projects,
            project => project.root === 'packages/shared' && project.resolutionDomain === 'bazel',
          ),
        )!;

        expect(EffectArray.filter(workspace.projects, project => project.root === 'apps/mobile')).toHaveLength(1);
        expect(mobile).toMatchObject({
          buildSystem: 'node',
          name: '@acme/mobile',
          resolutionDomain: 'typescript',
        });
        expect(mobile.languages).toEqual(expect.arrayContaining(['bazel', 'starlark', 'typescript']));
        expect(mobile.workspaceRoots).toEqual(['', 'apps/mobile']);
        expect(nestedBazel.workspaceRoots).toEqual(['apps/mobile/vendor/tool']);
        expect(integratedBazel.workspaceRoots).toEqual(['']);
        expect(new Set([mobile.id, nestedBazel.id, integratedBazel.id]).size).toBe(3);
        expect(workspace.workspaces).toEqual(
          expect.arrayContaining([
            expect.objectContaining({buildSystem: 'bazel', root: ''}),
            expect.objectContaining({buildSystem: 'bazel', root: 'apps/mobile/vendor/tool'}),
            expect.objectContaining({buildSystem: 'node', root: ''}),
          ]),
        );

        const mobileBuild = Option.getOrUndefined(
          EffectArray.findFirst(files, file => file.path === 'apps/mobile/BUILD.bazel'),
        )!;
        const extracted = yield* runExtraction(mobileBuild, workspace.projects);
        const [attributed] = createWorkspaceAttributor(workspace)([extracted]);
        expect(
          Option.getOrUndefined(
            EffectArray.findFirst(attributed.symbols, symbol => symbol.kind === 'target' && symbol.name === 'mobile'),
          ),
        ).toMatchObject({
          packageName: '@acme/mobile',
          resolutionDomain: 'bazel',
          resolutionScopeId: mobile.id,
        });
      }),
  );

  effectIt.effect('indexes .bazelrc configuration inheritance and imports as declared relationships', () =>
    Effect.gen(function* () {
      const facts = yield* runExtraction(
        bazelFile(
          '.bazelrc',
          `
          import %workspace%/config/common.bazelrc
          build:ci --config=remote --remote_cache=https://cache.invalid
          build:remote --remote_executor=grpc://executor.invalid
        `,
        ),
        [],
      );

      expect(EffectArray.map(facts.symbols, symbol => [symbol.kind, symbol.name])).toEqual(
        expect.arrayContaining([
          ['config', 'build:ci'],
          ['config', 'build:remote'],
        ]),
      );
      expect(EffectArray.map(facts.edges, edge => [edge.relation, edge.targetName])).toEqual(
        expect.arrayContaining([
          ['imports', '%workspace%/config/common.bazelrc'],
          ['configures', 'remote'],
        ]),
      );
    }),
  );
});

function runExtraction(
  file: CodeGraphInventoryFile,
  projects: Parameters<typeof BUILTIN_LANGUAGE_PACK_REGISTRY.extractFile>[1],
): Effect.Effect<CodeGraphFileFacts, unknown> {
  return BUILTIN_LANGUAGE_PACK_REGISTRY.extractFile(file, projects).pipe(
    provideTestLayer(TreeSitterRuntime.layer),
    provideTestLayer(TestSystemInfoLayer),
    provideTestLayer(BunServices.layer),
  );
}

function bazelFile(path: string, content: string, language?: string): CodeGraphInventoryFile {
  const matched = BUILTIN_LANGUAGE_PACK_REGISTRY.match(path);
  return {
    blobId: `blob:${path}`,
    content,
    contentHash: `hash:${path}:${content.length}`,
    language: language ?? Option.getOrThrow(matched).language,
    mode: '100644',
    path,
    size: new TextEncoder().encode(content).byteLength,
    source: 'commit',
  };
}
