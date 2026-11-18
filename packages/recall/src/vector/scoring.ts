import {Schema} from 'effect';

export class VectorIndexOperationError extends Schema.TaggedError<
  VectorIndexOperationError,
  {readonly brand: unique symbol}
>()('VectorIndexOperationError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

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

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
