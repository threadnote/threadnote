import {dlopen, FFIType} from 'bun:ffi';
import {Array as EffectArray, String as EffectString} from 'effect';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export type Arm = 'stock' | 'typescript' | 'rust';
type PageValidation = (bytes: Uint8Array, dimensions: number) => number;
type PageRow = {readonly symbol_id: string; readonly vector: unknown};
type PageDecoder = (
  rows: readonly PageRow[],
  dimensions: number,
  bytesFromBlob: (value: unknown) => Uint8Array,
  invalid: (message: string) => Error,
) => readonly {readonly id: string; readonly vector: Float32Array}[];

const source = fileURLToPath(new URL('../../src/embedding.ts', import.meta.url));
const stockDecode = `        const records = EffectArray.map(rows, row => ({
          id: row.symbol_id,
          vector: decodeVector(row.vector, active.dimensions),
        }));`;
const injectedDecode = `        const decodePage = globalThis.threadnoteGraphVectorPrototypeDecode;
        let records;
        if (decodePage) {
          records = decodePage(rows, active.dimensions, bytesFromSqlBlob, message =>
            CodeGraphEmbeddingError.make({message}),
          );
        } else {
${EffectString.replace('const records', 'records')(stockDecode)}
        }`;

declare global {
  var threadnoteGraphVectorPrototypeDecode: PageDecoder | undefined;
}

export function registerOptimizedSearch() {
  let substitutions = 0;
  Bun.plugin({
    name: 'graph-vector-page-experiment',
    setup(build) {
      build.onLoad({filter: /[\\/]packages[\\/]graph[\\/]src[\\/]embedding\.ts$/}, async ({path}) => {
        if (resolve(path) !== source) return;
        const contents = await Bun.file(path).text();
        if (EffectString.split(contents, stockDecode).length !== 2)
          throw new Error('Expected one stock graph page decoder');
        substitutions++;
        return {contents: EffectString.replace(stockDecode, injectedDecode)(contents), loader: 'ts'};
      });
    },
  });
  return () => {
    if (substitutions !== 1) throw new Error('Expected one graph vector module substitution');
  };
}

export function openRustValidator(library: string) {
  const handle = dlopen(library, {
    threadnote_validate_graph_vector_page: {
      args: [FFIType.ptr, FFIType.u32, FFIType.u32],
      returns: FFIType.i32,
    },
  });
  return {
    // Only private, fixed-length views cross this synchronous boundary.
    validate: (bytes: Uint8Array, dimensions: number) => {
      if (bytes.byteLength > 0xffff_ffff) throw new Error('Graph vector page is too large');
      return handle.symbols.threadnote_validate_graph_vector_page(bytes, bytes.byteLength, dimensions);
    },
    close: () => handle.close(),
  };
}

export const validateTypeScriptPage: PageValidation = (bytes, dimensions) => {
  const values = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const rows = values.length / dimensions;
  let offset = 0;
  for (let row = 1; row <= rows; row++) {
    const end = offset + dimensions;
    let sum = 0;
    for (; offset < end; offset++) {
      const value = values[offset];
      if (!Number.isFinite(value)) return row;
      sum += value * value;
    }
    if (Math.abs(Math.sqrt(sum) - 1) > 0.002) return -row;
  }
  return 0;
};

export function pageDecoder(validate: PageValidation): PageDecoder {
  if (new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) {
    throw new Error('The experimental typed vector representation requires little-endian storage');
  }
  return (rows, dimensions, bytesFromBlob, invalid) => {
    const width = dimensions * 4;
    const packed = new Uint8Array(rows.length * width);
    let goodRows = 0;
    let shapeError: unknown;
    for (const row of rows) {
      try {
        const bytes = bytesFromBlob(row.vector);
        if (bytes.byteLength !== width) {
          throw invalid(`Stored vector has ${bytes.byteLength} bytes; expected ${width}.`);
        }
        packed.set(bytes, goodRows * width);
        goodRows++;
      } catch (error) {
        shapeError = error;
        break;
      }
    }

    if (goodRows > 0) {
      const prefix = goodRows === rows.length ? packed : packed.subarray(0, goodRows * width);
      const status = validate(prefix, dimensions);
      if (!Number.isInteger(status) || Math.abs(status) > goodRows) {
        throw new Error(`Graph vector page validator returned invalid status ${status}`);
      }
      if (status > 0) throw invalid('Stored vector contains a non-finite component.');
      if (status < 0) throw invalid('Stored vector is not L2-normalized.');
    }
    if (goodRows !== rows.length) throw shapeError;

    // The views own the JavaScript buffer reference. Rust never owns the bytes.
    return EffectArray.map(rows, (row, index) => ({
      id: row.symbol_id,
      vector: new Float32Array(packed.buffer, index * width, dimensions),
    }));
  };
}
