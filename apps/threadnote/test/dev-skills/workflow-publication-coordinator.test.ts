import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {persistCodexCloudProfile} from '../../src/codex/profile.js';
import {resolveWorkflowBinding} from '../../src/workflow_memory/profile.js';
import {bindWorkflow, readOptionalResource, withWorkflowLock} from '../../src/workflow_memory/journal.js';
import {assertWorkflowPublicationVerified, runWorkflowPublication} from '../../src/workflow_memory/publication.js';
import {runWorkflowMemory} from '../../src/workflow_memory/index.js';
import {prepareCursorCloudSharedMemory, writeCursorCloudSharedMemory} from '../../src/mcp/server/memory.js';
import {
  assertPublicationText,
  type WorkflowPublicationNode,
  type WorkflowPublicationRequest,
} from '../../src/workflow_memory/publication_contract.js';
import type {WorkflowBinding, WorkflowReadResult} from '../../src/workflow_memory/protocol.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const graph: readonly WorkflowPublicationNode[] = [
  {
    key: 'architecture',
    role: 'architecture',
    topic: 'design',
    body: 'Approved architecture — 仕様.',
    codeRefs: [],
    relations: [],
  },
  {
    key: 'spec',
    role: 'spec',
    topic: 'behavior',
    body: 'REQ-1 and SC-1: Approved behavior.',
    codeRefs: [],
    relations: [],
  },
];
const fixture = Effect.fn('test.workflowPublicationCoordinator.fixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-publication-coordinator-'}));
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  const remote = path.join(root, 'remote.git');
  const worktree = path.join(root, 'shared');
  const git = (cwd: string, args: readonly string[]) => runCommandEffect('git', ['-C', cwd, ...args]);
  yield* fs.makeDirectory(home);
  yield* fs.makeDirectory(repo);
  yield* git(repo, ['init', '--initial-branch=main']);
  yield* git(repo, ['config', 'user.email', 'test@example.invalid']);
  yield* git(repo, ['config', 'user.name', 'Publication Test']);
  yield* git(repo, ['remote', 'add', 'origin', 'https://example.invalid/source.git']);
  yield* fs.makeDirectory(path.join(repo, 'src'));
  yield* fs.writeFileString(path.join(repo, 'src/value.ts'), 'export const value = 1;\n');
  yield* git(repo, ['add', '.']);
  yield* git(repo, ['commit', '-m', 'source']);
  const sourceCommit = (yield* git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  yield* git(root, ['init', '--bare', '--initial-branch=main', remote]);
  yield* git(root, ['clone', remote, worktree]);
  yield* git(worktree, ['config', 'user.email', 'test@example.invalid']);
  yield* git(worktree, ['config', 'user.name', 'Publication Test']);
  yield* fs.writeFileString(path.join(worktree, 'README.md'), 'Shared fixture\n');
  yield* git(worktree, ['add', '.']);
  yield* git(worktree, ['commit', '-m', 'seed']);
  yield* git(worktree, ['push', 'origin', 'main']);
  yield* fs.makeDirectory(path.join(home, 'share'));
  yield* fs.writeFileString(
    path.join(home, 'share', 'teams.json'),
    JSON.stringify({
      version: 1,
      defaultTeam: 'default',
      teams: {default: {name: 'default', access: 'read-write', remote, worktree, gitdir: path.join(worktree, '.git')}},
    }),
  );
  const config = {
    account: 'local',
    agentContextHome: home,
    agentId: 'test',
    user: 'tester',
    manifestPath: path.join(home, 'manifest.yaml'),
    manifestSource: 'bundled-example' as const,
  };
  yield* persistCodexCloudProfile(config, ['default']);
  const context = {
    ...system,
    currentDirectory: () => repo,
    environment: () =>
      Object.fromEntries(Object.entries(system.environment()).filter(([key]) => !key.startsWith('THREADNOTE_'))),
  };
  const binding = yield* resolveWorkflowBinding(config, {
    protocolVersion: 1,
    action: 'bind',
    workflowRunId: 'workflow-publication',
    project: 'fixture',
    featureId: 'feature',
    generation: 'bundle-v1',
  }).pipe(Effect.provideService(SystemInfo, context));
  const state = yield* bindWorkflow(config, binding);
  const call = (input: WorkflowPublicationRequest) =>
    withWorkflowLock(config, binding.bindingId, runWorkflowPublication(config, state, input)).pipe(
      Effect.provideService(SystemInfo, context),
    );
  const preview = (nodes = graph) =>
    call({
      protocolVersion: 1,
      bindingId: binding.bindingId,
      action: 'publication-preview',
      sourceCommit,
      graph: {nodes},
    });
  const approve = (approvalDigest: string, decision: 'approve' | 'defer' | 'reject' = 'approve') =>
    call({
      protocolVersion: 1,
      bindingId: binding.bindingId,
      action: 'publication-approve',
      approvalDigest,
      decision,
      approvalEvidence: 'User approved the displayed content, selected team and final relation graph.',
    });
  const publish = (approvalDigest: string) =>
    call({protocolVersion: 1, bindingId: binding.bindingId, action: 'publication-publish', approvalDigest});
  const guard = withWorkflowLock(
    config,
    binding.bindingId,
    assertWorkflowPublicationVerified(config, binding.bindingId),
  ).pipe(Effect.provideService(SystemInfo, context));
  return {
    fs,
    path,
    home,
    repo,
    remote,
    worktree,
    git,
    config,
    binding,
    context,
    preview,
    approve,
    publish,
    guard,
    sourceCommit,
  };
});

