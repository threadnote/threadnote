import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {makeSourceConfigurationRegistry} from '@threadnote/integration-runtime/config';
import {
  githubSourceCodec,
  upsertGitHubSource,
  requireGitHubSource,
  sourceConfigurationFingerprint,
  normalizeGitHubRepository,
} from '../src/config.js';
const registry = makeSourceConfigurationRegistry({sources: [githubSourceCodec], projections: []});
const emptyObsidianConfiguration = registry.empty;
const parseObsidianConfiguration = registry.parse;
const renderObsidianConfiguration = registry.render;

describe('GitHub configuration', () => {
  it('round-trips GitHub repository allowlists and fingerprints independently of repository order', () => {
    const name = fc
      .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'), {minLength: 1, maxLength: 12})
      .map(parts => `r${parts.join('')}`);
    fc.assert(
      fc.property(fc.uniqueArray(name, {minLength: 1, maxLength: 8}), fc.boolean(), (names, local) => {
        const source = {
          type: 'github' as const,
          id: 'github',
          enabled: true,
          credentialEnv: 'THREADNOTE_GITHUB_TOKEN',
          ...(local ? {credentialStorage: 'local' as const} : {}),
          project: 'engineering',
          repositories: names.map(value => `Owner/${value}`),
          refreshIntervalMinutes: 15,
          maxStaleHours: 24,
        };
        const configuration = upsertGitHubSource(emptyObsidianConfiguration(), source);
        const parsed = parseObsidianConfiguration(renderObsidianConfiguration(configuration));
        expect(parsed).toEqual(configuration);
        expect(requireGitHubSource(parsed, 'github').repositories).toEqual(names.map(value => `owner/${value}`).sort());
        expect(sourceConfigurationFingerprint(source)).toBe(
          sourceConfigurationFingerprint({...source, repositories: [...source.repositories].reverse()}),
        );
      }),
      {numRuns: 40},
    );
  });

  it('accepts only GitHub repository roots and rejects duplicate canonical repositories', () => {
    expect(normalizeGitHubRepository('https://github.com/Owner/Repo/')).toBe('owner/repo');
    for (const invalid of [
      'https://evil.example/Owner/Repo',
      'http://github.com/Owner/Repo',
      'https://github.com/Owner/Repo/issues',
      'https://github.com/Owner/Repo?tab=readme',
      'Owner/../Repo',
      'Owner/Repo/extra',
    ])
      expect(() => normalizeGitHubRepository(invalid)).toThrow();
    expect(() =>
      upsertGitHubSource(emptyObsidianConfiguration(), {
        type: 'github',
        id: 'github',
        enabled: true,
        credentialEnv: 'THREADNOTE_GITHUB_TOKEN',
        project: null,
        repositories: ['Owner/Repo', 'https://github.com/owner/repo'],
        refreshIntervalMinutes: 15,
        maxStaleHours: 24,
      }),
    ).toThrow(/duplicate repositories/);
  });
});
