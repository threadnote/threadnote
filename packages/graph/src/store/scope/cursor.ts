import {CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY} from '../../index_scope.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const CODE_GRAPH_SCOPE_CURSOR_MAXIMUM_BYTES = 146;
export const CODE_GRAPH_SCOPE_CURSOR_PATTERN = /^[0-9a-f]{64}(?:\|code-graph-scope:[0-9a-f]{64})?$/u;

export function codeGraphScopeCursor(
  worktreeId: string,
  scopeId: string = CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY,
): string {
  return scopeId === CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY ? worktreeId : `${worktreeId}|${scopeId}`;
}

export function codeGraphScopeCursorParameters(cursor: string): readonly [string, string] {
  return [
    Effect.pipe(cursor, EffectString.slice(0, 64)),
    cursor.length === 64 ? CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY : Effect.pipe(cursor, EffectString.slice(65)),
  ];
}
