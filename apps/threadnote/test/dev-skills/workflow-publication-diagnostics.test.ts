import {it} from '@effect/vitest';
import {Cause, Effect, Schema} from 'effect';
import {expect} from 'vitest';
import {publicationDiagnostics} from './workflow-publication-diagnostics.js';

it.effect('classifies Git operations through resolved Unix and Windows executables without recording paths', () =>
  Effect.gen(function* () {
    const diagnostics = publicationDiagnostics();
    for (const executable of [
      'git',
      'git.exe',
      '/usr/bin/git',
      'C:\\Program Files\\Git\\bin\\git.exe',
      'C:/Git/bin/git.exe',
    ]) {
      yield* diagnostics.observe(executable, ['-C', '/private/repo', 'push', 'origin', 'main'], Effect.void);
    }
    yield* diagnostics.observe('/private/unknown', ['private-argument'], Effect.void);
    const report = diagnostics.snapshot();
    expect(report.recent.map(command => command.operation)).toEqual(['push', 'push', 'push', 'push', 'push', 'other']);
    expect(JSON.stringify(report)).not.toContain('private');
    expect(JSON.stringify(report)).not.toContain('Program Files');
  }),
);

it.effect('observes results, failures and interruption without replacing them', () =>
  Effect.gen(function* () {
    const diagnostics = publicationDiagnostics();
    const value = {approved: true};
    expect(yield* diagnostics.observe('git', ['status'], Effect.succeed(value))).toBe(value);
    expect(yield* diagnostics.observe('git', ['show'], Effect.fail('original')).pipe(Effect.result)).toMatchObject({
      _tag: 'Failure',
      failure: 'original',
    });
    const interrupted = yield* diagnostics.observe('git', ['fetch'], Effect.interrupt).pipe(Effect.exit);
    expect(interrupted._tag).toBe('Failure');
    if (interrupted._tag === 'Failure') expect(Cause.hasInterrupts(interrupted.cause)).toBe(true);
    expect(diagnostics.snapshot()).toMatchObject({
      commandCount: 3,
      activeCount: 0,
      recent: [{outcome: 'Success'}, {outcome: 'Failure'}, {outcome: 'Failure'}],
    });
  }),
);

it.effect.prop(
  'bounds observations and excludes command inputs without mutating them',
  {secret: Schema.String},
  ({secret}) =>
    Effect.gen(function* () {
      let time = 0;
      const diagnostics = publicationDiagnostics(() => time++);
      const args = Object.freeze(['-C', `/private/${secret}`, 'show', `private-body:${secret}`]);
      const before = [...args];
      diagnostics.phase('publish');
      const initial = diagnostics.snapshot();
      for (let index = 0; index < 40; index++) {
        const during = yield* diagnostics.observe(
          'git',
          args,
          Effect.sync(() => diagnostics.snapshot()),
        );
        expect(during.activeCount).toBe(1);
        expect(during.active).toMatchObject([{operation: 'show'}]);
      }
      const report = diagnostics.snapshot();
      expect(report.recent).toHaveLength(16);
      expect(report.recent.map(command => command.sequence)).toEqual(
        Array.from({length: 16}, (_, index) => index + 25),
      );
      expect(report.activeCount).toBe(0);
      expect(initial.commandCount).toBe(0);
      expect(args).toEqual(before);
      expect(JSON.stringify(report)).not.toContain('private-body:');
      expect(JSON.stringify(report)).not.toContain('/private/');
      expect(report.phase).toBe('publish');
      expect(report.phaseElapsedMs).toBeGreaterThan(0);
    }),
  {arbitrary: {runs: 30}},
);
