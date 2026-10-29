import {Array as EffectArray} from 'effect';
import type {TreeNode} from './ui/contracts.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export type LibraryScope = 'local' | `team:${string}`;

/** Scope the canonical tree without changing node identities or descendants. */
export function libraryScopeTree(tree: TreeNode | undefined, scope: LibraryScope): TreeNode | undefined {
  if (!tree) return undefined;
  if (scope === 'local' && Effect.pipe(tree.uri, EffectString.endsWith('/memories/shared'))) return undefined;
  const matches = scope === 'local' ? !tree.isShared : tree.sharedTeam === Effect.pipe(scope, EffectString.slice(5));
  if (!tree.isDir) return matches ? tree : undefined;
  const children = EffectArray.flatMap(tree.children ?? [], child => {
    const scoped = libraryScopeTree(child, scope);
    return scoped ? [scoped] : [];
  });
  if (children.length === 0 && (!matches || !tree.isSystem)) return undefined;
  return {...tree, children};
}

/** Folder operations use the full subtree, independently of search and expansion. */
export function descendantMemoryUris(node: TreeNode): readonly string[] {
  if (node.isSystem) return [];
  if (!node.isDir) return [node.uri];
  const children = node.children ?? [];
  return [
    ...new Set(EffectArray.flatMap(children, (child, index) => (index in children ? descendantMemoryUris(child) : []))),
  ];
}

export function toggleMemorySelection(
  selected: ReadonlySet<string>,
  node: TreeNode,
  checked: boolean,
): ReadonlySet<string> {
  const next = new Set(selected);
  for (const uri of descendantMemoryUris(node)) {
    if (checked) next.add(uri);
    else next.delete(uri);
  }
  return next;
}

export function reconcileMemorySelection(
  selected: ReadonlySet<string>,
  tree: TreeNode | undefined,
): ReadonlySet<string> {
  if (!tree) return new Set();
  const available = new Set(descendantMemoryUris(tree));
  const next = new Set(EffectArray.filter([...selected], uri => available.has(uri)));
  return next.size === selected.size ? selected : next;
}

/** Keep identity, citations, relations and legacy fields outside the authoring surface. */
export function memoryDocumentParts(content: string): {header: string; body: string; trailer: string} {
  const header = /^(?:MEMORY|HANDOFF)(?:\r\n|\r|\n)[\s\S]*?(?:\r\n\r\n|\n\n|\r\r)/u.exec(content)?.[0] ?? '';
  const rest = Effect.pipe(content, EffectString.slice(header.length));
  const trailer = /\r?\n\r?\n<!-- MEMORY_FIELDS\r?\n[\s\S]*?\r?\n-->\s*$/u.exec(rest)?.[0] ?? '';
  return {header, body: trailer ? Effect.pipe(rest, EffectString.slice(0, -trailer.length)) : rest, trailer};
}

export function replaceMemoryBody(content: string, body: string): string {
  const parts = memoryDocumentParts(content);
  return parts.header + body + parts.trailer;
}

/** Present the authored title while leaving the canonical URI untouched. */
export function libraryItemTitle(node: TreeNode): string {
  const title = node.metadata?.topic ?? Effect.pipe(node.name, EffectString.replace(/\.md$/iu, ''));
  const readable = Effect.pipe(title, EffectString.replace(/[-_]/gu, ' '));
  return (
    Effect.pipe(readable, __effectPipeInput => {
      const __effectPipeStage0 = Effect.pipe(
        __effectPipeInput,
        EffectString.charAt(0),
        Effect.Option.getOrElse(() => ''),
      );
      const __effectPipeStage1 = Effect.pipe(__effectPipeStage0, EffectString.toUpperCase);
      return __effectPipeStage1;
    }) + Effect.pipe(readable, EffectString.slice(1))
  );
}

/** Hide single-child storage wrappers; actions still receive their real subtree. */
export function libraryExplorerNodes(tree: TreeNode | undefined): readonly TreeNode[] {
  if (!tree) return [];
  let root = tree;
  while (root.isDir) {
    const children = root.children ?? [];
    if (children.length !== 1 || !children[0].isDir) break;
    root = children[0];
  }
  return root === tree && root.isDir && root.relativePath === '' ? (root.children ?? []) : [root];
}

/** Prune search results without changing canonical nodes or folder selection. */
export function librarySearchTree(
  tree: TreeNode | undefined,
  query: string,
  recalledUris: ReadonlySet<string>,
  showSystem: boolean,
): TreeNode | undefined {
  if (!tree || (!showSystem && tree.isSystem)) return undefined;
  const needle = Effect.pipe(query, EffectString.trim, EffectString.toLocaleLowerCase());
  if (!needle) return tree;
  if (!tree.isDir) {
    return recalledUris.has(tree.uri) ||
      EffectArray.some(
        [tree.name, tree.uri, tree.metadata?.topic ?? ''],
        __effectArrayValue =>
          !!(value => Effect.pipe(value, EffectString.toLocaleLowerCase(), EffectString.includes(needle)))(
            __effectArrayValue,
          ),
      )
      ? tree
      : undefined;
  }
  const children = EffectArray.flatMap(tree.children ?? [], child => {
    const match = librarySearchTree(child, query, recalledUris, showSystem);
    return match ? [match] : [];
  });
  return children.length ? {...tree, children} : undefined;
}
