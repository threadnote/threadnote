import {Array as EffectArray} from 'effect';
import {compareCodeUnits} from '../ordering.js';
import type {CodeGraphReference, CodeGraphSymbol} from '../types.js';

export type CodeGraphResolutionSurfaceSymbol = Pick<
  CodeGraphSymbol,
  | 'arity'
  | 'exported'
  | 'id'
  | 'kind'
  | 'language'
  | 'lookupKeys'
  | 'name'
  | 'packageName'
  | 'path'
  | 'qualifiedName'
  | 'resolutionDomain'
  | 'resolutionScopeId'
>;

export type CodeGraphResolutionPublicationGate =
  'exported' | 'non-typescript-domain' | 'own-path-local' | 'unknown-lookup-form' | 'foreign-path' | 'scope-mismatch';

export type CodeGraphResolutionLookupKeyForm =
  'none' | 'non-typescript' | 'typescript-other' | 'typescript-path-scoped' | 'typescript-path-unscoped';

export interface CodeGraphResolutionPublicationAssessment {
  /** Closed, path-free gate suitable for anonymous build telemetry. */
  readonly gate: CodeGraphResolutionPublicationGate;
  /** Closed lookup-key shape; never contains a symbol, scope, or repository path. */
  readonly lookupKeyForm: CodeGraphResolutionLookupKeyForm;
  readonly published: boolean;
}

export function hasSameCodeGraphResolutionSurface(
  left: readonly CodeGraphResolutionSurfaceSymbol[],
  right: readonly CodeGraphResolutionSurfaceSymbol[],
): boolean {
  const leftById = new Map<string, string>();
  const leftIds = new Set<string>();
  for (const symbol of left) {
    if (leftIds.has(symbol.id)) return false;
    leftIds.add(symbol.id);
    if (!isPublishedCodeGraphResolutionSymbol(symbol)) continue;
    leftById.set(symbol.id, symbolResolutionSurface(symbol));
  }
  const rightIds = new Set<string>();
  let rightPublishedCount = 0;
  for (const symbol of right) {
    if (rightIds.has(symbol.id)) return false;
    rightIds.add(symbol.id);
    if (!isPublishedCodeGraphResolutionSymbol(symbol)) continue;
    rightPublishedCount += 1;
    if (leftById.get(symbol.id) !== symbolResolutionSurface(symbol)) return false;
  }
  return leftById.size === rightPublishedCount;
}

/**
 * Re-export aliases publish lookup keys that may be consumed outside the file
 * being replaced. A span-only edit is local when the exact resolver input is
 * otherwise unchanged. Unknown alias forms and duplicate reference identities
 * deliberately fail closed so they continue through project-closure planning.
 */
export function hasSameCodeGraphReexportResolutionSurface(
  left: readonly CodeGraphReference[],
  right: readonly CodeGraphReference[],
): boolean {
  const leftSurface = staticReexportResolutionSurface(left);
  const rightSurface = staticReexportResolutionSurface(right);
  if (leftSurface === undefined || rightSurface === undefined || leftSurface.size !== rightSurface.size) return false;
  for (const [edgeId, surface] of leftSurface) {
    if (rightSurface.get(edgeId) !== surface) return false;
  }
  return true;
}

function staticReexportResolutionSurface(
  references: readonly CodeGraphReference[],
): ReadonlyMap<string, string> | undefined {
  const aliases = EffectArray.filter(references, reference => (reference.aliasLookupKeys?.length ?? 0) > 0);
  if (aliases.length === 0) return new Map();

  const referenceIds = new Set<string>();
  for (const reference of references) {
    if (referenceIds.has(reference.edgeId)) return undefined;
    referenceIds.add(reference.edgeId);
  }

  const surface = new Map<string, string>();
  for (const reference of aliases) {
    if (
      reference.relation !== 'reexports' ||
      reference.resolutionDomain !== 'typescript' ||
      reference.exportedOnly !== true
    ) {
      return undefined;
    }
    surface.set(reference.edgeId, reexportResolutionSurface(reference));
  }
  return surface;
}

function reexportResolutionSurface(reference: CodeGraphReference): string {
  return JSON.stringify({
    aliasLookupKeys: canonicalStringSet(reference.aliasLookupKeys ?? []),
    arity: reference.arity,
    edgeId: reference.edgeId,
    evidencePath: reference.evidencePath,
    exportedOnly: reference.exportedOnly,
    lookupTiers: EffectArray.map(reference.lookupTiers, canonicalStringSet),
    provenance: reference.provenance,
    relation: reference.relation,
    resolutionDomain: reference.resolutionDomain,
    sourceId: reference.sourceId,
    sourceName: reference.sourceName,
    targetName: reference.targetName,
  });
}

