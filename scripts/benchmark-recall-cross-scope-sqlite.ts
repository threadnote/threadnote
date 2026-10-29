import {Array as EffectArray} from 'effect';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Clock, DateTime, Effect, FileSystem, Path} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {runCommandEffect} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {benchmarkMeasurement} from '@threadnote/evidence/benchmark';
import {
  loadRecallIndexData,
  loadRecallIndexDataBatch,
  type RecallIndexQueryDiagnostics,
} from '@threadnote/recall/index';
import {
  mergeRecallCandidateLanes,
  mergeRecallIndexCandidates,
  prioritizeCrossScopeRecallCandidates,
  prioritizeWorkspaceRecallCandidates,
  recallCrossScopeFallbackRequired,
  recallCrossScopeLaneBudgets,
} from '@threadnote/recall/runtime';
import {recallIndexPreselectionLimit} from '@threadnote/recall/results';
import {getThreadnoteVersion} from '@threadnote/workspace/runtime-version';
import {atomicWrite, fixtureHash, printJson, scriptArguments} from './effect/script.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Option as EffectOption} from 'effect';

const FIXED_NOW = new Date('2026-08-20T00:00:00.000Z');
const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const PROJECT = 'sqlite-cross-scope-bench';
const NO_SIBLING_PROJECT = 'sqlite-no-sibling-bench';
const CURRENT_SCOPE = 'apps/search';
const SIBLING_SCOPE = 'apps/billing';
const SCENARIOS = ['common-balanced', 'selective-sibling', 'buried-common-sibling', 'common-no-sibling'] as const;
const PROFILES = ['global-only', 'preferred-plus-global'] as const;
const MODES = ['no-challenger-reference', 'evidence-gated', 'always-query-reference'] as const;

type Scenario = (typeof SCENARIOS)[number];
type Profile = (typeof PROFILES)[number];
type Mode = (typeof MODES)[number];

interface PassResult {
  readonly admittedCandidates: number;
  readonly crossCandidates: number;
  readonly fallbackCandidates: number;
  readonly fallbackPostingRows: number;
  readonly fallbackPostingStatements: number;
  readonly fallbackQueries: number;
  readonly initialPostingRows: number;
  readonly initialPostingStatements: number;
  readonly initialSelections: number;
  readonly protectedCandidates: number;
  readonly targetAdmitted: boolean | null;
}

