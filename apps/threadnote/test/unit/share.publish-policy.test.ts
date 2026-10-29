import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {Cause, Effect, Exit, FileSystem, Path} from 'effect';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {runSharePublish} from '@threadnote/threadnote/effect/share';
import {runSharePublishTool} from '@threadnote/threadnote/mcp/server/share';
import {sharePublishEligibilityError} from '@threadnote/threadnote/share/publish_policy';
import type {ShareRuntime} from '@threadnote/threadnote/types';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const config: ShareRuntime = {
  account: 'local',
  agentContextHome: '/tmp/threadnote-share-policy',
  agentId: 'threadnote',
  user: 'tester',
};

function content(kind: string, status = 'active'): string {
  return `MEMORY\nkind: ${kind}\nstatus: ${status}\nproject: foo\ntopic: bar\n\nBody\n`;
}

describe('share publication eligibility', () => {
  it('accepts an active personal durable memory', () => {
    expect(
      sharePublishEligibilityError(
        config,
        'threadnote://user/tester/memories/durable/projects/foo/bar.md',
        content('durable'),
      ),
    ).toBeUndefined();
  });

  it('rejects a handoff even when its content claims to be durable', () => {
    expect(
      sharePublishEligibilityError(
        config,
        'threadnote://user/tester/memories/handoffs/active/foo/bar.md',
        content('durable'),
      ),
    ).toContain('only active personal durable memories');
  });

  it.effect('refuses CLI and MCP publication previews of a personal handoff', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-share-eligible-'});
        const uri = 'threadnote://user/tester/memories/handoffs/active/foo/bar.md';
        const sourcePath = path.join(
          home,
          'data',
          'local',
          'user',
          'tester',
          'memories',
          'handoffs',
          'active',
          'foo',
          'bar.md',
        );
        const worktree = path.join(home, 'share', 'worktrees', 'default');
        yield* fs.makeDirectory(path.dirname(sourcePath), {recursive: true});
        yield* fs.makeDirectory(worktree, {recursive: true});
        yield* fs.writeFileString(
          sourcePath,
          'HANDOFF\nkind: handoff\nstatus: active\nproject: foo\ntopic: bar\n\nBody\n',
        );
        yield* fs.writeFileString(
          path.join(home, 'share', 'teams.json'),
          `${JSON.stringify({
            defaultTeam: 'default',
            teams: {
              default: {
                addedAt: '2026-09-14T00:00:00.000Z',
                gitdir: path.join(home, 'team.gitdir'),
                name: 'default',
                remote: 'git@example.com:team/memories.git',
                worktree,
              },
            },
            version: 1,
          })}\n`,
        );
        const result = yield* Effect.exit(runSharePublish({...config, agentContextHome: home}, uri, {preview: true}));
        expect(Exit.isFailure(result) ? Cause.pretty(result.cause) : '').toContain(
          'only active personal durable memories',
        );
        const mcpResult = yield* runSharePublishTool(
          {...config, agentContextHome: home, manifestPath: path.join(home, 'seed-manifest.yaml')},
          uri,
          {preview: true},
        );
        expect(mcpResult.isError).toBe(true);
        expect(mcpResult.content[0]).toMatchObject({
          type: 'text',
          text: expect.stringContaining('only active personal durable memories'),
        });
        expect(yield* fs.exists(sourcePath)).toBe(true);
        expect(yield* fs.exists(path.join(worktree, 'handoffs', 'active', 'foo', 'bar.md'))).toBe(false);

        const durablePath = path.join(
          home,
          'data',
          'local',
          'user',
          'tester',
          'memories',
          'durable',
          'projects',
          'foo',
          'bar.md',
        );
        yield* fs.makeDirectory(path.dirname(durablePath), {recursive: true});
        yield* fs.writeFileString(durablePath, content('durable'));
        const legacyUri = 'viking://user/tester/memories/durable/projects/foo/bar.md';
        const legacyPreview = yield* Effect.exit(
          runSharePublish({...config, agentContextHome: home}, legacyUri, {preview: true}),
        );
        expect(Exit.isSuccess(legacyPreview)).toBe(true);
        const dryRun = yield* Effect.exit(
          runSharePublish({...config, agentContextHome: home}, legacyUri, {dryRun: true}),
        );
        expect(Exit.isSuccess(dryRun)).toBe(true);
        expect(yield* fs.exists(durablePath)).toBe(true);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('rejects anchors while accepting canonicalized legacy aliases', () => {
    const uri = 'threadnote://user/tester/memories/durable/projects/foo/bar.md';
    expect(
      sharePublishEligibilityError(
        config,
        Effect2.pipe(uri, EffectString.replace('threadnote://', 'viking://')),
        content('durable'),
      ),
    ).toBeUndefined();
    expect(sharePublishEligibilityError(config, `${uri}#x.md`, content('durable'))).toContain(
      'only active personal durable memories',
    );
  });

  fcProp(
    it,
    'accepts exactly the active durable lifecycle path and document kind',
    {
      pathKind: FC.constantFrom('durable/projects', 'handoffs/active', 'preferences', 'incidents/active'),
      documentKind: FC.constantFrom('durable', 'handoff', 'preference', 'incident', 'smoke'),
      status: FC.constantFrom('active', 'archived', 'expired', 'superseded'),
    },
    ({pathKind, documentKind, status}) => {
      const uri = `threadnote://user/tester/memories/${pathKind}/foo/bar.md`;
      const eligible = sharePublishEligibilityError(config, uri, content(documentKind, status)) === undefined;
      expect(eligible).toBe(pathKind === 'durable/projects' && documentKind === 'durable' && status === 'active');
    },
  );
});
