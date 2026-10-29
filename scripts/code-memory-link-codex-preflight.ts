import {Array as EffectArray, Predicate} from 'effect';
/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- This reviewed preflight owns exact Git and candidate CLI operating-system process boundaries. */
import {createHash} from 'node:crypto';
import {mkdir, readFile, realpath, stat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {
  CODE_MEMORY_LINK_CANONICAL_EMPTY_CONTEXT_BRIEF_V1,
  canonicalizeCodeMemoryLinkContextBriefResultV1,
  codeMemoryLinkGoldCitationDigest,
  type CodeMemoryLinkContextBriefResponseReceiptV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-protocol';
import type {CodeMemoryLinkCodexClientConfigV1} from './code-memory-link-codex-isolation.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const CODE_MEMORY_LINK_EVALUATION_ACCOUNT = 'local' as const;
export const CODE_MEMORY_LINK_EVALUATION_AGENT_ID = 'agent-gate' as const;
export const CODE_MEMORY_LINK_EVALUATION_USER = 'code-memory-link' as const;

export interface CodeMemoryLinkCandidatePreflightResultV1 {
  readonly graphContentId: string;
  readonly graphSnapshotDigest: string;
  readonly observedCitationDigests: readonly string[];
  readonly observedSelectedMemories: readonly CodeMemoryLinkExpectedSelectedMemoryV1[];
  readonly responses: {
    readonly anchored: CodeMemoryLinkContextBriefResponseReceiptV1;
    readonly noMemory: CodeMemoryLinkContextBriefResponseReceiptV1;
    readonly taskOnly: CodeMemoryLinkContextBriefResponseReceiptV1;
  };
}

export interface CodeMemoryLinkExpectedSelectedMemoryV1 {
  readonly contentSha256: string;
  readonly memoryIdDigest: string;
}

export async function initializeCodeMemoryLinkFixtureRepository(input: {
  readonly config: CodeMemoryLinkCodexClientConfigV1;
  readonly repositoryRoot: string;
  readonly taskId: string;
  readonly temporaryHome: string;
}): Promise<{readonly commit: string; readonly origin: string}> {
  await assertReviewedExecutable(input.config.git.executable, input.config.git.executableSha256, 'Git executable');
  const origin = `https://fixtures.threadnote.invalid/code-memory-link/${input.taskId}.git`;
  const environment = {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: input.temporaryHome,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PATH: input.config.safeExecutablePath,
  };
  await mkdir(input.temporaryHome, {recursive: false, mode: 0o700});
  const run = (args: readonly string[]) =>
    capture(input.config.git.executable, args, {
      cwd: input.repositoryRoot,
      environment,
      maxOutputBytes: 64 * 1_024,
      timeoutMilliseconds: 30_000,
    });
  await run(['-c', 'init.defaultBranch=main', 'init', '--quiet']);
  await run(['remote', 'add', 'origin', origin]);
  await run(['add', '--all']);
  await capture(input.config.git.executable, ['commit', '--quiet', '--no-gpg-sign', '-m', `fixture ${input.taskId}`], {
    cwd: input.repositoryRoot,
    environment: {
      ...environment,
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
      GIT_AUTHOR_EMAIL: 'fixture@threadnote.invalid',
      GIT_AUTHOR_NAME: 'Threadnote Fixture',
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
      GIT_COMMITTER_EMAIL: 'fixture@threadnote.invalid',
      GIT_COMMITTER_NAME: 'Threadnote Fixture',
    },
    maxOutputBytes: 64 * 1_024,
    timeoutMilliseconds: 30_000,
  });
  const commit = Effect.pipe((await run(['rev-parse', 'HEAD'])).stdout, EffectString.trim);
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error('Disposable fixture did not produce one deterministic commit.');
  if ((await run(['status', '--porcelain=v1'])).stdout !== '') {
    throw new Error('Disposable fixture repository is not clean after deterministic initialization.');
  }
  return {commit, origin};
}

export async function preflightCodeMemoryLinkCandidate(input: {
  readonly budgetTokens: number;
  readonly candidateExecutable: string;
  readonly candidateExecutableSha256: string;
  readonly codeRefs: readonly string[];
  readonly expectedGoldCitationDigests: readonly string[];
  readonly expectedPreflightCitationDigests: readonly string[];
  readonly expectedSelectedMemories: readonly CodeMemoryLinkExpectedSelectedMemoryV1[];
  readonly expectedResponses: CodeMemoryLinkCandidatePreflightResultV1['responses'];
  readonly expectedCommit: string;
  readonly expectedOrigin: string;
  readonly project: string;
  readonly repositoryRoot: string;
  readonly safeExecutablePath: string;
  readonly task: string;
  readonly threadnoteHome: string;
}): Promise<CodeMemoryLinkCandidatePreflightResultV1> {
  const budgetTokens = Math.min(1_250, input.budgetTokens);
  if (!Number.isSafeInteger(budgetTokens) || budgetTokens < 1) {
    throw new Error('Candidate preflight token dose is invalid.');
  }
  await assertReviewedExecutable(input.candidateExecutable, input.candidateExecutableSha256, 'candidate executable');
  const environment = candidateEnvironment(input.threadnoteHome, input.safeExecutablePath);
  const run = (args: readonly string[], timeoutMilliseconds = 120_000) =>
    capture(input.candidateExecutable, args, {
      cwd: input.repositoryRoot,
      environment,
      maxOutputBytes: 2 * 1_024 * 1_024,
      timeoutMilliseconds,
    });
  await run(
    ['graph', 'index', '--home', input.threadnoteHome, '--cwd', input.repositoryRoot, '--no-vectors', '--json'],
    300_000,
  );
  const graph = assertCodeMemoryLinkGraphStatusPreflight(
    parseJson(
      (await run(['graph', 'status', '--home', input.threadnoteHome, '--cwd', input.repositoryRoot, '--json'])).stdout,
      'graph status',
    ),
    {commit: input.expectedCommit, origin: input.expectedOrigin, repositoryRoot: input.repositoryRoot},
  );
  const contextBrief = async (codeRefs: readonly string[]) =>
    object(
      parseJson(
        (
          await run([
            'context',
            'brief',
            '--json',
            '--task',
            input.task,
            '--cwd',
            input.repositoryRoot,
            '--home',
            input.threadnoteHome,
            '--project',
            input.project,
            '--mode',
            'brief',
            '--budget-tokens',
            String(budgetTokens),
            ...EffectArray.flatMap(codeRefs, reference => ['--code-ref', reference]),
          ])
        ).stdout,
        'Context Brief preflight',
      ),
      'Context Brief preflight',
    );
  const brief = await contextBrief(input.codeRefs);
  const taskOnlyBrief = await contextBrief([]);
  const observedCitationDigests = contextBriefCitationDigests(brief);
  const observedSelectedMemories = codeMemoryLinkContextBriefSelectedMemoriesV1(brief);
  const expectedGold = [...input.expectedGoldCitationDigests].sort();
  const expectedPreflight = [...input.expectedPreflightCitationDigests];
  if (EffectArray.some(expectedGold, digest => !observedCitationDigests.includes(digest))) {
    throw new Error('Rebuilt exact-current graph did not reproduce every sealed gold citation digest.');
  }
  if (
    observedCitationDigests.length !== expectedPreflight.length ||
    EffectArray.some(observedCitationDigests, (digest, index) => digest !== expectedPreflight[index])
  ) {
    throw new Error('Rebuilt exact-current graph differs from the sealed preflight citation digest set.');
  }
  assertCodeMemoryLinkSelectedMemoryRosterV1(input.expectedSelectedMemories, observedSelectedMemories);
  const responses = {
    anchored: canonicalizeCodeMemoryLinkContextBriefResultV1(brief).receipt,
    noMemory: canonicalizeCodeMemoryLinkContextBriefResultV1(
      CODE_MEMORY_LINK_CANONICAL_EMPTY_CONTEXT_BRIEF_V1.structuredContent,
    ).receipt,
    taskOnly: canonicalizeCodeMemoryLinkContextBriefResultV1(taskOnlyBrief).receipt,
  };
  if (JSON.stringify(responses) !== JSON.stringify(input.expectedResponses)) {
    throw new Error('Production Context Brief arm responses differ from their exact sealed projections.');
  }
  await assertReviewedExecutable(input.candidateExecutable, input.candidateExecutableSha256, 'candidate executable');
  return {
    graphContentId: graph.graphContentId,
    graphSnapshotDigest: domainDigest('graph-snapshot', graph.snapshotId),
    observedCitationDigests,
    observedSelectedMemories,
    responses,
  };
}

export function codeMemoryLinkContextBriefSelectedMemoriesV1(
  briefInput: unknown,
): readonly CodeMemoryLinkExpectedSelectedMemoryV1[] {
  const brief = object(briefInput, 'Context Brief selected-memory roster');
  if (brief.type !== 'context-brief' || (brief.version !== 2 && brief.version !== 3)) {
    throw new Error('Candidate preflight did not return a supported Context Brief.');
  }
  return canonicalizeCodeMemoryLinkContextBriefResultV1(brief).receipt.selectedMemories;
}

export function assertCodeMemoryLinkSelectedMemoryRosterV1(expectedInput: unknown, observedInput: unknown): void {
  const expected = selectedMemoryRoster(expectedInput, 'sealed selected-memory roster');
  const observed = selectedMemoryRoster(observedInput, 'observed selected-memory roster');
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new Error('Production Context Brief differs from the sealed selected-memory identity/content roster.');
  }
}

export function assertCodeMemoryLinkGraphStatusPreflight(
  value: unknown,
  expected: {readonly commit: string; readonly origin: string; readonly repositoryRoot: string},
): {readonly graphContentId: string; readonly snapshotId: string} {
  const status = object(value, 'graph status');
  if (
    status.type !== 'code-graph-status' ||
    (status.version !== 2 && status.version !== 3 && status.version !== 4 && status.version !== 5) ||
    status.stale !== false
  ) {
    throw new Error('Candidate graph preflight did not publish an exact-current graph.');
  }
  const identity = object(status.identity, 'graph repository identity');
  const expectedRemoteIdentity = normalizedFixtureRemote(expected.origin);
  if (
    identity.headCommit !== expected.commit ||
    identity.repoRoot !== expected.repositoryRoot ||
    identity.remoteIdentity !== expectedRemoteIdentity
  ) {
    throw new Error('Candidate graph preflight resolved another repository identity.');
  }
  const repositoryId = boundedText(identity.repositoryId, 'graph repository id', 256);
  const readySnapshot = object(status.readySnapshot, 'ready graph snapshot');
  const snapshotId = boundedText(readySnapshot.id, 'ready graph snapshot id', 256);
  const graphContentId = boundedText(readySnapshot.graphContentId, 'ready graph content id', 256);
  if (
    readySnapshot.commit !== expected.commit ||
    readySnapshot.dirty !== false ||
    readySnapshot.state !== 'ready' ||
    readySnapshot.repositoryId !== repositoryId
  ) {
    throw new Error('Candidate graph preflight selected another or non-ready snapshot.');
  }
  return {graphContentId, snapshotId};
}

function normalizedFixtureRemote(origin: string): string {
  const parsed = new URL(origin);
  const path = Effect.pipe(
    parsed.pathname,
    EffectString.replace(/^\/+|\/+$/gu, ''),
    EffectString.replace(/\.git$/u, ''),
  );
  if (!parsed.hostname || !path) throw new Error('Fixture origin is invalid.');
  return `${Effect.pipe(parsed.hostname, EffectString.toLowerCase)}/${path}`;
}

export function candidateEnvironment(
  threadnoteHome: string,
  safeExecutablePath: string,
): Readonly<Record<string, string>> {
  return {
    CI: '1',
    HOME: threadnoteHome,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
    NO_UPDATE_NOTIFIER: '1',
    PATH: safeExecutablePath,
    THREADNOTE_ACCOUNT: CODE_MEMORY_LINK_EVALUATION_ACCOUNT,
    THREADNOTE_AGENT_ID: CODE_MEMORY_LINK_EVALUATION_AGENT_ID,
    THREADNOTE_HOME: threadnoteHome,
    THREADNOTE_NO_SPINNER: '1',
    THREADNOTE_NO_UPDATE_CHECK: '1',
    THREADNOTE_USER: CODE_MEMORY_LINK_EVALUATION_USER,
  };
}

function contextBriefCitationDigests(brief: Record<string, unknown>): readonly string[] {
  if (brief.type !== 'context-brief' || (brief.version !== 2 && brief.version !== 3)) {
    throw new Error('Candidate preflight did not return a supported Context Brief.');
  }
  if (!EffectArray.isArray(brief.durableDecisions) || !EffectArray.isArray(brief.activeHandoffs)) {
    throw new Error('Candidate preflight Context Brief is missing its memory arrays.');
  }
  const digests = EffectArray.flatMap([...brief.durableDecisions, ...brief.activeHandoffs], (entry, index) => {
    const memory = object(entry, `Context Brief memory ${index + 1}`);
    if (memory.selectionBasis !== 'code-citation') return [];
    if (!EffectArray.isArray(memory.codeRelations)) throw new Error('Code-selected memory has no relation receipts.');
    return EffectArray.flatMap(memory.codeRelations, (entry, relationIndex) => {
      const relation = object(entry, `Context Brief relation ${relationIndex + 1}`);
      if (relation.status !== 'exact' && relation.status !== 'relocated') return [];
      return [codeMemoryLinkGoldCitationDigest(boundedText(relation.citationId, 'citation id', 256))];
    });
  });
  return [...new Set(digests)].sort();
}

async function assertReviewedExecutable(path: string, expectedSha256: string, label: string): Promise<void> {
  const canonical = await realpath(path);
  if (canonical !== path || !(await stat(canonical)).isFile()) {
    throw new Error(`${label} is no longer one canonical regular file.`);
  }
  const digest = createHash('sha256')
    .update(await readFile(canonical))
    .digest('hex');
  if (digest !== expectedSha256) throw new Error(`${label} hash changed during the trial.`);
}

async function capture(
  executable: string,
  args: readonly string[],
  input: {
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly maxOutputBytes: number;
    readonly timeoutMilliseconds: number;
  },
): Promise<{readonly stdout: string}> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [...args], {
      cwd: input.cwd,
      env: {...input.environment},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let exceeded = false;
    const timeout = setTimeout(() => child.kill('SIGKILL'), input.timeoutMilliseconds);
    child.stdout.on('data', value => {
      const chunk = Buffer.from(value);
      stdoutBytes += chunk.length;
      if (stdoutBytes > input.maxOutputBytes) {
        exceeded = true;
        child.kill('SIGKILL');
      } else stdout.push(chunk);
    });
    child.stderr.on('data', value => {
      const chunk = Buffer.from(value);
      stderrBytes += chunk.length;
      if (stderrBytes <= 64 * 1_024) stderr.push(chunk);
    });
    child.once('error', reject);
    child.once('exit', code => {
      clearTimeout(timeout);
      if (exceeded) reject(new Error('Reviewed preflight command exceeded its output budget.'));
      else if (code !== 0) {
        reject(
          new Error(
            `Reviewed preflight command failed: ${Effect.pipe(Buffer.concat(stderr).toString('utf8'), EffectString.slice(-2048))}`,
          ),
        );
      } else resolvePromise({stdout: Buffer.concat(stdout).toString('utf8')});
    });
  });
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (cause) {
    throw new Error(`${label} returned invalid JSON.`, {cause});
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new Error(`${label} must be bounded non-empty text.`);
  }
  return value;
}

