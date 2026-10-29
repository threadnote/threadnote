import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {
  assessProjectClosureSeeds,
  assessProjectFileSetClosureSeeds,
  declaredProjectResolutionClosureProjectIds,
  partitionProjectResolutionSurfaceChanges,
  planProjectIncrementalClosure,
} from '@threadnote/graph/incremental/closure';
import {resolvePersistedReexportTerminals} from '@threadnote/graph/indexer';
import type {CodeGraphWorkspace, CodeGraphWorkspaceProject} from '@threadnote/graph/languages/types';
import type {CodeGraphReusableReexport} from '@threadnote/graph/store';
import type {CodeGraphFileFacts, CodeGraphInventoryFile, CodeGraphSymbol} from '@threadnote/graph/types';
import {mergeCodeGraphWorkspaces} from '@threadnote/graph/workspace';
import {classifyWorkspaceTransition} from '@threadnote/graph/workspace/transition';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('project incremental closure', () => {
  it('includes unchanged nested ownership paths and reverse dependents from each project version', () => {
    const oldLib = transitionProject('lib', 'packages/lib');
    const oldConsumer = transitionProject('consumer', 'packages/consumer', ['lib']);
    const newLib = transitionProject('new-lib', 'packages/lib');
    const newConsumer = transitionProject('consumer', 'packages/consumer', ['new-lib']);
    const paths = ['packages/consumer/index.ts', 'packages/lib/index.ts', 'packages/lib/nested/kept.ts'];
    const files = EffectArray.map(paths, path => ({
      path,
      size: 10,
      resolutionDomains: ['typescript'],
      hasWorkspacePackageSymbol: Effect.pipe(path, EffectString.startsWith('packages/lib/')),
    }));
    const transition = classifyWorkspaceTransition({
      base: transitionSide([oldConsumer, oldLib], files),
      current: transitionSide([newConsumer, newLib], files),
      resolverExtractorContextUnchanged: true,
    });
    expect(transition).toMatchObject({
      mode: 'eligible',
      ownerChangedPaths: ['packages/lib/index.ts', 'packages/lib/nested/kept.ts'],
    });
    if (transition.mode === 'eligible') {
      expect(transition.baseAffectedPaths).toEqual(paths);
      expect(transition.currentAffectedPaths).toEqual(paths);
      expect(transition.sourceBytes).toBe(30);
    }
  });

  it('matches an independent reverse reachability model for generated dependency chains', () => {
    FC.assert(
      FC.property(FC.integer({min: 2, max: 18}), count => {
        const projects = Array.from({length: count}, (_, index) =>
          transitionProject(`p${index}`, `packages/p${index}`, index + 1 < count ? [`p${index + 1}`] : []),
        );
        const target = `p${Math.floor(count / 2)}`;
        const currentProjects = EffectArray.map(projects, (value, index) =>
          index === Math.floor(count / 2)
            ? transitionProject(value.id, value.root, [...value.dependencies, 'added'])
            : value,
        );
        const files = [
          ...EffectArray.map(projects, value => ({
            path: `${value.root}/index.ts`,
            size: 1,
            resolutionDomains: ['typescript'],
            hasWorkspacePackageSymbol: false,
          })),
          {
            path: 'packages/added/index.ts',
            size: 1,
            resolutionDomains: ['typescript'],
            hasWorkspacePackageSymbol: false,
          },
        ];
        const transition = classifyWorkspaceTransition({
          base: transitionSide(projects, files.slice(0, projects.length)),
          current: transitionSide([...currentProjects, transitionProject('added', 'packages/added')], files),
          resolverExtractorContextUnchanged: true,
        });
        expect(transition.mode).toBe('eligible');
        if (transition.mode === 'eligible') {
          const expected = independentReverseClosure(projects, [target]);
          expect([...expected].sort()).toEqual(
            EffectArray.map(
              EffectArray.filter(
                projects,
                __effectArrayValue =>
                  !!(value => transition.baseAffectedPaths.includes(`${value.root}/index.ts`))(__effectArrayValue),
              ),
              value => value.id,
            ).sort(),
          );
        }
      }),
      {numRuns: 50},
    );
  });

  it('matches independent nearest-root ownership and two-version graph oracles for generated nested transitions', () => {
    FC.assert(
      FC.property(
        FC.record({depth: FC.integer({min: 1, max: 5}), dependentCount: FC.integer({min: 0, max: 8})}),
        ({depth, dependentCount}) => {
          const childRoot = `packages/${EffectArray.join(
            Array.from({length: depth}, () => 'nested'),
            '/',
          )}`;
          const parent = transitionProject('parent', 'packages');
          const child = transitionProject('child', childRoot);
          const oldConsumers = Array.from({length: dependentCount}, (_, index) =>
            transitionProject(`consumer${index}`, `apps/consumer${index}`, ['parent']),
          );
          const currentConsumers = EffectArray.map(oldConsumers, value =>
            transitionProject(value.id, value.root, ['child']),
          );
          const allFiles = [
            {
              path: `${childRoot}/src/kept.ts`,
              size: 2,
              resolutionDomains: ['typescript'],
              hasWorkspacePackageSymbol: true,
            },
            ...EffectArray.map(oldConsumers, value => ({
              path: `${value.root}/index.ts`,
              size: 3,
              resolutionDomains: ['typescript'],
              hasWorkspacePackageSymbol: false,
            })),
          ];
          const baseProjects = [parent, ...oldConsumers];
          const currentProjects = [parent, child, ...currentConsumers];
          const beforeSeeds = ['parent', ...EffectArray.map(oldConsumers, value => value.id)];
          const afterSeeds = ['child', ...EffectArray.map(currentConsumers, value => value.id)];
          for (const direction of [
            {base: baseProjects, current: currentProjects, baseSeeds: beforeSeeds, currentSeeds: afterSeeds},
            {base: currentProjects, current: baseProjects, baseSeeds: afterSeeds, currentSeeds: beforeSeeds},
          ]) {
            const transition = classifyWorkspaceTransition({
              base: transitionSide(direction.base, allFiles),
              current: transitionSide(direction.current, allFiles),
              resolverExtractorContextUnchanged: true,
            });
            expect(transition.mode).toBe('eligible');
            if (transition.mode !== 'eligible') continue;
            const baseClosure = independentReverseClosure(direction.base, direction.baseSeeds);
            const currentClosure = independentReverseClosure(direction.current, direction.currentSeeds);
            expect(transition.baseProjectClosureIds).toEqual([...baseClosure].sort());
            expect(transition.currentProjectClosureIds).toEqual([...currentClosure].sort());
            expect(transition.ownerChangedPaths).toEqual([`${childRoot}/src/kept.ts`]);
            expect(transition.baseAffectedPaths).toEqual(oracleAffectedPaths(direction.base, allFiles, baseClosure));
            expect(transition.currentAffectedPaths).toEqual(
              oracleAffectedPaths(direction.current, allFiles, currentClosure),
            );
          }
        },
      ),
      {numRuns: 60},
    );
  });

  it('admits generated additions and removals monotonically under tighter valid work caps', () => {
    FC.assert(
      FC.property(
        FC.record({
          count: FC.integer({min: 1, max: 15}),
          size: FC.integer({min: 1, max: 50}),
          fileLimit: FC.integer({min: 0, max: 20}),
          byteLimit: FC.integer({min: 0, max: 800}),
        }),
        ({count, size, fileLimit, byteLimit}) => {
          const parent = transitionProject('parent', 'packages');
          const child = transitionProject('child', 'packages/child');
          const files = Array.from({length: count}, (_, index) => ({
            path: `packages/child/file${index}.ts`,
            size,
            resolutionDomains: ['typescript'],
            hasWorkspacePackageSymbol: false,
          }));
          const before = transitionSide([parent], files);
          const after = transitionSide([parent, child], files);
          for (const [base, current] of [
            [before, after],
            [after, before],
          ]) {
            const input = {base, current, resolverExtractorContextUnchanged: true};
            const limited = classifyWorkspaceTransition({...input, maxFiles: fileLimit, maxSourceBytes: byteLimit});
            const loosened = classifyWorkspaceTransition({
              ...input,
              maxFiles: fileLimit + 1,
              maxSourceBytes: byteLimit + 1,
            });
            expect(limited.mode).toBe(count <= fileLimit && count * size <= byteLimit ? 'eligible' : 'fallback');
            if (limited.mode === 'eligible') expect(loosened.mode).toBe('eligible');
            if (loosened.mode === 'fallback') expect(limited.mode).toBe('fallback');
          }
        },
      ),
      {numRuns: 60},
    );
  });

  it('finds the exact reverse-transitive declared project closure and deterministically selects its files', () => {
    const projects = [project('app', ['barrel']), project('barrel', ['core']), project('core'), project('unrelated')];
    const files = EffectArray.flatMap(projects, value => [inventory(`${value.root}/index.ts`, 32)]);
    const plan = planProjectIncrementalClosure({
      cachedFactBytesByPath: new Map(EffectArray.map(files, file => [file.path, 64])),
      files: [...files].reverse(),
      modifiedPaths: ['packages/barrel/index.ts'],
      projects: [...projects].reverse(),
      seedProjectIds: ['barrel'],
      workspaceDiagnostics: [],
    });

    expect(plan).toEqual({
      affectedPaths: ['packages/app/index.ts', 'packages/barrel/index.ts'],
      cachedFactBytes: 128,
      mode: 'eligible',
      planningOperations: {dependencyEdges: 2, pathOwnershipChecks: 4},
      projectIds: ['app', 'barrel'],
      sourceBytes: 64,
    });
    expect(declaredProjectResolutionClosureProjectIds([...projects].reverse(), ['barrel'])).toEqual(['app', 'barrel']);
  });

  it('accepts distinct declared evidence for one structural dependency after workspace composition', () => {
    const canonicalProjects = [project('app', ['core']), project('core'), project('unrelated')];
    const appWithBuildEvidence = {
      ...project('app', ['core']),
      dependencyDetails: [
        {
          evidence: 'packages/app/tsconfig.json',
          provenance: 'declared' as const,
          targetId: 'core',
        },
      ],
    };
    const merged = mergeCodeGraphWorkspaces([workspace(canonicalProjects), workspace([appWithBuildEvidence])]);
    const files = EffectArray.map(canonicalProjects, value => inventory(`${value.root}/index.ts`, 1));
    const common = {
      cachedFactBytesByPath: new Map(EffectArray.map(files, file => [file.path, 1])),
      files,
      modifiedPaths: ['packages/core/index.ts'],
      seedProjectIds: ['core'],
      workspaceDiagnostics: [] as readonly string[],
    };

    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(merged.projects, value => value.id === 'app'))
        ?.dependencyDetails,
    ).toEqual([
      {evidence: 'packages/app/package.json', provenance: 'declared', targetId: 'core'},
      {evidence: 'packages/app/tsconfig.json', provenance: 'declared', targetId: 'core'},
    ]);
    const canonical = planProjectIncrementalClosure({...common, projects: canonicalProjects});
    expect(canonical).toMatchObject({mode: 'eligible', projectIds: ['app', 'core']});
    expect(planProjectIncrementalClosure({...common, projects: merged.projects})).toEqual(canonical);
  });

  it('retains otherwise-compatible modified files outside the seeded closure without leaking their unchanged peers', () => {
    const projects = [project('app', ['barrel']), project('barrel'), project('other'), project('idle')];
    const files = EffectArray.map(projects, value => inventory(`${value.root}/index.ts`, 1));
    const plan = planProjectIncrementalClosure({
      cachedFactBytesByPath: new Map(EffectArray.map(files, file => [file.path, 1])),
      files,
      modifiedPaths: ['packages/barrel/index.ts', 'packages/other/index.ts'],
      projects,
      seedProjectIds: ['barrel'],
      workspaceDiagnostics: [],
    });

    expect(plan).toMatchObject({
      affectedPaths: ['packages/app/index.ts', 'packages/barrel/index.ts', 'packages/other/index.ts'],
      mode: 'eligible',
      projectIds: ['app', 'barrel'],
    });
  });

  it('allows only project-scoped arity and lookup changes and seeds static reexports', () => {
    const projects = [project('app', ['barrel']), project('barrel')];
    const left = facts('packages/barrel/index.ts', [symbol('barrel', 1, ['typescript:barrel:path:a:name:foo'])], true);
    const right = facts('packages/barrel/index.ts', [symbol('barrel', 2, ['typescript:barrel:path:b:name:foo'])], true);

    expect(assessProjectClosureSeeds({committedFacts: [left], effectiveFacts: [right], projects})).toEqual({
      candidateLookupKeys: [
        {key: 'typescript:barrel:path:a:name:foo', resolutionDomain: 'typescript'},
        {key: 'typescript:barrel:path:b:name:foo', resolutionDomain: 'typescript'},
      ],
      candidateReexports: [],
      mode: 'eligible',
      planningOperations: {ownershipChecks: 3, pathIndexProjects: 2},
      seedProjectIds: ['barrel'],
    });

    expect(
      assessProjectClosureSeeds({
        committedFacts: [left],
        effectiveFacts: [
          facts(
            'packages/barrel/index.ts',
            [symbol('barrel', 2, ['global:name:other', 'typescript:barrel:path:b:name:foo'])],
            true,
          ),
        ],
        projects,
      }),
    ).toEqual({mode: 'fallback', reason: 'resolution-surface-changed'});
  });

  fcProp(
    it,
    'admits added, removed, and renamed exports only when every lookup key belongs to one declared project',
    {
      reverseKeys: FC.boolean(),
      suffix: FC.integer({max: 100_000, min: 0}),
    },
    ({reverseKeys, suffix}) => {
      const scopeId = `p${suffix}`;
      const name = `added${suffix}`;
      const path = `packages/${scopeId}/index.ts`;
      const encodedPath = encodeURIComponent(path);
      const ownedKeys = [
        `typescript:${scopeId}:path:${encodedPath}:name:${name}`,
        `typescript:${scopeId}:path:${encodedPath}:qualified:${name}`,
        `typescript:${scopeId}:path:${encodedPath}:name:${name}:arity:0`,
        `typescript:${scopeId}:path:${encodedPath}:name:${name}:implementation`,
      ];
      const keys = reverseKeys ? [...ownedKeys].reverse() : ownedKeys;
      const added: CodeGraphSymbol = {
        ...symbol(scopeId, 0, keys),
        id: `symbol-${suffix}`,
        name,
        path,
        qualifiedName: name,
      };
      const projects = [project(scopeId)];
      const committed = facts(path, [], false);
      const effective = facts(path, [added], false);

      const assessment = assessProjectClosureSeeds({
        committedFacts: [committed],
        effectiveFacts: [effective],
        projects,
      });
      expect(assessment).toMatchObject({
        mode: 'eligible',
        planningOperations: {ownershipChecks: 1, pathIndexProjects: 1},
        seedProjectIds: [scopeId],
      });
      expect(assessment.mode === 'eligible' ? assessment.candidateLookupKeys : undefined).toEqual(
        EffectArray.map([...ownedKeys].sort(), key => ({key, resolutionDomain: 'typescript'})),
      );
      expect(assessment.mode === 'eligible' ? assessment.candidateReexports : undefined).toEqual([]);
      expect(assessProjectClosureSeeds({committedFacts: [effective], effectiveFacts: [committed], projects})).toEqual({
        candidateLookupKeys: EffectArray.map([...ownedKeys].sort(), key => ({key, resolutionDomain: 'typescript'})),
        candidateReexports: [],
        mode: 'eligible',
        planningOperations: {ownershipChecks: 1, pathIndexProjects: 1},
        seedProjectIds: [scopeId],
      });
      const renamedName = `renamed${suffix}`;
      const renamedKeys = EffectArray.map(keys, key => Effect.pipe(key, EffectString.replaceAll(name, renamedName)));
      const renamed = {
        ...added,
        id: `renamed-symbol-${suffix}`,
        lookupKeys: renamedKeys,
        name: renamedName,
        qualifiedName: renamedName,
      };
      const renameAssessment = assessProjectClosureSeeds({
        committedFacts: [effective],
        effectiveFacts: [facts(path, [renamed], false)],
        projects,
      });
      expect(renameAssessment).toMatchObject({
        mode: 'eligible',
        planningOperations: {ownershipChecks: 2, pathIndexProjects: 1},
        seedProjectIds: [scopeId],
      });
      expect(renameAssessment.mode === 'eligible' ? renameAssessment.candidateLookupKeys : undefined).toEqual(
        EffectArray.map([...ownedKeys, ...renamedKeys].sort(), key => ({key, resolutionDomain: 'typescript'})),
      );
      expect(
        assessProjectClosureSeeds({
          committedFacts: [facts(path, [{...added, exported: false}], false)],
          effectiveFacts: [effective],
          projects,
        }),
      ).toEqual({mode: 'fallback', reason: 'resolution-surface-changed'});
      expect(
        assessProjectClosureSeeds({
          committedFacts: [committed],
          effectiveFacts: [facts(path, [{...added, lookupKeys: [...keys, `global:name:${name}`]}], false)],
          projects,
        }),
      ).toEqual({mode: 'fallback', reason: 'resolution-surface-changed'});
      expect(
        assessProjectClosureSeeds({
          committedFacts: [facts(path, [{...added, lookupKeys: [...keys, `global:name:${name}`]}], false)],
          effectiveFacts: [committed],
          projects,
        }),
      ).toEqual({mode: 'fallback', reason: 'resolution-surface-changed'});
      expect(
        assessProjectClosureSeeds({
          committedFacts: [effective],
          effectiveFacts: [committed],
          projects: [
            project(scopeId),
            {
              ...project(`ambiguous-${scopeId}`),
              root: `packages/${scopeId}`,
              sourceRoots: [`packages/${scopeId}`],
            },
          ],
        }),
      ).toEqual({mode: 'fallback', reason: 'resolution-surface-changed'});
    },
    {fastCheck: {numRuns: 100}},
  );

  it('candidate-scans static Swift and Bash global lookup keys', () => {
    for (const language of ['swift', 'bash'] as const) {
      const path = `scripts/${language}.${language === 'swift' ? 'swift' : 'sh'}`;
      const symbol: CodeGraphSymbol = {
        contentHash: 'hash',
        exported: true,
        id: language,
        kind: 'function',
        language,
        lookupKeys: [`${language}:q:consumer`],
        name: 'consumer',
        path,
        qualifiedName: 'consumer',
        resolutionDomain: language,
        span: {column: 1, endColumn: 2, endLine: 1, line: 1},
      };
      expect(
        assessProjectClosureSeeds({
          committedFacts: [facts(path, [], false)],
          effectiveFacts: [facts(path, [symbol], false)],
          projects: [],
        }),
      ).toMatchObject({
        candidateLookupKeys: [{key: `${language}:q:consumer`, resolutionDomain: language}],
        candidateScanRequired: true,
        mode: 'eligible',
      });
    }
  });

  fcProp(
    it,
    'candidate-scans only the canonical global lookup surface of existing Markdown headings',
    {
      reverseKeys: FC.boolean(),
      suffix: FC.integer({max: 100_000, min: 0}),
    },
    ({reverseKeys, suffix}) => {
      const path = `docs/surface-${suffix}.md`;
      const oldName = `Old${suffix}`;
      const newName = `New${suffix}`;
      const oldHeading = markdownHeading(path, oldName, reverseKeys, undefined);
      const newHeading = markdownHeading(path, newName, !reverseKeys, '@fixture/current');
      const oldFacts = facts(path, [oldHeading], false);
      const newFacts = facts(path, [newHeading], false);
      const expectedKeys = EffectArray.map(
        [...(oldHeading.lookupKeys ?? []), ...(newHeading.lookupKeys ?? [])].sort(),
        key => ({key, resolutionDomain: 'global'}),
      );

      expect(assessProjectClosureSeeds({committedFacts: [oldFacts], effectiveFacts: [newFacts], projects: []})).toEqual(
        {
          candidateLookupKeys: expectedKeys,
          candidateReexports: [],
          candidateScanRequired: true,
          mode: 'eligible',
          planningOperations: {ownershipChecks: 0, pathIndexProjects: 0},
          seedProjectIds: [],
        },
      );
      expect(
        assessProjectClosureSeeds({
          committedFacts: [facts(path, [], false)],
          effectiveFacts: [newFacts],
          projects: [],
        }),
      ).toMatchObject({candidateScanRequired: true, mode: 'eligible', seedProjectIds: []});
      expect(
        assessProjectClosureSeeds({
          committedFacts: [oldFacts],
          effectiveFacts: [facts(path, [], false)],
          projects: [],
        }),
      ).toMatchObject({candidateScanRequired: true, mode: 'eligible', seedProjectIds: []});

      for (const invalid of [
        {...oldHeading, kind: 'section'},
        {...oldHeading, lookupKeys: [...(oldHeading.lookupKeys ?? []), `global:alias:${oldName}`]},
        {...oldHeading, resolutionDomain: 'generic'},
        {...oldHeading, resolutionScopeId: 'unexpected-scope'},
      ]) {
        expect(
          assessProjectClosureSeeds({
            committedFacts: [facts(path, [invalid], false)],
            effectiveFacts: [facts(path, [], false)],
            projects: [],
          }),
        ).toEqual({mode: 'fallback', reason: 'resolution-surface-changed'});
      }
    },
    {fastCheck: {numRuns: 100}},
  );

  fcProp(
    it,
    'selects file-set closure seeds deterministically from added and deleted project paths',
    {
      currentMask: FC.integer({max: 65_535, min: 0}),
      deletedMask: FC.integer({max: 65_535, min: 0}),
      projectCount: FC.integer({max: 16, min: 1}),
      reverse: FC.boolean(),
    },
    ({currentMask, deletedMask, projectCount, reverse}) => {
      const boundedMask = (1 << projectCount) - 1;
      const maskedCurrent = currentMask & boundedMask;
      const effectiveDeletedMask = deletedMask & boundedMask;
      const effectiveCurrentMask = (maskedCurrent | effectiveDeletedMask) === 0 ? 1 : maskedCurrent;
      const projects = Array.from({length: projectCount}, (_, index) => project(`p${index}`));
      const paths = (mask: number) =>
        EffectArray.map(
          EffectArray.filter(projects, (_, index) => (mask & (1 << index)) !== 0),
          value => `${value.root}/index.ts`,
        );
      const expected = EffectArray.map(
        EffectArray.filter(
          projects,
          (_, index) => ((effectiveCurrentMask | effectiveDeletedMask) & (1 << index)) !== 0,
        ),
        value => value.id,
      ).sort();
      const input = {
        baseProjects: reverse ? [...projects].reverse() : projects,
        currentChangedPaths: reverse ? paths(effectiveCurrentMask).reverse() : paths(effectiveCurrentMask),
        currentProjects: reverse ? [...projects].reverse() : projects,
        deletedPaths: reverse ? paths(effectiveDeletedMask).reverse() : paths(effectiveDeletedMask),
      };
      const first = assessProjectFileSetClosureSeeds(input);
      const second = assessProjectFileSetClosureSeeds(input);

      expect(first).toEqual(second);
      expect(first).toMatchObject({mode: 'eligible', seedProjectIds: expected});
    },
    {fastCheck: {numRuns: 200}},
  );

  fcProp(
    it,
    'partitions local-only modifications from changed cross-file resolution surfaces deterministically',
    {
      changedMask: FC.integer({max: 65_535, min: 0}),
      fileCount: FC.integer({max: 16, min: 1}),
      reverse: FC.boolean(),
    },
    ({changedMask, fileCount, reverse}) => {
      const entries = Array.from({length: fileCount}, (_, index) => {
        const path = `packages/p${index}/index.ts`;
        const baselineSymbol = {
          ...symbol(`p${index}`, 1, [`typescript:p${index}:path:${encodeURIComponent(path)}:name:value${index}`]),
          id: `symbol-${index}`,
          name: `value${index}`,
          path,
          qualifiedName: `value${index}`,
        };
        const changed = (changedMask & (1 << index)) !== 0;
        return {
          changed,
          committed: facts(path, [baselineSymbol], false),
          effective: {
            ...facts(path, [{...baselineSymbol, arity: changed ? 2 : 1, contentHash: `current-${index}`}], false),
            diagnostics: [`diagnostic-${index}`],
          },
          path,
        };
      });
      const ordered = reverse ? [...entries].reverse() : entries;
      const partition = partitionProjectResolutionSurfaceChanges(
        EffectArray.map(ordered, entry => entry.committed),
        EffectArray.map(ordered, entry => entry.effective),
      );
      const changedPaths = EffectArray.map(
        EffectArray.filter(entries, (entry, __effectArrayIndex) => __effectArrayIndex in entries && entry.changed),
        entry => entry.path,
      ).sort();
      const stablePaths = EffectArray.map(
        EffectArray.filter(entries, entry => !entry.changed),
        entry => entry.path,
      ).sort();

      expect(
        EffectOption.getOrUndefined(
          EffectOption.map(EffectOption.fromNullishOr(partition?.changedCommittedFacts), __effectArrayReceiver =>
            EffectArray.map(__effectArrayReceiver, value => value.path),
          ),
        ),
      ).toEqual(changedPaths);
      expect(
        EffectOption.getOrUndefined(
          EffectOption.map(EffectOption.fromNullishOr(partition?.changedEffectiveFacts), __effectArrayReceiver =>
            EffectArray.map(__effectArrayReceiver, value => value.path),
          ),
        ),
      ).toEqual(changedPaths);
      expect(partition?.stablePaths).toEqual(stablePaths);
      expect(
        partitionProjectResolutionSurfaceChanges(
          EffectArray.map(ordered, entry => entry.committed),
          EffectArray.map(ordered.slice(1), entry => entry.effective),
        ),
      ).toBeUndefined();
    },
    {fastCheck: {numRuns: 100}},
  );

  fcProp(
    it,
    'ignores ambiguous ownership in resolution domains outside the changed file and seeded closure',
    {
      reverse: FC.boolean(),
      unrelatedProjectCount: FC.integer({max: 8, min: 2}),
    },
    ({reverse, unrelatedProjectCount}) => {
      const runtime = project('runtime');
      const path = `${runtime.root}/added.ts`;
      const unrelated = Array.from({length: unrelatedProjectCount}, (_, index) => ({
        ...project(`config-${index}`),
        dependencies: [`missing-${index}`],
        dependencyDetails: [],
        resolutionDomain: 'typescript-config',
        root: '',
        sourceRoots: [runtime.root],
      }));
      const projects = [runtime, ...(reverse ? unrelated.reverse() : unrelated)];
      const currentResolutionDomainByPath = new Map([[path, 'typescript']]);
      const canonicalSeeds = assessProjectFileSetClosureSeeds({
        baseProjects: [runtime],
        currentChangedPaths: [path],
        currentProjects: [runtime],
        currentResolutionDomainByPath,
        deletedPaths: [],
      });
      const mixedSeeds = assessProjectFileSetClosureSeeds({
        baseProjects: projects,
        currentChangedPaths: [path],
        currentProjects: projects,
        currentResolutionDomainByPath,
        deletedPaths: [],
      });
      const file = inventory(path, 1);
      const common = {
        cachedFactBytesByPath: new Map([[path, 1]]),
        files: [file],
        modifiedPaths: [path],
        seedProjectIds: [runtime.id],
        workspaceDiagnostics: [] as readonly string[],
      };

      expect(canonicalSeeds).toMatchObject({mode: 'eligible', seedProjectIds: [runtime.id]});
      expect(mixedSeeds).toMatchObject({
        mode: 'eligible',
        planningOperations: {ownershipChecks: 1},
        seedProjectIds: [runtime.id],
      });
      expect(planProjectIncrementalClosure({...common, projects})).toEqual(
        planProjectIncrementalClosure({...common, projects: [runtime]}),
      );
    },
    {fastCheck: {numRuns: 100}},
  );

  fcProp(
    it,
    'admits an unowned resolver domain deterministically without exposing changed paths',
    {
      pathCount: FC.integer({max: 16, min: 1}),
      reverse: FC.boolean(),
    },
    ({pathCount, reverse}) => {
      const runtime = project('runtime');
      const paths = Array.from({length: pathCount}, (_, index) => `docs/private-${index}.md`);
      const orderedPaths = reverse ? [...paths].reverse() : paths;
      const result = assessProjectFileSetClosureSeeds({
        baseProjects: [runtime],
        currentChangedPaths: orderedPaths,
        currentProjects: [runtime],
        currentResolutionDomainByPath: new Map(EffectArray.map(paths, path => [path, 'documentation'])),
        deletedPaths: [],
      });

      expect(result).toEqual({
        mode: 'eligible',
        planningOperations: {ownershipChecks: 0, pathIndexProjects: 2},
        seedProjectIds: [],
        unownedResolutionDomains: ['documentation'],
      });
      expect(
        assessProjectFileSetClosureSeeds({
          baseProjects: [runtime],
          currentChangedPaths: [],
          currentProjects: [runtime],
          deletedPaths: orderedPaths,
          deletedResolutionDomainByPath: new Map(EffectArray.map(paths, path => [path, 'documentation'])),
        }),
      ).toEqual(result);
      expect(JSON.stringify(result)).not.toContain('private-');
    },
    {fastCheck: {numRuns: 100}},
  );

  it('fails closed when a file-set change lacks stable declared ownership in both workspace models', () => {
    const declared = project('a');
    const input = {
      baseProjects: [declared],
      currentChangedPaths: ['packages/a/added.ts'],
      currentProjects: [declared],
      deletedPaths: [] as readonly string[],
    };

    expect(assessProjectFileSetClosureSeeds({...input, currentChangedPaths: ['unowned.ts']})).toEqual({
      fallbackDetail: 'path-unowned',
      mode: 'fallback',
      reason: 'project-closure-incomplete',
    });
    expect(
      assessProjectFileSetClosureSeeds({
        ...input,
        currentProjects: [{...declared, provenance: 'inferred'}],
      }),
    ).toEqual({fallbackDetail: 'project-model-incomplete', mode: 'fallback', reason: 'project-closure-incomplete'});
    expect(assessProjectFileSetClosureSeeds({...input, currentProjects: []})).toEqual({
      fallbackDetail: 'path-unowned',
      mode: 'fallback',
      reason: 'project-closure-incomplete',
    });
    expect(assessProjectFileSetClosureSeeds({...input, baseProjects: []})).toEqual({
      fallbackDetail: 'project-not-stable',
      mode: 'fallback',
      reason: 'project-closure-incomplete',
    });
    expect(assessProjectFileSetClosureSeeds({...input, currentProjects: [declared, declared]})).toEqual({
      fallbackDetail: 'duplicate-project-identity',
      mode: 'fallback',
      reason: 'project-closure-incomplete',
    });
  });

  it('fails closed for inferred, ambiguous, diagnostic, incomplete, missing-cache, and oversized closure evidence', () => {
    const base = project('a');
    const file = inventory('packages/a/index.ts', 1);
    const common = {
      cachedFactBytesByPath: new Map([[file.path, 1]]),
      files: [file],
      modifiedPaths: [file.path],
      seedProjectIds: ['a'],
      workspaceDiagnostics: [] as readonly string[],
    };

    expect(planProjectIncrementalClosure({...common, projects: [{...base, provenance: 'inferred'}]})).toEqual({
      mode: 'fallback',
      reason: 'project-closure-incomplete',
    });
    expect(planProjectIncrementalClosure({...common, projects: [base], workspaceDiagnostics: ['ambiguous']})).toEqual({
      mode: 'fallback',
      reason: 'project-closure-incomplete',
    });
    expect(
      planProjectIncrementalClosure({
        ...common,
        projects: [{...base, dependencies: ['missing'], dependencyDetails: []}],
      }),
    ).toEqual({mode: 'fallback', reason: 'project-closure-incomplete'});
    expect(planProjectIncrementalClosure({...common, cachedFactBytesByPath: new Map(), projects: [base]})).toEqual({
      mode: 'fallback',
      reason: 'cache-incomplete',
    });
    expect(
      planProjectIncrementalClosure({
        ...common,
        cachedFactBytesByPath: new Map([[file.path, 8 * 1_048_576 + 1]]),
        projects: [base],
      }),
    ).toEqual({
      fallbackBoundary: {
        changedFiles: 1,
        limit: 8 * 1_048_576,
        metric: 'cached-fact-bytes',
        observedAtDecision: 8 * 1_048_576 + 1,
        stage: 'project-closure-selection',
      },
      mode: 'fallback',
      reason: 'project-closure-unbounded',
    });
    const aggregateBudgetFiles = [
      inventory('packages/a/one.ts', 1),
      inventory('packages/a/two.ts', 1),
      inventory('packages/a/three.ts', 1),
      inventory('packages/a/four.ts', 1),
      inventory('packages/a/five.ts', 1),
    ];
    expect(
      planProjectIncrementalClosure({
        ...common,
        cachedFactBytesByPath: new Map(
          EffectArray.map(aggregateBudgetFiles.slice(0, 4), value => [value.path, 8 * 1_048_576]),
        ),
        files: aggregateBudgetFiles.slice(0, 4),
        modifiedPaths: [aggregateBudgetFiles[0].path],
        projects: [base],
      }),
    ).toMatchObject({cachedFactBytes: 32 * 1_048_576, mode: 'eligible'});
    expect(
      planProjectIncrementalClosure({
        ...common,
        cachedFactBytesByPath: new Map(
          EffectArray.map(aggregateBudgetFiles, (value, index) => [value.path, index === 4 ? 1 : 8 * 1_048_576]),
        ),
        files: aggregateBudgetFiles,
        modifiedPaths: [aggregateBudgetFiles[0].path],
        projects: [base],
      }),
    ).toEqual({
      fallbackBoundary: {
        changedFiles: 1,
        limit: 32 * 1_048_576,
        metric: 'cached-fact-bytes',
        observedAtDecision: 32 * 1_048_576 + 1,
        stage: 'project-closure-selection',
      },
      mode: 'fallback',
      reason: 'project-closure-unbounded',
    });
    expect(
      planProjectIncrementalClosure({
        ...common,
        files: [inventory(file.path, 16 * 1_048_576 + 1)],
        projects: [base],
      }),
    ).toEqual({
      fallbackBoundary: {
        changedFiles: 1,
        limit: 16 * 1_048_576,
        metric: 'source-bytes',
        observedAtDecision: 16 * 1_048_576 + 1,
        stage: 'project-closure-selection',
      },
      mode: 'fallback',
      reason: 'project-closure-unbounded',
    });
    expect(
      planProjectIncrementalClosure({
        ...common,
        cachedFactBytesByPath: new Map(
          Array.from({length: 129}, (_, index) => [`packages/a/file-${index}.ts`, 1] as const),
        ),
        files: Array.from({length: 129}, (_, index) => inventory(`packages/a/file-${index}.ts`, 1)),
        modifiedPaths: ['packages/a/file-0.ts'],
        projects: [base],
      }),
    ).toEqual({
      fallbackBoundary: {
        changedFiles: 1,
        limit: 128,
        metric: 'affected-files',
        observedAtDecision: 129,
        stage: 'project-closure-selection',
      },
      mode: 'fallback',
      reason: 'project-closure-unbounded',
    });
    expect(planProjectIncrementalClosure({...common, projects: [{...base, diagnostics: ['unreconciled']}]})).toEqual({
      mode: 'fallback',
      reason: 'project-closure-incomplete',
    });
    expect(
      planProjectIncrementalClosure({
        ...common,
        projects: [base, {...project('b'), root: base.root, sourceRoots: base.sourceRoots}],
      }),
    ).toEqual({mode: 'fallback', reason: 'project-closure-incomplete'});

    const left = facts(
      file.path,
      [{...symbol('a', 1, ['typescript:a:path:a:name:foo']), resolutionScopeId: undefined}],
      true,
    );
    const right = facts(
      file.path,
      [{...symbol('a', 2, ['typescript:a:path:b:name:foo']), resolutionScopeId: undefined}],
      true,
    );
    expect(assessProjectClosureSeeds({committedFacts: [left], effectiveFacts: [right], projects: [base]})).toEqual({
      mode: 'fallback',
      reason: 'project-closure-incomplete',
    });
    expect(
      assessProjectClosureSeeds({
        committedFacts: [left],
        effectiveFacts: [right, facts('packages/a/extra.ts', [], false)],
        projects: [base],
      }),
    ).toEqual({mode: 'fallback', reason: 'resolution-surface-changed'});
    const dynamic = {
      ...left,
      references: EffectOption.getOrUndefined(
        EffectOption.map(EffectOption.fromNullishOr(left.references), __effectArrayReceiver =>
          EffectArray.map(__effectArrayReceiver, reference => ({...reference, relation: 'calls' as const})),
        ),
      ),
    };
    expect(assessProjectClosureSeeds({committedFacts: [dynamic], effectiveFacts: [dynamic], projects: [base]})).toEqual(
      {
        mode: 'fallback',
        reason: 'dynamic-aliases',
      },
    );
  });

  it('still fails closed for malformed structural dependency evidence', () => {
    const target = project('b');
    const declared = {evidence: 'packages/a/package.json', provenance: 'declared' as const, targetId: 'b'};
    const malformedProjects = [
      [{...project('a', ['b']), dependencyDetails: []}, target],
      [{...project('a'), dependencyDetails: [declared]}, target],
      [{...project('a', ['b']), dependencyDetails: [{...declared, provenance: 'inferred' as const}]}, target],
      [project('a', ['missing']), target],
      [{...project('a', ['b']), dependencies: ['b', 'b']}, target],
    ];
    const files = [inventory('packages/a/index.ts', 1), inventory('packages/b/index.ts', 1)];
    const common = {
      cachedFactBytesByPath: new Map(EffectArray.map(files, file => [file.path, 1])),
      files,
      modifiedPaths: ['packages/a/index.ts'],
      seedProjectIds: ['a'],
      workspaceDiagnostics: [] as readonly string[],
    };

    for (const projects of malformedProjects) {
      expect(planProjectIncrementalClosure({...common, projects})).toEqual({
        mode: 'fallback',
        reason: 'project-closure-incomplete',
      });
    }
  });

  fcProp(
    it,
    'keeps file-set seeds and closure unchanged when declared evidence is added or reordered for existing targets',
    {
      evidenceCopies: FC.integer({max: 5, min: 1}),
      projectCount: FC.integer({max: 8, min: 2}),
      reverseEvidence: FC.boolean(),
      seed: FC.integer({max: 100_000, min: 0}),
    },
    ({evidenceCopies, projectCount, reverseEvidence, seed}) => {
      const projects = Array.from({length: projectCount}, (_, index) =>
        project(`p${index}`, index === 0 ? [] : [`p${index - 1}`]),
      );
      const enrichedProjects = EffectArray.map(projects, value => ({
        ...value,
        dependencyDetails: EffectArray.flatMap(value.dependencyDetails, dependency => {
          const evidence = [
            dependency,
            ...Array.from({length: evidenceCopies}, (_, index) => ({
              ...dependency,
              evidence: `packages/${value.id}/dependency-evidence-${index}.json`,
            })),
          ];
          return reverseEvidence ? evidence.reverse() : evidence;
        }),
      }));
      const seedProject = projects[seed % projectCount];
      const changedPath = `${seedProject.root}/index.ts`;
      const files = EffectArray.map(projects, value => inventory(`${value.root}/index.ts`, 1));
      const canonicalSeeds = assessProjectFileSetClosureSeeds({
        baseProjects: projects,
        currentChangedPaths: [changedPath],
        currentProjects: projects,
        deletedPaths: [],
      });
      const enrichedSeeds = assessProjectFileSetClosureSeeds({
        baseProjects: projects,
        currentChangedPaths: [changedPath],
        currentProjects: enrichedProjects,
        deletedPaths: [],
      });
      const common = {
        cachedFactBytesByPath: new Map(EffectArray.map(files, file => [file.path, 1])),
        files,
        modifiedPaths: [changedPath],
        seedProjectIds: [seedProject.id],
        workspaceDiagnostics: [] as readonly string[],
      };
      const canonicalPlan = planProjectIncrementalClosure({...common, projects});

      expect(canonicalSeeds.mode).toBe('eligible');
      expect(enrichedSeeds).toEqual(canonicalSeeds);
      expect(canonicalPlan.mode).toBe('eligible');
      expect(planProjectIncrementalClosure({...common, projects: enrichedProjects})).toEqual(canonicalPlan);
    },
    {fastCheck: {numRuns: 100}},
  );

  fcProp(
    it,
    'is deterministic, order-independent, idempotent, seed-containing, monotone, and equal to an independent reverse model',
    {
      adjacency: FC.array(FC.integer({max: 63, min: 0}), {maxLength: 6, minLength: 1}),
      dependencyPriorities: FC.array(FC.integer(), {maxLength: 6, minLength: 6}),
      filePriorities: FC.array(FC.integer(), {maxLength: 6, minLength: 6}),
      priorities: FC.array(FC.integer(), {maxLength: 6, minLength: 6}),
      seedPriorities: FC.array(FC.integer(), {maxLength: 6, minLength: 6}),
      seedMask: FC.integer({max: 63, min: 1}),
    },
    ({adjacency, dependencyPriorities, filePriorities, priorities, seedMask, seedPriorities}) => {
      const count = adjacency.length;
      const ids = Array.from({length: count}, (_, index) => `p${index}`);
      const projects = EffectArray.map(ids, (id, source) =>
        project(
          id,
          EffectArray.filter(ids, (_, target) => target !== source && (adjacency[source] & (1 << target)) !== 0),
        ),
      );
      const seeds = EffectArray.filter(ids, (_, index) => (seedMask & (1 << index)) !== 0);
      const firstSeed = seeds[0] ?? ids[0];
      const expected = independentReverseClosure(projects, seeds.length > 0 ? seeds : [firstSeed]);
      const files = EffectArray.map(ids, id => inventory(`packages/${id}/index.ts`, 1));
      const bytes = new Map(EffectArray.map(files, file => [file.path, 1]));
      const shuffled = EffectArray.map(
        EffectArray.map(projects, (value, index) => ({
          index,
          priority: priorities[index] ?? 0,
          value: {
            ...value,
            dependencies:
              (dependencyPriorities[index] ?? 0) < 0 ? [...value.dependencies].reverse() : value.dependencies,
            dependencyDetails:
              (dependencyPriorities[index] ?? 0) >= 0
                ? [...value.dependencyDetails].reverse()
                : value.dependencyDetails,
          },
        })).sort((left, right) => left.priority - right.priority || left.index - right.index),
        entry => entry.value,
      );
      const shuffledFiles = EffectArray.map(
        EffectArray.map(files, (value, index) => ({index, priority: filePriorities[index] ?? 0, value})).sort(
          (left, right) => left.priority - right.priority || left.index - right.index,
        ),
        entry => entry.value,
      );
      const shuffledSeeds = EffectArray.map(
        EffectArray.map(seeds.length > 0 ? seeds : [firstSeed], value => ({
          priority: seedPriorities[ids.indexOf(value)] ?? 0,
          value,
        })).sort(
          (left, right) =>
            left.priority - right.priority || Effect.pipe(left.value, EffectString.localeCompare(right.value)),
        ),
        entry => entry.value,
      );
      const canonical = planProjectIncrementalClosure({
        cachedFactBytesByPath: bytes,
        files,
        modifiedPaths: [`packages/${firstSeed}/index.ts`],
        projects,
        seedProjectIds: seeds.length > 0 ? seeds : [firstSeed],
        workspaceDiagnostics: [],
      });
      const input = {
        cachedFactBytesByPath: bytes,
        files: shuffledFiles,
        modifiedPaths: [`packages/${firstSeed}/index.ts`],
        projects: shuffled,
        seedProjectIds: shuffledSeeds,
        workspaceDiagnostics: [] as readonly string[],
      };
      const once = planProjectIncrementalClosure(input);
      const twice = planProjectIncrementalClosure(input);

      expect(once).toEqual(twice);
      expect(once).toEqual(canonical);
      expect(once.mode).toBe('eligible');
      if (once.mode !== 'eligible') return;
      expect(planProjectIncrementalClosure({...input, seedProjectIds: once.projectIds})).toEqual(once);
      expect(once.projectIds).toEqual([...expected].sort());
      expect(EffectArray.every(seeds, seed => once.projectIds.includes(seed))).toBe(true);

      const expanded = planProjectIncrementalClosure({...input, seedProjectIds: ids});
      expect(expanded.mode).toBe('eligible');
      if (expanded.mode === 'eligible') {
        expect(EffectArray.every(once.projectIds, id => expanded.projectIds.includes(id))).toBe(true);
      }
      const missingEdge = EffectOption.getOrUndefined(
        EffectArray.findFirst(
          EffectArray.flatMap(projects, source => EffectArray.map(ids, targetId => ({source, targetId}))),
          ({source, targetId}) => source.id !== targetId && !source.dependencies.includes(targetId),
        ),
      );
      if (missingEdge) {
        const edgeExpanded = planProjectIncrementalClosure({
          ...input,
          projects: EffectArray.map(projects, value =>
            value.id === missingEdge.source.id
              ? {
                  ...value,
                  dependencies: [...value.dependencies, missingEdge.targetId],
                  dependencyDetails: [
                    ...value.dependencyDetails,
                    {
                      evidence: `packages/${value.id}/package.json`,
                      provenance: 'declared' as const,
                      targetId: missingEdge.targetId,
                    },
                  ],
                }
              : value,
          ),
        });
        expect(edgeExpanded.mode).toBe('eligible');
        if (edgeExpanded.mode === 'eligible') {
          expect(EffectArray.every(once.projectIds, id => edgeExpanded.projectIds.includes(id))).toBe(true);
        }
      }
    },
    {fastCheck: {numRuns: 200}},
  );

  it('plans 5,000 projects and 60,000 paths within the broad scaling ceiling', () => {
    const projectCount = 5_000;
    const projects = Array.from({length: projectCount}, (_, index) =>
      project(`p${index}`, index === 0 ? [] : [`p${index - 1}`]),
    );
    const files = Array.from({length: 60_000}, (_, index) =>
      inventory(`packages/p${index % projectCount}/file-${index}.ts`, 1),
    );
    const plan = planProjectIncrementalClosure({
      cachedFactBytesByPath: new Map(EffectArray.map(files, file => [file.path, 1])),
      files,
      maxCachedFactBytes: 100_000,
      maxFiles: 100_000,
      maxSourceBytes: 100_000,
      modifiedPaths: ['packages/p4999/file-4999.ts'],
      projects,
      seedProjectIds: ['p4999'],
      workspaceDiagnostics: [],
    });

    expect(plan.mode).toBe('eligible');
    if (plan.mode === 'eligible') {
      expect(plan.planningOperations).toEqual({dependencyEdges: 4_999, pathOwnershipChecks: 60_000});
    }
  });

  it('indexes seed ownership once across 5,000 projects and dense bounded facts', () => {
    const projects = Array.from({length: 5_000}, (_, index) => project(`p${index}`));
    const path = 'packages/p4999/index.ts';
    const template = {
      ...facts(path, [], true).references![0],
      aliasLookupKeys: ['typescript:p4999:path:packages%2Fp4999%2Findex.ts:name:foo'],
    };
    const denseFacts: CodeGraphFileFacts = {
      diagnostics: [],
      edges: [],
      path,
      references: Array.from({length: 2_048}, (_, index) => ({...template, edgeId: `edge-${index}`})),
      symbols: [],
    };
    const assessment = assessProjectClosureSeeds({
      committedFacts: [denseFacts],
      effectiveFacts: [denseFacts],
      projects,
    });

    expect(assessment).toEqual({
      candidateLookupKeys: [],
      candidateReexports: [],
      mode: 'eligible',
      planningOperations: {ownershipChecks: 4_096, pathIndexProjects: 5_000},
      seedProjectIds: ['p4999'],
    });
  });

  it('seeds only the symmetric-diff entry of a large otherwise-unchanged barrel', () => {
    const path = 'packages/barrel/index.ts';
    const reference = (index: number) => ({
      ...facts(path, [], true).references![0],
      aliasLookupKeys: [`typescript:barrel:path:${encodeURIComponent(path)}:name:alias${index}`],
      edgeId: `edge-${index}`,
      lookupTiers: [[`typescript:barrel:path:${encodeURIComponent(`packages/core/value-${index}.ts`)}:name:value`]],
    });
    const stable = Array.from({length: 500}, (_, index) => reference(index));
    const committed: CodeGraphFileFacts = {...facts(path, [], false), references: stable};
    const effective: CodeGraphFileFacts = {...facts(path, [], false), references: [...stable, reference(500)]};
    const assessment = assessProjectClosureSeeds({
      committedFacts: [committed],
      effectiveFacts: [effective],
      projects: [project('barrel')],
    });

    expect(assessment).toMatchObject({
      candidateReexports: [
        {
          sourcePath: path,
        },
      ],
      mode: 'eligible',
      seedProjectIds: ['barrel'],
    });
    expect(assessment.mode === 'eligible' ? assessment.candidateLookupKeys : []).toHaveLength(2);
  });

  it('resolves a 10,000-hop persisted reexport chain iteratively within a structural operation cap', () => {
    const reexports = Array.from({length: 10_000}, (_, index) => reexport(`p${index}`, 'foo', `p${index + 1}`, 'foo'));
    const result = resolvePersistedReexportTerminals({name: 'foo', path: 'p0'}, provenance(reexports), {
      maxOperations: 20_001,
    });

    expect(result).toEqual({
      mode: 'complete',
      operations: 20_001,
      targets: [{name: 'foo', path: 'p10000'}],
    });
  });

  it('deduplicates reconvergent reexport diamonds and preserves cycle-only seeds independent of row order', () => {
    const diamond = [
      reexport('a', 'foo', 'b', 'foo'),
      reexport('a', 'foo', 'c', 'foo'),
      reexport('b', 'foo', 'd', 'foo'),
      reexport('c', 'foo', 'd', 'foo'),
      reexport('d', 'foo', 'sink', 'value'),
    ];
    const cycle = [reexport('x', 'foo', 'y', 'foo'), reexport('y', 'foo', 'x', 'foo')];

    const forward = resolvePersistedReexportTerminals({name: 'foo', path: 'a'}, provenance(diamond));
    const reverse = resolvePersistedReexportTerminals({name: 'foo', path: 'a'}, provenance([...diamond].reverse()));
    expect(reverse).toEqual(forward);
    expect(forward).toMatchObject({mode: 'complete', targets: [{name: 'value', path: 'sink'}]});
    expect(resolvePersistedReexportTerminals({name: 'foo', path: 'x'}, provenance(cycle))).toMatchObject({
      mode: 'complete',
      targets: [{name: 'foo', path: 'x'}],
    });
    expect(
      resolvePersistedReexportTerminals({name: 'foo', path: 'a'}, provenance(diamond), {maxOperations: 3}),
    ).toEqual({mode: 'fallback', reason: 'reexport-closure-unbounded'});
  });
});

