import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {Clock, Effect, Schema} from 'effect';
import type {ProjectManifest, ResolvedWorkset} from '@threadnote/workspace/config';
import {errorMessage} from '@threadnote/platform/errors';
import {formatStaleVersionNotice, trimTrailingSlash} from '../../utils.js';
import {exactMemoryScopeUris, exactRecallScopeIntents} from '@threadnote/recall/results';
import {activeInstalledVersion} from '../../installations.js';
import {parseResourceId} from '@threadnote/store/resource-id';
import {uriSegment} from '@threadnote/store/resource-segment';
import {attachAnonymousTelemetryDiagnostic, attachAnonymousTelemetryError} from '../../telemetry/diagnostic.js';
export {uriSegment};
export interface RuntimeConfig {
  readonly account: string;
  readonly agentContextHome: string;
  readonly agentId: string;
  readonly manifestPath: string;
  readonly user: string;
}

export type CheckedText =
  | {
      readonly ok: true;
      readonly value: string;
    }
  | {
      readonly error: CallToolResult;
      readonly ok: false;
    };

export type CheckedOptionalText =
  | {
      readonly ok: true;
      readonly value: string | undefined;
    }
  | {
      readonly error: CallToolResult;
      readonly ok: false;
    };

export type CheckedTextArray =
  | {
      readonly ok: true;
      readonly value: readonly string[];
    }
  | {
      readonly error: CallToolResult;
      readonly ok: false;
    };

export type CheckedOptionalTextArray =
  | {
      readonly ok: true;
      readonly value: readonly string[] | undefined;
    }
  | {
      readonly error: CallToolResult;
      readonly ok: false;
    };

