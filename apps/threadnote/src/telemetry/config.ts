import {Crypto, Effect, FileSystem, Option, Path, Result, Schema} from 'effect';
import {Base64Url} from 'effect/encoding';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {isJsonObject} from '@threadnote/platform/json';

export const TELEMETRY_CONFIGURATION_VERSION = 1 as const;
export const TELEMETRY_CONSENT_VERSION = 6 as const;
export const TELEMETRY_RENEWABLE_CONSENT_VERSION = 5 as const;
export const DEFAULT_TELEMETRY_ENDPOINT = 'https://telemetry.threadnote.io/v1/traces';

export interface DisabledTelemetryConfiguration {
  readonly consentVersion: typeof TELEMETRY_CONSENT_VERSION;
  readonly enabled: false;
  readonly version: typeof TELEMETRY_CONFIGURATION_VERSION;
}

export interface EnabledTelemetryConfiguration {
  /** Keep telemetry enabled when later releases expand the versioned data contract. */
  readonly autoAccept?: true;
  readonly consentVersion: typeof TELEMETRY_CONSENT_VERSION;
  readonly enabled: true;
  readonly endpoint: string;
  /** Local HMAC key for provider session pseudonyms. Never exported. */
  readonly sessionSalt: string;
  readonly version: typeof TELEMETRY_CONFIGURATION_VERSION;
}

export type TelemetryConfiguration = DisabledTelemetryConfiguration | EnabledTelemetryConfiguration;

/**
 * A previously enabled consent that is structurally valid but does not cover
 * the current data contract. This is diagnostic state only: it never enables
 * an exporter until the user applies the current consent explicitly.
 */
export interface TelemetryConsentRenewal {
  readonly consentVersion: typeof TELEMETRY_RENEWABLE_CONSENT_VERSION;
  readonly endpoint: string;
}

export type TelemetryEnvironmentOptOut = 'DNT' | 'DO_NOT_TRACK' | 'THREADNOTE_TELEMETRY';

export class TelemetryConfigurationError extends Schema.TaggedError<TelemetryConfigurationError>()(
  'TelemetryConfigurationError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

const TELEMETRY_DIRECTORY_NAME = 'telemetry';
const TELEMETRY_CONFIGURATION_FILE_NAME = 'config.json';
const TELEMETRY_CONFIGURATION_MAX_BYTES = 16 * 1024;
const TELEMETRY_ENDPOINT_MAX_CHARACTERS = 2_048;
const TELEMETRY_SESSION_SALT_BYTES = 32;
const TELEMETRY_DIRECTORY_MODE = 0o700;
const TELEMETRY_CONFIGURATION_FILE_MODE = 0o600;
const TELEMETRY_LOCK_OPTIONS = {
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 30_000,
  waitTimeoutMilliseconds: 2_000,
} as const;

export const telemetryConfigurationPath = Effect.fn('telemetry.configurationPath')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
) {
  const path = yield* Path.Path;
  return path.join(config.agentContextHome, TELEMETRY_DIRECTORY_NAME, TELEMETRY_CONFIGURATION_FILE_NAME);
});

export const readTelemetryConfiguration = Effect.fn('telemetry.readConfiguration')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
) {
  const document = yield* readTelemetryConfigurationDocument(config);
  if (document === undefined) return undefined;
  return yield* Effect.try({
    try: () => parseTelemetryConfiguration(document.raw, document.file),
    catch: cause =>
      Schema.is(TelemetryConfigurationError)(cause)
        ? cause
        : TelemetryConfigurationError.make({cause, message: 'Telemetry configuration could not be parsed.'}),
  });
});

/**
 * Recognizes only the exact enabled v5 shape so update/status UX can explain
 * why telemetry stopped. Malformed, disabled, older, newer, and current
 * configurations are not renewal candidates and continue to fail closed.
 */
export const readTelemetryConsentRenewal = Effect.fn('telemetry.readConsentRenewal')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
) {
  const document = yield* readTelemetryConfigurationDocument(config);
  return document === undefined ? undefined : parseTelemetryConsentRenewal(document.raw, document.file);
});

