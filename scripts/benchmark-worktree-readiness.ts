import {Array as EffectArray} from 'effect';
import {ScriptCommandExecutorLayer} from './effect/system-layer.js';
import {ScriptSystemInfoLayer} from './effect/system-layer.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Clock, Console, DateTime, Effect, FileSystem, Layer, Path} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {runtimeHostHardwareInfo, runtimeOperatingSystemRelease, SystemInfo} from '@threadnote/platform/system';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const DEFAULT_CANDIDATE_REF = 'v4.0.1';
const DEFAULT_SAMPLES = 5;
const DEFAULT_WARMUPS = 1;
const FIXTURE_QUERY = 'compareVersions';
const FIXTURE_QUERY_PATH = 'apps/threadnote/src/release/version/compare.ts';
const INDEX_TIMEOUT_MILLISECONDS = 15 * 60 * 1_000;
const MAX_COMMAND_OUTPUT_BYTES = 128 * 1_024 * 1_024;
const PARSER_WORKERS = 4;

type ScenarioName = 'graphEquivalentCommit' | 'oneFileChange';
type RuntimeName = 'baseline' | 'candidate';

interface BenchmarkOptions {
  readonly baselineRef?: string;
  readonly candidateRef: string;
  readonly outputPath?: string;
  readonly samples: number;
  readonly warmups: number;
}

interface RuntimeCheckout {
  readonly commit: string;
  readonly home: string;
  readonly name: RuntimeName;
  readonly root: string;
}

interface FixtureCheckout {
  readonly primary: string;
  readonly runtime: RuntimeCheckout;
  readonly worktreeRoot: string;
}

interface GraphShape {
  readonly edges: number;
  readonly files: number;
  readonly symbols: number;
}

interface Observation {
  readonly durationMilliseconds: number;
  readonly graph: GraphShape;
  readonly materializationMode: string;
  readonly queryDigest: string;
  readonly reusedFiles: number;
  readonly stagedFiles: number;
  readonly totalFiles: number;
}

interface Summary {
  readonly maximumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly minimumMilliseconds: number;
  readonly samples: number;
}

interface ScenarioEvidence {
  readonly baseline: Summary & {
    readonly materializationModes: readonly string[];
    readonly observations: readonly Observation[];
    readonly stagedFiles: readonly number[];
  };
  readonly candidate: Summary & {
    readonly materializationModes: readonly string[];
    readonly observations: readonly Observation[];
    readonly stagedFiles: readonly number[];
  };
  readonly graphParityPassed: true;
  readonly medianSpeedup: number;
  readonly percentFaster: number;
  readonly queryParityPassed: true;
}

interface BenchmarkContext {
  readonly baselineCommit: string;
  readonly candidateCommit: string;
  readonly options: BenchmarkOptions;
  readonly repositoryRoot: string;
  readonly temporaryRoot: string;
}

