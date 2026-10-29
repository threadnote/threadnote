import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import * as FC from 'fast-check';
import {sha256Digest} from '@threadnote/graph/sharing/digest';
import {defaultGraphShareProfile, type GraphShareEnrollmentV2} from '@threadnote/graph/sharing/profile';
import {
  promptGraphShareOciProfileAccess,
  promptGraphShareOciTrustRoot,
} from '@threadnote/graph/sharing/profile/consent';
import {SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const namespace = 'oci://registry.example.test/acme/profile';
const publisherKeyFingerprint = sha256Digest('publisher key');
const enrollment: GraphShareEnrollmentV2 = {
  profile: `${namespace}@${sha256Digest('manifest')}`,
  profileDigest: sha256Digest('profile body'),
  publisherKeyFingerprint,
  repositoryId: Effect2.pipe('a', EffectString.repeat(64)),
  schemaVersion: 2,
};
const baseProfile = defaultGraphShareProfile({
  branch: 'main',
  canonicalRemote: 'github.com/acme/repo',
  organization: 'acme',
  publisherKeyFingerprint,
  repositoryId: enrollment.repositoryId,
});
const profile = {
  ...baseProfile,
  contribution: {...baseProfile.contribution, defaultMode: 'idle' as const},
  coordinator: {url: 'https://coordinator.example.test'},
  registry: {
    canonical: 'oci://registry.example.test/acme/canonical',
    worker: 'oci://registry.example.test/acme/worker',
  },
};

function terminal(system: SystemInfoShape, answers: readonly string[], prompts: string[], tty = true): SystemInfoShape {
  let index = 0;
  return {
    ...system,
    stdinIsTTY: tty,
    stdoutIsTTY: tty,
    readLine: (prompt, onLine) => {
      prompts.push(prompt);
      const answer = answers[index++] ?? '';
      queueMicrotask(() => onLine(answer));
      return () => undefined;
    },
  };
}

const withSystem = <A, E>(effect: Effect.Effect<A, E, SystemInfo>, answers: readonly string[], prompts: string[]) =>
  Effect.gen(function* () {
    const system = yield* SystemInfo;
    return yield* effect.pipe(Effect.provideService(SystemInfo, terminal(system, answers, prompts)));
  });

describe('interactive OCI graph first-use approval', () => {
  effectIt.effect('requires exact independently typed namespace and full publisher fingerprint', () =>
    Effect.gen(function* () {
      const prompts: string[] = [];
      const approved = yield* withSystem(
        promptGraphShareOciTrustRoot({enrollment}),
        [namespace, publisherKeyFingerprint],
        prompts,
      );
      expect(approved).toEqual({registryCanonical: namespace, publisherKeyFingerprint});
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toContain(namespace);
      expect(prompts[0]).toContain('organization administrator');
      expect(prompts[1]).toContain(publisherKeyFingerprint);
      expect(prompts[1]).toContain('full fingerprint');
    }).pipe(provideTestLayer(TestSystemInfoLayer)),
  );

  effectIt.effect('denies a wrong root immediately and never prompts for the next field', () =>
    Effect.gen(function* () {
      const prompts: string[] = [];
      const error = yield* withSystem(
        promptGraphShareOciTrustRoot({enrollment}),
        ['oci://registry.example.test/acme/other', publisherKeyFingerprint],
        prompts,
      ).pipe(Effect.flip);
      expect(error.message).toContain('namespace was not independently confirmed');
      expect(prompts).toHaveLength(1);
      const keyError = yield* withSystem(
        promptGraphShareOciTrustRoot({enrollment}),
        [namespace, sha256Digest('other key')],
        prompts,
      ).pipe(Effect.flip);
      expect(keyError.message).toContain('fingerprint was not independently confirmed');
      expect(prompts).toHaveLength(3);
    }).pipe(provideTestLayer(TestSystemInfoLayer)),
  );

  effectIt.effect('rejects empty approval, JSON mode, and non-TTY use without a default', () =>
    Effect.gen(function* () {
      const system = yield* SystemInfo;
      const prompts: string[] = [];
      const empty = yield* promptGraphShareOciTrustRoot({enrollment}).pipe(
        Effect.provideService(SystemInfo, terminal(system, [''], prompts)),
        Effect.flip,
      );
      expect(empty.message).toContain('not independently confirmed');
      const json = yield* promptGraphShareOciTrustRoot({enrollment, json: true}).pipe(
        Effect.provideService(SystemInfo, terminal(system, [namespace, publisherKeyFingerprint], prompts)),
        Effect.flip,
      );
      const nonTty = yield* promptGraphShareOciTrustRoot({enrollment}).pipe(
        Effect.provideService(SystemInfo, terminal(system, [namespace, publisherKeyFingerprint], prompts, false)),
        Effect.flip,
      );
      expect(json.message).toContain('TTY and non-JSON');
      expect(nonTty.message).toContain('TTY and non-JSON');
      expect(prompts).toHaveLength(1);
    }).pipe(provideTestLayer(TestSystemInfoLayer)),
  );

  effectIt.effect('shows verified destinations, source scope, actual passive behavior, and declared limits', () =>
    Effect.gen(function* () {
      const prompts: string[] = [];
      const mode = yield* withSystem(promptGraphShareOciProfileAccess({profile}), ['join'], prompts);
      expect(mode).toBe('join');
      expect(prompts).toHaveLength(1);
      const displayed = prompts[0];
      for (const value of [
        'Organization: acme',
        'Effective coordinator: https://coordinator.example.test',
        profile.registry.canonical,
        profile.registry.worker,
        profile.source.canonicalRemote,
        'refs/heads/main',
        'Declared default contribution mode: idle',
        'passive: ordinary graph indexing/use',
        'Idle and dedicated currently map to passive',
        'no active scheduler enforces them',
        'AC power only: true',
        'Idle only: true',
        'Maximum CPUs: 2',
        'Maximum memory bytes: 4294967296',
        'Positive upload limit 1048576 bytes/second is declared but not enforced',
      ])
        expect(displayed).toContain(value);
    }).pipe(provideTestLayer(TestSystemInfoLayer)),
  );

  effectIt.effect('explains that a zero upload budget pauses automatic delivery on join', () =>
    Effect.gen(function* () {
      const prompts: string[] = [];
      const zeroProfile = {
        ...profile,
        contribution: {...profile.contribution, maximumUploadBytesPerSecond: 0},
      };
      expect(yield* withSystem(promptGraphShareOciProfileAccess({profile: zeroProfile}), ['join'], prompts)).toBe(
        'join',
      );
      expect(prompts[0]).toContain('organization profile disables contribution uploads');
      expect(prompts[0]).toContain('Upload limit 0 bytes/second disables contribution delivery');
      expect(prompts[0]).not.toContain('MCP monitor delivers them automatically');
    }).pipe(provideTestLayer(TestSystemInfoLayer)),
  );

  effectIt.effect('requires exact read-only or join and never upgrades --read-only to join', () =>
    Effect.gen(function* () {
      const prompts: string[] = [];
      expect(yield* withSystem(promptGraphShareOciProfileAccess({profile}), ['read-only'], prompts)).toBe('read-only');
      for (const answer of ['', 'yes', 'Join', 'join ']) {
        const denied = yield* withSystem(promptGraphShareOciProfileAccess({profile}), [answer], prompts).pipe(
          Effect.flip,
        );
        expect(denied.message).toContain('access was not approved');
      }
      const deniedJoin = yield* withSystem(
        promptGraphShareOciProfileAccess({profile, readOnly: true}),
        ['join'],
        prompts,
      ).pipe(Effect.flip);
      expect(deniedJoin.message).toContain('access was not approved');
      expect(
        yield* withSystem(promptGraphShareOciProfileAccess({profile, readOnly: true}), ['read-only'], prompts),
      ).toBe('read-only');
    }).pipe(provideTestLayer(TestSystemInfoLayer)),
  );

  effectIt.effect('shows an effective coordinator override and denies join without a valid destination pair', () =>
    Effect.gen(function* () {
      const prompts: string[] = [];
      expect(
        yield* withSystem(
          promptGraphShareOciProfileAccess({
            profile,
            effectiveCoordinatorUrl: 'https://approved.example.test/',
          }),
          ['join'],
          prompts,
        ),
      ).toBe('join');
      expect(prompts[0]).toContain('Effective coordinator: https://approved.example.test');
      expect(prompts[0]).not.toContain('Effective coordinator: https://coordinator.example.test');
      const noCoordinator = yield* withSystem(
        promptGraphShareOciProfileAccess({profile: {...profile, coordinator: undefined}}),
        ['join'],
        prompts,
      ).pipe(Effect.flip);
      expect(noCoordinator.message).toContain('approved coordinator');
      const sameNamespace = yield* withSystem(
        promptGraphShareOciProfileAccess({
          profile: {...profile, registry: {...profile.registry, worker: profile.registry.canonical}},
        }),
        ['join'],
        prompts,
      ).pipe(Effect.flip);
      expect(sameNamespace.message).toContain('distinct canonical and worker');
      const sameTargetWithDefaultPort = yield* withSystem(
        promptGraphShareOciProfileAccess({
          profile: {
            ...profile,
            registry: {...profile.registry, worker: 'oci://registry.example.test:443/acme/canonical'},
          },
        }),
        ['join'],
        prompts,
      ).pipe(Effect.flip);
      expect(sameTargetWithDefaultPort.message).toContain('distinct canonical and worker');
      expect(
        yield* withSystem(
          promptGraphShareOciProfileAccess({
            profile: {...profile, registry: {...profile.registry, worker: 'cas://local/worker'}},
          }),
          ['read-only'],
          prompts,
        ),
      ).toBe('read-only');
    }).pipe(provideTestLayer(TestSystemInfoLayer)),
  );

  fcEffectProp(
    effectIt,
    'single-character changes to either root field never authorize the requested root',
    {
      field: FC.constantFrom('namespace' as const, 'fingerprint' as const),
      index: FC.integer({min: 0, max: Math.min(namespace.length, publisherKeyFingerprint.length) - 1}),
    },
    ({field, index}) =>
      Effect.gen(function* () {
        const original = field === 'namespace' ? namespace : publisherKeyFingerprint;
        const changed = `${Effect2.pipe(original, EffectString.slice(0, index))}${original[index] === 'x' ? 'y' : 'x'}${Effect2.pipe(original, EffectString.slice(index + 1))}`;
        const prompts: string[] = [];
        const answers = field === 'namespace' ? [changed, publisherKeyFingerprint] : [namespace, changed];
        const denied = yield* withSystem(promptGraphShareOciTrustRoot({enrollment}), answers, prompts).pipe(
          Effect.flip,
        );
        expect(denied.message).toContain('not independently confirmed');
        expect(prompts).toHaveLength(field === 'namespace' ? 1 : 2);
      }).pipe(provideTestLayer(TestSystemInfoLayer)),
    {fastCheck: {numRuns: 36}},
  );
});
