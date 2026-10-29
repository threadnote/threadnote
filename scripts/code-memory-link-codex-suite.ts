import {Array as EffectArray, Option as EffectOption, Predicate} from 'effect';
/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- This reviewed sealed-suite loader verifies raw filesystem identity before exposing bytes to Effect-free protocol parsers. */
import {createHash} from 'node:crypto';
import {lstat, readFile, realpath, stat} from 'node:fs/promises';
import {isAbsolute, join, posix, resolve, sep} from 'node:path';
import {
  parseCodeMemoryLinkRubricV1,
  parseCodeMemoryLinkContextBriefResponseReceiptV1,
  parseCodeMemoryLinkSealedSuiteV1,
  parseCodeMemoryLinkTaskPacketV1,
  type CodeMemoryLinkArtifactV1,
  type CodeMemoryLinkContextBriefResponseReceiptV1,
  type CodeMemoryLinkRubricV1,
  type CodeMemoryLinkSealedSuiteV1,
  type CodeMemoryLinkTaskPacketV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-protocol';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const CODE_MEMORY_LINK_CODEX_SUITE_LAYOUT_VERSION = 1 as const;
export const CODE_MEMORY_LINK_CODEX_JUDGE_COMMAND_VERSION = 1 as const;

export interface CodeMemoryLinkCodexSuiteLayoutV1 {
  readonly fixtureFiles: readonly {
    readonly artifactId: string;
    readonly destination: string;
    readonly scope: 'repository' | 'threadnote-home';
    readonly source: string;
    readonly taskId: string;
  }[];
  readonly judge: {
    readonly commandArtifactId: string;
    readonly files: readonly {
      readonly artifactId: string;
      readonly destination: string;
      readonly source: string;
    }[];
  };
  readonly layoutArtifactId: string;
  readonly tasks: readonly {
    readonly packetHash: string;
    readonly packetSource: string;
    readonly preflightCodeRefs: readonly string[];
    readonly preflightExpectedCitationDigests: readonly string[];
    readonly preflightExpectedResponses: {
      readonly anchored: CodeMemoryLinkContextBriefResponseReceiptV1;
      readonly noMemory: CodeMemoryLinkContextBriefResponseReceiptV1;
      readonly taskOnly: CodeMemoryLinkContextBriefResponseReceiptV1;
    };
    readonly preflightExpectedSelectedMemories: readonly {
      readonly contentSha256: string;
      readonly memoryIdDigest: string;
    }[];
    readonly project: string;
    readonly rubricHash: string;
    readonly rubricSource: string;
    readonly taskId: string;
    readonly taskKind: 'hidden-constraint' | 'negative-control';
  }[];
  readonly version: typeof CODE_MEMORY_LINK_CODEX_SUITE_LAYOUT_VERSION;
}

export interface CodeMemoryLinkCodexJudgeCommandV1 {
  readonly maxOutputBytes: number;
  readonly programArtifactId: string;
  readonly runner: 'bun';
  readonly timeoutMilliseconds: number;
  readonly version: typeof CODE_MEMORY_LINK_CODEX_JUDGE_COMMAND_VERSION;
}

export interface CodeMemoryLinkVerifiedArtifactV1 {
  readonly artifactId: string;
  readonly bytes: Uint8Array;
  readonly destination: string;
  readonly sha256: string;
}

export interface LoadedCodeMemoryLinkCodexSuiteTaskV1 {
  readonly fixture: {
    readonly repository: readonly CodeMemoryLinkVerifiedArtifactV1[];
    readonly threadnoteHome: readonly CodeMemoryLinkVerifiedArtifactV1[];
  };
  readonly judge: {
    readonly command: CodeMemoryLinkCodexJudgeCommandV1;
    readonly commandArtifact: CodeMemoryLinkVerifiedArtifactV1;
    readonly files: readonly CodeMemoryLinkVerifiedArtifactV1[];
    readonly programArtifact: CodeMemoryLinkVerifiedArtifactV1;
  };
  readonly layout: CodeMemoryLinkCodexSuiteLayoutV1;
  readonly rubric: CodeMemoryLinkRubricV1;
  readonly suite: CodeMemoryLinkSealedSuiteV1;
  readonly taskPacket: CodeMemoryLinkTaskPacketV1;
}

const HASH = /^[0-9a-f]{64}$/u;
const ARTIFACT_ID = /^art_[0-9a-f]{16,64}$/u;
const TASK_ID = /^tsk_[0-9a-f]{16,64}$/u;
const MAXIMUM_SEALED_FILE_BYTES = 4 * 1_024 * 1_024;
const FORBIDDEN_PUBLIC_NAMES = new Set([
  '.codex',
  '.claude',
  '.cursor',
  '.git',
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  'hooks.json',
]);

/** Resolve and fully verify every private suite byte before the agent process is launched. */
export async function loadCodeMemoryLinkCodexSuiteTask(input: {
  readonly expectedLayoutArtifactId: string;
  readonly expectedSuiteHash: string;
  readonly root: string;
  readonly taskId: string;
}): Promise<LoadedCodeMemoryLinkCodexSuiteTaskV1> {
  const root = await canonicalDirectory(input.root, 'sealed suite root');
  const suiteBytes = await verifiedLooseFile(root, 'suite.json', 'sealed suite');
  const suite = parseCodeMemoryLinkSealedSuiteV1(parseJson(suiteBytes, 'sealed suite'));
  if (suite.suiteHash !== matching(input.expectedSuiteHash, HASH, 'expected suite hash')) {
    throw new Error('The sealed suite hash differs from the preregistered manifest binding.');
  }
  const expectedLayoutArtifactId = matching(input.expectedLayoutArtifactId, ARTIFACT_ID, 'expected layout artifact id');
  const layoutDescriptor = artifactById(suite.judge.artifacts, expectedLayoutArtifactId, 'suite layout');
  const layoutBytes = await verifiedArtifactFile(root, 'adapter.json', layoutDescriptor, 'suite layout');
  const layout = parseCodeMemoryLinkCodexSuiteLayoutV1(parseJson(layoutBytes, 'suite layout'));
  if (layout.layoutArtifactId !== expectedLayoutArtifactId) {
    throw new Error('The suite layout does not identify its reviewed content-addressed artifact.');
  }
  const mappedLayout = EffectOption.getOrUndefined(
    EffectArray.findFirst(layout.judge.files, file => file.artifactId === expectedLayoutArtifactId),
  );
  if (!mappedLayout || mappedLayout.source !== 'adapter.json') {
    throw new Error('The reviewed layout artifact must map the fixed adapter.json source.');
  }

  assertTaskRoster(layout, suite);
  assertArtifactCoverage(
    EffectArray.map(layout.fixtureFiles, file => file.artifactId),
    suite.fixture.artifacts,
    'fixture',
  );
  assertArtifactCoverage(
    EffectArray.map(layout.judge.files, file => file.artifactId),
    suite.judge.artifacts,
    'judge',
  );
  const allSources = [
    ...EffectArray.map(layout.fixtureFiles, file => file.source),
    ...EffectArray.map(layout.judge.files, file => file.source),
    ...EffectArray.flatMap(layout.tasks, task => [task.packetSource, task.rubricSource]),
  ];
  unique(allSources, 'suite source paths');

  const fixtureFiles = await Promise.all(
    EffectArray.map(layout.fixtureFiles, async file => {
      const descriptor = artifactById(suite.fixture.artifacts, file.artifactId, 'fixture');
      return {
        artifactId: file.artifactId,
        bytes: await verifiedArtifactFile(root, file.source, descriptor, 'fixture artifact'),
        destination: file.destination,
        sha256: descriptor.sha256,
      } satisfies CodeMemoryLinkVerifiedArtifactV1;
    }),
  );
  const judgeFiles = await Promise.all(
    EffectArray.map(layout.judge.files, async file => {
      const descriptor = artifactById(suite.judge.artifacts, file.artifactId, 'judge');
      return {
        artifactId: file.artifactId,
        bytes: await verifiedArtifactFile(root, file.source, descriptor, 'judge artifact'),
        destination: file.destination,
        sha256: descriptor.sha256,
      } satisfies CodeMemoryLinkVerifiedArtifactV1;
    }),
  );

  const parsedTasks = await Promise.all(
    EffectArray.map(layout.tasks, async mappedTask => {
      const [packetBytes, rubricBytes] = await Promise.all([
        verifiedLooseFile(root, mappedTask.packetSource, 'task packet'),
        verifiedLooseFile(root, mappedTask.rubricSource, 'task rubric'),
      ]);
      const taskPacket = parseCodeMemoryLinkTaskPacketV1(parseJson(packetBytes, 'task packet'));
      const rubric = parseCodeMemoryLinkRubricV1(parseJson(rubricBytes, 'task rubric'));
      if (
        taskPacket.taskId !== mappedTask.taskId ||
        rubric.taskId !== mappedTask.taskId ||
        taskPacket.taskKind !== mappedTask.taskKind ||
        rubric.taskKind !== mappedTask.taskKind ||
        taskPacket.packetHash !== mappedTask.packetHash ||
        rubric.rubricHash !== mappedTask.rubricHash ||
        taskPacket.fixtureHash !== suite.fixture.fixtureHash ||
        rubric.fixtureHash !== suite.fixture.fixtureHash
      ) {
        throw new Error(`Task ${mappedTask.taskId} is not bound to its exact packet, rubric, kind, and fixture.`);
      }
      if (
        EffectArray.some(
          rubric.goldCitationDigests,
          digest => !mappedTask.preflightExpectedCitationDigests.includes(digest),
        )
      ) {
        throw new Error(`Task ${mappedTask.taskId} preflight does not cover every sealed gold citation digest.`);
      }
      return {rubric, taskPacket};
    }),
  );
  const requestedTaskId = matching(input.taskId, TASK_ID, 'requested task id');
  const selectedIndex = EffectOption.getOrElse(
    EffectArray.findFirstIndex(layout.tasks, task => task.taskId === requestedTaskId),
    () => -1,
  );
  if (selectedIndex < 0) throw new Error('The requested task is outside the sealed suite roster.');
  const selected = parsedTasks[selectedIndex];
  const commandArtifact = artifactByLoadedId(judgeFiles, layout.judge.commandArtifactId, 'judge command');
  const command = parseCodeMemoryLinkCodexJudgeCommandV1(parseJson(commandArtifact.bytes, 'judge command'));
  const programArtifact = artifactByLoadedId(judgeFiles, command.programArtifactId, 'judge program');
  if (
    programArtifact.artifactId === commandArtifact.artifactId ||
    programArtifact.artifactId === layout.layoutArtifactId
  ) {
    throw new Error('The static judge program must be a distinct reviewed artifact.');
  }
  const selectedFixtureFiles = EffectArray.filter(
    fixtureFiles,
    (_, index) => layout.fixtureFiles[index].taskId === requestedTaskId,
  );
  const selectedRepositoryFiles = EffectArray.filter(
    selectedFixtureFiles,
    file =>
      EffectOption.getOrUndefined(
        EffectArray.findFirst(layout.fixtureFiles, mapped => mapped.artifactId === file.artifactId),
      )!.scope === 'repository',
  );
  if (selectedRepositoryFiles.length === 0)
    throw new Error('Every sealed task requires a non-empty public repository.');
  return {
    fixture: {
      repository: selectedRepositoryFiles,
      threadnoteHome: EffectArray.filter(
        selectedFixtureFiles,
        file =>
          EffectOption.getOrUndefined(
            EffectArray.findFirst(layout.fixtureFiles, mapped => mapped.artifactId === file.artifactId),
          )!.scope === 'threadnote-home',
      ),
    },
    judge: {command, commandArtifact, files: judgeFiles, programArtifact},
    layout,
    rubric: selected.rubric,
    suite,
    taskPacket: selected.taskPacket,
  };
}

export function parseCodeMemoryLinkCodexSuiteLayoutV1(value: unknown): CodeMemoryLinkCodexSuiteLayoutV1 {
  const layout = object(value, 'suite layout');
  exactKeys(layout, ['fixtureFiles', 'judge', 'layoutArtifactId', 'tasks', 'version'], 'suite layout');
  if (layout.version !== CODE_MEMORY_LINK_CODEX_SUITE_LAYOUT_VERSION) invalid('suite layout version must be 1');
  if (!EffectArray.isArray(layout.fixtureFiles) || !EffectArray.isArray(layout.tasks)) {
    invalid('suite layout fixtureFiles and tasks must be arrays');
  }
  const fixtureFiles = EffectArray.map(layout.fixtureFiles, (entry, index) => {
    const file = object(entry, `fixture file ${index + 1}`);
    exactKeys(file, ['artifactId', 'destination', 'scope', 'source', 'taskId'], `fixture file ${index + 1}`);
    const scope = oneOf(file.scope, ['repository', 'threadnote-home'] as const, 'fixture scope');
    return {
      artifactId: matching(file.artifactId, ARTIFACT_ID, 'fixture artifact id'),
      destination: relativeFile(file.destination, 'fixture destination', scope === 'repository'),
      scope,
      source: relativeFile(file.source, 'fixture source'),
      taskId: matching(file.taskId, TASK_ID, 'fixture task id'),
    };
  });
  const judgeInput = object(layout.judge, 'suite layout judge');
  exactKeys(judgeInput, ['commandArtifactId', 'files'], 'suite layout judge');
  if (!EffectArray.isArray(judgeInput.files)) invalid('suite layout judge files must be an array');
  const judgeFiles = EffectArray.map(judgeInput.files, (entry, index) => {
    const file = object(entry, `judge file ${index + 1}`);
    exactKeys(file, ['artifactId', 'destination', 'source'], `judge file ${index + 1}`);
    const destination = relativeFile(file.destination, 'judge destination');
    if (
      destination === '.runner-home' ||
      Effect.pipe(destination, EffectString.startsWith('.runner-home/')) ||
      destination === '.runner-tmp' ||
      Effect.pipe(destination, EffectString.startsWith('.runner-tmp/'))
    ) {
      invalid('judge destination uses an outer-runner reserved path');
    }
    return {
      artifactId: matching(file.artifactId, ARTIFACT_ID, 'judge artifact id'),
      destination,
      source: relativeFile(file.source, 'judge source'),
    };
  });
  const tasks = EffectArray.map(layout.tasks, (entry, index) => {
    const task = object(entry, `suite layout task ${index + 1}`);
    exactKeys(
      task,
      [
        'packetHash',
        'packetSource',
        'preflightCodeRefs',
        'preflightExpectedCitationDigests',
        'preflightExpectedResponses',
        'preflightExpectedSelectedMemories',
        'project',
        'rubricHash',
        'rubricSource',
        'taskId',
        'taskKind',
      ],
      `suite layout task ${index + 1}`,
    );
    return {
      packetHash: matching(task.packetHash, HASH, 'task packet hash'),
      packetSource: relativeFile(task.packetSource, 'task packet source'),
      preflightCodeRefs: codeRefs(task.preflightCodeRefs),
      preflightExpectedCitationDigests: sortedHashes(
        task.preflightExpectedCitationDigests,
        'task preflight expected citation digests',
        64,
      ),
      preflightExpectedResponses: expectedResponses(task.preflightExpectedResponses),
      preflightExpectedSelectedMemories: selectedMemories(
        task.preflightExpectedSelectedMemories,
        'task preflight expected selected memories',
      ),
      project: matching(task.project, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u, 'task project'),
      rubricHash: matching(task.rubricHash, HASH, 'task rubric hash'),
      rubricSource: relativeFile(task.rubricSource, 'task rubric source'),
      taskId: matching(task.taskId, TASK_ID, 'task id'),
      taskKind: oneOf(task.taskKind, ['hidden-constraint', 'negative-control'] as const, 'task kind'),
    };
  });
  unique(
    EffectArray.map(fixtureFiles, file => file.artifactId),
    'fixture artifact ids',
  );
  unique(
    EffectArray.map(fixtureFiles, file => `${file.taskId}:${file.scope}:${file.destination}`),
    'fixture destinations',
  );
  unique(
    EffectArray.map(judgeFiles, file => file.artifactId),
    'judge artifact ids',
  );
  unique(
    EffectArray.map(judgeFiles, file => file.destination),
    'judge destinations',
  );
  unique(
    EffectArray.map(tasks, task => task.taskId),
    'suite layout task ids',
  );
  const taskIds = new Set(EffectArray.map(tasks, task => task.taskId));
  if (EffectArray.some(fixtureFiles, file => !taskIds.has(file.taskId)))
    invalid('fixture file references an unknown task id');
  return {
    fixtureFiles,
    judge: {
      commandArtifactId: matching(judgeInput.commandArtifactId, ARTIFACT_ID, 'judge command artifact id'),
      files: judgeFiles,
    },
    layoutArtifactId: matching(layout.layoutArtifactId, ARTIFACT_ID, 'layout artifact id'),
    tasks,
    version: CODE_MEMORY_LINK_CODEX_SUITE_LAYOUT_VERSION,
  };
}

export function parseCodeMemoryLinkCodexJudgeCommandV1(value: unknown): CodeMemoryLinkCodexJudgeCommandV1 {
  const command = object(value, 'judge command');
  exactKeys(
    command,
    ['maxOutputBytes', 'programArtifactId', 'runner', 'timeoutMilliseconds', 'version'],
    'judge command',
  );
  if (command.version !== CODE_MEMORY_LINK_CODEX_JUDGE_COMMAND_VERSION) invalid('judge command version must be 1');
  if (command.runner !== 'bun') invalid('judge command runner must be bun');
  return {
    maxOutputBytes: integer(command.maxOutputBytes, 'judge maximum output bytes', 1, 1 * 1_024 * 1_024),
    programArtifactId: matching(command.programArtifactId, ARTIFACT_ID, 'judge program artifact id'),
    runner: 'bun',
    timeoutMilliseconds: integer(command.timeoutMilliseconds, 'judge timeout', 1, 120_000),
    version: CODE_MEMORY_LINK_CODEX_JUDGE_COMMAND_VERSION,
  };
}

function assertTaskRoster(layout: CodeMemoryLinkCodexSuiteLayoutV1, suite: CodeMemoryLinkSealedSuiteV1): void {
  if (layout.tasks.length !== suite.tasks.length)
    throw new Error('Suite layout must map every sealed task exactly once.');
  for (let index = 0; index < suite.tasks.length; index += 1) {
    const expected = suite.tasks[index];
    const actual = layout.tasks[index];
    if (
      !actual ||
      actual.taskId !== expected.taskId ||
      actual.taskKind !== expected.taskKind ||
      actual.packetHash !== expected.packetHash ||
      actual.rubricHash !== expected.rubricHash
    ) {
      throw new Error('Suite layout task roster differs from the canonical sealed-suite roster.');
    }
  }
}

function assertArtifactCoverage(
  ids: readonly string[],
  descriptors: readonly CodeMemoryLinkArtifactV1[],
  label: string,
) {
  if (ids.length !== descriptors.length || EffectArray.some(ids, (id, index) => id !== descriptors[index].artifactId)) {
    throw new Error(`Suite layout must map the canonical ${label} artifact roster exactly once and in order.`);
  }
}

async function canonicalDirectory(pathInput: string, label: string): Promise<string> {
  if (!isAbsolute(pathInput) || resolve(pathInput) !== pathInput)
    throw new Error(`${label} must be normalized and absolute.`);
  const metadata = await lstat(pathInput);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error(`${label} must be a non-symlink directory.`);
  const canonical = await realpath(pathInput);
  if (canonical !== pathInput) throw new Error(`${label} must be canonical.`);
  return canonical;
}

async function verifiedArtifactFile(
  root: string,
  relativePath: string,
  descriptor: CodeMemoryLinkArtifactV1,
  label: string,
): Promise<Uint8Array> {
  const bytes = await verifiedLooseFile(root, relativePath, label);
  if (sha256(bytes) !== descriptor.sha256)
    throw new Error(`${label} hash differs from its sealed artifact descriptor.`);
  return bytes;
}

async function verifiedLooseFile(root: string, relativePath: string, label: string): Promise<Uint8Array> {
  const normalized = relativeFile(relativePath, `${label} path`);
  const path = join(root, ...Effect.pipe(normalized, EffectString.split('/')));
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`${label} must be a non-symlink, non-hardlinked regular file.`);
  }
  if (metadata.size > MAXIMUM_SEALED_FILE_BYTES) throw new Error(`${label} exceeds the sealed-file byte limit.`);
  const canonical = await realpath(path);
  if (canonical !== path || (canonical !== root && !Effect.pipe(canonical, EffectString.startsWith(`${root}${sep}`)))) {
    throw new Error(`${label} escaped the canonical sealed suite root.`);
  }
  if (!(await stat(canonical)).isFile()) throw new Error(`${label} must remain a regular file.`);
  const bytes = await readFile(canonical);
  const after = await lstat(path);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.nlink !== 1 ||
    after.dev !== metadata.dev ||
    after.ino !== metadata.ino ||
    after.size !== metadata.size ||
    after.mtimeMs !== metadata.mtimeMs ||
    (await realpath(path)) !== canonical
  ) {
    throw new Error(`${label} changed while its sealed bytes were read.`);
  }
  return bytes;
}

