import {Array as EffectArray} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {normalizeWorksetScopeReceipt, worksetScopeDigestFields} from './scope_receipt.js';
import {
  CODE_GRAPH_WORKSET_CATALOG_LIMITS,
  CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION,
  CodeGraphWorksetCatalogError,
  type CodeGraphWorksetCatalogGenerationInputV1,
  type CodeGraphWorksetCatalogGenerationIdentityV1,
  type CodeGraphWorksetCatalogGenerationDigestMemberV1,
  type CodeGraphWorksetCatalogGenerationMemberV1,
  type CodeGraphWorksetCatalogGenerationReceiptIdentityV1,
  type CodeGraphWorksetCatalogGenerationReceiptInputV1,
  type CodeGraphWorksetRoutingProjectionDraftV1,
  type CodeGraphWorksetRoutingProjectionDigestStateV1,
  type CodeGraphWorksetRoutingProjectionReceiptV1,
  type CodeGraphWorksetRoutingProjectionV1,
  type CodeGraphWorksetRoutingSymbolV1,
} from './types.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const COMMIT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const NODE_ID = /^cgs_(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SYMBOL_CHAIN_SEED = sha256HexSync('threadnote-workset-routing-symbol-chain-v2');

export function createCodeGraphWorksetRoutingProjection(
  input: CodeGraphWorksetRoutingProjectionDraftV1,
): CodeGraphWorksetRoutingProjectionV1 {
  const normalized = normalizeProjectionDraft(input);
  return {...normalized, projectionDigest: codeGraphWorksetRoutingProjectionDigest(normalized)};
}

export function validateCodeGraphWorksetRoutingProjection(
  input: CodeGraphWorksetRoutingProjectionV1,
): CodeGraphWorksetRoutingProjectionV1 {
  assertSha256(input.projectionDigest, 'projection digest');
  const normalized = normalizeProjectionDraft(input);
  const digest = codeGraphWorksetRoutingProjectionDigest(normalized);
  if (digest !== input.projectionDigest) {
    throw invalid('Workset routing projection digest does not match its normalized records.');
  }
  return {...normalized, projectionDigest: digest};
}

export function codeGraphWorksetRoutingProjectionDigest(input: CodeGraphWorksetRoutingProjectionDraftV1): string {
  const normalized = normalizeProjectionDraft(input);
  const appended = codeGraphWorksetRoutingProjectionDigestAppend(
    codeGraphWorksetRoutingProjectionDigestStart(),
    normalized.symbols,
  );
  return codeGraphWorksetRoutingProjectionDigestComplete(
    {...normalized, symbolCount: normalized.symbols.length},
    appended.state,
  );
}

export function codeGraphWorksetRoutingProjectionDigestStart(): CodeGraphWorksetRoutingProjectionDigestStateV1 {
  return {chainDigest: SYMBOL_CHAIN_SEED, symbolCount: 0};
}

/** Normalize and fold one already-ordered page without retaining earlier pages. */
export function codeGraphWorksetRoutingProjectionDigestAppend(
  state: CodeGraphWorksetRoutingProjectionDigestStateV1,
  page: readonly CodeGraphWorksetRoutingSymbolV1[],
): {
  readonly state: CodeGraphWorksetRoutingProjectionDigestStateV1;
  readonly symbols: readonly CodeGraphWorksetRoutingSymbolV1[];
} {
  const symbols = EffectArray.map(page, normalizeCodeGraphWorksetRoutingSymbol);
  return {state: appendCanonicalSymbols(state, symbols, false), symbols};
}

/** Fold an already-normalized page without allocating a second page-sized array. */
export function codeGraphWorksetRoutingProjectionDigestAppendCanonical(
  state: CodeGraphWorksetRoutingProjectionDigestStateV1,
  symbols: readonly CodeGraphWorksetRoutingSymbolV1[],
): CodeGraphWorksetRoutingProjectionDigestStateV1 {
  return appendCanonicalSymbols(state, symbols, true);
}

