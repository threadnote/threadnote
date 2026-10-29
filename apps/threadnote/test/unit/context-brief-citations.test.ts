import {Array as EffectArray} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import fc from 'fast-check';
import {Effect, Layer} from 'effect';
import {describe, expect, it} from 'vitest';
import {
  aggregatePreciseStatus,
  cleanPublishedCatalogFenceMatches,
  cleanPublishedCatalogSnapshotMatches,
  cleanPublishedCitationFenceMatches,
  routeContextBriefWorksetValidation,
  validateContextBriefFileCitation,
  validateContextBriefSymbolCitation,
  type ContextBriefPreciseEvidenceStatus,
} from '@threadnote/threadnote/context_brief/index';
import {createCodeGraphSourceSpanCanonicalizer} from '@threadnote/graph/citation/primitives';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import type {
  CodeGraphInventoryFile,
  CodeGraphSnapshot,
  CodeGraphStatus,
  CodeGraphSymbol,
} from '@threadnote/graph/types';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {codeGraphWorksetManifestDigest} from '@threadnote/graph/workset_catalog/workset';
import type {CodeGraphWorksetCatalogPublishedMemberV1} from '@threadnote/graph/workset_catalog/types';

import type {ResolvedWorkset} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const SOURCE_HASH = Effect2.pipe('a', EffectString.repeat(64));
const CHANGED_HASH = Effect2.pipe('b', EffectString.repeat(64));
const OBSERVED_AT = '2026-08-26T00:00:00.000Z';
const citation = createMemoryCodeCitation({
  extractorSet: 'native-code-graph-13',
  fileContentHash: {algorithm: 'sha256', value: SOURCE_HASH},
  path: 'src/original.ts',
  repositoryId: Effect2.pipe('c', EffectString.repeat(64)),
  repositoryIdentityKind: 'remote',
  sourceCommit: Effect2.pipe('d', EffectString.repeat(40)),
  sourceDirty: false,
  sourceSnapshotId: `cgsn_${Effect2.pipe('e', EffectString.repeat(40))}`,
  target: {kind: 'file'},
  version: 1,
});
const snapshot: CodeGraphSnapshot = {
  commit: Effect2.pipe('f', EffectString.repeat(40)),
  dirty: false,
  edgeCount: 0,
  extractorSet: 'native-code-graph-13',
  fileCount: 1,
  id: `cgsn_${Effect2.pipe('1', EffectString.repeat(40))}`,
  repositoryId: citation.repositoryId,
  state: 'ready',
  symbolCount: 0,
  worktreeId: Effect2.pipe('2', EffectString.repeat(64)),
};
const published: CodeGraphWorksetCatalogPublishedMemberV1 = {
  checkoutId: Effect2.pipe('3', EffectString.repeat(64)),
  commitId: snapshot.commit,
  ordinal: 0,
  projectionDigest: Effect2.pipe('4', EffectString.repeat(64)),
  repositoryId: snapshot.repositoryId,
  repositoryKey: 'threadnote',
  snapshotDigest: Effect2.pipe('5', EffectString.repeat(64)),
  snapshotId: snapshot.id,
  symbolCount: snapshot.symbolCount,
  worktreeId: snapshot.worktreeId,
};

