import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Effect, Layer, Result, Schema} from 'effect';
import {describe, expect} from 'vitest';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo} from '@threadnote/platform/system';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {
  readRecallIndexData,
  readRecallIndexDataBatch,
  readRecallMemoryLinks,
  RecallReadyReadUnavailable,
} from '@threadnote/recall/index';
import {
  RecallReadyReadBoundary,
  RecallReadyReadBoundaryError,
  type RecallReadyReadRequest,
  type RecallReadyReadResponse,
} from '@threadnote/recall/read_boundary';

const platform = Layer.mergeAll(
  BunServices.layer,
  cryptoLayer,
  SystemInfo.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: import.meta.path}),
        Layer.succeed(ChildEnvironmentPolicy, {preserveIntendedChild: env => env, sanitizeExternal: env => env}),
      ),
    ),
  ),
);
const config = {account: 'local', agentContextHome: '/must-not-open', user: 'test'};
const empty = {
  candidates: [],
  corpusStatistics: {averageDocumentLength: 1, documentCount: 0, documentFrequency: {}, totalDocumentLength: 0},
  generation: 'ready',
  queryExhaustive: true,
  readState: {freshness: 'current', maintenance: 'unneeded'},
};
const response = (
  request: RecallReadyReadRequest,
  extra: Partial<RecallReadyReadResponse> = {},
): RecallReadyReadResponse => ({
  protocol: 1,
  binding: 'test',
  operation: request.operation,
  outcome: 'success',
  observations: [],
  maintenanceRequested: false,
  value: empty,
  ...extra,
});
const provide = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  read: Parameters<typeof RecallReadyReadBoundary.of>[0]['read'],
) =>
  Effect.scoped(
    Layer.build(platform).pipe(
      Effect.flatMap(context =>
        effect.pipe(Effect.provideService(RecallReadyReadBoundary, {read}), Effect.provide(context)),
      ),
    ),
  );

describe('ready recall boundary', () => {
  effectIt.effect('empty selection batches return no evidence without crossing the native boundary', () =>
    Effect.gen(function* () {
      for (const includeInactive of [false, true]) {
        const result = yield* provide(readRecallIndexDataBatch(config, {includeInactive, selections: []}), () =>
          Effect.die('An empty selection must not launch a ready-read worker.'),
        );
        expect(result).toEqual([]);
      }
    }),
  );

  effectIt.effect('passes full scope and replays diagnostics per batch selection without opening an index', () => {
    const calls: number[] = [];
    let seen: RecallReadyReadRequest | undefined;
    return readRecallIndexDataBatch(config, {
      includeInactive: false,
      selections: EffectArray.map([0, 1], ordinal => ({
        query: `query-${ordinal}`,
        allowedUriScopes: ['threadnote://user/test/memories'],
        eligibility: {
          kind: 'candidate-policy' as const,
          authority: 'any' as const,
          projects: {mode: 'allow-projects-and-projectless' as const, projects: ['allowed']},
        },
        onQueryDiagnostics: () =>
          Effect.sync(() => {
            calls.push(ordinal);
          }),
      })),
    }).pipe(
      Effect.tap(value =>
        Effect.sync(() => {
          expect(value).toEqual([empty, empty]);
          expect(calls).toEqual([1, 0]);
          expect(seen?.operation).toBe('batch');
          if (seen?.operation === 'batch') {
            expect(seen.options.selections[0]?.allowedUriScopes).toEqual(['threadnote://user/test/memories']);
            expect('onQueryDiagnostics' in seen.options.selections[0]).toBe(false);
          }
        }),
      ),
      effect =>
        provide(effect, request =>
          Effect.sync(() => {
            seen = request;
            return response(request, {
              value: [empty, empty],
              observations: EffectArray.map([1, 0], selectionOrdinal => ({
                kind: 'query' as const,
                selectionOrdinal,
                value: {postingRows: 1, postingStatements: 1, queryTerms: 1},
              })),
            });
          }),
        ),
    );
  });

  effectIt.effect(
    'transports the source instant and canonical record callbacks without weakening link semantics',
    () => {
      const instant = new Date('2026-11-04T01:00:00.000Z');
      const uri = 'threadnote://user/test/memories/durable/source.md';
      const content = formatMemoryDocument(
        'MEMORY',
        {
          kind: 'durable',
          status: 'active',
          timestamp: instant.toISOString(),
          sourceAgentClient: 'test',
          memoryId: 'tn_boundary_source',
        },
        'source proof',
      );
      let records = 0;
      let mismatch = 0;
      return readRecallMemoryLinks(config, {
        includeInactive: false,
        memorySeeds: [{memoryId: 'tn_seed', requestedOrdinal: 0}],
        sourceCurrentAt: instant,
        onCanonicalRecords: values => {
          records += values.length;
          expect(values[0]?.body).toBe('source proof');
        },
        onCanonicalMismatch: count => {
          mismatch += count;
        },
      }).pipe(
        Effect.tap(value =>
          Effect.sync(() => {
            expect(value).toEqual([]);
            expect(records).toBe(1);
            expect(mismatch).toBe(2);
          }),
        ),
        effect =>
          provide(effect, request =>
            Effect.sync(() => {
              expect(request.operation).toBe('memory-links');
              if (request.operation === 'memory-links')
                expect(request.options.sourceCurrentAt).toBe(instant.toISOString());
              return response(request, {
                value: [],
                observations: [
                  {kind: 'records', value: [{uri, content}]},
                  {kind: 'mismatch', value: 2},
                ],
              });
            }),
          ),
      );
    },
  );

  effectIt.effect('preserves readiness versus operational failure taxonomy and mismatch observations on failure', () =>
    Effect.gen(function* () {
      for (const outcome of ['unavailable', 'failed'] as const) {
        let mismatch = 0;
        const result = yield* provide(
          readRecallMemoryLinks(config, {
            includeInactive: false,
            memorySeeds: [],
            onCanonicalMismatch: count => {
              mismatch += count;
            },
          }).pipe(Effect.result),
          request => Effect.succeed(response(request, {outcome, observations: [{kind: 'mismatch', value: 1}]})),
        );
        expect(mismatch).toBe(1);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(Schema.is(RecallReadyReadUnavailable)(result.failure)).toBe(outcome === 'unavailable');
      }
      const exhausted = yield* provide(readRecallIndexData(config, {includeInactive: false}).pipe(Effect.result), () =>
        Effect.fail(RecallReadyReadBoundaryError.make({reason: 'budget-exhausted'})),
      );
      expect(Result.isFailure(exhausted) && Schema.is(RecallReadyReadUnavailable)(exhausted.failure)).toBe(true);
    }),
  );

  effectIt.effect('fails closed on malformed authorized result envelopes', () =>
    provide(
      readRecallIndexData(config, {includeInactive: false}).pipe(
        Effect.result,
        Effect.tap(result =>
          Effect.sync(() => {
            expect(Result.isFailure(result)).toBe(true);
          }),
        ),
      ),
      request =>
        Effect.succeed(response(request, {value: {...empty, candidates: [{uri: 'threadnote://private', text: 42}]}})),
    ),
  );
});
