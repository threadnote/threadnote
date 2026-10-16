#!/usr/bin/env bun

/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- The evaluation runner owns isolated process and filesystem boundaries. */

import {randomBytes} from 'node:crypto';
import {appendFile, mkdir, mkdtemp, readFile, realpath, symlink, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  assertTopicStudyLedgerV1,
  TOPIC_STUDY_COMPARISON_METHOD_V1,
  TOPIC_STUDY_PRECONDITION_FAILURE_PREFIX,
  topicStudyPreconditionFailedV1,
  parseTopicStudyGateInputV1,
  parseTopicStudyCorpusJsonV1,
  summarizeTopicStudyV1,
  topicStudyCanonicalJson,
  topicStudyCorpusHashV1,
  topicStudyLedgerRowV1,
  topicStudyUnavailableObservationV1,
  type TopicStudyGateInputV1,
  type TopicStudyObservationV1,
  TOPIC_STUDY_ARMS,
} from '@threadnote/threadnote/evaluation/topic-maintenance-longitudinal';
import {
  readBoundedChildOutput,
  topicStudyEnvironment,
  withTopicStudyTimeline,
  topicStudyCommitEnvironment,
} from './topic-maintenance-longitudinal-process.js';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {
  applyTopicStudySourceChanges,
  assertTopicStudyModel,
  assertTopicStudyRuntime,
  assertTopicStudySourceAdapter,
  captureTopicStudyRuntime,
  prepareTopicStudyModel,
  topicStudyFileHash,
  topicStudySourceTreeHash,
  topicStudyExpectedSourceTreeHash,
} from './topic-maintenance-longitudinal-runtime.js';

interface Options {
  readonly corpus: string;
  readonly seal: string;
  readonly baseline: string;
  readonly output: string;
  readonly binary: string | null;
  readonly adapter: string | null;
  readonly modelRoot: string | null;
  readonly modelId: string;
  readonly alternateModelId: string | null;
  readonly alternatePermitted: boolean;
  readonly expectedHead: string | null;
  readonly gateEvidence: string | null;
  readonly repetitions: number;
  readonly execute: boolean;
  readonly replay: string | null;
}

const DEFAULT_FIXTURE = 'apps/threadnote/test/evaluation/fixtures/topic-maintenance-v1';
const MAX_ADAPTER_BYTES = 512 * 1024;

function optionsFromArgs(args: readonly string[]): Options {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--execute' || key === '--alternate-permitted') {
      flags.set(key, 'true');
      continue;
    }
    if (!key.startsWith('--') || flags.has(key) || args[index + 1] === undefined)
      throw new Error(`Invalid argument ${key}`);
    flags.set(key, args[++index]);
  }
  const known = new Set([
    '--corpus',
    '--seal',
    '--baseline',
    '--output',
    '--binary',
    '--adapter',
    '--model-root',
    '--model-id',
    '--alternate-model-id',
    '--alternate-permitted',
    '--expected-head',
    '--gate-evidence',
    '--repetitions',
    '--execute',
    '--replay',
  ]);
  if ([...flags.keys()].some(key => !known.has(key))) throw new Error('Unknown longitudinal runner option.');
  const repetitions = Number(flags.get('--repetitions') ?? '1');
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 10)
    throw new Error('Repetitions must be 1-10.');
  const binary = flags.get('--binary') ?? null;
  const adapter = flags.get('--adapter') ?? null;
  if (binary !== null && !isAbsolute(binary)) throw new Error('Binary path must be absolute.');
  if (adapter !== null && !isAbsolute(adapter)) throw new Error('Adapter path must be absolute.');
  if (flags.has('--replay') && flags.has('--execute')) throw new Error('--replay cannot execute models.');
  return {
    corpus: flags.get('--corpus') ?? `${DEFAULT_FIXTURE}/sequence.json`,
    seal: flags.get('--seal') ?? `${DEFAULT_FIXTURE}/sequence.sha256`,
    baseline: flags.get('--baseline') ?? `${DEFAULT_FIXTURE}/baseline.json`,
    output: flags.get('--output') ?? '.context/dev-cycle/phase-6/runs',
    binary,
    adapter,
    modelRoot: flags.get('--model-root') ?? null,
    modelId: flags.get('--model-id') ?? 'gemma-4-e4b-it-q4',
    alternateModelId: flags.get('--alternate-model-id') ?? null,
    alternatePermitted: flags.has('--alternate-permitted'),
    repetitions,
    execute: flags.has('--execute'),
    replay: flags.get('--replay') ?? null,
    expectedHead: flags.get('--expected-head') ?? null,
    gateEvidence: flags.get('--gate-evidence') ?? null,
  };
}

