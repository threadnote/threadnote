import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray} from 'effect';
import {Option} from 'effect';
import {compareCodeUnits} from '../ordering.js';
import type {
  CodeGraphEdge,
  CodeGraphFileFacts,
  CodeGraphReference,
  CodeGraphRelation,
  CodeGraphSymbol,
} from '../types.js';
import type {CodeGraphMonikerV1} from '../cross_repository/types.js';
import {canonicalCodeGraphMonikers} from '../cross_repository/monikers.js';
import {parseCodeGraphFileFacts} from './validation.js';
import * as EffectRecord from 'effect/Record';

export const CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM = 8 * 1_048_576;
export const CODE_GRAPH_REFERENCE_CANDIDATES_PER_REFERENCE_MAXIMUM = 100_000;
export const CODE_GRAPH_PARSER_FACTS_VERSION = 'parser-facts-v7-worker-resource-budgets' as const;

const CACHED_FACT_BUDGET_DIAGNOSTIC =
  'Cached code graph facts exceeded the per-file persistence budget; lower-priority relationships and documentation were omitted.';
export const CODE_GRAPH_REFERENCE_CANDIDATE_BUDGET_DIAGNOSTIC =
  'A code graph relationship exceeded the per-reference resolution budget; the relationship was preserved as unresolved.';
const boundedCodeGraphFactBrand: unique symbol = Symbol('threadnote/BoundedCodeGraphFact');
const cachedFactEncoder = new TextEncoder();

export interface MeasuredCodeGraphFact {
  readonly bytes: number;
  readonly facts: CodeGraphFileFacts;
}

export interface BoundedCodeGraphFact extends MeasuredCodeGraphFact {
  readonly [boundedCodeGraphFactBrand]: true;
  readonly json: string;
}

export type CodeGraphCacheFactInput = CodeGraphFileFacts | BoundedCodeGraphFact;

/** Exact UTF-8 bytes used by SQLite for the serialized fact JSON. */
export function cachedCodeGraphFactBytes(facts: CodeGraphFileFacts): number {
  return cachedFactEncoder.encode(JSON.stringify(facts)).byteLength;
}

/**
 * Allocation-light upper bound for JSON's UTF-8 representation. A UTF-16 code
 * unit needs at most six ASCII bytes when JSON escaped. Ordinary facts can
 * therefore skip an otherwise redundant preflight serialization.
 */
export function cachedCodeGraphFactByteUpperBound(facts: CodeGraphFileFacts): number {
  return cachedJsonByteUpperBound(facts);
}

/**
 * Produces the exact serialized payload accepted by the cache boundary. The
 * returned brand is module-owned, so trusted callers can pass it through the
 * store without a second stringify while raw alternate callers are bounded by
 * the store itself.
 */
export function serializeBoundedCodeGraphFact(
  facts: unknown,
  maximumBytes = CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM,
): BoundedCodeGraphFact {
  const measured = measureBoundedCodeGraphFactWithJson(parseCodeGraphFileFacts(facts), maximumBytes);
  return {
    [boundedCodeGraphFactBrand]: true,
    ...measured,
  };
}

/** Measures final attributed facts exactly but does not retain their transient JSON string. */
export function measureBoundedCodeGraphFact(
  facts: CodeGraphFileFacts,
  maximumBytes = CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM,
): MeasuredCodeGraphFact {
  const {json: _json, ...measured} = measureBoundedCodeGraphFactWithJson(facts, maximumBytes);
  return measured;
}

export function ensureBoundedCodeGraphFact(input: CodeGraphCacheFactInput): BoundedCodeGraphFact {
  if (isBoundedCodeGraphFact(input) && input.bytes <= CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM) return input;
  return serializeBoundedCodeGraphFact(isBoundedCodeGraphFact(input) ? input.facts : input);
}

export function isBoundedCodeGraphFact(input: CodeGraphCacheFactInput): input is BoundedCodeGraphFact {
  return boundedCodeGraphFactBrand in input && input[boundedCodeGraphFactBrand] === true;
}

