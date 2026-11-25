import {createTypeScriptSyntaxSession, type TypeScriptSyntaxSession} from '../../workspace/typescript-syntax.js';
import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it, afterAll} from 'vitest';
import {allowedRepositoryPath, sourceRepositoryPathCandidates} from '../repository-inputs.mjs';

describe('repository input discovery', () => {
  it('finds complete paths assembled below a dynamic repository root', async () => {
    const candidates = await sourceRepositoryPathCandidates(
      await getSyntaxSession(),
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

  it('does not turn a static prefix with a dynamic tail into a broad repository input', async () => {
    const candidates = await sourceRepositoryPathCandidates(
      await getSyntaxSession(),
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

  it('owns the directory of a dynamic repository path passed to a file reader', async () => {
    const candidates = await sourceRepositoryPathCandidates(
      await getSyntaxSession(),
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

  it('ignores zero-argument methods whose names overlap filesystem readers', async () => {
    expect(
      await sourceRepositoryPathCandidates(
        await getSyntaxSession(),
        'example.ts',
        `
          const metadata = await handle.stat();
          const bytes = await handle.readFile();
          const sink = open();
        `,
      ),
    ).toEqual([]);
  });

  it('accepts only exact roots and their descendants', async () => {
    expect(allowedRepositoryPath('docs/troubleshooting.md', ['docs', 'README.md'])).toBe(true);
    expect(allowedRepositoryPath('README.md', ['docs', 'README.md'])).toBe(true);
    expect(allowedRepositoryPath('docs-private/file.md', ['docs', 'README.md'])).toBe(false);
  });

  it('round-trips arbitrary safe join components deterministically', async () => {
    const segment = fc.stringMatching(/^[a-z][a-z0-9_-]{0,12}$/u);
    await fc.assert(
      fc.asyncProperty(fc.array(segment, {minLength: 2, maxLength: 6}), async parts => {
        const source = `join(process.cwd(), ${EffectArray.join(
          EffectArray.map(parts, part => JSON.stringify(part)),
          ', ',
        )})`;
        const candidates = await sourceRepositoryPathCandidates(await getSyntaxSession(), 'example.ts', source);
        expect(candidates).toContain(EffectArray.join(parts, '/'));
        expect(candidates).toEqual([...new Set(candidates)].sort());
      }),
      {numRuns: 100},
    );
  });
});

// One npm TypeScript syntax child serves this whole file and is closed once.
let syntaxSession: TypeScriptSyntaxSession | undefined;
afterAll(async () => {
  await syntaxSession?.close();
});
function getSyntaxSession(): Promise<TypeScriptSyntaxSession> {
  return Promise.resolve((syntaxSession ??= createTypeScriptSyntaxSession({cwd: process.cwd()})));
}