function selectedMemoryRoster(value: unknown, label: string): readonly CodeMemoryLinkExpectedSelectedMemoryV1[] {
  if (!EffectArray.isArray(value) || value.length > 24) throw new Error(`${label} must be a bounded array.`);
  const memories = EffectArray.map(value, (entry, index) => {
    const memory = object(entry, `${label}[${index}]`);
    const keys = EffectRecord.keys(memory).sort();
    if (keys.length !== 2 || keys[0] !== 'contentSha256' || keys[1] !== 'memoryIdDigest') {
      throw new Error(`${label}[${index}] has unsupported or missing fields.`);
    }
    return {
      contentSha256: digest(memory.contentSha256, `${label}[${index}].contentSha256`),
      memoryIdDigest: digest(memory.memoryIdDigest, `${label}[${index}].memoryIdDigest`),
    };
  });
  if (
    EffectArray.some(
      memories,
      (entry, index) =>
        index > 0 &&
        (memories[index - 1].memoryIdDigest > entry.memoryIdDigest ||
          (memories[index - 1].memoryIdDigest === entry.memoryIdDigest &&
            memories[index - 1].contentSha256 >= entry.contentSha256)),
    )
  ) {
    throw new Error(`${label} must be unique and canonically sorted.`);
  }
  if (new Set(EffectArray.map(memories, memory => memory.memoryIdDigest)).size !== memories.length) {
    throw new Error(`${label} memory identities must be unique.`);
  }
  return memories;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function domainDigest(domain: string, value: string): string {
  return createHash('sha256').update(`threadnote-code-memory-link-${domain}-v1\0${value}`).digest('hex');
}
