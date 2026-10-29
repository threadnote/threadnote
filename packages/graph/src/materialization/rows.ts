import {Array as EffectArray} from 'effect';
import {canonicalCodeGraphMonikers} from '../cross_repository/monikers.js';
import type {CodeGraphMonikerV1} from '../cross_repository/types.js';
import {compareCodeUnits} from '../ordering.js';
import type {CodeGraphReusableReexport} from '../store/models.js';
import type {CodeGraphEdge, CodeGraphReference, CodeGraphSymbol} from '../types.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const referenceCandidateEncoder = new TextEncoder();

export interface CodeGraphMaterializationEdgeRow {
  readonly confidence: number;
  readonly evidencePath: string;
  readonly evidenceSpanJson: string;
  readonly id: string;
  readonly provenance: CodeGraphEdge['provenance'];
  readonly relation: CodeGraphEdge['relation'];
  readonly sourceId: string | null;
  readonly sourceName: string;
  readonly targetId: string | null;
  readonly targetName: string;
}

export function codeGraphMaterializationEdgeRows(
  edges: readonly CodeGraphEdge[],
): readonly CodeGraphMaterializationEdgeRow[] {
  return EffectArray.map(
    [...edges].sort((left, right) => compareCodeUnits(left.id, right.id)),
    edge => ({
      confidence: edge.confidence,
      evidencePath: edge.evidencePath,
      evidenceSpanJson: JSON.stringify(edge.evidenceSpan),
      id: edge.id,
      provenance: edge.provenance,
      relation: edge.relation,
      sourceId: edge.sourceId ?? null,
      sourceName: edge.sourceName,
      targetId: edge.targetId ?? null,
      targetName: edge.targetName,
    }),
  );
}

export interface CodeGraphMaterializationSymbolLookupRow {
  readonly evidenceEdgeId?: string;
  readonly evidencePath: string;
  readonly exported: 0 | 1;
  readonly lookupKey: string;
  readonly provenance: 'symbol';
  readonly resolutionDomain: string;
  readonly symbolId: string;
}

export interface CodeGraphMaterializationSymbolTermRow {
  readonly symbolId: string;
  readonly term: string;
  readonly weight: number;
}

export interface CodeGraphMaterializationReferenceRow {
  readonly aliasLookupKeysJson: string;
  readonly candidateCount: number;
  readonly candidatePayloadBytes: number;
  readonly confidence: number;
  readonly edgeId: string;
  readonly evidencePath: string;
  readonly evidenceSpanJson: string;
  readonly exportedOnly: 0 | 1;
  readonly lookupTiersJson: string;
  readonly provenance: CodeGraphEdge['provenance'];
  readonly relation: CodeGraphEdge['relation'];
  readonly resolutionDomain: string;
  readonly sourceId: string | null;
  readonly sourceName: string;
  readonly targetName: string;
}

export interface CodeGraphMaterializationMonikerRow {
  readonly componentId: string | null;
  readonly dependencyKind: string | null;
  readonly evidencePath: string;
  readonly evidenceSpanJson: string;
  readonly id: string;
  readonly identity: string;
  readonly importPath: string | null;
  readonly kind: string;
  readonly packageName: string | null;
  readonly packageVersion: string | null;
  readonly qualifiedName: string | null;
  readonly resolutionDomain: string;
  readonly role: string;
  readonly scheme: string;
  readonly symbolId: string | null;
  readonly version: number;
}

export interface CompactedReferenceLookupTiers {
  readonly candidateCount: number;
  readonly json: string;
  readonly payloadBytes: number;
  readonly tiers: readonly (readonly string[])[];
}

export interface CodeGraphMaterializationSymbolRow {
  readonly arity: number | null;
  readonly contentHash: string;
  readonly documentation: string | null;
  readonly exported: 0 | 1;
  readonly id: string;
  readonly kind: string;
  readonly language: string;
  readonly lookupKeysJson: string;
  readonly name: string;
  readonly packageName: string | null;
  readonly path: string;
  readonly qualifiedName: string;
  readonly resolutionDomain: string | null;
  readonly resolutionScopeId: string | null;
  readonly signature: string | null;
  readonly spanJson: string;
}

