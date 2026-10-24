import {fcEffectProp, fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import * as FC from 'fast-check';
import {CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM} from '@threadnote/graph/fact/budget';
import type {ProjectResolutionLookupKey} from '@threadnote/graph/incremental/closure';
import {
  assessResolutionCandidateReexportSafety,
  boundedReusableReexportsFromKeys,
  enrichPersistedTypeScriptReexports,
} from '@threadnote/graph/indexer/resolution_candidate_closure';
import type {CodeGraphReusableReexport} from '@threadnote/graph/store';
import {
  PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORT_KEY_BYTES,
  PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORT_LOOKUP_KEYS,
  PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORTS,
  PROJECT_RESOLUTION_CANDIDATE_PROJECTION_STORAGE_MAX_BYTES,
  PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FACT_BYTES,
  PROJECT_RESOLUTION_CANDIDATE_SCAN_PAGE_MAX_FACT_BYTES,
  planProjectResolutionCandidateScan,
  resolutionCandidateLookupKeyClosure,
  scanProjectResolutionCandidateClosure,
  type ProjectResolutionCandidateClosure,
  type ProjectResolutionCandidateFactPage,
  type ProjectResolutionCandidateScanPlan,
  type ProjectResolutionReexportKeys,
} from '@threadnote/graph/store/resolution/candidate_closure';
import {CODE_GRAPH_RESOLUTION_PASS_MAXIMUM} from '@threadnote/graph/store/resolution';
import type {
  CodeGraphFileFacts,
  CodeGraphInventoryFile,
  CodeGraphReference,
  CodeGraphSymbol,
} from '@threadnote/graph/types';

describe('resolution-candidate closure', () => {
  fcProp(
    effectIt,
    'partitions every file exactly once independent of inventory order',
    {
      ids: FC.uniqueArray(FC.integer({max: 10_000, min: 0}), {maxLength: 80}),
      pageMaximumFactBytes: FC.integer({max: 64, min: 1}),
      pageMaximumFiles: FC.integer({max: 16, min: 1}),
      reverse: FC.boolean(),
    },
    ({ids, pageMaximumFactBytes, pageMaximumFiles, reverse}) => {
      const files = ids.map(id => inventory(`src/file-${id}.ts`, 1));
      const bytesByPath = new Map(files.map(file => [file.path, factBytesForPath(file.path)]));
      const inputFiles = reverse ? [...files].reverse() : files;
      const plan = planProjectResolutionCandidateScan({
        bytesByPath,
        files: inputFiles,
        maximumFactBytes: Number.MAX_SAFE_INTEGER,
        maximumFiles: 80,
        pageMaximumFactBytes,
        pageMaximumFiles,
      });

      expect(plan.mode).toBe('eligible');
      if (plan.mode !== 'eligible') return;
      const flattened = plan.pages.flatMap(page => page.files.map(file => file.path));
      const expectedPaths = files.map(file => file.path).sort();
      expect(flattened).toEqual(expectedPaths);
      expect(new Set(flattened).size).toBe(flattened.length);
      expect(plan.files).toBe(files.length);
      expect(plan.factBytes).toBe([...bytesByPath.values()].reduce((total, bytes) => total + bytes, 0));
      for (const page of plan.pages) {
        expect(page.files.length).toBeLessThanOrEqual(pageMaximumFiles);
        expect(page.factBytes).toBe(page.files.reduce((total, file) => total + bytesByPath.get(file.path)!, 0));
        if (page.factBytes > pageMaximumFactBytes) {
          expect(page.files).toHaveLength(1);
          expect(bytesByPath.get(page.files[0].path)).toBeGreaterThan(pageMaximumFactBytes);
        }
      }

      const reordered = planProjectResolutionCandidateScan({
        bytesByPath,
        files: [...inputFiles].reverse(),
        maximumFactBytes: Number.MAX_SAFE_INTEGER,
        maximumFiles: 80,
        pageMaximumFactBytes,
        pageMaximumFiles,
      });
      expect(reordered).toEqual(plan);
    },
    {fastCheck: {numRuns: 150}},
  );

  fcEffectProp(
    effectIt,
    'returns the same complete closure for every bounded page partition',
    {
      ids: FC.uniqueArray(FC.integer({max: 1_000, min: 0}), {maxLength: 40, minLength: 1}),
      leftPageFiles: FC.integer({max: 12, min: 1}),
      rightPageFiles: FC.integer({max: 12, min: 1}),
    },
    ({ids, leftPageFiles, rightPageFiles}) =>
      Effect.gen(function* () {
        const files = ids.map(id => inventory(`src/file-${id}.ts`, 1));
        const factsByPath = new Map(
          ids.map(id => {
            const path = `src/file-${id}.ts`;
            const group = id % 4;
            return [
              path,
              id % 4 === 0
                ? facts(path, [reexportReference(path, `alias-${group}`, 'seed')])
                : facts(path, [reference(path, [[`alias-${group}`]])]),
            ] as const;
          }),
        );
        const leftPlan = eligiblePlan(files, leftPageFiles);
        const rightPlan = eligiblePlan([...files].reverse(), rightPageFiles);
        const left = yield* scan(leftPlan, factsByPath, [lookup('typescript', 'seed')], 40);
        const right = yield* scan(rightPlan, factsByPath, [lookup('typescript', 'seed')], 40);

        expect(canonicalClosure(left)).toEqual(canonicalClosure(right));
      }),
    {fastCheck: {numRuns: 80}},
  );

  fcEffectProp(
    effectIt,
    'conservatively selects the independent union of old and current membership references',
    {
      rows: FC.array(FC.record({oldKey: FC.integer({min: 0, max: 5}), newKey: FC.integer({min: 0, max: 5})}), {
        minLength: 1,
        maxLength: 20,
      }),
      seed: FC.integer({min: 0, max: 5}),
      reverse: FC.boolean(),
    },
    ({rows, seed, reverse}) =>
      Effect.gen(function* () {
        const files = rows.map((_, index) => inventory(`file-${index}.ts`, 1));
        const before = new Map(
          rows.map((row, index) => [
            files[index].path,
            facts(files[index].path, [reference(files[index].path, [[String(row.oldKey)]])]),
          ]),
        );
        const current = new Map(
          rows.map((row, index) => [
            files[index].path,
            facts(files[index].path, [reference(files[index].path, [[String(row.newKey)]])]),
          ]),
        );
        const expected = files
          .filter((_, index) => rows[index].oldKey === seed || rows[index].newKey === seed)
          .map(file => file.path)
          .sort();
        let loaded = 0;
        const result = yield* scanProjectResolutionCandidateClosure({
          initialLookupKeys: [lookup('typescript', String(seed))],
          maximumSelectedFiles: files.length,
          plan: eligiblePlan(reverse ? [...files].reverse() : files, 3),
          loadPage: page => {
            loaded += page.length;
            return Effect.succeed({
              ...loadedPage(page, current),
              previousFacts: new Map(page.map(file => [file.path, before.get(file.path)!])),
            });
          },
        });
        expect(loaded).toBe(files.length);
        expect(result.mode).toBe('eligible');
        if (result.mode === 'eligible') {
          expect(result.paths).toEqual(expected);
          expect(result.projectionObservations).toBe(files.length * 2);
        }
      }),
    {fastCheck: {numRuns: 80}},
  );

  effectIt.effect(
    'projects both membership versions once with shared observation limits and current-only reexports',
    () =>
      Effect.gen(function* () {
        const files = [inventory('consumer.ts', 1), inventory('barrel.ts', 1)];
        const before = new Map([
          ['consumer.ts', facts('consumer.ts', [reference('consumer.ts', [['old']])])],
          ['barrel.ts', facts('barrel.ts', [reexportReference('barrel.ts', 'alias', 'old')])],
        ]);
        const current = new Map([
          ['consumer.ts', facts('consumer.ts', [reference('consumer.ts', [['new']])])],
          ['barrel.ts', facts('barrel.ts', [reexportReference('barrel.ts', 'alias', 'new')])],
        ]);
        let loads = 0;
        const loadPage = (page: readonly CodeGraphInventoryFile[]) => {
          loads += 1;
          return Effect.succeed({
            ...loadedPage(page, current),
            previousFacts: new Map(page.map(file => [file.path, before.get(file.path)!])),
          });
        };
        const closure = yield* scanProjectResolutionCandidateClosure({
          initialLookupKeys: [],
          finalizeLookupKeys: () => [lookup('typescript', 'old')],
          loadPage,
          maximumSelectedFiles: 2,
          plan: eligiblePlan(files, 1),
        });
        expect(loads).toBe(2);
        expect(closure.mode).toBe('eligible');
        if (closure.mode === 'eligible') {
          expect(closure.paths).toEqual(['barrel.ts', 'consumer.ts']);
          expect(closure.reexports).toEqual([
            {
              aliases: [lookup('typescript', 'alias')],
              candidates: [lookup('typescript', 'new')],
              sourcePath: 'barrel.ts',
            },
          ]);
          expect(closure.projectionObservations).toBe(4);
          for (const [limits, detail] of [
            [{maximumProjectionAssociations: 3}, 'candidate-projection-associations'],
            [{maximumProjectionAssociationsPerFile: 1}, 'candidate-projection-file-associations'],
            [
              {maximumProjectionObservedKeyBytes: closure.projectionObservedKeyBytes! - 1},
              'candidate-projection-observed-key-bytes',
            ],
          ] as const) {
            expect(
              yield* scanProjectResolutionCandidateClosure({
                initialLookupKeys: [],
                loadPage,
                maximumSelectedFiles: 2,
                plan: eligiblePlan(files, 1),
                ...limits,
              }),
            ).toMatchObject({mode: 'fallback', detail});
          }
        }
        const bounded = yield* scanProjectResolutionCandidateClosure({
          initialLookupKeys: [lookup('typescript', 'old')],
          loadPage,
          maximumSelectedFiles: 2,
          maximumProjectionObservations: 3,
          plan: eligiblePlan(files, 1),
        });
        expect(bounded).toMatchObject({
          mode: 'fallback',
          detail: 'candidate-projection-observations',
          observed: 4,
          limit: 3,
        });
      }),
  );

  effectIt.effect('loads each page once and joins earlier evidence to aliases discovered later', () =>
    Effect.gen(function* () {
      const alias = 'alias';
      const files = [inventory('a-consumer.ts', 1), inventory('b-symbol.ts', 1), inventory('z-barrel.ts', 1)];
      const factsByPath = new Map<string, CodeGraphFileFacts>([
        ['a-consumer.ts', facts('a-consumer.ts', [reference('a-consumer.ts', [[alias]])])],
        ['b-symbol.ts', facts('b-symbol.ts', [], [symbol('b-symbol.ts', alias)])],
        ['z-barrel.ts', facts('z-barrel.ts', [reexportReference('z-barrel.ts', alias, 'seed')])],
      ]);
      const plan = eligiblePlan(files, 1);
      let pageLoads = 0;
      const closure = yield* scanProjectResolutionCandidateClosure({
        initialLookupKeys: [lookup('typescript', 'seed')],
        loadPage: page => {
          pageLoads += 1;
          return Effect.succeed(loadedPage(page, factsByPath));
        },
        maximumSelectedFiles: 3,
        plan,
      });

      expect(pageLoads).toBe(plan.pages.length);
      expect(closure.mode).toBe('eligible');
      if (closure.mode === 'eligible') {
        expect(closure.paths).toEqual(['a-consumer.ts', 'z-barrel.ts']);
        expect([...closure.directAliasSymbolConflictIdentities]).toEqual(['typescript\0alias']);
      }
    }),
  );

  effectIt.effect('turns projection fingerprint collisions into a conservative superset', () =>
    Effect.gen(function* () {
      const files = [
        inventory('a-unrelated.ts', 1),
        inventory('b-target.ts', 1),
        inventory('c-symbol.ts', 1),
        inventory('z-barrel.ts', 1),
      ];
      const factsByPath = new Map<string, CodeGraphFileFacts>([
        ['a-unrelated.ts', facts('a-unrelated.ts', [reference('a-unrelated.ts', [['other']])])],
        ['b-target.ts', facts('b-target.ts', [reference('b-target.ts', [['seed']])])],
        ['c-symbol.ts', facts('c-symbol.ts', [], [symbol('c-symbol.ts', 'direct')])],
        ['z-barrel.ts', facts('z-barrel.ts', [reexportReference('z-barrel.ts', 'alias', 'seed')])],
      ]);
      const closure = yield* scanProjectResolutionCandidateClosure({
        initialLookupKeys: [lookup('typescript', 'seed')],
        loadPage: page => Effect.succeed(loadedPage(page, factsByPath)),
        maximumSelectedFiles: files.length,
        plan: eligiblePlan(files, 1),
        projectionFingerprint: () => 0n,
      });

      expect(closure.mode).toBe('eligible');
      if (closure.mode === 'eligible') {
        expect(closure.paths).toEqual(['a-unrelated.ts', 'b-target.ts', 'z-barrel.ts']);
        expect([...closure.directAliasSymbolConflictIdentities]).toEqual(['typescript\0alias']);
      }
    }),
  );

  fcProp(
    effectIt,
    'computes a deterministic reverse fixed point independent of edge permutation and is idempotent',
    {
      edgeCodes: FC.array(FC.integer({max: 10_000, min: 0}), {maxLength: 80}),
      nodeCount: FC.integer({max: 20, min: 1}),
      permutationCodes: FC.array(FC.integer({max: 10_000, min: 0}), {maxLength: 80}),
      seedCodes: FC.array(FC.integer({max: 10_000, min: 0}), {maxLength: 20, minLength: 1}),
    },
    ({edgeCodes, nodeCount, permutationCodes, seedCodes}) => {
      const reexports = edgeCodes.map((code, index) => {
        const alias = code % nodeCount;
        const candidate = Math.floor(code / nodeCount) % nodeCount;
        return reexportKeys(
          `barrel-${index}.ts`,
          lookup('typescript', `k${alias}`),
          lookup('typescript', `k${candidate}`),
        );
      });
      const seeds = seedCodes.map(code => lookup('typescript', `k${code % nodeCount}`));
      const expected = independentLookupClosure(seeds, reexports);
      const permuted = [...reexports]
        .map((value, index) => ({priority: permutationCodes[index] ?? 0, value}))
        .sort((left, right) => left.priority - right.priority)
        .map(entry => entry.value);

      const canonical = resolutionCandidateLookupKeyClosure(seeds, reexports, nodeCount + 1);
      const reordered = resolutionCandidateLookupKeyClosure([...seeds].reverse(), permuted, nodeCount + 1);
      expect(canonical.mode).toBe('eligible');
      expect(reordered.mode).toBe('eligible');
      if (canonical.mode !== 'eligible' || reordered.mode !== 'eligible') return;
      expect([...canonical.identities].sort()).toEqual([...expected].sort());
      expect([...reordered.identities].sort()).toEqual([...expected].sort());

      const fixedPointSeeds = [...canonical.identities].map(parseLookupIdentity);
      const repeated = resolutionCandidateLookupKeyClosure(fixedPointSeeds, permuted, nodeCount + 1);
      expect(repeated.mode).toBe('eligible');
      if (repeated.mode === 'eligible') {
        expect([...repeated.identities].sort()).toEqual([...canonical.identities].sort());
      }
    },
    {fastCheck: {numRuns: 200}},
  );

  fcProp(
    effectIt,
    'matches an independent fixed-point model for multi-alias multi-candidate hyperedges',
    {
      hyperedges: FC.array(
        FC.record({
          aliasCodes: FC.array(FC.integer({max: 10_000, min: 0}), {maxLength: 8, minLength: 1}),
          candidateCodes: FC.array(FC.integer({max: 10_000, min: 0}), {maxLength: 8, minLength: 1}),
        }),
        {maxLength: 30},
      ),
      nodeCount: FC.integer({max: 20, min: 1}),
      seedCodes: FC.array(FC.integer({max: 10_000, min: 0}), {maxLength: 10, minLength: 1}),
    },
    ({hyperedges, nodeCount, seedCodes}) => {
      const reexports = hyperedges.map(({aliasCodes, candidateCodes}, index) => ({
        aliases: aliasCodes.map(code => lookup('typescript', `k${code % nodeCount}`)),
        candidates: candidateCodes.map(code => lookup('typescript', `k${code % nodeCount}`)),
        sourcePath: `barrel-${index}.ts`,
      }));
      const seeds = seedCodes.map(code => lookup('typescript', `k${code % nodeCount}`));
      const expected = independentLookupClosure(seeds, reexports);
      const actual = resolutionCandidateLookupKeyClosure(seeds, reexports, nodeCount);

      expect(actual.mode).toBe('eligible');
      if (actual.mode === 'eligible') {
        expect([...actual.identities].sort()).toEqual([...expected].sort());
      }
    },
    {fastCheck: {numRuns: 150}},
  );

  fcProp(
    effectIt,
    'bounds parsed provenance by the unique alias-target product independent of duplicate order',
    {
      aliasIds: FC.uniqueArray(FC.integer({max: 31, min: 0}), {maxLength: 8, minLength: 1}),
      candidateIds: FC.uniqueArray(FC.integer({max: 31, min: 0}), {maxLength: 8, minLength: 1}),
      duplicate: FC.boolean(),
      maximumRows: FC.integer({max: 64, min: 0}),
    },
    ({aliasIds, candidateIds, duplicate, maximumRows}) => {
      const copies = duplicate ? 2 : 1;
      const aliases = aliasIds.flatMap(id =>
        Array.from({length: copies}, () =>
          lookup('typescript', canonicalTypeScriptKey(`alias-${id}.ts`, `alias${id}`)),
        ),
      );
      const candidates = candidateIds.flatMap(id =>
        Array.from({length: copies}, () =>
          lookup('typescript', canonicalTypeScriptKey(`target-${id}.ts`, `target${id}`)),
        ),
      );
      const reexport = {aliases, candidates, sourcePath: 'barrel.ts'};
      const result = boundedReusableReexportsFromKeys([reexport], maximumRows);
      const reordered = boundedReusableReexportsFromKeys(
        [{aliases: [...aliases].reverse(), candidates: [...candidates].reverse(), sourcePath: 'barrel.ts'}],
        maximumRows,
      );
      const expectedRows = aliasIds.length * candidateIds.length;

      if (expectedRows > maximumRows) {
        expect(result).toBeUndefined();
        expect(reordered).toBeUndefined();
        return;
      }
      expect(result).toHaveLength(expectedRows);
      expect(reordered).toHaveLength(expectedRows);
      expect(canonicalReexports(result ?? [])).toEqual(canonicalReexports(reordered ?? []));
    },
    {fastCheck: {numRuns: 150}},
  );

  effectIt.effect('isolates identical lookup-key text by resolution domain through aliases and consumers', () =>
    Effect.gen(function* () {
      const files = [
        inventory('src/barrel.ts', 1),
        inventory('src/typescript-direct.ts', 1),
        inventory('src/typescript-alias.ts', 1),
        inventory('src/Jvm.java', 1),
      ];
      const factsByPath = new Map<string, CodeGraphFileFacts>([
        ['src/barrel.ts', facts('src/barrel.ts', [reexportReference('src/barrel.ts', 'alias', 'shared')])],
        [
          'src/typescript-direct.ts',
          facts('src/typescript-direct.ts', [reference('src/typescript-direct.ts', [['shared']])]),
        ],
        [
          'src/typescript-alias.ts',
          facts('src/typescript-alias.ts', [reference('src/typescript-alias.ts', [['alias']])]),
        ],
        ['src/Jvm.java', facts('src/Jvm.java', [reference('src/Jvm.java', [['shared', 'alias']], 'jvm')])],
      ]);

      const closure = yield* scan(eligiblePlan(files, 2), factsByPath, [lookup('typescript', 'shared')], 4);

      expect(closure.mode).toBe('eligible');
      if (closure.mode === 'eligible') {
        expect(closure.paths).toEqual(['src/barrel.ts', 'src/typescript-alias.ts', 'src/typescript-direct.ts']);
        expect([...closure.affectedAliasLookupIdentities]).toEqual(['typescript\0alias']);
        const jvmClosure = resolutionCandidateLookupKeyClosure([lookup('jvm', 'shared')], closure.reexports);
        expect(jvmClosure.mode).toBe('eligible');
        if (jvmClosure.mode === 'eligible') {
          expect([...jvmClosure.identities]).not.toContain('typescript\0alias');
        }
      }
    }),
  );

  fcEffectProp(
    effectIt,
    'selects a file exactly when any candidate tier contains an affected key',
    {
      seed: FC.integer({max: 16, min: 0}),
      tiers: FC.array(FC.uniqueArray(FC.integer({max: 16, min: 0}), {maxLength: 5}), {
        maxLength: 6,
      }),
    },
    ({seed, tiers}) =>
      Effect.gen(function* () {
        const path = 'src/consumer.ts';
        const lookupTiers = tiers.map(tier => tier.map(id => `k${id}`));
        const factsByPath = new Map([[path, facts(path, [reference(path, lookupTiers)])]]);
        const closure = yield* scan(
          eligiblePlan([inventory(path, 1)], 1),
          factsByPath,
          [lookup('typescript', `k${seed}`)],
          1,
        );
        const expected = tiers.some(tier => tier.includes(seed));

        expect(closure.mode).toBe('eligible');
        if (closure.mode === 'eligible') expect(closure.paths).toEqual(expected ? [path] : []);
      }),
    {fastCheck: {numRuns: 120}},
  );

  fcEffectProp(
    effectIt,
    'matches an independent two-pass oracle across domains, symbols, and added reexports',
    {
      additionalRows: FC.array(
        FC.record({
          alias: FC.integer({max: 15, min: 0}),
          candidate: FC.integer({max: 15, min: 0}),
          domain: FC.constantFrom('jvm', 'typescript'),
        }),
        {maxLength: 8},
      ),
      rows: FC.array(
        FC.record({
          alias: FC.integer({max: 15, min: 0}),
          candidate: FC.integer({max: 15, min: 0}),
          domain: FC.constantFrom('jvm', 'typescript'),
          keys: FC.uniqueArray(FC.integer({max: 15, min: 0}), {maxLength: 6}),
          reexport: FC.boolean(),
          symbolKeys: FC.uniqueArray(FC.integer({max: 15, min: 0}), {maxLength: 4}),
        }),
        {maxLength: 24},
      ),
      seed: FC.integer({max: 15, min: 0}),
      seedDomain: FC.constantFrom('jvm', 'typescript'),
    },
    ({additionalRows, rows, seed, seedDomain}) =>
      Effect.gen(function* () {
        const files = rows.map((_, index) => inventory(`src/file-${index}.ts`, 1));
        const baseReexports = rows.flatMap((row, index) =>
          row.reexport
            ? [
                reexportKeys(
                  `src/file-${index}.ts`,
                  lookup(row.domain, `k${row.alias}`),
                  lookup(row.domain, `k${row.candidate}`),
                ),
              ]
            : [],
        );
        const additionalReexports = additionalRows.map((row, index) =>
          reexportKeys(
            `candidate-${index}.ts`,
            lookup(row.domain, `k${row.alias}`),
            lookup(row.domain, `k${row.candidate}`),
          ),
        );
        const allReexports = [...additionalReexports, ...baseReexports];
        const referencesByPath = new Map(
          rows.map((row, index) => {
            const path = `src/file-${index}.ts`;
            const midpoint = Math.ceil(row.keys.length / 2);
            const ordinary =
              row.keys.length === 0
                ? []
                : [
                    reference(
                      path,
                      [
                        row.keys.slice(0, midpoint).map(key => `k${key}`),
                        row.keys.slice(midpoint).map(key => `k${key}`),
                      ],
                      row.domain,
                    ),
                  ];
            const reexport = row.reexport
              ? [reexportReference(path, `k${row.alias}`, `k${row.candidate}`, row.domain)]
              : [];
            return [path, [...ordinary, ...reexport]] as const;
          }),
        );
        const symbolsByPath = new Map(
          rows.map((row, index) => {
            const path = `src/file-${index}.ts`;
            return [path, row.symbolKeys.map(key => symbol(path, `k${key}`, row.domain))] as const;
          }),
        );
        const factsByPath = new Map(
          files.map(file => [
            file.path,
            facts(file.path, referencesByPath.get(file.path) ?? [], symbolsByPath.get(file.path) ?? []),
          ]),
        );
        const exactClosure = independentLookupClosure([lookup(seedDomain, `k${seed}`)], allReexports);
        const expectedPaths = files
          .filter(file =>
            (referencesByPath.get(file.path) ?? []).some(candidate =>
              candidate.lookupTiers.some(tier =>
                tier.some(key => exactClosure.has(lookupIdentity(lookup(candidate.resolutionDomain, key)))),
              ),
            ),
          )
          .map(file => file.path)
          .sort();
        const allAliasIdentities = new Set(allReexports.flatMap(value => value.aliases.map(lookupIdentity)));
        const symbolIdentities = new Set(
          rows.flatMap(row => row.symbolKeys.map(key => lookupIdentity(lookup(row.domain, `k${key}`)))),
        );
        const expectedConflicts = [...allAliasIdentities].filter(identity => symbolIdentities.has(identity)).sort();
        const expectedAffectedAliases = [...allAliasIdentities].filter(identity => exactClosure.has(identity)).sort();
        const actual = yield* scanProjectResolutionCandidateClosure({
          additionalReexports,
          initialLookupKeys: [lookup(seedDomain, `k${seed}`)],
          loadPage: page => Effect.succeed(loadedPage(page, factsByPath)),
          maximumSelectedFiles: files.length,
          plan: eligiblePlan([...files].reverse(), Math.max(1, (rows.length % 7) + 1)),
        });

        expect(actual.mode).toBe('eligible');
        if (actual.mode === 'eligible') {
          expect(actual.paths).toEqual(expectedPaths);
          expect([...actual.affectedAliasLookupIdentities].sort()).toEqual(expectedAffectedAliases);
          expect([...actual.directAliasSymbolConflictIdentities].sort()).toEqual(expectedConflicts);
          expect(canonicalProjectReexports(actual.reexports)).toEqual(canonicalProjectReexports(baseReexports));
        }

        const conservative = yield* scanProjectResolutionCandidateClosure({
          additionalReexports,
          initialLookupKeys: [lookup(seedDomain, `k${seed}`)],
          loadPage: page => Effect.succeed(loadedPage(page, factsByPath)),
          maximumSelectedFiles: files.length,
          plan: eligiblePlan([...files].reverse(), Math.max(1, ((rows.length + 3) % 7) + 1)),
          projectionFingerprint: partitionProjectionFingerprint,
        });
        expect(conservative.mode).toBe('eligible');
        if (conservative.mode === 'eligible') {
          const conservativePaths = new Set(conservative.paths);
          const conservativeConflicts = new Set(conservative.directAliasSymbolConflictIdentities);
          expect(expectedPaths.every(path => conservativePaths.has(path))).toBe(true);
          expect(expectedConflicts.every(identity => conservativeConflicts.has(identity))).toBe(true);
          expect([...conservative.affectedAliasLookupIdentities].sort()).toEqual(expectedAffectedAliases);
          expect(canonicalProjectReexports(conservative.reexports)).toEqual(canonicalProjectReexports(baseReexports));
        }
      }),
    {fastCheck: {numRuns: 120}},
  );

  effectIt.effect('retains earlier-empty, same-tier ambiguity, and later-tier negative dependencies', () =>
    Effect.gen(function* () {
      const files = [
        inventory('src/earlier-empty.ts', 1),
        inventory('src/same-tier.ts', 1),
        inventory('src/later-tier.ts', 1),
      ];
      const factsByPath = new Map<string, CodeGraphFileFacts>([
        [
          'src/earlier-empty.ts',
          facts('src/earlier-empty.ts', [reference('src/earlier-empty.ts', [['seed'], ['fallback']])]),
        ],
        ['src/same-tier.ts', facts('src/same-tier.ts', [reference('src/same-tier.ts', [['other', 'seed']])])],
        ['src/later-tier.ts', facts('src/later-tier.ts', [reference('src/later-tier.ts', [['stable'], ['seed']])])],
      ]);

      const closure = yield* scan(eligiblePlan(files, 2), factsByPath, [lookup('typescript', 'seed')], 3);

      expect(closure.mode).toBe('eligible');
      if (closure.mode === 'eligible') {
        expect(closure.paths).toEqual(['src/earlier-empty.ts', 'src/later-tier.ts', 'src/same-tier.ts']);
      }
    }),
  );

  effectIt('reports exact planning, lookup, selection, and reexport cap boundaries', () => {
    const files = [inventory('a.ts', 1), inventory('b.ts', 1), inventory('c.ts', 1)];
    expect(
      planProjectResolutionCandidateScan({
        bytesByPath: new Map(files.map(file => [file.path, 1])),
        files,
        maximumFiles: 2,
      }),
    ).toEqual({
      detail: 'candidate-scan-files',
      limit: 2,
      mode: 'fallback',
      observed: 3,
      reason: 'project-closure-unbounded',
    });
    expect(
      planProjectResolutionCandidateScan({
        bytesByPath: new Map(files.map(file => [file.path, 1])),
        files,
        maximumFactBytes: 2,
      }),
    ).toEqual({
      detail: 'candidate-scan-fact-bytes',
      limit: 2,
      mode: 'fallback',
      observed: 3,
      reason: 'project-closure-unbounded',
    });
    expect(
      resolutionCandidateLookupKeyClosure(
        [lookup('typescript', 'one'), lookup('typescript', 'two'), lookup('typescript', 'three')],
        [],
        2,
      ),
    ).toEqual({
      detail: 'candidate-lookup-keys',
      limit: 2,
      mode: 'fallback',
      observed: 3,
      reason: 'project-closure-unbounded',
    });
  });

  effectIt('keeps a production-sized cached-fact surface within the default bounded scan', () => {
    const files = Array.from({length: 48}, (_, index) => inventory(`file-${index}.ts`, 1));
    const productionSurfaceBytes = 192 * 1_048_576;
    const bytesPerFile = productionSurfaceBytes / files.length;
    const plan = planProjectResolutionCandidateScan({
      bytesByPath: new Map(files.map(file => [file.path, bytesPerFile])),
      files,
    });

    expect(PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FACT_BYTES).toBe(256 * 1_048_576);
    expect(PROJECT_RESOLUTION_CANDIDATE_SCAN_PAGE_MAX_FACT_BYTES).toBe(CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM);
    expect(plan).toMatchObject({factBytes: productionSurfaceBytes, files: 48, mode: 'eligible'});
    if (plan.mode === 'eligible') {
      expect(plan.pages).toHaveLength(24);
      expect(plan.pages.every(page => page.factBytes <= PROJECT_RESOLUTION_CANDIDATE_SCAN_PAGE_MAX_FACT_BYTES)).toBe(
        true,
      );
    }
    const overflowFiles = [inventory('overflow-a.ts', 1), inventory('overflow-b.ts', 1)];
    expect(
      planProjectResolutionCandidateScan({
        bytesByPath: new Map([
          [overflowFiles[0].path, PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FACT_BYTES],
          [overflowFiles[1].path, 1],
        ]),
        files: overflowFiles,
      }),
    ).toEqual({
      detail: 'candidate-scan-fact-bytes',
      limit: PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FACT_BYTES,
      mode: 'fallback',
      observed: PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FACT_BYTES + 1,
      reason: 'project-closure-unbounded',
    });
  });

  effectIt.effect('accepts exact one-pass projection limits and fails before dedupe can hide excess work', () =>
    Effect.gen(function* () {
      const duplicateIdentity = 'typescript\0seed';
      const duplicateBytes = Buffer.byteLength(duplicateIdentity, 'utf8');
      const oneFile = [inventory('a.ts', 1)];
      const duplicateFacts = new Map([['a.ts', facts('a.ts', [reference('a.ts', [['seed', 'seed']])])]]);
      const scanWith = (options: {
        readonly factsByPath?: ReadonlyMap<string, CodeGraphFileFacts>;
        readonly files?: readonly CodeGraphInventoryFile[];
        readonly maximumProjectionAssociations?: number;
        readonly maximumProjectionAssociationsPerFile?: number;
        readonly maximumProjectionObservations?: number;
        readonly maximumProjectionObservedKeyBytes?: number;
      }) => {
        const {factsByPath = duplicateFacts, files = oneFile, ...limits} = options;
        return scanProjectResolutionCandidateClosure({
          initialLookupKeys: [lookup('typescript', 'seed')],
          loadPage: page => Effect.succeed(loadedPage(page, factsByPath)),
          maximumSelectedFiles: files.length,
          plan: eligiblePlan(files, 1),
          ...limits,
        });
      };

      expect(yield* scanWith({maximumProjectionObservations: 1})).toEqual({
        detail: 'candidate-projection-observations',
        limit: 1,
        mode: 'fallback',
        observed: 2,
        reason: 'project-closure-unbounded',
      });
      expect(yield* scanWith({maximumProjectionObservedKeyBytes: duplicateBytes})).toEqual({
        detail: 'candidate-projection-observed-key-bytes',
        limit: duplicateBytes,
        mode: 'fallback',
        observed: duplicateBytes * 2,
        reason: 'project-closure-unbounded',
      });
      expect(
        yield* scanWith({
          maximumProjectionAssociations: 1,
          maximumProjectionAssociationsPerFile: 1,
          maximumProjectionObservations: 2,
          maximumProjectionObservedKeyBytes: duplicateBytes * 2,
        }),
      ).toMatchObject({mode: 'eligible', paths: ['a.ts']});
      const distinctFacts = new Map([['a.ts', facts('a.ts', [reference('a.ts', [['seed', 'other']])])]]);
      const twoFiles = [inventory('a.ts', 1), inventory('b.ts', 1)];
      const sharedFacts = new Map(
        twoFiles.map(file => [file.path, facts(file.path, [reference(file.path, [['seed']])])]),
      );
      expect(yield* scanWith({files: twoFiles, factsByPath: sharedFacts, maximumProjectionAssociations: 1})).toEqual({
        detail: 'candidate-projection-associations',
        limit: 1,
        mode: 'fallback',
        observed: 2,
        reason: 'project-closure-unbounded',
      });
      expect(yield* scanWith({factsByPath: distinctFacts, maximumProjectionAssociationsPerFile: 1})).toEqual({
        detail: 'candidate-projection-file-associations',
        limit: 1,
        mode: 'fallback',
        observed: 2,
        reason: 'project-closure-unbounded',
      });
      expect(
        yield* scanWith({
          factsByPath: distinctFacts,
          maximumProjectionAssociations: 2,
          maximumProjectionAssociationsPerFile: 2,
          maximumProjectionObservations: 2,
        }),
      ).toMatchObject({mode: 'eligible', paths: ['a.ts']});
    }),
  );

  effectIt('ratchets the full projection record payload below 20 MiB', () => {
    expect(PROJECT_RESOLUTION_CANDIDATE_PROJECTION_STORAGE_MAX_BYTES).toBe(20_316_160);
    expect(PROJECT_RESOLUTION_CANDIDATE_PROJECTION_STORAGE_MAX_BYTES).toBeLessThan(20 * 1_048_576);
  });

  effectIt.effect('fails closed on incomplete pages and reports exact selected/reexport overflows', () =>
    Effect.gen(function* () {
      const files = [inventory('a.ts', 1), inventory('b.ts', 1)];
      const plan = eligiblePlan(files, 1);
      const missing = yield* scanProjectResolutionCandidateClosure({
        initialLookupKeys: [lookup('typescript', 'seed')],
        loadPage: () => Effect.succeed({bytesByPath: new Map(), facts: new Map()}),
        maximumSelectedFiles: 2,
        plan,
      });
      expect(missing).toEqual({mode: 'fallback', reason: 'cache-incomplete'});

      const matchingFacts = new Map(
        files.map(file => [file.path, facts(file.path, [reference(file.path, [['seed']])])]),
      );
      const selectedOverflow = yield* scan(plan, matchingFacts, [lookup('typescript', 'seed')], 1);
      expect(selectedOverflow).toEqual({
        detail: 'candidate-selected-files',
        limit: 1,
        mode: 'fallback',
        observed: 2,
        reason: 'project-closure-unbounded',
      });

      const emptyPlan = eligiblePlan([], 1);
      const repeatedReexport = reexportKeys('barrel.ts', lookup('typescript', 'alias'), lookup('typescript', 'seed'));
      const reexportOverflow = yield* scanProjectResolutionCandidateClosure({
        additionalReexports: Array.from(
          {length: PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORTS + 1},
          () => repeatedReexport,
        ),
        initialLookupKeys: [lookup('typescript', 'seed')],
        loadPage: () => Effect.die('empty plan must not load a page'),
        maximumSelectedFiles: 0,
        plan: emptyPlan,
      });
      expect(reexportOverflow).toEqual({
        detail: 'candidate-reexports',
        limit: PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORTS,
        mode: 'fallback',
        observed: PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORTS + 1,
        reason: 'project-closure-unbounded',
      });

      const repeatedLookup = lookup('typescript', 'seed');
      const exactLookupKeyLimit = yield* scanProjectResolutionCandidateClosure({
        additionalReexports: [
          {
            aliases: Array.from(
              {length: PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORT_LOOKUP_KEYS / 2},
              () => repeatedLookup,
            ),
            candidates: Array.from(
              {length: PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORT_LOOKUP_KEYS / 2},
              () => repeatedLookup,
            ),
            sourcePath: 'broad-barrel.ts',
          },
        ],
        initialLookupKeys: [repeatedLookup],
        loadPage: () => Effect.die('empty plan must not load a page'),
        maximumSelectedFiles: 0,
        plan: emptyPlan,
      });
      expect(exactLookupKeyLimit.mode).toBe('eligible');
      const lookupKeyOverflow = yield* scanProjectResolutionCandidateClosure({
        additionalReexports: [
          {
            aliases: Array.from(
              {length: PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORT_LOOKUP_KEYS / 2 + 1},
              () => repeatedLookup,
            ),
            candidates: Array.from(
              {length: PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORT_LOOKUP_KEYS / 2},
              () => repeatedLookup,
            ),
            sourcePath: 'broad-barrel.ts',
          },
        ],
        initialLookupKeys: [repeatedLookup],
        loadPage: () => Effect.die('empty plan must not load a page'),
        maximumSelectedFiles: 0,
        plan: emptyPlan,
      });
      expect(lookupKeyOverflow).toEqual({
        detail: 'candidate-reexport-lookup-keys',
        limit: PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORT_LOOKUP_KEYS,
        mode: 'fallback',
        observed: PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORT_LOOKUP_KEYS + 1,
        reason: 'project-closure-unbounded',
      });

      const halfByteLimitKey = 'x'.repeat(PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORT_KEY_BYTES / 2);
      const keyByteOverflow = yield* scanProjectResolutionCandidateClosure({
        additionalReexports: [
          reexportKeys(
            'large-barrel.ts',
            lookup('typescript', halfByteLimitKey),
            lookup('typescript', halfByteLimitKey),
          ),
        ],
        initialLookupKeys: [lookup('typescript', 'seed')],
        loadPage: () => Effect.die('empty plan must not load a page'),
        maximumSelectedFiles: 0,
        plan: emptyPlan,
      });
      expect(keyByteOverflow).toEqual({
        detail: 'candidate-reexport-key-bytes',
        limit: PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORT_KEY_BYTES,
        mode: 'fallback',
        observed: PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORT_KEY_BYTES + 'typescript'.length * 2,
        reason: 'project-closure-unbounded',
      });
    }),
  );

  effectIt('accepts functional aliases and rejects ambiguity, cycles, conflicts, and malformed aliases', () => {
    const alias = canonicalTypeScriptKey('barrel.ts', 'value');
    const firstTarget = canonicalTypeScriptKey('first.ts', 'value');
    const secondTarget = canonicalTypeScriptKey('second.ts', 'value');
    const safety = new Set([lookupIdentity(lookup('typescript', alias))]);
    const staged = new Set(safety);
    const functional = [
      reexportKeys('barrel.ts', lookup('typescript', alias), lookup('typescript', firstTarget)),
      reexportKeys('duplicate.ts', lookup('typescript', alias), lookup('typescript', firstTarget)),
    ];

    expect(
      assessResolutionCandidateReexportSafety({
        directAliasSymbolConflictIdentities: new Set(),
        reexports: functional,
        safetyAliasLookupIdentities: safety,
        stagedAliasLookupIdentities: staged,
      }),
    ).toEqual({mode: 'eligible', stagedDepthMaximum: 1});
    expect(
      assessResolutionCandidateReexportSafety({
        directAliasSymbolConflictIdentities: new Set(),
        reexports: [
          ...functional,
          reexportKeys('ambiguous.ts', lookup('typescript', alias), lookup('typescript', secondTarget)),
        ],
        safetyAliasLookupIdentities: safety,
        stagedAliasLookupIdentities: staged,
      }),
    ).toEqual({mode: 'fallback', reason: 'non-functional-alias'});
    expect(
      assessResolutionCandidateReexportSafety({
        directAliasSymbolConflictIdentities: new Set(),
        reexports: [reexportKeys('barrel.ts', lookup('typescript', alias), lookup('typescript', alias))],
        safetyAliasLookupIdentities: safety,
        stagedAliasLookupIdentities: staged,
      }),
    ).toEqual({mode: 'fallback', reason: 'alias-cycle'});
    expect(
      assessResolutionCandidateReexportSafety({
        directAliasSymbolConflictIdentities: safety,
        reexports: functional,
        safetyAliasLookupIdentities: safety,
        stagedAliasLookupIdentities: staged,
      }),
    ).toEqual({mode: 'fallback', reason: 'direct-symbol-conflict'});
    expect(
      assessResolutionCandidateReexportSafety({
        directAliasSymbolConflictIdentities: new Set(),
        reexports: [
          reexportKeys('barrel.ts', lookup('typescript', 'not-canonical'), lookup('typescript', firstTarget)),
        ],
        safetyAliasLookupIdentities: new Set(['typescript\0not-canonical']),
        stagedAliasLookupIdentities: new Set(['typescript\0not-canonical']),
      }),
    ).toEqual({mode: 'fallback', reason: 'unparseable-alias'});
  });

  effectIt('counts only staged aliases and admits exactly 32 persisted-delta passes', () => {
    const thirtyTwo = reexportChain(CODE_GRAPH_RESOLUTION_PASS_MAXIMUM);
    const thirtyThree = reexportChain(CODE_GRAPH_RESOLUTION_PASS_MAXIMUM + 1);
    expect(
      reexportSafety(
        thirtyTwo,
        thirtyTwo.map(value => value.alias),
      ),
    ).toEqual({
      mode: 'eligible',
      stagedDepthMaximum: CODE_GRAPH_RESOLUTION_PASS_MAXIMUM,
    });
    expect(
      reexportSafety(
        thirtyThree,
        thirtyThree.map(value => value.alias),
      ),
    ).toEqual({
      mode: 'fallback',
      reason: 'staged-depth-unbounded',
    });

    const retainedTail = reexportChain(96);
    expect(
      reexportSafety(
        retainedTail,
        retainedTail.slice(0, 1).map(value => value.alias),
      ),
    ).toEqual({
      mode: 'eligible',
      stagedDepthMaximum: 1,
    });
    expect(
      reexportSafety(
        retainedTail,
        retainedTail.slice(0, CODE_GRAPH_RESOLUTION_PASS_MAXIMUM).map(value => value.alias),
      ),
    ).toEqual({mode: 'eligible', stagedDepthMaximum: CODE_GRAPH_RESOLUTION_PASS_MAXIMUM});
  });

  effectIt('walks a 10,000-alias retained chain without recursive ancestor copies', () => {
    const chain = reexportChain(10_000);

    expect(reexportSafety(chain, [])).toEqual({mode: 'eligible', stagedDepthMaximum: 0});
  });

  effectIt.effect('processes broad reexport hyperedges without materializing their Cartesian product', () =>
    Effect.gen(function* () {
      const count = 4_000;
      const aliases = Array.from({length: count}, (_, index) => lookup('typescript', `alias-${index}`));
      const candidates = Array.from({length: count}, (_, index) => lookup('typescript', `candidate-${index}`));
      const reexport = {aliases, candidates, sourcePath: 'broad-barrel.ts'};
      const closure = resolutionCandidateLookupKeyClosure([candidates[0]], [reexport], count + 1);

      expect(closure.mode).toBe('eligible');
      if (closure.mode === 'eligible') expect(closure.identities.size).toBe(count + 1);

      const scanned = yield* scanProjectResolutionCandidateClosure({
        additionalReexports: [reexport],
        initialLookupKeys: [candidates[0]],
        loadPage: () => Effect.die('empty scan plan must not load a page'),
        maximumSelectedFiles: 0,
        plan: eligiblePlan([], 1),
      });
      expect(scanned.mode).toBe('eligible');
      if (scanned.mode === 'eligible') expect(scanned.lookupKeys).toBe(count + 1);

      const parsedAliases = aliases.map(({resolutionDomain}, index) =>
        lookup(resolutionDomain, canonicalTypeScriptKey(`alias-${index}.ts`, `alias${index}`)),
      );
      const parsedCandidates = candidates.map(({resolutionDomain}, index) =>
        lookup(resolutionDomain, canonicalTypeScriptKey(`candidate-${index}.ts`, `candidate${index}`)),
      );
      expect(
        assessResolutionCandidateReexportSafety({
          directAliasSymbolConflictIdentities: new Set(),
          reexports: [{aliases: parsedAliases, candidates: parsedCandidates, sourcePath: 'broad-barrel.ts'}],
          safetyAliasLookupIdentities: new Set([lookupIdentity(parsedAliases[0])]),
          stagedAliasLookupIdentities: new Set(),
        }),
      ).toEqual({mode: 'fallback', reason: 'non-functional-alias'});
    }),
  );

  effectIt('rewrites a selected consumer to the terminal so it consumes no additional delta pass', () => {
    const chain = reexportChain(CODE_GRAPH_RESOLUTION_PASS_MAXIMUM);
    const consumerPath = 'consumer.ts';
    const consumer = facts(consumerPath, [reference(consumerPath, [[chain[0].alias]])]);
    const provenance: CodeGraphReusableReexport[] = chain.map(value => ({
      importedName: value.targetName,
      localName: value.aliasName,
      sourcePath: value.aliasPath,
      targetPath: value.targetPath,
    }));

    const enriched = enrichPersistedTypeScriptReexports([consumer], provenance);

    expect(enriched?.[0]?.references?.[0]?.lookupTiers).toEqual([[chain.at(-1)!.target]]);
  });
});

function inventory(path: string, size: number): CodeGraphInventoryFile {
  return {
    blobId: path,
    contentHash: path,
    language: path.endsWith('.java') ? 'java' : 'typescript',
    mode: '100644',
    path,
    size,
    source: 'worktree',
  };
}

function facts(
  path: string,
  references: readonly CodeGraphReference[] = [],
  symbols: readonly CodeGraphSymbol[] = [],
): CodeGraphFileFacts {
  return {diagnostics: [], edges: [], path, references, symbols};
}

function symbol(path: string, lookupKey: string, resolutionDomain = 'typescript'): CodeGraphSymbol {
  return {
    contentHash: path,
    exported: true,
    id: `symbol-${path}`,
    kind: 'constant',
    language: resolutionDomain === 'jvm' ? 'java' : 'typescript',
    lookupKeys: [lookupKey],
    name: lookupKey,
    path,
    qualifiedName: lookupKey,
    resolutionDomain,
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
  };
}

function reference(
  path: string,
  lookupTiers: readonly (readonly string[])[],
  resolutionDomain = 'typescript',
): CodeGraphReference {
  return {
    edgeId: `edge-${path}`,
    evidencePath: path,
    evidenceSpan: {column: 1, endColumn: 2, endLine: 1, line: 1},
    lookupTiers,
    provenance: 'syntactic',
    relation: 'references',
    resolutionDomain,
    sourceName: path,
    targetName: lookupTiers.flat().join(','),
  };
}

function reexportReference(
  path: string,
  alias: string,
  candidate: string,
  resolutionDomain = 'typescript',
): CodeGraphReference {
  return {
    ...reference(path, [[candidate]], resolutionDomain),
    aliasLookupKeys: [alias],
    relation: 'reexports',
  };
}

function lookup(resolutionDomain: string, key: string): ProjectResolutionLookupKey {
  return {key, resolutionDomain};
}

function lookupIdentity(value: ProjectResolutionLookupKey): string {
  return `${value.resolutionDomain}\0${value.key}`;
}

function partitionProjectionFingerprint(identity: string): bigint {
  let fingerprint = 0;
  for (let index = 0; index < identity.length; index += 1) {
    fingerprint = (fingerprint * 31 + identity.charCodeAt(index)) & 3;
  }
  return BigInt(fingerprint);
}

function parseLookupIdentity(identity: string): ProjectResolutionLookupKey {
  const separator = identity.indexOf('\0');
  return {key: identity.slice(separator + 1), resolutionDomain: identity.slice(0, separator)};
}

function reexportKeys(
  sourcePath: string,
  alias: ProjectResolutionLookupKey,
  candidate: ProjectResolutionLookupKey,
): ProjectResolutionReexportKeys {
  return {aliases: [alias], candidates: [candidate], sourcePath};
}

function independentLookupClosure(
  initial: readonly ProjectResolutionLookupKey[],
  reexports: readonly ProjectResolutionReexportKeys[],
): ReadonlySet<string> {
  const closure = new Set(initial.map(lookupIdentity));
  let changed = true;
  while (changed) {
    changed = false;
    for (const reexport of reexports) {
      if (!reexport.candidates.some(candidate => closure.has(lookupIdentity(candidate)))) continue;
      for (const alias of reexport.aliases) {
        const identity = lookupIdentity(alias);
        if (closure.has(identity)) continue;
        closure.add(identity);
        changed = true;
      }
    }
  }
  return closure;
}

function factBytesForPath(path: string): number {
  return (path.length % 71) + 1;
}

function eligiblePlan(
  files: readonly CodeGraphInventoryFile[],
  pageMaximumFiles: number,
): Extract<ProjectResolutionCandidateScanPlan, {readonly mode: 'eligible'}> {
  const plan = planProjectResolutionCandidateScan({
    bytesByPath: new Map(files.map(file => [file.path, 1])),
    files,
    maximumFactBytes: Number.MAX_SAFE_INTEGER,
    maximumFiles: Math.max(files.length, 1),
    pageMaximumFactBytes: Number.MAX_SAFE_INTEGER,
    pageMaximumFiles,
  });
  if (plan.mode !== 'eligible') throw new Error(`Expected eligible scan plan, received ${plan.mode}`);
  return plan;
}

function scan(
  plan: Extract<ProjectResolutionCandidateScanPlan, {readonly mode: 'eligible'}>,
  factsByPath: ReadonlyMap<string, CodeGraphFileFacts>,
  initialLookupKeys: readonly ProjectResolutionLookupKey[],
  maximumSelectedFiles: number,
): Effect.Effect<ProjectResolutionCandidateClosure> {
  return scanProjectResolutionCandidateClosure({
    initialLookupKeys,
    loadPage: files => Effect.succeed(loadedPage(files, factsByPath)),
    maximumSelectedFiles,
    plan,
  });
}

function loadedPage(
  files: readonly CodeGraphInventoryFile[],
  factsByPath: ReadonlyMap<string, CodeGraphFileFacts>,
): ProjectResolutionCandidateFactPage {
  return {
    bytesByPath: new Map(files.map(file => [file.path, 1])),
    facts: new Map(
      files.flatMap(file => (factsByPath.has(file.path) ? [[file.path, factsByPath.get(file.path)!]] : [])),
    ),
  };
}

function canonicalClosure(closure: ProjectResolutionCandidateClosure): unknown {
  if (closure.mode !== 'eligible') return closure;
  return {
    ...closure,
    affectedAliasLookupIdentities: [...closure.affectedAliasLookupIdentities].sort(),
    directAliasSymbolConflictIdentities: [...closure.directAliasSymbolConflictIdentities].sort(),
  };
}

function canonicalReexports(reexports: readonly CodeGraphReusableReexport[]): readonly string[] {
  return reexports
    .map(value => [value.sourcePath, value.localName, value.targetPath, value.importedName].join('\0'))
    .sort();
}

function canonicalProjectReexports(reexports: readonly ProjectResolutionReexportKeys[]): readonly string[] {
  return reexports
    .map(value =>
      [
        value.sourcePath,
        value.aliases.map(lookupIdentity).sort().join(','),
        value.candidates.map(lookupIdentity).sort().join(','),
      ].join('\0'),
    )
    .sort();
}

function canonicalTypeScriptKey(path: string, name: string): string {
  return `typescript:test:path:${encodeURIComponent(path)}:name:${encodeURIComponent(name)}`;
}

interface ReexportChainEntry {
  readonly alias: string;
  readonly aliasName: string;
  readonly aliasPath: string;
  readonly keys: ProjectResolutionReexportKeys;
  readonly target: string;
  readonly targetName: string;
  readonly targetPath: string;
}

function reexportChain(length: number): readonly ReexportChainEntry[] {
  return Array.from({length}, (_, index) => {
    const aliasPath = `barrel-${index}.ts`;
    const targetPath = index + 1 === length ? 'terminal.ts' : `barrel-${index + 1}.ts`;
    const aliasName = `value${index}`;
    const targetName = index + 1 === length ? 'terminal' : `value${index + 1}`;
    const alias = canonicalTypeScriptKey(aliasPath, aliasName);
    const target = canonicalTypeScriptKey(targetPath, targetName);
    return {
      alias,
      aliasName,
      aliasPath,
      keys: reexportKeys(aliasPath, lookup('typescript', alias), lookup('typescript', target)),
      target,
      targetName,
      targetPath,
    };
  });
}

function reexportSafety(chain: readonly ReexportChainEntry[], stagedAliases: readonly string[]) {
  const safetyAliasLookupIdentities = new Set([lookupIdentity(lookup('typescript', chain[0].alias))]);
  return assessResolutionCandidateReexportSafety({
    directAliasSymbolConflictIdentities: new Set(),
    reexports: chain.map(value => value.keys),
    safetyAliasLookupIdentities,
    stagedAliasLookupIdentities: new Set(stagedAliases.map(alias => lookupIdentity(lookup('typescript', alias)))),
  });
}
