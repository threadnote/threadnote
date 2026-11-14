import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Deferred, Effect, Fiber, Schema, Semaphore} from 'effect';
import {describe, expect, it} from 'vitest';
import {applySemanticChange, recoverSemanticChange, type ApplyPorts} from '../../src/apply.js';
import {ApplyFault, restoreApplyJournal, type ApplyTarget, type ApplyJournal} from '../../src/journal.js';
import {createSemanticProposal} from '../../src/proposals.js';
import {type OwnedView} from '../../src/views.js';
import {observation} from '../fixtures.js';

const digest = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex');

/** Independent resource model: actual bytes and current owners are separate from the durable journal. */
function fixture(count = 3, buffer = false) {
  const files = new Map<string, {text: string; owner: OwnedView; writable: boolean}>();
  const targets = Array.from({length: count}, (_, index) => {
    const text = `old${index}`;
    const source = {
      ...observation,
      uri: `file:///worktree/a/project/${index}.ts`,
      content: digest(text),
      view: {
        kind: buffer ? ('editor' as const) : ('disk' as const),
        id: `view${index}`,
        owner: 'private-owner',
        epoch: 1,
      },
      documentVersion: buffer ? 1 : null,
    };
    const owner = {observation: source, authority: 'qualified-writer', fence: 1};
    files.set(source.uri, {text, owner, writable: true});
    return {
      observation: source,
      beforeText: text,
      edits: [{range: {start: {line: 0, character: 0}, end: {line: 0, character: 3}}, newText: 'new'}],
      precondition: {
        sourceKind: buffer ? ('overlay' as const) : ('disk' as const),
        rawDigest: source.content,
        encoding: 'utf-8' as const,
        physicalIdentity: buffer ? null : `inode${index}`,
        owner: source.view.owner,
        documentVersion: source.documentVersion,
      },
    };
  });
  const proposal = createSemanticProposal(
    {
      version: 1,
      operation: 'rename',
      evidence: {
        basis: 'semantic',
        observation: targets[0].observation,
        scope: 'project',
        completeness: 'partial',
        limitations: [],
      },
      targets,
    },
    digest,
  );
  const owners = EffectArray.map(targets, target => files.get(target.observation.uri)!.owner);
  const binding = {
    operation: 'operation',
    principal: 'private-principal',
    worktree: observation.worktree,
    proposal: proposal.digest,
  };
  const operationGate = Semaphore.makeUnsafe(1);
  const targetGate = Semaphore.makeUnsafe(1);
  const state = {
    stored: undefined as unknown,
    authorized: true,
    qualified: true,
    writes: [] as string[],
    intents: [] as string[],
    invalidations: 0,
    lostAck: false,
    failIntent: false,
    failResult: false,
    commitThenFailResult: false,
    loseReloadAfterCommit: false,
    loadUnavailable: false,
    persistenceLog: [] as ApplyJournal[],
    beforeTarget: (_target: ApplyTarget) => {},
    afterWrite: (_uri: string) => {},
  };
  const current = (target: ApplyTarget) => {
    const file = files.get(target.before.observation.uri)!;
    return {...file.owner, observation: {...file.owner.observation, content: digest(file.text)}};
  };
  const ports: ApplyPorts = {
    withOperation: (_operation, effect) => operationGate.withPermit(effect),
    withTarget: (target, effect) =>
      targetGate.withPermit(Effect.sync(() => state.beforeTarget(target)).pipe(Effect.andThen(effect))),
    authorize: () => Effect.sync(() => state.authorized),
    load: () =>
      state.loadUnavailable
        ? Effect.fail(ApplyFault.make({reason: 'unavailable'}))
        : Effect.sync(() => structuredClone(state.stored)),
    persist: journal =>
      Effect.try({
        try: () => {
          if (state.failIntent && EffectArray.some(journal.results, result => result.state === 'intent')) {
            state.failIntent = false;
            throw new Error('private journal failure');
          }
          if (state.failResult && EffectArray.some(journal.results, result => result.state === 'applied')) {
            state.failResult = false;
            throw new Error('private result failure');
          }
          state.stored = structuredClone(journal);
          state.persistenceLog.push(structuredClone(journal));
          if (state.commitThenFailResult && EffectArray.some(journal.results, result => result.state === 'applied')) {
            state.commitThenFailResult = false;
            state.loadUnavailable = state.loseReloadAfterCommit;
            throw new Error('private acknowledgement failed after durable commit');
          }
          for (const [index, result] of journal.results.entries()) {
            if (result.state === 'intent') state.intents.push(journal.plan.targets[index].before.observation.uri);
          }
        },
        catch: () => ApplyFault.make({reason: 'unavailable'}),
      }),
    check: target =>
      Effect.sync(() => {
        if (!state.qualified) return {status: 'conflict', reason: 'unqualified-writer'} as const;
        if (!files.get(target.before.observation.uri)!.writable)
          return {status: 'conflict', reason: 'readonly'} as const;
        return {status: 'ok', current: current(target)} as const;
      }),
    mutate: (target, afterText) =>
      Effect.sync(() => {
        const uri = target.before.observation.uri;
        const file = files.get(uri)!;
        const journal = restoreApplyJournal(state.stored);
        const index = EffectArray.findFirstIndex(journal.plan.targets, t => t.before.observation.uri === uri);
        expect(index._tag).toBe('Some');
        if (index._tag === 'Some') expect(journal.results[index.value].state).toBe('intent');
        // This independent writer oracle also checks the resource immediately before mutation.
        if (!state.authorized) return {status: 'conflict', reason: 'authorization'} as const;
        if (file.text !== proposal.targets[index._tag === 'Some' ? index.value : 0].beforeText)
          return {status: 'conflict', reason: 'source-changed'} as const;
        if (file.owner.fence !== target.before.fence || file.owner.authority !== target.before.authority)
          return {status: 'conflict', reason: 'ownership'} as const;
        file.text = afterText;
        file.owner = {
          ...file.owner,
          observation: {...file.owner.observation, content: digest(afterText), documentVersion: buffer ? 2 : null},
        };
        state.writes.push(uri);
        state.afterWrite(uri);
        return state.lostAck
          ? ({status: 'unknown'} as const)
          : ({status: 'applied', current: current(target)} as const);
      }),
    inspect: target => Effect.sync(() => current(target)),
    invalidate: () =>
      Effect.sync(() => {
        state.invalidations++;
      }),
  };
  const input = {binding, proposal, owners};
  return {files, ports, state, input, run: () => applySemanticChange(input, ports, digest)};
}