function artifactById(
  artifacts: readonly CodeMemoryLinkArtifactV1[],
  artifactId: string,
  label: string,
): CodeMemoryLinkArtifactV1 {
  const artifact = EffectOption.getOrUndefined(
    EffectArray.findFirst(artifacts, entry => entry.artifactId === artifactId),
  );
  if (!artifact) throw new Error(`The ${label} artifact id is absent from the sealed manifest.`);
  return artifact;
}

function artifactByLoadedId(
  artifacts: readonly CodeMemoryLinkVerifiedArtifactV1[],
  artifactId: string,
  label: string,
): CodeMemoryLinkVerifiedArtifactV1 {
  const artifact = EffectOption.getOrUndefined(
    EffectArray.findFirst(artifacts, entry => entry.artifactId === artifactId),
  );
  if (!artifact) throw new Error(`The ${label} artifact id is absent from the loaded sealed artifacts.`);
  return artifact;
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)) as unknown;
  } catch (cause) {
    throw new Error(`${label} is not canonical UTF-8 JSON.`, {cause});
  }
}

function relativeFile(value: unknown, label: string, forbidControlFiles = false): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4_096 ||
    Effect.pipe(value, EffectString.includes('\\')) ||
    Effect.pipe(value, EffectString.includes('\0')) ||
    isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value === '.' ||
    Effect.pipe(value, EffectString.endsWith('/'))
  ) {
    invalid(`${label} must be one normalized relative file path`);
  }
  const segments = Effect.pipe(value, EffectString.split('/'));
  if (EffectArray.some(segments, (segment: string) => segment === '' || segment === '.' || segment === '..')) {
    invalid(`${label} contains a forbidden path segment`);
  }
  if (forbidControlFiles && EffectArray.some(segments, (segment: string) => FORBIDDEN_PUBLIC_NAMES.has(segment))) {
    invalid(`${label} contains an agent-control filename`);
  }
  return value;
}

