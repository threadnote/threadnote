import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Predicate, Schema} from 'effect';
import {parseCodeGraphMonikerV1} from '../cross_repository/monikers.js';
import type {
  CodeGraphEdge,
  CodeGraphDerivationInputs,
  CodeGraphFileFacts,
  CodeGraphProvenance,
  CodeGraphReference,
  CodeGraphRelation,
  CodeGraphSpan,
  CodeGraphSymbol,
} from '../types.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const ARRAY_ENTRIES_MAXIMUM = 1_000_000;
const PATH_LENGTH_MAXIMUM = 4_096;
const SHORT_TEXT_LENGTH_MAXIMUM = 16_384;
const TEXT_LENGTH_MAXIMUM = 8 * 1_048_576;
const SHA256 = /^[0-9a-f]{64}$/u;
const PROVENANCE = [
  'declared',
  'heuristic',
  'model',
  'resolved',
  'syntactic',
] as const satisfies readonly CodeGraphProvenance[];
const RELATIONS = [
  'calls',
  'configures',
  'constructs',
  'contains',
  'declares',
  'depends_on',
  'documents',
  'exports',
  'extends',
  'implements',
  'imports',
  'overrides',
  'reads_or_writes',
  'references',
  'reexports',
  'semantic_association',
  'tests',
] as const satisfies readonly CodeGraphRelation[];

export class CodeGraphFactValidationError extends Schema.TaggedError<
  CodeGraphFactValidationError,
  {readonly brand: unique symbol}
