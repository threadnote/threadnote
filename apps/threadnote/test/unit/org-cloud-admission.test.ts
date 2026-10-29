import {Array as EffectArray} from 'effect';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {orgCloudRepositorySetDigest} from '@threadnote/remote-memory/cloud_admission';
import {buildOrgCloudHybridMcpConfig, type CursorCloudProfileV1} from '@threadnote/threadnote/cursor/cloud';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const profile: CursorCloudProfileV1 = {
  account: 'local',
  agentId: 'cloud',
  graphMode: 'local-checkout',
  homeDurability: 'ephemeral',
  memoryRoot: 'threadnote://user/cloud/memories/shared/cloud',
  profile: 'shared-read-write',
  provider: 'cursor-cloud',
  team: 'cloud',
  user: 'cloud',
  version: 1,
};

describe('organization Cloud admission config', () => {
  it('requires an explicit repository set and defaults to read only', () => {
    expect(() => buildOrgCloudHybridMcpConfig(profile, 'https://example.test/mcp', 'share')).toThrow(
      'repository bindings',
    );
    const config = buildOrgCloudHybridMcpConfig(profile, 'https://example.test/mcp', 'share', undefined, {
      repositories: ['https://github.com/example/repo.git'],
    });
    expect(config.mcpServers['threadnote-org'].auth.scopes).toEqual(['memory:read']);
    expect(config.mcpServers['threadnote-org'].headers).toMatchObject({'threadnote-cloud-access': 'read-only'});
    expect(JSON.stringify(config)).not.toContain('github.com');
    const contributing = buildOrgCloudHybridMcpConfig(profile, 'https://example.test/mcp', 'share', 'writer-client', {
      repositories: ['github.com/example/repo'],
      contribute: true,
    });
    expect(contributing.mcpServers['threadnote-org'].auth.scopes).toEqual(['memory:read', 'memory:write:durable']);
    expect(contributing.mcpServers['threadnote-org'].headers).toMatchObject({'threadnote-cloud-access': 'contribute'});
    expect(
      orgCloudRepositorySetDigest(
        'share',
        Array.from({length: 300}, () => 'https://github.com/example/repo.git'),
      ),
    ).toBe(orgCloudRepositorySetDigest('share', ['github.com/example/repo']));
  });

  it('canonicalizes sets independently of order, duplicates, and URL spelling without mutating inputs', () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[a-z][a-z0-9]{0,15}$/), {minLength: 1, maxLength: 32}), names => {
        const repositories = EffectArray.map(names, name => `github.com/example/${name}`);
        const before = [...repositories];
        const digest = orgCloudRepositorySetDigest('share', repositories);
        expect(orgCloudRepositorySetDigest('share', [...repositories].reverse())).toBe(digest);
        expect(orgCloudRepositorySetDigest('share', [...repositories, ...repositories])).toBe(digest);
        expect(
          orgCloudRepositorySetDigest(
            'share',
            EffectArray.map(repositories, repository => `https://${repository}.git`),
          ),
        ).toBe(digest);
        expect(orgCloudRepositorySetDigest('other-share', repositories)).not.toBe(digest);
        expect(repositories).toEqual(before);
      }),
      {numRuns: 100},
    );
  });

  it('rejects invalid or credential-bearing repository sets', () => {
    for (const repositories of [
      [],
      ['https://user:password@example.test/repo'],
      ['https://example.test/repo?token=secret'],
      ['../repo'],
      [`github.com/example/${Effect.pipe('segment/', EffectString.repeat(300))}repo`],
    ]) {
      expect(() => orgCloudRepositorySetDigest('share', repositories)).toThrow();
    }
  });
});