const benchmarkWorktreeReadiness = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const options = parseArguments(system.processArguments.slice(2));
    const repositoryRoot = yield* gitTopLevel(system.currentDirectory());
    const candidateCommit = yield* git(repositoryRoot, ['rev-parse', '--verify', `${options.candidateRef}^{commit}`]);
    const baselineRef = options.baselineRef ?? `${candidateCommit}^`;
    const baselineCommit = yield* git(repositoryRoot, ['rev-parse', '--verify', `${baselineRef}^{commit}`]);
    if (candidateCommit === baselineCommit) {
      return yield* ScriptError.make({message: 'Candidate and baseline commits must differ.'});
    }
    yield* git(repositoryRoot, ['merge-base', '--is-ancestor', baselineCommit, candidateCommit]);

    const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-worktree-readiness-'});
    const context: BenchmarkContext = {baselineCommit, candidateCommit, options, repositoryRoot, temporaryRoot};
    yield* progress(`Preparing exact runtime checkouts in ${temporaryRoot}`);
    const baseline = yield* prepareRuntime(context, 'baseline', baselineCommit);
    const candidate = yield* prepareRuntime(context, 'candidate', candidateCommit);
    const fixtures = {
      baseline: yield* prepareFixture(context, baseline),
      candidate: yield* prepareFixture(context, candidate),
    } as const;

    yield* progress('Building the shared warm anchor for each runtime');
    const anchorObservations = {
      baseline: yield* runIndex(baseline, fixtures.baseline.primary),
      candidate: yield* runIndex(candidate, fixtures.candidate.primary),
    } as const;
    assertParity(anchorObservations.baseline, anchorObservations.candidate, 'warm anchor');

    const scenarios = {
      graphEquivalentCommit: yield* runScenario(context, 'graphEquivalentCommit', fixtures),
      oneFileChange: yield* runScenario(context, 'oneFileChange', fixtures),
    } satisfies Record<ScenarioName, ScenarioEvidence>;

    const hardware = runtimeHostHardwareInfo();
    const harnessPath = yield* path.fromFileUrl(new URL(import.meta.url));

    const artifact = {
      schemaVersion: 1,
      generatedAt: DateTime.formatIso(yield* DateTime.now),
      scope: {
        name: 'warm-linked-worktree-lexical-readiness',
        description:
          'Elapsed wall time from invoking graph index in a newly linked worktree until a current lexical snapshot is ready.',
        excludes: ['cold anchor construction', 'dependency installation', 'optional vector enrichment'],
        order: 'Alternating same-machine runs; candidate first for even samples and baseline first for odd samples.',
        samples: options.samples,
        warmups: options.warmups,
      },
      source: {
        repository: 'threadnote/threadnote',
        repositoryUrl: 'https://github.com/threadnote/threadnote',
        fixtureCommit: candidateCommit,
        candidate: {commit: candidateCommit, ref: options.candidateRef},
        baseline: {commit: baselineCommit, ref: baselineRef},
        harness: {
          path: 'scripts/benchmark-worktree-readiness.ts',
          sha256: sha256HexSync(yield* fs.readFile(harnessPath)),
        },
      },
      environment: {
        architecture: system.architecture,
        bun: system.runtimeVersion,
        cpu: hardware.cpuModel,
        logicalCpuCount: hardware.logicalCpuCount,
        memoryBytes: hardware.memoryBytes,
        operatingSystem: `${system.platform} ${runtimeOperatingSystemRelease}`,
        parserWorkers: PARSER_WORKERS,
        runner: 'same-machine-local-source',
      },
      anchor: {
        graphParityPassed: true,
        baseline: anchorObservations.baseline.graph,
        candidate: anchorObservations.candidate.graph,
      },
      scenarios,
    } as const;

    validateArtifact(context, artifact);
    const json = `${JSON.stringify(artifact, undefined, 2)}\n`;
    if (options.outputPath) yield* atomicWrite(path.resolve(options.outputPath), json);
    yield* Console.log(JSON.stringify(artifact, undefined, 2));
  }),
);

const prepareRuntime = Effect.fn('worktreeReadiness.prepareRuntime')(function* (
  context: BenchmarkContext,
  name: RuntimeName,
  commit: string,
) {
  const path = yield* Path.Path;
  const root = path.join(context.temporaryRoot, `runtime-${name}`);
  yield* cloneAtCommit(context, context.repositoryRoot, root, commit);
  yield* progress(`Installing frozen dependencies for ${name} ${Effect2.pipe(commit, EffectString.slice(0, 12))}`);
  yield* command('bun', ['install', '--frozen-lockfile', '--ignore-scripts'], root, 5 * 60 * 1_000);
  if ((yield* git(root, ['status', '--porcelain', '--untracked-files=no'])) !== '') {
    return yield* ScriptError.make({message: `${name} runtime checkout changed during dependency installation.`});
  }
  return {
    commit,
    home: path.join(context.temporaryRoot, `home-${name}`),
    name,
    root,
  };
});

const prepareFixture = Effect.fn('worktreeReadiness.prepareFixture')(function* (
  context: BenchmarkContext,
  runtime: RuntimeCheckout,
) {
  const path = yield* Path.Path;
  const primary = path.join(context.temporaryRoot, `fixture-${runtime.name}`);
  yield* cloneAtCommit(context, context.repositoryRoot, primary, context.candidateCommit);
  yield* git(primary, ['switch', '--create', 'worktree-readiness-benchmark']);
  yield* git(primary, ['config', 'user.name', 'Threadnote Benchmark']);
  yield* git(primary, ['config', 'user.email', 'benchmark@threadnote.local']);
  return {
    primary,
    runtime,
    worktreeRoot: path.join(context.temporaryRoot, `worktrees-${runtime.name}`),
  };
});