function codeRefs(value: unknown): readonly string[] {
  if (!EffectArray.isArray(value) || value.length === 0 || value.length > 8) {
    invalid('task preflightCodeRefs must contain 1-8 values');
  }
  const parsed = EffectArray.map(value, (entry, index) => {
    if (typeof entry !== 'string' || /^cgs_/u.test(entry)) {
      invalid(`task preflightCodeRefs[${index}] must be a sealed repo-relative file path`);
    }
    return relativeFile(entry, `task preflightCodeRefs[${index}]`, true);
  });
  unique(parsed, 'task preflight code refs');
  return parsed;
}

function sortedHashes(value: unknown, label: string, maximum: number): readonly string[] {
  if (!EffectArray.isArray(value) || value.length > maximum) invalid(`${label} is invalid`);
  const parsed = EffectArray.map(value, (entry, index) => matching(entry, HASH, `${label}[${index}]`));
  if (EffectArray.some(parsed, (entry, index) => index > 0 && parsed[index - 1] >= entry)) {
    invalid(`${label} must be unique and sorted`);
  }
  return parsed;
}

function expectedResponses(
  value: unknown,
): CodeMemoryLinkCodexSuiteLayoutV1['tasks'][number]['preflightExpectedResponses'] {
  const responses = object(value, 'task preflight expected responses');
  exactKeys(responses, ['anchored', 'noMemory', 'taskOnly'], 'task preflight expected responses');
  const anchored = parseCodeMemoryLinkContextBriefResponseReceiptV1(responses.anchored);
  const noMemory = parseCodeMemoryLinkContextBriefResponseReceiptV1(responses.noMemory);
  const taskOnly = parseCodeMemoryLinkContextBriefResponseReceiptV1(responses.taskOnly);
  if (
    anchored.responseClass !== 'anchored-v3' ||
    noMemory.responseClass !== 'empty-v1' ||
    taskOnly.responseClass !== 'task-v2'
  ) {
    invalid('task preflight expected responses do not preserve anchored/task-only/no-memory classes');
  }
  return {anchored, noMemory, taskOnly};
}

