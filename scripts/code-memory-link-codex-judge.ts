import {Array as EffectArray, Predicate} from 'effect';
/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- This reviewed static-judge adapter owns disposable filesystem and child-process boundaries. */
import {createHash} from 'node:crypto';
import {chmod, mkdir, readFile, realpath, stat, writeFile} from 'node:fs/promises';
import {dirname, join, resolve, sep} from 'node:path';
import {
  codeMemoryLinkStaticArtifactSha256,
  evaluateCodeMemoryLinkStaticArtifactsV1,
  type CodeMemoryLinkRubricV1,
  type CodeMemoryLinkStaticArtifactInputV1,
  type CodeMemoryLinkStaticJudgmentV1,
  type CodeMemoryLinkStaticObservationV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-protocol';
import {codeMemoryLinkAgentSuiteGuardArtifactId} from '@threadnote/threadnote/evaluation/code-memory-link-agent-suite';
import type {CodeMemoryLinkCodexClientConfigV1} from './code-memory-link-codex-isolation.js';
import type {
  CodeMemoryLinkCodexJudgeCommandV1,
  CodeMemoryLinkVerifiedArtifactV1,
} from './code-memory-link-codex-suite.js';
import {captureCodeMemoryLinkProcessGroup} from './code-memory-link-process-boundary.js';
import {
  assertCodeMemoryLinkRepositorySnapshot,
  type CodeMemoryLinkRepositorySnapshotV1,
} from './code-memory-link-repository-snapshot.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export interface CodeMemoryLinkJudgeRunResultV1 {
  readonly commandArtifactId: string;
  readonly commandSha256: string;
  readonly judgment: CodeMemoryLinkStaticJudgmentV1;
  readonly observation: CodeMemoryLinkStaticObservationV1;
  readonly programArtifactId: string;
  readonly programSha256: string;
  readonly repositorySnapshotHash: string;
  readonly runBindingHash: string;
  readonly staticArtifacts: readonly CodeMemoryLinkStaticArtifactInputV1[];
  readonly stderrSha256: string;
  readonly stdoutSha256: string;
}

export interface CodeMemoryLinkPublicArtifactDescriptorV1 {
  readonly byteCount: number;
  readonly contentSha256: string;
  readonly pathDigest: string;
  readonly type: 'file';
}

const MAXIMUM_STATIC_ARTIFACT_BYTES = 1 * 1_024 * 1_024;
const MAXIMUM_STATIC_ARTIFACT_TOTAL_BYTES = 4 * 1_024 * 1_024;

export async function materializeCodeMemoryLinkArtifacts(
  root: string,
  artifacts: readonly CodeMemoryLinkVerifiedArtifactV1[],
): Promise<void> {
  await mkdir(root, {recursive: true, mode: 0o700});
  for (const artifact of artifacts) {
    const destination = resolve(root, artifact.destination);
    if (destination !== root && !Effect.pipe(destination, EffectString.startsWith(`${root}${sep}`))) {
      throw new Error('Materialized sealed artifact escaped its disposable root.');
    }
    await mkdir(dirname(destination), {recursive: true, mode: 0o700});
    await writeFile(destination, artifact.bytes, {flag: 'wx', mode: 0o600});
  }
}

export async function runCodeMemoryLinkStaticJudge(input: {
  readonly command: CodeMemoryLinkCodexJudgeCommandV1;
  readonly commandArtifact: CodeMemoryLinkVerifiedArtifactV1;
  readonly config: CodeMemoryLinkCodexClientConfigV1;
  readonly judgeFiles: readonly CodeMemoryLinkVerifiedArtifactV1[];
  readonly judgeRoot: string;
  readonly programArtifact: CodeMemoryLinkVerifiedArtifactV1;
  readonly qualifyingActionItemId: string | null;
  readonly repositorySnapshot: CodeMemoryLinkRepositorySnapshotV1;
  readonly rubric: CodeMemoryLinkRubricV1;
  readonly runBindingHash: string;
  readonly taskId: string;
}): Promise<CodeMemoryLinkJudgeRunResultV1> {
  await assertCodeMemoryLinkRepositorySnapshot(input.repositorySnapshot);
  await materializeCodeMemoryLinkArtifacts(input.judgeRoot, input.judgeFiles);
  const programPath = resolve(input.judgeRoot, input.programArtifact.destination);
  await assertMaterializedArtifact(programPath, input.programArtifact);
  const privateHome = join(input.judgeRoot, '.runner-home');
  const temporary = join(input.judgeRoot, '.runner-tmp');
  await Promise.all([mkdir(privateHome, {mode: 0o700}), mkdir(temporary, {mode: 0o700})]);
  const guardArtifactId = codeMemoryLinkAgentSuiteGuardArtifactId(input.taskId);
  const guardRequired = EffectArray.some(
    input.rubric.predicates,
    predicate => predicate.assertion.artifactId === guardArtifactId,
  );
  let output: {readonly stderr: string; readonly stdout: string};
  try {
    output = await captureCodeMemoryLinkProcessGroup({
      arguments: [
        programPath,
        '--repository',
        input.repositorySnapshot.root,
        '--task-id',
        input.taskId,
        ...(guardRequired ? ['--guard-required'] : []),
      ],
      command: input.config.proxy.bunExecutable,
      cwd: input.judgeRoot,
      environment: {
        HOME: privateHome,
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        NO_COLOR: '1',
        PATH: dirname(input.config.proxy.bunExecutable),
        THREADNOTE_CODE_MEMORY_LINK_RUN_BINDING_HASH: matchingHash(input.runBindingHash, 'run binding'),
        TMPDIR: temporary,
      },
      label: 'Static judge command',
      maxOutputBytes: input.command.maxOutputBytes,
      timeoutMilliseconds: input.command.timeoutMilliseconds,
    });
  } finally {
    await assertCodeMemoryLinkRepositorySnapshot(input.repositorySnapshot);
  }
  const staticArtifacts = parseJudgeOutput(output.stdout, input.rubric);
  const {judgment, observation} = evaluateCodeMemoryLinkStaticArtifactsV1({
    artifacts: staticArtifacts,
    qualifyingActionItemId: input.qualifyingActionItemId,
    rubric: input.rubric,
  });
  return {
    commandArtifactId: input.commandArtifact.artifactId,
    commandSha256: input.commandArtifact.sha256,
    judgment,
    observation,
    programArtifactId: input.programArtifact.artifactId,
    programSha256: input.programArtifact.sha256,
    repositorySnapshotHash: input.repositorySnapshot.repositorySnapshotHash,
    runBindingHash: matchingHash(input.runBindingHash, 'run binding'),
    staticArtifacts,
    stderrSha256: sha256(output.stderr),
    stdoutSha256: sha256(output.stdout),
  };
}