>()('CodeGraphFactValidationError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

/** Exact recursive validator for parser facts crossing a durable or portable boundary. */
export function parseCodeGraphFileFacts(value: unknown): CodeGraphFileFacts {
  const input = object(value, 'Code graph file facts');
  exactKeys(input, ['diagnostics', 'edges', 'path', 'symbols'], ['derivationInputs', 'monikers', 'references']);
  const path = repositoryPath(input.path, 'File-fact path');
  const diagnostics = stringArray(input.diagnostics, 'File-fact diagnostics', TEXT_LENGTH_MAXIMUM);
  const symbols = EffectArray.map(array(input.symbols, 'File-fact symbols'), parseSymbol);
  const edges = EffectArray.map(array(input.edges, 'File-fact edges'), parseEdge);
  const references =
    input.references === undefined
      ? undefined
      : EffectArray.map(array(input.references, 'File-fact references'), parseReference);
  const monikers =
    input.monikers === undefined
      ? undefined
      : EffectArray.map(array(input.monikers, 'File-fact monikers'), (moniker, index) => {
          try {
            return parseCodeGraphMonikerV1(moniker);
          } catch (cause) {
            throw CodeGraphFactValidationError.make({cause, message: `File-fact moniker ${index} is invalid.`});
          }
        });
  const derivationInputs =
    input.derivationInputs === undefined ? undefined : parseDerivationInputs(input.derivationInputs);
  return {
    ...(derivationInputs === undefined ? {} : {derivationInputs}),
    diagnostics,
    edges,
    ...(monikers === undefined ? {} : {monikers}),
    path,
    ...(references === undefined ? {} : {references}),
    symbols,
  };
}

function parseSymbol(value: unknown, index: number): CodeGraphSymbol {
  const input = object(value, `File-fact symbol ${index}`);
  exactKeys(
    input,
    ['contentHash', 'exported', 'id', 'kind', 'language', 'name', 'path', 'qualifiedName', 'span'],
    ['arity', 'documentation', 'lookupKeys', 'packageName', 'resolutionDomain', 'resolutionScopeId', 'signature'],
  );
  return {
    ...(input.arity === undefined ? {} : {arity: nonnegativeInteger(input.arity, 'Symbol arity')}),
    contentHash: digest(input.contentHash, 'Symbol content hash'),
    ...(input.documentation === undefined ? {} : {documentation: text(input.documentation, 'Symbol documentation')}),
    exported: bool(input.exported, 'Symbol exported'),
    id: shortText(input.id, 'Symbol ID'),
    kind: shortText(input.kind, 'Symbol kind'),
    language: shortText(input.language, 'Symbol language'),
    ...(input.lookupKeys === undefined
      ? {}
      : {lookupKeys: nonEmptyStringArray(input.lookupKeys, 'Symbol lookup keys', false)}),
    name: boundedNonEmptyText(input.name, 'Symbol name'),
    ...(input.packageName === undefined
      ? {}
      : {packageName: boundedNonEmptyText(input.packageName, 'Symbol package name')}),
    path: repositoryPath(input.path, 'Symbol path'),
    qualifiedName: boundedNonEmptyText(input.qualifiedName, 'Symbol qualified name'),
    ...(input.resolutionDomain === undefined
      ? {}
      : {resolutionDomain: shortText(input.resolutionDomain, 'Symbol resolution domain')}),
    ...(input.resolutionScopeId === undefined
      ? {}
      : {resolutionScopeId: shortText(input.resolutionScopeId, 'Symbol resolution scope')}),
    ...(input.signature === undefined ? {} : {signature: text(input.signature, 'Symbol signature')}),
    span: parseSpan(input.span, 'Symbol span'),
  };
}

function parseEdge(value: unknown, index: number): CodeGraphEdge {
  const input = object(value, `File-fact edge ${index}`);
  exactKeys(
    input,
    ['confidence', 'evidencePath', 'evidenceSpan', 'id', 'provenance', 'relation', 'sourceName', 'targetName'],
    ['sourceId', 'targetId'],
  );
  return {
    confidence: finiteRange(input.confidence, 'Edge confidence', 0, 1),
    evidencePath: repositoryPath(input.evidencePath, 'Edge evidence path'),
    evidenceSpan: parseSpan(input.evidenceSpan, 'Edge evidence span'),
    id: shortText(input.id, 'Edge ID'),
    provenance: provenance(input.provenance, 'Edge provenance'),
    relation: relation(input.relation, 'Edge relation'),
    ...(input.sourceId === undefined ? {} : {sourceId: shortText(input.sourceId, 'Edge source ID')}),
    sourceName: boundedNonEmptyText(input.sourceName, 'Edge source name'),
    ...(input.targetId === undefined ? {} : {targetId: shortText(input.targetId, 'Edge target ID')}),
    targetName: boundedNonEmptyText(input.targetName, 'Edge target name'),
  };
}

function parseReference(value: unknown, index: number): CodeGraphReference {
  const input = object(value, `File-fact reference ${index}`);
  exactKeys(
    input,
    [
      'edgeId',
      'evidencePath',
      'evidenceSpan',
      'lookupTiers',
      'provenance',
      'relation',
      'resolutionDomain',
      'sourceName',
      'targetName',
    ],
    ['aliasLookupKeys', 'arity', 'exportedOnly', 'sourceId'],
  );
  return {
    ...(input.aliasLookupKeys === undefined
      ? {}
      : {aliasLookupKeys: nonEmptyStringArray(input.aliasLookupKeys, 'Reference alias lookup keys', false)}),
    ...(input.arity === undefined ? {} : {arity: nonnegativeInteger(input.arity, 'Reference arity')}),
    edgeId: shortText(input.edgeId, 'Reference edge ID'),
    evidencePath: repositoryPath(input.evidencePath, 'Reference evidence path'),
    evidenceSpan: parseSpan(input.evidenceSpan, 'Reference evidence span'),
    ...(input.exportedOnly === undefined
      ? {}
      : {exportedOnly: bool(input.exportedOnly, 'Reference exported-only state')}),
    lookupTiers: EffectArray.map(array(input.lookupTiers, 'Reference lookup tiers'), (tier, tierIndex) =>
      nonEmptyStringArray(tier, `Reference lookup tier ${tierIndex}`, false),
    ),
    provenance: provenance(input.provenance, 'Reference provenance'),
    relation: relation(input.relation, 'Reference relation'),
    resolutionDomain: shortText(input.resolutionDomain, 'Reference resolution domain'),
    ...(input.sourceId === undefined ? {} : {sourceId: shortText(input.sourceId, 'Reference source ID')}),
    sourceName: boundedNonEmptyText(input.sourceName, 'Reference source name'),
    targetName: boundedNonEmptyText(input.targetName, 'Reference target name'),
  };
}

function parseDerivationInputs(value: unknown): CodeGraphDerivationInputs {
  const input = object(value, 'File-fact derivation inputs');
  exactKeys(input, [], ['rationale']);
  if (input.rationale === undefined) return {};
  const rationale = EffectArray.map(array(input.rationale, 'File-fact rationale inputs'), (value, index) => {
    const rationale = object(value, `File-fact rationale ${index}`);
    exactKeys(rationale, ['documentation', 'line', 'marker', 'name'], []);
    return {
      documentation: text(rationale.documentation, 'Rationale documentation'),
      line: positiveInteger(rationale.line, 'Rationale line'),
      marker: shortText(rationale.marker, 'Rationale marker'),
      name: boundedNonEmptyText(rationale.name, 'Rationale name'),
    };
  });
  return {rationale};
}

function parseSpan(value: unknown, label: string): CodeGraphSpan {
  const input = object(value, label);
  exactKeys(input, ['column', 'endColumn', 'endLine', 'line'], []);
  const column = positiveInteger(input.column, `${label} column`);
  const endColumn = positiveInteger(input.endColumn, `${label} end column`);
  const endLine = positiveInteger(input.endLine, `${label} end line`);
  const line = positiveInteger(input.line, `${label} line`);
  if (endLine < line || (endLine === line && endColumn < column)) {
    throw CodeGraphFactValidationError.make({message: `${label} ends before it starts.`});
  }
  return {column, endColumn, endLine, line};
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) {
    throw CodeGraphFactValidationError.make({message: `${label} must be an object.`});
  }
  return value;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!EffectArray.isArray(value) || value.length > ARRAY_ENTRIES_MAXIMUM) {
    throw CodeGraphFactValidationError.make({message: `${label} must be a bounded array.`});
  }
  return value;
}

