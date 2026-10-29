import {it as effectIt} from '@effect/vitest';
import {Array as Arr, Effect, Option, String} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {hash, json, stableJson} from '../../src/dev_skills/files.js';
import {loadDevSkillsBundleAt} from '../../src/dev_skills/manifest.js';
import {
  applyDevSkills,
  prepareDevSkillsRefresh,
  previewDevSkillsRefresh,
  runDevSkillsRefresh,
} from '../../src/dev_skills/index.js';
import {parseRefreshState, refreshStatePath} from '../../src/dev_skills/refresh_state.js';
import {planMutation} from '../../src/dev_skills/plan.js';
import {journalPath} from '../../src/dev_skills/registry.js';
import {readTransactionConsumer, recoverTransaction} from '../../src/dev_skills/transaction.js';
import {withDevSkillsMutationLease, withPhysicalLock} from '../../src/dev_skills/lease.js';
import {devSkillsReleaseFixture, devSkillsTestLayer, fixture, snapshot} from './service-fixture.js';
import {historicalBundle, retainedRefreshState} from './historical-refresh-fixture.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const selector = {agent: 'codex'};
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(TestClock.withLive, provideTestLayer(devSkillsTestLayer));

describe('retained manifest journal compatibility', () => {
  effectIt.effect('preserves nonempty schema1/2 request fingerprints, outcomes and original bytes', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const current = yield* loadDevSkillsBundleAt(f.source, '5.3.0-beta.7');
      const target = (yield* f.run(planMutation(f.config, current, 'install', selector))).consumer;
      fc.assert(
        fc.property(
          fc.integer({min: 1, max: 8}),
          fc.constantFrom('current' as const, 'pending' as const, 'skipped' as const),
          fc.boolean(),
          (count, outcome, legacy) => {
            const bundle = legacy ? historicalBundle(current) : current;
            const consumers = Array.from({length: count}, (_, index) => ({
              ...target,
              home: f.path.join(f.home, `member-${index}`),
            }));
            const state = retainedRefreshState(f.path, bundle, consumers, outcome);
            const bytes = json(state);
            const input = JSON.parse(bytes);
            const inputBefore = JSON.stringify(input);
            const decoded = parseRefreshState(input, f.runtime, f.path);
            expect(decoded).toEqual(state);
            expect(hash(stableJson(decoded.request))).toBe(state.intentId);
            expect(parseRefreshState(decoded, f.runtime, f.path)).toEqual(decoded);
            expect(JSON.stringify(input)).toBe(inputBefore);
            expect(json(state)).toBe(bytes);
            const invalid = JSON.parse(JSON.stringify(state));
            delete invalid.request.members[0].enrollment.enabled;
            const invalidBefore = JSON.stringify(invalid);
            expect(() => parseRefreshState(invalid, f.runtime, f.path)).toThrow('Invalid enrollment enablement');
            expect(JSON.stringify(invalid)).toBe(invalidBefore);
            expect(() => parseRefreshState({...state, intentId: hash('wrong fingerprint')}, f.runtime, f.path)).toThrow(
              'fingerprint',
            );
            const badManifest = JSON.parse(JSON.stringify(state));
            badManifest.request.desired.hashes['dev-cycle/SKILL.md'] = hash('foreign bytes');
            const badManifestBefore = JSON.stringify(badManifest);
            expect(() => parseRefreshState(badManifest, f.runtime, f.path)).toThrow('digest');
            expect(JSON.stringify(badManifest)).toBe(badManifestBefore);
            expect(() => parseRefreshState({...state, unknown: true}, f.runtime, f.path)).toThrow('Unknown');
          },
        ),
        {numRuns: 24},
      );
    }).pipe(provide),
  );

  for (const outcome of ['current', 'pending', 'skipped'] as const)
    effectIt.effect(`archives original ${outcome} schema1 history byte-for-byte and retries the same new intent`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const installed = yield* f.run(applyDevSkills(f.config, 'install', selector));
        const current = yield* loadDevSkillsBundleAt(f.source, '5.3.0-beta.7');
        const consumer = {home: f.home, installationRoot: f.runtime, target: installed.target};
        const old = retainedRefreshState(f.path, historicalBundle(current), [consumer], outcome);
        const raw = JSON.stringify(old, null, 4) + '\n\n';
        yield* f.fs.writeFileString(refreshStatePath(f.path, f.runtime), raw);
        const release = yield* devSkillsReleaseFixture(f, '5.3.0-beta.10');
        const preview = yield* f.run(previewDevSkillsRefresh(f.config, release));
        const prepared = yield* f.run(
          prepareDevSkillsRefresh(f.config, preview, {expectedDigest: preview.previewDigest}),
        );
        expect(
          yield* f.fs.readFileString(f.path.join(f.runtime, 'dev-skills-refresh-history', `${old.intentId}.json`)),
        ).toBe(raw);
        yield* release.activate;
        expect((yield* release.run(runDevSkillsRefresh(f.config, prepared.intentId))).repairRequired).toBe(false);
        const retry = yield* release.run(previewDevSkillsRefresh(f.config, release));
        expect(
          (yield* release.run(prepareDevSkillsRefresh(f.config, retry, {expectedDigest: retry.previewDigest})))
            .intentId,
        ).toBe(prepared.intentId);
        expect(
          yield* f.fs.readFileString(f.path.join(f.runtime, 'dev-skills-refresh-history', `${old.intentId}.json`)),
        ).toBe(raw);
      }).pipe(provide),
    );

  effectIt.effect('replays a captured schema1 transaction with its original owner and rejects foreign bytes', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const bundle = historicalBundle(yield* loadDevSkillsBundleAt(f.source, '5.3.0-beta.7'));
      const mutation = yield* f.run(planMutation(f.config, bundle, 'install', selector));
      const journal = {
        schemaVersion: 1,
        consumer: mutation.consumer,
        previewDigest: mutation.plan.previewDigest,
        generation: mutation.generation,
        changes: mutation.changes,
        enabled: true,
      };
      const file = journalPath(f.path, mutation.consumer.target.skillRoot);
      yield* f.fs.makeDirectory(f.path.dirname(file), {recursive: true});
      const original = json(journal);
      yield* f.fs.writeFileString(file, original);
      yield* f.fs.makeDirectory(f.runtime, {recursive: true});
      expect(yield* readTransactionConsumer(mutation.consumer.target.skillRoot)).toEqual(mutation.consumer);
      const recovery = (consumer = mutation.consumer) =>
        f.run(
          withDevSkillsMutationLease(f.config, () =>
            withPhysicalLock(consumer.target.skillRoot, recoverTransaction(consumer)),
          ),
        );
      const before = yield* snapshot(f.root);
      expect(
        yield* recovery({...mutation.consumer, home: f.path.join(f.root, 'foreign')}).pipe(Effect.result),
      ).toMatchObject({_tag: 'Failure', failure: {code: 'recovery-needed'}});
      expect(yield* snapshot(f.root)).toEqual(before);
      const discovery = Option.getOrThrow(
        Arr.findFirst(mutation.changes, change => String.endsWith('SKILL.md')(change.path)),
      );
      yield* f.fs.makeDirectory(f.path.dirname(discovery.path), {recursive: true});
      yield* f.fs.writeFileString(discovery.path, 'third-party');
      const drift = yield* snapshot(f.root);
      expect(yield* recovery().pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
        failure: {code: 'recovery-conflict'},
      });
      expect(yield* snapshot(f.root)).toEqual(drift);
      yield* f.fs.remove(discovery.path);
      expect(yield* recovery()).toBe(true);
      expect(yield* f.fs.exists(file)).toBe(false);
      expect(yield* f.fs.readFileString(discovery.path)).toBe(discovery.after);
      // Historical reading cannot admit this old manifest as a fresh candidate.
      yield* f.fs.writeFileString(f.manifest, json(bundle.manifest));
      const stable = yield* snapshot(f.root);
      expect(
        yield* loadDevSkillsBundleAt(f.source, bundle.manifest.releaseVersion, true).pipe(Effect.result),
      ).toMatchObject({_tag: 'Failure'});
      expect(yield* snapshot(f.root)).toEqual(stable);
    }).pipe(provide),
  );
});