const benchmarkRecallCrossScopeSqlite = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const options = parseRecallCrossScopeSqliteBenchmarkArguments(yield* scriptArguments());
  const home = yield* fs.makeTempDirectory({prefix: 'threadnote-recall-cross-scope-sqlite-'});
  const benchmark = Effect.gen(function* () {
    const fixture = yield* writeFixture(fs, path, home, options.documents);
    const config = {account: 'local', agentContextHome: home, user: 'benchmark'};
    yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: false, limit: 0, query: ''});

    for (let index = 0; index < options.warmups; index += 1) {
      for (const scenario of SCENARIOS) {
        for (const profile of PROFILES) {
          for (const mode of MODES) yield* runPass(config, fixture, options.topK, scenario, profile, mode);
        }
      }
    }

    const durations = new Map<string, number[]>();
    const summaries = new Map<string, PassResult>();
    for (let sample = 0; sample < options.samples; sample += 1) {
      for (const scenario of SCENARIOS) {
        for (const profile of PROFILES) {
          for (const mode of rotatedModes(sample)) {
            const key = passKey(scenario, profile, mode);
            const startedAt = yield* Clock.currentTimeNanos;
            const result = yield* runPass(config, fixture, options.topK, scenario, profile, mode);
            const finishedAt = yield* Clock.currentTimeNanos;
            const values = durations.get(key) ?? [];
            values.push(Number(finishedAt - startedAt) / NANOSECONDS_PER_MILLISECOND);
            durations.set(key, values);
            summaries.set(key, result);
          }
        }
      }
      yield* Effect.yieldNow;
    }

    const [commit, status, hardware, sourceVersion, hash] = yield* Effect.all(
      [
        git(['rev-parse', 'HEAD']),
        git(['status', '--porcelain']),
        system.hardwareInfo,
        getThreadnoteVersion(),
        fixtureHash(JSON.stringify({fixtureManifestSha256: fixture.manifestSha256, topK: options.topK})),
      ],
      {concurrency: 'unbounded'},
    );
    const artifact = {
      createdAt: DateTime.formatIso(yield* DateTime.now),
      environment: {
        architecture: system.architecture,
        commit,
        cpu: hardware.cpuModel,
        dirty: status.length > 0,
        fixtureHash: hash,
        memoryBytes: hardware.memoryBytes,
        operatingSystem: hardware.operatingSystem,
        runtime: `bun/${system.runtimeVersion}`,
      },
      measurements: EffectArray.map([...durations], ([key, values]) =>
        benchmarkMeasurement(`${key}-sqlite-latency`, 'milliseconds', values),
      ),
      metadata: {
        sourceVersion: `threadnote-${sourceVersion}`,
        timingScope:
          'per-pass wall time after fixture indexing and configured warmups for one production-shaped topical plus protected-workspace batch, in-process lane prioritization and bounded admission, and any conditional sibling fallback; fixture/index build, branch and semantic selections, reranking, and final section construction excluded',
      },
      shape: {
        laneBudgets: recallCrossScopeLaneBudgets(options.topK),
        mainDocuments: fixture.mainDocuments,
        noSiblingDocuments: fixture.noSiblingDocuments,
        profiles: PROFILES,
        scenarios: SCENARIOS,
        totalIndexedDocuments: fixture.mainDocuments + fixture.noSiblingDocuments,
        topK: options.topK,
      },
      suite: 'recall-cross-scope-sqlite',
      summaries: EffectRecord.fromEntries(summaries),
      version: 1,
      warmups: options.warmups,
    };
    if (options.outputPath) yield* atomicWrite(options.outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
    yield* printJson(artifact);
  });
  yield* benchmark.pipe(Effect.ensuring(fs.remove(home, {force: true, recursive: true}).pipe(Effect.ignore)));
});

