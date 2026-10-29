import {Array as EffectArray} from 'effect';
import {fcEffectProp, fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import {Effect, Option} from 'effect';
import * as FC from 'fast-check';
import {extractBazelFacts} from '@threadnote/graph/languages/bazel/extractor';
import {parseBazelSyntax} from '@threadnote/graph/languages/bazel/syntax';
import {resolveCodeGraphWorkspaceCatalog} from '@threadnote/graph/index_scope';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '@threadnote/graph/languages/registry';
import type {CodeGraphInventoryFile} from '@threadnote/graph/types';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const files = [
  bazelFile('MODULE.bazel', 'module(name = "root")'),
  bazelFile('libs/core/BUILD', 'java_library(name = "core")'),
  bazelFile('libs/ui/BUILD.bazel', 'kt_jvm_library(name = "ui", deps = ["//libs/core:core"])'),
  bazelFile('apps/web/BUILD', 'ts_library(name = "web", deps = ["//libs/ui:ui"])'),
  bazelFile('apps/isolated/MODULE.bazel', 'module(name = "isolated")'),
  bazelFile('apps/isolated/BUILD', 'py_library(name = "isolated", deps = ["//lib:helper"])'),
  bazelFile('apps/isolated/lib/BUILD', 'py_library(name = "helper")'),
  bazelFile('tools/BUILD', 'exports_files(["defs.bzl"])'),
  bazelFile('tools/defs.bzl', 'def project(name, deps = []):\n    native.filegroup(name = name, srcs = deps)'),
  bazelFile('.bazelrc', 'build:ci --config=remote'),
] as const;

const permutedFiles = FC.array(FC.integer({max: 10_000, min: -10_000}), {
  maxLength: files.length,
  minLength: files.length,
}).map(priorities =>
  EffectArray.map(
    EffectArray.map(files, (file, index) => ({file, index, priority: priorities[index]})).sort(
      (left, right) => left.priority - right.priority || left.index - right.index,
    ),
    item => item.file,
  ),
);

describe('Bazel workspace properties', () => {
  it.effect('reuses immutable workspace declarations without caching source observations or caller mutations', () =>
    Effect.gen(function* () {
      let discoveries = 0;
      const registry = {
        ...BUILTIN_LANGUAGE_PACK_REGISTRY,
        discoverWorkspace: (input: readonly CodeGraphInventoryFile[]) =>
          Effect.suspend(() => {
            discoveries += 1;
            return BUILTIN_LANGUAGE_PACK_REGISTRY.discoverWorkspace(input);
          }),
      };
      const first = yield* resolveCodeGraphWorkspaceCatalog(files, registry);
      const expected = structuredClone(first);
      expect(
        Reflect.set(first.resolutionContextPaths, String(first.resolutionContextPaths.length), 'caller-mutation'),
      ).toBe(true);
      const second = yield* resolveCodeGraphWorkspaceCatalog([...files].reverse(), registry);
      expect(second).toEqual(expected);
      expect(discoveries).toBe(1);
      const changed = EffectArray.map(files, file =>
        file.path === 'libs/ui/BUILD.bazel'
          ? {...file, blobId: 'changed', contentHash: 'changed', content: 'kt_jvm_library(name="ui")'}
          : file,
      );
      const fresh = yield* resolveCodeGraphWorkspaceCatalog(changed, registry);
      expect(fresh.workspace).toEqual(yield* BUILTIN_LANGUAGE_PACK_REGISTRY.discoverWorkspace(changed));
      expect(discoveries).toBe(2);
    }),
  );

  fcEffectProp(
    it,
    'keeps cached workspace results equivalent to fresh discovery across input changes and registry boundaries',
    {slots: FC.array(FC.integer({min: 0, max: 12}), {minLength: 2, maxLength: 24})},
    ({slots}) =>
      Effect.gen(function* () {
        const registries = EffectArray.map(['one', 'two'], name => ({
          ...BUILTIN_LANGUAGE_PACK_REGISTRY,
          discoverWorkspace: (input: readonly CodeGraphInventoryFile[]) =>
            BUILTIN_LANGUAGE_PACK_REGISTRY.discoverWorkspace(input).pipe(
              Effect.map(workspace => ({...workspace, fingerprint: `${name}:${workspace.fingerprint}`})),
            ),
        }));
        for (const slot of slots) {
          const content = JSON.stringify({name: `package-${slot}`});
          const input = [
            {
              ...bazelFile('package.json', content),
              blobId: sha256HexSync(content),
              contentHash: sha256HexSync(content),
            },
          ];
          for (const registry of registries) {
            const actual = yield* resolveCodeGraphWorkspaceCatalog(input, registry);
            expect(actual.workspace).toEqual(yield* registry.discoverWorkspace(input));
          }
        }
      }),
    {fastCheck: {numRuns: 24}},
  );

  it.effect('evicts old catalogs and declines oversized serialized results', () =>
    Effect.gen(function* () {
      let discoveries = 0;
      const registry = {
        ...BUILTIN_LANGUAGE_PACK_REGISTRY,
        discoverWorkspace: (input: readonly CodeGraphInventoryFile[]) =>
          Effect.suspend(() => {
            discoveries += 1;
            return BUILTIN_LANGUAGE_PACK_REGISTRY.discoverWorkspace(input);
          }),
      };
      const inputs = Array.from({length: 9}, (_, index) => [
        {...files[0], blobId: String(index), contentHash: String(index)},
      ]);
      for (const input of inputs) yield* resolveCodeGraphWorkspaceCatalog(input, registry);
      yield* resolveCodeGraphWorkspaceCatalog(inputs[0], registry);
      expect(discoveries).toBe(10);
      let oversizedDiscoveries = 0;
      const oversized = {
        ...registry,
        discoverWorkspace: () => {
          oversizedDiscoveries += 1;
          return Effect.succeed({
            diagnostics: [Effect2.pipe('x', EffectString.repeat(2_097_152))],
            fingerprint: 'large',
            projects: [],
            workspaces: [],
          });
        },
      };
      yield* resolveCodeGraphWorkspaceCatalog([], oversized);
      yield* resolveCodeGraphWorkspaceCatalog([], oversized);
      expect(oversizedDiscoveries).toBe(2);
    }),
  );

  fcProp(
    it,
    'preserves decoded literal values and UTF-16 offsets through comments and strings',
    {
      value: FC.array(FC.constantFrom('a', '🧠', '\\', '"', '\n', '\r', '\t', '\u2028', '\u2029', '#', '('), {
        maxLength: 128,
      }).map(characters => EffectArray.join(characters, '')),
      comment: FC.array(FC.constantFrom('x', '🧠', '"', "'", '#', '(', ')'), {maxLength: 64}).map(characters =>
        EffectArray.join(characters, ''),
      ),
    },
    ({value, comment}) => {
      const prefix = `# fake(${comment})\r\n`;
      const call = `rule(name = ${JSON.stringify(value)})`;
      const parsed = parseBazelSyntax(`${prefix}${call}`);
      expect(parsed.calls).toHaveLength(1);
      expect(parsed.calls[0]).toMatchObject({callee: 'rule', start: prefix.length, end: prefix.length + call.length});
      expect(EffectArray.map(parsed.calls[0].strings, literal => literal.value)).toEqual([value]);
      expect(EffectArray.map(parsed.calls[0].attributes[0].strings, literal => literal.value)).toEqual([value]);
    },
    {fastCheck: {numRuns: 150}},
  );

  it('preserves raw and multiline literal boundaries without treating embedded calls as code', () => {
    const source = 'rule(name = r"raw\\n", doc = """🧠\n# fake()\nline\\tend""")\nnext()';
    const parsed = parseBazelSyntax(source);
    expect(EffectArray.map(parsed.calls, call => call.callee)).toEqual(['rule', 'next']);
    expect(EffectArray.map(parsed.calls[0].strings, literal => literal.value)).toEqual([
      'raw\\n',
      '🧠\n# fake()\nline\tend',
    ]);
    expect(parsed.calls[1].start).toBe(
      Effect2.pipe(
        source,
        EffectString.indexOf('next()'),
        Effect2.Option.getOrElse(() => -1),
      ),
    );
  });

  fcEffectProp(
    it,
    'keeps nested workspace ownership and target dependencies deterministic across inventory permutations',
    {permuted: permutedFiles},
    ({permuted}) =>
      Effect.gen(function* () {
        const expected = yield* BUILTIN_LANGUAGE_PACK_REGISTRY.discoverWorkspace(files);
        const actual = yield* BUILTIN_LANGUAGE_PACK_REGISTRY.discoverWorkspace(permuted);

        expect(actual).toEqual(expected);
        expect(
          Option.getOrUndefined(EffectArray.findFirst(actual.projects, project => project.name === '//libs/ui'))
            ?.dependencies,
        ).toContain(
          Option.getOrUndefined(EffectArray.findFirst(actual.projects, project => project.name === '//libs/core'))?.id,
        );
        expect(
          Option.getOrUndefined(EffectArray.findFirst(actual.projects, project => project.name === '//'))
            ?.workspaceRoots,
        ).toEqual(expect.arrayContaining(['apps/isolated']));
      }),
    {fastCheck: {numRuns: 150}},
  );

  fcProp(
    it,
    'recognizes canonical Bazel labels without accepting arbitrary source strings as graph dependencies',
    {
      packagePath: FC.constantFrom('', 'apps/web', 'libs/core/deep'),
      target: FC.stringMatching(/^[A-Za-z_][A-Za-z0-9_.-]{0,20}$/),
    },
    ({packagePath, target}) => {
      const local = `:${target}`;
      const absolute = `//${packagePath}:${target}`;
      const build = bazelFile(
        'BUILD',
        `filegroup(name = "owner", deps = ["${local}", "${absolute}", "plain.txt", "//../escape:target"])`,
      );

      const facts = extractBazelFacts(build, {packageName: Option.none(), project: Option.none()});
      const dependencies = EffectArray.map(
        EffectArray.filter(facts.edges, edge => edge.relation === 'depends_on'),
        edge => edge.targetName,
      );
      expect(dependencies).toContain(`//:${target}`);
      expect(dependencies).toContain(absolute);
      expect(dependencies).not.toContain('plain.txt');
      expect(dependencies).not.toContain('//../escape:target');
    },
    {fastCheck: {numRuns: 100}},
  );

  fcProp(
    it,
    'extracts equivalent Starlark structure from .axl and .bzl when typed annotations are stripped',
    {
      name: FC.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,12}$/),
      param: FC.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,8}$/),
      typeName: FC.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,10}$/),
      constant: FC.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,10}$/),
      callee: FC.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,10}$/),
    },
    ({name, param, typeName, constant, callee}) => {
      const typed = EffectArray.join(
        [
          `def ${name}(${param}: ${typeName}) -> ${typeName}:`,
          `    ${callee}(${param})`,
          `    return ${param}`,
          '',
          `${constant} = ${callee}()`,
        ],
        '\n',
      );
      const untyped = EffectArray.join(
        [`def ${name}(${param}):`, `    ${callee}(${param})`, `    return ${param}`, '', `${constant} = ${callee}()`],
        '\n',
      );

      const axl = extractBazelFacts(bazelFile(`lib/${name}.axl`, typed), {
        packageName: Option.none(),
        project: Option.none(),
      });
      const bzl = extractBazelFacts(bazelFile(`lib/${name}.bzl`, untyped), {
        packageName: Option.none(),
        project: Option.none(),
      });

      expect(normalizeStarlarkShape(axl)).toEqual(normalizeStarlarkShape(bzl));
    },
    {fastCheck: {numRuns: 100}},
  );
});

function normalizeStarlarkShape(facts: ReturnType<typeof extractBazelFacts>) {
  const symbolsById = new Map(EffectArray.map(facts.symbols, symbol => [symbol.id, symbol]));
  return {
    edges: EffectArray.map(
      EffectArray.filter(facts.edges, edge => edge.relation !== 'contains'),
      edge => {
        const source = edge.sourceId === undefined ? undefined : symbolsById.get(edge.sourceId);
        const sourceKey = source?.kind === 'module' ? 'module' : (source?.name ?? edge.sourceName);
        return [edge.relation, sourceKey, edge.targetName] as const;
      },
    ).sort(),
    symbols: EffectArray.map(
      EffectArray.filter(facts.symbols, symbol => symbol.kind !== 'module'),
      symbol => [symbol.kind, symbol.name] as const,
    ).sort(),
  };
}

function bazelFile(path: string, content: string): CodeGraphInventoryFile {
  return {
    blobId: `blob:${path}`,
    content,
    contentHash: `hash:${path}:${content.length}`,
    language: Option.getOrThrow(BUILTIN_LANGUAGE_PACK_REGISTRY.match(path)).language,
    mode: '100644',
    path,
    size: new TextEncoder().encode(content).byteLength,
    source: 'commit',
  };
}