export function codeGraphMaterializationSymbolRows(
  symbols: readonly CodeGraphSymbol[],
): readonly CodeGraphMaterializationSymbolRow[] {
  return EffectArray.map(
    [...symbols].sort((left, right) => compareCodeUnits(left.id, right.id)),
    symbol => ({
      arity: symbol.arity ?? null,
      contentHash: symbol.contentHash,
      documentation: symbol.documentation ?? null,
      exported: symbol.exported ? 1 : 0,
      id: symbol.id,
      kind: symbol.kind,
      language: symbol.language,
      lookupKeysJson: JSON.stringify(symbol.lookupKeys ?? []),
      name: symbol.name,
      packageName: symbol.packageName ?? null,
      path: symbol.path,
      qualifiedName: symbol.qualifiedName,
      resolutionDomain: symbol.resolutionDomain ?? null,
      resolutionScopeId: symbol.resolutionScopeId ?? null,
      signature: symbol.signature ?? null,
      spanJson: JSON.stringify(symbol.span),
    }),
  );
}

/** Canonical snapshot-independent lookup rows shared by direct and spool writers. */
export function codeGraphMaterializationSymbolLookupRows(
  symbols: readonly CodeGraphSymbol[],
): readonly CodeGraphMaterializationSymbolLookupRow[] {
  const rows = new Map<string, CodeGraphMaterializationSymbolLookupRow>();
  for (const symbol of symbols) {
    for (const lookupKey of symbol.lookupKeys ?? []) {
      const identity = `${lookupKey}\0${symbol.id}`;
      if (rows.has(identity)) continue;
      rows.set(identity, {
        evidencePath: symbol.path,
        exported: symbol.exported ? 1 : 0,
        lookupKey,
        provenance: 'symbol',
        resolutionDomain: codeGraphLookupDomain(lookupKey, symbol.resolutionDomain),
        symbolId: symbol.id,
      });
    }
  }
  return [...rows.values()].sort(
    (left, right) =>
      compareCodeUnits(left.lookupKey, right.lookupKey) || compareCodeUnits(left.symbolId, right.symbolId),
  );
}

export function codeGraphMaterializationSymbolTermRows(
  symbols: readonly CodeGraphSymbol[],
  termsBySymbol: ReadonlyMap<CodeGraphSymbol, readonly (readonly [string, number])[]>,
): readonly CodeGraphMaterializationSymbolTermRow[] {
  const rows: CodeGraphMaterializationSymbolTermRow[] = [];
  for (const symbol of symbols) {
    const terms = termsBySymbol.get(symbol);
    if (terms === undefined) {
      throw new Error('Code graph materialization symbol terms are missing.');
    }
    for (const [term, weight] of terms) rows.push({symbolId: symbol.id, term, weight});
  }
  return rows.sort(
    (left, right) => compareCodeUnits(left.term, right.term) || compareCodeUnits(left.symbolId, right.symbolId),
  );
}

/** Canonical unresolved-reference payload shared by direct and spool writers. */
export function codeGraphMaterializationReferenceRows(
  references: readonly CodeGraphReference[],
  referenceEdges: ReadonlyMap<string, CodeGraphEdge>,
): readonly CodeGraphMaterializationReferenceRow[] {
  const edgeIds = new Set<string>();
  return EffectArray.map(
    [...references].sort((left, right) => compareCodeUnits(left.edgeId, right.edgeId)),
    reference => {
      if (edgeIds.has(reference.edgeId)) {
        throw new Error('Code graph materialization reference identities are duplicated.');
      }
      edgeIds.add(reference.edgeId);
      const edge = referenceEdges.get(reference.edgeId);
      if (edge === undefined || edge.targetId !== undefined) {
        throw new Error('Code graph materialization reference edge payload is missing or resolved.');
      }
      const candidates = compactReferenceLookupTiers(reference.lookupTiers);
      return {
        aliasLookupKeysJson: JSON.stringify(reference.aliasLookupKeys ?? []),
        candidateCount: candidates.candidateCount,
        candidatePayloadBytes: candidates.payloadBytes,
        confidence: edge.confidence,
        edgeId: reference.edgeId,
        evidencePath: edge.evidencePath,
        evidenceSpanJson: JSON.stringify(edge.evidenceSpan),
        exportedOnly: reference.exportedOnly === true ? 1 : 0,
        lookupTiersJson: candidates.json,
        provenance: edge.provenance,
        relation: edge.relation,
        resolutionDomain: reference.resolutionDomain,
        sourceId: edge.sourceId ?? null,
        sourceName: edge.sourceName,
        targetName: edge.targetName,
      };
    },
  );
}