function transitionProject(id: string, root: string, dependencies: readonly string[] = []): CodeGraphWorkspaceProject {
  return {
    ...project(id, dependencies),
    buildSystem: 'node',
    root,
    sourceRoots: [root],
    workspaceId: 'workspace',
    workspaceRoots: ['packages'],
  };
}
function transitionSide(
  projects: readonly CodeGraphWorkspaceProject[],
  files: readonly {
    path: string;
    size: number;
    resolutionDomains: readonly string[];
    hasWorkspacePackageSymbol: boolean;
  }[],
) {
  const workspaces = [
    ...new Map(
      EffectArray.map(projects, value => [
        value.workspaceId,
        {
          buildSystem: value.buildSystem,
          diagnostics: [],
          id: value.workspaceId,
          name: value.workspaceId,
          provenance: 'declared' as const,
          root: value.workspaceRoots[0] ?? value.root,
        },
      ]),
    ).values(),
  ];
  return {workspace: {...workspace(projects), workspaces}, files, inventoryComplete: true};
}

function oracleAffectedPaths(
  projects: readonly CodeGraphWorkspaceProject[],
  files: readonly {path: string; resolutionDomains: readonly string[]; hasWorkspacePackageSymbol: boolean}[],
  closure: ReadonlySet<string>,
): string[] {
  return EffectArray.map(
    EffectArray.filter(
      files,
      __effectArrayValue =>
        !!(file => {
          const domains = [...file.resolutionDomains, ...(file.hasWorkspacePackageSymbol ? ['workspace'] : [])];
          return EffectArray.some(domains, domain => {
            const owner = oracleOwner(projects, file.path, domain);
            return owner !== undefined && closure.has(owner.id);
          });
        })(__effectArrayValue),
    ),
    file => file.path,
  ).sort();
}

