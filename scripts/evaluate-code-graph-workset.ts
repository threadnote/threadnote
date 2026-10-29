import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';
import {provideScriptLayer, scriptError, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Effect} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {
  CODE_GRAPH_WORKSET_BASELINE_VERSION,
  codeGraphWorksetEvaluationFixtureHash,
  evaluateCodeGraphWorksetObservations,
  parseCodeGraphWorksetEvaluationBaselineV1,
  type CodeGraphWorksetCoverageObservationV1,
  type CodeGraphWorksetEvaluationMetrics,
  type CodeGraphWorksetEvaluationObservationV1,
} from '@threadnote/threadnote/evaluation/code-graph-workset';
import {getThreadnoteVersion} from '@threadnote/workspace/runtime-version';
import {atomicWrite, printJson, scriptArguments} from './effect/script.js';
import {
  buildCodeGraphWorksetEvaluationFixture,
  codeGraphWorksetCoverage,
  codeGraphWorksetObservationFromQuery,
  codeGraphWorksetRuntimeConfig,
  indexPreparedCodeGraphWorksetFixture,
  measureCodeGraphWorksetQuery,
  publishIndexedCodeGraphWorksetCatalog,
  unsupportedCodeGraphWorksetObservation,
} from './support/code-graph-workset-harness.js';
import {
  CODE_GRAPH_WORKSET_FIXTURE_SIZES,
  prepareCodeGraphWorksetFixture,
  removePreparedCodeGraphWorksetFixture,
  type CodeGraphWorksetFixtureSize,
  type PreparedCodeGraphWorksetFixture,
} from './support/code-graph-workset-fixture.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const WORKSET_EVALUATION_SMOKE_SIZES = [1, 8] as const;

export interface CodeGraphWorksetEvaluationArguments {
  readonly createdAt: string;
  readonly outputPath?: string;
  readonly sizes: readonly CodeGraphWorksetFixtureSize[];
  readonly smoke: boolean;
}

interface EvaluationArgumentDefaults {
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: Date;
}

export function parseCodeGraphWorksetEvaluationArguments(
  args: readonly string[],
  defaults: EvaluationArgumentDefaults = {},
): CodeGraphWorksetEvaluationArguments {
  let createdAt = defaultCreatedAt(defaults.environment ?? process.env, defaults.now ?? new Date());
  let outputPath: string | undefined;
  let requestedSizes: readonly CodeGraphWorksetFixtureSize[] | undefined;
  let smoke = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--created-at') createdAt = parseCreatedAt(required(args[++index], argument), argument);
    else if (argument === '--output') outputPath = required(args[++index], argument);
    else if (argument === '--sizes') requestedSizes = parseEvaluationSizes(required(args[++index], argument));
    else if (argument === '--smoke') smoke = true;
    else throw ScriptError.make({message: `Unknown code graph workset evaluation option: ${argument}`});
  }
  const sizes = requestedSizes ?? (smoke ? WORKSET_EVALUATION_SMOKE_SIZES : CODE_GRAPH_WORKSET_FIXTURE_SIZES);
  return {createdAt, outputPath, sizes, smoke};
}

