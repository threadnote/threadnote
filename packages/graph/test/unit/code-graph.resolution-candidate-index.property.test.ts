import {Array as EffectArray} from 'effect';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import * as FC from 'fast-check';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import type {ProjectResolutionLookupKey} from '@threadnote/graph/incremental/closure';
import {
  planProjectResolutionCandidateScan,
  scanProjectResolutionCandidateClosure,
  type ProjectResolutionCandidateClosure,
  type ProjectResolutionReexportKeys,
} from '@threadnote/graph/store/resolution/candidate_closure';
import type {
  CodeGraphFileFacts,
  CodeGraphInventoryFile,
  CodeGraphReference,
  CodeGraphSymbol,
} from '@threadnote/graph/types';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('resolution-candidate closure oracle', () => {
  fcEffectProp(
    effectIt,
    'selects exactly the consumers an independent reverse model finds for every edit form',
    {edit: editArbitrary(), model: modelArbitrary(), pageMaximumFiles: FC.integer({max: 8, min: 1})},
    ({edit, model, pageMaximumFiles}) =>
      Effect.gen(function* () {
        const repository = repositoryFacts(model);
        const query = editQuery(model, edit);
        const closure = yield* fullScanClosure(repository, query, pageMaximumFiles);
        const expected = independentClosure(repository, query);

        expect(closure.mode).toBe('eligible');
        if (closure.mode !== 'eligible') return;
        expect(closure.paths).toEqual(expected.paths);
        expect([...closure.affectedAliasLookupIdentities].sort()).toEqual(expected.aliasIdentities);
        expect([...closure.directAliasSymbolConflictIdentities].sort()).toEqual(expected.conflictIdentities);
        expect(canonicalReexports(closure.reexports)).toEqual(canonicalReexports(expected.baseReexports));
      }),
    {fastCheck: {numRuns: 300}},
  );
});

type ConsumerForm = 'default' | 'global' | 'mixed-domain' | 'named' | 'namespace' | 'scoped';

interface ResolutionModel {
  readonly barrels: readonly {
    readonly declares: readonly string[];
    readonly reexports: readonly {readonly alias: string; readonly name: string; readonly target: number}[];
  }[];
  readonly consumers: readonly (readonly {
    readonly form: ConsumerForm;
    readonly name: string;
    readonly target: number;
  }[])[];
  readonly modules: readonly (readonly string[])[];
}

type ResolutionEdit =
  | {readonly kind: 'addition'; readonly module: number; readonly name: string}
  | {
      readonly kind: 'reexport';
      readonly alias: string;
      readonly barrel: number;
      readonly name: string;
      readonly target: number;
    }
  | {readonly kind: 'removal'; readonly module: number; readonly name: string}
  | {readonly from: string; readonly kind: 'rename'; readonly module: number; readonly to: string};

interface ResolutionQuery {
  readonly additionalReexports: readonly ProjectResolutionReexportKeys[];
  readonly initialLookupKeys: readonly ProjectResolutionLookupKey[];
}

interface ResolutionRepository {
  readonly facts: ReadonlyMap<string, CodeGraphFileFacts>;
  readonly files: readonly CodeGraphInventoryFile[];
}

const NAMES = ['alpha', 'beta', 'default', 'gamma'] as const;

function modelArbitrary(): FC.Arbitrary<ResolutionModel> {
  const name = FC.constantFrom(...NAMES);
  return FC.record({
    barrels: FC.array(
      FC.record({
        declares: FC.uniqueArray(name, {maxLength: 2}),
        reexports: FC.array(FC.record({alias: name, name, target: FC.nat(31)}), {maxLength: 3}),
      }),
      {maxLength: 4},
    ),
    consumers: FC.array(
      FC.array(
        FC.record({
          form: FC.constantFrom<ConsumerForm>('default', 'global', 'mixed-domain', 'named', 'namespace', 'scoped'),
          name,
          target: FC.nat(31),
        }),
        {maxLength: 4},
      ),
      {maxLength: 8, minLength: 1},
    ),
    modules: FC.array(FC.uniqueArray(name, {maxLength: 4}), {maxLength: 5, minLength: 1}),
  });
}

