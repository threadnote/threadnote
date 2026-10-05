import {Effect, Schema} from 'effect';
import {McpSchema} from 'effect/ai';
import {
  isMemoryRelocationUri,
  MemoryRelocationError,
  MemoryPointerNotFound,
  readMemoryWithRelocations,
} from '@threadnote/memory/relocation';
import {
  MemoryIdentityResolutionError,
  resolveMemoryIdentityAliases,
  verifyResolvedMemoryIdentity,
} from '@threadnote/recall/memory/identity';
import {uriSegment} from '@threadnote/workspace/manifest';
import {memoryReadRecoveryForError, memoryReadRecoveryText} from '@threadnote/memory/read/recovery';
import {MEMORY_READ_MAXIMUM_CONTENT_BYTES} from '@threadnote/memory/read/projection';
import {canonicalResourceUri, parseResourceId, resourceIdIsWithin} from '@threadnote/store/resource-id';
import {ResourceNotFound, ResourceStore} from '@threadnote/store/resource-store';
import {
  mcpResourceNotFoundRecoveryErrorData,
  MCP_RESOURCE_ERROR_DATA,
  MCP_RESOURCE_NOT_FOUND_ERROR_DATA,
} from './mcp.js';

export const MCP_RESOURCE_READ_MAX_BYTES = MEMORY_READ_MAXIMUM_CONTENT_BYTES;
export const MCP_RESOURCE_MIME_TYPE = 'text/plain; charset=utf-8';
// The MCP resources contract uses this server-error code for a resource that
// does not exist across every protocol revision Threadnote advertises.
export const MCP_RESOURCE_NOT_FOUND_CODE = -32_002;

interface McpResourceConfig {
  readonly account: string;
  readonly agentContextHome: string;
  readonly manifestPath?: string;
  readonly user: string;
}

export function readThreadnoteMcpResource(config: McpResourceConfig, uri: string, scopeRoots?: readonly string[]) {
  return Effect.gen(function* () {
    const requestedUri = yield* canonicalThreadnoteUri(uri);
    const [identity] = yield* resolveMemoryIdentityAliases(
      config,
      [requestedUri],
      scopeRoots ?? [canonicalResourceUri('user', [uriSegment(config.user), 'memories'])],
    );
    const canonicalUri = identity.canonicalUri;
    if (scopeRoots && !scopeRoots.some(scopeRoot => resourceIdIsWithin(canonicalUri, scopeRoot))) {
      return yield* McpSchema.InvalidParams.make({
        data: MCP_RESOURCE_ERROR_DATA,
        message: 'The requested resource is outside the active Cursor Cloud memory scope.',
      });
    }
    const store = yield* ResourceStore;
    const location = {account: config.account, home: config.agentContextHome, user: config.user};
    const exact = yield* store.readBounded(location, canonicalUri, MCP_RESOURCE_READ_MAX_BYTES).pipe(
      Effect.map(read => ({canonicalUri, read})),
      Effect.catchTag('ResourceNotFound', () => Effect.void),
    );
    const resolved =
      exact ??
      (isMemoryRelocationUri(config, canonicalUri)
        ? yield* readMemoryWithRelocations(config, canonicalUri).pipe(
            Effect.map(memory => ({
              canonicalUri: memory.canonicalUri,
              read: {content: memory.content, truncated: false},
            })),
          )
        : yield* ResourceNotFound.make({
            message: `Resource does not exist: ${canonicalUri}`,
            uri: canonicalUri,
          }));
    if (scopeRoots && !scopeRoots.some(scopeRoot => resourceIdIsWithin(resolved.canonicalUri, scopeRoot))) {
      return yield* McpSchema.InvalidParams.make({
        data: MCP_RESOURCE_ERROR_DATA,
        message: 'The relocated resource is outside the active Cursor Cloud memory scope.',
      });
    }
    const read = resolved.read;
    if (read.truncated) {
      return yield* resourceTooLarge();
    }
    if (Buffer.byteLength(read.content, 'utf8') > MCP_RESOURCE_READ_MAX_BYTES) {
      return yield* resourceTooLarge();
    }
    yield* verifyResolvedMemoryIdentity(identity, resolved.canonicalUri, read.content);
    return {
      contents: [
        {
          mimeType: MCP_RESOURCE_MIME_TYPE,
          text: read.content,
          uri: identity.expectedMemoryId === undefined ? resolved.canonicalUri : identity.requestedUri,
        },
      ],
    } satisfies McpSchema.ReadResourceResult;
  }).pipe(Effect.mapError(error => mcpResourceReadError(config, error)));
}