function selectedMemories(
  value: unknown,
  label: string,
): readonly {readonly contentSha256: string; readonly memoryIdDigest: string}[] {
  if (!EffectArray.isArray(value) || value.length > 24) invalid(`${label} is invalid`);
  const parsed = EffectArray.map(value, (entry, index) => {
    const memory = object(entry, `${label}[${index}]`);
    exactKeys(memory, ['contentSha256', 'memoryIdDigest'], `${label}[${index}]`);
    return {
      contentSha256: matching(memory.contentSha256, HASH, `${label}[${index}].contentSha256`),
      memoryIdDigest: matching(memory.memoryIdDigest, HASH, `${label}[${index}].memoryIdDigest`),
    };
  });
  if (
    EffectArray.some(
      parsed,
      (entry, index) =>
        index > 0 &&
        (parsed[index - 1].memoryIdDigest > entry.memoryIdDigest ||
          (parsed[index - 1].memoryIdDigest === entry.memoryIdDigest &&
            parsed[index - 1].contentSha256 >= entry.contentSha256)),
    )
  ) {
    invalid(`${label} must be unique and sorted`);
  }
  if (new Set(EffectArray.map(parsed, memory => memory.memoryIdDigest)).size !== parsed.length) {
    invalid(`${label} memory identity digests must be unique`);
  }
  return parsed;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) invalid(`${label} must be an object`);
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = EffectRecord.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || EffectArray.some(actual, (key, index) => key !== wanted[index])) {
    invalid(`${label} has unsupported or missing fields`);
  }
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`${label} is out of range`);
  }
  return value;
}

function matching(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(`${label} is invalid`);
  return value;
}

function isOneOf<T extends string>(value: string, allowed: readonly T[]): value is T {
  return EffectArray.some(allowed, candidate => candidate === value);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !isOneOf(value, allowed)) invalid(`${label} is invalid`);
  return value;
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label} must be unique`);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function invalid(message: string): never {
  throw new Error(`Invalid Code Memory Link sealed-suite adapter: ${message}.`);
}
