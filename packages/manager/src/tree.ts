import {Effect, Predicate} from 'effect';

function isExternalTreePath(relativePath: string): boolean {
  return relativePath === 'external' || relativePath.startsWith('external/');
}

function externalResourceTreeEntryVisible(
  relativePath: string,
  entry: {readonly name: string; readonly isDirectory: () => boolean},
): boolean {
  return (
    !isExternalTreePath(relativePath) ||
    (!entry.name.startsWith('.') && (entry.isDirectory() || entry.name.endsWith('.md')))
  );
}

function externalResourceTreeNodeVisible(node: {
  readonly relativePath: string;
  readonly isDir: boolean;
  readonly children?: readonly unknown[];
}): boolean {
  return !isExternalTreePath(node.relativePath) || !node.isDir || (node.children?.length ?? 0) > 0;
}

export const externalResourceTree = {
  entryVisible: externalResourceTreeEntryVisible,
  nodeVisible: externalResourceTreeNodeVisible,
};

export function emptyManagerTree(name: string, uri: string) {
  return {
    children: [],
    isDir: true as const,
    isShared: false,
    isSystem: false,
    name,
    relativePath: '',
    uri,
  };
}

export function isMissingManagerTreePath(cause: unknown): boolean {
  return (
    Predicate.isObject(cause) &&
    (('code' in cause && cause.code === 'ENOENT') ||
      ('reason' in cause &&
        typeof cause.reason === 'object' &&
        cause.reason !== null &&
        '_tag' in cause.reason &&
        cause.reason._tag === 'NotFound'))
  );
}

export function readManagerTreeRoot<A, B, E1, E2, R1, R2>(
  rootLookup: Effect.Effect<A, E1, R1>,
  readTree: Effect.Effect<B, E2, R2>,
  emptyTree: B,
): Effect.Effect<B, E1 | E2, R1 | R2> {
  return rootLookup.pipe(
    Effect.matchEffect({
      onFailure: cause => (isMissingManagerTreePath(cause) ? Effect.succeed(emptyTree) : Effect.fail(cause)),
      onSuccess: () => readTree,
    }),
  );
}
