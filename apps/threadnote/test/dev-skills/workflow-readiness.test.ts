import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {describe, expect} from 'vitest';
import {SystemInfo} from '@threadnote/platform/system';
import {readWorkflowReadiness} from '../../src/workflow_memory/index.js';
import type {WorkflowProfile} from '../../src/workflow_memory/protocol.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const testLayer = Layer.merge(BunServices.layer, TestSystemInfoLayer);
const fixture = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'workflow-readiness-'});
  const home = path.join(root, 'home');
  const config = {
    account: 'local',
    agentContextHome: home,
    agentId: 'test',
    user: 'tester',
    manifestPath: path.join(home, 'manifest.yaml'),
  };
  const environment: Record<string, string> = {};
  const call = (profile?: WorkflowProfile) =>
    readWorkflowReadiness(config, profile).pipe(
      Effect.provideService(SystemInfo, {...system, currentDirectory: () => root, environment: () => environment}),
    );
  return {fs, path, root, home, config, environment, call};
});

describe('workflow configuration readiness', () => {
  effectIt.effect('does not initialize an absent home or require a share for private desktop planning', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const result = yield* f.call('desktop');
      expect(result.planning).toMatchObject({state: 'unchecked', reasons: [{code: 'task-context-unchecked'}]});
      expect(result.publication).toMatchObject({state: 'blocked', reasons: [{code: 'share-missing'}]});
      expect(yield* f.fs.readDirectory(f.root)).toEqual([]);
    }).pipe(provideTestLayer(testLayer)),
  );

  for (const profile of ['codex-cloud-personal', 'cursor-cloud-personal'] as const) {
    effectIt.effect(`requires configured ${profile} without bootstrapping it`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const result = yield* f.call(profile);
        expect(result.planning.state).toBe('blocked');
        expect(result.publication.state).toBe('blocked');
        expect(yield* f.fs.readDirectory(f.root)).toEqual([]);
      }).pipe(provideTestLayer(testLayer)),
    );

    effectIt.effect(`reports configured ${profile} without claiming remote credentials are verified`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const provider = profile === 'codex-cloud-personal' ? 'codex-cloud' : 'cursor-cloud';
        yield* f.fs.makeDirectory(f.path.join(f.home, provider), {recursive: true});
        yield* f.fs.writeFileString(
          f.path.join(f.home, provider, 'profile.json'),
          JSON.stringify({
            version: 1,
            provider,
            account: f.config.account,
            agentId: f.config.agentId,
            user: f.config.user,
            ...(provider === 'codex-cloud' ? {teams: ['personal']} : {}),
          }),
        );
        if (provider === 'cursor-cloud') f.environment.THREADNOTE_CURSOR_CLOUD_TEAM = 'personal';
        const worktree = f.path.join(f.root, 'share');
        yield* f.fs.makeDirectory(f.path.join(worktree, '.git'), {recursive: true});
        yield* f.fs.makeDirectory(f.path.join(f.home, 'share'));
        yield* f.fs.writeFileString(
          f.path.join(f.home, 'share/teams.json'),
          JSON.stringify({
            version: 1,
            teams: {personal: {remote: 'https://example.invalid/private.git', worktree, access: 'read-write'}},
          }),
        );
        const before = (yield* f.fs.readDirectory(f.home, {recursive: true})).sort();
        const result = yield* f.call(profile);
        expect(result.profile).toBe(profile);
        expect(result.planning.state).toBe('unchecked');
        expect(result.publication).toMatchObject({state: 'unchecked', reasons: [{code: 'publication-not-verified'}]});
        expect((yield* f.fs.readDirectory(f.home, {recursive: true})).sort()).toEqual(before);
        expect((yield* f.call('desktop')).planning.state).toBe('blocked');
        expect(yield* f.fs.exists(f.path.join(f.home, 'workflow-memory'))).toBe(false);
      }).pipe(provideTestLayer(testLayer)),
    );
  }

  for (const mode of ['org', 'remote-hybrid']) {
    effectIt.effect(`rejects ${mode} configuration without writes`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        f.environment.THREADNOTE_CURSOR_CLOUD_MODE = mode;
        expect((yield* f.call()).planning).toMatchObject({state: 'blocked', reasons: [{code: 'unsupported-profile'}]});
        expect(yield* f.fs.readDirectory(f.root)).toEqual([]);
      }).pipe(provideTestLayer(testLayer)),
    );
  }
});