function canonicalThreadnoteUri(uri: string): Effect.Effect<string, McpSchema.InvalidParams> {
  return Effect.try({
    try: () => {
      const parsed = parseResourceId(uri);
      if (parsed.inputScheme !== 'threadnote' || parsed.canonicalUri !== uri) {
        throw new Error('non-canonical Threadnote resource URI');
      }
      return parsed.canonicalUri;
    },
    catch: () =>
      McpSchema.InvalidParams.make({
        data: MCP_RESOURCE_ERROR_DATA,
        message: 'Expected a canonical threadnote:// URI.',
      }),
  });
}

function resourceTooLarge(): McpSchema.InvalidParams {
  return McpSchema.InvalidParams.make({
    data: MCP_RESOURCE_ERROR_DATA,
    message: `Threadnote resource exceeds the ${MCP_RESOURCE_READ_MAX_BYTES}-byte resources/read limit; use read_context with mode=outline or section, or pass one URI with offsetBytes=0 for explicit pages.`,
  });
}

function mcpResourceReadError(
  config: McpResourceConfig,
  error: unknown,
): McpSchema.InternalError | McpSchema.InvalidParams {
  if (Schema.is(McpSchema.InvalidParams)(error) || Schema.is(McpSchema.InternalError)(error)) {
    return error;
  }
  if (error instanceof MemoryRelocationError) {
    return McpSchema.InternalError.make({
      data: MCP_RESOURCE_ERROR_DATA,
      message: 'Threadnote memory relocation could not be verified safely.',
    });
  }
  if (error instanceof MemoryPointerNotFound) {
    const recovery = memoryReadRecoveryForError(config, error);
    return McpSchema.InvalidParams.make({
      data: recovery === undefined ? MCP_RESOURCE_NOT_FOUND_ERROR_DATA : mcpResourceNotFoundRecoveryErrorData(recovery),
      message:
        recovery === undefined
          ? 'Threadnote resource was not found.'
          : `Threadnote resource was not found. Recovery: ${memoryReadRecoveryText(recovery)}`,
    });
  }
  if (Schema.is(MemoryIdentityResolutionError)(error)) {
    return McpSchema.InvalidParams.make({
      data: error.reason === 'not-found' ? MCP_RESOURCE_NOT_FOUND_ERROR_DATA : MCP_RESOURCE_ERROR_DATA,
      message: error.message,
    });
  }
  if (Schema.is(ResourceNotFound)(error)) {
    return McpSchema.InvalidParams.make({
      data: MCP_RESOURCE_NOT_FOUND_ERROR_DATA,
      message: 'Threadnote resource was not found.',
    });
  }
  if (typeof error !== 'object' || error === null || !('_tag' in error)) {
    return McpSchema.InternalError.make({
      data: MCP_RESOURCE_ERROR_DATA,
      message: 'Threadnote resource could not be read safely.',
    });
  }
  switch (error._tag) {
    case 'InvalidResourceId':
      return McpSchema.InvalidParams.make({
        data: MCP_RESOURCE_ERROR_DATA,
        message: 'Expected a canonical threadnote:// URI.',
      });
    case 'ResourceAccessDenied':
      return McpSchema.InvalidParams.make({
        data: MCP_RESOURCE_ERROR_DATA,
        message: 'Threadnote resource is not readable in the active account.',
      });
    case 'ResourceNotFound':
      return McpSchema.InvalidParams.make({
        data: MCP_RESOURCE_NOT_FOUND_ERROR_DATA,
        message: 'Threadnote resource was not found.',
      });
    default:
      return McpSchema.InternalError.make({
        data: MCP_RESOURCE_ERROR_DATA,
        message: 'Threadnote resource could not be read safely.',
      });
  }
}
