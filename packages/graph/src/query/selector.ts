import {Array as EffectArray} from 'effect';
import {Effect} from 'effect';
import {type CodeGraphStoreShape} from '../store.js';
import {type CodeGraphQueryNode} from '../types.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export interface CodeGraphEndpointSelector {
  readonly original: string;
  readonly path?: string;
  readonly symbol: string;
}

export function codeGraphEndpointMatches(
  store: Pick<CodeGraphStoreShape, 'findSymbolsByPathAndName' | 'searchSymbols' | 'symbolsByIds'>,
  databasePath: string,
  snapshotId: string,
  selector: CodeGraphEndpointSelector,
): Effect.Effect<readonly CodeGraphQueryNode[], unknown> {
  if (!selector.path && isStableCodeGraphNodeId(selector.symbol)) {
    return store
      .symbolsByIds(databasePath, snapshotId, [selector.symbol])
      .pipe(Effect.map(symbols => EffectArray.map(symbols, symbol => ({...symbol, score: 1}))));
  }
  return selector.path
    ? store.findSymbolsByPathAndName(databasePath, snapshotId, selector.path, selector.symbol)
    : store.searchSymbols(databasePath, snapshotId, selector.symbol, 20);
}

export function isStableCodeGraphNodeId(value: string): boolean {
  return /^cgs_[a-f0-9]{32,64}$/u.test(value);
}

export function parseCodeGraphEndpointSelector(value: string): CodeGraphEndpointSelector {
  const separator = Effect2.pipe(
    value,
    EffectString.lastIndexOf('#'),
    Effect2.Option.getOrElse(() => -1),
  );
  if (separator <= 0 || separator >= value.length - 1) {
    return {original: value, symbol: value};
  }
  return {
    original: value,
    path: Effect2.pipe(
      value,
      EffectString.slice(0, separator),
      EffectString.replaceAll('\\', '/'),
      EffectString.replace(/^\.\/+/, ''),
    ),
    symbol: Effect2.pipe(value, EffectString.slice(separator + 1)),
  };
}

export function exactCodeGraphImpactSelectorMatches(
  selector: CodeGraphEndpointSelector,
  matches: readonly CodeGraphQueryNode[],
): readonly CodeGraphQueryNode[] {
  if (!selector.path && isStableCodeGraphNodeId(selector.symbol)) return matches;
  const normalizedSymbol = Effect2.pipe(selector.symbol, EffectString.toLocaleLowerCase('en-US'));
  const normalizedPath = Effect2.pipe(
    selector.path ?? selector.symbol,
    EffectString.replaceAll('\\', '/'),
    EffectString.replace(/^\.\/+/, ''),
    EffectString.toLocaleLowerCase('en-US'),
  );
  return EffectArray.filter(matches, node => {
    const nodePath = Effect2.pipe(
      node.path,
      EffectString.replaceAll('\\', '/'),
      EffectString.toLocaleLowerCase('en-US'),
    );
    if (selector.path && nodePath !== normalizedPath) return false;
    return (
      Effect2.pipe(node.name, EffectString.toLocaleLowerCase('en-US')) === normalizedSymbol ||
      Effect2.pipe(node.qualifiedName, EffectString.toLocaleLowerCase('en-US')) === normalizedSymbol ||
      (!selector.path && nodePath === normalizedPath)
    );
  });
}

export function selectCodeGraphEndpoint(
  matches: readonly CodeGraphQueryNode[],
  selector: CodeGraphEndpointSelector,
): {readonly node?: CodeGraphQueryNode; readonly warnings: readonly string[]} {
  const normalizedSymbol = Effect2.pipe(selector.symbol, EffectString.toLocaleLowerCase('en-US'));
  const candidates = EffectArray.filter(matches, node => {
    if (selector.path && Effect2.pipe(node.path, EffectString.replaceAll('\\', '/')) !== selector.path) return false;
    return (
      Effect2.pipe(node.name, EffectString.toLocaleLowerCase('en-US')) === normalizedSymbol ||
      Effect2.pipe(node.qualifiedName, EffectString.toLocaleLowerCase('en-US')) === normalizedSymbol
    );
  });
  if (candidates.length === 1) return {node: candidates[0], warnings: []};
  if (candidates.length === 0 && matches.length === 1 && !selector.path) {
    return {node: matches[0], warnings: []};
  }
  const visible = EffectArray.join(
    EffectArray.map(
      (candidates.length > 0 ? candidates : matches).slice(0, 5),
      node => `${node.path}#${node.qualifiedName}`,
    ),
    ', ',
  );
  return {
    warnings: [
      visible.length > 0
        ? `Path endpoint "${selector.original}" is ambiguous; use path#symbol. Candidates: ${visible}.`
        : `Path endpoint "${selector.original}" was not found.`,
    ],
  };
}
