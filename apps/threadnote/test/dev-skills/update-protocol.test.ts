import {it as effectIt} from '@effect/vitest';
import {Array as A, Effect, String as S} from 'effect';
import fc from 'fast-check';
import {expect, it} from 'vitest';
import {CommandExecutor} from '@threadnote/platform/command';
import {
  parseDevSkillsUpdateStatus,
  parsePreparedDevSkillsUpdate,
  prepareCandidateDevSkillsUpdate,
  projectDevSkillsUpdateStatus,
} from '../../src/dev_skills/update_protocol.js';
import {prepareReleaseDevSkills, refreshReleaseDevSkills} from '../../src/release/dev_skills_update.js';
import {devSkillsReleaseFixture, devSkillsTestLayer, fixture} from './service-fixture.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {SystemInfo} from '@threadnote/platform/system';
import {DevSkillsSource} from '../../src/dev_skills/manifest.js';
import type {DevSkillsRefreshResult} from '../../src/dev_skills/contract.js';

const prepared = {
  protocolVersion: 1 as const,
  intentId: S.repeat(64)('a'),
  release: {
    installationRoot: '/installation',
    releaseRoot: '/installation/versions/5.3.0-beta.9',
    releaseVersion: '5.3.0-beta.9',
    bundleDigest: S.repeat(64)('b'),
  },
};
const status = {...prepared, current: 1, skipped: 0, pending: 0, repairRequired: false, diagnostics: []};

it('round-trips bounded updater results without changing caller input', () => {
  fc.assert(
    fc.property(
      fc.record({
        current: fc.integer({min: 0, max: 64}),
        skipped: fc.integer({min: 0, max: 64}),
        pending: fc.integer({min: 0, max: 64}),
        diagnostics: fc.array(fc.string({maxLength: 120}), {maxLength: 8}),
      }),
      fields => {
        const input = {...prepared, ...fields, repairRequired: fields.pending > 0 || fields.diagnostics.length > 0};
        const encoded = JSON.stringify(input);
        expect(parseDevSkillsUpdateStatus(JSON.parse(encoded))).toEqual(input);
        expect(JSON.stringify(input)).toBe(encoded);
      },
    ),
    {numRuns: 48},
  );
});

it('rejects unsupported versions, unknown fields and invalid outcome counts', () => {
  fc.assert(
    fc.property(fc.integer({min: 2, max: 100}), fc.string({maxLength: 80}), (protocolVersion, extra) => {
      expect(() => parsePreparedDevSkillsUpdate({...prepared, protocolVersion})).toThrow();
      expect(() => parsePreparedDevSkillsUpdate({...prepared, future: extra})).toThrow();
      expect(() =>
        parsePreparedDevSkillsUpdate({...prepared, release: {...prepared.release, future: extra}}),
      ).toThrow();
    }),
    {numRuns: 32},
  );
  for (const invalid of [
    {...status, pending: -1},
    {...status, current: 0.5},
    {...status, current: 2049},
    {...status, current: 2048, skipped: 1},
    {...status, pending: 1},
    {...status, diagnostics: ['pending but success']},
    {...status, diagnostics: [S.repeat(4097)('x')], repairRequired: true},
  ])
    expect(() => parseDevSkillsUpdateStatus(invalid)).toThrow();
});

it('bounds diagnostic rendering without losing the pending outcome', () => {
  const result: DevSkillsRefreshResult = {
    schemaVersion: 1,
    intentId: prepared.intentId,
    release: prepared.release,
    targets: [],
    repairRequired: true,
    issues: Array.from({length: 2048}, () => ({code: 'pending', message: S.repeat(4000)('界')})),
  };
  const projected = projectDevSkillsUpdateStatus(result);
  expect(projected.repairRequired).toBe(true);
  expect(projected.diagnostics).toHaveLength(64);
  expect(A.every(projected.diagnostics, message => message.length <= 1000)).toBe(true);
  expect(projected.diagnostics.at(-1)).toContain('omitted');
  expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(300_000);
});