function appendCanonicalSymbols(
  state: CodeGraphWorksetRoutingProjectionDigestStateV1,
  symbols: readonly CodeGraphWorksetRoutingSymbolV1[],
  validateCanonical: boolean,
): CodeGraphWorksetRoutingProjectionDigestStateV1 {
  assertSha256(state.chainDigest, 'projection symbol-chain digest');
  if (!Number.isSafeInteger(state.symbolCount) || state.symbolCount < 0) {
    throw invalid('Workset projection symbol-chain count is invalid.');
  }
  let chainDigest = state.chainDigest;
  let lastNodeId = state.lastNodeId;
  for (const symbol of symbols) {
    const canonical = validateCanonical ? normalizeCodeGraphWorksetRoutingSymbol(symbol) : symbol;
    if (
      validateCanonical &&
      JSON.stringify(symbolDigestRecord(canonical)) !== JSON.stringify(symbolDigestRecord(symbol))
    ) {
      throw invalid('Workset routing projection page is not canonical.');
    }
    if (lastNodeId !== undefined && compareText(lastNodeId, symbol.nodeId) >= 0) {
      throw invalid('Workset routing symbol pages are not in strict node-identity order.');
    }
    chainDigest = sha256HexSync(
      JSON.stringify(['threadnote-workset-routing-symbol-chain-link-v2', chainDigest, symbolDigestRecord(canonical)]),
    );
    lastNodeId = symbol.nodeId;
  }
  const symbolCount = state.symbolCount + symbols.length;
  if (!Number.isSafeInteger(symbolCount) || symbolCount > CODE_GRAPH_WORKSET_CATALOG_LIMITS.symbolsPerProjection) {
    throw invalid('Workset routing projection has too many symbols.');
  }
  return {chainDigest, ...(lastNodeId === undefined ? {} : {lastNodeId}), symbolCount};
}

export function codeGraphWorksetRoutingProjectionDigestComplete(
  input: Omit<CodeGraphWorksetRoutingProjectionReceiptV1, 'projectionDigest'>,
  state: CodeGraphWorksetRoutingProjectionDigestStateV1,
): string {
  const metadata = normalizeProjectionMetadata(input);
  assertSha256(state.chainDigest, 'projection symbol-chain digest');
  if (state.symbolCount !== metadata.symbolCount) {
    throw invalid('Workset routing projection symbol-chain count does not match its receipt.');
  }
  return sha256HexSync(
    JSON.stringify([
      'threadnote-workset-routing-projection-v2',
      metadata.repositoryId,
      metadata.checkoutId,
      metadata.worktreeId,
      metadata.snapshotId,
      metadata.snapshotDigest,
      metadata.commitId,
      metadata.extractorGeneration,
      metadata.projectorVersion,
      metadata.componentCount,
      metadata.symbolCount,
      state.chainDigest,
      ...worksetScopeDigestFields(metadata),
    ]),
  );
}

export function validateCodeGraphWorksetRoutingProjectionReceipt(
  input: CodeGraphWorksetRoutingProjectionReceiptV1,
): CodeGraphWorksetRoutingProjectionReceiptV1 {
  assertSha256(input.projectionDigest, 'projection digest');
  return {...normalizeProjectionMetadata(input), projectionDigest: input.projectionDigest};
}

export function codeGraphWorksetCatalogGenerationIdentity(
  input: CodeGraphWorksetCatalogGenerationInputV1,
): CodeGraphWorksetCatalogGenerationIdentityV1 {
  const worksetName = boundedText(input.worksetName, 'workset name', 256);
  assertSha256(input.manifestDigest, 'manifest digest');
  if (input.members.length > CODE_GRAPH_WORKSET_CATALOG_LIMITS.membersPerGeneration) {
    throw invalid('Workset catalog generation has too many members.');
  }
  const members = EffectArray.map(input.members, normalizeGenerationMember).sort(compareMember);
  const seenKeys = new Set<string>();
  for (const member of members) {
    if (seenKeys.has(member.repositoryKey)) {
      throw invalid(`Workset catalog repository key ${member.repositoryKey} is duplicated.`);
    }
    seenKeys.add(member.repositoryKey);
  }
  const digest = codeGraphWorksetCatalogGenerationDigest(
    worksetName,
    input.manifestDigest,
    EffectArray.map(members, member => ({
      ...normalizeWorksetScopeReceipt(member.projection),
      projectionDigest: member.projection.projectionDigest,
      repositoryId: member.projection.repositoryId,
      repositoryKey: member.repositoryKey,
      snapshotId: member.projection.snapshotId,
    })),
  );
  return {digest, id: `cgwg_${Effect.pipe(digest, EffectString.slice(0, 40))}`, members};
}

