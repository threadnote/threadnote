import {Clock, Console, Effect, Predicate, Schema} from 'effect';
import {cursorCloudMemoryEndpoint} from './cloud.js';
import {CommandExecutor, type CommandOptions} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import type {CommandResult} from '@threadnote/platform/command';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const CURSOR_AGENT_SOCKET_DEFAULT = '/run/cursor/api.sock';
const CURSOR_OIDC_PATH = 'http://cursor-agent/v1/tokens/oidc';
const CHALLENGE_MAX_FUTURE_MILLISECONDS = 10 * 60 * 1_000;
const CURL_OUTPUT_MAX_BYTES = 16 * 1_024;

export class CursorAttestationError extends Schema.TaggedError<
  CursorAttestationError,
  {readonly brand: unique symbol}
>()('CursorAttestationError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

export interface CursorAttestationChallengeInputV1 {
  readonly audience?: unknown;
  readonly challengeId?: unknown;
  readonly completionUrl?: unknown;
  readonly expiresAt?: unknown;
  readonly nonce?: unknown;
}

export interface CursorAttestationChallengeV1 {
  readonly audience: string;
  readonly challengeId: string;
  readonly completionUrl: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly version: 1;
}

export interface CursorAttestationReceiptV1 {
  readonly attestationId: string;
  readonly expiresAt?: string;
}

export interface CursorAttestationCommandOptions {
  readonly audience: string;
  readonly challenge: string;
  readonly completionUrl: string;
  readonly endpoint: string;
  readonly expiresAt: string;
  readonly json?: boolean;
  readonly nonce: string;
}

export interface CursorAttestationExchangeClient {
  readonly complete: (
    challenge: CursorAttestationChallengeV1,
    token: string,
  ) => Effect.Effect<{readonly attestationId: string; readonly expiresAt?: string}, unknown>;
  readonly mint: (
    challenge: CursorAttestationChallengeV1,
  ) => Effect.Effect<{readonly expiresAt: number; readonly token: string}, unknown>;
}

export function validateCursorAttestationChallenge(
  input: CursorAttestationChallengeInputV1,
  expectedMemoryEndpoint: string,
  nowMilliseconds = Date.now(),
): CursorAttestationChallengeV1 {
  const challengeId = portableOpaqueValue(input.challengeId, 'challengeId', 256);
  const nonce = portableOpaqueValue(input.nonce, 'nonce', 512, 16);
  const audience = httpsUrl(input.audience, 'audience', 512);
  const completionUrl = httpsUrl(input.completionUrl, 'completionUrl', 2_048);
  const expectedEndpoint = new URL(cursorCloudMemoryEndpoint(expectedMemoryEndpoint));
  const expectedAudience = new URL('/attest/cursor', expectedEndpoint).toString();
  const expectedCompletionUrl = new URL('/attest/cursor/complete', expectedEndpoint).toString();
  if (audience !== expectedAudience || completionUrl !== expectedCompletionUrl) {
    throw CursorAttestationError.make({
      message: 'Cursor attestation audience and completion endpoint must match the configured remote memory service.',
    });
  }
  const expiresAt = requiredString(input.expiresAt, 'expiresAt', 64);
  const expiresAtMilliseconds = Date.parse(expiresAt);
  if (
    !Number.isFinite(expiresAtMilliseconds) ||
    expiresAtMilliseconds <= nowMilliseconds ||
    expiresAtMilliseconds - nowMilliseconds > CHALLENGE_MAX_FUTURE_MILLISECONDS
  ) {
    throw CursorAttestationError.make({message: 'Cursor attestation challenge is expired or has an invalid lifetime.'});
  }
  return {
    audience,
    challengeId,
    completionUrl,
    expiresAt: new Date(expiresAtMilliseconds).toISOString(),
    nonce,
    version: 1,
  };
}

export const completeCursorAttestationChallenge = Effect.fn('cursorCloud.completeAttestation')(function* (
  input: CursorAttestationChallengeInputV1,
  expectedMemoryEndpoint: string,
  client: CursorAttestationExchangeClient,
  nowMilliseconds?: number,
) {
  const now = nowMilliseconds ?? (yield* Clock.currentTimeMillis);
  const challenge = yield* Effect.try({
    try: () => validateCursorAttestationChallenge(input, expectedMemoryEndpoint, now),
    catch: cause =>
      Schema.is(CursorAttestationError)(cause)
        ? cause
        : CursorAttestationError.make({message: 'Cursor attestation challenge validation failed.'}),
  });
  const minted = yield* client
    .mint(challenge)
    .pipe(
      Effect.mapError(() => CursorAttestationError.make({message: 'Cursor workload identity token minting failed.'})),
    );
  if (!minted.token || !Number.isSafeInteger(minted.expiresAt) || minted.expiresAt * 1_000 <= now) {
    return yield* CursorAttestationError.make({message: 'Cursor returned an invalid workload identity response.'});
  }
  const completion = yield* client
    .complete(challenge, minted.token)
    .pipe(
      Effect.mapError(() => CursorAttestationError.make({message: 'Cursor workload attestation completion failed.'})),
    );
  const normalizedCompletion = yield* Effect.try({
    try: () => ({
      attestationId: portableOpaqueValue(completion.attestationId, 'attestationId', 256),
      expiresAt: optionalTimestamp(completion.expiresAt),
    }),
    catch: () =>
      CursorAttestationError.make({message: 'Threadnote returned an invalid workload attestation response.'}),
  });
  return {
    attestationId: normalizedCompletion.attestationId,
    ...(normalizedCompletion.expiresAt ? {expiresAt: normalizedCompletion.expiresAt} : {}),
  } satisfies CursorAttestationReceiptV1;
});

export const runCursorAttestationChallenge = Effect.fn('cursorCloud.runAttestation')(function* (
  input: CursorAttestationChallengeInputV1,
  expectedMemoryEndpoint: string,
) {
  const system = yield* SystemInfo;
  const commands = yield* CommandExecutor;
  const socket = yield* Effect.try({
    try: () => cursorAgentSocket(system.environment().CURSOR_AGENT_SOCKET),
    catch: cause =>
      Schema.is(CursorAttestationError)(cause)
        ? cause
        : CursorAttestationError.make({message: 'CURSOR_AGENT_SOCKET is not a valid Unix socket path.'}),
  });
  const execute: CurlExecute = (args, options) => commands.execute('curl', args, options);
  const client: CursorAttestationExchangeClient = {
    complete: (challenge, token) => completeChallengeWithCurl(challenge, token, execute),
    mint: challenge => mintCursorTokenWithCurl(challenge, socket, execute),
  };
  return yield* completeCursorAttestationChallenge(input, expectedMemoryEndpoint, client);
});

export const runCursorAttestationCommand = Effect.fn('cursorCloud.attestationCommand')(function* (
  options: CursorAttestationCommandOptions,
) {
  const receipt = yield* runCursorAttestationChallenge(
    {
      audience: options.audience,
      challengeId: options.challenge,
      completionUrl: options.completionUrl,
      expiresAt: options.expiresAt,
      nonce: options.nonce,
    },
    options.endpoint,
  );
  yield* Console.log(
    options.json ? JSON.stringify(receipt) : `Cursor workload attestation completed: ${receipt.attestationId}`,
  );
});

type CurlExecute = (args: readonly string[], options: CommandOptions) => Effect.Effect<CommandResult, unknown>;

function mintCursorTokenWithCurl(challenge: CursorAttestationChallengeV1, socket: string, execute: CurlExecute) {
  const body = JSON.stringify({aud: challenge.audience, nonce: challenge.nonce});
  return curlJson(socket, CURSOR_OIDC_PATH, body, 8_000, execute, true).pipe(
    Effect.flatMap(response => {
      if (response.status < 200 || response.status >= 300) {
        return Effect.fail(
          CursorAttestationError.make({message: 'Cursor rejected the workload identity token request.'}),
        );
      }
      const parsed = parseObject(response.body);
      if (parsed === undefined || typeof parsed.token !== 'string' || typeof parsed.expires_at !== 'number') {
        return Effect.fail(
          CursorAttestationError.make({message: 'Cursor returned an invalid workload identity response.'}),
        );
      }
      return Effect.succeed({expiresAt: parsed.expires_at, token: parsed.token});
    }),
  );
}

function completeChallengeWithCurl(challenge: CursorAttestationChallengeV1, token: string, execute: CurlExecute) {
  const body = JSON.stringify({challengeId: challenge.challengeId, token});
  return curlJson(undefined, challenge.completionUrl, body, 10_000, execute).pipe(
    Effect.flatMap(response => {
      if (response.status < 200 || response.status >= 300) {
        return Effect.fail(
          CursorAttestationError.make({message: 'Threadnote rejected the workload attestation completion.'}),
        );
      }
      const parsed = parseObject(response.body);
      if (parsed === undefined || typeof parsed.attestationId !== 'string') {
        return Effect.fail(
          CursorAttestationError.make({message: 'Threadnote returned an invalid workload attestation response.'}),
        );
      }
      return Effect.succeed({
        attestationId: parsed.attestationId,
        ...(typeof parsed.expiresAt === 'string' ? {expiresAt: parsed.expiresAt} : {}),
      });
    }),
  );
}

function curlJson(
  socket: string | undefined,
  url: string,
  input: string,
  timeoutMs: number,
  execute: CurlExecute,
  retryTransient = false,
) {
  const args = [
    '--silent',
    '--show-error',
    '--max-time',
    String(Math.ceil(timeoutMs / 1_000)),
    ...(retryTransient ? ['--retry', '2', '--retry-delay', '1', '--retry-max-time', '6', '--retry-connrefused'] : []),
    ...(socket ? ['--unix-socket', socket] : []),
    '--header',
    'Content-Type: application/json',
    '--request',
    'POST',
    '--data-binary',
    '@-',
    '--write-out',
    '\n%{http_code}',
    url,
  ];
  return execute(args, {
    input: new TextEncoder().encode(input),
    maxOutputBytes: CURL_OUTPUT_MAX_BYTES,
    timeoutMs,
  }).pipe(
    Effect.flatMap(result =>
      Effect.try({
        try: () => parseCurlOutput(result.stdout),
        catch: () => CursorAttestationError.make({message: 'Cursor workload attestation network exchange failed.'}),
      }),
    ),
    Effect.mapError(() =>
      CursorAttestationError.make({message: 'Cursor workload attestation network exchange failed.'}),
    ),
  );
}

function parseCurlOutput(output: string): {readonly body: string; readonly status: number} {
  const separator = Effect2.pipe(
    output,
    EffectString.lastIndexOf('\n'),
    Effect2.Option.getOrElse(() => -1),
  );
  const statusText = separator >= 0 ? Effect2.pipe(output, EffectString.slice(separator + 1)) : '';
  if (!/^\d{3}$/u.test(statusText)) {
    throw CursorAttestationError.make({
      message: 'Cursor workload attestation network exchange returned an invalid response.',
    });
  }
  return {body: Effect2.pipe(output, EffectString.slice(0, separator)), status: Number(statusText)};
}

function parseObject(body: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (Predicate.isObject(parsed)) return parsed;
  } catch {
    // The caller's bounded error deliberately excludes the response body.
  }
  return undefined;
}

