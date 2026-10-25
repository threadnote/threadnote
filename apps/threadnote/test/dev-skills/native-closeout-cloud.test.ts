import {it} from '@effect/vitest';
import {Effect, Result, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {CommandExecutor, isGitExecutable, runCommandEffect} from '@threadnote/platform/command';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {ResourceStore} from '@threadnote/store/resource-store';
import {decodeNativeCloseoutProposal} from '@threadnote/workflow-automations/closeout';
import {nativeCloseoutFixture} from './native-closeout-fixture.js';
import {provideNative} from './native-automation-fixture.js';
import {readNativeWorkflowState} from '../../src/workflow_automation/store.js';

type Fixture = Effect.Success<ReturnType<typeof nativeCloseoutFixture>>;
const decode = Schema.decodeUnknownEffect;
const validation = Schema.Struct({
  phases: Schema.Array(Schema.Struct({id: Schema.String, acceptanceCriteria: Schema.Array(Schema.String)})),
  scenarios: Schema.Array(Schema.Struct({id: Schema.String})),
  decisions: Schema.Array(Schema.Struct({id: Schema.String, selected: Schema.String})),
});
const preview = Schema.Struct({
  publication: Schema.Struct({
    approvalDigest: Schema.String,
    nodes: Schema.Array(
      Schema.Struct({
        key: Schema.String,
        canonicalUri: Schema.String,
        memoryId: Schema.String,
        body: Schema.String,
        bodySha256: Schema.String,
      }),
    ),
  }),
});
const summary = Schema.Struct({
  closeout: Schema.Struct({state: Schema.String, archived: Schema.Finite, revision: Schema.String}),
});
const artifact = Schema.Struct({
  artifact: Schema.Struct({state: Schema.String, uri: Schema.String, memoryId: Schema.String}),
});
const receipt = Schema.Struct({
  archives: Schema.Record(
    Schema.String,
    Schema.Struct({uri: Schema.String, memoryId: Schema.String, revision: Schema.String}),
  ),
});
type Preview = typeof preview.Type;
const git = (f: Fixture, args: readonly string[]) =>
  runCommandEffect('git', ['-C', f.path.join(f.root, 'remote.git'), ...args]);
const prepare = (f: Fixture, withSpec = true) =>
  Effect.gen(function* () {
    const input = yield* decode(validation)(yield* f.closeout('validation-input'));
    const proposal = decodeNativeCloseoutProposal({
      architecture: {
        summary: 'The reader returns complete saved data.',
        components: ['Reader', 'Store'],
        contracts: ['Every saved field is returned.'],
        diagram: 'flowchart TD\n Reader --> Store',
        invariants: ['No saved field is omitted.'],
        unknowns: ['Production load is unmeasured.'],
        deviations: ['Complete reads use independent verification.'],
        codeRefs: ['source.ts'],
      },
      architectureVerification: 'Verified committed source and complete read behavior.',
      combinedChecks: [
        {command: 'private complete-read check', result: 'passed', evidence: 'Every field was observed.'},
      ],
      phaseEvidence: input.phases.map(p => ({
        id: p.id,
        acceptance: p.acceptanceCriteria.map(criterion => ({criterion, evidence: 'Observed: ' + criterion})),
      })),
      scenarios: input.scenarios.map(s => ({id: s.id, evidence: 'Observed complete saved data for ' + s.id})),
      ...(withSpec ? {behaviorVerification: 'All approved scenarios returned complete saved data.'} : {}),
      decisions: input.decisions.map(d => ({
        id: d.id,
        implemented: d.selected + ' Independently verified against the durable graph.',
        rationale:
          'The actual choice preserves complete reads; independent verification adds evidence without changing storage.',
      })),
    });
    yield* f.closeout('prepare', {proposal});
    const projected = yield* decode(preview)(yield* f.closeout('publication-preview'));
    expect(projected.publication.nodes.map(n => n.key).sort()).toEqual(
      withSpec ? ['architecture', 'spec'] : ['architecture'],
    );
    return {proposal, projected};
  });
const active = (f: Fixture, owned: readonly {runId: string; uri: string}[]) =>
  Effect.gen(function* () {
    for (const item of owned)
      expect(
        (yield* decode(artifact)(yield* f.call({...f.base('read', item.runId), uri: item.uri}))).artifact.state,
      ).toBe('active');
  });
const readRemote = (f: Fixture, projected: Preview) =>
  Effect.gen(function* () {
    const bodies: Record<string, string> = {};
    for (const node of projected.publication.nodes) {
      const relative = node.canonicalUri.split('/shared/default/')[1];
      expect(relative).toBeTruthy();
      const content = (yield* git(f, ['show', 'main:' + relative])).stdout;
      const record = parseMemoryDocument(node.canonicalUri, content);
      expect(record).toBeDefined();
      if (!record) throw new Error('Missing durable memory document.');
      expect(sha256HexSync(record.body.trim() + '\n')).toBe(node.bodySha256);
      expect(content).not.toContain(f.root);
      expect(content).not.toContain(f.home);
      expect(content).not.toContain('.context');
      expect(content).not.toContain('.closeout.json');
      bodies[node.key] = record.body;
    }
    return bodies;
  });
const approve = (f: Fixture, digest: string) =>
  f.closeout('publication-approve', {
    approvalDigest: digest,
    decision: 'approve',
    approvalEvidence: 'Explicit test authority approves this exact isolated private Git graph.',
  });
const verifyRetirement = (f: Fixture, owned: readonly {runId: string; uri: string; memoryId: string}[]) =>
  Effect.gen(function* () {
    const image = yield* decode(receipt)(
      JSON.parse(yield* f.fs.readFileString(f.statePath('controller') + '.closeout.json')),
    );
    expect(Object.keys(image.archives).sort()).toEqual(owned.map(i => i.uri).sort());
    for (const item of owned) {
      const archived = image.archives[item.uri];
      expect(
        (yield* decode(artifact)(yield* f.call({...f.base('read', item.runId), uri: archived.uri}))).artifact,
      ).toMatchObject({state: 'archived', memoryId: item.memoryId});
    }
    expect(
      (yield* decode(artifact)(yield* f.call({...f.base('read', 'plan-run'), uri: f.unrelated.uri}))).artifact.state,
    ).toBe('active');
  });

describe('verified personal cloud closeout', () => {
  for (const profile of ['codex-cloud-personal', 'cursor-cloud-personal'] as const) {
    it.effect(
      'publishes and independently reads the complete approved graph for ' + profile,
      () =>
        Effect.gen(function* () {
          const f = yield* nativeCloseoutFixture(true, profile);
          const loaded = yield* f.load();
          expect(loaded.spec?.kind).toBe('spec');
          expect(new Set(loaded.owned.map(i => i.runId))).toEqual(new Set(['plan-run']));
          const {proposal, projected} = yield* prepare(f);
          yield* active(f, loaded.owned);
          const wrong = yield* f
            .closeout('publication-approve', {
              approvalDigest: '0'.repeat(64),
              decision: 'approve',
              approvalEvidence: 'Wrong digest must not authorize publication.',
            })
            .pipe(Effect.result);
          expect(Result.isFailure(wrong)).toBe(true);
          yield* active(f, loaded.owned);
          yield* approve(f, projected.publication.approvalDigest);
          let verifiedBeforeFirstRemoval = false;
          const store = f.store;
          const observedStore = {
            ...store,
            remove: (
              location: Parameters<typeof store.remove>[0],
              uri: string,
              options?: Parameters<typeof store.remove>[2],
            ) =>
              Effect.gen(function* () {
                if (!verifiedBeforeFirstRemoval && loaded.owned.some(i => i.uri === uri)) {
                  yield* readRemote(f, projected);
                  verifiedBeforeFirstRemoval = true;
                }
                return yield* store.remove(location, uri, options);
              }),
          };
          const finished = yield* decode(summary)(
            yield* f.closeout('finish').pipe(Effect.provideService(ResourceStore, observedStore)),
          );
          expect(verifiedBeforeFirstRemoval).toBe(true);
          expect(finished.closeout).toMatchObject({state: 'complete', archived: loaded.owned.length});
          const bodies = yield* readRemote(f, projected);
          for (const [index, decision] of f.plan.decisions.entries()) {
            expect(bodies.architecture).toContain(decision.selected);
            expect(bodies.architecture).toContain(decision.alternatives[0].design);
            expect(bodies.architecture).toContain(decision.rationale);
            expect(bodies.architecture).toContain(proposal.decisions[index].implemented);
            expect(bodies.architecture).toContain(proposal.decisions[index].rationale);
          }
          expect(bodies.spec).toContain('Saved data.');
          for (const item of loaded.owned)
            for (const body of Object.values(bodies)) expect(body).not.toContain(item.uri);
          yield* verifyRetirement(f, loaded.owned);
          const head = (yield* git(f, ['rev-parse', 'main'])).stdout;
          const bytes = yield* f.fs.readFileString(f.statePath('controller') + '.closeout.json');
          expect(yield* decode(summary)(yield* f.closeout('finish'))).toEqual(finished);
          expect((yield* git(f, ['rev-parse', 'main'])).stdout).toBe(head);
          expect(yield* f.fs.readFileString(f.statePath('controller') + '.closeout.json')).toBe(bytes);
        }).pipe(TestClock.withLive, provideNative),
      {timeout: 60_000},
    );
  }
  it.effect(
    'retains drafts after a committed readback mismatch and retries the approved graph without duplicate commits',
    () =>
      Effect.gen(function* () {
        const f = yield* nativeCloseoutFixture(false, 'codex-cloud-personal');
        const loaded = yield* f.load();
        const {projected} = yield* prepare(f, false);
        yield* approve(f, projected.publication.approvalDigest);
        const commands = yield* CommandExecutor;
        const worktree = f.path.join(f.root, 'shared');
        let mismatched = false;
        const interrupted = CommandExecutor.of({
          ...commands,
          execute: (executable, args, options) =>
            commands.execute(executable, args, options).pipe(
              Effect.map(result => {
                if (
                  !mismatched &&
                  isGitExecutable(executable) &&
                  args[0] === '-C' &&
                  args[1] === worktree &&
                  args[2] === 'show' &&
                  /^[a-f0-9]{40}(?:[a-f0-9]{24})?:/u.test(args[3] ?? '')
                ) {
                  mismatched = true;
                  return {...result, stdout: f.root + projected.publication.nodes[0].body};
                }
                return result;
              }),
            ),
        });
        const rejected = yield* f
          .closeout('finish')
          .pipe(Effect.provideService(CommandExecutor, interrupted), Effect.result);
        expect(mismatched).toBe(true);
        expect(rejected).toMatchObject({_tag: 'Failure', failure: {code: 'publication-incomplete'}});
        if (Result.isFailure(rejected)) {
          expect(rejected.failure.message).toContain('stage architecture:create:');
          expect(rejected.failure.message).toContain('[commit-content-changed]');
          expect(rejected.failure.message).not.toContain(f.root);
          expect(rejected.failure.message).not.toContain(projected.publication.nodes[0].body);
          expect(rejected.failure.message).not.toContain('Shared publication commit content changed.');
        }
        // The actual commit exists locally, before receipt persistence or push.
        expect((yield* runCommandEffect('git', ['-C', worktree, 'rev-list', '--count', 'HEAD'])).stdout.trim()).toBe(
          '2',
        );
        expect((yield* git(f, ['rev-list', '--count', 'main'])).stdout.trim()).toBe('1');
        const committedHead = (yield* runCommandEffect('git', ['-C', worktree, 'rev-parse', 'HEAD'])).stdout;
        yield* active(f, loaded.owned);
        const state = yield* readNativeWorkflowState(f.config, f.controllerRunId);
        if (!state) throw new Error('Missing native closeout binding.');
        const publication = yield* decode(
          Schema.Struct({approvalDigest: Schema.String, decision: Schema.Literal('approve')}),
        )(
          JSON.parse(
            yield* f.fs.readFileString(
              f.path.join(f.home, 'workflow-memory', `${state.state.bindingId}.publication.json`),
            ),
          ),
        );
        expect(publication.approvalDigest).toBe(projected.publication.approvalDigest);
        expect(publication.decision).toBe('approve');
        expect((yield* decode(summary)(yield* f.closeout('finish'))).closeout.state).toBe('complete');
        expect((yield* git(f, ['rev-parse', 'main'])).stdout).toBe(committedHead);
        yield* readRemote(f, projected);
        yield* verifyRetirement(f, loaded.owned);
        expect((yield* git(f, ['rev-list', '--count', 'main'])).stdout.trim()).toBe('2');
        expect((yield* runCommandEffect('git', ['-C', worktree, 'rev-list', '--count', 'HEAD'])).stdout.trim()).toBe(
          '2',
        );
        const head = (yield* git(f, ['rev-parse', 'main'])).stdout;
        yield* f.closeout('finish');
        expect((yield* git(f, ['rev-parse', 'main'])).stdout).toBe(head);
      }).pipe(TestClock.withLive, provideNative),
    {timeout: 60_000},
  );
  it.effect(
    'retains drafts after private push rejection and retries the same approved graph without duplicates',
    () =>
      Effect.gen(function* () {
        const f = yield* nativeCloseoutFixture(true, 'codex-cloud-personal');
        const loaded = yield* f.load();
        const {projected} = yield* prepare(f);
        yield* approve(f, projected.publication.approvalDigest);
        const hook = f.path.join(f.root, 'remote.git', 'hooks', 'pre-receive');
        yield* f.fs.writeFileString(hook, '#!/bin/sh\n[ "$(git rev-list --count refs/heads/main)" -lt 2 ]\n', {
          mode: 0o700,
        });
        const rejected = yield* f.closeout('finish').pipe(Effect.result);
        expect(Result.isFailure(rejected)).toBe(true);
        if (Result.isFailure(rejected)) {
          expect(rejected.failure).toMatchObject({code: 'publication-incomplete'});
          expect(rejected.failure.message).toContain('stage spec:create');
          expect(rejected.failure.message).toContain('shared writer returned');
          expect(rejected.failure.message).not.toContain(f.root);
          expect(rejected.failure.message).not.toContain('Approved architecture');
        }
        yield* active(f, loaded.owned);
        yield* f.fs.remove(hook);
        expect((yield* decode(preview)(yield* f.closeout('publication-preview'))).publication.approvalDigest).toBe(
          projected.publication.approvalDigest,
        );
        const finished = yield* decode(summary)(yield* f.closeout('finish'));
        expect(finished.closeout.state).toBe('complete');
        yield* readRemote(f, projected);
        yield* verifyRetirement(f, loaded.owned);
        expect((yield* git(f, ['rev-list', '--count', 'main'])).stdout.trim()).toBe('4');
        const head = (yield* git(f, ['rev-parse', 'main'])).stdout;
        yield* f.closeout('finish');
        expect((yield* git(f, ['rev-parse', 'main'])).stdout).toBe(head);
      }).pipe(TestClock.withLive, provideNative),
    {timeout: 60_000},
  );
});