effectIt.effect('uses only the candidate protocol and independently checks its durable status', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const releaseVersion = '5.3.0-beta.9';
    const releaseRoot = f.path.join(f.runtime, 'versions', releaseVersion);
    const admission = {...prepared, release: {...prepared.release, installationRoot: f.runtime, releaseRoot}};
    const reply = {...status, ...admission};
    const commands: string[] = [];
    const executor = CommandExecutor.of({
      execute: (_executable, args) => {
        commands.push(args[3]);
        expect(args[args.indexOf('--protocol-version') + 1]).toBe('1');
        return Effect.succeed({
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify(args[3] === 'prepare-update' ? admission : reply),
        });
      },
      executeStreaming: () => Effect.die('updater uses bounded protocol calls'),
    });
    // A future candidate owns these formats; the parent must never parse either file.
    yield* f.fs.makeDirectory(f.path.join(releaseRoot, 'config'), {recursive: true});
    yield* f.fs.writeFileString(f.path.join(releaseRoot, 'config/dev-skills.json'), '{"schemaVersion":99}');
    yield* f.fs.writeFileString(f.path.join(f.runtime, 'dev-skills-refresh.json'), '{"schemaVersion":99}');
    const result = yield* f.run(
      Effect.gen(function* () {
        const intent = yield* prepareReleaseDevSkills(f.config, releaseRoot, releaseVersion);
        return yield* refreshReleaseDevSkills(f.config, intent);
      }).pipe(Effect.provideService(CommandExecutor, executor)),
    );
    expect(result).toEqual(reply);
    expect(commands).toEqual(['prepare-update', 'update-status', 'refresh-update', 'update-status']);
  }).pipe(provideTestLayer(devSkillsTestLayer)),
);

effectIt.effect('refuses a candidate reply whose release differs from the verified package', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const result = yield* f.run(prepareReleaseDevSkills(f.config, prepared.release.releaseRoot, '5.3.0-beta.10')).pipe(
      Effect.provideService(
        CommandExecutor,
        CommandExecutor.of({
          execute: () => Effect.succeed({exitCode: 0, stderr: '', stdout: JSON.stringify(prepared)}),
          executeStreaming: () => Effect.die('unused'),
        }),
      ),
      Effect.result,
    );
    expect(result._tag).toBe('Failure');
  }).pipe(provideTestLayer(devSkillsTestLayer)),
);

effectIt.effect('refuses preparation when the candidate cannot read back the same durable intent', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const result = yield* f
      .run(prepareReleaseDevSkills(f.config, prepared.release.releaseRoot, prepared.release.releaseVersion))
      .pipe(
        Effect.provideService(
          CommandExecutor,
          CommandExecutor.of({
            execute: (_executable, args) =>
              Effect.succeed({
                exitCode: 0,
                stderr: '',
                stdout: JSON.stringify(
                  args[3] === 'prepare-update' ? prepared : {...status, intentId: S.repeat(64)('c')},
                ),
              }),
            executeStreaming: () => Effect.die('unused'),
          }),
        ),
        Effect.result,
      );
    expect(result).toMatchObject({_tag: 'Failure', failure: {_tag: 'DevSkillsUpdatePending'}});
  }).pipe(provideTestLayer(devSkillsTestLayer)),
);

effectIt.effect('keeps a refresh pending when its readonly durable status disagrees', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const result = yield* f.run(refreshReleaseDevSkills(f.config, prepared)).pipe(
      Effect.provideService(
        CommandExecutor,
        CommandExecutor.of({
          execute: (_executable, args) =>
            Effect.succeed({
              exitCode: 0,
              stderr: '',
              stdout: JSON.stringify(args[3] === 'update-status' ? {...status, current: 0} : status),
            }),
          executeStreaming: () => Effect.die('unused'),
        }),
      ),
      Effect.result,
    );
    expect(result).toMatchObject({_tag: 'Failure', failure: {_tag: 'DevSkillsUpdatePending'}});
  }).pipe(provideTestLayer(devSkillsTestLayer)),
);

effectIt.effect('candidate preparation refuses a different executing version before writing intent', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const candidate = yield* devSkillsReleaseFixture(f, '5.3.0-beta.9', true);
    const result = yield* prepareCandidateDevSkillsUpdate(f.config, candidate.releaseRoot, '5.3.0-beta.10').pipe(
      Effect.provideService(SystemInfo, {...f.system, executablePath: f.path.join(candidate.bundleRoot, 'threadnote')}),
      Effect.provideService(DevSkillsSource, {root: candidate.bundleRoot, runtimeVersion: candidate.releaseVersion}),
      Effect.result,
    );
    expect(result._tag).toBe('Failure');
    expect(yield* f.fs.exists(f.path.join(f.runtime, 'dev-skills-refresh.json'))).toBe(false);
  }).pipe(provideTestLayer(devSkillsTestLayer)),
);
