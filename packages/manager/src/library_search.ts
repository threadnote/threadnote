import {useEffect, useState} from 'react';
import {api, errorMessage} from './ui/support.js';
import type {LibraryScope} from './library_model.js';
import type {LibrarySearchResponse, TreeNode} from './ui/contracts.js';

interface SearchState {
  readonly key: string;
  readonly tree?: TreeNode;
  readonly result?: LibrarySearchResponse;
  readonly error?: string;
}

export function useLibrarySearch(query: string, scope: LibraryScope, enabled: boolean, tree?: TreeNode) {
  const text = query.trim();
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
