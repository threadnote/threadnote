import {Array as EffectArray, Schema} from 'effect';
import type {VectorRecord} from '@threadnote/inference/vector-search';

export class CodeGraphEmbeddingError extends Schema.TaggedError<
  CodeGraphEmbeddingError,
  {readonly brand: unique symbol}
>()('CodeGraphEmbeddingError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

export function decodeSearchVectorPage(
  rows: readonly {readonly symbol_id: string; readonly vector: unknown}[],
  dimensions: number,
): readonly VectorRecord<readonly number[] | Float32Array>[] {
  if (!LITTLE_ENDIAN) {
    return EffectArray.map(rows, row => ({id: row.symbol_id, vector: decodeVector(row.vector, dimensions)}));
  }
  const width = dimensions * Float32Array.BYTES_PER_ELEMENT;
  const packed = new Uint8Array(rows.length * width);
  const values = new Float32Array(packed.buffer);
  return EffectArray.map(rows, (row, index) => {
    const offset = index * width;
    packed.set(readVectorBytes(row.vector, width), offset);
    let sum = 0;
    const start = index * dimensions;
    const end = start + dimensions;
    for (let component = start; component < end; component++) {
      const value = values[component];
      if (!Number.isFinite(value)) {
        throw CodeGraphEmbeddingError.make({message: 'Stored vector contains a non-finite component.'});
      }
      sum += value * value;
    }
    assertNormalized(sum);
    return {id: row.symbol_id, vector: new Float32Array(packed.buffer, offset, dimensions)};
  });
}

function readVectorBytes(value: unknown, width: number): Uint8Array {
  const bytes = bytesFromSqlBlob(value);
  if (bytes.byteLength !== width) {
    throw CodeGraphEmbeddingError.make({message: `Stored vector has ${bytes.byteLength} bytes; expected ${width}.`});
  }
  return bytes;
}

function decodeVector(value: unknown, dimensions: number): readonly number[] {
  const bytes = readVectorBytes(value, dimensions * Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = Array.from({length: dimensions}, (_, index) => view.getFloat32(index * 4, true));
  if (EffectArray.some(vector, component => !Number.isFinite(component))) {
    throw CodeGraphEmbeddingError.make({message: 'Stored vector contains a non-finite component.'});
  }
  assertNormalized(EffectArray.reduce(vector, 0, (sum, component) => sum + component * component));
  return vector;
}

export function isDecodableVector(value: unknown, dimensions: number): boolean {
  try {
    decodeVector(value, dimensions);
    return true;
  } catch {
    return false;
  }
}

export function bytesFromSqlBlob(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw CodeGraphEmbeddingError.make({message: 'Stored vector is not a binary SQLite value.'});
}

function assertNormalized(squaredMagnitude: number): void {
  if (Math.abs(Math.sqrt(squaredMagnitude) - 1) > 0.002) {
    throw CodeGraphEmbeddingError.make({message: 'Stored vector is not L2-normalized.'});
  }
}