function editArbitrary(): FC.Arbitrary<ResolutionEdit> {
  const name = FC.constantFrom(...NAMES, 'renamed');
  return FC.oneof(
    FC.record({from: name, kind: FC.constant('rename' as const), module: FC.nat(31), to: name}),
    FC.record({kind: FC.constant('removal' as const), module: FC.nat(31), name}),
    FC.record({kind: FC.constant('addition' as const), module: FC.nat(31), name}),
    FC.record({alias: name, barrel: FC.nat(31), kind: FC.constant('reexport' as const), name, target: FC.nat(31)}),
  );
}

function modulePath(index: number): string {
  return `src/module-${index}.ts`;
}

function barrelPath(index: number): string {
  return `src/barrel-${index}.ts`;
}

function consumerPath(index: number): string {
  return `src/consumer-${index}.ts`;
}

function exporterPath(model: ResolutionModel, target: number): string {
  const exporters = model.modules.length + model.barrels.length;
  const index = target % exporters;
  return index < model.modules.length ? modulePath(index) : barrelPath(index - model.modules.length);
}

function pathKey(path: string, name: string): string {
  return `typescript:path:${encodeURIComponent(path)}:name:${encodeURIComponent(name)}`;
}

function scopedKey(path: string, name: string): string {
  return `typescript:cgp_fixture:path:${encodeURIComponent(path)}:name:${encodeURIComponent(name)}`;
}

function moduleKey(path: string): string {
  return `typescript:module:${encodeURIComponent(path)}`;
}

function globalKey(name: string): string {
  return `global:name:${encodeURIComponent(name)}`;
}

function exportKeys(path: string, name: string): readonly string[] {
  return [pathKey(path, name), scopedKey(path, name), globalKey(name)];
}

function repositoryFacts(model: ResolutionModel): ResolutionRepository {
  const modules = EffectArray.map(model.modules, (exports, index) => {
    const path = modulePath(index);
    return fileFacts(
      path,
      [],
      [
        symbol(path, path, [moduleKey(path)]),
        ...EffectArray.map(exports, name => symbol(path, name, exportKeys(path, name))),
      ],
    );
  });
  const barrels = EffectArray.map(model.barrels, (barrel, index) => {
    const path = barrelPath(index);
    return fileFacts(
      path,
      EffectArray.map(barrel.reexports, (reexport, order) => {
        const target = exporterPath(model, reexport.target);
        return reference(
          path,
          order,
          'reexports',
          'typescript',
          [[scopedKey(target, reexport.name)], [pathKey(target, reexport.name)]],
          [pathKey(path, reexport.alias), scopedKey(path, reexport.alias)],
        );
      }),
      EffectArray.map(barrel.declares, name => symbol(path, name, [pathKey(path, name)])),
    );
  });
  const consumers = EffectArray.map(model.consumers, (uses, index) => {
    const path = consumerPath(index);
    return fileFacts(
      path,
      EffectArray.map(uses, (use, order) => consumerReference(path, order, exporterPath(model, use.target), use)),
      [],
    );
  });
  const facts = [...modules, ...barrels, ...consumers];
  return {
    facts: new Map(EffectArray.map(facts, value => [value.path, value])),
    files: EffectArray.map(facts, value => inventory(value.path)),
  };
}

function consumerReference(
  path: string,
  order: number,
  target: string,
  use: {readonly form: ConsumerForm; readonly name: string},
): CodeGraphReference {
  switch (use.form) {
    case 'default':
      return reference(path, order, 'references', 'typescript', [[pathKey(target, 'default')]]);
    case 'global':
      return reference(path, order, 'calls', 'global', [[globalKey(use.name)]]);
    // Reference identity uses the reference domain, never the key prefix.
    case 'mixed-domain':
      return reference(path, order, 'calls', 'typescript', [[globalKey(use.name)]]);
    case 'named':
      return reference(path, order, 'calls', 'typescript', [
        [scopedKey(target, use.name)],
        [pathKey(target, use.name)],
      ]);
    case 'namespace':
      return reference(path, order, 'references', 'typescript', [[moduleKey(target)], [pathKey(target, use.name)]]);
    case 'scoped':
      return reference(path, order, 'calls', 'typescript', [[scopedKey(target, use.name)]]);
  }
}

