import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {persistCodexCloudProfile} from '../../src/codex/profile.js';
import {persistCursorCloudIdentityProfile} from '../../src/cursor/profile.js';
import {runWorkflowMemory} from '../../src/workflow_memory/index.js';
import {nativeFixture, provideNative} from './native-automation-fixture.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Array as EffectArray} from 'effect';

for (const profile of ['codex-cloud-personal', 'cursor-cloud-personal'] as const) {
  effectIt.effect(`${profile} names private and shared artifacts without reusing destination approval`, () =>
    Effect.gen(function* () {
      const system = yield* SystemInfo;
      const environment = EffectRecord.fromEntries(
        EffectArray.filter(
          EffectRecord.toEntries(system.environment()),
          ([key]) => !Effect2.pipe(key, EffectString.startsWith('THREADNOTE_')),
        ),
      );
      if (profile === 'cursor-cloud-personal') environment.THREADNOTE_CURSOR_CLOUD_TEAM = 'default';
      const f = yield* nativeFixture(environment);
      const config = {...f.config, manifestSource: 'bundled-example' as const};
      const git = (cwd: string, args: readonly string[]) => runCommandEffect('git', ['-C', cwd, ...args]);
      yield* git(f.repo, ['config', 'user.email', 'test@example.invalid']);
      yield* git(f.repo, ['config', 'user.name', 'Native Naming Test']);
      yield* git(f.repo, ['add', 'source.ts']);
      yield* git(f.repo, ['commit', '-m', 'source']);
      const sourceCommit = Effect2.pipe((yield* git(f.repo, ['rev-parse', 'HEAD'])).stdout, EffectString.trim);
      const remote = f.path.join(f.root, 'remote.git');
      const worktree = f.path.join(f.root, 'shared');
      yield* git(f.root, ['init', '--bare', '--initial-branch=main', remote]);
      yield* git(f.root, ['clone', remote, worktree]);
      yield* git(worktree, ['config', 'user.email', 'test@example.invalid']);
      yield* git(worktree, ['config', 'user.name', 'Native Naming Test']);
      yield* f.fs.writeFileString(f.path.join(worktree, 'README.md'), 'Private fixture\n');
      yield* git(worktree, ['add', 'README.md']);
      yield* git(worktree, ['commit', '-m', 'seed']);
      yield* git(worktree, ['push', 'origin', 'main']);
      yield* f.fs.makeDirectory(f.path.join(f.home, 'share'));
      yield* f.fs.writeFileString(
        f.path.join(f.home, 'share', 'teams.json'),
        JSON.stringify({
          version: 1,
          defaultTeam: 'default',
          teams: {
            default: {name: 'default', access: 'read-write', remote, worktree, gitdir: f.path.join(worktree, '.git')},
          },
        }),
      );
      if (profile === 'codex-cloud-personal') yield* persistCodexCloudProfile(config, ['default']);
      else yield* persistCursorCloudIdentityProfile(config);
      const init = yield* f.call(
        {...f.base('init'), project: 'fixture', featureId: 'feature', title: 'Cloud Runtime', profile},
        config,
      );
      if (!('bindingId' in init)) return yield* Effect.die('Expected a native binding.');
      const written = yield* f.call(f.write({nameHint: 'plan'}), config);
      if (!('artifact' in written)) return yield* Effect.die('Expected a private draft.');
      const draft = written.artifact;
      expect(draft).toMatchObject({
        storageKind: 'handoff',
        uri: 'threadnote://user/tester/memories/handoffs/active/fixture/workflow-cloud-runtime-plan.md',
      });
      const draftBytes = yield* f.store.read(f.location, draft.uri);
      const call = (request: unknown) =>
        runWorkflowMemory(config, request).pipe(
          Effect.provideService(SystemInfo, {
            ...system,
            currentDirectory: () => f.repo,
            environment: () => environment,
          }),
        );
      const envelope = {protocolVersion: 1, bindingId: init.bindingId};
      const preview = (topic: string) =>
        call({
          ...envelope,
          action: 'publication-preview',
          sourceCommit,
          graph: {
            nodes: [
              {
                key: 'stable-architecture-key',
                role: 'architecture',
                topic,
                body: 'Approved architecture.',
                codeRefs: [],
                relations: [],
              },
            ],
          },
        });
      const first = yield* preview('arch');
      if (!('approvalDigest' in first) || !('nodes' in first))
        return yield* Effect.die('Expected publication preview.');
      expect(first.nodes[0].canonicalUri).toBe(
        'threadnote://user/tester/memories/shared/default/durable/projects/fixture/workflow-cloud-runtime-arch.md',
      );
      yield* call({
        ...envelope,
        action: 'publication-approve',
        approvalDigest: first.approvalDigest,
        decision: 'approve',
        approvalEvidence: 'Human approved this exact fixture destination.',
      });
      const changed = yield* preview('arch-revised');
      if (!('approvalDigest' in changed) || !('nodes' in changed))
        return yield* Effect.die('Expected changed preview.');
      expect(changed.nodes[0].canonicalUri).toBe(
        'threadnote://user/tester/memories/shared/default/durable/projects/fixture/workflow-cloud-runtime-arch-revised.md',
      );
      expect(changed.approvalDigest).not.toBe(first.approvalDigest);
      expect(
        yield* call({...envelope, action: 'publication-publish', approvalDigest: first.approvalDigest}).pipe(
          Effect.result,
        ),
      ).toMatchObject({_tag: 'Failure', failure: {code: 'publication-approval-changed'}});
      expect(
        yield* call({...envelope, action: 'publication-publish', approvalDigest: changed.approvalDigest}).pipe(
          Effect.result,
        ),
      ).toMatchObject({_tag: 'Failure', failure: {code: 'publication-approval-required'}});
      expect(yield* f.store.read(f.location, draft.uri)).toBe(draftBytes);
      expect(Effect2.pipe((yield* git(remote, ['rev-list', '--count', 'main'])).stdout, EffectString.trim)).toBe('1');
      yield* call({
        ...envelope,
        action: 'publication-approve',
        approvalDigest: changed.approvalDigest,
        decision: 'approve',
        approvalEvidence: 'Human approved the revised exact destination.',
      });
      expect(
        yield* call({...envelope, action: 'publication-publish', approvalDigest: changed.approvalDigest}),
      ).toMatchObject({status: 'ok', verifiedReadback: true});
      expect(
        EffectArray.filter(
          Effect2.pipe((yield* git(remote, ['ls-tree', '-r', '--name-only', 'main'])).stdout, EffectString.split('\n')),
          Boolean,
        ),
      ).toEqual(['README.md', 'durable/projects/fixture/workflow-cloud-runtime-arch-revised.md']);
      expect(yield* f.store.read(f.location, draft.uri)).toBe(draftBytes);
    }).pipe(TestClock.withLive, provideNative),
  );
}
