import {it as effectIt} from '@effect/vitest';
import {Effect, Schema} from 'effect';
import {describe, expect, it, vi} from 'vitest';

import {CommandExecutor, CommandFailed, CommandTimedOut} from '@threadnote/platform/command';
import {
  ProcedureRuntimeError,
  procedureRuntimeStatus,
  verifyLocalProcedure,
} from '@threadnote/threadnote/procedure/runtime';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const manifest = {
  artifact: {id: 'team.example/review', semanticVersion: '1.2.3', sha256: Effect2.pipe('a', EffectString.repeat(64))},
  compatible: {capabilities: ['filesystem.read'], surfaceIds: ['terminal']},
  dependencies: [],
  owner: 'owner',
  presentation: {summary: 'Run the reviewed repository verification workflow.', taskKeywords: ['review']},
  relatedDurableMemoryIds: [],
  reviewedOn: '2026-09-17',
  rollout: {channel: 'stable', percentage: 100},
  schemaVersion: 2,
  verification: {
    commands: [
      {argv: ['setup', '--prepare'], id: 'z-setup'},
      {argv: ['check'], id: 'a-check'},
    ],
    fixtures: [{id: 'fixture', sha256: Effect2.pipe('b', EffectString.repeat(64))}],
  },
} as const;

const metadata = {
  hostVersion: 'test-host',
  threadnoteVersion: '5.0.0',
  verifiedAt: '2026-09-17T12:00:00.000Z',
  verifier: 'test-verifier',
} as const;

const commandExecutor = (execute: Parameters<typeof CommandExecutor.of>[0]['execute']) =>
  CommandExecutor.of({execute, executeStreaming: () => Effect.die('not used')});

describe('verified procedure runtime', () => {
  effectIt.effect(
    'runs only the selected local manifest commands with bounded command options and returns a receipt',
    () =>
      Effect.gen(function* () {
        const calls: Array<{executable: string; args: readonly string[]; timeoutMs?: number; maxOutputBytes?: number}> =
          [];
        const result = yield* verifyLocalProcedure({
          manifest,
          manifestPath: '/author-selected/procedure.json',
          metadata,
          timeoutMs: 321,
        }).pipe(
          Effect.provideService(
            CommandExecutor,
            commandExecutor((executable, args, options) =>
              Effect.sync(() => {
                calls.push({executable, args, timeoutMs: options?.timeoutMs, maxOutputBytes: options?.maxOutputBytes});
                return {exitCode: 0, stderr: '', stdout: ''};
              }),
            ),
          ),
        );

        expect(calls).toEqual([
          {executable: 'setup', args: ['--prepare'], timeoutMs: 321, maxOutputBytes: 65_536},
          {executable: 'check', args: [], timeoutMs: 321, maxOutputBytes: 65_536},
        ]);
        expect(result.executedCommandIds).toEqual(['z-setup', 'a-check']);
        expect(result.receipt?.commandIds).toEqual(['z-setup', 'a-check']);
      }),
  );

  effectIt.effect('does not execute commands in preview or dry-run mode', () =>
    Effect.gen(function* () {
      const execute = vi.fn(() => Effect.die('must not run'));
      for (const mode of [{preview: true}, {dryRun: true}] as const) {
        const result = yield* verifyLocalProcedure({
          manifest,
          manifestPath: '/author-selected/procedure.json',
          metadata,
          ...mode,
        }).pipe(Effect.provideService(CommandExecutor, commandExecutor(execute)));
        expect(result).toEqual({executedCommandIds: [], receipt: undefined});
      }
      expect(execute).not.toHaveBeenCalled();
    }),
  );

  effectIt.effect('redacts failed and timed-out command details from verification errors', () =>
    Effect.gen(function* () {
      const base = {args: ['--token=secret'], executable: 'test', message: 'secret output'};
      for (const error of [
        CommandFailed.make({...base, exitCode: 1, stderr: 'secret stderr', stdout: 'secret stdout'}),
        CommandTimedOut.make({...base, timeoutMs: 50}),
      ]) {
        const failure = yield* Effect.flip(
          verifyLocalProcedure({manifest, manifestPath: '/author-selected/procedure.json', metadata}).pipe(
            Effect.provideService(
              CommandExecutor,
              commandExecutor(() => Effect.fail(error)),
            ),
          ),
        );
        expect(failure).toEqual(
          ProcedureRuntimeError.make({
            message: Schema.is(CommandTimedOut)(error)
              ? 'Verification command z-setup timed out.'
              : 'Verification command z-setup failed.',
          }),
        );
        expect(failure.message).not.toContain('secret');
      }
    }),
  );

  it('returns unverified when a receipt does not match the local content hash', () => {
    const receipt = {
      artifact: manifest.artifact,
      commandIds: ['z-setup', 'a-check'],
      fixtureDigests: manifest.verification.fixtures,
      ...metadata,
      manifestSha256: Effect2.pipe('c', EffectString.repeat(64)),
      schemaVersion: 1,
    };
    expect(
      procedureRuntimeStatus({
        capabilities: ['filesystem.read'],
        localArtifactSha256: manifest.artifact.sha256,
        manifest,
        receipt,
        surfaceIds: ['terminal'],
      }),
    ).toBe('unverified');
  });
});
