import {Effect, Schema} from 'effect';
import {Observation, Position, type QueryOutcome} from '@threadnote/semantic/contracts';
import type {LspClient} from './lsp_transport.js';

export const SemanticLanguage = Schema.Literals([
  'typescript',
  'typescriptreact',
  'javascript',
  'javascriptreact',
  'python',
]);
export type SemanticLanguage = typeof SemanticLanguage.Type;
export const SemanticQuery = Schema.Literals([
  'definition',
  'references',
  'hover',
  'symbols',
  'completion',
  'signature',
  'implementation',
  'type-definition',
  'call-hierarchy',
  'type-hierarchy',
]);
export type SemanticQuery = typeof SemanticQuery.Type;
export const isCoreSemanticQuery = (
  operation: SemanticQuery,
): operation is 'definition' | 'references' | 'hover' | 'symbols' =>
  ['definition', 'references', 'hover', 'symbols'].includes(operation);
export interface SemanticSession {
  readonly upsert: (
    observation: Observation,
    text: string,
    language: SemanticLanguage,
    milliseconds: number,
  ) => Effect.Effect<Observation, unknown>;
  readonly query: (
    operation: SemanticQuery,
    observation: Observation,
    position: Position | undefined,
    milliseconds: number,
  ) => Effect.Effect<QueryOutcome, unknown>;
  readonly diagnostics: (observation: Observation, milliseconds: number) => Effect.Effect<DiagnosticDelta, unknown>;
  readonly prepare?: (
    operation: 'rename' | 'code-action',
    observation: Observation,
    position: Position,
    newName: string | undefined,
    milliseconds: number,
  ) => Effect.Effect<QueryOutcome, unknown>;
  readonly project: (
    uri: string,
  ) => Effect.Effect<
    {readonly configuration: string; readonly fileCount?: number; readonly profile?: Schema.Json} | undefined,
    unknown
  >;
  readonly available: Effect.Effect<boolean>;
  readonly invalidate: Effect.Effect<void>;
  readonly close: LspClient['close'];
}

export class SemanticSessionFault extends Schema.TaggedError<SemanticSessionFault>()('SemanticSessionFault', {
  reason: Schema.Literals(['invalid', 'conflict', 'stale', 'not-ready', 'provider']),
}) {}
export const SemanticRange = Schema.Struct({start: Position, end: Position});

export interface SemanticDiagnostic {
  readonly id: string;
  readonly range: typeof SemanticRange.Type;
  readonly message: string;
  readonly category: string;
  readonly code: string | number;
}
export interface DiagnosticSnapshot {
  readonly observation: Observation;
  readonly items: readonly SemanticDiagnostic[];
}
export interface DiagnosticDelta extends DiagnosticSnapshot {
  readonly added: readonly SemanticDiagnostic[];
  readonly remaining: readonly SemanticDiagnostic[];
  readonly resolved: readonly {
    readonly item: SemanticDiagnostic;
    readonly observation: Observation;
    readonly resolvedIn: Observation;
  }[];
}
/** UTF-16 LSP positions must be within a line and cannot split a surrogate pair. */
export function validTextPosition(text: string, position: Position): boolean {
  if (!Schema.is(Position)(position)) return false;
  const lines = text.split(/\r\n|\r|\n/u);
  const line = lines[position.line];
  if (line === undefined || position.character > line.length) return false;
  const before = line.charCodeAt(position.character - 1);
  const after = line.charCodeAt(position.character);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}
export function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