function oracleOwner(
  projects: readonly CodeGraphWorkspaceProject[],
  path: string,
  domain: string,
): CodeGraphWorkspaceProject | undefined {
  const eligible = EffectArray.filter(
    projects,
    __effectArrayValue =>
      !!(value =>
        domain === 'workspace'
          ? value.buildSystem === 'node' || value.buildSystem === 'pnpm'
          : value.resolutionDomain === domain ||
            (domain === 'bazel' &&
              EffectArray.some(value.languages, language => language === 'bazel' || language === 'starlark')))(
        __effectArrayValue,
      ),
  );
  const find = (rootsFor: (project: CodeGraphWorkspaceProject) => readonly string[]) => {
    const matches = EffectArray.flatMap(eligible, project =>
      EffectArray.map(
        EffectArrayPipe(rootsFor(project), __effectArrayValues =>
          EffectArray.filter(
            __effectArrayValues,
            (root, __effectArrayIndex2) =>
              __effectArrayIndex2 in __effectArrayValues &&
              (root === '' || path === root || Effect.pipe(path, EffectString.startsWith(`${root}/`))),
          ),
        ),
        root => ({project, root}),
      ),
    );
    matches.sort(
      (left, right) =>
        right.root.length - left.root.length ||
        Effect.pipe(left.project.id, EffectString.localeCompare(right.project.id)),
    );
    return matches[0]?.project;
  };
  return find(project => project.sourceRoots) ?? find(project => [project.root]);
}

