import {Schema} from 'effect';
import type {VectorSearchResult} from '@threadnote/inference/vector-search';

export class VectorIndexOperationError extends Schema.TaggedError<
  VectorIndexOperationError,
  {readonly brand: unique symbol}
>()('VectorIndexOperationError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

interface VectorRow {
  readonly chunk_id: string;
  readonly uri: string;
  readonly vector: unknown;
}
interface SemanticChunkMatch extends VectorSearchResult {
  readonly uri: string;
}

export function validateEncodedVector(value: unknown, dimensions: number): void {
  const bytes = bytesFromSqlBlob(value);
  if (bytes.byteLength !== dimensions * 4) {
    throw VectorIndexOperationError.make({
      message: `Stored vector has ${bytes.byteLength} bytes; expected ${dimensions * 4}.`,
    });
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let squaredMagnitude = 0;
  for (let index = 0; index < dimensions; index += 1) {
    const component = view.getFloat32(index * 4, true);
    if (!Number.isFinite(component)) {
      throw VectorIndexOperationError.make({message: 'Stored vector contains a non-finite component.'});
    }
    squaredMagnitude += component * component;
  }
  if (Math.abs(Math.sqrt(squaredMagnitude) - 1) > 0.002) {
    throw VectorIndexOperationError.make({message: 'Stored vector is not L2-normalized.'});
  }
}

export function encodedVectorValidationFailure(value: unknown, dimensions: number): unknown | undefined {
  try {
    validateEncodedVector(value, dimensions);
    return undefined;
  } catch (cause) {
    return cause;
  }
}

function bytesFromSqlBlob(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw VectorIndexOperationError.make({message: 'Stored vector is not a binary SQLite value.'});
}

export function mergeSemanticMatches(
  left: readonly SemanticChunkMatch[],
  right: readonly SemanticChunkMatch[],
  limit: number,
): readonly SemanticChunkMatch[] {
  return [...left, ...right].sort(compareVectorMatches).slice(0, limit);
}

export function searchEncodedVectorRows(
  normalizedQuery: readonly number[],
  rows: readonly VectorRow[],
  dimensions: number,
  limit: number,
): readonly SemanticChunkMatch[] {
  if (normalizedQuery.length !== dimensions) {
    throw VectorIndexOperationError.make({
      message: `Query vector has ${normalizedQuery.length} dimensions; expected ${dimensions}.`,
    });
  }
  const matches: SemanticChunkMatch[] = [];
  for (const row of rows) {
    const bytes = bytesFromSqlBlob(row.vector);
    if (bytes.byteLength !== dimensions * 4) {
      throw VectorIndexOperationError.make({
        message: `Stored vector ${row.chunk_id} has ${bytes.byteLength} bytes; expected ${dimensions * 4}.`,
      });
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let score = 0;
    let squaredMagnitude = 0;
    for (let index = 0; index < dimensions; index += 1) {
      const component = view.getFloat32(index * 4, true);
      if (!Number.isFinite(component)) {
        throw VectorIndexOperationError.make({
          message: `Stored vector ${row.chunk_id} contains a non-finite component.`,
        });
      }
      squaredMagnitude += component * component;
      score += normalizedQuery[index] * component;
    }
    if (Math.abs(Math.sqrt(squaredMagnitude) - 1) > 0.002) {
      throw VectorIndexOperationError.make({message: `Stored vector ${row.chunk_id} is not L2-normalized.`});
    }
    matches.push({
      id: row.chunk_id,
      score: Math.max(-1, Math.min(1, score)),
      uri: row.uri,
    });
  }
  return matches.sort(compareVectorMatches).slice(0, Math.min(limit, matches.length));
}

function compareVectorMatches(left: VectorSearchResult, right: VectorSearchResult): number {
  return right.score - left.score || compareCodeUnits(left.id, right.id);
}

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