async function processResult(command: readonly string[], cwd: string, env: Record<string, string>, input?: string) {
  const child = Bun.spawn([...command], {
    cwd,
    env,
    stdin: input === undefined ? 'ignore' : new Blob([input]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill(), 30 * 60_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBoundedChildOutput(child.stdout, MAX_ADAPTER_BYTES, () => child.kill()),
      readBoundedChildOutput(child.stderr, MAX_ADAPTER_BYTES, () => child.kill()),
      child.exited,
    ]);
    return {stdout, stderr, exitCode};
  } finally {
    clearTimeout(timer);
  }
}

async function prepareSandbox(
  directory: string,
  baseline: {
    sourceFiles: readonly {path: string; content: string}[];
  },
) {
  const repo = join(directory, 'repo');
  const home = join(directory, 'home');
  await mkdir(repo, {recursive: true});
  await mkdir(home, {recursive: true});
  for (const source of baseline.sourceFiles) {
    if (
      !/^[a-zA-Z0-9._/-]+$/u.test(source.path) ||
      source.path.startsWith('/') ||
      source.path.split('/').some(segment => ['', '.', '..', '.git'].includes(segment))
    )
      throw new Error('Unsafe baseline fixture source path.');
    const path = join(repo, source.path);
    await mkdir(dirname(path), {recursive: true});
    await writeFile(path, source.content);
  }
  const manifest = join(directory, 'manifest.yaml');
  await writeFile(
    manifest,
    'version: 1\nprojects:\n  - name: fixture\n    path: ' +
      JSON.stringify(repo) +
      '\n    uri: threadnote://resources/repos/fixture\n    seed: []\n',
  );
  const env = topicStudyEnvironment({
    ...process.env,
    HOME: home,
    THREADNOTE_HOME: join(home, 'data-home'),
    THREADNOTE_USER: 'local',
    THREADNOTE_MANIFEST: manifest,
    THREADNOTE_TELEMETRY: 'off',
    NO_COLOR: '1',
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    DO_NOT_TRACK: '1',
  });
  for (const command of [
    ['git', 'init', '-q'],
    ['git', 'add', '.'],
    [
      'git',
      '-c',
      'user.name=Topic Study',
      '-c',
      'user.email=topic-study@example.invalid',
      'commit',
      '-qm',
      'sealed baseline',
    ],
  ]) {
    const result = await processResult(command, repo, topicStudyCommitEnvironment(env, 0));
    if (result.exitCode !== 0) throw new Error(`Sandbox Git setup failed: ${result.stderr}`);
  }
  const commit = (await processResult(['git', 'rev-parse', 'HEAD'], repo, env)).stdout.trim();
  return {repo, home, env, commit, manifest};
}

async function readGateEvidence(path: string | null): Promise<TopicStudyGateInputV1> {
  return path === null
    ? {
        realTopicPilotObserved: false,
        alternatePermittedAndMeasured: false,
        pairedHumanMedianReduction: null,
        totalCostMeasured: false,
        disagreementsAdjudicated: false,
        downstreamNoRegression: null,
      }
    : parseTopicStudyGateInputV1(JSON.parse(await readFile(path, 'utf8')) as unknown);
}