function project(id: string, dependencies: readonly string[] = []): CodeGraphWorkspaceProject {
  return {
    buildSystem: 'node',
    dependencies,
    dependencyDetails: EffectArray.map(dependencies, targetId => ({
      evidence: `packages/${id}/package.json`,
      provenance: 'declared',
      targetId,
    })),
    diagnostics: [],
    id,
    kind: 'package',
    languages: ['typescript'],
    name: id,
    provenance: 'declared',
    resolutionDomain: 'typescript',
    root: `packages/${id}`,
    sourceRoots: [`packages/${id}`],
    workspaceId: 'workspace',
    workspaceRoots: [''],
  };
}

function workspace(projects: readonly CodeGraphWorkspaceProject[]): CodeGraphWorkspace {
  return {diagnostics: [], fingerprint: 'test-workspace', projects, workspaces: []};
}

function inventory(path: string, size: number): CodeGraphInventoryFile {
  return {
    blobId: path,
    contentHash: path,
    language: 'typescript',
    mode: '100644',
    path,
    size,
    source: 'worktree',
  };
}

function symbol(scopeId: string, arity: number, lookupKeys: readonly string[]): CodeGraphSymbol {
  return {
    arity,
    contentHash: 'hash',
    exported: true,
    id: 'symbol',
    kind: 'function',
    language: 'typescript',
    lookupKeys,
    name: 'foo',
    packageName: scopeId,
    path: `packages/${scopeId}/index.ts`,
    qualifiedName: 'foo',
    resolutionDomain: 'typescript',
    resolutionScopeId: scopeId,
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
  };
}

