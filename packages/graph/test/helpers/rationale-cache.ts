import {Schema} from 'effect';
import type {CodeGraphFileFacts} from '@threadnote/graph/types';

const spanSchema = Schema.Struct({
  column: Schema.Finite,
  endColumn: Schema.Finite,
  endLine: Schema.Finite,
  line: Schema.Finite,
});

const symbolSchema = Schema.Struct({
  arity: Schema.optionalKey(Schema.Finite),
  contentHash: Schema.String,
  documentation: Schema.optionalKey(Schema.String),
  exported: Schema.Boolean,
  id: Schema.String,
  kind: Schema.String,
  language: Schema.String,
  lookupKeys: Schema.optionalKey(Schema.Array(Schema.String)),
  name: Schema.String,
  packageName: Schema.optionalKey(Schema.String),
  path: Schema.String,
  qualifiedName: Schema.String,
  resolutionDomain: Schema.optionalKey(Schema.String),
  resolutionScopeId: Schema.optionalKey(Schema.String),
  signature: Schema.optionalKey(Schema.String),
  span: spanSchema,
});

const rationaleInputSchema = Schema.Struct({
  documentation: Schema.String,
  line: Schema.Finite,
  marker: Schema.String,
  name: Schema.String,
});

const codeGraphRationaleCacheSnapshotSchema = Schema.Struct({
  derivationInputs: Schema.optionalKey(Schema.Struct({rationale: Schema.Array(rationaleInputSchema)})),
  diagnostics: Schema.Array(Schema.String),
  edges: Schema.Array(Schema.Never),
  path: Schema.String,
  symbols: Schema.Array(symbolSchema),
});

const isCodeGraphRationaleCacheSnapshot = Schema.is(codeGraphRationaleCacheSnapshotSchema);

export function parseCodeGraphRationaleCacheSnapshot(serialized: string): CodeGraphFileFacts {
  const parsed: unknown = JSON.parse(serialized);
  if (!isCodeGraphRationaleCacheSnapshot(parsed)) throw new Error('Rationale cache snapshot is invalid.');
  return parsed;
}
