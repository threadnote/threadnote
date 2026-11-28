/** Native pointer fields do not root their JavaScript backing buffers. Keep actual arguments strongly owned through completion. */
const argumentsInUse = new Set<readonly ArrayBufferView[]>();
export function retainNativeArguments(values: readonly ArrayBufferView[]): () => void {
  argumentsInUse.add(values);
  return () => {
    argumentsInUse.delete(values);
  };
}
export function withNativeArguments<A>(values: readonly ArrayBufferView[], use: () => A): A {
  const release = retainNativeArguments(values);
  try {
    return use();
  } finally {
    release();
  }
}