function runPass(
  config: {readonly account: string; readonly agentContextHome: string; readonly user: string},
  fixture: RecallSqliteFixture,
  topK: number,
  scenario: Scenario,
  profile: Profile,
  mode: Mode,
) {
  return Effect.gen(function* () {
    const query = scenarioQuery(scenario);
    const project = scenarioProject(scenario);
    let initialPostingRows = 0;
    let initialPostingStatements = 0;
    let fallbackPostingRows = 0;
    let fallbackPostingStatements = 0;
    const diagnostics = (lane: 'initial' | 'fallback') => (event: RecallIndexQueryDiagnostics) =>
      Effect.sync(() => {
        if (lane === 'initial') {
          initialPostingRows += event.postingRows;
          initialPostingStatements += event.postingStatements;
        } else {
          fallbackPostingRows += event.postingRows;
          fallbackPostingStatements += event.postingStatements;
        }
      });
    const scopeSets: ReadonlyArray<readonly string[] | undefined> =
      profile === 'preferred-plus-global' ? [[fixture.preferredUris[scenario]], undefined] : [undefined];
    const selection = {
      limit: recallIndexPreselectionLimit(topK),
      onQueryDiagnostics: diagnostics('initial'),
      query,
    };
    const topicalSelections = EffectArray.map(scopeSets, allowedUriScopes => ({...selection, allowedUriScopes}));
    const workspaceSelections = EffectArray.map(scopeSets, allowedUriScopes => ({
      ...selection,
      allowedUriScopes,
      workspaceScope: CURRENT_SCOPE,
    }));
    const initial = yield* loadRecallIndexDataBatch(config, {
      includeInactive: false,
      selections: [...topicalSelections, ...workspaceSelections],
    });
    const topicalResults = initial.slice(0, topicalSelections.length);
    const workspaceResults = initial.slice(topicalSelections.length);
    const topicalCandidates = mergeRecallIndexCandidates(EffectArray.map(topicalResults, result => result.candidates));
    const ordinaryCross = prioritizeCrossScopeRecallCandidates(query, topicalCandidates, {
      now: FIXED_NOW,
      project,
      workspaceScope: CURRENT_SCOPE,
    });
    const protectedCandidates = prioritizeWorkspaceRecallCandidates(
      query,
      mergeRecallIndexCandidates(EffectArray.map(workspaceResults, result => result.candidates)),
      {now: FIXED_NOW, project, workspaceScope: CURRENT_SCOPE},
    );
    const budgets = recallCrossScopeLaneBudgets(topK);
    const fallbackQueries =
      mode === 'always-query-reference' ||
      (mode === 'evidence-gated' && recallCrossScopeFallbackRequired(topicalResults.at(-1)?.queryExhaustive))
        ? 1
        : 0;
    const fallback =
      fallbackQueries === 0
        ? undefined
        : yield* loadRecallIndexData(config, {
            includeInactive: false,
            limit: budgets.crossSelectionLimit,
            onQueryDiagnostics: diagnostics('fallback'),
            project,
            query,
            workspaceScope: CURRENT_SCOPE,
            workspaceScopeMode: 'sibling',
          });
    const crossCandidates =
      mode === 'no-challenger-reference'
        ? []
        : prioritizeCrossScopeRecallCandidates(
            query,
            mergeRecallIndexCandidates([ordinaryCross, fallback?.candidates ?? []]),
            {now: FIXED_NOW, project, workspaceScope: CURRENT_SCOPE},
          );
    const admittedCandidates = mergeRecallCandidateLanes(
      [topicalCandidates],
      [protectedCandidates],
      [crossCandidates],
      budgets,
    ).slice(0, budgets.admissionLimit);
    const targetUri = fixture.targetUris[scenario];
    return {
      admittedCandidates: admittedCandidates.length,
      crossCandidates: crossCandidates.length,
      fallbackCandidates: fallback?.candidates.length ?? 0,
      fallbackPostingRows,
      fallbackPostingStatements,
      fallbackQueries,
      initialPostingRows,
      initialPostingStatements,
      initialSelections: topicalSelections.length + workspaceSelections.length,
      protectedCandidates: protectedCandidates.length,
      targetAdmitted:
        targetUri === undefined ? null : EffectArray.some(admittedCandidates, candidate => candidate.uri === targetUri),
    } satisfies PassResult;
  });
}

interface RecallSqliteFixture {
  readonly mainDocuments: number;
  readonly manifestSha256: string;
  readonly noSiblingDocuments: number;
  readonly preferredUris: Readonly<Record<Scenario, string>>;
  readonly targetUris: Readonly<Record<Scenario, string | undefined>>;
}

