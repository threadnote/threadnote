import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Clock, Effect, FileSystem, Path, Redacted, Schema, Semaphore} from 'effect';
import {CommandExecutor} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {readBoundedPrivateBytes} from '../atomic.js';
import {sha256Digest, SHA256_DIGEST, SHA256_HEX} from '../digest.js';
import {graphSharingFailure, graphSharingUnavailable} from '../errors.js';
import {graphSharingLayout} from '../layout.js';
import {canonicalOAuthUrl} from '../oauth/m2m_config.js';

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const Organization = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/u));
const Scope = Schema.Struct({
  coordinatorUrl: Text,
  organization: Organization,
  profileDigest: Schema.String.check(Schema.isPattern(SHA256_DIGEST)),
  repositoryId: Schema.String.check(Schema.isPattern(SHA256_HEX)),
});
const Binding = Schema.Struct({
  audience: Text,
  coordinatorUrl: Text,
  helper: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u)),
  issuer: Text,
  organization: Organization,
});
export const GraphControlCredentialConfiguration = Schema.Struct({
  bindings: Schema.Array(Binding).check(Schema.isMaxLength(32)),
  schemaVersion: Schema.Literal(1),
});
const HelperResponse = Schema.Struct({
  accessToken: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._~+/-]+=*$/u), Schema.isMaxLength(16_384)),
  audience: Text,
  expiresAt: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  issuer: Text,
  schemaVersion: Schema.Literal(1),
  subject: Text,
});
const STRICT = {onExcessProperty: 'error'} as const;

export type GraphControlClientScope = typeof Scope.Type;
export interface GraphControlCredential {
  readonly authorization: Redacted.Redacted<string>;
  readonly expiresAt: number;
  readonly identity: string;
  readonly principalId: string;
}

/** Call only with an approved repository profile. Helpers are selected from private device configuration. */
export const makeGraphControlCredentialLoader = Effect.fn('codeGraph.sharing.controlCredentialLoader')(function* (
  home: string,
  input: GraphControlClientScope,
  capability: 'graph:read' | 'graph:contribute',
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const command = yield* CommandExecutor;
  const system = yield* SystemInfo;
  const scope = yield* Schema.decodeEffect(
    Scope,
    STRICT,
  )(input).pipe(Effect.mapError(() => graphSharingFailure('Graph control credential scope is invalid.')));
  if (!canonicalOAuthUrl(scope.coordinatorUrl))
    return yield* graphSharingFailure('Graph control credentials require an exact HTTPS resource.');
  const configPath = path.join(graphSharingLayout(path, home).root, 'control-credentials.json');
  const gate = yield* Semaphore.make(1);
  let cached: {bindingId: string; credential: GraphControlCredential; refreshAt: number} | undefined;

  const load = gate.withPermit(
    Effect.gen(function* () {
      if (!(yield* fs.exists(configPath))) {
        cached = undefined;
        return yield* graphSharingUnavailable('Organization graph credentials need setup.');
      }
      const bytes = yield* readBoundedPrivateBytes(configPath, 65_536).pipe(
        Effect.mapError(() => graphSharingFailure('Graph control credential configuration is unavailable.')),
      );
      const text = yield* Effect.try({
        try: () => new TextDecoder('utf-8', {fatal: true}).decode(bytes),
        catch: () => graphSharingFailure('Graph control credential configuration is invalid.'),
      });
      const config = yield* Schema.decodeEffect(
        Schema.fromJsonString(GraphControlCredentialConfiguration),
        STRICT,
      )(text).pipe(Effect.mapError(() => graphSharingFailure('Graph control credential configuration is invalid.')));
      if (
        EffectArray.some(
          config.bindings,
          binding =>
            !canonicalOAuthUrl(binding.coordinatorUrl) ||
            !canonicalOAuthUrl(binding.issuer) ||
            !canonicalOAuthUrl(binding.audience),
        ) ||
        new Set(
          EffectArray.map(config.bindings, binding => JSON.stringify([binding.coordinatorUrl, binding.organization])),
        ).size !== config.bindings.length
      )
        return yield* graphSharingFailure('Graph control credential configuration is invalid.');
      const binding = EffectOption.getOrUndefined(
        EffectArray.findFirst(
          config.bindings,
          item => item.coordinatorUrl === scope.coordinatorUrl && item.organization === scope.organization,
        ),
      );
      if (binding === undefined) {
        cached = undefined;
        return yield* graphSharingUnavailable('Organization graph credentials need setup.');
      }
      const bindingId = sha256Digest(JSON.stringify([binding, scope, capability]));
      const now = yield* Clock.currentTimeMillis;
      if (cached?.bindingId === bindingId && cached.refreshAt > now) return cached.credential;
      cached = undefined;
      const isPackagedOAuthUser = binding.helper === 'auth0' || binding.helper === 'oauth';
      const oauthUserArgument = binding.helper === 'auth0' ? '__graph-auth0-helper' : '__graph-oauth-helper';
      const helper = isPackagedOAuthUser
        ? typeof THREADNOTE_STANDALONE !== 'undefined' && THREADNOTE_STANDALONE
          ? {executable: system.executablePath, args: [oauthUserArgument, 'get']}
          : {
              executable: system.executablePath,
              args: [system.developmentEntrypoint, oauthUserArgument, 'get'],
            }
        : {executable: `threadnote-credential-${binding.helper}`, args: ['get']};
      const result = yield* command
        .execute(helper.executable, helper.args, {
          allowFailure: true,
          env: {...system.environment(), THREADNOTE_HOME: home},
          input: new TextEncoder().encode(
            JSON.stringify({
              ...scope,
              audience: binding.audience,
              issuer: binding.issuer,
              interactive: false,
              schemaVersion: 1,
              scopes: [capability],
            }) + '\n',
          ),
          maxOutputBytes: 32_768,
          // The packaged OAuth helper may need both a token exchange and a cold JWKS fetch.
          timeoutMs: isPackagedOAuthUser
            ? 25_000
            : binding.helper === 'auth0-m2m' || binding.helper === 'oauth-m2m'
              ? 10_000
              : 5_000,
        })
        .pipe(Effect.mapError(() => graphSharingUnavailable('Graph control credential helper is unavailable.')));
      if (result.exitCode !== 0)
        return yield* graphSharingUnavailable('Graph control credential helper denied access.');
      const token = yield* Schema.decodeEffect(
        Schema.fromJsonString(HelperResponse),
        STRICT,
      )(result.stdout).pipe(
        Effect.mapError(() => graphSharingFailure('Graph control credential helper response is invalid.')),
      );
      const loadedAt = yield* Clock.currentTimeMillis;
      if (token.issuer !== binding.issuer || token.audience !== binding.audience || token.expiresAt <= loadedAt / 1000)
        return yield* graphSharingFailure('Graph control credential helper response is outside its authority.');
      const principalId = sha256Digest(JSON.stringify([token.issuer, token.subject]));
      const credential: GraphControlCredential = {
        authorization: Redacted.make(`Bearer ${token.accessToken}`),
        expiresAt: token.expiresAt,
        identity: sha256Digest(JSON.stringify([bindingId, principalId])),
        principalId,
      };
      const remaining = token.expiresAt * 1000 - loadedAt;
      cached = {
        bindingId,
        credential,
        refreshAt: loadedAt + Math.min(300_000, remaining - Math.min(30_000, remaining / 10)),
      };
      return credential;
    }),
  );
  return {
    load,
    invalidate: (used: GraphControlCredential) => {
      if (cached?.credential === used) cached = undefined;
    },
  };
});