function httpsUrl(value: unknown, name: string, maximum: number): string {
  const text = requiredString(value, name, maximum);
  if (!/^[\x21-\x7e]+$/u.test(text)) {
    throw CursorAttestationError.make({message: `Cursor attestation ${name} must be a bounded printable HTTPS URL.`});
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw CursorAttestationError.make({message: `Cursor attestation ${name} must be a valid HTTPS URL.`});
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0 ||
    parsed.search.length > 0
  ) {
    throw CursorAttestationError.make({
      message: `Cursor attestation ${name} must be credential-free HTTPS without a query or fragment.`,
    });
  }
  const normalized = parsed.toString();
  if (normalized.length > maximum) {
    throw CursorAttestationError.make({message: `Cursor attestation ${name} must be a bounded printable HTTPS URL.`});
  }
  return normalized;
}

function portableOpaqueValue(value: unknown, name: string, maximum: number, minimum = 1): string {
  const text = requiredString(value, name, maximum);
  if (text.length < minimum || !/^[A-Za-z0-9._~-]+$/u.test(text)) {
    throw CursorAttestationError.make({message: `Cursor attestation ${name} must be a portable opaque identifier.`});
  }
  return text;
}

function requiredString(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    Effect2.pipe(value, EffectString.trim) !== value
  ) {
    throw CursorAttestationError.make({message: `Cursor attestation ${name} is required and exceeds its safe bounds.`});
  }
  return value;
}

function optionalTimestamp(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw CursorAttestationError.make({message: 'Threadnote returned an invalid workload attestation response.'});
  }
  return new Date(milliseconds).toISOString();
}

function cursorAgentSocket(value: string | undefined): string {
  const socket =
    Effect2.pipe(value, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    ) || CURSOR_AGENT_SOCKET_DEFAULT;
  if (!Effect2.pipe(socket, EffectString.startsWith('/')) || socket.length > 1_024 || /[\0\r\n]/u.test(socket)) {
    throw CursorAttestationError.make({message: 'CURSOR_AGENT_SOCKET must be a bounded absolute Unix socket path.'});
  }
  return socket;
}
