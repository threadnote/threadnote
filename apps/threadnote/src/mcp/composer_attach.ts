import {Array as EffectArray} from 'effect';
import {Schema} from 'effect';
import {THREADNOTE_MCP_NAME} from '../constants.js';
import {COMPOSER_OAUTH_CLIENT_ID} from '../remote_memory/local_idp.js';
import {COMPOSER_OAUTH_SCOPES} from '@threadnote/remote-memory/oauth';
import type {JsonObject} from '@threadnote/platform/json';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const THREADNOTE_ORG_MCP_NAME = 'threadnote-org' as const;
export const THREADNOTE_COMPOSER_SHARE_ID_HEADER = 'threadnote-share-id';
const COMPOSER_SHARE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export const ORG_COMPOSER_POLICY = {
  canonicalStore: 'git',
  cursorOidc: 'optional-attribution',
  oauth: 'org-idp',
  shareBinding: 'header',
} as const;

export class ComposerAttachError extends Schema.TaggedError<ComposerAttachError, {readonly brand: unique symbol}>()(
  'ComposerAttachError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

export interface ComposerShareBinding {
  readonly clientId?: string;
  readonly additionalScopes?: readonly string[];
  readonly callback?: {readonly url: string; readonly port: number};
  readonly shareId: string;
  readonly url: string;
}

export interface ComposerMcpOAuthAuth {
  readonly CLIENT_ID: string;
  readonly scopes: readonly string[];
}

export interface ComposerHttpMcpEntry {
  readonly [key: string]: unknown;
  readonly type?: never;
  readonly auth: ComposerMcpOAuthAuth;
  readonly headers: Readonly<{readonly [THREADNOTE_COMPOSER_SHARE_ID_HEADER]: string}>;
  readonly url: string;
}

export interface CopilotComposerHttpMcpEntry {
  readonly [key: string]: unknown;
  readonly type: 'http';
  readonly oauth: Readonly<{clientId: string}>;
  readonly headers: ComposerHttpMcpEntry['headers'];
  readonly url: string;
}

export type ComposerClientHttpMcpEntry = ComposerHttpMcpEntry | CopilotComposerHttpMcpEntry;

export interface ComposerAttachOptions {
  readonly composerClientId?: string;
  readonly composerOAuthScopes?: readonly string[];
  readonly composerCallbackUrl?: string;
  readonly composerCallbackPort?: number;
  readonly composerUrl?: string;
  readonly shareId?: string;
}

export function resolveComposerAttach(options: ComposerAttachOptions): ComposerShareBinding | undefined {
  const composerUrl = Effect.pipe(options.composerUrl, effectOptionalString =>
    effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
  );
  const shareId = Effect.pipe(options.shareId, effectOptionalString =>
    effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
  );
  if (
    !composerUrl &&
    !shareId &&
    options.composerClientId === undefined &&
    !options.composerOAuthScopes?.length &&
    options.composerCallbackUrl === undefined &&
    options.composerCallbackPort === undefined
  )
    return undefined;
  if (!composerUrl || !shareId) {
    throw ComposerAttachError.make({
      message: 'Organization composer attach requires both --composer-url and --share-id.',
    });
  }
  return {
    ...(options.composerClientId === undefined ? {} : {clientId: composerOAuthClientId(options.composerClientId)}),
    ...(options.composerOAuthScopes?.length
      ? {
          additionalScopes: EffectArray.filter(
            composerOAuthScopes(options.composerOAuthScopes),
            scope => !EffectArray.some(COMPOSER_OAUTH_SCOPES, required => required === scope),
          ),
        }
      : {}),
    ...(options.composerCallbackUrl === undefined && options.composerCallbackPort === undefined
      ? {}
      : {
          callback: composerOAuthCallback(options.composerCallbackUrl, options.composerCallbackPort),
        }),
    shareId: composerShareId(shareId),
    url: composerMcpUrl(composerUrl),
  };
}

export function resolveComposerServeShareId(teamName: string, shareId?: string): string {
  return composerShareId(
    Effect.pipe(shareId, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
    ) || teamName,
  );
}

export function composerShareId(shareId: string): string {
  const normalized = Effect.pipe(shareId, EffectString.trim);
  if (!COMPOSER_SHARE_ID_PATTERN.test(normalized)) {
    throw ComposerAttachError.make({
      message:
        'The organization composer share ID must be an opaque identifier containing only letters, digits, dot, underscore, or hyphen.',
    });
  }
  return normalized;
}

export function composerMcpUrl(endpoint: string): string {
  const normalized = Effect.pipe(endpoint, EffectString.trim);
  const hasUnsafeCharacter = EffectArray.some([...normalized], character => {
    const codePoint =
      Effect.pipe(
        character,
        EffectString.codePointAt(0),
        Effect.Option.getOrElse(() => undefined),
      ) ?? 0;
    return /\s/u.test(character) || codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (!normalized || hasUnsafeCharacter) {
    throw ComposerAttachError.make({message: 'The organization composer endpoint must be a valid MCP URL.'});
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw ComposerAttachError.make({message: 'The organization composer endpoint must be a valid MCP URL.'});
  }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  if (
    (parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:')) ||
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0 ||
    parsed.search.length > 0 ||
    parsed.pathname !== '/mcp'
  ) {
    throw ComposerAttachError.make({
      message:
        'The organization composer endpoint must be the credential-free /mcp URL without a query or fragment; HTTPS is required outside loopback.',
    });
  }
  if (parsed.hostname === 'localhost') parsed.hostname = '127.0.0.1';
  return parsed.toString();
}

export function buildComposerHttpMcpEntry(
  url: string,
  shareId: string,
  clientId: string = COMPOSER_OAUTH_CLIENT_ID,
  additionalScopes: readonly string[] = [],
): ComposerHttpMcpEntry {
  return {
    auth: {
      CLIENT_ID: composerOAuthClientId(clientId),
      scopes: composerOAuthScopes(additionalScopes),
    },
    headers: {[THREADNOTE_COMPOSER_SHARE_ID_HEADER]: composerShareId(shareId)},
    url: composerMcpUrl(url),
  };
}

export function buildCopilotComposerHttpMcpEntry(
  url: string,
  shareId: string,
  clientId: string = COMPOSER_OAUTH_CLIENT_ID,
): CopilotComposerHttpMcpEntry {
  const entry = buildComposerHttpMcpEntry(url, shareId, clientId);
  return {type: 'http', url: entry.url, headers: entry.headers, oauth: {clientId: entry.auth.CLIENT_ID}};
}

export function withComposerHttpMcpEntry(
  servers: Readonly<Record<string, JsonObject>>,
  stdioName: string,
  stdio: JsonObject,
  attach: ComposerShareBinding | undefined,
  client: 'cursor' | 'copilot' = 'cursor',
): Record<string, JsonObject> {
  if (attach && stdioName === THREADNOTE_ORG_MCP_NAME) {
    throw ComposerAttachError.make({
      message: 'Organization composer attach cannot use the reserved HTTP server name for the stdio Git adapter.',
    });
  }
  const next: Record<string, JsonObject> = {...servers, [stdioName]: stdio};
  if (attach) {
    if (client === 'copilot' && (attach.additionalScopes?.length || attach.callback)) {
      throw ComposerAttachError.make({
        message: 'Additional OAuth scopes and callbacks are not supported for Copilot attach.',
      });
    }
    next[THREADNOTE_ORG_MCP_NAME] =
      client === 'copilot'
        ? buildCopilotComposerHttpMcpEntry(attach.url, attach.shareId, attach.clientId)
        : buildComposerHttpMcpEntry(attach.url, attach.shareId, attach.clientId, attach.additionalScopes);
  }
  return next;
}

export function teamStdioServers(
  stdio: JsonObject,
  attach: ComposerShareBinding | undefined,
): Record<string, JsonObject> {
  return withComposerHttpMcpEntry({}, THREADNOTE_MCP_NAME, stdio, attach);
}

export function stdioEnvironmentCallsComposer(env: Readonly<Record<string, unknown>>): boolean {
  return typeof env.THREADNOTE_CURSOR_MEMORY_ENDPOINT === 'string' && env.THREADNOTE_CURSOR_MEMORY_ENDPOINT.length > 0;
}

export function composerHttpEntryMatches(actual: unknown, expected: ComposerClientHttpMcpEntry): boolean {
  if (
    !isComposerHttpEntry(actual) ||
    actual.url !== expected.url ||
    actual.headers[THREADNOTE_COMPOSER_SHARE_ID_HEADER] !== expected.headers[THREADNOTE_COMPOSER_SHARE_ID_HEADER]
  )
    return false;
  return actual.type === 'http'
    ? expected.type === 'http' && actual.oauth.clientId === expected.oauth.clientId
    : expected.type !== 'http' &&
        actual.auth.CLIENT_ID === expected.auth.CLIENT_ID &&
        composerOAuthScopesMatch(actual.auth.scopes, expected.auth.scopes);
}

export function isManagedComposerHttpEntry(actual: unknown): boolean {
  return (
    isComposerHttpEntry(actual) &&
    (actual.type === 'http' ? actual.oauth.clientId : actual.auth.CLIENT_ID) === COMPOSER_OAUTH_CLIENT_ID &&
    (actual.type === 'http' ||
      (actual.auth.scopes.length === COMPOSER_OAUTH_SCOPES.length &&
        EffectArray.every(actual.auth.scopes, (scope, index) => scope === COMPOSER_OAUTH_SCOPES[index])))
  );
}

export function isComposerHttpEntry(actual: unknown): actual is ComposerClientHttpMcpEntry {
  if (!isRecord(actual) || typeof actual.url !== 'string' || !isRecord(actual.headers)) return false;
  const shareId = actual.headers[THREADNOTE_COMPOSER_SHARE_ID_HEADER];
  if (typeof shareId !== 'string' || EffectRecord.keys(actual.headers).length !== 1) return false;
  let clientId: string;
  if (actual.type === 'http') {
    if (EffectArray.some(EffectRecord.keys(actual), key => !['type', 'url', 'headers', 'oauth'].includes(key)))
      return false;
    if (!isRecord(actual.oauth) || typeof actual.oauth.clientId !== 'string') return false;
    if (EffectRecord.keys(actual.oauth).length !== 1) return false;
    clientId = actual.oauth.clientId;
  } else {
    if (EffectArray.some(EffectRecord.keys(actual), key => !['url', 'headers', 'auth'].includes(key))) return false;
    if (!isRecord(actual.auth) || typeof actual.auth.CLIENT_ID !== 'string' || !EffectArray.isArray(actual.auth.scopes))
      return false;
    if (EffectArray.some(EffectRecord.keys(actual.auth), key => key !== 'CLIENT_ID' && key !== 'scopes')) return false;
    if (!validComposerOAuthScopes(actual.auth.scopes)) return false;
    clientId = actual.auth.CLIENT_ID;
  }
  try {
    composerMcpUrl(actual.url);
    composerShareId(shareId);
    composerOAuthClientId(clientId);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !EffectArray.isArray(value);
}

function composerOAuthClientId(value: string): string {
  if (!/^[\x21-\x7e]{1,512}$/u.test(value)) {
    throw ComposerAttachError.make({
      message: 'The organization OAuth client ID must be 1–512 visible ASCII characters.',
    });
  }
  return value;
}

export function composerOAuthScopes(additionalScopes: readonly string[] = []): readonly string[] {
  if (
    additionalScopes.length > 32 ||
    EffectArray.some(additionalScopes, scope => !/^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/u.test(scope))
  ) {
    throw ComposerAttachError.make({
      message:
        'OAuth scopes require at most 32 non-empty RFC 6749 scope tokens of at most 256 ASCII characters each (no spaces, quotes, or backslashes).',
    });
  }
  const extras = EffectArray.filter(
    [...new Set(additionalScopes)],
    scope => !EffectArray.some(COMPOSER_OAUTH_SCOPES, required => required === scope),
  ).sort();
  const scopes = [...COMPOSER_OAUTH_SCOPES, ...extras];
  if (scopes.length > 32 || EffectArray.join(scopes, ' ').length > 2048) {
    throw ComposerAttachError.make({
      message: 'The complete OAuth scope set must contain at most 32 tokens and 2048 bytes.',
    });
  }
  return scopes;
}

export function composerOAuthScopesMatch(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    EffectArray.every(expected, scope => actual.includes(scope))
  );
}

function validComposerOAuthScopes(scopes: readonly unknown[]): scopes is readonly string[] {
  if (!EffectArray.every(scopes, scope => typeof scope === 'string')) return false;
  try {
    return composerOAuthScopesMatch(scopes, composerOAuthScopes(scopes));
  } catch {
    return false;
  }
}

function composerOAuthCallback(url: string | undefined, port: number | undefined): {url: string; port: number} {
  const message =
    'Codex OAuth callback requires both a credential-free http://127.0.0.1 callback URL and a matching --composer-callback-port between 1024 and 65535, without query or fragment.';
  if (!url || port === undefined || !Number.isInteger(port) || port < 1024 || port > 65535 || /\s/u.test(url)) {
    throw ComposerAttachError.make({message});
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw ComposerAttachError.make({message});
  }
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== '127.0.0.1' ||
    Number(parsed.port) !== port ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw ComposerAttachError.make({message});
  }
  return {url, port};
}