function markdownHeading(
  path: string,
  name: string,
  reverseKeys: boolean,
  packageName: string | undefined,
): CodeGraphSymbol {
  const qualifiedName = `${path}#${Effect.pipe(name, EffectString.toLowerCase)}`;
  const lookupKeys = [
    `global:qualified:${encodeURIComponent(qualifiedName)}`,
    `global:name:${encodeURIComponent(name)}`,
  ];
  return {
    contentHash: 'hash',
    exported: true,
    id: `heading-${qualifiedName}`,
    kind: 'heading',
    language: 'markdown',
    lookupKeys: reverseKeys ? lookupKeys.reverse() : lookupKeys,
    name,
    packageName,
    path,
    qualifiedName,
    resolutionDomain: 'documentation',
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
  };
}

function facts(path: string, symbols: readonly CodeGraphSymbol[], reexport: boolean): CodeGraphFileFacts {
  return {
    diagnostics: [],
    edges: [],
    path,
    references: reexport
      ? [
          {
            aliasLookupKeys: ['typescript:barrel:path:packages%2Fbarrel%2Findex.ts:name:foo'],
            edgeId: 'edge',
            evidencePath: path,
            evidenceSpan: {column: 1, endColumn: 2, endLine: 1, line: 1},
            lookupTiers: [['typescript:barrel:path:packages%2Fcore%2Findex.ts:name:foo']],
            provenance: 'syntactic',
            relation: 'reexports',
            resolutionDomain: 'typescript',
            sourceName: 'barrel',
            targetName: './core.js',
          },
        ]
      : [],
    symbols,
  };
}

function independentReverseClosure(
  projects: readonly CodeGraphWorkspaceProject[],
  seeds: readonly string[],
): ReadonlySet<string> {
  const closure = new Set(seeds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const project of projects) {
      if (closure.has(project.id)) continue;
      if (EffectArray.some(project.dependencies, dependency => closure.has(dependency))) {
        closure.add(project.id);
        changed = true;
      }
    }
  }
  return closure;
}

function reexport(
  sourcePath: string,
  localName: string,
  targetPath: string,
  importedName: string,
): CodeGraphReusableReexport {
  return {importedName, localName, sourcePath, targetPath};
}

function provenance(
  reexports: readonly CodeGraphReusableReexport[],
): ReadonlyMap<string, readonly CodeGraphReusableReexport[]> {
  const output = new Map<string, CodeGraphReusableReexport[]>();
  for (const value of reexports) {
    const key = `${value.sourcePath}\0${value.localName}`;
    const entries = output.get(key) ?? [];
    entries.push(value);
    output.set(key, entries);
  }
  return output;
}
