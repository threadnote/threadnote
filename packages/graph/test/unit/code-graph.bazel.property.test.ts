import {fcEffectProp, fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import {Effect, Option} from 'effect';
import * as FC from 'fast-check';
import {extractBazelFacts} from '@threadnote/graph/languages/bazel/extractor';
import {parseBazelSyntax} from '@threadnote/graph/languages/bazel/syntax';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '@threadnote/graph/languages/registry';
import type {CodeGraphInventoryFile} from '@threadnote/graph/types';

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
  files
    .map((file, index) => ({file, index, priority: priorities[index]}))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(item => item.file),
);

describe('Bazel workspace properties', () => {
  fcProp(
    it,
    'preserves decoded literal values and UTF-16 offsets through comments and strings',
    {
      value: FC.array(FC.constantFrom('a', '🧠', '\\', '"', '\n', '\r', '\t', '\u2028', '\u2029', '#', '('), {
        maxLength: 128,
      }).map(characters => characters.join('')),
      comment: FC.array(FC.constantFrom('x', '🧠', '"', "'", '#', '(', ')'), {maxLength: 64}).map(characters =>
        characters.join(''),
      ),
    },
    ({value, comment}) => {
      const prefix = `# fake(${comment})\r\n`;
      const call = `rule(name = ${JSON.stringify(value)})`;
      const parsed = parseBazelSyntax(`${prefix}${call}`);
      expect(parsed.calls).toHaveLength(1);
      expect(parsed.calls[0]).toMatchObject({callee: 'rule', start: prefix.length, end: prefix.length + call.length});
      expect(parsed.calls[0].strings.map(literal => literal.value)).toEqual([value]);
      expect(parsed.calls[0].attributes[0].strings.map(literal => literal.value)).toEqual([value]);
    },
    {fastCheck: {numRuns: 150}},
  );

  it('preserves raw and multiline literal boundaries without treating embedded calls as code', () => {
    const source = 'rule(name = r"raw\\n", doc = """🧠\n# fake()\nline\\tend""")\nnext()';
    const parsed = parseBazelSyntax(source);
    expect(parsed.calls.map(call => call.callee)).toEqual(['rule', 'next']);
    expect(parsed.calls[0].strings.map(literal => literal.value)).toEqual(['raw\\n', '🧠\n# fake()\nline\tend']);
    expect(parsed.calls[1].start).toBe(source.indexOf('next()'));
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
        expect(actual.projects.find(project => project.name === '//libs/ui')?.dependencies).toContain(
          actual.projects.find(project => project.name === '//libs/core')?.id,
        );
        expect(actual.projects.find(project => project.name === '//')?.workspaceRoots).toEqual(
          expect.arrayContaining(['apps/isolated']),
        );
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
      const dependencies = facts.edges.filter(edge => edge.relation === 'depends_on').map(edge => edge.targetName);
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
      const typed = [
        `def ${name}(${param}: ${typeName}) -> ${typeName}:`,
        `    ${callee}(${param})`,
        `    return ${param}`,
        '',
        `${constant} = ${callee}()`,
      ].join('\n');
      const untyped = [
        `def ${name}(${param}):`,
        `    ${callee}(${param})`,
        `    return ${param}`,
        '',
        `${constant} = ${callee}()`,
      ].join('\n');

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
  const symbolsById = new Map(facts.symbols.map(symbol => [symbol.id, symbol]));
  return {
    edges: facts.edges
      .filter(edge => edge.relation !== 'contains')
      .map(edge => {
        const source = edge.sourceId === undefined ? undefined : symbolsById.get(edge.sourceId);
        const sourceKey = source?.kind === 'module' ? 'module' : (source?.name ?? edge.sourceName);
        return [edge.relation, sourceKey, edge.targetName] as const;
      })
      .sort(),
    symbols: facts.symbols
      .filter(symbol => symbol.kind !== 'module')
      .map(symbol => [symbol.kind, symbol.name] as const)
      .sort(),
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
