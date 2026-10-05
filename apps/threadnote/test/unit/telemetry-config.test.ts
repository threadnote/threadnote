import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {Base64Url} from 'effect/encoding';
import * as FC from 'fast-check';
import {describe, expect, it} from 'vitest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {
  DEFAULT_TELEMETRY_ENDPOINT,
  TelemetryConfigurationError,
  createEnabledTelemetryConfiguration,
  disabledTelemetryConfiguration,
  enabledTelemetryConfiguration,
  normalizeTelemetryEndpoint,
  parseTelemetryConsentRenewal,
  parseTelemetryConfiguration,
  readTelemetryConsentRenewal,
  readTelemetryConfiguration,
  renderTelemetryConfiguration,
  resolveTelemetryConfiguration,
  telemetryConfigurationPath,
  writeTelemetryConfiguration,
} from '@threadnote/threadnote/telemetry/config';
import {provideTestLayer} from '../helpers/effect-layer.js';

const FIXED_SESSION_SALT = Base64Url.encode(new Uint8Array(32).fill(7));

describe('telemetry configuration', () => {
  it('accepts only the strict versioned consent schema', () => {
    const enabled = enabledTelemetryConfiguration(DEFAULT_TELEMETRY_ENDPOINT, FIXED_SESSION_SALT);
    const autoAccepted = enabledTelemetryConfiguration(DEFAULT_TELEMETRY_ENDPOINT, FIXED_SESSION_SALT, true);
    expect(parseTelemetryConfiguration(renderTelemetryConfiguration(enabled))).toEqual(enabled);
    expect(parseTelemetryConfiguration(renderTelemetryConfiguration(autoAccepted))).toEqual(autoAccepted);
    expect(parseTelemetryConfiguration(renderTelemetryConfiguration(disabledTelemetryConfiguration()))).toEqual(
      disabledTelemetryConfiguration(),
    );

    for (const malformed of [
      {},
      {consentVersion: 2, enabled: true, endpoint: DEFAULT_TELEMETRY_ENDPOINT, version: 1},
      {consentVersion: 2, enabled: false, endpoint: DEFAULT_TELEMETRY_ENDPOINT, version: 1},
      {
        consentVersion: 5,
        autoAccept: 'yes',
        enabled: true,
        endpoint: DEFAULT_TELEMETRY_ENDPOINT,
        sessionSalt: FIXED_SESSION_SALT,
        version: 1,
      },
      {
        consentVersion: 6,
        autoAccept: true,
        enabled: true,
        endpoint: DEFAULT_TELEMETRY_ENDPOINT,
        sessionSalt: FIXED_SESSION_SALT,
        unexpected: true,
        version: 1,
      },
      {consentVersion: 3, enabled: false, version: 1},
      {consentVersion: 7, enabled: false, version: 1},
      {consentVersion: 5, enabled: false, version: 2},
    ]) {
      expect(() => parseTelemetryConfiguration(JSON.stringify(malformed))).toThrow(TelemetryConfigurationError);
    }
  });

  it('requires HTTPS except for explicit loopback collectors', () => {
    expect(normalizeTelemetryEndpoint('https://collector.example/v1/traces')).toBe(
      'https://collector.example/v1/traces',
    );
    expect(normalizeTelemetryEndpoint('http://localhost:4318/v1/traces')).toBe('http://localhost:4318/v1/traces');
    expect(normalizeTelemetryEndpoint('http://127.0.0.2:4318/v1/traces')).toBe('http://127.0.0.2:4318/v1/traces');
    expect(normalizeTelemetryEndpoint('http://[::1]:4318/v1/traces')).toBe('http://[::1]:4318/v1/traces');
    for (const endpoint of [
      'http://collector.example/v1/traces',
      'https://user:secret@collector.example/v1/traces',
      'https://collector.example/v1/traces?token=secret',
      'file:///tmp/traces',
    ]) {
      expect(() => normalizeTelemetryEndpoint(endpoint)).toThrow(TelemetryConfigurationError);
    }
  });

  fcEffectProp(
    effectIt,
    'round-trips every canonical 32-byte local session salt and acceptance mode',
    {autoAccept: FC.boolean(), bytes: FC.uint8Array({maxLength: 32, minLength: 32})},
    ({autoAccept, bytes}) =>
      Effect.sync(() => {
        const value = enabledTelemetryConfiguration(DEFAULT_TELEMETRY_ENDPOINT, Base64Url.encode(bytes), autoAccept);
        expect(parseTelemetryConfiguration(renderTelemetryConfiguration(value))).toEqual(value);
      }),
    {fastCheck: {numRuns: 50}},
  );

  fcEffectProp(
    effectIt,
    'recognizes only the exact renewable enabled-consent generation',
    {
      autoAccept: FC.option(FC.boolean(), {nil: undefined}),
      consentVersion: FC.integer({max: 8, min: 1}),
      enabled: FC.boolean(),
      extraField: FC.boolean(),
      validEndpoint: FC.boolean(),
      validSalt: FC.boolean(),
      version: FC.integer({max: 2, min: 0}),
    },
    ({autoAccept, consentVersion, enabled, extraField, validEndpoint, validSalt, version}) =>
      Effect.sync(() => {
        const renewal = parseTelemetryConsentRenewal(
          JSON.stringify({
            ...(autoAccept === undefined ? {} : {autoAccept}),
            consentVersion,
            enabled,
            endpoint: validEndpoint ? DEFAULT_TELEMETRY_ENDPOINT : 'http://collector.example/v1/traces',
            sessionSalt: validSalt ? FIXED_SESSION_SALT : 'not-a-canonical-session-salt',
            ...(extraField ? {unexpected: true} : {}),
            version,
          }),
        );
        expect(renewal).toEqual(
          consentVersion === 5 &&
            enabled &&
            autoAccept !== true &&
            !extraField &&
            validEndpoint &&
            validSalt &&
            version === 1
            ? {consentVersion: 5, endpoint: DEFAULT_TELEMETRY_ENDPOINT}
            : undefined,
        );
      }),
    {fastCheck: {numRuns: 50}},
  );

  fcEffectProp(
    effectIt,
    'accepts earlier consent generations only when future scope updates were auto-accepted',
    {
      autoAccept: FC.boolean(),
      consentVersion: FC.integer({max: 8, min: 1}),
    },
    ({autoAccept, consentVersion}) =>
      Effect.sync(() => {
        const parse = () =>
          parseTelemetryConfiguration(
            JSON.stringify({
              ...(autoAccept ? {autoAccept: true} : {}),
              consentVersion,
              enabled: true,
              endpoint: DEFAULT_TELEMETRY_ENDPOINT,
              sessionSalt: FIXED_SESSION_SALT,
              version: 1,
            }),
          );
        if (consentVersion === 6 || (consentVersion < 6 && autoAccept)) {
          expect(parse()).toEqual({
            ...(autoAccept ? {autoAccept: true} : {}),
            consentVersion: 6,
            enabled: true,
            endpoint: DEFAULT_TELEMETRY_ENDPOINT,
            sessionSalt: FIXED_SESSION_SALT,
            version: 1,
          });
        } else {
          expect(parse).toThrow(TelemetryConfigurationError);
        }
      }),
    {fastCheck: {numRuns: 50}},
  );

  effectIt.effect('persists private config atomically and removes the local salt on disable', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-telemetry-config-'});
        const config = {agentContextHome: home};
        const first = yield* createEnabledTelemetryConfiguration();
        const file = yield* writeTelemetryConfiguration(config, first);

        expect(yield* readTelemetryConfiguration(config)).toEqual(first);
        if (system.platform !== 'win32') {
          expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600);
          expect((yield* fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
        }

        yield* writeTelemetryConfiguration(config, disabledTelemetryConfiguration());
        expect(yield* readTelemetryConfiguration(config)).toEqual(disabledTelemetryConfiguration());
        expect(yield* fs.readFileString(file)).not.toContain('sessionSalt');
        expect(yield* resolveTelemetryConfiguration(config)).toBeUndefined();

        const second = yield* createEnabledTelemetryConfiguration();
        expect(second.sessionSalt).not.toBe(first.sessionSalt);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('fails closed for absent, malformed, and symbolic-link configuration', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-telemetry-fail-closed-'});
        const home = path.join(root, 'home');
        const config = {agentContextHome: home};
        expect(yield* resolveTelemetryConfiguration(config)).toBeUndefined();

        const file = yield* telemetryConfigurationPath(config);
        yield* fs.makeDirectory(path.dirname(file), {mode: 0o700, recursive: true});
        yield* fs.writeFileString(file, '{not-json}\n', {mode: 0o600});
        expect(yield* resolveTelemetryConfiguration(config)).toBeUndefined();

        const outside = path.join(root, 'outside.json');
        yield* fs.writeFileString(outside, renderTelemetryConfiguration(disabledTelemetryConfiguration()));
        yield* fs.remove(file);
        yield* fs.symlink(outside, file);
        expect(yield* resolveTelemetryConfiguration(config)).toBeUndefined();
        expect(yield* Effect.exit(readTelemetryConfiguration(config))).toMatchObject({_tag: 'Failure'});
        expect(yield* Effect.exit(readTelemetryConsentRenewal(config))).toMatchObject({_tag: 'Failure'});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('fails closed for manual consent but honors prior automatic scope acceptance', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-telemetry-stale-consent-'});
        const config = {agentContextHome: home};
        const file = yield* telemetryConfigurationPath(config);
        yield* fs.makeDirectory(path.dirname(file), {mode: 0o700, recursive: true});
        yield* fs.writeFileString(
          file,
          `${JSON.stringify({
            consentVersion: 5,
            enabled: true,
            endpoint: DEFAULT_TELEMETRY_ENDPOINT,
            sessionSalt: FIXED_SESSION_SALT,
            version: 1,
          })}\n`,
          {mode: 0o600},
        );

        expect(yield* resolveTelemetryConfiguration(config)).toBeUndefined();
        expect(yield* Effect.exit(readTelemetryConfiguration(config))).toMatchObject({_tag: 'Failure'});
        expect(yield* readTelemetryConsentRenewal(config)).toEqual({
          consentVersion: 5,
          endpoint: DEFAULT_TELEMETRY_ENDPOINT,
        });

        yield* fs.writeFileString(
          file,
          `${JSON.stringify({
            autoAccept: true,
            consentVersion: 5,
            enabled: true,
            endpoint: DEFAULT_TELEMETRY_ENDPOINT,
            sessionSalt: FIXED_SESSION_SALT,
            version: 1,
          })}\n`,
          {mode: 0o600},
        );
        expect(yield* resolveTelemetryConfiguration(config)).toEqual({
          autoAccept: true,
          consentVersion: 6,
          enabled: true,
          endpoint: DEFAULT_TELEMETRY_ENDPOINT,
          sessionSalt: FIXED_SESSION_SALT,
          version: 1,
        });
        expect(yield* readTelemetryConsentRenewal(config)).toBeUndefined();
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('honors environment kill switches without permitting environment opt-in', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseSystem = yield* SystemInfo;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-telemetry-env-'});
        const config = {agentContextHome: home};
        const enabled = yield* createEnabledTelemetryConfiguration();
        yield* writeTelemetryConfiguration(config, enabled);

        for (const override of [{DNT: '1'}, {DO_NOT_TRACK: 'true'}, {THREADNOTE_TELEMETRY: '0'}]) {
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({...baseSystem.environment(), ...override}),
          });
          expect(yield* resolveTelemetryConfiguration(config).pipe(Effect.provideService(SystemInfo, testSystem))).toBe(
            undefined,
          );
        }

        const otherHome = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-telemetry-env-enable-'});
        const optInSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({...baseSystem.environment(), THREADNOTE_TELEMETRY: '1'}),
        });
        expect(
          yield* resolveTelemetryConfiguration({agentContextHome: otherHome}).pipe(
            Effect.provideService(SystemInfo, optInSystem),
          ),
        ).toBeUndefined();
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});