/** Invalid, unreadable, absent, disabled, or environment-suppressed consent always resolves to off. */
export const resolveTelemetryConfiguration = Effect.fn('telemetry.resolveConfiguration')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
) {
  const system = yield* SystemInfo;
  if (telemetryEnvironmentOptOut(system.environment()) !== undefined) return undefined;
  return yield* readTelemetryConfiguration(config).pipe(
    Effect.map(value => (value?.enabled === true ? value : undefined)),
    Effect.orElseSucceed(() => undefined),
  );
});

export const writeTelemetryConfiguration = Effect.fn('telemetry.writeConfiguration')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  value: TelemetryConfiguration,
) {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* telemetryConfigurationPath(config);
  const directory = path.dirname(file);
  const serialized = renderTelemetryConfiguration(value);
  yield* prepareTelemetryDirectory(fs, directory);
  yield* withExclusiveFileLock(
    fs,
    `${file}.lock`,
    TELEMETRY_LOCK_OPTIONS,
    Effect.gen(function* () {
      yield* assertRegularTelemetryDirectory(fs, directory);
      if ((yield* fs.exists(file)) && Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) {
        return yield* TelemetryConfigurationError.make({
          message: 'Telemetry configuration must not be a symbolic link.',
        });
      }
      const temporary = path.join(directory, `.config.${yield* crypto.randomUUIDv4}.tmp`);
      yield* fs.writeFileString(temporary, serialized, {mode: TELEMETRY_CONFIGURATION_FILE_MODE});
      yield* fs.rename(temporary, file).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
      yield* fs.chmod(file, TELEMETRY_CONFIGURATION_FILE_MODE);
      yield* fs.chmod(directory, TELEMETRY_DIRECTORY_MODE);
    }),
  );
  return file;
});

export const createEnabledTelemetryConfiguration = Effect.fn('telemetry.createEnabledConfiguration')(function* (
  endpoint = DEFAULT_TELEMETRY_ENDPOINT,
  autoAccept = false,
) {
  const crypto = yield* Crypto.Crypto;
  return enabledTelemetryConfiguration(
    endpoint,
    Base64Url.encode(yield* crypto.randomBytes(TELEMETRY_SESSION_SALT_BYTES)),
    autoAccept,
  );
});

export function enabledTelemetryConfiguration(
  endpoint: string,
  sessionSalt: string,
  autoAccept = false,
): EnabledTelemetryConfiguration {
  return {
    ...(autoAccept ? {autoAccept: true as const} : {}),
    consentVersion: TELEMETRY_CONSENT_VERSION,
    enabled: true,
    endpoint: normalizeTelemetryEndpoint(endpoint),
    sessionSalt: normalizeTelemetrySessionSalt(sessionSalt),
    version: TELEMETRY_CONFIGURATION_VERSION,
  };
}

export function disabledTelemetryConfiguration(): DisabledTelemetryConfiguration {
  return {
    consentVersion: TELEMETRY_CONSENT_VERSION,
    enabled: false,
    version: TELEMETRY_CONFIGURATION_VERSION,
  };
}

export function parseTelemetryConfiguration(
  raw: string,
  source = TELEMETRY_CONFIGURATION_FILE_NAME,
): TelemetryConfiguration {
  try {
    return parseTelemetryConfigurationValue(JSON.parse(raw) as unknown, source);
  } catch (cause) {
    if (Schema.is(TelemetryConfigurationError)(cause)) throw cause;
    throw TelemetryConfigurationError.make({cause, message: `Telemetry configuration is not valid JSON: ${source}`});
  }
}