export const evaluateCodeGraphWorkset = Effect.scoped(
  Effect.gen(function* () {
    const options = parseCodeGraphWorksetEvaluationArguments(yield* scriptArguments());
    const initialSize = options.sizes[0];
    if (initialSize === undefined)
      return yield* ScriptError.make({message: 'At least one evaluation size is required.'});
    let maximumSize: CodeGraphWorksetFixtureSize = initialSize;
    for (const size of options.sizes) if (size > maximumSize) maximumSize = size;
    const prepared = yield* acquirePreparedFixture(maximumSize, 'mixed');
    yield* indexPreparedCodeGraphWorksetFixture(prepared);
    const selectedWorksets = EffectArray.map(options.sizes, size => {
      const workset = EffectOption.getOrUndefined(
        EffectArray.findFirst(prepared.plan.worksets, candidate => candidate.size === size),
      );
      if (!workset) throw ScriptError.make({message: `Fixture did not emit a size-${size} workset.`});
      return workset.name;
    });
    yield* publishIndexedCodeGraphWorksetCatalog(prepared, selectedWorksets);

    const fixture = buildCodeGraphWorksetEvaluationFixture(prepared.plan, options.sizes);
    const config = codeGraphWorksetRuntimeConfig(prepared);
    const observations: CodeGraphWorksetEvaluationObservationV1[] = [];
    for (const worksetSize of options.sizes) {
      const workset = EffectOption.getOrUndefined(
        EffectArray.findFirst(prepared.plan.worksets, candidate => candidate.size === worksetSize),
      );
      if (!workset) return yield* ScriptError.make({message: `Fixture did not emit a size-${worksetSize} workset.`});
      const queries = EffectArrayPipe(fixture.queries, __effectArrayValues =>
        EffectArray.filter(
          __effectArrayValues,
          (query, __effectArrayIndex) => __effectArrayIndex in __effectArrayValues && query.sizes.includes(worksetSize),
        ),
      );
      const worktree = yield* measureWorktreeIsolation(prepared, config, workset.name, worksetSize);
      let coverage: readonly CodeGraphWorksetCoverageObservationV1[] | undefined;
      let worktreeReceiptAvailable = true;
      for (const query of queries) {
        if (query.operation !== 'query') {
          if (!coverage) {
            const probe = EffectOption.getOrUndefined(
              EffectArray.findFirst(
                fixture.queries,
                __effectArrayValue =>
                  !!(candidate => candidate.operation === 'query' && candidate.sizes.includes(worksetSize))(
                    __effectArrayValue,
                  ),
              ),
            );
            if (!probe?.query) {
              return yield* ScriptError.make({
                message: `Fixture size ${worksetSize} has no executable coverage probe.`,
              });
            }
            const measured = yield* measureCodeGraphWorksetQuery(config, workset.name, probe.query);
            coverage = codeGraphWorksetCoverage(fixture, worksetSize, measured.result);
          }
          observations.push(
            unsupportedCodeGraphWorksetObservation(fixture, worksetSize, 'evaluation-1', query.id, coverage),
          );
          continue;
        }
        const measured = yield* measureCodeGraphWorksetQuery(config, workset.name, query.query!);
        coverage = codeGraphWorksetCoverage(fixture, worksetSize, measured.result);
        observations.push(
          codeGraphWorksetObservationFromQuery(
            fixture,
            worksetSize,
            'evaluation-1',
            query.id,
            measured,
            worktreeReceiptAvailable ? worktree : undefined,
          ),
        );
        worktreeReceiptAvailable = false;
      }
    }

    const metrics = evaluateCodeGraphWorksetObservations(fixture, observations);
    const system = yield* SystemInfo;
    const hardware = yield* system.hardwareInfo;
    const [commit, dirty, version] = yield* Effect.all(
      [
        sourceGit(['rev-parse', 'HEAD']),
        sourceGit(['status', '--porcelain', '--untracked-files=all']),
        getThreadnoteVersion().pipe(Effect.orElseSucceed(() => 'unknown')),
      ],
      {concurrency: 3},
    );
    const baseline = parseCodeGraphWorksetEvaluationBaselineV1({
      createdAt: options.createdAt,
      fixture: {
        hash: codeGraphWorksetEvaluationFixtureHash(fixture),
        id: fixture.id,
        members: fixture.members.length,
        queries: fixture.queries.length,
        sizes: fixture.sizes,
        version: fixture.version,
      },
      metrics,
      source: {
        commit,
        dirty: dirty.length > 0,
        environment: `${hardware.operatingSystem}; ${system.architecture}`,
        name: 'threadnote-native-code-graph-workset',
        version,
      },
      version: CODE_GRAPH_WORKSET_BASELINE_VERSION,
    });
    if (options.outputPath) yield* atomicWrite(options.outputPath, `${JSON.stringify(baseline, undefined, 2)}\n`);
    yield* printJson(baseline);
    const safetyFailures = codeGraphWorksetEvaluationSafetyFailures(metrics);
    if (safetyFailures.length > 0) return yield* ScriptError.make({message: EffectArray.join(safetyFailures, '\n')});
  }),
);

export function codeGraphWorksetEvaluationSafetyFailures(metrics: {
  readonly aggregate: Pick<
    CodeGraphWorksetEvaluationMetrics['aggregate'],
    'authoritativeFalseEdgeRate' | 'noAnswerPrecision' | 'noAnswerRecall' | 'worktreeLeakageRate'
  >;
}): readonly string[] {
  return EffectArray.filter(
    [
      metrics.aggregate.authoritativeFalseEdgeRate !== 0 ? 'authoritative false-edge rate must be zero' : '',
      metrics.aggregate.worktreeLeakageRate !== 0 ? 'worktree leakage rate must be zero' : '',
      metrics.aggregate.noAnswerPrecision !== 1 ? 'no-answer precision must be one' : '',
      metrics.aggregate.noAnswerRecall !== 1 ? 'no-answer recall must be one' : '',
    ],
    Boolean,
  );
}