export function codeGraphWorksetCatalogGenerationDigest(
  worksetName: string,
  manifestDigest: string,
  members: readonly CodeGraphWorksetCatalogGenerationDigestMemberV1[],
): string {
  const normalizedName = boundedText(worksetName, 'workset name', 256);
  assertSha256(manifestDigest, 'manifest digest');
  if (members.length > CODE_GRAPH_WORKSET_CATALOG_LIMITS.membersPerGeneration) {
    throw invalid('Workset catalog generation has too many members.');
  }
  const normalizedMembers = EffectArray.map(members, normalizeGenerationDigestMember).sort(compareDigestMember);
  for (let index = 1; index < normalizedMembers.length; index += 1) {
    if (normalizedMembers[index - 1].repositoryKey === normalizedMembers[index].repositoryKey) {
      throw invalid(`Workset catalog repository key ${normalizedMembers[index].repositoryKey} is duplicated.`);
    }
  }
  return sha256HexSync(
    JSON.stringify([
      'threadnote-workset-catalog-generation-v1',
      normalizedName,
      manifestDigest,
      EffectArray.map(normalizedMembers, member => [
        member.repositoryKey,
        member.repositoryId,
        member.snapshotId,
        member.projectionDigest,
        ...worksetScopeDigestFields(member),
      ]),
    ]),
  );
}

export function codeGraphWorksetCatalogGenerationReceiptIdentity(
  input: CodeGraphWorksetCatalogGenerationReceiptInputV1,
): CodeGraphWorksetCatalogGenerationReceiptIdentityV1 {
  if (input.members.length > CODE_GRAPH_WORKSET_CATALOG_LIMITS.membersPerGeneration) {
    throw invalid('Workset catalog generation has too many members.');
  }
  const members = EffectArray.map(input.members, normalizeGenerationDigestMember).sort(compareDigestMember);
  const digest = codeGraphWorksetCatalogGenerationDigest(input.worksetName, input.manifestDigest, members);
  return {digest, id: `cgwg_${Effect.pipe(digest, EffectString.slice(0, 40))}`, members};
}

function normalizeGenerationMember(
  member: CodeGraphWorksetCatalogGenerationMemberV1,
): CodeGraphWorksetCatalogGenerationMemberV1 {
  return {
    projection: validateCodeGraphWorksetRoutingProjection(member.projection),
    repositoryKey: boundedText(member.repositoryKey, 'repository key', 512),
  };
}