/** The failed slot must be durable before its precondition failure stops the study. */
export async function appendTopicStudySlotV1(
  path: string,
  row: ReturnType<typeof topicStudyLedgerRowV1>,
): Promise<boolean> {
  await appendFile(path, JSON.stringify(row) + '\n');
  return topicStudyPreconditionFailedV1(row.observation);
}

async function main() {
  const options = optionsFromArgs(Bun.argv.slice(2));
  const [json, seal, baselineJson] = await Promise.all([
    readFile(options.corpus, 'utf8'),
    readFile(options.seal, 'utf8'),
    readFile(options.baseline, 'utf8'),
  ]);
  const corpus = parseTopicStudyCorpusJsonV1(json);
  const canonicalSeal = sha256HexSync(topicStudyCanonicalJson(corpus));
  if (canonicalSeal !== seal.trim()) throw new Error('Corpus seal mismatch; no arm may run.');
  const baseline = JSON.parse(baselineJson) as {sourceFiles: readonly {path: string; content: string}[]};
  if (sha256HexSync(baselineJson) !== corpus.initialFixtureHash) throw new Error('Baseline fixture hash mismatch.');
  const corpusHash = topicStudyCorpusHashV1(corpus);
  if (options.replay !== null) {
    const runDirectory = await realpath(options.replay);
    const ledger = await readFile(join(runDirectory, 'outcomes.jsonl'), 'utf8');
    const rows = assertTopicStudyLedgerV1(ledger, corpus);
    const originalSummary = await readFile(join(runDirectory, 'summary.json'), 'utf8');
    const originalExecutionStatus =
      (JSON.parse(originalSummary) as {executionStatus?: unknown}).executionStatus ?? 'unspecified';
    const executionHeads = new Set<string>();
    const manifests = await Promise.all(
      [...new Set(rows.map(row => `${row.arm}-${row.repetition}`))].map(async key => {
        const raw = await readFile(join(runDirectory, `${key}-manifest.json`), 'utf8');
        const manifest = JSON.parse(raw) as {
          version?: unknown;
          arm?: unknown;
          repetition?: unknown;
          runNonce?: unknown;
          corpusHash?: unknown;
          canonicalSeal?: unknown;
          expectedHead?: unknown;
          runtime?: {sourceHead?: unknown};
        };
        if (
          manifest.version !== 1 ||
          `${manifest.arm}-${manifest.repetition}` !== key ||
          rows.some(row => `${row.arm}-${row.repetition}` === key && row.runNonce !== manifest.runNonce) ||
          manifest.corpusHash !== corpusHash ||
          manifest.canonicalSeal !== canonicalSeal ||
          typeof manifest.expectedHead !== 'string' ||
          !/^[0-9a-f]{40}$/u.test(manifest.expectedHead) ||
          manifest.runtime?.sourceHead !== manifest.expectedHead
        )
          throw new Error('Replay manifest does not match the sealed execution.');
        executionHeads.add(manifest.expectedHead);
        return {name: `${key}-manifest.json`, sha256: sha256HexSync(raw)};
      }),
    );
    if (executionHeads.size !== 1) throw new Error('Replay requires one immutable execution HEAD.');
    const planJson = await readFile(join(runDirectory, 'plan.json'), 'utf8').catch(error => {
      if ((error as {code?: string}).code === 'ENOENT') return null;
      throw error;
    });
    let plannedRepetitions: number | undefined;
    if (planJson !== null) {
      const plan = JSON.parse(planJson) as {
        version?: unknown;
        expectedHead?: unknown;
        corpusHash?: unknown;
        canonicalSeal?: unknown;
        repetitions?: unknown;
      };
      if (
        plan.version !== 1 ||
        plan.expectedHead !== [...executionHeads][0] ||
        plan.corpusHash !== corpusHash ||
        plan.canonicalSeal !== canonicalSeal ||
        typeof plan.repetitions !== 'number' ||
        !Number.isSafeInteger(plan.repetitions) ||
        plan.repetitions < 1 ||
        plan.repetitions > 10
      )
        throw new Error('Replay planned schedule is invalid.');
      plannedRepetitions = plan.repetitions;
    }
    const sourceRoot = resolve(import.meta.dir, '..');
    const current = await processResult(['git', 'rev-parse', 'HEAD'], sourceRoot, topicStudyEnvironment(process.env));
    if (current.exitCode !== 0) throw new Error('Analysis HEAD is unavailable.');
    const analysisRuntime = await captureTopicStudyRuntime(sourceRoot, current.stdout.trim());
    const analysisCodeHash = sha256HexSync(
      await readFile(join(sourceRoot, 'apps/threadnote/src/evaluation/topic-maintenance-longitudinal.ts')),
    );
    const summary = summarizeTopicStudyV1(
      rows,
      corpus,
      await readGateEvidence(options.gateEvidence),
      plannedRepetitions,
    );
    process.stdout.write(
      JSON.stringify({
        kind: 'topic-study-reanalysis',
        executionHead: [...executionHeads][0],
        analysisHead: analysisRuntime.sourceHead,
        analysisCodeHash,
        analysisRuntime,
        corpusHash,
        canonicalSeal,
        ledgerSha256: sha256HexSync(ledger),
        originalSummarySha256: sha256HexSync(originalSummary),
        originalExecutionStatus,
        planSha256: planJson === null ? null : sha256HexSync(planJson),
        manifests,
        summary,
      }) + '\n',
    );
    return;
  }
  if (!options.execute) {
    process.stdout.write(
      JSON.stringify({
        status: 'validated',
        events: corpus.events.length,
        corpusHash,
        canonicalSeal,
        executedArms: 0,
        decision: 'HOLD',
      }) + '\n',
    );
    return;
  }
  const output = resolve(options.output);
  if (!output.includes('/.context/dev-cycle/phase-6/'))
    throw new Error('Raw evaluation output must remain inside ignored .context/dev-cycle/phase-6/.');
  await mkdir(output, {recursive: true, mode: 0o700});
  const runDirectory = await mkdtemp(join(output, 'longitudinal-'));
  const ledgerPath = join(runDirectory, 'outcomes.jsonl');
  if (options.binary === null) throw new Error('--execute requires an absolute installed Threadnote binary.');
  if (!options.expectedHead || !/^[0-9a-f]{40}$/u.test(options.expectedHead))
    throw new Error('--execute requires --expected-head with the exact committed installation SHA.');
  const binary = await realpath(options.binary);
  const adapter = await realpath(options.adapter ?? 'scripts/topic-maintenance-longitudinal-native-adapter.ts');
  const runtime = await captureTopicStudyRuntime(resolve(import.meta.dir, '..'), options.expectedHead);
  await assertTopicStudySourceAdapter(runtime.sourceRoot, adapter);
  const binaryHash = await topicStudyFileHash(binary);
  const modelManifest = BUILTIN_MODEL_MANIFESTS.find(item => item.id === options.modelId && item.role === 'generation');
  if (!modelManifest || options.modelRoot === null)
    throw new Error('--execute requires a pinned generation --model-id and --model-root.');
  const verifiedModel = await prepareTopicStudyModel(
    join(await realpath(options.modelRoot), `${modelManifest.sha256}.gguf`),
    join(runDirectory, 'verified-model', `${modelManifest.sha256}.gguf`),
    modelManifest,
  );
  let previousHash: string | null = null;
  const rows: ReturnType<typeof topicStudyLedgerRowV1>[] = [];
  await writeFile(
    join(runDirectory, 'plan.json'),
    JSON.stringify({
      version: 1,
      expectedHead: options.expectedHead,
      corpusHash,
      canonicalSeal,
      repetitions: options.repetitions,
      comparisonMethod: TOPIC_STUDY_COMPARISON_METHOD_V1,
    }),
  );
  for (const arm of TOPIC_STUDY_ARMS) {
    for (let repetition = 1; repetition <= options.repetitions; repetition++) {
      const expectedSourceFiles = new Map(baseline.sourceFiles.map(source => [source.path, source.content]));
      const runNonce = `run_${randomBytes(16).toString('hex')}`;
      const sandbox = await prepareSandbox(join(runDirectory, `${arm}-${repetition}`), baseline);
      if (arm !== 'maintained-alternate' || !options.alternatePermitted) {
        sandbox.env.THREADNOTE_EFFECT_AI = 'off';
        delete sandbox.env.THREADNOTE_EFFECT_AI_API_KEY;
        delete sandbox.env.THREADNOTE_EFFECT_AI_API_URL;
        delete sandbox.env.THREADNOTE_EFFECT_AI_MODEL;
      }
      if (options.modelRoot !== null) {
        const models = join(sandbox.home, 'data-home', 'models', 'generation');
        await mkdir(models, {recursive: true});
        await symlink(dirname(verifiedModel.path), join(models, options.modelId), 'dir');
      }
      const binaryVersion = await processResult([binary, '--version'], sandbox.repo, sandbox.env);
      if (binaryVersion.exitCode !== 0 || !binaryVersion.stdout.includes(`.g${options.expectedHead}`))
        throw new Error('Installed Threadnote runtime does not match --expected-head.');
      const manifest = {
        version: 1,
        arm,
        comparisonMethod: TOPIC_STUDY_COMPARISON_METHOD_V1,
        repetition,
        runNonce,
        corpusHash,
        canonicalSeal,
        initialCommit: sandbox.commit,
        binary,
        binaryVersion: binaryVersion?.stdout.trim() ?? null,
        adapter,
        home: sandbox.home,
        repository: sandbox.repo,
        manifestPath: sandbox.manifest,
        modelId: options.modelId,
        alternateModelId: options.alternateModelId,
        alternatePermitted: options.alternatePermitted,
        expectedHead: options.expectedHead,
        runtime,
        binaryHash,
        verifiedModel,
        adapterHash: sha256HexSync(await readFile(adapter)),
        localModelHelperHash: sha256HexSync(await readFile('scripts/topic-maintenance-longitudinal-local-model.ts')),
      };
      const manifestPath = join(runDirectory, `${arm}-${repetition}-manifest.json`);
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
      for (const event of corpus.events) {
        await assertTopicStudyRuntime(runtime);
        await assertTopicStudyModel(verifiedModel);
        if ((await topicStudyFileHash(binary)) !== binaryHash)
          throw new Error('Installed binary drift; study aborted.');
        const fixtureGit = async (args: readonly string[], postReview = false) => {
          const result = await processResult(
            ['git', ...args],
            sandbox.repo,
            topicStudyCommitEnvironment(sandbox.env, event.index, postReview),
          );
          if (result.exitCode !== 0) throw new Error('Authored fixture Git transition failed.');
          return result.stdout.trim();
        };
        const transition = async (changes: typeof event.changes, commit: boolean, label: string) => {
          const changed = await applyTopicStudySourceChanges(sandbox.repo, changes);
          if (commit && (changed || label === event.id)) {
            await fixtureGit(['add', '-A']);
            await fixtureGit(
              [
                '-c',
                'user.name=Topic Study',
                '-c',
                'user.email=topic-study@example.invalid',
                'commit',
                '--allow-empty',
                '-qm',
                label,
              ],
              label !== event.id,
            );
          }
        };
        await transition(event.changes, event.commit, event.id);
        for (const change of [...event.changes, ...event.postReviewChanges]) {
          if (change.content === null) expectedSourceFiles.delete(change.path);
          else expectedSourceFiles.set(change.path, change.content);
        }
        let observation: TopicStudyObservationV1 = topicStudyUnavailableObservationV1(
          event,
          'Native CLI event adapter did not return a valid observation.',
        );
        if (binaryVersion.exitCode === 0) {
          const request = {
            version: 1,
            event,
            arm,
            repetition,
            runNonce,
            corpusHash,
            manifestPath,
            binary,
            repository: sandbox.repo,
            home: sandbox.home,
            baseline: resolve(options.baseline),
          };
          try {
            const result = await withTopicStudyTimeline(
              async () => {},
              () => transition(event.postReviewChanges, true, `${event.id}-post-review`),
              () => processResult([process.execPath, adapter], sandbox.repo, sandbox.env, JSON.stringify(request)),
            );
            if (result.exitCode === 0) {
              const candidate = JSON.parse(result.stdout) as TopicStudyObservationV1;
              const proposed = topicStudyLedgerRowV1({
                corpusHash,
                runNonce,
                arm: arm,
                repetition,
                eventIndex: event.index,
                eventId: event.id,
                observation: candidate,
                previousHash,
              });
              assertTopicStudyLedgerV1([...rows, proposed].map(row => JSON.stringify(row)).join('\n'), corpus);
              observation = candidate;
            } else
              observation = {
                ...topicStudyUnavailableObservationV1(
                  event,
                  `${TOPIC_STUDY_PRECONDITION_FAILURE_PREFIX}Adapter exited ${result.exitCode}; its public review lifecycle could not be verified.`,
                ),
                status: 'failed',
              };
          } catch (error) {
            observation = {
              ...topicStudyUnavailableObservationV1(
                event,
                `${TOPIC_STUDY_PRECONDITION_FAILURE_PREFIX}${error instanceof Error ? error.message : 'Adapter failed.'} Its public review lifecycle could not be verified.`,
              ),
              status: 'failed',
            };
          }
        }
        await assertTopicStudyRuntime(runtime);
        await assertTopicStudyModel(verifiedModel);
        if ((await topicStudyFileHash(binary)) !== binaryHash)
          throw new Error('Installed binary drift; study aborted.');
        const actualSourceTreeHash = await topicStudySourceTreeHash(sandbox.repo);
        if (actualSourceTreeHash !== topicStudyExpectedSourceTreeHash(expectedSourceFiles))
          throw new Error('Actual fixture tree differs from the sealed authored timeline; study aborted.');
        observation = {
          ...observation,
          sourceCommit: await fixtureGit(['rev-parse', 'HEAD']),
          sourceTreeHash: actualSourceTreeHash,
        };
        const row = topicStudyLedgerRowV1({
          corpusHash,
          runNonce,
          arm: arm,
          repetition,
          eventIndex: event.index,
          eventId: event.id,
          observation,
          previousHash,
        });
        rows.push(row);
        previousHash = row.hash;
        if (await appendTopicStudySlotV1(ledgerPath, row)) {
          const summary = summarizeTopicStudyV1(
            rows,
            corpus,
            await readGateEvidence(options.gateEvidence),
            options.repetitions,
          );
          await writeFile(
            join(runDirectory, 'summary.json'),
            JSON.stringify({executionStatus: 'precondition-failed', reason: observation.reason, ...summary}, null, 2),
          );
          process.stdout.write(
            JSON.stringify({
              runDirectory,
              corpusHash,
              executionStatus: 'precondition-failed',
              reason: observation.reason,
              ...summary,
            }) + '\n',
          );
          process.exitCode = 1;
          return;
        }
      }
    }
  }
  await assertTopicStudyRuntime(runtime, true);
  await assertTopicStudyModel(verifiedModel, true);
  assertTopicStudyLedgerV1(await readFile(ledgerPath, 'utf8'), corpus);
  const gate = await readGateEvidence(options.gateEvidence);
  const summary = summarizeTopicStudyV1(rows, corpus, gate, options.repetitions);
  await writeFile(
    join(runDirectory, 'summary.json'),
    JSON.stringify({executionStatus: 'completed', ...summary}, null, 2),
  );
  process.stdout.write(JSON.stringify({runDirectory, corpusHash, ...summary}) + '\n');
}

if (import.meta.main) await main();
