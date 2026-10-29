import {Array as EffectArray, Option as EffectOption} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {createResolutionAttributor} from '@threadnote/graph/extractor';
import {hasSameCodeGraphResolutionSurface} from '@threadnote/graph/indexer';
import {sameEffectiveCodeGraphInventory} from '@threadnote/graph/indexer/shared';
import {
  assessCodeGraphResolutionSymbolPublication,
  hasSameCodeGraphReexportResolutionSurface,
} from '@threadnote/graph/resolution/surface';
import type {
  CodeGraphFileFacts,
  CodeGraphInventoryFile,
  CodeGraphReference,
  CodeGraphSymbol,
} from '@threadnote/graph/types';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const optionalText = FC.oneof(FC.constant(undefined), FC.string({maxLength: 24}));
const optionalArity = FC.oneof(FC.constant(undefined), FC.integer({max: 32, min: 0}));

const staticReexportReferenceArbitrary = FC.record({
  aliasIds: FC.uniqueArray(FC.integer({max: 1_000, min: 0}), {maxLength: 5, minLength: 1}),
  edgeId: FC.integer({max: 1_000_000, min: 0}),
  line: FC.integer({max: 500, min: 1}),
  sourceId: FC.integer({max: 1_000_000, min: 0}),
  tierIds: FC.array(FC.uniqueArray(FC.integer({max: 1_000, min: 0}), {maxLength: 5}), {
    maxLength: 4,
    minLength: 1,
  }),
}).map(({aliasIds, edgeId, line, sourceId, tierIds}): CodeGraphReference => ({
  aliasLookupKeys: EffectArray.map(aliasIds, id => `typescript:scope:path:src/index.ts:name:alias${id}`),
  edgeId: `edge-${edgeId}`,
  evidencePath: 'src/index.ts',
  evidenceSpan: {column: 1, endColumn: 2, endLine: line, line},
  exportedOnly: true,
  lookupTiers: EffectArray.map(tierIds, ids =>
    EffectArray.map(ids, id => `typescript:scope:path:src/source.ts:name:value${id}`),
  ),
  provenance: 'syntactic',
  relation: 'reexports',
  resolutionDomain: 'typescript',
  sourceId: `source-${sourceId}`,
  sourceName: 'index',
  targetName: './source.js',
}));

const symbolArbitrary = FC.record({
  arity: optionalArity,
  contentHash: FC.string({maxLength: 24}),
  documentation: optionalText,
  exported: FC.boolean(),
  id: FC.string({maxLength: 24}),
  kind: FC.string({maxLength: 24}),
  language: FC.string({maxLength: 24}),
  lookupKeys: FC.array(FC.string({maxLength: 24}), {maxLength: 6}),
  name: FC.string({maxLength: 24}),
  packageName: optionalText,
  path: FC.string({maxLength: 48}),
  qualifiedName: FC.string({maxLength: 48}),
  resolutionDomain: optionalText,
  resolutionScopeId: optionalText,
  signature: optionalText,
  span: FC.record({
    column: FC.integer({max: 500, min: 1}),
    endColumn: FC.integer({max: 500, min: 1}),
    endLine: FC.integer({max: 500, min: 1}),
    line: FC.integer({max: 500, min: 1}),
  }),
}).map(
  value =>
    ({
      ...(value.arity === undefined ? {} : {arity: value.arity}),
      contentHash: value.contentHash,
      ...(value.documentation === undefined ? {} : {documentation: value.documentation}),
      exported: value.exported,
      id: value.id,
      kind: value.kind,
      language: value.language,
      lookupKeys: value.lookupKeys,
      name: value.name,
      ...(value.packageName === undefined ? {} : {packageName: value.packageName}),
      path: value.path,
      qualifiedName: value.qualifiedName,
      ...(value.resolutionDomain === undefined ? {} : {resolutionDomain: value.resolutionDomain}),
      ...(value.resolutionScopeId === undefined ? {} : {resolutionScopeId: value.resolutionScopeId}),
      ...(value.signature === undefined ? {} : {signature: value.signature}),
      span: value.span,
    }) satisfies CodeGraphSymbol,
);