function normalizeProjectionDraft(
  input: CodeGraphWorksetRoutingProjectionDraftV1,
): CodeGraphWorksetRoutingProjectionDraftV1 {
  assertSha256(input.repositoryId, 'repository identity');
  assertSha256(input.checkoutId, 'checkout identity');
  assertSha256(input.worktreeId, 'worktree identity');
  assertSha256(input.snapshotDigest, 'snapshot digest');
  if (!COMMIT_ID.test(input.commitId)) throw invalid('Workset projection commit identity is invalid.');
  const snapshotId = boundedText(input.snapshotId, 'snapshot identity', 256);
  if (!Number.isSafeInteger(input.extractorGeneration) || input.extractorGeneration < 1) {
    throw invalid('Workset projection extractor generation is invalid.');
  }
  if (input.projectorVersion !== CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION) {
    throw invalid('Workset routing projection version is incompatible.');
  }
  if (!Number.isSafeInteger(input.componentCount) || input.componentCount < 0) {
    throw invalid('Workset projection component count is invalid.');
  }
  if (input.symbols.length > CODE_GRAPH_WORKSET_CATALOG_LIMITS.symbolsPerProjection) {
    throw invalid('Workset routing projection has too many symbols.');
  }
  const symbols = EffectArray.map(input.symbols, normalizeCodeGraphWorksetRoutingSymbol).sort((left, right) =>
    compareText(left.nodeId, right.nodeId),
  );
  for (let index = 1; index < symbols.length; index += 1) {
    if (symbols[index - 1].nodeId === symbols[index].nodeId) {
      throw invalid(`Workset routing symbol ${symbols[index].nodeId} is duplicated.`);
    }
  }
  return {
    ...normalizeWorksetScopeReceipt(input),
    checkoutId: input.checkoutId,
    commitId: input.commitId,
    componentCount: input.componentCount,
    extractorGeneration: input.extractorGeneration,
    projectorVersion: input.projectorVersion,
    repositoryId: input.repositoryId,
    snapshotDigest: input.snapshotDigest,
    snapshotId,
    symbols,
    worktreeId: input.worktreeId,
  };
}

export function normalizeCodeGraphWorksetRoutingSymbol(
  symbol: CodeGraphWorksetRoutingSymbolV1,
): CodeGraphWorksetRoutingSymbolV1 {
  if (!NODE_ID.test(symbol.nodeId)) throw invalid('Workset routing node identity is invalid.');
  const path = repositoryRelativePath(symbol.path);
  const lookupKeys = [
    ...new Set(EffectArray.map(symbol.lookupKeys, key => boundedText(key, 'lookup key', 2_048))),
  ].sort(compareText);
  if (lookupKeys.length > CODE_GRAPH_WORKSET_CATALOG_LIMITS.lookupKeysPerSymbol) {
    throw invalid(`Workset routing symbol ${symbol.nodeId} has too many lookup keys.`);
  }
  const terms = new Map<string, number>();
  for (const candidate of symbol.terms) {
    const term = boundedText(candidate.term, 'routing term', 256);
    if (!Number.isFinite(candidate.weight) || candidate.weight <= 0 || candidate.weight > 1_000) {
      throw invalid(`Workset routing symbol ${symbol.nodeId} has an invalid term weight.`);
    }
    terms.set(term, Math.max(terms.get(term) ?? 0, candidate.weight));
  }
  if (terms.size > CODE_GRAPH_WORKSET_CATALOG_LIMITS.termsPerSymbol) {
    throw invalid(`Workset routing symbol ${symbol.nodeId} has too many routing terms.`);
  }
  const span = symbol.span;
  if (
    !EffectArray.every(
      [span.line, span.column, span.endLine, span.endColumn],
      value => Number.isSafeInteger(value) && value >= 0,
    ) ||
    span.endLine < span.line ||
    (span.endLine === span.line && span.endColumn < span.column)
  ) {
    throw invalid(`Workset routing symbol ${symbol.nodeId} has an invalid evidence span.`);
  }
  return {
    exported: symbol.exported,
    kind: boundedText(symbol.kind, 'symbol kind', 256),
    language: boundedText(symbol.language, 'symbol language', 256),
    lookupKeys,
    name: boundedText(symbol.name, 'symbol name', 2_048),
    nodeId: symbol.nodeId,
    ...(symbol.packageName === undefined ? {} : {packageName: boundedText(symbol.packageName, 'package name', 2_048)}),
    path,
    qualifiedName: boundedText(symbol.qualifiedName, 'qualified symbol name', 4_096),
    span: {...span},
    terms: EffectArray.map(
      [...terms].sort(([left], [right]) => compareText(left, right)),
      ([term, weight]) => ({term, weight}),
    ),
  };
}