export function parseTelemetryConsentRenewal(
  raw: string,
  source = TELEMETRY_CONFIGURATION_FILE_NAME,
): TelemetryConsentRenewal | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (
    !isJsonObject(value) ||
    value.version !== TELEMETRY_CONFIGURATION_VERSION ||
    value.consentVersion !== TELEMETRY_RENEWABLE_CONSENT_VERSION ||
    value.enabled !== true ||
    value.autoAccept === true ||
    (value.autoAccept !== undefined && typeof value.autoAccept !== 'boolean') ||
    typeof value.endpoint !== 'string' ||
    typeof value.sessionSalt !== 'string'
  ) {
    return undefined;
  }
  try {
    assertExactKeys(
      value,
      [
        ...(value.autoAccept === undefined ? [] : ['autoAccept']),
        'consentVersion',
        'enabled',
        'endpoint',
        'sessionSalt',
        'version',
      ],
      source,
    );
    normalizeTelemetrySessionSalt(value.sessionSalt);
    return {
      consentVersion: TELEMETRY_RENEWABLE_CONSENT_VERSION,
      endpoint: normalizeTelemetryEndpoint(value.endpoint),
    };
  } catch {
    return undefined;
  }
}

export function renderTelemetryConfiguration(value: TelemetryConfiguration): string {
  const parsed = parseTelemetryConfigurationValue(value, TELEMETRY_CONFIGURATION_FILE_NAME);
  return `${JSON.stringify(parsed, undefined, 2)}\n`;
}

export function normalizeTelemetryEndpoint(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > TELEMETRY_ENDPOINT_MAX_CHARACTERS) {
    throw TelemetryConfigurationError.make({message: 'Telemetry endpoint must be a non-empty bounded URL.'});
  }
  let endpoint: URL;
  try {
    endpoint = new URL(trimmed);
  } catch (cause) {
    throw TelemetryConfigurationError.make({cause, message: 'Telemetry endpoint must be an absolute URL.'});
  }
  if (endpoint.username || endpoint.password) {
    throw TelemetryConfigurationError.make({message: 'Telemetry endpoint must not contain credentials.'});
  }
  if (endpoint.search || endpoint.hash) {
    throw TelemetryConfigurationError.make({
      message: 'Telemetry endpoint must not contain a query string or fragment.',
    });
  }
  const loopback = isLoopbackHostname(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) {
    throw TelemetryConfigurationError.make({
      message: 'Telemetry endpoint must use HTTPS, except for a loopback HTTP collector.',
    });
  }
  return endpoint.toString();
}

export function normalizeTelemetrySessionSalt(value: string): string {
  const decoded = Base64Url.decode(value);
  if (
    !Result.isSuccess(decoded) ||
    decoded.success.byteLength !== TELEMETRY_SESSION_SALT_BYTES ||
    Base64Url.encode(decoded.success) !== value
  ) {
    throw TelemetryConfigurationError.make({
      message: 'Telemetry session salt must be canonical base64url for 32 random bytes.',
    });
  }
  return value;
}

export function telemetryEnvironmentOptOut(
  environment: Readonly<Record<string, string | undefined>>,
): TelemetryEnvironmentOptOut | undefined {
  if (environmentOptOutEnabled(environment.DO_NOT_TRACK)) return 'DO_NOT_TRACK';
  if (environmentOptOutEnabled(environment.DNT)) return 'DNT';
  if (threadnoteTelemetryDisabled(environment.THREADNOTE_TELEMETRY)) return 'THREADNOTE_TELEMETRY';
  return undefined;
}

function parseTelemetryConfigurationValue(value: unknown, source: string): TelemetryConfiguration {
  if (!isJsonObject(value)) {
    throw TelemetryConfigurationError.make({message: `Telemetry configuration must be an object: ${source}`});
  }
  if (value.version !== TELEMETRY_CONFIGURATION_VERSION) {
    throw TelemetryConfigurationError.make({
      message: `Unsupported telemetry configuration version in ${source}. Expected ${TELEMETRY_CONFIGURATION_VERSION}.`,
    });
  }
  if (value.enabled === false) {
    assertCurrentTelemetryConsentVersion(value.consentVersion, source);
    assertExactKeys(value, ['consentVersion', 'enabled', 'version'], source);
    return disabledTelemetryConfiguration();
  }
  if (value.enabled === true) {
    const autoAccept = value.autoAccept;
    if (autoAccept !== undefined && typeof autoAccept !== 'boolean') {
      throw TelemetryConfigurationError.make({message: `Telemetry auto-accept must be a boolean: ${source}`});
    }
    if (
      value.consentVersion !== TELEMETRY_CONSENT_VERSION &&
      !(autoAccept === true && isEarlierTelemetryConsentVersion(value.consentVersion))
    ) {
      throw unsupportedTelemetryConsentVersion(source);
    }
    assertExactKeys(
      value,
      [
        ...(autoAccept === undefined ? [] : ['autoAccept']),
        'consentVersion',
        'enabled',
        'endpoint',
        'sessionSalt',
        'version',
      ],
      source,
    );
    if (typeof value.endpoint !== 'string' || typeof value.sessionSalt !== 'string') {
      throw TelemetryConfigurationError.make({
        message: `Enabled telemetry configuration requires an endpoint and local session salt: ${source}`,
      });
    }
    return enabledTelemetryConfiguration(value.endpoint, value.sessionSalt, autoAccept === true);
  }
  assertCurrentTelemetryConsentVersion(value.consentVersion, source);
  throw TelemetryConfigurationError.make({
    message: `Telemetry configuration requires a boolean enabled field: ${source}`,
  });
}