const publishedSymbolArbitrary = symbolArbitrary.map(
  symbol =>
    ({
      ...symbol,
      exported: true,
      id: `published:${symbol.id}`,
      lookupKeys: [...(symbol.lookupKeys ?? []), `global:name:${encodeURIComponent(symbol.name)}`],
    }) satisfies CodeGraphSymbol,
);

const typescriptPathArbitrary = FC.tuple(
  FC.constantFrom('src/private.ts', 'test/callback.spec.ts', 'packages/with space/file:name.ts'),
  FC.integer({max: 10_000, min: 0}),
).map(([path, suffix]) => `${Effect.pipe(path, EffectString.replace(/\.ts$/, ''))}-${suffix}.ts`);

const resolutionScopeIdArbitrary = FC.oneof(
  FC.constant(undefined),
  FC.integer({max: 10_000, min: 0}).map(suffix => `project-${suffix}`),
);

const effectiveInventoryArbitrary = FC.uniqueArray(
  FC.record({
    contentHash: FC.string({maxLength: 64}),
    language: FC.string({maxLength: 16}),
    mode: FC.string({maxLength: 8}),
    ordinal: FC.integer({max: 10_000, min: 0}),
    size: FC.integer({max: 10_000_000, min: 0}),
  }),
  {maxLength: 24, minLength: 1, selector: value => value.ordinal},
).map(values =>
  EffectArray.map(values, (value): CodeGraphInventoryFile => ({
    blobId: `blob-${value.ordinal}`,
    contentHash: value.contentHash,
    language: value.language,
    mode: value.mode,
    path: `src/file-${value.ordinal}.ts`,
    size: value.size,
    source: 'worktree',
  })).sort((left, right) => Effect.pipe(left.path, EffectString.localeCompare(right.path))),
);

const pathLocalTypeScriptSymbolArbitrary = FC.record({
  arity: optionalArity,
  path: typescriptPathArbitrary,
  resolutionScopeId: resolutionScopeIdArbitrary,
  suffix: FC.integer({max: 10_000, min: 0}),
}).map(({arity, path, resolutionScopeId, suffix}) => {
  const name = `privateMethod${suffix}`;
  const qualifiedName = `Fixture.${name}`;
  const ownPathLookupKeys = typescriptPathLocalLookupKeys(path, name, qualifiedName, resolutionScopeId, arity);
  return {
    ...(arity === undefined ? {} : {arity}),
    contentHash: `content-${suffix}`,
    exported: false,
    id: `local:${path}:${suffix}`,
    kind: 'method',
    language: 'typescript',
    lookupKeys: ownPathLookupKeys,
    name,
    path,
    qualifiedName,
    resolutionDomain: 'typescript',
    ...(resolutionScopeId === undefined ? {} : {resolutionScopeId}),
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
  } satisfies CodeGraphSymbol;
});

