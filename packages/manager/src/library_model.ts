import type {TreeNode} from './ui/contracts.js';

export type LibraryScope = 'local' | `team:${string}`;

/** Scope the canonical tree without changing node identities or descendants. */
export function libraryScopeTree(tree: TreeNode | undefined, scope: LibraryScope): TreeNode | undefined {
  if (!tree) return undefined;
  if (scope === 'local' && tree.uri.endsWith('/memories/shared')) return undefined;
  const matches = scope === 'local' ? !tree.isShared : tree.sharedTeam === scope.slice(5);
  if (!tree.isDir) return matches ? tree : undefined;
  const children = (tree.children ?? []).flatMap(child => {
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
  return [...new Set((node.children ?? []).flatMap(descendantMemoryUris))];
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
  const next = new Set([...selected].filter(uri => available.has(uri)));
  return next.size === selected.size ? selected : next;
}

/** Keep identity, citations, relations and legacy fields outside the authoring surface. */
export function memoryDocumentParts(content: string): {header: string; body: string; trailer: string} {
  const header = /^(?:MEMORY|HANDOFF)(?:\r\n|\r|\n)[\s\S]*?(?:\r\n\r\n|\n\n|\r\r)/u.exec(content)?.[0] ?? '';
  const rest = content.slice(header.length);
  const trailer = /\r?\n\r?\n<!-- MEMORY_FIELDS\r?\n[\s\S]*?\r?\n-->\s*$/u.exec(rest)?.[0] ?? '';
  return {header, body: trailer ? rest.slice(0, -trailer.length) : rest, trailer};
}

export function replaceMemoryBody(content: string, body: string): string {
  const parts = memoryDocumentParts(content);
  return parts.header + body + parts.trailer;
}

/** Present the authored title while leaving the canonical URI untouched. */
export function libraryItemTitle(node: TreeNode): string {
  const title = node.metadata?.topic ?? node.name.replace(/\.md$/iu, '');
  const readable = title.replace(/[-_]/gu, ' ');
  return readable.charAt(0).toUpperCase() + readable.slice(1);
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