function writeFixture(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
  documents: number,
): Effect.Effect<RecallSqliteFixture, unknown> {
  return Effect.gen(function* () {
    const projectsRoot = path.join(home, 'data', 'local', 'user', 'benchmark', 'memories', 'durable', 'projects');
    const preferredRoot = path.join(projectsRoot, PROJECT, 'preferred');
    const fallbackRoot = path.join(projectsRoot, PROJECT, 'fallback');
    const noSiblingRoot = path.join(projectsRoot, NO_SIBLING_PROJECT, 'preferred');
    yield* fs.makeDirectory(preferredRoot, {recursive: true});
    yield* fs.makeDirectory(fallbackRoot, {recursive: true});
    yield* fs.makeDirectory(noSiblingRoot, {recursive: true});
    const selectiveIndex = documents % 2 === 0 ? documents - 1 : documents - 2;
    const buriedIndex = selectiveIndex - 2;
    const mainRecords = Array.from({length: documents}, (_unused, index) => {
      const current = index < Math.min(140, documents - 2) || index % 2 === 0;
      const scope = current ? CURRENT_SCOPE : SIBLING_SCOPE;
      const preferred = index < Math.floor(documents / 2);
      const filename = `${Effect2.pipe(String(index), EffectString.padStart(6, '0'))}.md`;
      const selective = index === selectiveIndex;
      const buried = index === buriedIndex;
      const localBuriedDecoy = current && index < Math.min(140, documents - 2);
      return {
        content: memoryContent(index, scope, {buried, localBuriedDecoy, selective}),
        filename,
        relativePath: `${PROJECT}/${preferred ? 'preferred' : 'fallback'}/${filename}`,
        root: preferred ? preferredRoot : fallbackRoot,
      } as const;
    });
    yield* Effect.forEach(
      mainRecords,
      record => fs.writeFileString(path.join(record.root, record.filename), record.content),
      {concurrency: 32, discard: true},
    );
    const noSiblingDocuments = Math.max(300, Math.floor(documents / 4));
    const noSiblingRecords = Array.from({length: noSiblingDocuments}, (_unused, index) => {
      const filename = `${Effect2.pipe(String(index), EffectString.padStart(6, '0'))}.md`;
      return {
        content: noSiblingMemoryContent(index),
        filename,
        relativePath: `${NO_SIBLING_PROJECT}/preferred/${filename}`,
      } as const;
    });
    yield* Effect.forEach(
      noSiblingRecords,
      record => fs.writeFileString(path.join(noSiblingRoot, record.filename), record.content),
      {concurrency: 32, discard: true},
    );
    const uriRoot = `threadnote://user/benchmark/memories/durable/projects/${PROJECT}`;
    const uriFor = (index: number) =>
      `${uriRoot}/${index < Math.floor(documents / 2) ? 'preferred' : 'fallback'}/${Effect2.pipe(String(index), EffectString.padStart(6, '0'))}.md`;
    const commonSiblingIndex = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        Array.from({length: documents}, (_unused, index) => index),
        index => index >= Math.max(Math.min(140, documents - 2), Math.floor(documents / 2)) && index % 2 === 1,
      ),
    );
    if (commonSiblingIndex === undefined) return yield* ScriptError.make({message: 'Fixture has no sibling document'});
    return {
      mainDocuments: mainRecords.length,
      manifestSha256: sha256HexSync(
        JSON.stringify({
          currentScope: CURRENT_SCOPE,
          records: EffectArray.map([...mainRecords, ...noSiblingRecords], ({content, relativePath}) => ({
            contentSha256: sha256HexSync(content),
            relativePath,
          })),
          siblingScope: SIBLING_SCOPE,
          version: 1,
        }),
      ),
      noSiblingDocuments: noSiblingRecords.length,
      preferredUris: {
        'buried-common-sibling': `${uriRoot}/preferred`,
        'common-balanced': `${uriRoot}/preferred`,
        'common-no-sibling': `threadnote://user/benchmark/memories/durable/projects/${NO_SIBLING_PROJECT}/preferred`,
        'selective-sibling': `${uriRoot}/preferred`,
      },
      targetUris: {
        'buried-common-sibling': uriFor(buriedIndex),
        'common-balanced': uriFor(commonSiblingIndex),
        'common-no-sibling': undefined,
        'selective-sibling': uriFor(selectiveIndex),
      },
    };
  });
}

function noSiblingMemoryContent(index: number): string {
  return EffectArray.join(
    [
      'MEMORY',
      'kind: durable',
      'status: active',
      `project: ${NO_SIBLING_PROJECT}`,
      `topic: isolated-common-anchor-${index}`,
      `workspace_scope: ${CURRENT_SCOPE}`,
      'keywords: isolated common anchor',
      'source_agent_client: benchmark',
      'timestamp: 2026-08-20T00:00:00.000Z',
      '',
      `Isolated common anchor belongs only to the current scope ${index}.`,
    ],
    '\n',
  );
}