function canonicalStringSet(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

/**
 * Published symbols can participate in lookup from outside the file whose
 * facts an overlay replaces. Unknown and non-path-local lookup-key forms fail
 * closed as published.
 */
export function isPublishedCodeGraphResolutionSymbol(symbol: CodeGraphResolutionSurfaceSymbol): boolean {
  return assessCodeGraphResolutionSymbolPublication(symbol).published;
}

/**
 * Classifies publication using only resolver lookup tiers. The closed gate and
 * key form intentionally expose enough evidence to diagnose fail-closed
 * fallbacks without recording paths, symbol names, or project identifiers.
 */
export function assessCodeGraphResolutionSymbolPublication(
  symbol: CodeGraphResolutionSurfaceSymbol,
): CodeGraphResolutionPublicationAssessment {
  if (symbol.exported) {
    return {gate: 'exported', lookupKeyForm: firstLookupKeyForm(symbol), published: true};
  }
  // Rationale annotations are derived from a source file and only emit a direct
  // `documents` edge to an owner in that same file. Their human-facing lookup
  // terms are query metadata, not resolver endpoints. Line movement therefore
  // stays inside the changed-file rewrite instead of forcing repository-wide
  // resolution closure.
  if (symbol.kind === 'rationale' && symbol.resolutionDomain === 'documentation') {
    return {
      gate: 'own-path-local',
      lookupKeyForm: symbol.lookupKeys?.length ? 'non-typescript' : 'none',
      published: false,
    };
  }
  if (symbol.resolutionDomain !== 'typescript') {
    return {
      gate: 'non-typescript-domain',
      lookupKeyForm: symbol.lookupKeys?.length ? 'non-typescript' : 'none',
      published: true,
    };
  }
  let lookupKeyForm: CodeGraphResolutionLookupKeyForm = 'none';
  for (const key of symbol.lookupKeys ?? []) {
    const assessment = assessOwnTypeScriptPathLookupKey(key, symbol);
    lookupKeyForm = assessment.lookupKeyForm;
    if (assessment.gate !== 'own-path-local') {
      return {gate: assessment.gate, lookupKeyForm, published: true};
    }
  }
  return {gate: 'own-path-local', lookupKeyForm, published: false};
}

function symbolResolutionSurface(symbol: CodeGraphResolutionSurfaceSymbol): string {
  // Signature, content, documentation, and spans are replaced with the changed file's facts but do not affect
  // cross-file endpoint resolution. File-local unpublished declarations are replaced with the changed file too;
  // the current resolver's published lookup contract is serialized below.
  return JSON.stringify({
    arity: symbol.arity,
    exported: symbol.exported,
    id: symbol.id,
    kind: symbol.kind,
    language: symbol.language,
    lookupKeys: symbol.lookupKeys ?? [],
    name: symbol.name,
    packageName: symbol.packageName,
    path: symbol.path,
    qualifiedName: symbol.qualifiedName,
    resolutionDomain: symbol.resolutionDomain,
    resolutionScopeId: symbol.resolutionScopeId,
  });
}

function assessOwnTypeScriptPathLookupKey(
  key: string,
  symbol: CodeGraphResolutionSurfaceSymbol,
): Pick<CodeGraphResolutionPublicationAssessment, 'gate' | 'lookupKeyForm'> {
  const match =
    /^typescript:(?:([^:]+):)?path:([^:]+):(?:name|qualified):[^:]+(?::(?:arity:\d+|implementation|merge-canonical))?$/.exec(
      key,
    );
  if (!match) return {gate: 'unknown-lookup-form', lookupKeyForm: 'typescript-other'};
  const lookupKeyForm = match[1] === undefined ? 'typescript-path-unscoped' : 'typescript-path-scoped';
  if (match[1] !== undefined && match[1] !== symbol.resolutionScopeId) {
    return {gate: 'scope-mismatch', lookupKeyForm};
  }
  try {
    return decodeURIComponent(match[2]) === symbol.path
      ? {gate: 'own-path-local', lookupKeyForm}
      : {gate: 'foreign-path', lookupKeyForm};
  } catch {
    return {gate: 'unknown-lookup-form', lookupKeyForm};
  }
}

function firstLookupKeyForm(symbol: CodeGraphResolutionSurfaceSymbol): CodeGraphResolutionLookupKeyForm {
  const key = symbol.lookupKeys?.[0];
  if (key === undefined) return 'none';
  if (symbol.resolutionDomain !== 'typescript') return 'non-typescript';
  if (/^typescript:path:/.test(key)) return 'typescript-path-unscoped';
  if (/^typescript:[^:]+:path:/.test(key)) return 'typescript-path-scoped';
  return 'typescript-other';
}