const runScenario = Effect.fn('worktreeReadiness.runScenario')(function* (
  context: BenchmarkContext,
  scenario: ScenarioName,
  fixtures: Readonly<Record<RuntimeName, FixtureCheckout>>,
) {
  const observations: Record<RuntimeName, Observation[]> = {baseline: [], candidate: []};
  const totalRuns = context.options.warmups + context.options.samples;
  for (let run = 0; run < totalRuns; run += 1) {
    const measured = run >= context.options.warmups;
    const sample = run - context.options.warmups;
    const logicalRun = `${scenario}-${run + 1}`;
    for (const fixture of EffectRecord.values(fixtures)) yield* prepareScenarioCommit(fixture, scenario, run);
    const worktrees = {
      baseline: yield* addLinkedWorktree(fixtures.baseline, logicalRun),
      candidate: yield* addLinkedWorktree(fixtures.candidate, logicalRun),
    } as const;
    const order: readonly RuntimeName[] = run % 2 === 0 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
    const current: Partial<Record<RuntimeName, Observation>> = {};
    yield* Effect.gen(function* () {
      for (const name of order) {
        yield* progress(
          `${scenario} ${
            measured
              ? `sample ${sample + 1}/${context.options.samples}`
              : `warmup ${run + 1}/${context.options.warmups}`
          } · ${name}`,
        );
        current[name] = yield* runIndex(fixtures[name].runtime, worktrees[name]);
      }
    }).pipe(
      Effect.ensuring(
        removeLinkedWorktree(fixtures.baseline, worktrees.baseline).pipe(
          Effect.andThen(removeLinkedWorktree(fixtures.candidate, worktrees.candidate)),
        ),
      ),
    );
    const baseline = requireObservation(current.baseline, `${logicalRun} baseline`);
    const candidate = requireObservation(current.candidate, `${logicalRun} candidate`);
    assertParity(baseline, candidate, logicalRun);
    assertExpectedMode(scenario, baseline, candidate);
    if (measured) {
      observations.baseline.push(baseline);
      observations.candidate.push(candidate);
    }
  }
  const baseline = summarize(
    EffectArray.map(observations.baseline, value => value.durationMilliseconds),
    context.options.samples,
  );
  const candidate = summarize(
    EffectArray.map(observations.candidate, value => value.durationMilliseconds),
    context.options.samples,
  );
  const medianSpeedup = baseline.medianMilliseconds / candidate.medianMilliseconds;
  return {
    baseline: {
      ...baseline,
      materializationModes: unique(EffectArray.map(observations.baseline, value => value.materializationMode)),
      observations: observations.baseline,
      stagedFiles: EffectArray.map(observations.baseline, value => value.stagedFiles),
    },
    candidate: {
      ...candidate,
      materializationModes: unique(EffectArray.map(observations.candidate, value => value.materializationMode)),
      observations: observations.candidate,
      stagedFiles: EffectArray.map(observations.candidate, value => value.stagedFiles),
    },
    graphParityPassed: true,
    medianSpeedup,
    percentFaster: (1 - candidate.medianMilliseconds / baseline.medianMilliseconds) * 100,
    queryParityPassed: true,
  };
});