function normalizeProjectionMetadata(
  input: Omit<CodeGraphWorksetRoutingProjectionReceiptV1, 'projectionDigest'>,
): Omit<CodeGraphWorksetRoutingProjectionReceiptV1, 'projectionDigest'> {
  const normalized = normalizeProjectionDraft({...input, symbols: []});
  if (
    !Number.isSafeInteger(input.symbolCount) ||
    input.symbolCount < 0 ||
    input.symbolCount > CODE_GRAPH_WORKSET_CATALOG_LIMITS.symbolsPerProjection
  ) {
    throw invalid('Workset routing projection symbol count is invalid.');
  }
  const {symbols: _symbols, ...metadata} = normalized;
  return {...metadata, symbolCount: input.symbolCount};
}

function symbolDigestRecord(symbol: CodeGraphWorksetRoutingSymbolV1): readonly unknown[] {
  return [
    symbol.nodeId,
    symbol.kind,
    symbol.language,
    symbol.exported ? 1 : 0,
    symbol.packageName ?? null,
    symbol.path,
    symbol.name,
    symbol.qualifiedName,
    symbol.span.line,
    symbol.span.column,
    symbol.span.endLine,
    symbol.span.endColumn,
    symbol.lookupKeys,
    EffectArray.map(symbol.terms, term => [term.term, term.weight]),
  ];
}

function repositoryRelativePath(value: string): string {
  const path = boundedText(value, 'evidence path', 4_096);
  if (
    Effect.pipe(path, EffectString.startsWith('/')) ||
    Effect.pipe(path, EffectString.includes('\\')) ||
    /^[A-Za-z]:/u.test(path) ||
    EffectArray.some(
      Effect.pipe(path, EffectString.split('/')),
      segment => segment === '' || segment === '.' || segment === '..',
    )
  ) {
    throw invalid('Workset routing evidence path must be repository-relative and slash-normalized.');
  }
  return path;
}

function assertSha256(value: string, label: string): void {
  if (!SHA256_HEX.test(value)) throw invalid(`Workset ${label} is invalid.`);
}

function boundedText(value: string, label: string, maximumBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    containsControlCharacter(value) ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    throw invalid(`Workset ${label} is invalid.`);
  }
  return value;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = Effect.pipe(
      character,
      EffectString.codePointAt(0),
      Effect.Option.getOrElse(() => undefined),
    )!;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function compareMember(
  left: CodeGraphWorksetCatalogGenerationMemberV1,
  right: CodeGraphWorksetCatalogGenerationMemberV1,
): number {
  return (
    compareText(left.repositoryKey, right.repositoryKey) ||
    compareText(left.projection.repositoryId, right.projection.repositoryId) ||
    compareText(left.projection.snapshotId, right.projection.snapshotId) ||
    compareText(left.projection.projectionDigest, right.projection.projectionDigest)
  );
}

function compareDigestMember(
  left: CodeGraphWorksetCatalogGenerationDigestMemberV1,
  right: CodeGraphWorksetCatalogGenerationDigestMemberV1,
): number {
  return (
    compareText(left.repositoryKey, right.repositoryKey) ||
    compareText(left.repositoryId, right.repositoryId) ||
    compareText(left.snapshotId, right.snapshotId) ||
    compareText(left.projectionDigest, right.projectionDigest)
  );
}

function normalizeGenerationDigestMember(
  member: CodeGraphWorksetCatalogGenerationDigestMemberV1,
): CodeGraphWorksetCatalogGenerationDigestMemberV1 {
  assertSha256(member.repositoryId, 'repository identity');
  assertSha256(member.projectionDigest, 'projection digest');
  return {
    ...normalizeWorksetScopeReceipt(member),
    projectionDigest: member.projectionDigest,
    repositoryId: member.repositoryId,
    repositoryKey: boundedText(member.repositoryKey, 'repository key', 512),
    snapshotId: boundedText(member.snapshotId, 'snapshot identity', 256),
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(message: string): CodeGraphWorksetCatalogError {
  return CodeGraphWorksetCatalogError.of('invalid-input', message);
}
