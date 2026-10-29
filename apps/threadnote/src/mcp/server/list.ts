import {Array as EffectArray} from 'effect';
import {Effect, Result} from 'effect';
import {
  cursorCloudMemoryScopeReceipt,
  cursorCloudScopeTeams,
  cursorCloudShareForTeam,
  cursorCloudShareForUri,
  cursorCloudUriWithinScope,
} from '../../cursor/cloud.js';
import {EffectMcpServerRegistry, McpInput} from '../../effect/ai/mcp.js';
import {errorMessage} from '@threadnote/platform/errors';
import {argumentError, optionalResourceUri, type RuntimeConfig} from './common.js';
import {resolveMemoryScope, syncCursorCloudMemoryShares, type MemoryScopeSource} from './cursor_cloud_memory.js';
import {runNativeListTool} from './memory.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export function registerListTool(
  server: EffectMcpServerRegistry,
  config: RuntimeConfig,
  name: string,
  description: string,
  scopeSource?: MemoryScopeSource,
): void {
  const profileLabel = scopeSource?.label ?? 'Personal Cursor Cloud';
  server.registerTool(
    name,
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description,
      inputSchema: {
        uri: McpInput.string('Optional threadnote:// directory URI; defaults to threadnote://'),
        all: McpInput.boolean('Show hidden files like .abstract.md and .overview.md'),
        recursive: McpInput.boolean('List recursively'),
        simple: McpInput.boolean('Only return paths'),
        nodeLimit: McpInput.integer('Maximum node count', {minimum: 1, maximum: 1000}),
        node_limit: McpInput.integer('Maximum node count', {minimum: 1, maximum: 1000}),
        ...(scopeSource ? {team: McpInput.string(`Configured ${profileLabel} share`)} : {}),
      },
    },
    Effect.fn('mcp_server.callback')(function* ({all, nodeLimit, node_limit, recursive, simple, team, uri}) {
      const memoryScope = yield* resolveMemoryScope(scopeSource);
      const checkedUri = optionalResourceUri(uri, name);
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      const requestedTeam = typeof team === 'string' ? team : undefined;
      const selectedShareResult = yield* Effect.try({
        try: () =>
          memoryScope &&
          Effect2.pipe(requestedTeam, effectOptionalString =>
            effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
          )
            ? cursorCloudShareForTeam(memoryScope, requestedTeam)
            : undefined,
        catch: errorMessage,
      }).pipe(Effect.result);
      if (Result.isFailure(selectedShareResult)) return argumentError(selectedShareResult.failure);
      const selectedShare = selectedShareResult.success;
      if (
        memoryScope &&
        Effect2.pipe(requestedTeam, effectOptionalString =>
          effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
        ) &&
        !selectedShare
      ) {
        return argumentError(
          `${name} team must be one of: ${EffectArray.join(cursorCloudScopeTeams(memoryScope), ', ')}.`,
        );
      }
      const uriShare =
        memoryScope && checkedUri.value ? cursorCloudShareForUri(memoryScope, checkedUri.value) : undefined;
      if (memoryScope && checkedUri.value && !cursorCloudUriWithinScope(memoryScope, checkedUri.value)) {
        return argumentError(`${name} uri must stay within a configured ${profileLabel} share.`);
      }
      if (selectedShare && uriShare && selectedShare.team !== uriShare.team) {
        return argumentError(`${name} team must match the share containing uri.`);
      }
      if (memoryScope && !checkedUri.value && !selectedShare && memoryScope.shares.length > 1) {
        return argumentError(`${name} requires team or uri when several ${profileLabel} shares are configured.`);
      }
      const scopedUri = checkedUri.value ?? selectedShare?.root ?? memoryScope?.shares[0]?.root ?? 'threadnote://';
      if (memoryScope && !cursorCloudUriWithinScope(memoryScope, scopedUri)) {
        return argumentError(`${name} uri must stay within a configured ${profileLabel} share.`);
      }
      yield* syncCursorCloudMemoryShares(config, memoryScope, selectedShare?.team ?? uriShare?.team).pipe(
        Effect.catch(() => Effect.void),
      );
      const result = yield* runNativeListTool(config, {
        all,
        nodeLimit: nodeLimit ?? node_limit,
        recursive,
        simple,
        uri: scopedUri,
      });
      return memoryScope && result.structuredContent
        ? {
            ...result,
            structuredContent: {
              ...result.structuredContent,
              memoryScope: cursorCloudMemoryScopeReceipt(memoryScope),
            },
          }
        : result;
    }),
  );
}
