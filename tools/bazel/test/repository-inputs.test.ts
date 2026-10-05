import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {allowedRepositoryPath, sourceRepositoryPathCandidates} from '../repository-inputs.mjs';

describe('repository input discovery', () => {
  it('finds complete paths assembled below a dynamic repository root', () => {
    const candidates = sourceRepositoryPathCandidates(
      'example.ts',
      `
        import {join} from 'node:path';
        const root = process.cwd();
        const docs = join(root, 'docs', 'troubleshooting.md');
        const fixtures = join(temporaryRoot, 'apps', 'threadnote', 'test', 'fixtures', fixtureName);
        const workflow = '.github/workflows/ci.yml';
        const external = join(root, '..', 'outside.txt');
      `,
    );

    expect(candidates).toContain('docs/troubleshooting.md');
    expect(candidates).not.toContain('apps/threadnote/test/fixtures');
    expect(candidates).toContain('.github/workflows/ci.yml');
    expect(candidates).not.toContain('../outside.txt');
  });

  it('does not turn a static prefix with a dynamic tail into a broad repository input', () => {
    const candidates = sourceRepositoryPathCandidates(
      'example.ts',
      `
        join(readyRoot, 'packages', segment);
        resolve(checkout, 'apps', applicationName, 'fixtures');
        join(temporaryRoot, 'config');
      `,
    );

    expect(candidates).not.toContain('packages');
    expect(candidates).not.toContain('apps');
    expect(candidates).not.toContain('config');
  });

  it('owns the directory of a dynamic repository path passed to a file reader', () => {
    const candidates = sourceRepositoryPathCandidates(
      'example.ts',
      `
        readProjectFile(\`.github/release-notes/v\${manifest.version}.md\`);
        Bun.file(\`assets/code-graph/\${asset}\`);
        Bun.file(\`cursor-plugin/\${asset}\`);
      `,
    );

    expect(candidates).toContain('.github/release-notes');
    expect(candidates).toContain('assets/code-graph');
    expect(candidates).toContain('cursor-plugin');
  });

  it('ignores zero-argument methods whose names overlap filesystem readers', () => {
    expect(
      sourceRepositoryPathCandidates(
        'example.ts',
        `
          const metadata = await handle.stat();
          const bytes = await handle.readFile();
          const sink = open();
        `,
      ),
    ).toEqual([]);
  });

  it('accepts only exact roots and their descendants', () => {
    expect(allowedRepositoryPath('docs/troubleshooting.md', ['docs', 'README.md'])).toBe(true);
    expect(allowedRepositoryPath('README.md', ['docs', 'README.md'])).toBe(true);
    expect(allowedRepositoryPath('docs-private/file.md', ['docs', 'README.md'])).toBe(false);
  });

  it('round-trips arbitrary safe join components deterministically', () => {
    const segment = fc.stringMatching(/^[a-z][a-z0-9_-]{0,12}$/u);
    fc.assert(
      fc.property(fc.array(segment, {minLength: 2, maxLength: 6}), parts => {
        const source = `join(process.cwd(), ${parts.map(part => JSON.stringify(part)).join(', ')})`;
        const candidates = sourceRepositoryPathCandidates('example.ts', source);
        expect(candidates).toContain(parts.join('/'));
        expect(candidates).toEqual([...new Set(candidates)].sort());
      }),
      {numRuns: 100},
    );
  });
});