function memoryContent(
  index: number,
  workspaceScope: string,
  options: {readonly buried: boolean; readonly localBuriedDecoy: boolean; readonly selective: boolean},
): string {
  const topic = options.localBuriedDecoy ? `buried-zephyr-contract-${index}` : `sqlite-record-${index}`;
  return EffectArray.join(
    [
      'MEMORY',
      'kind: durable',
      'status: active',
      `project: ${PROJECT}`,
      `topic: ${topic}`,
      `workspace_scope: ${workspaceScope}`,
      'keywords: common posting anchor',
      ...(options.buried ? ['keywords: current buried zephyr contract'] : []),
      ...(options.selective ? ['keywords: selective heliotrope needle'] : []),
      'source_agent_client: benchmark',
      'timestamp: 2026-08-20T00:00:00.000Z',
      '',
      EffectArray.join(
        EffectArray.filter(
          [
            'Common posting anchor for the production SQLite selection benchmark.',
            options.localBuriedDecoy ? 'Buried zephyr contract decoy with stronger recorded topic evidence.' : '',
            options.buried ? 'The governing buried zephyr contract belongs to the billing sibling.' : '',
            options.selective ? 'Unique selective heliotrope needle belongs to the billing sibling.' : '',
          ],
          Boolean,
        ),
        ' ',
      ),
    ],
    '\n',
  );
}

function scenarioQuery(scenario: Scenario): string {
  if (scenario === 'common-balanced') return 'common posting anchor';
  if (scenario === 'common-no-sibling') return 'isolated common anchor';
  if (scenario === 'selective-sibling') return 'selective heliotrope needle';
  return 'buried zephyr contract';
}

function scenarioProject(scenario: Scenario): string {
  return scenario === 'common-no-sibling' ? NO_SIBLING_PROJECT : PROJECT;
}

function rotatedModes(sample: number): readonly Mode[] {
  const offset = sample % MODES.length;
  return [...MODES.slice(offset), ...MODES.slice(0, offset)];
}

function passKey(scenario: Scenario, profile: Profile, mode: Mode): string {
  return `${scenario}:${profile}:${mode}`;
}

export interface RecallCrossScopeSqliteBenchmarkOptions {
  readonly documents: number;
  readonly outputPath?: string;
  readonly samples: number;
  readonly topK: number;
  readonly warmups: number;
}

export function parseRecallCrossScopeSqliteBenchmarkArguments(
  args: readonly string[],
): RecallCrossScopeSqliteBenchmarkOptions {
  let documents = 4_000;
  let samples = 5;
  let topK = 5;
  let warmups = 1;
  let outputPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--documents') documents = positiveInteger(args[++index], argument);
    else if (argument === '--samples') samples = positiveInteger(args[++index], argument);
    else if (argument === '--top-k') topK = positiveInteger(args[++index], argument);
    else if (argument === '--warmups') warmups = nonNegativeInteger(args[++index], argument);
    else if (argument === '--output') outputPath = requiredValue(args[++index], argument);
    else throw ScriptError.make({message: `Unknown cross-scope SQLite benchmark option: ${argument}`});
  }
  if (documents < 300)
    throw ScriptError.make({message: '--documents must be at least 300 to preserve the buried target shape'});
  if (documents > 100_000) throw ScriptError.make({message: '--documents must not exceed 100,000'});
  return {documents, outputPath, samples, topK, warmups};
}

const git = Effect.fn('benchmark.git')((arguments_: readonly string[]) =>
  runCommandEffect('git', arguments_, {timeoutMs: 30_000}).pipe(
    Effect.map(result => Effect2.pipe(result.stdout, EffectString.trim)),
  ),
);

function positiveInteger(value: string | undefined, option: string): number {
  const parsed = nonNegativeInteger(value, option);
  if (parsed < 1) throw ScriptError.make({message: `${option} requires a positive integer`});
  return parsed;
}

function nonNegativeInteger(value: string | undefined, option: string): number {
  const raw = requiredValue(value, option);
  if (!/^\d+$/u.test(raw)) throw ScriptError.make({message: `${option} requires a non-negative integer`});
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw ScriptError.make({message: `${option} requires a non-negative integer`});
  }
  return parsed;
}

function requiredValue(value: string | undefined, option: string): string {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native optional chaining preserves the non-undefined return type after validation.
  if (!value?.trim()) throw ScriptError.make({message: `${option} requires a value`});
  return value;
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(benchmarkRecallCrossScopeSqlite, ApplicationLayer));
