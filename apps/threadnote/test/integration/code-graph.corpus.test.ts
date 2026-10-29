import {Array as EffectArray} from 'effect';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {execFileSync} from '@threadnote/testing/node-child-process';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {strToU8, zipSync} from 'fflate';
import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {TestClock} from 'effect/testing';
import {afterEach, describe, expect} from 'vitest';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0).reverse()) rmSync(root, {force: true, recursive: true});
});

describe('code graph mixed corpus lifecycle', () => {
  effectIt.effect('defers opaque media while retaining searchable documents for structural-only indexing', () =>
    Effect.gen(function* () {
      const root = temporaryDirectory();
      mkdirSync(join(root, 'docs'), {recursive: true});
      mkdirSync(join(root, 'diagrams'), {recursive: true});
      writeFileSync(join(root, 'docs', 'operations.rst'), 'Structural incident handoff\n===========================\n');
      writeFileSync(join(root, 'diagrams', 'opaque-pixel.png'), new Uint8Array(48 * 1_024));
      git(root, ['init']);
      git(root, ['config', 'user.email', 'threadnote@example.test']);
      git(root, ['config', 'user.name', 'Threadnote Test']);
      git(root, ['add', '.']);
      git(root, ['commit', '-m', 'fixture']);
      const home = join(root, '.threadnote-test-home');
      const indexer = yield* CodeGraphIndexer;
      const query = yield* CodeGraphQueryService;
      const indexed = yield* indexer.index({cwd: root, ensureVectors: false, threadnoteHome: home});
      const [document, image] = yield* Effect.all(
        [
          query.inspect({
            cwd: root,
            operation: 'query',
            query: 'structural incident handoff',
            refresh: false,
            threadnoteHome: home,
          }),
          query.inspect({
            cwd: root,
            operation: 'query',
            query: 'opaque pixel',
            refresh: false,
            threadnoteHome: home,
          }),
        ],
        {concurrency: 1},
      );
      expect(indexed.snapshot.fileCount).toBe(1);
      expect(indexed.skippedFiles).toBeGreaterThanOrEqual(1);
      expect(EffectArray.join(indexed.diagnostics, '\n')).toContain('Deferred 1 opaque corpus asset');
      expect(EffectArray.some(document.nodes, node => node.path === 'docs/operations.rst')).toBe(true);
      expect(image.nodes).toEqual([]);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('indexes tracked text, OpenXML, media metadata, and rationale in one transactional snapshot', () =>
    Effect.gen(function* () {
      const root = temporaryDirectory();
      mkdirSync(join(root, 'docs'), {recursive: true});
      mkdirSync(join(root, 'diagrams'), {recursive: true});
      mkdirSync(join(root, 'src'), {recursive: true});
      writeFileSync(
        join(root, 'docs', 'operations.rst'),
        'Operations\n==========\n\nRetry queues use decorrelated jitter.\n',
      );
      writeFileSync(
        join(root, 'docs', 'handoff.docx'),
        zipSync({
          '[Content_Types].xml': strToU8('<Types/>'),
          'word/document.xml': strToU8(
            '<w:document><w:body><w:p><w:r><w:t>Portable incident handoff checklist</w:t></w:r></w:p></w:body></w:document>',
          ),
        }),
      );
      const png = new Uint8Array(24);
      png.set([0x89, 0x50, 0x4e, 0x47], 0);
      writeFileSync(join(root, 'diagrams', 'retry-flow.png'), png);
      writeFileSync(
        join(root, 'src', 'retry.ts'),
        'export function retry() {\n  // WHY: Backoff prevents coordinated retries.\n}\n',
      );
      git(root, ['init']);
      git(root, ['config', 'user.email', 'threadnote@example.test']);
      git(root, ['config', 'user.name', 'Threadnote Test']);
      git(root, ['add', '.']);
      git(root, ['commit', '-m', 'fixture']);
      const home = join(root, '.threadnote-test-home');
      const indexer = yield* CodeGraphIndexer;
      const query = yield* CodeGraphQueryService;
      const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});
      const [office, image, rationale] = yield* Effect.all(
        [
          query.inspect({
            cwd: root,
            operation: 'query',
            query: 'portable incident handoff',
            refresh: false,
            threadnoteHome: home,
          }),
          query.inspect({
            cwd: root,
            operation: 'query',
            query: 'retry flow',
            refresh: false,
            threadnoteHome: home,
          }),
          query.inspect({
            cwd: root,
            operation: 'query',
            query: 'coordinated retries backoff why',
            refresh: false,
            threadnoteHome: home,
          }),
        ],
        {concurrency: 1},
      );
      expect(indexed.snapshot.fileCount).toBe(4);
      expect(EffectArray.some(office.nodes, node => node.path === 'docs/handoff.docx')).toBe(true);
      expect(image.nodes).toEqual(expect.arrayContaining([expect.objectContaining({kind: 'asset'})]));
      expect(rationale.nodes).toEqual(
        expect.arrayContaining([expect.objectContaining({kind: 'rationale', path: 'src/retry.ts'})]),
      );
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );
});

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-code-graph-corpus-'));
  temporaryRoots.push(root);
  return root;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {stdio: 'pipe'});
}
