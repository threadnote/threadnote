import {Array as EffectArray} from 'effect';
import {compareCodeUnits} from '../ordering.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const CODE_GRAPH_INVENTORY_HASH_CHUNK_ROWS = 1_024;

/** @internal Streams canonical inventory rows without one repository-sized joined string. */
export function codeGraphInventorySha256Hex<A extends {readonly path: string}>(
  prefix: string,
  files: readonly A[],
  line: (file: A) => string,
): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(prefix);
  const canonical = codeGraphInventoryInStrictCanonicalOrder(files);
  if (canonical) {
    for (let offset = 0; offset < files.length; offset += CODE_GRAPH_INVENTORY_HASH_CHUNK_ROWS) {
      if (offset > 0) hasher.update('\n');
      hasher.update(
        EffectArray.join(
          EffectArray.map(files.slice(offset, offset + CODE_GRAPH_INVENTORY_HASH_CHUNK_ROWS), line),
          '\n',
        ),
      );
    }
  } else {
    const rows = EffectArray.map(files, line).sort(compareCodeUnits);
    for (let offset = 0; offset < rows.length; offset += CODE_GRAPH_INVENTORY_HASH_CHUNK_ROWS) {
      if (offset > 0) hasher.update('\n');
      hasher.update(EffectArray.join(rows.slice(offset, offset + CODE_GRAPH_INVENTORY_HASH_CHUNK_ROWS), '\n'));
    }
  }
  return hasher.digest('hex');
}

function codeGraphInventoryInStrictCanonicalOrder(files: readonly {readonly path: string}[]): boolean {
  if (
    Effect.pipe(files[0]?.path, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.includes('\0')),
    )
  )
    return false;
  for (let index = 1; index < files.length; index += 1) {
    if (
      Effect.pipe(files[index].path, EffectString.includes('\0')) ||
      compareCodeUnits(files[index - 1].path, files[index].path) >= 0
    ) {
      return false;
    }
  }
  return true;
}