function exactKeys(input: Record<string, unknown>, required: readonly string[], optional: readonly string[]): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!EffectRecord.has(input, key))
      throw CodeGraphFactValidationError.make({message: `Code graph facts are missing ${key}.`});
  }
  for (const key of EffectRecord.keys(input)) {
    if (!allowed.has(key))
      throw CodeGraphFactValidationError.make({message: `Code graph facts contain unknown field ${key}.`});
  }
}

function text(value: unknown, label: string, maximum = TEXT_LENGTH_MAXIMUM): string {
  if (typeof value !== 'string' || value.length > maximum) {
    throw CodeGraphFactValidationError.make({message: `${label} must be a bounded string.`});
  }
  return value;
}

function shortText(value: unknown, label: string): string {
  const result = boundedNonEmptyText(value, label);
  if (containsControlCharacter(result)) {
    throw CodeGraphFactValidationError.make({message: `${label} must be non-empty and control-free.`});
  }
  return result;
}

/**
 * Repository-controlled semantic text may contain terminal controls. It is
 * persisted verbatim for graph fidelity and sanitized only at presentation
 * boundaries; structural IDs and paths remain control-free.
 */
function boundedNonEmptyText(value: unknown, label: string): string {
  const result = text(value, label, SHORT_TEXT_LENGTH_MAXIMUM);
  if (result.length === 0) throw CodeGraphFactValidationError.make({message: `${label} must be non-empty.`});
  return result;
}

function stringArray(value: unknown, label: string, maximum = SHORT_TEXT_LENGTH_MAXIMUM): readonly string[] {
  return EffectArray.map(array(value, label), entry => text(entry, `${label} entry`, maximum));
}

function nonEmptyStringArray(value: unknown, label: string, controlFree: boolean): readonly string[] {
  return EffectArray.map(array(value, label), entry =>
    controlFree ? shortText(entry, `${label} entry`) : boundedNonEmptyText(entry, `${label} entry`),
  );
}

function repositoryPath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > PATH_LENGTH_MAXIMUM ||
    Effect.pipe(value, EffectString.startsWith('/')) ||
    Effect.pipe(value, EffectString.startsWith('\\')) ||
    /^[A-Za-z]:/u.test(value) ||
    Effect.pipe(value, EffectString.includes('\\')) ||
    containsControlCharacter(value) ||
    EffectArray.some(
      Effect.pipe(value, EffectString.split('/')),
      segment => segment.length === 0 || segment === '.' || segment === '..',
    )
  ) {
    throw CodeGraphFactValidationError.make({message: `${label} must be a safe repository-relative POSIX path.`});
  }
  return value;
}

function containsControlCharacter(value: string): boolean {
  // C0/C1 controls are outside printable ASCII and the U+00A0-and-up range.
  return /[^\u0020-\u007e\u00a0-\u{10ffff}]/u.test(value);
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw CodeGraphFactValidationError.make({message: `${label} must be a lowercase SHA-256 digest.`});
  }
  return value;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw CodeGraphFactValidationError.make({message: `${label} must be boolean.`});
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw CodeGraphFactValidationError.make({message: `${label} must be a positive safe integer.`});
  }
  return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw CodeGraphFactValidationError.make({message: `${label} must be a non-negative safe integer.`});
  }
  return value;
}

function finiteRange(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw CodeGraphFactValidationError.make({
      message: `${label} must be a finite number between ${minimum} and ${maximum}.`,
    });
  }
  return value;
}

function provenance(value: unknown, label: string): CodeGraphProvenance {
  const matched =
    typeof value === 'string'
      ? EffectOption.getOrUndefined(EffectArray.findFirst(PROVENANCE, candidate => candidate === value))
      : undefined;
  if (matched === undefined) {
    throw CodeGraphFactValidationError.make({message: `${label} is invalid.`});
  }
  return matched;
}

function relation(value: unknown, label: string): CodeGraphRelation {
  const matched =
    typeof value === 'string'
      ? EffectOption.getOrUndefined(EffectArray.findFirst(RELATIONS, candidate => candidate === value))
      : undefined;
  if (matched === undefined) {
    throw CodeGraphFactValidationError.make({message: `${label} is invalid.`});
  }
  return matched;
}