function matchingHash(value: string, label: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error(`Static judge ${label} is invalid.`);
  return value;
}

export async function collectCodeMemoryLinkPublicArtifacts(
  repositorySnapshot: CodeMemoryLinkRepositorySnapshotV1,
): Promise<readonly CodeMemoryLinkPublicArtifactDescriptorV1[]> {
  const files = await assertCodeMemoryLinkRepositorySnapshot(repositorySnapshot);
  return EffectArray.map(files, file => ({
    byteCount: file.byteCount,
    contentSha256: file.contentSha256,
    pathDigest: domainDigest('public-path', file.relativePath),
    type: 'file',
  }));
}

function parseJudgeOutput(
  stdout: string,
  rubric: CodeMemoryLinkRubricV1,
): readonly CodeMemoryLinkStaticArtifactInputV1[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (cause) {
    throw new Error('Static judge returned invalid JSON.', {cause});
  }
  const envelope = object(parsed, 'static judge output');
  exactKeys(envelope, ['artifacts', 'version'], 'static judge output');
  if (envelope.version !== 1 || !EffectArray.isArray(envelope.artifacts)) {
    throw new Error('Static judge output version or artifacts are invalid.');
  }
  let totalBytes = 0;
  const artifacts = EffectArray.map(envelope.artifacts, (entry, index) => {
    const artifact = object(entry, `static artifact ${index + 1}`);
    exactKeys(artifact, ['artifactId', 'content', 'mediaType', 'sha256'], `static artifact ${index + 1}`);
    if (typeof artifact.artifactId !== 'string' || !/^art_[0-9a-f]{16,64}$/u.test(artifact.artifactId)) {
      throw new Error('Static judge emitted an invalid artifact id.');
    }
    if (artifact.mediaType !== 'text/plain' && artifact.mediaType !== 'application/json') {
      throw new Error('Static judge emitted an unsupported artifact media type.');
    }
    if (typeof artifact.content !== 'string') throw new Error('Static judge artifact content must be UTF-8 text.');
    const byteCount = Buffer.byteLength(artifact.content, 'utf8');
    if (byteCount > MAXIMUM_STATIC_ARTIFACT_BYTES) throw new Error('Static judge artifact exceeds its byte limit.');
    totalBytes += byteCount;
    if (totalBytes > MAXIMUM_STATIC_ARTIFACT_TOTAL_BYTES) {
      throw new Error('Static judge artifact set exceeds its aggregate byte limit.');
    }
    if (artifact.mediaType === 'application/json') {
      try {
        JSON.parse(artifact.content);
      } catch (cause) {
        throw new Error('Static judge JSON artifact is invalid.', {cause});
      }
    }
    const expectedSha256 = codeMemoryLinkStaticArtifactSha256(artifact.content);
    if (artifact.sha256 !== expectedSha256) throw new Error('Static judge artifact hash does not match its content.');
    return {
      artifactId: artifact.artifactId,
      content: artifact.content,
      mediaType: artifact.mediaType,
      sha256: expectedSha256,
    } satisfies CodeMemoryLinkStaticArtifactInputV1;
  });
  const requiredIds = [
    ...new Set(EffectArray.map(rubric.predicates, predicate => predicate.assertion.artifactId)),
  ].sort();
  if (
    artifacts.length !== requiredIds.length ||
    EffectArray.some(artifacts, (artifact, index) => artifact.artifactId !== requiredIds[index])
  ) {
    throw new Error('Static judge must return exactly the canonical rubric artifact roster.');
  }
  return artifacts;
}

async function assertMaterializedArtifact(path: string, artifact: CodeMemoryLinkVerifiedArtifactV1): Promise<void> {
  const canonical = await realpath(path);
  if (canonical !== path || !(await stat(canonical)).isFile())
    throw new Error('Static judge program is not canonical.');
  if (sha256(await readFile(canonical)) !== artifact.sha256) throw new Error('Static judge program changed.');
  await chmod(canonical, 0o600);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = EffectRecord.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || EffectArray.some(actual, (key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unsupported or missing fields.`);
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function domainDigest(domain: string, value: string): string {
  return sha256(`threadnote-code-memory-link-${domain}-v1\0${value}`);
}