describe('guarded apply core', () => {
  effectIt.effect('writes exact targets once and reconciles the same operation without replay', () =>
    Effect.gen(function* () {
      const f = fixture();
      const before = JSON.stringify(f.input);
      const receipt = yield* f.run();
      expect(receipt).toMatchObject({
        status: 'applied',
        invalidation: 'complete',
        durability: 'recorded',
        diagnostics: 'not-run',
        tests: 'not-run',
      });
      expect(Array.from(f.files.values(), file => file.text)).toEqual(['new0', 'new1', 'new2']);
      expect(f.state.writes).toHaveLength(3);
      expect(yield* f.run()).toEqual(receipt);
      expect(f.state.writes).toHaveLength(3);
      expect(f.state.invalidations).toBe(1);
      expect(JSON.stringify(f.input)).toBe(before);
      const output = JSON.stringify(receipt);
      for (const secret of ['private-owner', 'private-principal', 'file://', 'old0', 'new0'])
        expect(output).not.toContain(secret);
    }),
  );

  effectIt.effect('rejects a late preflight failure without writing an earlier eligible target', () =>
    Effect.gen(function* () {
      const f = fixture();
      f.files.get(f.input.proposal.targets[2].observation.uri)!.writable = false;
      const receipt = yield* f.run();
      expect(receipt.status).toBe('conflict');
      expect(receipt.targets[2]).toMatchObject({state: 'conflict', reason: 'readonly', observed: 'original'});
      expect(f.state.writes).toEqual([]);
      expect(f.state.intents).toEqual([]);
      expect(Array.from(f.files.values(), file => file.text)).toEqual(['old0', 'old1', 'old2']);
    }),
  );

  effectIt.effect.each(['text', 'owner', 'authorization'] as const)(
    'preserves a concurrent %s change after the first target',
    mode =>
      Effect.gen(function* () {
        const f = fixture();
        const second = f.files.get(f.input.proposal.targets[1].observation.uri)!;
        f.state.afterWrite = () => {
          if (mode === 'text') second.text = 'later-user-edit';
          if (mode === 'owner') second.owner = {...second.owner, fence: 2};
          if (mode === 'authorization') f.state.authorized = false;
        };
        const receipt = yield* f.run();
        expect(receipt.status).toBe('partial');
        expect(f.state.writes).toEqual([f.input.proposal.targets[0].observation.uri]);
        expect(second.text).toBe(mode === 'text' ? 'later-user-edit' : 'old1');
        expect(receipt.targets[1].state).toBe('conflict');
        f.state.authorized = true;
        expect((yield* recoverSemanticChange(f.input.binding, f.ports)).status).toBe('partial');
        expect(f.state.writes).toHaveLength(1);
      }),
  );

  effectIt.effect('keeps a lost buffer acknowledgement indeterminate even when intended bytes are observed', () =>
    Effect.gen(function* () {
      const f = fixture(2, true);
      f.state.lostAck = true;
      const receipt = yield* f.run();
      expect(receipt).toMatchObject({
        status: 'indeterminate',
        targets: [
          {state: 'unknown', observed: 'intended'},
          {state: 'unwritten', observed: 'original'},
        ],
      });
      f.files.get(f.input.proposal.targets[0].observation.uri)!.text = 'later-user-edit';
      const recovered = yield* f.run();
      expect(recovered.status).toBe('indeterminate');
      expect(recovered.targets[0].observed).toBe('diverged');
      expect(f.state.writes).toHaveLength(1);
    }),
  );

  effectIt.effect.each(['intent', 'result'] as const)('stops safely when durable %s persistence fails', boundary =>
    Effect.gen(function* () {
      const f = fixture();
      f.state.failIntent = boundary === 'intent';
      f.state.failResult = boundary === 'result';
      const receipt = yield* f.run();
      expect(receipt.status).toBe('indeterminate');
      expect(f.state.writes).toHaveLength(boundary === 'intent' ? 0 : 1);
      const writes = [...f.state.writes];
      expect((yield* f.run()).status).toBe('indeterminate');
      expect(f.state.writes).toEqual(writes);
    }),
  );

  effectIt.effect.each([false, true])(
    'preserves a durable applied result after its persistence acknowledgement fails (reload unavailable: %s)',
    unavailable =>
      Effect.gen(function* () {
        const f = fixture(1);
        f.state.commitThenFailResult = true;
        f.state.loseReloadAfterCommit = unavailable;
        const receipt = yield* f.run();
        expect(receipt).toMatchObject(
          unavailable
            ? {status: 'indeterminate', durability: 'unconfirmed'}
            : {status: 'applied', durability: 'recorded'},
        );
        expect(restoreApplyJournal(f.state.stored).results[0].state).toBe('applied');
        expect(f.state.writes).toHaveLength(1);
        if (unavailable) expect(f.state.persistenceLog).toHaveLength(3);
        f.state.loadUnavailable = false;
        f.files.get(f.input.proposal.targets[0].observation.uri)!.text = 'later-user-edit';
        const recovered = yield* recoverSemanticChange(f.input.binding, f.ports);
        expect(recovered.status).toBe('applied');
        expect(recovered.targets[0]).toMatchObject({state: 'applied', observed: 'diverged'});
        expect(yield* f.run()).toEqual(recovered);
        expect(f.state.writes).toHaveLength(1);
        const revisions = EffectArray.map(f.state.persistenceLog, journal => journal.revision);
        expect(new Set(revisions).size).toBe(revisions.length);
        for (const journal of f.state.persistenceLog) {
          if (journal.revision >= 2) expect(journal.results[0].state).toBe('applied');
        }
      }),
  );

  effectIt.effect(
    'reconstructs tagged host and validation failures without private excess fields or nested exceptions',
    () =>
      Effect.gen(function* () {
        const f = fixture(1);
        const error = Object.assign(ApplyFault.make({reason: 'unavailable'}), {
          privateSource: 'SYNTHETIC_PRIVATE_SOURCE',
          capability: 'SYNTHETIC_CAPABILITY',
          cause: new Error('SYNTHETIC_EXCEPTION'),
        });
        const ports: ApplyPorts = {...f.ports, load: () => Effect.fail(error)};
        const failures = [
          yield* applySemanticChange(f.input, ports, digest).pipe(Effect.flip),
          yield* recoverSemanticChange(f.input.binding, ports).pipe(Effect.flip),
          yield* applySemanticChange(f.input, f.ports, () => {
            throw error;
          }).pipe(Effect.flip),
        ];
        for (const failure of failures) {
          expect(failure).not.toBe(error);
          expect(JSON.parse(JSON.stringify(failure))).toEqual({_tag: 'ApplyFault', reason: 'unavailable'});
          expect(String(failure)).not.toContain('SYNTHETIC');
        }
        expect(f.state.writes).toEqual([]);
      }),
  );

  effectIt.effect('preserves durable intent across interruption and never calls a writer during recovery', () =>
    Effect.gen(function* () {
      const f = fixture();
      const entered = yield* Deferred.make<void>();
      const ports: ApplyPorts = {
        ...f.ports,
        mutate: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      };
      const pending = yield* Effect.forkChild(applySemanticChange(f.input, ports, digest));
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(pending);
      expect(restoreApplyJournal(f.state.stored).results[0].state).toBe('intent');
      const recovered = yield* recoverSemanticChange(f.input.binding, {
        ...ports,
        mutate: () => Effect.die('Recovery issued a mutation'),
      });
      expect(recovered.status).toBe('indeterminate');
      expect(recovered.targets[0]).toMatchObject({state: 'intent', observed: 'original'});
      expect(f.state.writes).toEqual([]);
    }),
  );

  effectIt.effect('requires current task authorization and a separately qualified owner', () =>
    Effect.gen(function* () {
      const f = fixture(1, true);
      f.state.authorized = false;
      expect(yield* f.run().pipe(Effect.flip)).toMatchObject({reason: 'unauthorized'});
      f.state.authorized = true;
      f.state.qualified = false;
      expect((yield* f.run()).targets[0]).toMatchObject({state: 'conflict', reason: 'unqualified-writer'});
      expect(f.state.writes).toEqual([]);
    }),
  );

  effectIt.effect('refuses a complete unsupported ordered sequence before admission or writing', () =>
    Effect.gen(function* () {
      const f = fixture(1);
      const proposal = createSemanticProposal(
        {
          version: 2,
          operation: 'code-action',
          qualification: 'unsupported-operation-sequence',
          evidence: f.input.proposal.evidence,
          targets: [],
          operations: [{kind: 'create', uri: 'file:///worktree/a/project/new.ts'}],
        },
        digest,
      );
      expect(
        yield* applySemanticChange(
          {binding: {...f.input.binding, proposal: proposal.digest}, proposal, owners: []},
          f.ports,
          digest,
        ).pipe(Effect.flip),
      ).toMatchObject({reason: 'invalid-input'});
      expect(f.state.stored).toBeUndefined();
      expect(f.state.writes).toEqual([]);
    }),
  );

  effectIt.effect('rejects operation identity reuse and malformed restored journals', () =>
    Effect.gen(function* () {
      const f = fixture(1);
      yield* f.run();
      const changed = {...f.input, binding: {...f.input.binding, principal: 'different-principal'}};
      expect(yield* applySemanticChange(changed, f.ports, digest).pipe(Effect.flip)).toMatchObject({
        reason: 'identity-conflict',
      });
      expect(() => restoreApplyJournal({...restoreApplyJournal(f.state.stored), injectedGrant: true})).toThrow();
      const journal = restoreApplyJournal(f.state.stored);
      expect(() => restoreApplyJournal({...journal, results: []})).toThrow();
      expect(f.state.writes).toHaveLength(1);
    }),
  );

  effectIt.effect.prop(
    'preserves acknowledged results across generated concurrent changes, persistence outcomes and read-only retries',
    [
      Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 8})),
      Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 15})),
      Schema.Boolean,
      Schema.Boolean,
    ],
    ([count, selected, changeOwner, commitThenFail]) =>
      Effect.gen(function* () {
        const f = fixture(count);
        const stop = selected % count;
        const stopped = f.input.proposal.targets[stop].observation.uri;
        const original = JSON.stringify(f.input);
        f.state.commitThenFailResult = commitThenFail;
        f.state.beforeTarget = target => {
          if (target.before.observation.uri !== stopped) return;
          const file = f.files.get(stopped)!;
          if (changeOwner) file.owner = {...file.owner, fence: 2};
          else file.text = 'user-edit';
        };
        const receipt = yield* f.run();
        expect(receipt.status).toBe(stop === 0 ? 'conflict' : 'partial');
        const written = commitThenFail && stop > 0 ? 1 : stop;
        expect(f.state.writes).toEqual(
          EffectArray.map(EffectArray.take(f.input.proposal.targets, written), target => target.observation.uri),
        );
        const actual = Array.from(f.files, ([uri, file]) => [uri, file.text, file.owner.fence]);
        yield* f.run();
        const first = yield* recoverSemanticChange(f.input.binding, f.ports);
        const second = yield* recoverSemanticChange(f.input.binding, f.ports);
        expect(second).toEqual(first);
        expect(Array.from(f.files, ([uri, file]) => [uri, file.text, file.owner.fence])).toEqual(actual);
        expect(f.state.writes).toHaveLength(written);
        const revisions = EffectArray.map(f.state.persistenceLog, journal => journal.revision);
        expect(new Set(revisions).size).toBe(revisions.length);
        for (const [index, prior] of f.state.persistenceLog.entries()) {
          const next = f.state.persistenceLog[index + 1];
          if (!next) continue;
          expect(next.revision).toBeGreaterThan(prior.revision);
          for (const [target, result] of prior.results.entries()) {
            if (result.state === 'applied') expect(next.results[target]).toEqual(result);
          }
        }
        expect(JSON.stringify(f.input)).toBe(original);
      }),
    {arbitrary: {runs: 40}},
  );

  it('rejects a restored applied acknowledgement that still identifies the original bytes', () => {
    const f = fixture(1);
    const target = f.input.proposal.targets[0];
    // Full malformed persistence is rejected at the schema boundary, before any writer is available.
    expect(() =>
      restoreApplyJournal({
        version: 1,
        revision: 0,
        plan: {
          binding: f.input.binding,
          targets: [
            {
              before: f.input.owners[0],
              after: digest('new0'),
              sourceKind: target.precondition.sourceKind,
              physicalIdentity: target.precondition.physicalIdentity,
            },
          ],
        },
        results: [{state: 'applied', current: f.input.owners[0]}],
        observed: [null],
        invalidation: 'pending',
      }),
    ).toThrow();
  });
});