const prepareScenarioCommit = Effect.fn('worktreeReadiness.prepareScenarioCommit')(function* (
  fixture: FixtureCheckout,
  scenario: ScenarioName,
  run: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  if (scenario === 'oneFileChange') {
    yield* fs.writeFileString(
      path.join(fixture.primary, FIXTURE_QUERY_PATH),
      `\n// Threadnote worktree-readiness benchmark sample ${run + 1}.\n`,
      {flag: 'a'},
    );
    yield* git(fixture.primary, ['add', FIXTURE_QUERY_PATH]);
  }
  const date = DateTime.formatIso(
    DateTime.makeUnsafe(Date.UTC(2026, 7, 4, scenario === 'graphEquivalentCommit' ? 1 : 2, run, 0)),
  );
  const environment = {
    ...system.environment(),
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
  yield* command(
    'git',
    ['commit', '--allow-empty', '--quiet', '--message', `${scenario} benchmark sample ${run + 1}`],
    fixture.primary,
    30_000,
    environment,
  );
});

const addLinkedWorktree = Effect.fn('worktreeReadiness.addLinkedWorktree')(function* (
  fixture: FixtureCheckout,
  logicalRun: string,
) {
  const path = yield* Path.Path;
  const worktree = path.join(fixture.worktreeRoot, logicalRun);
  yield* git(fixture.primary, ['worktree', 'add', '--quiet', '--detach', worktree, 'HEAD']);
  return worktree;
});

const removeLinkedWorktree = Effect.fn('worktreeReadiness.removeLinkedWorktree')(function* (
  fixture: FixtureCheckout,
  worktree: string,
) {
  const path = yield* Path.Path;
  if (!Effect2.pipe(worktree, EffectString.startsWith(`${fixture.worktreeRoot}${path.sep}`))) {
    return yield* ScriptError.make({message: `Refusing to remove an unexpected worktree path: ${worktree}`});
  }
  yield* git(fixture.primary, ['worktree', 'remove', '--force', worktree]);
});

const runIndex = Effect.fn('worktreeReadiness.runIndex')(function* (runtime: RuntimeCheckout, cwd: string) {
  const started = yield* Clock.currentTimeNanos;
  const output = yield* runThreadnote(runtime, ['--log-level', 'none', 'graph', 'index', '--cwd', cwd, '--json']);
  const durationMilliseconds = Number((yield* Clock.currentTimeNanos) - started) / 1_000_000;
  const summary = finalJsonRecord(output, 'code-graph-index');
  const snapshot = record(summary.snapshot, 'snapshot');
  const materialization = record(summary.materialization, 'materialization');
  const query = finalJsonRecord(
    yield* runThreadnote(runtime, [
      '--log-level',
      'none',
      'graph',
      'query',
      '--cwd',
      cwd,
      '--query',
      FIXTURE_QUERY,
      '--node-limit',
      '5',
      '--edge-limit',
      '10',
      '--json',
    ]),
  );
  const nodes = EffectArray.map(array(query.nodes, 'query.nodes'), value => record(value, 'query node'));
  if (!EffectArray.some(nodes, node => node.name === FIXTURE_QUERY && node.path === FIXTURE_QUERY_PATH)) {
    throw ScriptError.make({
      message: `${runtime.name} query control did not return ${FIXTURE_QUERY_PATH}#${FIXTURE_QUERY}.`,
    });
  }
  return {
    durationMilliseconds,
    graph: {
      edges: integerField(snapshot, 'edgeCount'),
      files: integerField(snapshot, 'fileCount'),
      symbols: integerField(snapshot, 'symbolCount'),
    },
    materializationMode: stringField(materialization, 'mode'),
    queryDigest: queryEvidenceDigest(query),
    reusedFiles: integerField(summary, 'reusedFiles'),
    stagedFiles: integerField(materialization, 'stagedFiles'),
    totalFiles: integerField(materialization, 'totalFiles'),
  };
});

const runThreadnote = Effect.fn('worktreeReadiness.runThreadnote')(function* (
  runtime: RuntimeCheckout,
  arguments_: readonly string[],
) {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const result = yield* runCommandEffect(
    system.executablePath,
    [path.join(runtime.root, 'apps/threadnote/src/standalone.ts'), ...arguments_],
    {
      cwd: runtime.root,
      env: {
        ...system.environment(),
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        THREADNOTE_CODE_GRAPH_PARSER_WORKERS: String(PARSER_WORKERS),
        THREADNOTE_HOME: runtime.home,
      },
      maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
      timeoutMs: INDEX_TIMEOUT_MILLISECONDS,
    },
  );
  return result.stdout;
});

function assertExpectedMode(scenario: ScenarioName, baseline: Observation, candidate: Observation): void {
  if (baseline.materializationMode !== 'full') {
    throw ScriptError.make({message: `${scenario} baseline unexpectedly used ${baseline.materializationMode}.`});
  }
  const expectedCandidate = scenario === 'graphEquivalentCommit' ? 'reused-snapshot' : 'incremental-clean';
  if (candidate.materializationMode !== expectedCandidate) {
    throw ScriptError.make({message: `${scenario} candidate unexpectedly used ${candidate.materializationMode}.`});
  }
  if (scenario === 'graphEquivalentCommit' && candidate.stagedFiles !== 0) {
    throw ScriptError.make({
      message: 'Graph-equivalent candidate commit staged files instead of aliasing the ready graph.',
    });
  }
  if (scenario === 'oneFileChange' && candidate.stagedFiles !== 1) {
    throw ScriptError.make({
      message: `One-file candidate commit staged ${candidate.stagedFiles} files instead of one.`,
    });
  }
}

function assertParity(baseline: Observation, candidate: Observation, label: string): void {
  if (JSON.stringify(baseline.graph) !== JSON.stringify(candidate.graph)) {
    throw ScriptError.make({message: `${label} graph counts differ between the baseline and candidate.`});
  }
  if (baseline.queryDigest !== candidate.queryDigest) {
    throw ScriptError.make({message: `${label} query control differs between the baseline and candidate.`});
  }
}

function queryEvidenceDigest(query: Record<string, unknown>): string {
  const nodes = EffectArray.map(
    EffectArray.map(array(query.nodes, 'query.nodes'), value => record(value, 'query node')),
    node => ({
      exported: node.exported,
      kind: node.kind,
      language: node.language,
      name: node.name,
      path: node.path,
      qualifiedName: node.qualifiedName,
      signature: node.signature,
    }),
  ).sort(compareJson);
  const edges = EffectArray.map(
    EffectArray.map(array(query.edges, 'query.edges'), value => record(value, 'query edge')),
    edge => ({
      evidencePath: edge.evidencePath,
      provenance: edge.provenance,
      relation: edge.relation,
      sourceName: edge.sourceName,
      targetName: edge.targetName,
    }),
  ).sort(compareJson);
  return sha256HexSync(JSON.stringify({edges, nodes}));
}

function compareJson(left: unknown, right: unknown): number {
  return Effect2.pipe(JSON.stringify(left), EffectString.localeCompare(JSON.stringify(right), ['en']));
}

function summarize(values: readonly number[], expectedSamples: number): Summary {
  if (values.length !== expectedSamples || EffectArray.some(values, value => !Number.isFinite(value) || value <= 0)) {
    throw ScriptError.make({message: `Expected ${expectedSamples} positive benchmark observations.`});
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const medianMilliseconds = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return {
    maximumMilliseconds: sorted.at(-1)!,
    medianMilliseconds,
    minimumMilliseconds: sorted[0],
    samples: sorted.length,
  };
}

function validateArtifact(
  context: BenchmarkContext,
  artifact: {
    readonly scenarios: Readonly<Record<ScenarioName, ScenarioEvidence>>;
    readonly source: {readonly baseline: {readonly commit: string}; readonly candidate: {readonly commit: string}};
  },
): void {
  if (
    artifact.source.baseline.commit !== context.baselineCommit ||
    artifact.source.candidate.commit !== context.candidateCommit
  ) {
    throw ScriptError.make({message: 'Benchmark artifact source provenance drifted during the run.'});
  }
  for (const [name, scenario] of EffectRecord.toEntries(artifact.scenarios)) {
    if (!scenario.graphParityPassed || !scenario.queryParityPassed)
      throw ScriptError.make({message: `${name} parity did not pass.`});
    if (!Number.isFinite(scenario.medianSpeedup) || scenario.medianSpeedup <= 1) {
      throw ScriptError.make({message: `${name} did not improve median readiness time.`});
    }
    if (!Number.isFinite(scenario.percentFaster) || scenario.percentFaster <= 0 || scenario.percentFaster >= 100) {
      throw ScriptError.make({message: `${name} has an invalid percentage improvement.`});
    }
  }
}

function finalJsonRecord(output: string, expectedType?: string): Record<string, unknown> {
  const parsed = EffectArray.map(
    EffectArray.filter(Effect2.pipe(output, EffectString.split(/\r?\n/)), line =>
      Effect2.pipe(line, EffectString.trim, EffectString.startsWith('{')),
    ),
    line => JSON.parse(line) as unknown,
  );
  const records = EffectArray.filter(parsed, isRecord);
  const selected = expectedType ? records.findLast(record => record.type === expectedType) : records.at(-1);
  if (!selected)
    throw ScriptError.make({message: `Threadnote command did not emit ${expectedType ?? 'a final JSON record'}.`});
  return selected;
}

const cloneAtCommit = Effect.fn('worktreeReadiness.cloneAtCommit')(function* (
  context: BenchmarkContext,
  source: string,
  target: string,
  commit: string,
) {
  yield* command(
    'git',
    ['clone', '--quiet', '--no-local', '--no-checkout', source, target],
    context.temporaryRoot,
    2 * 60 * 1_000,
  );
  yield* git(target, ['checkout', '--quiet', '--detach', commit]);
  if ((yield* git(target, ['rev-parse', 'HEAD'])) !== commit) {
    return yield* ScriptError.make({message: `Could not prepare exact checkout ${commit}.`});
  }
});

const git = Effect.fn('worktreeReadiness.git')(function* (cwd: string, arguments_: readonly string[]) {
  return Effect2.pipe(yield* command('git', arguments_, cwd, 2 * 60 * 1_000), EffectString.trim);
});

const gitTopLevel = Effect.fn('worktreeReadiness.gitTopLevel')(function* (cwd: string) {
  return yield* git(cwd, ['rev-parse', '--show-toplevel']);
});

const command = Effect.fn('worktreeReadiness.command')(function* (
  executable: string,
  arguments_: readonly string[],
  cwd: string,
  timeout: number,
  env?: NodeJS.ProcessEnv,
) {
  const result = yield* runCommandEffect(executable, arguments_, {
    cwd,
    env,
    maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
    timeoutMs: timeout,
  });
  return result.stdout;
});

const atomicWrite = Effect.fn('worktreeReadiness.atomicWrite')(function* (target: string, content: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${system.processId}`);
  yield* fs.writeFileString(temporary, content, {flag: 'wx', mode: 0o600});
  yield* fs.rename(temporary, target);
});

function parseArguments(arguments_: readonly string[]): BenchmarkOptions {
  let baselineRef: string | undefined;
  let candidateRef = DEFAULT_CANDIDATE_REF;
  let outputPath: string | undefined;
  let samples = DEFAULT_SAMPLES;
  let warmups = DEFAULT_WARMUPS;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--baseline-ref') baselineRef = required(arguments_[++index], argument);
    else if (argument === '--candidate-ref') candidateRef = required(arguments_[++index], argument);
    else if (argument === '--output') outputPath = required(arguments_[++index], argument);
    else if (argument === '--samples') samples = positiveInteger(arguments_[++index], argument);
    else if (argument === '--warmups') warmups = nonNegativeInteger(arguments_[++index], argument);
    else throw ScriptError.make({message: `Unknown worktree-readiness benchmark option: ${argument}`});
  }
  return {baselineRef, candidateRef, outputPath, samples, warmups};
}

function required(value: string | undefined, option: string): string {
  if (
    !Effect2.pipe(value, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    )
  )
    throw ScriptError.make({message: `${option} requires a value.`});
  return value;
}

function positiveInteger(value: string | undefined, option: string): number {
  const parsed = nonNegativeInteger(value, option);
  if (parsed === 0) throw ScriptError.make({message: `${option} must be at least 1.`});
  return parsed;
}

function nonNegativeInteger(value: string | undefined, option: string): number {
  const parsed = Number.parseInt(required(value, option), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw ScriptError.make({message: `${option} must be a non-negative integer.`});
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw ScriptError.make({message: `${label} must be an object.`});
  return value;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!EffectArray.isArray(value)) throw ScriptError.make({message: `${label} must be an array.`});
  return value;
}

function integerField(record_: Record<string, unknown>, key: string): number {
  const value = record_[key];
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw ScriptError.make({message: `${key} must be a non-negative integer.`});
  return Number(value);
}

function stringField(record_: Record<string, unknown>, key: string): string {
  const value = record_[key];
  if (typeof value !== 'string' || value.length === 0)
    throw ScriptError.make({message: `${key} must be a non-empty string.`});
  return value;
}

function requireObservation(value: Observation | undefined, label: string): Observation {
  if (!value) throw ScriptError.make({message: `Missing ${label} observation.`});
  return value;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function progress(message: string): Effect.Effect<void> {
  return Console.error(`[worktree-readiness] ${message}`);
}

const systemLayer = ScriptSystemInfoLayer;
const commandLayer = ScriptCommandExecutorLayer.pipe(Layer.provide(systemLayer));
const WorktreeBenchmarkLayer = Layer.merge(systemLayer, commandLayer).pipe(Layer.provideMerge(BunServices.layer));

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(benchmarkWorktreeReadiness, WorktreeBenchmarkLayer));