describe('Context Brief code-citation classification', () => {
  it('accepts a clean published fence only while every code-bearing identity stays exact', () => {
    const before: CodeGraphStatus = {
      databasePath: '/threadnote/graph.sqlite',
      freshness: 'current',
      identity: {
        caseMode: 'sensitive',
        checkoutId: 'checkout',
        displayName: 'example/threadnote',
        gitCommonDirectory: '/work/.git',
        headCommit: snapshot.commit,
        objectFormat: 'sha1',
        remoteIdentity: 'https://github.com/example/threadnote.git',
        repoRoot: '/work',
        repositoryId: snapshot.repositoryId,
        worktreeId: snapshot.worktreeId,
      },
      languagePacks: [],
      readySnapshot: snapshot,
      stale: false,
    };
    const clean = {dirty: false as const, fingerprint: undefined};
    expect(cleanPublishedCitationFenceMatches(before, before.identity, clean, snapshot)).toBe(true);

    fc.assert(
      fc.property(
        fc.constantFrom(
          'checkout',
          'repository',
          'worktree',
          'head',
          'dirty',
          'snapshot',
          'commit',
          'snapshot-repository',
          'snapshot-worktree',
        ),
        mutation => {
          const identity = {
            ...before.identity,
            ...(mutation === 'checkout' ? {checkoutId: 'changed-checkout'} : {}),
            ...(mutation === 'repository' ? {repositoryId: Effect2.pipe('9', EffectString.repeat(64))} : {}),
            ...(mutation === 'worktree' ? {worktreeId: 'changed-worktree'} : {}),
            ...(mutation === 'head' ? {headCommit: Effect2.pipe('9', EffectString.repeat(40))} : {}),
          };
          const overlay = mutation === 'dirty' ? undefined : clean;
          const active = {
            ...snapshot,
            ...(mutation === 'snapshot' ? {id: `cgsn_${Effect2.pipe('9', EffectString.repeat(40))}`} : {}),
            ...(mutation === 'commit' ? {commit: Effect2.pipe('9', EffectString.repeat(40))} : {}),
            ...(mutation === 'snapshot-repository' ? {repositoryId: Effect2.pipe('9', EffectString.repeat(64))} : {}),
            ...(mutation === 'snapshot-worktree' ? {worktreeId: 'changed-worktree'} : {}),
          };
          expect(cleanPublishedCitationFenceMatches(before, identity, overlay, active)).toBe(false);
        },
      ),
      {numRuns: 100},
    );
  });

  it('rejects every mutated catalog-first snapshot or final-fence component', () => {
    const identity = {
      checkoutId: published.checkoutId,
      headCommit: published.commitId,
      repositoryId: published.repositoryId,
      worktreeId: published.worktreeId,
    };
    expect(cleanPublishedCatalogSnapshotMatches(published, snapshot)).toBe(true);
    expect(
      cleanPublishedCatalogFenceMatches(published, snapshot, identity, {
        ...snapshot,
        worktreeId: Effect2.pipe('shared-clean-row', EffectString.padEnd(64, '0')),
      }),
    ).toBe(true);

    const mutations = [
      'selected-id',
      'selected-repository',
      'selected-commit',
      'selected-symbols',
      'selected-dirty',
      'selected-state',
      'identity-checkout',
      'identity-repository',
      'identity-worktree',
      'identity-head',
      'active-id',
      'active-repository',
      'active-commit',
      'active-symbols',
      'active-extractor',
      'active-content',
      'active-base',
      'active-files',
      'active-edges',
      'active-overlay',
      'active-dirty',
      'active-state',
    ] as const;
    for (const mutation of mutations) {
      const selected: CodeGraphSnapshot = {
        ...snapshot,
        ...(mutation === 'selected-id' ? {id: `cgsn_${Effect2.pipe('9', EffectString.repeat(40))}`} : {}),
        ...(mutation === 'selected-repository' ? {repositoryId: Effect2.pipe('9', EffectString.repeat(64))} : {}),
        ...(mutation === 'selected-commit' ? {commit: Effect2.pipe('9', EffectString.repeat(40))} : {}),
        ...(mutation === 'selected-symbols' ? {symbolCount: snapshot.symbolCount + 1} : {}),
        ...(mutation === 'selected-dirty' ? {dirty: true} : {}),
        ...(mutation === 'selected-state' ? {state: 'retired' as const} : {}),
      };
      const observedIdentity = {
        ...identity,
        ...(mutation === 'identity-checkout' ? {checkoutId: Effect2.pipe('9', EffectString.repeat(64))} : {}),
        ...(mutation === 'identity-repository' ? {repositoryId: Effect2.pipe('9', EffectString.repeat(64))} : {}),
        ...(mutation === 'identity-worktree' ? {worktreeId: Effect2.pipe('9', EffectString.repeat(64))} : {}),
        ...(mutation === 'identity-head' ? {headCommit: Effect2.pipe('9', EffectString.repeat(40))} : {}),
      };
      const active: CodeGraphSnapshot = {
        ...snapshot,
        ...(mutation === 'active-id' ? {id: `cgsn_${Effect2.pipe('9', EffectString.repeat(40))}`} : {}),
        ...(mutation === 'active-repository' ? {repositoryId: Effect2.pipe('9', EffectString.repeat(64))} : {}),
        ...(mutation === 'active-commit' ? {commit: Effect2.pipe('9', EffectString.repeat(40))} : {}),
        ...(mutation === 'active-symbols' ? {symbolCount: snapshot.symbolCount + 1} : {}),
        ...(mutation === 'active-extractor' ? {extractorSet: 'changed-extractor'} : {}),
        ...(mutation === 'active-content' ? {graphContentId: `cgc_${Effect2.pipe('9', EffectString.repeat(40))}`} : {}),
        ...(mutation === 'active-base' ? {baseSnapshotId: `cgsn_${Effect2.pipe('9', EffectString.repeat(40))}`} : {}),
        ...(mutation === 'active-files' ? {fileCount: snapshot.fileCount + 1} : {}),
        ...(mutation === 'active-edges' ? {edgeCount: snapshot.edgeCount + 1} : {}),
        ...(mutation === 'active-overlay' ? {overlayFingerprint: 'changed-overlay'} : {}),
        ...(mutation === 'active-dirty' ? {dirty: true} : {}),
        ...(mutation === 'active-state' ? {state: 'retired' as const} : {}),
      };
      expect(cleanPublishedCatalogFenceMatches(published, selected, observedIdentity, active)).toBe(false);
    }
  });

  it('classifies exact and relocated file evidence while abstaining on incomplete or ambiguous absence', () => {
    expect(
      validateContextBriefFileCitation(
        citation,
        {file: file(citation.path, SOURCE_HASH), path: citation.path},
        {contentHash: SOURCE_HASH, files: [file(citation.path, SOURCE_HASH)], truncated: false},
        snapshot,
        OBSERVED_AT,
      ).status,
    ).toBe('exact');
    expect(
      validateContextBriefFileCitation(
        citation,
        {path: citation.path},
        {contentHash: SOURCE_HASH, files: [file('src/moved.ts', SOURCE_HASH)], truncated: false},
        snapshot,
        OBSERVED_AT,
      ),
    ).toMatchObject({observedPath: 'src/moved.ts', status: 'relocated'});
    expect(
      validateContextBriefFileCitation(
        citation,
        {path: citation.path},
        {contentHash: SOURCE_HASH, files: [], truncated: false},
        snapshot,
        OBSERVED_AT,
      ),
    ).toMatchObject({coverage: 'incomplete', reason: 'graph-incomplete', status: 'unknown'});
    expect(
      validateContextBriefFileCitation(
        citation,
        {path: citation.path},
        {
          contentHash: SOURCE_HASH,
          files: [file('src/a.ts', SOURCE_HASH), file('src/b.ts', SOURCE_HASH)],
          truncated: false,
        },
        snapshot,
        OBSERVED_AT,
      ).status,
    ).toBe('unknown');
  });

  it('never rescues an occupied changed locator with an unchanged copy elsewhere', () => {
    expect(
      validateContextBriefFileCitation(
        citation,
        {file: file(citation.path, CHANGED_HASH), path: citation.path},
        {contentHash: SOURCE_HASH, files: [file('src/copy.ts', SOURCE_HASH)], truncated: false},
        snapshot,
        OBSERVED_AT,
      ),
    ).toMatchObject({observedPath: citation.path, reason: 'source-changed', status: 'changed'});
  });

  it('emits deleted only when the snapshot proves complete repository-file coverage', () => {
    expect(
      validateContextBriefFileCitation(
        citation,
        {path: citation.path},
        {contentHash: SOURCE_HASH, files: [], truncated: false},
        snapshot,
        OBSERVED_AT,
        'complete',
      ),
    ).toMatchObject({coverage: 'current-complete', reason: 'source-deleted', status: 'deleted'});
  });

  it('aggregates without ever making changed, deleted, or unknown evidence fresh', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<ContextBriefPreciseEvidenceStatus>('exact', 'relocated'), {
          maxLength: 7,
        }),
        fc.constantFrom<ContextBriefPreciseEvidenceStatus>('changed', 'deleted', 'unknown'),
        (safe, unsafe) => {
          const aggregate = aggregatePreciseStatus(EffectArray.map([...safe, unsafe], status => ({status})));
          expect(aggregate).toBe(unsafe);
        },
      ),
      {numRuns: 100},
    );
  });

  effectIt.effect('marks a same-path symbol span move as relocated when its cited fragment survives', () => {
    const source = 'export function target() {}\n';
    const movedSource = `\n${source}`;
    const cited = symbolCitation(source);
    const current = symbol({
      contentHash: sha256HexSync(movedSource),
      id: cited.target.kind === 'symbol' ? cited.target.nodeId : '',
      path: cited.path,
      span: {column: 1, endColumn: Effect2.pipe(source, EffectString.trimEnd).length + 1, endLine: 2, line: 2},
    });

    return validateContextBriefSymbolCitation(
      cited,
      current,
      undefined,
      {file: file(cited.path, current.contentHash), path: cited.path},
      undefined,
      snapshot,
      () => Effect.succeed(createCodeGraphSourceSpanCanonicalizer(movedSource)),
      OBSERVED_AT,
    ).pipe(
      Effect.tap(receipt =>
        Effect.sync(() =>
          expect(receipt).toMatchObject({
            observedNodeId: current.id,
            observedSpan: current.span,
            status: 'relocated',
            strategy: 'node-id',
          }),
        ),
      ),
      provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer)),
    );
  });

  effectIt.effect('uses unknown instead of deletion when exact file bytes survive degraded symbol extraction', () => {
    const source = 'export function target() {}\n';
    const cited = symbolCitation(source);
    return validateContextBriefSymbolCitation(
      cited,
      undefined,
      undefined,
      {file: file(cited.path, cited.fileContentHash.value), path: cited.path},
      {
        contentHash: cited.fileContentHash.value,
        files: [file(cited.path, cited.fileContentHash.value)],
        truncated: false,
      },
      snapshot,
      () => Effect.die(new Error('source should not be read without a symbol candidate')),
      OBSERVED_AT,
    ).pipe(
      Effect.tap(receipt =>
        Effect.sync(() => expect(receipt).toMatchObject({reason: 'graph-incomplete', status: 'unknown'})),
      ),
      provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer)),
    );
  });

  effectIt.effect('abstains when a semantic locator has two candidates even if one fragment matches', () => {
    const source = 'export function target() {}\n';
    const cited = symbolCitation(source);
    const matching = symbol({
      contentHash: cited.fileContentHash.value,
      id: `cgs_${Effect2.pipe('7', EffectString.repeat(32))}`,
      path: 'src/moved.ts',
    });
    const unread = symbol({
      contentHash: Effect2.pipe('8', EffectString.repeat(64)),
      id: `cgs_${Effect2.pipe('9', EffectString.repeat(32))}`,
      path: 'src/unread.ts',
    });
    const locator = {
      kind: matching.kind,
      language: matching.language,
      name: matching.name,
      qualifiedName: matching.qualifiedName,
      version: 1 as const,
    };
    return validateContextBriefSymbolCitation(
      cited,
      undefined,
      {locator, symbols: [matching, unread], truncated: false},
      {path: cited.path},
      {contentHash: cited.fileContentHash.value, files: [file(matching.path, matching.contentHash)], truncated: false},
      snapshot,
      repositoryPath =>
        repositoryPath === unread.path
          ? Effect.fail('unread-candidate' as const)
          : Effect.succeed(createCodeGraphSourceSpanCanonicalizer(source)),
      OBSERVED_AT,
    ).pipe(
      Effect.tap(receipt =>
        Effect.sync(() => expect(receipt).toMatchObject({reason: 'ambiguous-relocation', status: 'unknown'})),
      ),
      provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer)),
    );
  });

  effectIt.effect('abstains on duplicate semantic candidates even when the old source path is occupied', () => {
    const source = 'export function target() {}\n';
    const cited = symbolCitation(source);
    const first = symbol({
      contentHash: cited.fileContentHash.value,
      id: `cgs_${Effect2.pipe('7', EffectString.repeat(32))}`,
      path: 'src/a.ts',
    });
    const second = symbol({
      contentHash: cited.fileContentHash.value,
      id: `cgs_${Effect2.pipe('8', EffectString.repeat(32))}`,
      path: 'src/b.ts',
    });
    const locator = {
      kind: first.kind,
      language: first.language,
      name: first.name,
      qualifiedName: first.qualifiedName,
      version: 1 as const,
    };
    return validateContextBriefSymbolCitation(
      cited,
      undefined,
      {locator, symbols: [first, second], truncated: false},
      {file: file(cited.path, CHANGED_HASH), path: cited.path},
      {contentHash: cited.fileContentHash.value, files: [file(first.path, first.contentHash)], truncated: true},
      snapshot,
      () => Effect.die(new Error('ambiguous candidates must not be inspected')),
      OBSERVED_AT,
    ).pipe(
      Effect.tap(receipt =>
        Effect.sync(() => expect(receipt).toMatchObject({reason: 'ambiguous-relocation', status: 'unknown'})),
      ),
      provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer)),
    );
  });

  effectIt.effect('accepts a unique symbol relocation when an unrelated file reuses the old path', () => {
    const source = 'export function target() {}\n';
    const cited = symbolCitation(source);
    const moved = symbol({
      contentHash: cited.fileContentHash.value,
      id: `cgs_${Effect2.pipe('7', EffectString.repeat(32))}`,
      path: 'src/moved.ts',
    });
    const locator = {
      kind: moved.kind,
      language: moved.language,
      name: moved.name,
      qualifiedName: moved.qualifiedName,
      version: 1 as const,
    };
    return validateContextBriefSymbolCitation(
      cited,
      undefined,
      {locator, symbols: [moved], truncated: false},
      {file: file(cited.path, CHANGED_HASH), path: cited.path},
      {contentHash: cited.fileContentHash.value, files: [file(moved.path, moved.contentHash)], truncated: false},
      snapshot,
      () => Effect.succeed(createCodeGraphSourceSpanCanonicalizer(source)),
      OBSERVED_AT,
    ).pipe(
      Effect.tap(receipt =>
        Effect.sync(() =>
          expect(receipt).toMatchObject({observedNodeId: moved.id, reason: 'relocated', status: 'relocated'}),
        ),
      ),
      provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer)),
    );
  });

  effectIt.effect('keeps an original changed symbol authoritative over an unchanged duplicate', () => {
    const source = 'export function target() {}\n';
    const changedSource = 'export function target() { return 1; }\n';
    const cited = symbolCitation(source);
    const original = symbol({
      contentHash: sha256HexSync(changedSource),
      id: `cgs_${Effect2.pipe('7', EffectString.repeat(32))}`,
      path: cited.path,
      span: cited.target.kind === 'symbol' ? cited.target.span : undefined,
    });
    const copy = symbol({
      contentHash: cited.fileContentHash.value,
      id: `cgs_${Effect2.pipe('8', EffectString.repeat(32))}`,
      path: 'src/copy.ts',
    });
    const locator = {
      kind: original.kind,
      language: original.language,
      name: original.name,
      qualifiedName: original.qualifiedName,
      version: 1 as const,
    };
    return validateContextBriefSymbolCitation(
      cited,
      undefined,
      {locator, symbols: [original, copy], truncated: false},
      {file: file(cited.path, original.contentHash), path: cited.path},
      {contentHash: cited.fileContentHash.value, files: [file(copy.path, copy.contentHash)], truncated: false},
      snapshot,
      repositoryPath =>
        Effect.succeed(createCodeGraphSourceSpanCanonicalizer(repositoryPath === cited.path ? changedSource : source)),
      OBSERVED_AT,
    ).pipe(
      Effect.tap(receipt =>
        Effect.sync(() =>
          expect(receipt).toMatchObject({observedNodeId: original.id, reason: 'source-changed', status: 'changed'}),
        ),
      ),
      provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer)),
    );
  });

  effectIt.effect('abstains when changed file bytes have no symbol evidence after parser degradation', () => {
    const source = 'export function target() {}\n';
    const cited = symbolCitation(source);
    return validateContextBriefSymbolCitation(
      cited,
      undefined,
      undefined,
      {file: file(cited.path, CHANGED_HASH), path: cited.path},
      {contentHash: cited.fileContentHash.value, files: [], truncated: false},
      snapshot,
      () => Effect.die(new Error('source should not be read without a symbol candidate')),
      OBSERVED_AT,
    ).pipe(
      Effect.tap(receipt =>
        Effect.sync(() => expect(receipt).toMatchObject({reason: 'graph-incomplete', status: 'unknown'})),
      ),
      provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer)),
    );
  });

  effectIt.effect('emits symbol deletion only under complete file-inventory coverage', () => {
    const source = 'export function target() {}\n';
    const cited = symbolCitation(source);
    return validateContextBriefSymbolCitation(
      cited,
      undefined,
      undefined,
      {path: cited.path},
      {contentHash: cited.fileContentHash.value, files: [], truncated: false},
      snapshot,
      () => Effect.die(new Error('source should not be read without a symbol candidate')),
      OBSERVED_AT,
      'complete',
    ).pipe(
      Effect.tap(receipt =>
        Effect.sync(() =>
          expect(receipt).toMatchObject({coverage: 'current-complete', reason: 'source-deleted', status: 'deleted'}),
        ),
      ),
      provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer)),
    );
  });

  effectIt.effect('rejects an exact node whose semantic locator disagrees with the citation', () => {
    const source = 'export function target() {}\n';
    const forged = symbolCitation(source, {name: 'forged', qualifiedName: 'forged'});
    const current = symbol({
      contentHash: forged.fileContentHash.value,
      id: forged.target.kind === 'symbol' ? forged.target.nodeId : '',
      path: forged.path,
    });
    return validateContextBriefSymbolCitation(
      forged,
      current,
      undefined,
      {file: file(forged.path, forged.fileContentHash.value), path: forged.path},
      undefined,
      snapshot,
      () => Effect.succeed(createCodeGraphSourceSpanCanonicalizer(source)),
      OBSERVED_AT,
    ).pipe(
      Effect.tap(receipt =>
        Effect.sync(() => expect(receipt).toMatchObject({reason: 'validation-error', status: 'unknown'})),
      ),
      provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer)),
    );
  });

  it('routes a 128-member workset to at most the 32 cited repositories before status probes', () => {
    const projects = Array.from({length: 128}, (_, index) => ({
      name: `project-${index}`,
      path: `/work/project-${index}`,
      seed: [],
      uri: `threadnote://projects/project-${index}`,
    }));
    const workset: ResolvedWorkset = {name: 'large', projects, unresolvedProjects: []};
    const repositoryIds = EffectArray.map(projects, (_, index) =>
      Effect2.pipe(index.toString(16), EffectString.padStart(64, '0')),
    );
    const admitted = new Set(repositoryIds.slice(0, 32));
    const published = {
      digest: 'generation',
      id: 'generation-id',
      manifestDigest: codeGraphWorksetManifestDigest(workset),
      members: EffectArray.map(projects, (project, index) => ({
        checkoutId: `checkout-${index}`,
        commitId: Effect2.pipe('a', EffectString.repeat(40)),
        ordinal: index,
        projectionDigest: `projection-${index}`,
        repositoryId: repositoryIds[index],
        repositoryKey: project.name,
        snapshotDigest: `snapshot-digest-${index}`,
        snapshotId: `cgsn_${Effect2.pipe(index.toString(16), EffectString.padStart(40, '0'))}`,
        symbolCount: 1,
        worktreeId: Effect2.pipe(index.toString(16), EffectString.padStart(64, 'f')),
      })),
      worksetName: workset.name,
    } as const;
    const route = routeContextBriefWorksetValidation(workset, published, admitted);

    expect(route.stale).toBe(false);
    expect(route.ambiguousRepositoryIds.size).toBe(0);
    expect(route.members).toHaveLength(32);
    expect(new Set(EffectArray.map(route.members, member => member.published.repositoryId))).toEqual(admitted);
    expect(
      routeContextBriefWorksetValidation(workset, published, admitted, {
        digest: 'different-generation',
        id: 'different-generation-id',
      }),
    ).toMatchObject({members: [], stale: true});
  });
});

