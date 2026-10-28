import {Effect} from 'effect';
import {
  assertCursorCloudMemoryTeamsReady,
  CURSOR_CLOUD_NO_SHARES_MESSAGE,
  CursorCloudOperationError,
  resolveCursorCloudMemoryScope,
  cursorCloudScopeTeams,
  type CursorCloudMemoryScope,
} from '../../cursor/cloud.js';
import {syncSharedReposBeforeAgentRead} from '../../effect/share.js';
import type {RuntimeConfig} from './common.js';

export type MemoryScopeSource =
  | CursorCloudMemoryScope
  | {
      readonly label?: string;
      readonly resolve: () => ReturnType<typeof resolveCursorCloudMemoryScope>;
    };

export const resolveMemoryScope = Effect.fn('mcp.resolveMemoryScope')(function* (
  source: MemoryScopeSource | undefined,
  allowEmpty = false,
) {
  const scope: CursorCloudMemoryScope | undefined = source && 'resolve' in source ? yield* source.resolve() : source;
  if (scope && scope.shares.length === 0 && !allowEmpty) {
    return yield* CursorCloudOperationError.make({message: CURSOR_CLOUD_NO_SHARES_MESSAGE});
  }
  return scope;
});

export function syncCursorCloudMemoryShares(
  config: RuntimeConfig,
  memoryScope: CursorCloudMemoryScope | undefined,
  teamSelector?: string | readonly string[],
) {
  if (!memoryScope) return syncSharedReposBeforeAgentRead(config);
  const teams =
    teamSelector === undefined
      ? cursorCloudScopeTeams(memoryScope)
      : typeof teamSelector === 'string'
        ? [teamSelector]
        : teamSelector;
  return assertCursorCloudMemoryTeamsReady(config, teams).pipe(
    Effect.andThen(syncSharedReposBeforeAgentRead(config, teams)),
  );
}
