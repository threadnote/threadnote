import {Array as EffectArray} from 'effect';
import {mkdtemp, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {buildGraphDocument, extractDependencyFacts, resolveGraphEdges} from '@threadnote/threadnote/graph';
import {runEffect as run} from '../helpers/effect-runtime.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('extractDependencyFacts', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tn-graph-'));
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  it('parses package.json name and all dependency sections', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@acme/web-app',
        dependencies: {'@acme/design-system': '^1.0.0', react: '^18.0.0'},
        devDependencies: {vitest: '^4.0.0'},
      }),
      'utf8',
    );
    const facts = await run(extractDependencyFacts(dir));
    expect(facts.publishedName).toBe('@acme/web-app');
    expect(facts.ecosystems).toEqual(['npm']);
    expect(facts.manifestFiles).toEqual(['package.json']);
    expect(facts.dependencies).toEqual(['@acme/design-system', 'react', 'vitest']);
  });

  it('parses go.mod module and require block', async () => {
    await writeFile(
      join(dir, 'go.mod'),
      EffectArray.join(
        [
          'module github.com/acme/service',
          '',
          'go 1.22',
          '',
          'require (',
          '\tgithub.com/acme/lib v1.2.3',
          '\tgithub.com/pkg/errors v0.9.1 // indirect',
          ')',
          '',
        ],
        '\n',
      ),
      'utf8',
    );
    const facts = await run(extractDependencyFacts(dir));
    expect(facts.publishedName).toBe('github.com/acme/service');
    expect(facts.ecosystems).toEqual(['go']);
    expect(facts.dependencies).toEqual(['github.com/acme/lib', 'github.com/pkg/errors']);
  });

  it('returns empty facts when no manifests exist and ignores malformed package.json', async () => {
    expect(await run(extractDependencyFacts(dir))).toEqual({dependencies: [], ecosystems: [], manifestFiles: []});
    await writeFile(join(dir, 'package.json'), '{not valid json', 'utf8');
    const facts = await run(extractDependencyFacts(dir));
    expect(facts.manifestFiles).toEqual([]);
  });
});

describe('resolveGraphEdges', () => {
  it('links in-workspace deps by project, counts the rest, and drops self/dupes', () => {
    const projectByPublishedName = new Map([
      ['@acme/design-system', 'design-system'],
      ['@acme/web-app', 'web-app'],
    ]);
    const {externalCount, internalEdges} = resolveGraphEdges(
      'web-app',
      ['@acme/design-system', '@acme/design-system', '@acme/web-app', 'react'],
      projectByPublishedName,
    );
    expect(internalEdges).toEqual([{dependency: '@acme/design-system', project: 'design-system'}]);
    expect(externalCount).toBe(1);
  });
});

describe('buildGraphDocument', () => {
  it('renders plain markdown with [[project]] edges and no MEMORY header', () => {
    const doc = buildGraphDocument({
      externalCount: 3,
      facts: {dependencies: [], ecosystems: ['npm'], manifestFiles: ['package.json'], publishedName: '@acme/web-app'},
      internalEdges: [{dependency: '@acme/design-system', project: 'design-system'}],
      projectName: 'web-app',
    });
    expect(Effect.pipe(doc, EffectString.startsWith('# web-app — dependency facts'))).toBe(true);
    expect(doc).not.toContain('MEMORY');
    expect(doc).not.toContain('kind:');
    expect(doc).toContain('provides: @acme/web-app');
    expect(doc).toContain('- [[design-system]] (via @acme/design-system)');
    expect(doc).toContain('external dependencies: 3 declared');
  });
});