/** Seeds exactly as incremental assessment derives them: changed symbol keys plus changed reexport hyperedges. */
function editQuery(model: ResolutionModel, edit: ResolutionEdit): ResolutionQuery {
  const symbolKeys = (path: string, names: readonly string[]) =>
    EffectArray.flatMap(names, name =>
      EffectArray.map(exportKeys(path, name), key => ({key, resolutionDomain: lookupKeyDomain(key, 'typescript')})),
    );
  switch (edit.kind) {
    case 'addition':
    case 'removal':
      return {
        additionalReexports: [],
        initialLookupKeys: symbolKeys(modulePath(edit.module % model.modules.length), [edit.name]),
      };
    case 'rename':
      return {
        additionalReexports: [],
        initialLookupKeys: symbolKeys(modulePath(edit.module % model.modules.length), [edit.from, edit.to]),
      };
    case 'reexport': {
      const source =
        model.barrels.length === 0 ? 'src/barrel-added.ts' : barrelPath(edit.barrel % model.barrels.length);
      const target = exporterPath(model, edit.target);
      const aliases = EffectArray.map([pathKey(source, edit.alias), scopedKey(source, edit.alias)], key => ({
        key,
        resolutionDomain: 'typescript',
      }));
      return {
        additionalReexports: [
          {
            aliases,
            candidates: EffectArray.map([scopedKey(target, edit.name), pathKey(target, edit.name)], key => ({
              key,
              resolutionDomain: 'typescript',
            })),
            sourcePath: source,
          },
        ],
        initialLookupKeys: aliases,
      };
    }
  }
}

function fullScanClosure(
  repository: ResolutionRepository,
  query: ResolutionQuery,
  pageMaximumFiles: number,
): Effect.Effect<ProjectResolutionCandidateClosure> {
  const plan = planProjectResolutionCandidateScan({
    bytesByPath: new Map(EffectArray.map(repository.files, file => [file.path, 1])),
    files: repository.files,
    pageMaximumFiles,
  });
  if (plan.mode !== 'eligible') return Effect.die(new Error(`Expected an eligible scan plan, received ${plan.mode}.`));
  return scanProjectResolutionCandidateClosure({
    additionalReexports: query.additionalReexports,
    initialLookupKeys: query.initialLookupKeys,
    loadPage: files =>
      Effect.succeed({
        bytesByPath: new Map(EffectArray.map(files, file => [file.path, 1])),
        facts: new Map(EffectArray.map(files, file => [file.path, repository.facts.get(file.path)!])),
      }),
    maximumSelectedFiles: 1_000,
    plan,
  });
}