export function codeGraphMaterializationMonikerRows(
  monikers: readonly CodeGraphMonikerV1[],
): readonly CodeGraphMaterializationMonikerRow[] {
  return EffectArray.map(canonicalCodeGraphMonikers(monikers), moniker => ({
    componentId: 'componentId' in moniker ? (moniker.componentId ?? null) : null,
    dependencyKind: 'dependencyKind' in moniker ? (moniker.dependencyKind ?? null) : null,
    evidencePath: moniker.evidence.path,
    evidenceSpanJson: JSON.stringify(moniker.evidence.span),
    id: moniker.id,
    identity: moniker.identity,
    importPath: 'importPath' in moniker ? (moniker.importPath ?? null) : null,
    kind: moniker.kind,
    packageName: 'packageName' in moniker ? (moniker.packageName ?? null) : null,
    packageVersion: 'packageVersion' in moniker ? (moniker.packageVersion ?? null) : null,
    qualifiedName: 'qualifiedName' in moniker ? (moniker.qualifiedName ?? null) : null,
    resolutionDomain: moniker.resolutionDomain,
    role: moniker.role,
    scheme: moniker.scheme,
    symbolId: 'symbolId' in moniker ? (moniker.symbolId ?? null) : null,
    version: moniker.version,
  }));
}

export function compactReferenceLookupTiers(
  lookupTiers: readonly (readonly string[])[],
): CompactedReferenceLookupTiers {
  const tiers = EffectArray.map(lookupTiers, tier => [...new Set(tier)].sort(compareCodeUnits));
  const json = JSON.stringify(tiers);
  return {
    candidateCount: EffectArray.reduce(tiers, 0, (total, tier) => total + tier.length),
    json,
    payloadBytes: referenceCandidateEncoder.encode(json).byteLength,
    tiers,
  };
}

export function codeGraphMaterializationReexportRows(
  references: readonly CodeGraphReference[],
): readonly CodeGraphReusableReexport[] {
  const rows = new Map<string, CodeGraphReusableReexport>();
  for (const reference of references) {
    for (const row of normalizedReexportProvenance(reference)) {
      rows.set(EffectArray.join([row.sourcePath, row.localName, row.targetPath, row.importedName], '\0'), row);
    }
  }
  return [...rows.values()].sort(
    (left, right) =>
      compareCodeUnits(left.sourcePath, right.sourcePath) ||
      compareCodeUnits(left.localName, right.localName) ||
      compareCodeUnits(left.targetPath, right.targetPath) ||
      compareCodeUnits(left.importedName, right.importedName),
  );
}

export function normalizedReexportProvenance(reference: CodeGraphReference): readonly CodeGraphReusableReexport[] {
  if (reference.relation !== 'reexports' || reference.resolutionDomain !== 'typescript') return [];
  const aliases = EffectArray.filter(
    uniquePathNameLookupKeys(reference.aliasLookupKeys ?? []),
    candidate => candidate.path === reference.evidencePath,
  );
  const targets = uniquePathNameLookupKeys(reference.lookupTiers.flat());
  return EffectArray.flatMap(aliases, alias =>
    EffectArray.map(targets, target => ({
      importedName: target.name,
      localName: alias.name,
      sourcePath: alias.path,
      targetPath: target.path,
    })),
  );
}

export function parseTypeScriptPathNameLookupKey(
  value: string,
): {readonly name: string; readonly path: string} | undefined {
  const match =
    /^typescript:(?:[^:]+:)?path:([^:]+):name:([^:]+)(?::(?:arity:\d+|implementation|merge-canonical))?$/u.exec(value);
  if (!match) return undefined;
  try {
    return {name: decodeURIComponent(match[2]), path: decodeURIComponent(match[1])};
  } catch {
    return undefined;
  }
}

function uniquePathNameLookupKeys(
  values: readonly string[],
): readonly {readonly name: string; readonly path: string}[] {
  const parsed = new Map<string, {readonly name: string; readonly path: string}>();
  for (const value of values) {
    const candidate = parseTypeScriptPathNameLookupKey(value);
    if (candidate !== undefined) parsed.set(`${candidate.path}\0${candidate.name}`, candidate);
  }
  return [...parsed.values()];
}

export function codeGraphLookupDomain(lookupKey: string, fallback: string | undefined): string {
  const separator = Effect.pipe(
    lookupKey,
    EffectString.indexOf(':'),
    Effect.Option.getOrElse(() => -1),
  );
  return separator > 0 ? Effect.pipe(lookupKey, EffectString.slice(0, separator)) : (fallback ?? 'generic');
}