function file(path: string, contentHash: string): CodeGraphInventoryFile {
  return {
    blobId: `snapshot:${contentHash}`,
    contentHash,
    language: 'typescript',
    mode: '100644',
    path,
    size: 12,
    source: 'commit',
  };
}

function symbolCitation(
  source: string,
  overrides: Partial<Extract<ReturnType<typeof createMemoryCodeCitation>['target'], {readonly kind: 'symbol'}>> = {},
) {
  const text = Effect2.pipe(source, EffectString.trimEnd);
  const result = createMemoryCodeCitation({
    extractorSet: snapshot.extractorSet,
    fileContentHash: {algorithm: 'sha256', value: sha256HexSync(source)},
    path: 'src/original.ts',
    repositoryId: snapshot.repositoryId,
    repositoryIdentityKind: 'remote',
    sourceCommit: citation.sourceCommit,
    sourceDirty: false,
    sourceSnapshotId: citation.sourceSnapshotId,
    target: {
      fragmentCanonicalization: 'utf8-source-span-v1',
      fragmentHash: {algorithm: 'sha256', value: sha256HexSync(text)},
      kind: 'symbol',
      language: 'typescript',
      name: 'target',
      nodeId: `cgs_${Effect2.pipe('6', EffectString.repeat(32))}`,
      qualifiedName: 'target',
      signatureHash: {algorithm: 'sha256', value: sha256HexSync('export function target(): void')},
      span: {column: 1, endColumn: text.length + 1, endLine: 1, line: 1},
      symbolKind: 'function',
      ...overrides,
    },
    version: 1,
  });
  if (result.target.kind !== 'symbol') throw new Error('Expected a symbol citation.');
  return {...result, target: result.target};
}

function symbol(
  overrides: Partial<CodeGraphSymbol> & Pick<CodeGraphSymbol, 'contentHash' | 'id' | 'path'>,
): CodeGraphSymbol {
  return {
    ...overrides,
    contentHash: overrides.contentHash,
    exported: true,
    id: overrides.id,
    kind: 'function',
    language: 'typescript',
    name: 'target',
    path: overrides.path,
    qualifiedName: 'target',
    signature: 'export function target(): void',
    span: overrides.span ?? {column: 1, endColumn: 'export function target() {}'.length + 1, endLine: 1, line: 1},
  };
}
