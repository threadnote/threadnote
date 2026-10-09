import {it as effectIt} from '@effect/vitest';
import {Effect, Redacted} from 'effect';
import {describe, expect} from 'vitest';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {admittedSourceFetch, sourceAccountKey, SourceHttpAdmission} from '../src/source-coordinator.js';

const config = {
  account: 'local',
  agentContextHome: '/synthetic-home',
  agentId: 'test',
  manifestPath: '/unused',
  user: 'test',
} satisfies RuntimeConfig;
const token = Redacted.make('SYNTHETIC_API_KEY');

describe('source HTTP admission boundary', () => {
  effectIt.effect('preserves the injected Promise fetch boundary without an admission service', () =>
    Effect.gen(function* () {
      const fetchImpl = () => Promise.resolve(new Response('ok'));
      expect(yield* admittedSourceFetch('synthetic', token, fetchImpl)).toBe(fetchImpl);
    }),
  );

  effectIt.effect('shares opaque account and explicit home identity and records server cooldown before returning', () =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      const wrapped = yield* admittedSourceFetch(
        'synthetic',
        token,
        () => Promise.resolve(new Response('limited', {status: 429, headers: {'retry-after': '120'}})),
        config,
      ).pipe(
        Effect.provideService(SourceHttpAdmission, {
          admit: request =>
            Effect.sync(() => {
              calls.push(request);
            }),
          cooldown: request =>
            Effect.sync(() => {
              calls.push(request);
            }),
        }),
      );
      const response = yield* Effect.tryPromise(() =>
        wrapped(new URL('https://synthetic.invalid/api'), {method: 'POST'}),
      );
      expect(response.status).toBe(429);
      expect(calls).toEqual([
        {provider: 'synthetic', config, accountKey: sourceAccountKey('synthetic', token), method: 'POST'},
        {
          provider: 'synthetic',
          config,
          accountKey: sourceAccountKey('synthetic', token),
          method: 'POST',
          retryAfterMs: 120_000,
        },
      ]);
      expect(JSON.stringify(calls)).not.toContain(Redacted.value(token));
    }),
  );

  effectIt.effect('fails closed when production admission has no explicit home', () =>
    Effect.gen(function* () {
      const result = yield* admittedSourceFetch('synthetic', token).pipe(
        Effect.provideService(SourceHttpAdmission, {admit: () => Effect.void, cooldown: () => Effect.void}),
        Effect.result,
      );
      expect(result._tag).toBe('Failure');
    }),
  );

  effectIt.effect('honors cancellation before calling the network', () =>
    Effect.gen(function* () {
      let fetched = false;
      const wrapped = yield* admittedSourceFetch(
        'synthetic',
        token,
        () => {
          fetched = true;
          return Promise.resolve(new Response('ok'));
        },
        config,
      ).pipe(Effect.provideService(SourceHttpAdmission, {admit: () => Effect.never, cooldown: () => Effect.void}));
      const signal = AbortSignal.abort();
      const result = yield* Effect.tryPromise(() => wrapped(new URL('https://synthetic.invalid/api'), {signal})).pipe(
        Effect.result,
      );
      expect(result._tag).toBe('Failure');
      expect(fetched).toBe(false);
    }),
  );
});