describe('approved workflow graph publication', () => {
  effectIt.effect(
    'publishes and replays the three approved stages before admitting draft retirement',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const preview = yield* f.preview();
        if (!('stages' in preview)) return yield* Effect.die('Expected preview');
        expect(preview.stages).toHaveLength(3);
        expect(preview.nodes.every(node => node.relations.length === 1)).toBe(true);
        expect((yield* f.git(f.remote, ['rev-list', '--count', 'main'])).stdout.trim()).toBe('1');
        expect(yield* f.publish(preview.approvalDigest).pipe(Effect.result)).toMatchObject({
          _tag: 'Failure',
          failure: {code: 'publication-approval-required'},
        });
        yield* f.approve(preview.approvalDigest);
        const result = yield* f.publish(preview.approvalDigest);
        expect(result).toMatchObject({status: 'ok', verifiedReadback: true});
        expect(yield* f.publish(preview.approvalDigest)).toEqual(result);
        expect(yield* f.guard).toEqual(result);
        expect((yield* f.git(f.remote, ['rev-list', '--count', 'main'])).stdout.trim()).toBe('4');
        const files = (yield* f.git(f.remote, ['ls-tree', '-r', '--name-only', 'main'])).stdout;
        expect(files).not.toMatch(/handoff|workflow-memory|\.publication/);
        for (const node of preview.nodes) {
          const content = yield* readOptionalResource(f.config, node.canonicalUri);
          expect(parseMemoryDocument(node.canonicalUri, content!)?.metadata.relations).toEqual(node.relations);
        }
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
    // Three native stages plus fresh replay/retirement verification exceeded 30s on Windows CI.
    process.platform === 'win32' ? 60_000 : undefined,
  );

  effectIt.effect('keeps a partially pushed graph pending and resumes its committed stage without duplicates', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const preview = yield* f.preview();
      const hook = f.path.join(f.remote, 'hooks', 'pre-receive');
      // Allow architecture, reject spec. No production state enters the shared repository.
      yield* f.fs.writeFileString(hook, '#!/bin/sh\n[ "$(git rev-list --count refs/heads/main)" -lt 2 ]\n', {
        mode: 0o700,
      });
      yield* f.approve(preview.approvalDigest);
      const pending = yield* f.publish(preview.approvalDigest);
      expect(pending).toMatchObject({status: 'pending', stage: 'spec:create', committed: {version: 1}});
      expect(yield* f.guard.pipe(Effect.result)).toMatchObject({_tag: 'Failure'});
      yield* f.fs.remove(hook);
      expect(yield* f.publish(preview.approvalDigest)).toMatchObject({status: 'ok', verifiedReadback: true});
      expect((yield* f.git(f.remote, ['rev-list', '--count', 'main'])).stdout.trim()).toBe('4');
      expect(yield* f.guard).toMatchObject({verifiedReadback: true});
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('invalidates approval on content changes and supports a standalone final node', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const first = yield* f.preview([graph[0]]);
      yield* f.approve(first.approvalDigest);
      const changed = yield* f.preview([{...graph[0], body: 'Revised approved architecture.'}]);
      expect(changed.approvalDigest).not.toBe(first.approvalDigest);
      expect(yield* f.publish(first.approvalDigest).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
        failure: {code: 'publication-approval-changed'},
      });
      for (const decision of ['defer', 'reject'] as const) {
        yield* f.approve(changed.approvalDigest, decision);
        expect(yield* f.publish(changed.approvalDigest).pipe(Effect.result)).toMatchObject({
          _tag: 'Failure',
          failure: {code: 'publication-approval-required'},
        });
      }
      yield* f.approve(changed.approvalDigest);
      expect(yield* f.publish(changed.approvalDigest)).toMatchObject({status: 'ok', verifiedReadback: true});
      expect((yield* f.git(f.remote, ['rev-list', '--count', 'main'])).stdout.trim()).toBe('2');
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects source HEAD changes and unavailable citations without publishing', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      expect(yield* f.preview([{...graph[0], codeRefs: ['src/value.ts']}]).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
      });
      const preview = yield* f.preview([graph[0]]);
      yield* f.approve(preview.approvalDigest);
      yield* f.git(f.repo, ['commit', '--allow-empty', '-m', 'new source']);
      expect(yield* f.publish(preview.approvalDigest).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
        failure: {code: 'publication-source-changed'},
      });
      expect((yield* f.git(f.remote, ['rev-list', '--count', 'main'])).stdout.trim()).toBe('1');
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('captures native current clean citations and preserves them in the remote document', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* (yield* CodeGraphIndexer).index({threadnoteHome: f.home, cwd: f.repo, ensureVectors: false});
      const preview = yield* f.preview([{...graph[0], codeRefs: ['src/value.ts']}]);
      if (!('stages' in preview)) return yield* Effect.die('Expected preview');
      expect(preview.nodes[0].codeCitations).toMatchObject([
        {sourceCommit: f.sourceCommit, sourceDirty: false, repositoryIdentityKind: 'remote'},
      ]);
      yield* f.approve(preview.approvalDigest);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'src/value.ts'), 'export const value = 2;\n');
      expect(yield* f.publish(preview.approvalDigest).pipe(Effect.result)).toMatchObject({_tag: 'Failure'});
      expect((yield* f.git(f.remote, ['rev-list', '--count', 'main'])).stdout.trim()).toBe('1');
      yield* f.fs.writeFileString(f.path.join(f.repo, 'src/value.ts'), 'export const value = 1;\n');
      expect(yield* f.publish(preview.approvalDigest)).toMatchObject({verifiedReadback: true});
      const content = yield* readOptionalResource(f.config, preview.nodes[0].canonicalUri);
      expect(parseMemoryDocument(preview.nodes[0].canonicalUri, content!)?.metadata.codeCitations).toEqual(
        preview.nodes[0].codeCitations,
      );
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('does not admit retirement after a final remote node is overwritten', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const preview = yield* f.preview([graph[0]]);
      if (!('stages' in preview)) return yield* Effect.die('Expected preview');
      yield* f.approve(preview.approvalDigest);
      yield* f.publish(preview.approvalDigest);
      const relative = preview.nodes[0].canonicalUri.split('/shared/default/')[1];
      yield* f.fs.writeFileString(f.path.join(f.worktree, relative), 'Concurrent shared edit\n');
      yield* f.git(f.worktree, ['add', relative]);
      yield* f.git(f.worktree, ['commit', '-m', 'concurrent edit']);
      yield* f.git(f.worktree, ['push', 'origin', 'main']);
      expect(yield* f.guard.pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
        failure: {code: 'publication-readback-conflict'},
      });
      expect((yield* f.git(f.remote, ['show', `main:${relative}`])).stdout).toBe('Concurrent shared edit\n');
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  for (const decision of ['reject', 'defer'] as const)
    effectIt.effect(
      `does not publish another binding's pending commit after its approval is revoked by ${decision}`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture();
          const remoteBefore = (yield* f.git(f.remote, ['rev-parse', 'main'])).stdout.trim();
          const first = yield* f.preview([graph[0]]);
          if (!('stages' in first)) return yield* Effect.die('Expected preview');
          yield* f.approve(first.approvalDigest);
          const hook = f.path.join(f.remote, 'hooks', 'pre-receive');
          yield* f.fs.writeFileString(hook, '#!/bin/sh\nexit 1\n', {mode: 0o700});
          const pending = yield* f.publish(first.approvalDigest);
          expect(pending).toMatchObject({status: 'pending', committed: {version: 1}});
          const firstCommit = (yield* f.git(f.worktree, ['rev-parse', 'HEAD'])).stdout.trim();
          yield* f.approve(first.approvalDigest, decision);
          yield* f.fs.remove(hook);
          const binding = yield* resolveWorkflowBinding(f.config, {
            protocolVersion: 1,
            action: 'bind',
            workflowRunId: 'independent-workflow',
            project: 'fixture',
            featureId: 'independent-feature',
            generation: 'bundle-v1',
          }).pipe(Effect.provideService(SystemInfo, f.context));
          const state = yield* bindWorkflow(f.config, binding);
          const call = (request: WorkflowPublicationRequest) =>
            withWorkflowLock(f.config, binding.bindingId, runWorkflowPublication(f.config, state, request)).pipe(
              Effect.provideService(SystemInfo, f.context),
            );
          const second = yield* call({
            protocolVersion: 1,
            bindingId: binding.bindingId,
            action: 'publication-preview',
            sourceCommit: f.sourceCommit,
            graph: {nodes: [{...graph[0], topic: 'independent-design', body: 'Independently approved architecture.'}]},
          });
          yield* call({
            protocolVersion: 1,
            bindingId: binding.bindingId,
            action: 'publication-approve',
            approvalDigest: second.approvalDigest,
            decision: 'approve',
            approvalEvidence: 'Approve only the displayed independent graph.',
          });
          expect(
            yield* call({
              protocolVersion: 1,
              bindingId: binding.bindingId,
              action: 'publication-publish',
              approvalDigest: second.approvalDigest,
            }),
          ).toMatchObject({status: 'pending'});
          expect((yield* f.git(f.remote, ['rev-parse', 'main'])).stdout.trim()).toBe(remoteBefore);
          expect(
            (yield* f.git(f.worktree, [
              'show',
              `${firstCommit}:${first.nodes[0].canonicalUri.split('/shared/default/')[1]}`,
            ])).stdout,
          ).toBe(first.stages[0].content);
          expect(yield* f.publish(first.approvalDigest).pipe(Effect.result)).toMatchObject({
            _tag: 'Failure',
            failure: {code: 'publication-approval-required'},
          });
          // Nothing was discarded: explicit renewed approval lets A publish, then B retries its own commit.
          yield* f.approve(first.approvalDigest);
          expect(yield* f.publish(first.approvalDigest)).toMatchObject({verifiedReadback: true});
          expect(
            yield* call({
              protocolVersion: 1,
              bindingId: binding.bindingId,
              action: 'publication-publish',
              approvalDigest: second.approvalDigest,
            }),
          ).toMatchObject({verifiedReadback: true});
        }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
    );

  for (const change of ['delete', 'archive', 'replace'] as const)
    effectIt.effect(`keeps drafts when an external target has a remote ${change} hidden by stale native cache`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const scope = {team: 'default', root: 'threadnote://user/tester/memories/shared/default'};
        const input = {
          operation: 'create' as const,
          bodyText: 'Approved external architecture dependency.',
          metadata: {
            kind: 'durable' as const,
            status: 'active' as const,
            project: 'fixture',
            topic: 'external-dependency',
            memoryId: 'tn_1234567890abcdef1234',
            timestamp: '2026-10-20T00:00:00.000Z',
            sourceAgentClient: 'test',
          },
        };
        const external = yield* prepareCursorCloudSharedMemory(f.config, scope, input);
        expect((yield* writeCursorCloudSharedMemory(f.config, scope, input)).isError).not.toBe(true);
        const body = 'Private draft retained until the complete approved graph is remotely verified.\n';
        const draft = (yield* runWorkflowMemory(f.config, {
          protocolVersion: 1,
          bindingId: f.binding.bindingId,
          action: 'create',
          operationId: 'private-draft',
          artifactKey: 'draft',
          sourceRunId: 'writer',
          role: 'root',
          body,
          bodySha256: sha256HexSync(body),
          expectedRevision: null,
        }).pipe(Effect.provideService(SystemInfo, f.context))) as WorkflowReadResult;
        const draftBefore = yield* readOptionalResource(f.config, draft.canonicalUri);
        const preview = yield* f.preview([{...graph[0], relations: [{type: 'depends_on', uri: external.memoryUri}]}]);
        yield* f.approve(preview.approvalDigest);
        expect(yield* f.publish(preview.approvalDigest)).toMatchObject({verifiedReadback: true});
        const peer = f.path.join(f.home, `peer-${change}`);
        yield* f.git(f.home, ['clone', f.remote, peer]);
        yield* f.git(peer, ['config', 'user.email', 'peer@example.invalid']);
        yield* f.git(peer, ['config', 'user.name', 'External Target Peer']);
        const path = external.memoryUri.split('/shared/default/')[1];
        if (change === 'delete') yield* f.git(peer, ['rm', path]);
        else {
          const record = parseMemoryDocument(external.memoryUri, external.memory)!;
          const modified = formatMemoryDocument(
            record.headerTitle,
            {
              ...record.metadata,
              ...(change === 'archive' ? {status: 'archived' as const} : {memoryId: 'tn_abcdef1234567890abcd'}),
            },
            record.body,
          );
          yield* f.fs.writeFileString(f.path.join(peer, path), modified);
          yield* f.git(peer, ['add', path]);
        }
        yield* f.git(peer, ['commit', '-m', `external dependency ${change}`]);
        yield* f.git(peer, ['push', 'origin', 'main']);
        expect(yield* readOptionalResource(f.config, external.memoryUri)).toBe(external.memory);
        expect(yield* f.publish(preview.approvalDigest).pipe(Effect.result)).toMatchObject({
          _tag: 'Failure',
          failure: {code: 'publication-readback-conflict'},
        });
        expect(yield* f.guard.pipe(Effect.result)).toMatchObject({
          _tag: 'Failure',
          failure: {code: 'publication-readback-conflict'},
        });
        expect(
          yield* runWorkflowMemory(f.config, {
            protocolVersion: 1,
            bindingId: f.binding.bindingId,
            action: 'archive',
            operationId: 'retire-private-draft',
            artifactKey: 'draft',
            sourceRunId: 'writer',
            role: 'root',
            uri: draft.canonicalUri,
            expectedRevision: draft.revision,
          }).pipe(Effect.provideService(SystemInfo, f.context), Effect.result),
        ).toMatchObject({
          _tag: 'Failure',
          failure: {code: 'publication-readback-conflict'},
        });
        expect(yield* readOptionalResource(f.config, draft.canonicalUri)).toBe(draftBefore);
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
    );

  it('rejects private references through bounded JSON and URL encoding layers', () => {
    const binding = {home: '/Users/private/threadnote', repo: '/work/project'} as WorkflowBinding;
    fc.assert(
      fc.property(
        fc.constantFrom(
          'threadnote://user/tester/memories/handoffs/active/task.md',
          '/Users/private/threadnote/workflow-memory/run.json',
          '/work/project/.context/task.json',
          String.raw`C:\Users\private\threadnote\workflow-memory\run.json`,
        ),
        fc.array(fc.constantFrom('unicode', 'percent', 'slash'), {minLength: 0, maxLength: 3}),
        (privateText, encodings) => {
          const encode = (value: string) =>
            encodings.reduce<string>(
              (text, encoding) =>
                encoding === 'unicode'
                  ? [...text].map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')
                  : encoding === 'percent'
                    ? [...text].map(character => `%${character.charCodeAt(0).toString(16).padStart(2, '0')}`).join('')
                    : text.replace(/[\\/]/gu, '\\$&'),
              value,
            );
          const inspect = (value: string) =>
            assertPublicationText(
              `Embedded ${JSON.stringify({value: encode(value)})}`,
              binding,
              'threadnote://user/tester/memories/shared/default',
            );
          expect(() => inspect(privateText)).toThrow();
          expect(() => inspect('threadnote://user/tester/memories/shared/default/design.md')).not.toThrow();
        },
      ),
      {
        numRuns: 120,
        examples: [
          ['threadnote://user/tester/memories/handoffs/active/task.md', ['unicode']],
          ['threadnote://user/tester/memories/handoffs/active/task.md', ['unicode', 'slash']],
        ],
      },
    );
    expect(() =>
      assertPublicationText(
        encodeURIComponent('/mnt/秘密/source/file.ts'),
        {...binding, repo: '/mnt/秘密/source'},
        'threadnote://user/tester/memories/shared/default',
      ),
    ).toThrow();
  });
});