// Version this MCP server process started from, captured at startup. A later
// `threadnote update` overwrites the package on disk, but this resident stdio
// process keeps running the old code (clients don't respawn an MCP server on
// update), so we compare against the on-disk version and nudge the caller to
// reconnect — otherwise they silently keep hitting stale code.
let mcpStartupVersion: string | undefined;
let staleNoticeCache: {readonly checkedAtMs: number; readonly notice: string | undefined} | undefined;
export class McpServerOperationError extends Schema.TaggedError<McpServerOperationError>()('McpServerOperationError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

const STALE_NOTICE_TTL_MS = 60_000;

export interface RecallProgressTiming {
  readonly heartbeatMilliseconds: number;
  readonly sharedSyncDelayMilliseconds: number;
}

const staleVersionNotice = Effect.fn('mcpServer.staleVersionNotice')(function* () {
  if (mcpStartupVersion === undefined) {
    return undefined;
  }
  const startupVersion = mcpStartupVersion;
  const nowMs = yield* Clock.currentTimeMillis;
  if (staleNoticeCache && nowMs - staleNoticeCache.checkedAtMs < STALE_NOTICE_TTL_MS) {
    return staleNoticeCache.notice;
  }
  const notice = yield* activeInstalledVersion().pipe(
    Effect.map(version => (version ? formatStaleVersionNotice(startupVersion, version) : undefined)),
  );
  staleNoticeCache = {checkedAtMs: nowMs, notice};
  return notice;
});

export const withStaleVersionNotice = Effect.fn('mcpServer.withStaleVersionNotice')(function* (result: CallToolResult) {
  const notice = yield* staleVersionNotice();
  if (notice === undefined) {
    return result;
  }
  return {...result, content: [...(result.content ?? []), {type: 'text', text: `⚠ ${notice}`}]};
});

export function exactMemoryScopes(
  config: RuntimeConfig,
  includeArchived: boolean,
  query: string,
  projectName: string | undefined,
  project: ProjectManifest | undefined,
): readonly string[] {
  return exactMemoryScopeUris({
    agentMemoriesUri: `threadnote://agent/${uriSegment(config.agentId)}/memories`,
    includeArchived,
    intents: exactRecallScopeIntents(query),
    projectName: projectName ? uriSegment(projectName) : undefined,
    projectResourceUri: project ? trimTrailingSlash(project.uri) : undefined,
    userBase: `threadnote://user/${uriSegment(config.user)}/memories`,
  });
}

export const MAX_WORKSET_PASSES = 12;

/** Durable + seeded recall scopes for every member of a workset (see src/memory/index.ts:worksetScopeUris). */
export function worksetScopeUris(config: RuntimeConfig, workset: ResolvedWorkset): readonly string[] {
  const scopes: string[] = [];
  for (const member of workset.projects) {
    scopes.push(`threadnote://user/${uriSegment(config.user)}/memories/durable/projects/${uriSegment(member.name)}`);
    const seeded = trimTrailingSlash(member.uri);
    if (seeded.startsWith('threadnote://')) {
      scopes.push(seeded);
    }
  }
  return [...new Set(scopes)];
}

export function projectMemoryScopeUris(
  config: RuntimeConfig,
  projectName: string | undefined,
  includeArchived: boolean,
): readonly string[] {
  if (!projectName) {
    return [];
  }
  const base = `threadnote://user/${uriSegment(config.user)}/memories`;
  const projectSegment = uriSegment(projectName);
  const scopes = [
    `${base}/durable/projects/${projectSegment}`,
    `${base}/handoffs/active/${projectSegment}`,
    `${base}/incidents/active/${projectSegment}`,
  ];
  return includeArchived
    ? [
        ...scopes,
        `${base}/durable/archived/${projectSegment}`,
        `${base}/handoffs/archived/${projectSegment}`,
        `${base}/incidents/archived/${projectSegment}`,
      ]
    : scopes;
}

export function normalizeOptionalMetadata(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function requiredText(
  value: string | undefined,
  toolName: string,
  fieldName: string,
  example: Record<string, string>,
): CheckedText {
  const normalized = value?.trim();
  if (normalized) {
    return {ok: true, value: normalized};
  }
  return {
    error: argumentError(
      [
        `Threadnote MCP tool "${toolName}" needs a non-empty "${fieldName}" argument.`,
        'Pass JSON arguments to the tool call.',
        `Example: ${toolName}(${JSON.stringify(example)})`,
      ].join('\n'),
    ),
    ok: false,
  };
}

export function rejectLeadingDash(value: string, toolName: string, fieldName: string): CheckedText {
  if (!value.startsWith('-')) {
    return {ok: true, value};
  }
  return {
    error: argumentError(
      `Threadnote MCP tool "${toolName}" rejects "${fieldName}" values that start with "-". Prefix relative file paths with "./" or use an absolute path.`,
    ),
    ok: false,
  };
}

export function requiredResourceUri(value: string | undefined, toolName: string, exampleUri: string): CheckedText {
  const checked = requiredText(value, toolName, 'uri', {uri: exampleUri});
  if (!checked.ok) {
    return checked;
  }
  try {
    return {ok: true, value: parseResourceId(checked.value).canonicalUri};
  } catch {
    return {
      error: argumentError(`Threadnote MCP tool "${toolName}" needs a threadnote:// URI. Received: ${checked.value}`),
      ok: false,
    };
  }
}

export function optionalResourceUri(
  value: string | undefined,
  toolName: string,
  fieldName = 'uri',
): CheckedOptionalText {
  const normalized = value?.trim();
  if (!normalized) {
    return {ok: true, value: undefined};
  }
  try {
    return {ok: true, value: parseResourceId(normalized).canonicalUri};
  } catch {
    return {
      error: argumentError(
        `Threadnote MCP tool "${toolName}" optional "${fieldName}" must be a threadnote:// URI. Received: ${normalized}`,
      ),
      ok: false,
    };
  }
}

export function optionalResourceUriList(
  value: readonly string[] | string | undefined,
  toolName: string,
): CheckedOptionalTextArray {
  const rawValues = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const uris = rawValues.map(uri => uri.trim()).filter(Boolean);
  if (uris.length === 0) {
    return {ok: true, value: undefined};
  }
  const canonicalUris: string[] = [];
  for (const uri of uris) {
    try {
      canonicalUris.push(parseResourceId(uri).canonicalUri);
    } catch {
      return {
        error: argumentError(
          `Threadnote MCP tool "${toolName}" needs threadnote:// URI values for "references". Received: ${uri}`,
        ),
        ok: false,
      };
    }
  }
  return {ok: true, value: [...new Set(canonicalUris)]};
}

export function requiredResourceUriList(
  value: readonly string[] | string | undefined,
  toolName: string,
  exampleUri: string,
  options: {readonly personalMemoryUser?: string} = {},
): CheckedTextArray {
  const rawValues = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const uris = rawValues.map(uri => uri.trim()).filter(Boolean);
  if (uris.length === 0) {
    return {
      error: argumentError(
        [
          `Threadnote MCP tool "${toolName}" needs a non-empty "uri" or "uris" argument.`,
          'Pass JSON arguments to the tool call.',
          `Example: ${toolName}(${JSON.stringify({uris: [exampleUri]})})`,
        ].join('\n'),
      ),
      ok: false,
    };
  }
  const canonicalUris: string[] = [];
  for (const uri of uris) {
    try {
      canonicalUris.push(parseResourceId(expandPersonalMemoryReference(uri, options.personalMemoryUser)).canonicalUri);
    } catch {
      return {
        error: argumentError(
          `Threadnote MCP tool "${toolName}" needs threadnote:// URI values${options.personalMemoryUser === undefined ? '' : ' or compact memories/ paths returned by Threadnote'}. Received: ${uri}`,
        ),
        ok: false,
      };
    }
  }
  return {ok: true, value: [...new Set(canonicalUris)]};
}

export function compactPersonalMemoryReferences(text: string, user: string, enabled = true): string {
  return enabled
    ? text.replaceAll(/threadnote:\/\/[^\s`)\]}>"']+/gu, candidate => compactPersonalMemoryReference(candidate, user))
    : text;
}

/** Recursively compacts current-user memory URIs in JSON-compatible MCP structured content without mutating the input. */
export function compactPersonalMemoryStructuredReferences<T>(value: T, user: string): T {
  if (typeof value === 'string') return compactPersonalMemoryReferences(value, user) as T;
  if (Array.isArray(value)) {
    return value.map(item => compactPersonalMemoryStructuredReferences(item, user)) as T;
  }
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, compactPersonalMemoryStructuredReferences(item, user)]),
  ) as T;
}

function compactPersonalMemoryReference(candidate: string, user: string): string {
  let trailingStart = candidate.length;
  while (trailingStart > 0 && isCompactReferenceTrailingPunctuation(candidate[trailingStart - 1])) {
    trailingStart -= 1;
  }
  const trailingPunctuation = candidate.slice(trailingStart);
  const uri = candidate.slice(0, trailingStart);
  try {
    const parsed = parseResourceId(uri);
    const currentUserSegment = uriSegment(user);
    if (
      parsed.namespace !== 'user' ||
      (parsed.segments[0] !== user && parsed.segments[0] !== currentUserSegment) ||
      parsed.segments[1] !== 'memories'
    ) {
      return candidate;
    }
    const prefix = `threadnote://user/${encodeURIComponent(parsed.segments[0])}/`;
    return `${parsed.canonicalUri.slice(prefix.length)}${trailingPunctuation}`;
  } catch {
    return candidate;
  }
}

function isCompactReferenceTrailingPunctuation(value: string | undefined): boolean {
  return value === '.' || value === ',' || value === ';' || value === ':';
}

function expandPersonalMemoryReference(value: string, user: string | undefined): string {
  return user !== undefined && value.startsWith('memories/') ? `threadnote://user/${uriSegment(user)}/${value}` : value;
}

export function argumentError(text: string): CallToolResult {
  return attachAnonymousTelemetryDiagnostic(
    {content: [{type: 'text', text}], isError: true},
    {errorType: 'McpArgumentError'},
  );
}

/** User-facing MCP failure plus a non-enumerable, privacy-safe diagnostic. */
export function mcpErrorResult(error: unknown): CallToolResult {
  return attachAnonymousTelemetryError(
    {content: [{type: 'text' as const, text: errorMessage(error)}], isError: true},
    error,
  );
}

export function setMcpStartupVersion(version: string | undefined): void {
  mcpStartupVersion = version;
}