describe('code graph incremental-overlay properties', () => {
  fcProp(
    it,
    'treats commit provenance as irrelevant only while the effective inventory stays exact',
    {files: effectiveInventoryArbitrary},
    ({files}) => {
      const committed = EffectArray.map(files, (file, index): CodeGraphInventoryFile => ({
        ...file,
        blobId: `committed-${index}`,
        rawContentHash: `raw-${index}`,
        source: 'commit',
      }));
      expect(sameEffectiveCodeGraphInventory(files, committed)).toBe(true);
      expect(sameEffectiveCodeGraphInventory(committed, files)).toBe(true);

      const [first, ...rest] = committed;
      const mutations: readonly CodeGraphInventoryFile[][] = [
        [{...first, contentHash: `changed:${first.contentHash}`}, ...rest],
        [{...first, language: `changed:${first.language}`}, ...rest],
        [{...first, mode: `changed:${first.mode}`}, ...rest],
        [{...first, path: `changed/${first.path}`}, ...rest],
        [{...first, size: first.size + 1}, ...rest],
        committed.slice(1),
        [first, first, ...rest],
      ];
      expect(EffectArray.every(mutations, mutated => !sameEffectiveCodeGraphInventory(files, mutated))).toBe(true);
      if (files.length > 1) expect(sameEffectiveCodeGraphInventory(files, [...committed].reverse())).toBe(false);
    },
    {fastCheck: {numRuns: 200}},
  );

  fcProp(
    it,
    'treats only span, reference order, and set-order churn as an unchanged static re-export surface',
    {reference: staticReexportReferenceArbitrary},
    ({reference}) => {
      const peer: CodeGraphReference = {
        ...reference,
        edgeId: `peer:${reference.edgeId}`,
        sourceId: `peer:${reference.sourceId ?? ''}`,
      };
      const spanOnly: CodeGraphReference = {
        ...reference,
        evidenceSpan: {
          column: reference.evidenceSpan.column + 3,
          endColumn: reference.evidenceSpan.endColumn + 3,
          endLine: reference.evidenceSpan.endLine + 7,
          line: reference.evidenceSpan.line + 7,
        },
      };
      const reorderedSets: CodeGraphReference = {
        ...spanOnly,
        aliasLookupKeys: [...reference.aliasLookupKeys!, ...reference.aliasLookupKeys!].reverse(),
        lookupTiers: EffectArray.map(reference.lookupTiers, tier => [...tier, ...tier].reverse()),
      };

      expect(hasSameCodeGraphReexportResolutionSurface([reference], [reference])).toBe(true);
      expect(hasSameCodeGraphReexportResolutionSurface([reference], [reorderedSets])).toBe(true);
      expect(hasSameCodeGraphReexportResolutionSurface([reference, peer], [peer, spanOnly])).toBe(true);
      expect(hasSameCodeGraphReexportResolutionSurface([reorderedSets], [reference])).toBe(true);
      const orderedTiers: CodeGraphReference = {...reference, lookupTiers: [['first'], ['second']]};
      expect(
        hasSameCodeGraphReexportResolutionSurface(
          [orderedTiers],
          [{...orderedTiers, lookupTiers: [['second'], ['first']]}],
        ),
      ).toBe(false);
    },
    {fastCheck: {numRuns: 200}},
  );

  fcProp(
    it,
    'fails closed for every changed or unsupported re-export resolver surface',
    {reference: staticReexportReferenceArbitrary},
    ({reference}) => {
      const changedTier = EffectArray.map(reference.lookupTiers, (tier, index) =>
        index === 0 ? [...tier, '__changed_target__'] : tier,
      );
      const mutations: readonly CodeGraphReference[] = [
        {...reference, aliasLookupKeys: [...reference.aliasLookupKeys!, '__changed_alias__']},
        {...reference, arity: (reference.arity ?? 0) + 1},
        {...reference, edgeId: `changed:${reference.edgeId}`},
        {...reference, evidencePath: `changed/${reference.evidencePath}`},
        {...reference, exportedOnly: false},
        {...reference, lookupTiers: changedTier},
        {...reference, provenance: 'heuristic'},
        {...reference, relation: 'calls'},
        {...reference, resolutionDomain: 'global'},
        {...reference, sourceId: `changed:${reference.sourceId ?? ''}`},
        {...reference, sourceName: `changed:${reference.sourceName}`},
        {...reference, targetName: `changed:${reference.targetName}`},
      ];

      expect(
        EffectArray.every(mutations, mutated => !hasSameCodeGraphReexportResolutionSurface([reference], [mutated])),
      ).toBe(true);
      expect(hasSameCodeGraphReexportResolutionSurface([reference, reference], [reference, reference])).toBe(false);
      const unsupported: CodeGraphReference = {...reference, relation: 'calls'};
      expect(hasSameCodeGraphReexportResolutionSurface([unsupported], [unsupported])).toBe(false);
      expect(hasSameCodeGraphReexportResolutionSurface([reference], [])).toBe(false);
      expect(hasSameCodeGraphReexportResolutionSurface([], [reference])).toBe(false);
    },
    {fastCheck: {numRuns: 200}},
  );

  it('classifies scoped and unscoped own-path TypeScript keys without leaking lookup values', () => {
    const path = 'packages/private/src/fixture.ts';
    const scoped: CodeGraphSymbol = {
      arity: 1,
      contentHash: 'content',
      exported: false,
      id: 'local-private-method',
      kind: 'method',
      language: 'typescript',
      lookupKeys: [],
      name: 'privateMethod',
      path,
      qualifiedName: 'Fixture.privateMethod',
      resolutionDomain: 'typescript',
      resolutionScopeId: 'project-a',
      span: {column: 1, endColumn: 2, endLine: 1, line: 1},
    };
    const unscoped = {
      ...scoped,
      lookupKeys: typescriptPathLocalLookupKeys(path, scoped.name, scoped.qualifiedName, undefined, scoped.arity),
    };
    const scopedWithKeys = {
      ...scoped,
      lookupKeys: typescriptPathLocalLookupKeys(path, scoped.name, scoped.qualifiedName, 'project-a', scoped.arity),
    };

    expect(assessCodeGraphResolutionSymbolPublication(unscoped)).toEqual({
      gate: 'own-path-local',
      lookupKeyForm: 'typescript-path-unscoped',
      published: false,
    });
    expect(assessCodeGraphResolutionSymbolPublication(scopedWithKeys)).toEqual({
      gate: 'own-path-local',
      lookupKeyForm: 'typescript-path-scoped',
      published: false,
    });
    expect(
      assessCodeGraphResolutionSymbolPublication({
        ...scopedWithKeys,
        lookupKeys: typescriptPathLocalLookupKeys(path, scoped.name, scoped.qualifiedName, 'project-b', scoped.arity),
      }),
    ).toMatchObject({gate: 'scope-mismatch', published: true});
  });

  it('keeps non-exported rationale line shifts inside the changed-file resolution surface', () => {
    const rationale: CodeGraphSymbol = {
      contentHash: 'before',
      documentation: 'preserve the bounded invariant',
      exported: false,
      id: 'rationale-line-10',
      kind: 'rationale',
      language: 'typescript',
      lookupKeys: ['WHY: preserve the bounded invariant', 'WHY', 'src/example.ts#rationale-10-1'],
      name: 'WHY: preserve the bounded invariant',
      path: 'src/example.ts',
      qualifiedName: 'src/example.ts#rationale-10-1',
      resolutionDomain: 'documentation',
      signature: 'WHY',
      span: {column: 1, endColumn: 1, endLine: 10, line: 10},
    };
    const shifted: CodeGraphSymbol = {
      ...rationale,
      contentHash: 'after',
      id: 'rationale-line-11',
      lookupKeys: ['WHY: preserve the bounded invariant', 'WHY', 'src/example.ts#rationale-11-1'],
      qualifiedName: 'src/example.ts#rationale-11-1',
      span: {column: 1, endColumn: 1, endLine: 11, line: 11},
    };

    expect(assessCodeGraphResolutionSymbolPublication(rationale)).toEqual({
      gate: 'own-path-local',
      lookupKeyForm: 'non-typescript',
      published: false,
    });
    expect(hasSameCodeGraphResolutionSurface([rationale], [shifted])).toBe(true);
  });

  fcProp(
    it,
    'keeps arbitrary rationale position changes resolution-local',
    {fromLine: FC.integer({max: 100_000, min: 1}), toLine: FC.integer({max: 100_000, min: 1})},
    ({fromLine, toLine}) => {
      const at = (line: number): CodeGraphSymbol => ({
        contentHash: `content-${line}`,
        documentation: 'bounded invariant',
        exported: false,
        id: `rationale-line-${line}`,
        kind: 'rationale',
        language: 'typescript',
        lookupKeys: ['WHY: bounded invariant', 'WHY', `src/example.ts#rationale-${line}-1`],
        name: 'WHY: bounded invariant',
        path: 'src/example.ts',
        qualifiedName: `src/example.ts#rationale-${line}-1`,
        resolutionDomain: 'documentation',
        signature: 'WHY',
        span: {column: 1, endColumn: 1, endLine: line, line},
      });

      expect(hasSameCodeGraphResolutionSurface([at(fromLine)], [at(toLine)])).toBe(true);
    },
    {fastCheck: {numRuns: 200}},
  );

  it('does not synthesize active global endpoints for TypeScript while preserving explicit extractor keys', () => {
    const path = 'src/example.ts';
    const ownKey = `typescript:path:${encodeURIComponent(path)}:name:local`;
    const explicitGlobal = 'global:name:explicit';
    const local: CodeGraphSymbol = {
      contentHash: 'hash',
      exported: false,
      id: 'local',
      kind: 'function',
      language: 'typescript',
      lookupKeys: [ownKey],
      name: 'local',
      path,
      qualifiedName: 'local',
      resolutionDomain: 'typescript',
      span: {column: 1, endColumn: 2, endLine: 1, line: 1},
    };
    const facts: CodeGraphFileFacts = {
      diagnostics: [],
      edges: [],
      path,
      references: [],
      symbols: [
        local,
        {...local, exported: true, id: 'exported', name: 'exported'},
        {
          ...local,
          id: 'explicit',
          lookupKeys: [ownKey, explicitGlobal],
          name: 'explicit',
        },
      ],
    };
    const file: CodeGraphInventoryFile = {
      blobId: 'blob',
      content: '',
      contentHash: 'hash',
      language: 'typescript',
      mode: '100644',
      path,
      size: 0,
      source: 'commit',
    };

    const attributed = createResolutionAttributor([file])([facts])[0];
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(attributed.symbols, symbol => symbol.id === 'local'))
        ?.lookupKeys,
    ).toEqual([ownKey]);
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(attributed.symbols, symbol => symbol.id === 'exported'))
        ?.lookupKeys,
    ).not.toContain('global:name:exported');
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(attributed.symbols, symbol => symbol.id === 'explicit'))
        ?.lookupKeys,
    ).toContain(explicitGlobal);
  });

  fcProp(
    it,
    'accepts non-resolution metadata changes but rejects every published declaration and lookup surface mutation',
    {symbol: publishedSymbolArbitrary},
    ({symbol}) => {
      const metadataOnly: CodeGraphSymbol = {
        ...symbol,
        contentHash: `changed:${symbol.contentHash}`,
        documentation: `changed:${symbol.documentation ?? ''}`,
        signature: changedOptional(symbol.signature),
        span: {...symbol.span, endLine: symbol.span.endLine + 1},
      };
      expect(hasSameCodeGraphResolutionSurface([symbol], [metadataOnly])).toBe(true);

      const mutations: readonly CodeGraphSymbol[] = [
        {...symbol, arity: symbol.arity === undefined ? 0 : symbol.arity + 1},
        {...symbol, exported: !symbol.exported},
        {...symbol, id: `changed:${symbol.id}`},
        {...symbol, kind: `changed:${symbol.kind}`},
        {...symbol, language: `changed:${symbol.language}`},
        {...symbol, lookupKeys: [...(symbol.lookupKeys ?? []), '__changed_lookup__']},
        {...symbol, name: `changed:${symbol.name}`},
        {...symbol, packageName: changedOptional(symbol.packageName)},
        {...symbol, path: `changed/${symbol.path}`},
        {...symbol, qualifiedName: `changed:${symbol.qualifiedName}`},
        {...symbol, resolutionDomain: changedOptional(symbol.resolutionDomain)},
        {...symbol, resolutionScopeId: changedOptional(symbol.resolutionScopeId)},
      ];
      expect(EffectArray.every(mutations, mutated => !hasSameCodeGraphResolutionSurface([symbol], [mutated]))).toBe(
        true,
      );
    },
    {fastCheck: {numRuns: 250}},
  );

  fcProp(
    it,
    'ignores additions, removals, and renames of unexported own-path TypeScript symbols but not new exports',
    {local: pathLocalTypeScriptSymbolArbitrary, published: publishedSymbolArbitrary},
    ({local, published}) => {
      const baseline = [{...published, id: `baseline:${published.id}`}];
      const renamed = renamePathLocalSymbol(local);

      expect(hasSameCodeGraphResolutionSurface(baseline, [...baseline, local])).toBe(true);
      expect(hasSameCodeGraphResolutionSurface([...baseline, local], baseline)).toBe(true);
      expect(hasSameCodeGraphResolutionSurface([...baseline, local], [...baseline, renamed])).toBe(true);
      expect(hasSameCodeGraphResolutionSurface(baseline, [...baseline, {...local, exported: true}])).toBe(false);
    },
    {fastCheck: {numRuns: 250}},
  );

  fcProp(
    it,
    'publishes every global and non-own lookup key while retaining empty unexported surfaces as local',
    {local: pathLocalTypeScriptSymbolArbitrary, published: publishedSymbolArbitrary},
    ({local, published}) => {
      const baseline = [{...published, id: `baseline:${published.id}`}];
      const localKeys = local.lookupKeys ?? [];
      const derivedLexicalMirrors = derivedTypeScriptLexicalGlobalLookupKeys(local.name, local.qualifiedName);
      const derivedMirrorSymbol: CodeGraphSymbol = {
        ...local,
        lookupKeys: [...localKeys, ...derivedLexicalMirrors],
      };
      const globalKey = `global:name:${encodeURIComponent(`other:${local.name}`)}`;
      const globalSymbol: CodeGraphSymbol = {...local, lookupKeys: [...localKeys, globalKey]};
      const changedGlobal: CodeGraphSymbol = {
        ...globalSymbol,
        lookupKeys: [...localKeys, `global:qualified:${encodeURIComponent(`other:${local.qualifiedName}`)}`],
      };
      const globalOnlySymbol: CodeGraphSymbol = {...local, lookupKeys: derivedLexicalMirrors};
      const noLookupSymbol: CodeGraphSymbol = {...local, lookupKeys: []};
      const foreignPathSymbol: CodeGraphSymbol = {
        ...local,
        lookupKeys: [
          ...localKeys,
          typeScriptPathLookupKey(`${local.path}.foreign`, 'name', local.name, local.resolutionScopeId),
        ],
      };
      const moduleKeySymbol: CodeGraphSymbol = {
        ...local,
        lookupKeys: [
          ...localKeys,
          `${typeScriptLookupKeyPrefix(local.resolutionScopeId)}module:${encodeURIComponent(local.path)}`,
        ],
      };

      expect(hasSameCodeGraphResolutionSurface([...baseline, local], [...baseline, derivedMirrorSymbol])).toBe(false);
      expect(hasSameCodeGraphResolutionSurface([...baseline, globalSymbol], [...baseline, changedGlobal])).toBe(false);
      expect(hasSameCodeGraphResolutionSurface([...baseline, globalSymbol], [...baseline, local])).toBe(false);
      expect(hasSameCodeGraphResolutionSurface([...baseline, local], [...baseline, globalSymbol])).toBe(false);
      expect(hasSameCodeGraphResolutionSurface(baseline, [...baseline, globalOnlySymbol])).toBe(false);
      expect(hasSameCodeGraphResolutionSurface(baseline, [...baseline, noLookupSymbol])).toBe(true);
      expect(hasSameCodeGraphResolutionSurface([...baseline, local], [...baseline, foreignPathSymbol])).toBe(false);
      expect(hasSameCodeGraphResolutionSurface([...baseline, local], [...baseline, moduleKeySymbol])).toBe(false);
    },
    {fastCheck: {numRuns: 200}},
  );

  fcProp(
    it,
    'is independent of published symbol materialization order while still requiring the exact published set',
    {symbols: FC.array(publishedSymbolArbitrary, {maxLength: 12, minLength: 1})},
    ({symbols}) => {
      const unique = EffectArray.map(symbols, (symbol, index) => ({...symbol, id: `symbol-${index}:${symbol.id}`}));
      expect(hasSameCodeGraphResolutionSurface(unique, [...unique].reverse())).toBe(true);
      expect(hasSameCodeGraphResolutionSurface(unique, unique.slice(1))).toBe(false);
    },
    {fastCheck: {numRuns: 150}},
  );

  fcProp(
    it,
    'fails closed when either resolution surface contains duplicate symbol IDs',
    {local: pathLocalTypeScriptSymbolArbitrary, symbol: publishedSymbolArbitrary},
    ({local, symbol}) => {
      const changedDuplicate: CodeGraphSymbol = {
        ...symbol,
        name: `changed:${symbol.name}`,
      };
      const uniquePeer: CodeGraphSymbol = {
        ...symbol,
        id: `peer:${symbol.id}`,
      };

      expect(hasSameCodeGraphResolutionSurface([symbol, changedDuplicate], [changedDuplicate, changedDuplicate])).toBe(
        false,
      );
      expect(hasSameCodeGraphResolutionSurface([symbol, symbol], [symbol, uniquePeer])).toBe(false);
      expect(hasSameCodeGraphResolutionSurface([symbol, uniquePeer], [symbol, symbol])).toBe(false);
      expect(hasSameCodeGraphResolutionSurface([symbol, symbol], [symbol, symbol])).toBe(false);
      expect(hasSameCodeGraphResolutionSurface([local, local], [])).toBe(false);
      expect(hasSameCodeGraphResolutionSurface([], [local, local])).toBe(false);
    },
    {fastCheck: {numRuns: 150}},
  );
});