/** Brute-force reverse model: no fingerprints, pages, or caps. */
function independentClosure(repository: ResolutionRepository, query: ResolutionQuery) {
  const identity = (value: ProjectResolutionLookupKey) => `${value.resolutionDomain}\0${value.key}`;
  const orderedFacts = EffectArray.map(
    [...repository.facts.keys()].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    path => repository.facts.get(path)!,
  );
  const baseReexports = EffectArray.flatMap(orderedFacts, file =>
    EffectArray.flatMap(file.references ?? [], value =>
      value.relation === 'reexports' && (value.aliasLookupKeys?.length ?? 0) > 0
        ? [
            {
              aliases: EffectArray.map(value.aliasLookupKeys!, key => ({
                key,
                resolutionDomain: lookupKeyDomain(key, value.resolutionDomain),
              })),
              candidates: EffectArray.map(value.lookupTiers.flat(), key => ({
                key,
                resolutionDomain: value.resolutionDomain,
              })),
              sourcePath: value.evidencePath,
            },
          ]
        : [],
    ),
  );
  const reexports = [...query.additionalReexports, ...baseReexports];
  const closure = new Set(EffectArray.map(query.initialLookupKeys, identity));
  for (let changed = true; changed;) {
    changed = false;
    for (const reexport of reexports) {
      if (!EffectArray.some(reexport.candidates, candidate => closure.has(identity(candidate)))) continue;
      for (const alias of reexport.aliases) {
        if (closure.has(identity(alias))) continue;
        closure.add(identity(alias));
        changed = true;
      }
    }
  }
  const symbolIdentities = new Set(
    EffectArray.flatMap(orderedFacts, file =>
      EffectArray.flatMap(file.symbols, value =>
        EffectArray.map(value.lookupKeys ?? [], key => `${lookupKeyDomain(key, value.resolutionDomain)}\0${key}`),
      ),
    ),
  );
  const aliasIdentities = new Set(
    EffectArray.flatMap(reexports, reexport => EffectArray.map(reexport.aliases, identity)),
  );
  return {
    aliasIdentities: EffectArray.filter([...aliasIdentities], value => closure.has(value)).sort(),
    baseReexports,
    conflictIdentities: EffectArray.filter([...aliasIdentities], value => symbolIdentities.has(value)).sort(),
    paths: EffectArray.map(
      EffectArray.filter(orderedFacts, file =>
        EffectArray.some(file.references ?? [], value =>
          EffectArray.some(value.lookupTiers.flat(), key => closure.has(`${value.resolutionDomain}\0${key}`)),
        ),
      ),
      file => file.path,
    ),
  };
}

function canonicalReexports(reexports: readonly ProjectResolutionReexportKeys[]): readonly string[] {
  const identity = (value: ProjectResolutionLookupKey) => `${value.resolutionDomain}\0${value.key}`;
  return EffectArray.map(reexports, value =>
    EffectArray.join(
      [
        value.sourcePath,
        EffectArray.join([...new Set(EffectArray.map(value.aliases, identity))].sort(), ','),
        EffectArray.join([...new Set(EffectArray.map(value.candidates, identity))].sort(), ','),
      ],
      '\0',
    ),
  ).sort();
}

function lookupKeyDomain(key: string, fallback: string | undefined): string {
  const separator = Effect2.pipe(
    key,
    EffectString.indexOf(':'),
    Effect2.Option.getOrElse(() => -1),
  );
  return separator > 0 ? Effect2.pipe(key, EffectString.slice(0, separator)) : (fallback ?? 'generic');
}

function inventory(path: string): CodeGraphInventoryFile {
  return {blobId: path, contentHash: path, language: 'typescript', mode: '100644', path, size: 1, source: 'commit'};
}

function fileFacts(
  path: string,
  references: readonly CodeGraphReference[],
  symbols: readonly CodeGraphSymbol[],
): CodeGraphFileFacts {
  return {diagnostics: [], edges: [], path, references, symbols};
}

function symbol(path: string, name: string, lookupKeys: readonly string[]): CodeGraphSymbol {
  return {
    contentHash: `${path}#${name}`,
    exported: true,
    id: `${path}#${name}`,
    kind: 'function',
    language: 'typescript',
    lookupKeys,
    name,
    path,
    qualifiedName: name,
    resolutionDomain: 'typescript',
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
  };
}

function reference(
  path: string,
  order: number,
  relation: CodeGraphReference['relation'],
  resolutionDomain: string,
  lookupTiers: readonly (readonly string[])[],
  aliasLookupKeys?: readonly string[],
): CodeGraphReference {
  return {
    ...(aliasLookupKeys === undefined ? {} : {aliasLookupKeys}),
    edgeId: `${path}#${order}`,
    evidencePath: path,
    evidenceSpan: {column: 1, endColumn: 2, endLine: order + 1, line: order + 1},
    lookupTiers,
    provenance: 'syntactic',
    relation,
    resolutionDomain,
    sourceName: path,
    targetName: EffectArray.join(lookupTiers.flat(), ','),
  };
}
