import {Array as EffectArray, Option as EffectOption} from 'effect';
import {describe, expect, it} from 'vitest';
import {
  acceptsRepositoryPath,
  codeGraphCatFileBatches,
  codeGraphInventoryExclusionReason,
  parseGitTree,
  parseNameStatus,
  shouldOmitRepositoryContent,
  summarizeCodeGraphInventoryPreview,
} from '@threadnote/graph/inventory';
import {
  CODE_GRAPH_GENERIC_JSON_EXCLUSION_BYTES,
  CODE_GRAPH_HIGH_SIGNAL_JSON_HARD_CAP_BYTES,
} from '@threadnote/graph/inventory/policy';
import {CORPUS_EXTRACTION_SOURCE_BYTES_LIMIT} from '@threadnote/graph/languages/corpus/policy';

describe('native code graph inventory policy', () => {
  it('packs up to 512 small blobs into one Git cat-file process without weakening the byte ceiling', () => {
    const entries = Array.from({length: 513}, (_, index) => ({index, size: 1}));
    expect(EffectArray.map(codeGraphCatFileBatches(entries.slice(0, 512)), batch => batch.length)).toEqual([512]);
    expect(EffectArray.map(codeGraphCatFileBatches(entries), batch => batch.length)).toEqual([512, 1]);
    expect(
      EffectArray.map(codeGraphCatFileBatches([{size: 16 * 1_048_576}, {size: 1}]), batch => batch.length),
    ).toEqual([1, 1]);
  });

  it('excludes SVG and low-meaning JSON at the reviewed pre-hydration boundaries', () => {
    for (const path of ['icons/logo.svg', 'icons/LOGO.SVG', './icons/logo.SvG']) {
      expect(codeGraphInventoryExclusionReason(path, 0), path).toBe('svg');
      expect(codeGraphInventoryExclusionReason(path, Number.MAX_SAFE_INTEGER), path).toBe('svg');
    }

    for (const path of [
      'test/__snapshots__/tiny.json',
      'test/__fixtures__/tiny.json',
      'test/_fixtures_/tiny.JSONC',
      'fixtures/tiny.JSONC',
      'assets/animations/loading.json',
      'configs/fixtures/runtime-config.json',
      'SCHEMAS/__SNAPSHOTS__/PROJECT.JSON',
      'assets/application.min.jsonc',
      'generated/package.json',
      'config/gen/runtime-config.JSON',
      'data/payload.generated.json',
    ]) {
      expect(codeGraphInventoryExclusionReason(path, 1), path).toBe('low-signal-json');
    }

    for (const path of ['data/events.json', 'assets/application.JSONC']) {
      expect(
        codeGraphInventoryExclusionReason(path, CODE_GRAPH_GENERIC_JSON_EXCLUSION_BYTES - 1),
        path,
      ).toBeUndefined();
      expect(codeGraphInventoryExclusionReason(path, CODE_GRAPH_GENERIC_JSON_EXCLUSION_BYTES), path).toBe(
        'generic-json-size',
      );
    }

    for (const path of [
      'package.json',
      'apps/mobile/tsconfig.build.json',
      'apps/mobile/project.json',
      'nx.json',
      'config/runtime.json',
    ]) {
      expect(codeGraphInventoryExclusionReason(path, CODE_GRAPH_GENERIC_JSON_EXCLUSION_BYTES), path).toBeUndefined();
      expect(
        codeGraphInventoryExclusionReason(path, CODE_GRAPH_HIGH_SIGNAL_JSON_HARD_CAP_BYTES - 1),
        path,
      ).toBeUndefined();
      expect(codeGraphInventoryExclusionReason(path, CODE_GRAPH_HIGH_SIGNAL_JSON_HARD_CAP_BYTES), path).toBe(
        'high-signal-json-hard-cap',
      );
    }

    expect(codeGraphInventoryExclusionReason('data/events.yaml', Number.MAX_SAFE_INTEGER)).toBeUndefined();
    expect(codeGraphInventoryExclusionReason('data/small.json', 1)).toBeUndefined();
    expect(codeGraphInventoryExclusionReason('src/application.ts', Number.MAX_SAFE_INTEGER)).toBeUndefined();
  });

  it('prunes every hidden, generated, vendor, and explicitly ignored directory before blob reads', () => {
    const ignore = 'fixtures/**\n!fixtures/keep.ts\n';

    expect(acceptsRepositoryPath('src/index.ts', ignore)).toBe(true);
    expect(acceptsRepositoryPath('.nx/cache/project.ts', ignore)).toBe(false);
    expect(acceptsRepositoryPath('packages/.cache/result.ts', ignore)).toBe(false);
    expect(acceptsRepositoryPath('.aspect/mycmd.axl', ignore)).toBe(true);
    expect(acceptsRepositoryPath('packages/app/node_modules/library/index.ts', ignore)).toBe(false);
    expect(acceptsRepositoryPath('dist/generated.ts', ignore)).toBe(false);
    expect(acceptsRepositoryPath('graphify-out/graph.json', ignore)).toBe(false);
    expect(acceptsRepositoryPath('fixtures/drop.ts', ignore)).toBe(false);
    expect(acceptsRepositoryPath('fixtures/keep.ts', ignore)).toBe(true);
    expect(acceptsRepositoryPath('../outside.ts', ignore)).toBe(false);
  });

  it('lets manifest-declared modules override only their matching broad prune prefix', () => {
    expect(acceptsRepositoryPath('pods/src/main/kotlin/Service.kt')).toBe(false);
    expect(acceptsRepositoryPath('pods/src/main/kotlin/Service.kt', '', ['pods'])).toBe(true);
    expect(acceptsRepositoryPath('apps/pods/src/main/java/Service.java', '', ['apps/pods'])).toBe(true);
    expect(
      acceptsRepositoryPath(
        'apps/pods/src/main/java/io/coda/pods/Service.java',
        '',
        ['apps/pods'],
        ['apps/pods/src/main/java'],
      ),
    ).toBe(true);
    expect(acceptsRepositoryPath('pods/build/generated/Generated.kt', '', ['pods'])).toBe(false);
    expect(acceptsRepositoryPath('pods/src/main/kotlin/Service.kt', 'pods/**', ['pods'])).toBe(false);
    expect(acceptsRepositoryPath('Pods/Headers/Generated.h')).toBe(false);
  });

  it('does not let broad package source roots re-include nested build output', () => {
    for (const directory of [
      'bazel-bin',
      'bazel-out',
      'bazel-testlogs',
      'bazel-workspace',
      'build',
      'dist',
      'graphify-out',
      'out',
    ]) {
      expect(
        acceptsRepositoryPath(`packages/app/${directory}/generated.js`, '', ['packages/app'], ['packages/app']),
        directory,
      ).toBe(false);
    }

    expect(acceptsRepositoryPath('packages/app/dist/source.ts', '', ['packages/app'], ['packages/app/dist'])).toBe(
      true,
    );
    expect(
      acceptsRepositoryPath(
        'packages/app/dist/source.ts',
        'packages/app/dist/**',
        ['packages/app'],
        ['packages/app/dist'],
      ),
    ).toBe(false);
  });

  it('accepts only ordinary blob records and handles byte-safe rename/delete overlays', () => {
    const tree = EffectArray.join(
      [
        '100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 42\tsrc/a.ts',
        '120000 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 12\tsrc/link.ts',
        '160000 commit cccccccccccccccccccccccccccccccccccccccc -\tvendor/submodule',
        '',
      ],
      '\0',
    );
    expect(parseGitTree(tree)).toEqual([
      {
        blobId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        mode: '100644',
        path: 'src/a.ts',
        size: 42,
      },
    ]);

    const status = parseNameStatus(
      EffectArray.join(
        ['R100', 'src/old.ts', 'src/new.ts', 'D', 'src/deleted.ts', 'M', 'src/a.ts', 'A', 'src/added.ts', ''],
        '\0',
      ),
    );
    expect([...status.added].sort()).toEqual(['src/added.ts', 'src/new.ts']);
    expect([...status.changed].sort()).toEqual(['src/a.ts', 'src/added.ts', 'src/new.ts']);
    expect([...status.deleted].sort()).toEqual(['src/deleted.ts', 'src/old.ts']);
  });

  it('preserves literal POSIX backslashes instead of collapsing distinct Git paths', () => {
    const tree = EffectArray.join(
      [
        '100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 42\tsrc/a.ts',
        '100644 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 43\tsrc\\\\a.ts',
        '',
      ],
      '\0',
    );

    expect(EffectArray.map(parseGitTree(tree), entry => entry.path)).toEqual(['src/a.ts', 'src\\\\a.ts']);
    expect(parseNameStatus(EffectArray.join(['M', 'src\\\\a.ts', ''], '\0')).changed).toEqual(new Set(['src\\\\a.ts']));
  });

  it('does not reject eligible source paths based on individual file size', () => {
    expect(acceptsRepositoryPath('src/generated-but-tracked.ts')).toBe(true);
    expect(acceptsRepositoryPath('src/a.ts', 'src/a.ts')).toBe(false);
    expect(acceptsRepositoryPath('src/b.ts', '', [], [], 'src/b.ts')).toBe(false);
    expect(acceptsRepositoryPath('src/c.ts', 'src/a.ts', [], [], 'src/b.ts')).toBe(true);
    expect(acceptsRepositoryPath('src/a.ts', 'src/a.ts', [], [], '!src/a.ts')).toBe(false);
    expect(shouldOmitRepositoryContent('src/generated-but-tracked.ts', Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(shouldOmitRepositoryContent('recordings/architecture.mp4', CORPUS_EXTRACTION_SOURCE_BYTES_LIMIT + 1)).toBe(
      true,
    );
  });

  it('keeps binary media metadata-only without loading its blob', () => {
    for (const path of ['assets/photo.png', 'recordings/demo.mp4', 'audio/incident.mp3']) {
      expect(shouldOmitRepositoryContent(path, 32), path).toBe(true);
    }
    expect(shouldOmitRepositoryContent('docs/architecture.pdf', 32)).toBe(false);
    expect(shouldOmitRepositoryContent('diagrams/architecture.svg', 32)).toBe(false);
  });

  it('does not hydrate low-signal structured test data', () => {
    for (const path of [
      'test/__snapshots__/screen.json',
      'tests/golden/render.yaml',
      'models-document/test/golden-data/example/v1/checksum_info.json',
      'models-document/test/golden_data/example/v1/checksum_info.json',
      'fixtures/events.jsonc',
      'assets/animations/loading.json',
    ]) {
      expect(shouldOmitRepositoryContent(path, 25 * 1_024 * 1_024), path).toBe(true);
    }
    expect(
      shouldOmitRepositoryContent(
        'models-document/test/golden-database/example/v1/checksum_info.json',
        25 * 1_024 * 1_024,
      ),
    ).toBe(false);
    expect(shouldOmitRepositoryContent('config/runtime.json', 25 * 1_024 * 1_024)).toBe(false);
    expect(shouldOmitRepositoryContent('schemas/events.yaml', 25 * 1_024 * 1_024)).toBe(false);
  });

  it('accepts every bundled language and workspace manifest through the generated registry', () => {
    for (const path of [
      'src/service.ts',
      'src/service.tsx',
      'src/service.java',
      'src/service.kt',
      'Sources/App/Service.swift',
      'pom.xml',
      'settings.gradle.kts',
      'apps/mobile/build.gradle',
      'Package.swift',
      'App.xcodeproj/project.pbxproj',
    ]) {
      expect(acceptsRepositoryPath(path), path).toBe(true);
    }
    expect(acceptsRepositoryPath('src/readme.txt')).toBe(true);
    expect(acceptsRepositoryPath('src/archive.bin')).toBe(false);
  });

  it('explains eligible and skipped bytes without repository paths', () => {
    const entries = [
      {path: 'src/active.ts', size: 10},
      {path: 'package.json', size: 20},
      {path: 'apps/mobile/project.json', size: 30},
      {path: 'tsconfig.json', size: 40},
      {path: 'assets/icon.svg', size: 50},
      {path: 'test/__fixtures__/payload.json', size: 60},
      {path: 'data/heavy.json', size: CODE_GRAPH_GENERIC_JSON_EXCLUSION_BYTES},
      {path: 'src/ignored.ts', size: 70},
      {path: 'dist/generated.ts', size: 80},
      {path: 'artifact.bin', size: 90},
    ] as const;

    const preview = summarizeCodeGraphInventoryPreview(entries, {threadnoteIgnore: 'src/ignored.ts\n'});
    const group = (reason: string, language: string) =>
      EffectOption.getOrUndefined(
        EffectArray.findFirst(
          preview.groups,
          candidate => candidate.reason === reason && candidate.language === language,
        ),
      );

    expect(preview.totals).toEqual({
      eligible: {bytes: 100, files: 4},
      repository: {
        bytes: EffectArray.reduce(entries, 0, (total, entry) => total + entry.size),
        files: entries.length,
      },
      skipped: {
        bytes: EffectArray.reduce(entries, 0, (total, entry) => total + entry.size) - 100,
        files: 6,
      },
    });
    expect(group('admitted', 'typescript')).toMatchObject({
      classifier: 'typescript',
      disposition: 'eligible',
      role: 'source',
    });
    expect(group('admitted', 'npm-manifest')).toMatchObject({
      classifier: 'manifests',
      disposition: 'eligible',
      role: 'manifest',
    });
    expect(group('admitted', 'typescript-config')).toMatchObject({
      classifier: 'manifests',
      disposition: 'eligible',
      role: 'workspace',
    });
    expect(group('admitted', 'json')).toMatchObject({classifier: 'schemas', disposition: 'eligible'});
    expect(group('svg', 'document')).toMatchObject({classifier: 'corpus', disposition: 'skipped'});
    expect(group('low-signal-json', 'json')).toMatchObject({classifier: 'schemas', disposition: 'skipped'});
    expect(group('generic-json-size', 'json')).toMatchObject({classifier: 'schemas', disposition: 'skipped'});
    expect(group('threadnote-ignore', 'typescript')).toMatchObject({
      classifier: 'typescript',
      disposition: 'skipped',
    });
    expect(group('generated-directory', 'typescript')).toMatchObject({disposition: 'skipped'});
    expect(group('unsupported-language', 'unmatched')).toMatchObject({
      classifier: 'unmatched',
      disposition: 'skipped',
      role: 'unmatched',
    });
    expect(JSON.stringify(preview)).not.toContain('src/active.ts');
    expect(JSON.stringify(preview)).not.toContain('package.json');
  });

  it('unions committed and local Threadnote ignore files in inventory preview', () => {
    const entries = [
      {path: 'src/a.ts', size: 10},
      {path: 'src/b.ts', size: 20},
      {path: 'src/c.ts', size: 30},
    ];
    const groupFiles = (
      options: {readonly threadnoteIgnore?: string; readonly threadnoteIgnoreLocal?: string},
      reason: string,
    ) =>
      EffectOption.getOrUndefined(
        EffectArray.findFirst(
          summarizeCodeGraphInventoryPreview(entries, options).groups,
          group => group.reason === reason,
        ),
      )?.files ?? 0;

    expect(groupFiles({threadnoteIgnore: 'src/a.ts\n'}, 'threadnote-ignore')).toBe(1);
    expect(groupFiles({threadnoteIgnoreLocal: 'src/b.ts\n'}, 'threadnote-ignore')).toBe(1);
    expect(groupFiles({threadnoteIgnore: 'src/a.ts\n', threadnoteIgnoreLocal: 'src/b.ts\n'}, 'threadnote-ignore')).toBe(
      2,
    );
    expect(groupFiles({}, 'threadnote-ignore')).toBe(0);
    expect(
      EffectOption.getOrUndefined(
        EffectArray.findFirst(
          summarizeCodeGraphInventoryPreview(entries, {
            threadnoteIgnore: 'src/a.ts\n',
            threadnoteIgnoreLocal: 'src/b.ts\n',
          }).groups,
          group => group.reason === 'admitted' && group.language === 'typescript',
        ),
      ),
    ).toMatchObject({files: 1});
  });
});