/** Stable, non-empty batches whose exact serialized fact totals are <= the supplied ceiling. */
export function boundedCodeGraphFactBatches(
  values: readonly MeasuredCodeGraphFact[],
  maximumBytes = CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM,
): readonly (readonly MeasuredCodeGraphFact[])[] {
  const output: MeasuredCodeGraphFact[][] = [];
  let batch: MeasuredCodeGraphFact[] = [];
  let bytes = 0;
  for (const candidate of values) {
    const value =
      candidate.bytes <= maximumBytes ? candidate : measureBoundedCodeGraphFact(candidate.facts, maximumBytes);
    if (batch.length > 0 && bytes + value.bytes > maximumBytes) {
      output.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(value);
    bytes += value.bytes;
  }
  if (batch.length > 0) output.push(batch);
  return output;
}

/** Budgets, exactly measures, and packs final per-file facts for staging transactions. */
export function finalCodeGraphFactBatches(
  facts: readonly CodeGraphFileFacts[],
  maximumBytes = CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM,
): readonly (readonly MeasuredCodeGraphFact[])[] {
  const canonical = canonicalMaterializationFacts(facts);
  const measured = EffectArray.map(canonical, fact => measureBoundedCodeGraphFact(fact, maximumBytes));
  const closed = closeMaterializationFacts(
    canonical,
    EffectArray.map(measured, value => value.facts),
  );
  return boundedCodeGraphFactBatches(
    EffectArray.map(closed, (fact, index) =>
      fact === measured[index].facts ? measured[index] : measureBoundedCodeGraphFact(fact, maximumBytes),
    ),
    maximumBytes,
  );
}

/**
 * Bounds one fact object without rejecting its repository. Selection is stable
 * and preserves module/package surfaces, import/export relationships, and
 * declaration topology before remaining declarations, calls, and docs.
 * Relationships carry every original file-local endpoint and references only
 * survive with their edge. A custom test ceiling must still contain the
 * intrinsic path plus empty-array JSON envelope.
 */
export function budgetCachedCodeGraphFacts(
  facts: CodeGraphFileFacts,
  maximumBytes = CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM,
): CodeGraphFileFacts {
  const compacted = budgetCodeGraphReferenceCandidates(compactCachedFileRelationships(facts));
  if (cachedCodeGraphFactByteUpperBound(compacted) <= maximumBytes) return compacted;
  if (cachedCodeGraphFactBytes(compacted) <= maximumBytes) return compacted;

  return selectCachedCodeGraphFactsWithinBudget(compacted, maximumBytes);
}

function selectCachedCodeGraphFactsWithinBudget(
  compacted: CodeGraphFileFacts,
  maximumBytes: number,
): CodeGraphFileFacts {
  const symbolsById = new Map<string, CodeGraphSymbol>();
  for (const symbol of compacted.symbols) {
    if (symbolsById.has(symbol.id)) continue;
    const {documentation: _documentation, ...persistent} = symbol;
    symbolsById.set(symbol.id, persistent);
  }
  const localSymbolIds = new Set(symbolsById.keys());
  const referencesByEdgeId = new Map<string, CodeGraphReference>();
  for (const reference of compacted.references ?? []) referencesByEdgeId.set(reference.edgeId, reference);
  const orderedSymbols = [...symbolsById.values()].sort(
    (left, right) =>
      cachedFactSymbolPriority(left) - cachedFactSymbolPriority(right) ||
      left.span.line - right.span.line ||
      left.span.column - right.span.column ||
      compareCodeUnits(left.id, right.id),
  );
  const orderedEdges = [...compacted.edges].sort(
    (left, right) =>
      cachedFactRelationshipPriority(left.relation) - cachedFactRelationshipPriority(right.relation) ||
      compareCodeUnits(left.evidencePath, right.evidencePath) ||
      left.evidenceSpan.line - right.evidenceSpan.line ||
      left.evidenceSpan.column - right.evidenceSpan.column ||
      compareCodeUnits(left.id, right.id),
  );

  const selectedSymbols: CodeGraphSymbol[] = [];
  const selectedSymbolIds = new Set<string>();
  const selectedEdges: CodeGraphEdge[] = [];
  const selectedEdgeIds = new Set<string>();
  const selectedReferences: CodeGraphReference[] = [];
  const selectedMonikers: CodeGraphMonikerV1[] = [];
  const selectedDiagnostics: string[] = [];
  const includeReferences = compacted.references !== undefined;
  const output = (): CodeGraphFileFacts => ({
    diagnostics: selectedDiagnostics,
    edges: selectedEdges,
    ...(compacted.monikers === undefined ? {} : {monikers: selectedMonikers}),
    path: compacted.path,
    ...(includeReferences ? {references: selectedReferences} : {}),
    symbols: selectedSymbols,
  });
  let selectedBytes = cachedCodeGraphFactBytes(output());

  for (const moniker of canonicalCodeGraphMonikers(compacted.monikers ?? [])) {
    const anchor = moniker.scheme === 'protobuf' ? symbolsById.get(moniker.symbolId) : undefined;
    if (moniker.scheme === 'protobuf' && anchor === undefined) continue;
    const missingAnchor = anchor === undefined || selectedSymbolIds.has(anchor.id) ? [] : [anchor];
    const delta =
      cachedFactArrayAppendBytes(selectedSymbols.length, missingAnchor) +
      cachedFactArrayAppendBytes(selectedMonikers.length, [moniker]);
    if (selectedBytes + delta > maximumBytes) continue;
    for (const symbol of missingAnchor) {
      selectedSymbols.push(symbol);
      selectedSymbolIds.add(symbol.id);
    }
    selectedMonikers.push(moniker);
    selectedBytes += delta;
  }

  const tryAddDiagnostic = (diagnostic: string): boolean => {
    const delta = cachedFactArrayAppendBytes(selectedDiagnostics.length, [diagnostic]);
    if (selectedBytes + delta > maximumBytes) return false;
    selectedDiagnostics.push(diagnostic);
    selectedBytes += delta;
    return true;
  };

  tryAddDiagnostic(CACHED_FACT_BUDGET_DIAGNOSTIC);

  const tryAddSymbols = (ids: readonly string[]): boolean => {
    const missing: CodeGraphSymbol[] = [];
    const pending = new Set<string>();
    for (const id of ids) {
      if (selectedSymbolIds.has(id) || pending.has(id)) continue;
      const symbol = Option.fromUndefinedOr(symbolsById.get(id));
      if (Option.isNone(symbol)) continue;
      pending.add(id);
      missing.push(symbol.value);
    }
    const delta = cachedFactArrayAppendBytes(selectedSymbols.length, missing);
    if (selectedBytes + delta > maximumBytes) return false;
    for (const symbol of missing) {
      selectedSymbols.push(symbol);
      selectedSymbolIds.add(symbol.id);
    }
    selectedBytes += delta;
    return true;
  };

  const tryAddRelationship = (edge: CodeGraphEdge): boolean => {
    if (selectedEdgeIds.has(edge.id)) return true;
    const reference = Option.fromUndefinedOr(referencesByEdgeId.get(edge.id));
    const references = Option.toArray(reference);
    const dependencyIds = new Set<string>();
    for (const id of [edge.sourceId, edge.targetId, ...EffectArray.map(references, value => value.sourceId)]) {
      if (id !== undefined && localSymbolIds.has(id)) dependencyIds.add(id);
    }
    const missingSymbols = EffectArray.flatMap([...dependencyIds], id => {
      if (selectedSymbolIds.has(id)) return [];
      return Option.toArray(Option.fromUndefinedOr(symbolsById.get(id)));
    });
    const delta =
      cachedFactArrayAppendBytes(selectedSymbols.length, missingSymbols) +
      cachedFactArrayAppendBytes(selectedEdges.length, [edge]) +
      cachedFactArrayAppendBytes(selectedReferences.length, references);
    if (selectedBytes + delta > maximumBytes) return false;
    for (const symbol of missingSymbols) {
      selectedSymbols.push(symbol);
      selectedSymbolIds.add(symbol.id);
    }
    selectedEdges.push(edge);
    selectedEdgeIds.add(edge.id);
    selectedReferences.push(...references);
    selectedBytes += delta;
    return true;
  };

  for (const symbol of EffectArray.filter(orderedSymbols, value => cachedFactSymbolPriority(value) === 0)) {
    tryAddSymbols([symbol.id]);
  }
  for (const edge of EffectArray.filter(orderedEdges, value => cachedFactRelationshipPriority(value.relation) === 0)) {
    tryAddRelationship(edge);
  }
  for (const edge of EffectArray.filter(orderedEdges, value => cachedFactRelationshipPriority(value.relation) === 1)) {
    tryAddRelationship(edge);
  }
  for (const symbol of EffectArray.filter(orderedSymbols, value => cachedFactSymbolPriority(value) === 1)) {
    tryAddSymbols([symbol.id]);
  }
  for (const symbol of EffectArray.filter(orderedSymbols, value => cachedFactSymbolPriority(value) === 2)) {
    tryAddSymbols([symbol.id]);
  }
  for (const edge of EffectArray.filter(orderedEdges, value => cachedFactRelationshipPriority(value.relation) === 2)) {
    tryAddRelationship(edge);
  }
  for (const edge of EffectArray.filter(orderedEdges, value => cachedFactRelationshipPriority(value.relation) === 3)) {
    tryAddRelationship(edge);
  }
  for (const symbol of EffectArray.filter(orderedSymbols, value => cachedFactSymbolPriority(value) === 3)) {
    tryAddSymbols([symbol.id]);
  }
  for (const edge of EffectArray.filter(orderedEdges, value => cachedFactRelationshipPriority(value.relation) === 4)) {
    tryAddRelationship(edge);
  }
  for (const diagnostic of [...new Set(compacted.diagnostics)].sort(compareCodeUnits).slice(0, 20)) {
    if (diagnostic !== CACHED_FACT_BUDGET_DIAGNOSTIC) tryAddDiagnostic(diagnostic);
  }

  return output();
}

/**
 * Removes only the resolution payload for pathological references. Their edge
 * remains in the graph as unresolved, so one file can never reject its
 * repository or expand a bounded resolution page beyond its cardinality cap.
 */
export function budgetCodeGraphReferenceCandidates(facts: CodeGraphFileFacts): CodeGraphFileFacts {
  if (facts.references === undefined) return facts;
  const sourceReferences = facts.references;
  const references = EffectArray.filter(
    sourceReferences,
    (__effectFilterValue: (typeof facts.references)[number], __effectFilterIndex: number) =>
      __effectFilterIndex in sourceReferences && isCodeGraphReferenceWithinCandidateBudget(__effectFilterValue),
  );
  if (references.length === facts.references.length) return facts;
  return {
    ...facts,
    diagnostics: facts.diagnostics.includes(CODE_GRAPH_REFERENCE_CANDIDATE_BUDGET_DIAGNOSTIC)
      ? facts.diagnostics
      : [...facts.diagnostics, CODE_GRAPH_REFERENCE_CANDIDATE_BUDGET_DIAGNOSTIC],
    references,
  };
}

export function isCodeGraphReferenceWithinCandidateBudget(reference: CodeGraphReference): boolean {
  return areCodeGraphLookupTiersWithinCandidateBudget(reference.lookupTiers);
}

export function areCodeGraphLookupTiersWithinCandidateBudget(lookupTiers: readonly (readonly string[])[]): boolean {
  let candidates = 0;
  for (const tier of lookupTiers) {
    const unique = new Set<string>();
    for (const lookupKey of tier) {
      if (unique.has(lookupKey)) continue;
      unique.add(lookupKey);
      candidates += 1;
      if (candidates > CODE_GRAPH_REFERENCE_CANDIDATES_PER_REFERENCE_MAXIMUM) return false;
    }
  }
  return true;
}

/** First edge wins; the last reference for one edge retains attribution semantics. */
export function compactCachedFileRelationships(facts: CodeGraphFileFacts): CodeGraphFileFacts {
  const edgeById = new Map<string, CodeGraphEdge>();
  for (const edge of facts.edges) {
    if (!edgeById.has(edge.id)) edgeById.set(edge.id, edge);
  }
  const referenceByEdgeId = new Map<string, CodeGraphReference>();
  for (const reference of facts.references ?? []) referenceByEdgeId.set(reference.edgeId, reference);
  if (edgeById.size === facts.edges.length && referenceByEdgeId.size === (facts.references?.length ?? 0)) return facts;
  return {
    ...facts,
    edges: [...edgeById.values()],
    ...(facts.references === undefined ? {} : {references: [...referenceByEdgeId.values()]}),
  };
}

/** Canonicalizes duplicate primary keys before a source batch can be split into transactions. */
function canonicalMaterializationFacts(facts: readonly CodeGraphFileFacts[]): readonly CodeGraphFileFacts[] {
  const symbolIds = new Set<string>();
  const edgeIds = new Set<string>();
  const referencesByEdgeId = new Map<string, CodeGraphReference>();
  for (const fact of facts) {
    for (const reference of fact.references ?? []) referencesByEdgeId.set(reference.edgeId, reference);
  }
  const includeReferences = EffectArray.some(facts, fact => fact.references !== undefined);
  return EffectArray.map(facts, fact => {
    const symbols = EffectArray.filter(fact.symbols, symbol => {
      if (symbolIds.has(symbol.id)) return false;
      symbolIds.add(symbol.id);
      return true;
    });
    const edges = EffectArray.filter(fact.edges, edge => {
      if (edgeIds.has(edge.id)) return false;
      edgeIds.add(edge.id);
      return true;
    });
    return {
      ...fact,
      edges,
      ...(includeReferences
        ? {
            references: EffectArray.flatMap(edges, edge =>
              Option.toArray(Option.fromUndefinedOr(referencesByEdgeId.get(edge.id))),
            ),
          }
        : {}),
      symbols,
    };
  });
}

/** Drops relationships whose original batch-local endpoints did not survive per-file budgeting. */
function closeMaterializationFacts(
  original: readonly CodeGraphFileFacts[],
  bounded: readonly CodeGraphFileFacts[],
): readonly CodeGraphFileFacts[] {
  const originalSymbolIds = new Set(
    EffectArray.flatMap(original, fact => EffectArray.map(fact.symbols, symbol => symbol.id)),
  );
  const retainedSymbolIds = new Set(
    EffectArray.flatMap(bounded, fact => EffectArray.map(fact.symbols, symbol => symbol.id)),
  );
  return EffectArray.map(bounded, fact => {
    const edges = EffectArrayPipe(fact.edges, __effectArrayValues =>
      EffectArray.filter(
        __effectArrayValues,
        (edge, __effectArrayIndex) =>
          __effectArrayIndex in __effectArrayValues &&
          (edge.sourceId === undefined ||
            !originalSymbolIds.has(edge.sourceId) ||
            retainedSymbolIds.has(edge.sourceId)) &&
          (edge.targetId === undefined ||
            !originalSymbolIds.has(edge.targetId) ||
            retainedSymbolIds.has(edge.targetId)),
      ),
    );
    const retainedEdgeIds = new Set(EffectArray.map(edges, edge => edge.id));
    const originalReferences = fact.references;
    const references =
      originalReferences === undefined
        ? undefined
        : EffectArray.filter(
            originalReferences,
            (reference, __effectArrayIndex) =>
              __effectArrayIndex in originalReferences &&
              retainedEdgeIds.has(reference.edgeId) &&
              (reference.sourceId === undefined ||
                !originalSymbolIds.has(reference.sourceId) ||
                retainedSymbolIds.has(reference.sourceId)),
          );
    if (edges.length === fact.edges.length && references?.length === fact.references?.length) return fact;
    return {...fact, edges, ...(references === undefined ? {} : {references})};
  });
}

function cachedJsonByteUpperBound(value: unknown): number {
  switch (typeof value) {
    case 'string':
      return saturatingAdd(2, saturatingMultiply(value.length, 6));
    case 'number':
      return 32;
    case 'boolean':
      return 5;
    case 'bigint':
      return Number.MAX_SAFE_INTEGER;
    case 'undefined':
    case 'function':
    case 'symbol':
      return 4;
    case 'object': {
      if (value === null) return 4;
      if (EffectArray.isArray(value)) {
        let bytes = saturatingAdd(2, Math.max(0, value.length - 1));
        for (const entry of value) bytes = saturatingAdd(bytes, cachedJsonByteUpperBound(entry));
        return bytes;
      }
      const entries = EffectRecord.toEntries(value);
      let bytes = saturatingAdd(2, Math.max(0, entries.length - 1));
      for (const [key, entry] of entries) {
        bytes = saturatingAdd(bytes, cachedJsonByteUpperBound(key), 1, cachedJsonByteUpperBound(entry));
      }
      return bytes;
    }
  }
}

function measureBoundedCodeGraphFactWithJson(
  facts: CodeGraphFileFacts,
  maximumBytes: number,
): {readonly bytes: number; readonly facts: CodeGraphFileFacts; readonly json: string} {
  const compacted = budgetCodeGraphReferenceCandidates(compactCachedFileRelationships(facts));
  // This boundary needs JSON anyway: reuse its exact bytes instead of walking
  // every property first to calculate a conservative serialization upper bound.
  const compactedJson = JSON.stringify(compacted);
  const compactedBytes = cachedFactEncoder.encode(compactedJson).byteLength;
  if (compactedBytes <= maximumBytes) return {bytes: compactedBytes, facts: compacted, json: compactedJson};
  const bounded = selectCachedCodeGraphFactsWithinBudget(compacted, maximumBytes);
  const json = JSON.stringify(bounded);
  return {bytes: cachedFactEncoder.encode(json).byteLength, facts: bounded, json};
}

function cachedFactArrayAppendBytes(currentLength: number, values: readonly unknown[]): number {
  if (values.length === 0) return 0;
  let bytes = currentLength === 0 ? values.length - 1 : values.length;
  for (const value of values) bytes += cachedFactEncoder.encode(JSON.stringify(value) ?? 'null').byteLength;
  return bytes;
}

function cachedFactSymbolPriority(symbol: CodeGraphSymbol): number {
  if (['file', 'module', 'package', 'project', 'target', 'workspace'].includes(symbol.kind)) return 0;
  if (['asset', 'document', 'heading', 'rationale'].includes(symbol.kind)) return 3;
  return symbol.exported ? 1 : 2;
}

function cachedFactRelationshipPriority(relation: CodeGraphRelation): number {
  switch (relation) {
    case 'configures':
    case 'depends_on':
    case 'exports':
    case 'imports':
    case 'reexports':
      return 0;
    case 'contains':
    case 'declares':
      return 1;
    case 'extends':
    case 'implements':
    case 'overrides':
    case 'tests':
      return 2;
    case 'calls':
    case 'constructs':
    case 'reads_or_writes':
    case 'references':
      return 3;
    case 'documents':
    case 'semantic_association':
      return 4;
  }
}

function saturatingMultiply(value: number, multiplier: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value * multiplier);
}

function saturatingAdd(...values: readonly number[]): number {
  return EffectArray.reduce(values, 0, (total, value) => Math.min(Number.MAX_SAFE_INTEGER, total + value));
}