function changedOptional(value: string | undefined): string {
  return `changed:${value ?? ''}`;
}

function renamePathLocalSymbol(symbol: CodeGraphSymbol): CodeGraphSymbol {
  const name = `renamed:${symbol.name}`;
  const qualifiedName = `renamed:${symbol.qualifiedName}`;
  return {
    ...symbol,
    id: `renamed:${symbol.id}`,
    lookupKeys: [
      ...typescriptPathLocalLookupKeys(symbol.path, name, qualifiedName, symbol.resolutionScopeId, symbol.arity),
    ],
    name,
    qualifiedName,
  };
}

function typescriptPathLocalLookupKeys(
  path: string,
  name: string,
  qualifiedName: string,
  resolutionScopeId: string | undefined,
  arity: number | undefined,
): readonly string[] {
  return [
    typeScriptPathLookupKey(path, 'name', name, resolutionScopeId),
    typeScriptPathLookupKey(path, 'qualified', qualifiedName, resolutionScopeId),
    ...(arity === undefined
      ? []
      : [
          typeScriptPathLookupKey(path, 'name', name, resolutionScopeId, `arity:${arity}`),
          typeScriptPathLookupKey(path, 'qualified', qualifiedName, resolutionScopeId, `arity:${arity}`),
        ]),
    typeScriptPathLookupKey(path, 'name', name, resolutionScopeId, 'implementation'),
    typeScriptPathLookupKey(path, 'qualified', qualifiedName, resolutionScopeId, 'implementation'),
  ];
}

function typeScriptPathLookupKey(
  path: string,
  kind: 'name' | 'qualified',
  value: string,
  resolutionScopeId: string | undefined,
  suffix?: `arity:${number}` | 'implementation',
): string {
  return `${typeScriptLookupKeyPrefix(resolutionScopeId)}path:${encodeURIComponent(path)}:${kind}:${encodeURIComponent(value)}${suffix ? `:${suffix}` : ''}`;
}

function typeScriptLookupKeyPrefix(resolutionScopeId: string | undefined): string {
  return resolutionScopeId === undefined ? 'typescript:' : `typescript:${resolutionScopeId}:`;
}

function derivedTypeScriptLexicalGlobalLookupKeys(name: string, qualifiedName: string): readonly string[] {
  return [`global:name:${encodeURIComponent(name)}`, `global:qualified:${encodeURIComponent(qualifiedName)}`];
}