function assertCurrentTelemetryConsentVersion(value: unknown, source: string): void {
  if (value !== TELEMETRY_CONSENT_VERSION) throw unsupportedTelemetryConsentVersion(source);
}

function isEarlierTelemetryConsentVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) < TELEMETRY_CONSENT_VERSION;
}

function unsupportedTelemetryConsentVersion(source: string): TelemetryConfigurationError {
  return TelemetryConfigurationError.make({
    message: `Unsupported telemetry consent version in ${source}. Expected ${TELEMETRY_CONSENT_VERSION}.`,
  });
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], source: string): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw TelemetryConfigurationError.make({message: `Telemetry configuration contains unsupported fields: ${source}`});
  }
}

function environmentOptOutEnabled(value: string | undefined): boolean {
  return value !== undefined && ['1', 'on', 'true', 'yes'].includes(value.trim().toLowerCase());
}

function threadnoteTelemetryDisabled(value: string | undefined): boolean {
  return value !== undefined && ['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

function isLoopbackHostname(value: string): boolean {
  const hostname = value
    .toLowerCase()
    .replace(/^\[|\]$/gu, '')
    .replace(/\.$/u, '');
  return hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/u.test(hostname);
}

function prepareTelemetryDirectory(fs: FileSystem.FileSystem, directory: string) {
  return Effect.gen(function* () {
    if ((yield* fs.exists(directory)) && Option.isSome(yield* fs.readLink(directory).pipe(Effect.option))) {
      return yield* TelemetryConfigurationError.make({message: 'Telemetry directory must not be a symbolic link.'});
    }
    yield* fs.makeDirectory(directory, {mode: TELEMETRY_DIRECTORY_MODE, recursive: true});
    yield* assertRegularTelemetryDirectory(fs, directory);
    yield* fs.chmod(directory, TELEMETRY_DIRECTORY_MODE);
  });
}

const readTelemetryConfigurationDocument = Effect.fn('telemetry.readConfigurationDocument')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* telemetryConfigurationPath(config);
  if (!(yield* fs.exists(file))) return undefined;
  yield* assertRegularTelemetryDirectory(fs, path.dirname(file));
  if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) {
    return yield* TelemetryConfigurationError.make({message: 'Telemetry configuration must not be a symbolic link.'});
  }
  const info = yield* fs.stat(file);
  if (info.type !== 'File' || Number(info.size) > TELEMETRY_CONFIGURATION_MAX_BYTES) {
    return yield* TelemetryConfigurationError.make({
      message: 'Telemetry configuration must be a bounded regular file.',
    });
  }
  return {file, raw: yield* fs.readFileString(file)};
});

function assertRegularTelemetryDirectory(fs: FileSystem.FileSystem, directory: string) {
  return Effect.gen(function* () {
    if (Option.isSome(yield* fs.readLink(directory).pipe(Effect.option))) {
      return yield* TelemetryConfigurationError.make({message: 'Telemetry directory must not be a symbolic link.'});
    }
    const info = yield* fs.stat(directory);
    if (info.type !== 'Directory') {
      return yield* TelemetryConfigurationError.make({message: 'Telemetry directory must be a regular directory.'});
    }
  });
}
