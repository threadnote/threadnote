import {isLibrarySearchResponse} from './api/response_guards.js';
import {useEffect, useState} from 'react';
import {api, errorMessage} from './ui/support.js';
import type {LibraryScope} from './library_model.js';
import type {LibrarySearchResponse, TreeNode} from './ui/contracts.js';
import {isMemoryLink} from './library_navigation.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

interface SearchState {
  readonly key: string;
  readonly tree?: TreeNode;
  readonly result?: LibrarySearchResponse;
  readonly error?: string;
}

export function librarySearchInputValue(value: string): string {
  return isMemoryLink(Effect.pipe(value, EffectString.trim)) ? value : Effect.pipe(value, EffectString.slice(0, 1024));
}

export function useLibrarySearch(query: string, scope: LibraryScope, enabled: boolean, tree?: TreeNode) {
  const input = Effect.pipe(query, EffectString.trim);
  const text = isMemoryLink(input) ? '' : input;
  const key = JSON.stringify([text, scope]);
  const [state, setState] = useState<SearchState>();
  useEffect(() => {
    if (!enabled || !text) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api<LibrarySearchResponse>(
        `/api/library/search?query=${encodeURIComponent(text)}&scope=${encodeURIComponent(scope)}`,
        undefined,
        {signal: controller.signal, timeoutMilliseconds: 45_000},
        isLibrarySearchResponse,
      ).then(
        result => {
          if (!controller.signal.aborted) setState({key, tree, result});
        },
        cause => {
          if (!controller.signal.aborted) setState({key, tree, error: errorMessage(cause)});
        },
      );
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, key, scope, text, tree]);
  const current = enabled && text && state?.key === key && state.tree === tree ? state : undefined;
  return {
    result: current?.result,
    error: current?.error,
    pending: Boolean(enabled && text && !current),
  };
}
