import {Clock, Context, Effect, Option, Redacted, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';

/** Descriptors contain identities, never credentials or fetched document content. */
export interface SourceWorkDescriptor {
  readonly sourceId: string;
  readonly provider: string;
  readonly accountKey: string;
  readonly fingerprint: string;
  readonly refreshIntervalMs: number;
  readonly credentialEnv?: string;
}

export interface SourceWorkResult {
  readonly sourceId: string;
  readonly syncedDocuments: readonly string[];
  readonly warnings: readonly string[];
  readonly output?: readonly string[];
  readonly nextAttemptAt?: number;
  readonly more?: boolean;
  /** Public provider command result. Kept only in the live worker reply cache. */
  readonly value?: unknown;
}

export interface SourceWorkOptions {
  readonly mode: 'automatic' | 'explicit';
  readonly requestId: string;
  /** Ephemeral caller environment. Never written to the queue or SQLite. */
  readonly credentialEnvironment: Readonly<Record<string, string>>;
}

export interface SourceWorkRegistration<R = never> {
  readonly provider: string;
  readonly admission?: {readonly limit: number; readonly windowMs: number};
  readonly list: (config: RuntimeConfig) => Effect.Effect<readonly SourceWorkDescriptor[], unknown, R>;
  readonly run: (
    config: RuntimeConfig,
    sourceId: string,
    options: SourceWorkOptions,
  ) => Effect.Effect<SourceWorkResult, unknown, R>;
}

export interface SourceAdmissionRequest {
  readonly config: RuntimeConfig;
  readonly provider: string;
  /** Opaque credential/principal fingerprint, never a token or email address. */
  readonly accountKey: string;
  readonly method: string;
}

export class SourceCoordinatorError extends Schema.TaggedError<SourceCoordinatorError>()('SourceCoordinatorError', {
  message: Schema.String,
}) {}

export class SourceHttpAdmission extends Context.Service<
  SourceHttpAdmission,
  {
    readonly admit: (request: SourceAdmissionRequest) => Effect.Effect<void, SourceCoordinatorError>;
    readonly cooldown: (
      request: SourceAdmissionRequest & {readonly retryAfterMs: number},
    ) => Effect.Effect<void, SourceCoordinatorError>;
  }
>()('@threadnote/integration-core/source-coordinator/SourceHttpAdmission') {}

export class SourceCoordinator extends Context.Service<
  SourceCoordinator,
  {
    readonly requestRefresh: (config: RuntimeConfig) => Effect.Effect<void, SourceCoordinatorError>;
    readonly sync: (config: RuntimeConfig, sourceId: string) => Effect.Effect<SourceWorkResult, SourceCoordinatorError>;
  }
>()('@threadnote/integration-core/source-coordinator/SourceCoordinator') {}

export type SourceFetch = (input: URL, init: RequestInit) => Promise<Response>;

export function sourceAccountKey(provider: string, token: Redacted.Redacted<string>): string {
  return sha256HexSync(`${provider}:${Redacted.value(token)}`);
}

/** Capture the Effect admission service at the existing Promise client boundary. */
export const admittedSourceFetch = Effect.fn('source.admittedFetch')(function* (
  provider: string,
  token: Redacted.Redacted<string>,
  fetchImpl: SourceFetch = fetch,
  config?: RuntimeConfig,
) {
  const admission = yield* Effect.serviceOption(SourceHttpAdmission);
  if (Option.isNone(admission)) return fetchImpl;
  if (config === undefined)
    return yield* SourceCoordinatorError.make({message: 'Source HTTP admission requires a runtime home.'});
  const context = yield* Effect.context<never>();
  // Intentional Promise fetch callback boundary captures the existing service context.
  // oxlint-disable-next-line threadnote/no-effect-runtime
  const run = Effect.runPromiseWith(context);
  const accountKey = sourceAccountKey(provider, token);
  return async (input: URL, init: RequestInit): Promise<Response> => {
    const request = {config, provider, accountKey, method: (init.method ?? 'GET').toUpperCase()};
    const signal = init.signal ?? undefined;
    await run(admission.value.admit(request), {signal});
    signal?.throwIfAborted();
    const response = await fetchImpl(input, init);
    if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
      const header = response.headers.get('retry-after');
      const seconds = header === null ? NaN : Number(header);
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1_000 - Date.now();
      const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : Date.parse(header ?? '') - Date.now();
      const retryAfterMs = Math.min(
        Math.max(60_000, 8_640_000_000_000_000 - Date.now() - 1),
        Math.max(60_000, Number.isFinite(delay) ? delay : Number.isFinite(reset) ? reset : 60_000),
      );
      await run(admission.value.cooldown({...request, retryAfterMs}), {signal});
    }
    return response;
  };
});

/** An omitted caller credential clears the old process environment binding. */
export function withSourceCredentialEnvironment<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  credentialEnv: string,
  values: Readonly<Record<string, string>>,
) {
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    const environment = {...system.environment()};
    delete environment[credentialEnv];
    if (values[credentialEnv] !== undefined) environment[credentialEnv] = values[credentialEnv];
    return yield* effect.pipe(Effect.provideService(SystemInfo, {...system, environment: () => environment}));
  });
}

export const cooldownSourceAccount = Effect.fn('source.cooldownAccount')(function* (
  config: RuntimeConfig,
  provider: string,
  token: Redacted.Redacted<string>,
  retryAfterMs: number,
  method: string,
) {
  const admission = yield* Effect.serviceOption(SourceHttpAdmission);
  const now = yield* Clock.currentTimeMillis;
  if (Option.isSome(admission))
    yield* admission.value.cooldown({
      config,
      provider,
      accountKey: sourceAccountKey(provider, token),
      method,
      retryAfterMs: Math.min(
        Math.max(60_000, 8_640_000_000_000_000 - now - 1),
        Math.max(60_000, Number.isFinite(retryAfterMs) ? retryAfterMs : 60_000),
      ),
    });
});