function acquirePreparedFixture(size: CodeGraphWorksetFixtureSize, stateProfile: 'all-clean' | 'mixed') {
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: () => prepareCodeGraphWorksetFixture({size, stateProfile}),
      catch: cause => scriptError(cause),
    }),
    fixture =>
      Effect.tryPromise({
        try: () => removePreparedCodeGraphWorksetFixture(fixture),
        catch: cause => scriptError(cause),
      }).pipe(Effect.ignore),
  );
}

const measureWorktreeIsolation = Effect.fn('evaluateCodeGraphWorkset.worktreeIsolation')(function* (
  prepared: PreparedCodeGraphWorksetFixture,
  config: ReturnType<typeof codeGraphWorksetRuntimeConfig>,
  worksetName: string,
  worksetSize: number,
) {
  const admitted = EffectArray.filter(
    prepared.repositories.slice(0, worksetSize),
    repository => repository.state === 'worktree',
  );
  if (admitted.length === 0) return {leakageCount: 0, observationCount: 0};
  const measured = yield* measureCodeGraphWorksetQuery(config, worksetName, 'siblingOnlySymbol');
  const leakedRepositories = new Set(
    EffectArray.map(
      EffectArray.filter(measured.result.cards, card => card.symbol.name === 'siblingOnlySymbol'),
      card => card.repositoryKey,
    ),
  );
  return {
    leakageCount: EffectArray.filter(admitted, repository => leakedRepositories.has(repository.projectName)).length,
    observationCount: admitted.length,
  };
});

function parseEvaluationSizes(value: string): readonly CodeGraphWorksetFixtureSize[] {
  const sizes = parseSizeList(value, '--sizes');
  for (const size of sizes) {
    if (!isCodeGraphWorksetFixtureSize(size)) {
      throw ScriptError.make({
        message: `--sizes only accepts evaluation sizes: ${EffectArray.join(
          EffectArray.map(CODE_GRAPH_WORKSET_FIXTURE_SIZES, item =>
            item === null || item === undefined ? '' : String(item),
          ),
          ', ',
        )}. Received ${size}.`,
      });
    }
  }
  return EffectArray.filter(
    [...sizes].sort((left, right) => left - right),
    isCodeGraphWorksetFixtureSize,
  );
}

function isCodeGraphWorksetFixtureSize(value: number): value is CodeGraphWorksetFixtureSize {
  return EffectArray.some(CODE_GRAPH_WORKSET_FIXTURE_SIZES, size => size === value);
}

function parseSizeList(value: string, option: string): readonly number[] {
  const parts = Effect2.pipe(value, EffectString.split(','));
  if (parts.length === 0 || EffectArray.some(parts, part => !Effect2.pipe(part, EffectString.trim)))
    throw ScriptError.make({message: `${option} requires comma-separated sizes.`});
  const sizes: number[] = EffectArray.map(parts, (part: string): number =>
    Number(Effect2.pipe(part, EffectString.trim)),
  );
  if (EffectArray.some(sizes, size => !Number.isSafeInteger(size) || size < 1)) {
    throw ScriptError.make({message: `${option} requires positive integer sizes.`});
  }
  if (new Set(sizes).size !== sizes.length) throw ScriptError.make({message: `${option} sizes must be unique.`});
  return sizes;
}

function defaultCreatedAt(environment: NodeJS.ProcessEnv, now: Date): string {
  const epoch = environment.SOURCE_DATE_EPOCH;
  if (epoch === undefined) return parseCreatedAt(now.toISOString(), 'current time');
  if (!/^\d+$/.test(epoch))
    throw ScriptError.make({message: 'SOURCE_DATE_EPOCH must be a non-negative integer number of seconds.'});
  const date = new Date(Number(epoch) * 1_000);
  if (!Number.isFinite(date.getTime()))
    throw ScriptError.make({message: 'SOURCE_DATE_EPOCH is outside the supported date range.'});
  return date.toISOString();
}

function parseCreatedAt(value: string, option: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw ScriptError.make({message: `${option} requires a valid date.`});
  return date.toISOString();
}

function required(value: string | undefined, option: string): string {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native optional chaining preserves the non-undefined return type after validation.
  if (!value?.trim()) throw ScriptError.make({message: `${option} requires a value.`});
  return value;
}

const sourceGit = Effect.fn('evaluateCodeGraphWorkset.sourceGit')((args: readonly string[]) =>
  runCommandEffect('git', ['-C', process.cwd(), ...args], {
    maxOutputBytes: 1_048_576,
    timeoutMs: 30_000,
  }).pipe(Effect.map(result => Effect2.pipe(result.stdout, EffectString.trim))),
);

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(evaluateCodeGraphWorkset, ApplicationLayer));
