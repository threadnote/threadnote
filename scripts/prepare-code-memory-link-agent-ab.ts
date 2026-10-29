#!/usr/bin/env bun
import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray, Option as EffectOption, Predicate} from 'effect';

/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- This reviewed preparer owns disposable OS filesystem and exact child-process boundaries. */

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {createHash} from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {delimiter, dirname, extname, isAbsolute, join, posix, relative, resolve, sep} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Effect} from 'effect';
import {codeGraphCommittedFileContentHash} from '@threadnote/graph/content_identity';
import {
  CODE_MEMORY_LINK_AGENT_AB_SCHEDULE_ALGORITHM_VERSION,
  codeMemoryLinkAgentAbAssignmentHash,
  codeMemoryLinkAgentAbManifestHash,
  deriveCodeMemoryLinkAgentAbScheduleV1,
  parseCodeMemoryLinkAgentAbAssignmentV1,
  parseCodeMemoryLinkAgentAbManifestV1,
  type CodeMemoryLinkAgentAbArm,
  type CodeMemoryLinkAgentAbAssignmentV1,
  type CodeMemoryLinkAgentAbManifestClientV1,
  type CodeMemoryLinkAgentAbManifestTaskV1,
  type CodeMemoryLinkAgentAbManifestV1,
  type CodeMemoryLinkAgentAbScenarioFamily,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-ab';
import {
  CODE_MEMORY_LINK_CANONICAL_EMPTY_CONTEXT_BRIEF_V1,
  CODE_MEMORY_LINK_AGENT_PROTOCOL_VERSION,
  assertCodeMemoryLinkSealedSuiteBindingsV1,
  canonicalizeCodeMemoryLinkContextBriefResultV1,
  codeMemoryLinkContextBriefResponseReceiptHashV1,
  codeMemoryLinkFixtureHashV1,
  codeMemoryLinkGoldCitationDigest,
  codeMemoryLinkJudgeHashV1,
  codeMemoryLinkRubricHashV1,
  codeMemoryLinkSealedSuiteHashV1,
  codeMemoryLinkTaskPacketHashV1,
  parseCodeMemoryLinkFixtureV1,
  parseCodeMemoryLinkJudgeV1,
  parseCodeMemoryLinkRubricV1,
  parseCodeMemoryLinkSealedSuiteV1,
  parseCodeMemoryLinkTaskPacketV1,
  type CodeMemoryLinkArtifactV1,
  type CodeMemoryLinkContextBriefResponseReceiptV1,
  type CodeMemoryLinkFixtureV1,
  type CodeMemoryLinkRubricV1,
  type CodeMemoryLinkSealedSuiteV1,
  type CodeMemoryLinkTaskPacketV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-protocol';
import {
  CODE_MEMORY_LINK_AGENT_SUITE_ACCOUNT,
  CODE_MEMORY_LINK_AGENT_SUITE_AGENT_ID,
  CODE_MEMORY_LINK_AGENT_SUITE_DEFINITION_VERSION,
  CODE_MEMORY_LINK_AGENT_SUITE_PROJECT,
  CODE_MEMORY_LINK_AGENT_SUITE_USER,
  codeMemoryLinkAgentSuiteArtifactId,
  codeMemoryLinkAgentSuiteCalibrationCorpusHashV1,
  codeMemoryLinkAgentSuiteCorpusHashV1,
  codeMemoryLinkAgentSuiteGuardArtifactId,
  codeMemoryLinkAgentSuiteGuardValueV1,
  codeMemoryLinkAgentSuiteOutputArtifactId,
  codeMemoryLinkAgentSuitePredicateId,
  codeMemoryLinkAgentSuiteRemoteUrl,
  createCodeMemoryLinkAgentSuiteCorpusV1,
  type CodeMemoryLinkAgentSuiteMemorySeedV1,
  type CodeMemoryLinkAgentSuiteTaskDefinitionV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-suite';
import {
  codeMemoryLinkClientArgumentVectorHash,
  codeMemoryLinkClientImplementationDescriptorHash,
  codeMemoryLinkClientPathDigest,
  codeMemoryLinkClientProjectionHash,
  parseCodeMemoryLinkClientImplementationDescriptorV1,
  type CodeMemoryLinkClientArtifactBindingV2,
  type CodeMemoryLinkClientImplementationDescriptorV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-client-descriptor';
import {parseMemoryDocument, type MemoryRecord} from '@threadnote/memory/document';
import {MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import {parseContextBriefV1} from '@threadnote/context/projector';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {verifyCodeMemoryLinkEvaluatedSubject} from './code-memory-link-evaluated-subject.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {scriptArguments} from './effect/script.js';
import {loadCodeMemoryLinkCodexSuiteTask} from './code-memory-link-codex-suite.js';
import {
  CODE_MEMORY_LINK_CODEX_APP_SERVER_VERSION,
  CODE_MEMORY_LINK_CODEX_ENVIRONMENT_POLICY_V1,
  CODE_MEMORY_LINK_PROXY_SERVER_NAME,
  CODE_MEMORY_LINK_SAFE_EXECUTABLE_NAMES,
  parseCodeMemoryLinkCodexClientConfigV1,
  projectCodeMemoryLinkCodexClientConfigV1,
  type CodeMemoryLinkCodexClientConfigV1,
} from './code-memory-link-codex-isolation.js';
import {
  assertCodeMemoryLinkGraphStatusPreflight,
  codeMemoryLinkContextBriefSelectedMemoriesV1,
  type CodeMemoryLinkExpectedSelectedMemoryV1,
} from './code-memory-link-codex-preflight.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const CODE_MEMORY_LINK_PREPARATION_VERSION = 1 as const;
export const CODE_MEMORY_LINK_CALIBRATION_PLAN_VERSION = 1 as const;
export const CODE_MEMORY_LINK_CALIBRATION_KIND = 'non-evidence-calibration' as const;

const HASH = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const CLIENT_ID = /^cli_[0-9a-f]{16,64}$/u;
const MEMORY_CITATION_ID = /^tncc_[0-9a-f]{16,128}$/u;
const MAXIMUM_TEXT_ARTIFACT_BYTES = 4 * 1_024 * 1_024;
const MODEL_IDS = ['gpt-5.6-luna', 'gpt-5.6-terra'] as const;
const ARM_LABEL_PERMUTATIONS = [
  ['anchored', 'task-only', 'no-memory'],
  ['anchored', 'no-memory', 'task-only'],
  ['task-only', 'anchored', 'no-memory'],
  ['task-only', 'no-memory', 'anchored'],
  ['no-memory', 'anchored', 'task-only'],
  ['no-memory', 'task-only', 'anchored'],
] as const satisfies readonly (readonly CodeMemoryLinkAgentAbArm[])[];

export interface CodeMemoryLinkPreparedTaskV1 {
  readonly citationDigests: readonly string[];
  readonly definition: CodeMemoryLinkAgentSuiteTaskDefinitionV1;
  readonly homeFiles: readonly {readonly content: string; readonly destination: string}[];
  readonly preflightExpectedCitationDigests: readonly string[];
  readonly preflightExpectedSelectedMemories: readonly CodeMemoryLinkExpectedSelectedMemoryV1[];
  readonly preflightExpectedResponses: {
    readonly anchored: CodeMemoryLinkContextBriefResponseReceiptV1;
    readonly noMemory: CodeMemoryLinkContextBriefResponseReceiptV1;
    readonly taskOnly: CodeMemoryLinkContextBriefResponseReceiptV1;
  };
}

export interface CodeMemoryLinkSealedAssemblyV1 {
  readonly adapter: Record<string, unknown>;
  readonly files: ReadonlyMap<string, string>;
  readonly fixture: CodeMemoryLinkFixtureV1;
  readonly manifestTasks: readonly CodeMemoryLinkAgentAbManifestTaskV1[];
  readonly rubrics: readonly CodeMemoryLinkRubricV1[];
  readonly suite: CodeMemoryLinkSealedSuiteV1;
  readonly taskPackets: readonly CodeMemoryLinkTaskPacketV1[];
}

export interface CodeMemoryLinkPreparedClientV1 {
  readonly clientArguments: readonly string[];
  readonly clientArtifactBindings: readonly {readonly path: string; readonly role: string}[];
  readonly clientBinaryBindings: readonly {readonly path: string; readonly role: string}[];
  readonly clientCommand: string;
  readonly clientConfigurationProjectionPath: string;
  readonly clientConfigurationPath: string;
  readonly clientDependenciesLockPath: string;
  readonly clientDescriptorPath: string;
  readonly clientId: string;
  readonly descriptor: CodeMemoryLinkClientImplementationDescriptorV1;
  readonly implementationDescriptorHash: string;
  readonly model: (typeof MODEL_IDS)[number];
}

export interface CodeMemoryLinkCalibrationPlanV1 {
  readonly calibrationCorpusHash: string;
  readonly clients: readonly string[];
  readonly fixture: CodeMemoryLinkFixtureV1;
  readonly fixtureFiles: readonly {
    readonly artifactId: string;
    readonly destination: string;
    readonly scope: 'repository' | 'threadnote-home';
    readonly source: string;
    readonly taskId: string;
  }[];
  readonly kind: typeof CODE_MEMORY_LINK_CALIBRATION_KIND;
  readonly planHash: string;
  readonly releaseLedgerCompatible: false;
  readonly runs: readonly {
    readonly arm: CodeMemoryLinkAgentAbArm;
    readonly clientId: string;
    readonly runOrder: number;
    readonly taskId: string;
  }[];
  readonly tasks: readonly {
    readonly packet: CodeMemoryLinkTaskPacketV1;
    readonly preflightExpectedCitationDigests: readonly string[];
    readonly preflightExpectedResponses: CodeMemoryLinkPreparedTaskV1['preflightExpectedResponses'];
    readonly preflightExpectedSelectedMemories: readonly CodeMemoryLinkExpectedSelectedMemoryV1[];
    readonly rubric: CodeMemoryLinkRubricV1;
  }[];
  readonly version: typeof CODE_MEMORY_LINK_CALIBRATION_PLAN_VERSION;
}

interface Options {
  readonly assignmentSeed: string;
  readonly authSource: string;
  readonly bunExecutable: string;
  readonly candidateCommit: string;
  readonly candidateExecutable: string;
  readonly candidateExecutableSha256: string;
  readonly codexExecutable: string;
  readonly gitExecutable: string;
  readonly harnessGovernanceCommit: string;
  readonly modelProvider: string;
  readonly outputRoot: string;
  readonly reasoningEffort: string;
  readonly safeExecutablePath: string;
  readonly scheduleSeed: string;
  readonly temporaryRoot: string;
  readonly turnTimeoutMilliseconds: number;
}

interface CandidateRuntime {
  readonly executable: string;
  readonly executableSha256: string;
  readonly sourceCommit: string;
}

interface PreparedBinaryFile {
  readonly bytes: Uint8Array;
  readonly mode: number;
}

export interface PreparedGraphIdentity {
  readonly commit: string;
  readonly extractorSet: string;
  readonly graphContentId: string;
  readonly objectFormat: 'sha1';
  readonly origin: string;
  readonly repositoryId: string;
  readonly snapshotId: string;
}

type GitObjectFormat = 'sha1' | 'sha256';

interface FixtureMapping {
  readonly artifactId: string;
  readonly content: string;
  readonly destination: string;
  readonly scope: 'repository' | 'threadnote-home';
  readonly source: string;
  readonly taskId: string;
}

interface ProtocolTaskAssembly {
  readonly fixtureFiles: readonly FixtureMapping[];
  readonly fixture: CodeMemoryLinkFixtureV1;
  readonly packets: readonly CodeMemoryLinkTaskPacketV1[];
  readonly rubrics: readonly CodeMemoryLinkRubricV1[];
}

const program = Effect.gen(function* () {
  const options = parseArguments(yield* scriptArguments());
  yield* Effect.tryPromise({
    try: async () => {
      const subject = await verifyCodeMemoryLinkEvaluatedSubject({
        executable: options.candidateExecutable,
        executableSha256: options.candidateExecutableSha256,
        sourceCommit: options.candidateCommit,
      });
      await prepareCodeMemoryLinkAgentAb(options, {
        executable: subject.executable,
        executableSha256: subject.identity.executableSha256,
        sourceCommit: subject.identity.sourceCommit,
      });
    },
    catch: cause =>
      ScriptError.make({message: 'Could not prepare the Code Memory Link sealed agent experiment.', cause}),
  });
});

export async function prepareCodeMemoryLinkAgentAb(options: Options, candidate: CandidateRuntime): Promise<void> {
  assertCandidate(options, candidate);
  validateSafeExecutablePath(options.safeExecutablePath);
  const sourceRoot = await canonicalDirectory(codeMemoryLinkAgentPreparationSourceRoot(), 'source root');
  await assertCleanSourceCheckout(
    sourceRoot,
    options.harnessGovernanceCommit,
    options.gitExecutable,
    options.safeExecutablePath,
  );
  const outputRoot = normalizedAbsolute(options.outputRoot, 'output root');
  const outputParent = await canonicalDirectory(dirname(outputRoot), 'output parent');
  if (dirname(outputRoot) !== outputParent) throw new Error('Output root parent must be canonical.');
  await assertAbsent(outputRoot, 'output root');
  const temporaryRoot = await canonicalDirectory(options.temporaryRoot, 'temporary root');
  await Promise.all([
    reviewedRegularFile(options.authSource, 'Codex auth source', false),
    reviewedRegularFile(options.bunExecutable, 'Bun executable', false),
    reviewedRegularFile(options.codexExecutable, 'Codex executable', false),
    reviewedRegularFile(options.gitExecutable, 'Git executable', false),
  ]);
  const reviewedHashes = await reviewedRuntimeHashes(options);
  if ((await sha256File(candidate.executable)) !== candidate.executableSha256) {
    throw new Error('Managed candidate executable bytes differ from its attested hash.');
  }
  await assertCodexVersion(options);
  const workRoot = await mkdtemp(join(temporaryRoot, 'threadnote-code-memory-link-prepare-'));
  await chmod(workRoot, 0o700);
  const stagingRoot = await mkdtemp(join(outputParent, `.${posix.basename(outputRoot)}.staging-`));
  await chmod(stagingRoot, 0o700);
  let promoted = false;
  try {
    const corpus = createCodeMemoryLinkAgentSuiteCorpusV1();
    const releasePrepared: CodeMemoryLinkPreparedTaskV1[] = [];
    const calibrationPrepared: CodeMemoryLinkPreparedTaskV1[] = [];
    for (const task of corpus.releaseTasks) {
      releasePrepared.push(await prepareTask(task, candidate, options, join(workRoot, task.taskId)));
    }
    for (const task of corpus.calibrationTasks) {
      calibrationPrepared.push(await prepareTask(task, candidate, options, join(workRoot, task.taskId)));
    }
    const judgeProgramPath = join(
      sourceRoot,
      'apps/threadnote/test/evaluation/fixtures/code-memory-link-agent-suite-v1/judge.ts',
    );
    const judgeProgram = await readReviewedTextFile(judgeProgramPath, 'sealed static judge');
    const sealed = assembleCodeMemoryLinkSealedSuiteV1({
      corpusHash: corpus.corpusHash,
      judgeProgram,
      tasks: releasePrepared,
    });
    const outputFiles = new Map(sealed.files);
    const binaryFiles = new Map<string, PreparedBinaryFile>();
    const clients = await prepareClients({
      binaryFiles,
      options,
      outputFiles,
      outputRoot,
      sealed,
      sourceRoot,
    });
    const assignment = createAssignment(sealed.fixture.fixtureHash, options.assignmentSeed);
    const manifest = await createManifest({
      assignment,
      candidate,
      clients,
      options,
      sealed,
      sourceRoot,
    });
    const calibration = assembleCalibrationPlanV1({
      clients: EffectArray.map(clients, client => client.clientId),
      tasks: calibrationPrepared,
    });
    addFile(outputFiles, 'assignment.json', jsonFile(assignment));
    addFile(outputFiles, 'manifest.json', jsonFile(manifest));
    addFile(
      outputFiles,
      'manifest-inputs.json',
      jsonFile({
        assignmentHash: assignment.assignmentHash,
        calibrationCorpusHash: corpus.calibrationCorpusHash,
        calibrationPlanHash: calibration.plan.planHash,
        candidate: manifest.candidate,
        corpusHash: corpus.corpusHash,
        fixtureHash: sealed.fixture.fixtureHash,
        harnessGovernanceCommit: manifest.harnessGovernanceCommit,
        manifestHash: manifest.manifestHash,
        suiteHash: sealed.suite.suiteHash,
        version: CODE_MEMORY_LINK_PREPARATION_VERSION,
      }),
    );
    addFile(outputFiles, 'clients.json', jsonFile({clients, version: CODE_MEMORY_LINK_PREPARATION_VERSION}));
    for (const [path, content] of calibration.files) addFile(outputFiles, path, content);
    addFile(outputFiles, 'calibration/plan.json', jsonFile(calibration.plan));
    await writePreparedFiles(stagingRoot, outputFiles, binaryFiles);
    await verifyPreparedTree(stagingRoot, outputFiles, binaryFiles);
    await verifySealedBindingsOnDisk(stagingRoot, sealed);
    await assertCleanSourceCheckout(
      sourceRoot,
      options.harnessGovernanceCommit,
      options.gitExecutable,
      options.safeExecutablePath,
    );
    if ((await sha256File(candidate.executable)) !== candidate.executableSha256) {
      throw new Error('Managed candidate executable changed during preparation.');
    }
    const finalReviewedHashes = await reviewedRuntimeHashes(options);
    if (JSON.stringify(finalReviewedHashes) !== JSON.stringify(reviewedHashes)) {
      throw new Error('A reviewed runtime executable changed during preparation.');
    }
    await Promise.all([
      reviewedRegularFile(options.authSource, 'Codex auth source', false),
      assertCodexVersion(options),
    ]);
    await rename(stagingRoot, outputRoot);
    promoted = true;
    process.stdout.write(
      `${JSON.stringify({
        calibrationPlanHash: calibration.plan.planHash,
        clients: EffectArray.map(clients, client => client.clientId),
        fixtureArtifacts: sealed.fixture.artifacts.length,
        fixtureHash: sealed.fixture.fixtureHash,
        manifestHash: manifest.manifestHash,
        output: outputRoot,
        releaseRuns: manifest.schedule.length,
        suiteHash: sealed.suite.suiteHash,
      })}\n`,
    );
  } finally {
    await rm(workRoot, {force: true, maxRetries: 3, recursive: true});
    if (!promoted) await rm(stagingRoot, {force: true, maxRetries: 3, recursive: true});
  }
}

export function codeMemoryLinkAgentPreparationSourceRoot(moduleUrl = import.meta.url): string {
  return resolve(fileURLToPath(new URL('../', moduleUrl)));
}

export function codeMemoryLinkAgentPreparedMemoryDirectory(
  status: CodeMemoryLinkAgentSuiteMemorySeedV1['status'],
): string {
  let lifecycle: 'archived' | 'projects' | 'superseded';
  switch (status) {
    case 'active':
      lifecycle = 'projects';
      break;
    case 'archived':
      lifecycle = 'archived';
      break;
    case 'superseded':
      lifecycle = 'superseded';
      break;
  }
  return `data/${CODE_MEMORY_LINK_AGENT_SUITE_ACCOUNT}/user/${CODE_MEMORY_LINK_AGENT_SUITE_USER}/memories/durable/${lifecycle}/${CODE_MEMORY_LINK_AGENT_SUITE_PROJECT}`;
}

export function codeMemoryLinkAgentPreparedMemoryDestinationMatches(
  destination: string,
  status: CodeMemoryLinkAgentSuiteMemorySeedV1['status'],
): boolean {
  return posix.dirname(destination) === codeMemoryLinkAgentPreparedMemoryDirectory(status);
}

export function assembleCodeMemoryLinkSealedSuiteV1(input: {
  readonly corpusHash: string;
  readonly judgeProgram: string;
  readonly tasks: readonly CodeMemoryLinkPreparedTaskV1[];
}): CodeMemoryLinkSealedAssemblyV1 {
  const releaseDefinitions = EffectArray.map(input.tasks, task => task.definition).sort(compareTasksById);
  const expectedCorpusHash = codeMemoryLinkAgentSuiteCorpusHashV1({
    releaseTasks: releaseDefinitions,
    version: CODE_MEMORY_LINK_AGENT_SUITE_DEFINITION_VERSION,
  });
  if (EffectArray.some(input.tasks, task => task.definition.calibration) || input.corpusHash !== expectedCorpusHash) {
    throw new Error('Release task definitions do not match the supplied release-only corpus hash.');
  }
  const protocol = assembleProtocolTasks(input.tasks, 'release');
  const taskPackets = protocol.packets;
  const rubrics = protocol.rubrics;
  const manifestTasks = EffectArray.map(taskPackets, packet => {
    const rubric = EffectOption.getOrUndefined(
      EffectArray.findFirst(rubrics, candidate => candidate.taskId === packet.taskId),
    )!;
    const prepared = EffectOption.getOrUndefined(
      EffectArray.findFirst(input.tasks, candidate => candidate.definition.taskId === packet.taskId),
    )!;
    return {
      budget: packet.budget,
      constraintTotal: EffectArrayPipe(rubric.predicates, __effectArrayValues =>
        EffectArray.filter(
          __effectArrayValues,
          (predicate, __effectArrayIndex) =>
            __effectArrayIndex in __effectArrayValues && predicate.roles.includes('constraint'),
        ),
      ).length,
      expectedResponseHashes: {
        anchored: codeMemoryLinkContextBriefResponseReceiptHashV1(prepared.preflightExpectedResponses.anchored),
        noMemory: codeMemoryLinkContextBriefResponseReceiptHashV1(prepared.preflightExpectedResponses.noMemory),
        taskOnly: codeMemoryLinkContextBriefResponseReceiptHashV1(prepared.preflightExpectedResponses.taskOnly),
      },
      packetHash: packet.packetHash,
      rubricHash: rubric.rubricHash,
      scenarioFamily: scenarioFamilyForTask(prepared.definition),
      taskId: packet.taskId,
      taskKind: packet.taskKind,
    } satisfies CodeMemoryLinkAgentAbManifestTaskV1;
  });
  const programArtifactId = globalArtifactId('static-judge-program');
  const commandArtifactId = globalArtifactId('static-judge-command');
  const layoutArtifactId = globalArtifactId('sealed-suite-layout');
  const command = {
    maxOutputBytes: 1 * 1_024 * 1_024,
    programArtifactId,
    runner: 'bun',
    timeoutMilliseconds: 30_000,
    version: 1,
  } as const;
  const judgeSources = new Map<
    string,
    {readonly content: string; readonly destination: string; readonly source: string}
  >([
    [
      programArtifactId,
      {
        content: input.judgeProgram,
        destination: 'judge.ts',
        source: `artifacts/judge/${programArtifactId}.ts`,
      },
    ],
    [
      commandArtifactId,
      {
        content: jsonFile(command),
        destination: 'command.json',
        source: `artifacts/judge/${commandArtifactId}.json`,
      },
    ],
  ]);
  const judgeFileSkeleton = EffectArray.map(
    [programArtifactId, commandArtifactId, layoutArtifactId].sort(compareStrings),
    artifactId => ({
      artifactId,
      destination:
        artifactId === programArtifactId
          ? 'judge.ts'
          : artifactId === commandArtifactId
            ? 'command.json'
            : 'adapter.json',
      source:
        artifactId === programArtifactId
          ? `artifacts/judge/${programArtifactId}.ts`
          : artifactId === commandArtifactId
            ? `artifacts/judge/${commandArtifactId}.json`
            : 'adapter.json',
    }),
  );
  const adapter = {
    fixtureFiles: EffectArray.map(protocol.fixtureFiles, ({content: _content, ...file}) => file),
    judge: {commandArtifactId, files: judgeFileSkeleton},
    layoutArtifactId,
    tasks: EffectArray.map(taskPackets, packet => {
      const prepared = EffectOption.getOrUndefined(
        EffectArray.findFirst(input.tasks, task => task.definition.taskId === packet.taskId),
      )!;
      const rubric = EffectOption.getOrUndefined(
        EffectArray.findFirst(rubrics, candidate => candidate.taskId === packet.taskId),
      )!;
      return {
        packetHash: packet.packetHash,
        packetSource: `tasks/${packet.taskId}/packet.json`,
        preflightCodeRefs: ['policy.json'],
        preflightExpectedCitationDigests: prepared.preflightExpectedCitationDigests,
        preflightExpectedResponses: prepared.preflightExpectedResponses,
        preflightExpectedSelectedMemories: prepared.preflightExpectedSelectedMemories,
        project: CODE_MEMORY_LINK_AGENT_SUITE_PROJECT,
        rubricHash: rubric.rubricHash,
        rubricSource: `tasks/${packet.taskId}/rubric.json`,
        taskId: packet.taskId,
        taskKind: packet.taskKind,
      };
    }),
    version: 1,
  };
  const adapterContent = jsonFile(adapter);
  judgeSources.set(layoutArtifactId, {content: adapterContent, destination: 'adapter.json', source: 'adapter.json'});
  const judgeArtifacts = EffectArray.map([...judgeSources.entries()], ([artifactId, value]) => ({
    artifactId,
    sha256: sha256(value.content),
  })).sort(compareArtifacts);
  const judgeWithoutHash = {
    artifacts: judgeArtifacts,
    judgeVersion: `ver_${Effect2.pipe(sha256(input.judgeProgram), EffectString.slice(0, 32))}`,
    version: CODE_MEMORY_LINK_AGENT_PROTOCOL_VERSION,
  };
  const judge = parseCodeMemoryLinkJudgeV1({
    ...judgeWithoutHash,
    judgeHash: codeMemoryLinkJudgeHashV1(judgeWithoutHash),
  });
  const suiteWithoutHash = {
    fixture: protocol.fixture,
    judge,
    suiteId: `sui_${Effect2.pipe(matchingHash(input.corpusHash, 'corpus hash'), EffectString.slice(0, 32))}`,
    tasks: EffectArray.map(taskPackets, packet => {
      const rubric = EffectOption.getOrUndefined(
        EffectArray.findFirst(rubrics, candidate => candidate.taskId === packet.taskId),
      )!;
      return {
        packetHash: packet.packetHash,
        rubricHash: rubric.rubricHash,
        taskId: packet.taskId,
        taskKind: packet.taskKind,
      };
    }),
    version: CODE_MEMORY_LINK_AGENT_PROTOCOL_VERSION,
  };
  const suite = parseCodeMemoryLinkSealedSuiteV1({
    ...suiteWithoutHash,
    suiteHash: codeMemoryLinkSealedSuiteHashV1(suiteWithoutHash),
  });
  assertCodeMemoryLinkSealedSuiteBindingsV1({rubrics, suite, taskPackets});
  const files = new Map<string, string>();
  addFile(files, 'suite.json', jsonFile(suite));
  addFile(files, 'adapter.json', adapterContent);
  for (const file of protocol.fixtureFiles) addFile(files, file.source, file.content);
  for (const [artifactId, source] of judgeSources) {
    if (artifactId !== layoutArtifactId) addFile(files, source.source, source.content);
  }
  for (const packet of taskPackets) {
    addFile(files, `tasks/${packet.taskId}/packet.json`, jsonFile(packet));
    addFile(
      files,
      `tasks/${packet.taskId}/rubric.json`,
      jsonFile(EffectOption.getOrUndefined(EffectArray.findFirst(rubrics, rubric => rubric.taskId === packet.taskId))!),
    );
  }
  return {adapter, files, fixture: protocol.fixture, manifestTasks, rubrics, suite, taskPackets};
}

export function assembleCalibrationPlanV1(input: {
  readonly clients: readonly string[];
  readonly tasks: readonly CodeMemoryLinkPreparedTaskV1[];
}): {readonly files: ReadonlyMap<string, string>; readonly plan: CodeMemoryLinkCalibrationPlanV1} {
  if (input.tasks.length !== 2 || EffectArray.some(input.tasks, task => !task.definition.calibration)) {
    throw new Error('Calibration plan requires exactly two calibration-only tasks.');
  }
  const protocol = assembleProtocolTasks(input.tasks, 'calibration');
  const clients = EffectArray.map([...input.clients], client => matching(client, CLIENT_ID, 'calibration client')).sort(
    compareStrings,
  );
  unique(clients, 'calibration clients');
  const tasks = EffectArray.map(protocol.packets, packet => ({
    packet,
    preflightExpectedCitationDigests: EffectOption.getOrUndefined(
      EffectArray.findFirst(input.tasks, task => task.definition.taskId === packet.taskId),
    )!.preflightExpectedCitationDigests,
    preflightExpectedResponses: EffectOption.getOrUndefined(
      EffectArray.findFirst(input.tasks, task => task.definition.taskId === packet.taskId),
    )!.preflightExpectedResponses,
    preflightExpectedSelectedMemories: EffectOption.getOrUndefined(
      EffectArray.findFirst(input.tasks, task => task.definition.taskId === packet.taskId),
    )!.preflightExpectedSelectedMemories,
    rubric: EffectOption.getOrUndefined(
      EffectArray.findFirst(protocol.rubrics, rubric => rubric.taskId === packet.taskId),
    )!,
  }));
  const fixtureFiles = EffectArray.map(protocol.fixtureFiles, file => ({
    artifactId: file.artifactId,
    destination: file.destination,
    scope: file.scope,
    source: `calibration/${file.source}`,
    taskId: file.taskId,
  }));
  const runs = EffectArray.map(
    EffectArray.flatMap(clients, clientId =>
      EffectArray.flatMap(tasks, task =>
        EffectArray.map(['anchored', 'task-only', 'no-memory'] as const, arm => ({
          arm,
          clientId,
          taskId: task.packet.taskId,
        })),
      ),
    ),
    (run, runOrder) => ({...run, runOrder}),
  );
  const withoutHash = {
    calibrationCorpusHash: codeMemoryLinkAgentSuiteCalibrationCorpusHashV1({
      calibrationTasks: EffectArray.map(input.tasks, task => task.definition).sort(compareTasksById),
      version: CODE_MEMORY_LINK_AGENT_SUITE_DEFINITION_VERSION,
    }),
    clients,
    fixture: protocol.fixture,
    fixtureFiles,
    kind: CODE_MEMORY_LINK_CALIBRATION_KIND,
    releaseLedgerCompatible: false as const,
    runs,
    tasks,
    version: CODE_MEMORY_LINK_CALIBRATION_PLAN_VERSION,
  };
  const plan = {
    ...withoutHash,
    planHash: domainDigest('calibration-plan', withoutHash),
  } satisfies CodeMemoryLinkCalibrationPlanV1;
  const files = new Map<string, string>();
  for (const file of protocol.fixtureFiles) {
    addFile(
      files,
      EffectOption.getOrUndefined(
        EffectArray.findFirst(fixtureFiles, mapping => mapping.artifactId === file.artifactId),
      )!.source,
      file.content,
    );
  }
  for (const task of tasks) {
    addFile(files, `calibration/tasks/${task.packet.taskId}/packet.json`, jsonFile(task.packet));
    addFile(files, `calibration/tasks/${task.packet.taskId}/rubric.json`, jsonFile(task.rubric));
  }
  return {files, plan};
}

function assembleProtocolTasks(
  tasksInput: readonly CodeMemoryLinkPreparedTaskV1[],
  namespace: 'calibration' | 'release',
): ProtocolTaskAssembly {
  const tasks = [...tasksInput].sort((left, right) => compareStrings(left.definition.taskId, right.definition.taskId));
  for (const task of tasks) {
    if (
      task.definition.controlScenario === 'malformed-citation' &&
      (task.homeFiles.length !== 1 ||
        !Effect2.pipe(task.homeFiles[0].content, EffectString.includes('code_citation: {not-canonical-json')))
    ) {
      throw new Error('Malformed-citation control requires one sealed legacy memory with malformed citation metadata.');
    }
  }
  unique(
    EffectArray.map(tasks, task => task.definition.taskId),
    `${namespace} task ids`,
  );
  const fixtureFiles = EffectArray.flatMap(tasks, task => {
    const repository = EffectArray.map(task.definition.publicFiles, file =>
      fixtureMapping(task, 'repository', file.path, file.content),
    );
    const home = EffectArray.map(task.homeFiles, file =>
      fixtureMapping(task, 'threadnote-home', file.destination, file.content),
    );
    return [...repository, ...home];
  }).sort((left, right) => compareStrings(left.artifactId, right.artifactId));
  unique(
    EffectArray.map(fixtureFiles, file => file.artifactId),
    `${namespace} fixture artifact ids`,
  );
  unique(
    EffectArray.map(fixtureFiles, file => sha256(file.content)),
    `${namespace} fixture artifact hashes`,
  );
  if (fixtureFiles.length > 256) throw new Error(`${namespace} fixture exceeds the protocol artifact limit.`);
  const fixtureWithoutHash = {
    artifacts: EffectArray.map(fixtureFiles, file => ({artifactId: file.artifactId, sha256: sha256(file.content)})),
    version: CODE_MEMORY_LINK_AGENT_PROTOCOL_VERSION,
  };
  const fixture = parseCodeMemoryLinkFixtureV1({
    ...fixtureWithoutHash,
    fixtureHash: codeMemoryLinkFixtureHashV1(fixtureWithoutHash),
  });
  const packets = EffectArray.map(tasks, task => {
    const withoutHash = {
      budget: task.definition.budget,
      fixtureHash: fixture.fixtureHash,
      prompt: task.definition.prompt,
      taskId: task.definition.taskId,
      taskKind: task.definition.taskKind,
      version: CODE_MEMORY_LINK_AGENT_PROTOCOL_VERSION,
    };
    return parseCodeMemoryLinkTaskPacketV1({
      ...withoutHash,
      packetHash: codeMemoryLinkTaskPacketHashV1(withoutHash),
    });
  });
  const rubrics = EffectArray.map(tasks, task => createRubric(task, fixture.fixtureHash));
  unique(
    EffectArray.map(packets, packet => packet.packetHash),
    `${namespace} packet hashes`,
  );
  unique(
    EffectArray.map(rubrics, rubric => rubric.rubricHash),
    `${namespace} rubric hashes`,
  );
  return {fixture, fixtureFiles, packets, rubrics};
}

function createRubric(task: CodeMemoryLinkPreparedTaskV1, fixtureHash: string): CodeMemoryLinkRubricV1 {
  const outputArtifactId = codeMemoryLinkAgentSuiteOutputArtifactId(task.definition.taskId);
  const expectedResult = {caseId: task.definition.taskId, role: 'result', selected: task.definition.answer, version: 1};
  const primaryRoles =
    task.definition.taskKind === 'hidden-constraint'
      ? (['constraint', 'memory-exclusive', 'qualifying-action', 'task-pass'] as const)
      : (['qualifying-action', 'task-pass'] as const);
  const instructionInjection =
    task.definition.controlScenario === 'instruction-injection-direct' ||
    task.definition.controlScenario === 'instruction-injection-lexical';
  const predicates = [
    {
      assertion: {artifactId: outputArtifactId, expected: expectedResult, kind: 'json-equals' as const},
      expected: true,
      predicateId: codeMemoryLinkAgentSuitePredicateId(task.definition.taskId, 'primary'),
      roles: [...primaryRoles].sort(compareStrings),
    },
    ...EffectArray.map(task.definition.harmfulAnswers, (answer, index) => ({
      assertion: {
        artifactId: outputArtifactId,
        expected: {caseId: task.definition.taskId, role: 'result', selected: answer, version: 1},
        kind: 'json-equals' as const,
      },
      expected: false,
      predicateId: codeMemoryLinkAgentSuitePredicateId(task.definition.taskId, 'harmful', index),
      roles: ['harmful-acceptance'] as const,
    })),
    ...(instructionInjection
      ? [
          {
            assertion: {
              artifactId: codeMemoryLinkAgentSuiteGuardArtifactId(task.definition.taskId),
              expected: codeMemoryLinkAgentSuiteGuardValueV1(task.definition.taskId),
              kind: 'json-equals' as const,
            },
            expected: true,
            predicateId: codeMemoryLinkAgentSuitePredicateId(task.definition.taskId, 'guard-invariant'),
            roles: ['harmful-acceptance', 'task-pass'] as const,
          },
        ]
      : []),
  ].sort((left, right) => compareStrings(left.predicateId, right.predicateId));
  const withoutHash = {
    fixtureHash,
    goldCitationDigests:
      task.definition.taskKind === 'hidden-constraint' ? [...task.citationDigests].sort(compareStrings) : [],
    predicates,
    qualifyingActionItemTypes: ['fileChange'] as const,
    taskId: task.definition.taskId,
    taskKind: task.definition.taskKind,
    version: CODE_MEMORY_LINK_AGENT_PROTOCOL_VERSION,
  };
  return parseCodeMemoryLinkRubricV1({...withoutHash, rubricHash: codeMemoryLinkRubricHashV1(withoutHash)});
}

function fixtureMapping(
  task: CodeMemoryLinkPreparedTaskV1,
  scope: 'repository' | 'threadnote-home',
  destination: string,
  content: string,
): FixtureMapping {
  const safeDestination = relativeFile(destination, `${scope} fixture destination`);
  assertBoundedUtf8(content, `${scope} fixture ${safeDestination}`);
  const artifactId = codeMemoryLinkAgentSuiteArtifactId(task.definition.taskId, scope, safeDestination);
  return {
    artifactId,
    content,
    destination: safeDestination,
    scope,
    source: `artifacts/fixture/${artifactId}${extname(safeDestination) || '.txt'}`,
    taskId: task.definition.taskId,
  };
}

async function prepareTask(
  definition: CodeMemoryLinkAgentSuiteTaskDefinitionV1,
  candidate: CandidateRuntime,
  options: Options,
  taskRoot: string,
): Promise<CodeMemoryLinkPreparedTaskV1> {
  await mkdir(taskRoot, {recursive: false, mode: 0o700});
  const repository = join(taskRoot, 'repository');
  const home = join(taskRoot, 'home');
  await Promise.all([mkdir(repository, {mode: 0o700}), mkdir(home, {mode: 0o700})]);
  await writeTaskFiles(repository, definition.initialFiles);
  const origin = codeMemoryLinkAgentSuiteRemoteUrl(definition.taskId);
  const commit = await initializeRepository({
    gitExecutable: options.gitExecutable,
    repository,
    remote: origin,
    safeExecutablePath: options.safeExecutablePath,
    taskId: definition.taskId,
  });
  const environment = candidateEnvironment(home, options.safeExecutablePath, options.temporaryRoot);
  const localGraph = await indexGraph(candidate.executable, repository, home, environment, {
    commit,
    gitExecutable: options.gitExecutable,
    origin,
    safeExecutablePath: options.safeExecutablePath,
  });
  let foreignGraph: PreparedGraphIdentity | null = null;

  if (EffectArray.some(definition.memorySeeds, seed => seed.foreignRepository)) {
    const foreign = join(taskRoot, 'foreign-repository');
    await mkdir(foreign, {mode: 0o700});
    await writeTaskFiles(foreign, definition.initialFiles);
    const foreignOrigin = codeMemoryLinkAgentSuiteRemoteUrl(definition.taskId, true);
    const foreignCommit = await initializeRepository({
      gitExecutable: options.gitExecutable,
      repository: foreign,
      remote: foreignOrigin,
      safeExecutablePath: options.safeExecutablePath,
      taskId: definition.taskId,
    });
    foreignGraph = await indexGraph(candidate.executable, foreign, home, environment, {
      commit: foreignCommit,
      gitExecutable: options.gitExecutable,
      origin: foreignOrigin,
      safeExecutablePath: options.safeExecutablePath,
    });
    for (const seed of EffectArrayPipe(definition.memorySeeds, __effectArrayValues =>
      EffectArray.filter(
        __effectArrayValues,
        (seed, __effectArrayIndex) => __effectArrayIndex in __effectArrayValues && seed.foreignRepository,
      ),
    )) {
      await rememberSeed(candidate.executable, foreign, home, seed, environment);
    }
  }

  for (const seed of EffectArray.filter(definition.memorySeeds, seed => !seed.foreignRepository)) {
    if (seed.malformedCitationProbe) {
      await assertMalformedCitationRejected(candidate.executable, repository, home, seed, environment);
    }
    await rememberSeed(candidate.executable, repository, home, seed, environment);
  }

  let finalCommit = commit;
  if (JSON.stringify(definition.initialFiles) !== JSON.stringify(definition.publicFiles)) {
    await replaceTaskFiles(repository, definition.initialFiles, definition.publicFiles);
    finalCommit = await commitRepositoryChange({
      gitExecutable: options.gitExecutable,
      message: `fixture-final ${definition.taskId}`,
      repository,
      safeExecutablePath: options.safeExecutablePath,
    });
  }
  await assertCleanRepository(options.gitExecutable, repository, options.safeExecutablePath);
  const memories = await collectMemoryFiles(home, taskRoot);
  if (memories.length !== definition.memorySeeds.length) {
    throw new Error(`Task ${definition.taskId} did not produce exactly one canonical memory per seed.`);
  }
  validateCodeMemoryLinkPreparedMemories(memories, definition, localGraph, foreignGraph);
  const sealedMemories =
    definition.controlScenario === 'malformed-citation'
      ? EffectArray.map(memories, file => ({
          ...file,
          content: injectCodeMemoryLinkMalformedLegacyCitationV1(file.content),
        }))
      : memories;
  if (definition.controlScenario === 'malformed-citation') {
    assertCodeMemoryLinkMalformedSealedMemoryV1(sealedMemories[0].content, definition);
    for (const file of sealedMemories) {
      await writeFile(joinWithin(home, file.destination, 'sealed malformed memory destination'), file.content, {
        encoding: 'utf8',
        mode: 0o600,
      });
    }
  }
  const citationIds =
    definition.controlScenario === 'malformed-citation'
      ? []
      : EffectArray.flatMap(sealedMemories, file => memoryCitationIds(file.content));
  const expectedCitationCount = EffectArray.filter(definition.memorySeeds, seed => seed.citationPath !== null).length;
  if (citationIds.length !== expectedCitationCount) {
    throw new Error(`Task ${definition.taskId} produced an unexpected citation count.`);
  }
  const citationDigests = [...new Set(EffectArray.map(citationIds, codeMemoryLinkGoldCitationDigest))].sort(
    compareStrings,
  );
  const preflightExpectedCitationDigests =
    definition.taskKind === 'hidden-constraint' ||
    definition.controlScenario === 'ambiguous' ||
    definition.controlScenario === 'instruction-injection-direct'
      ? citationDigests
      : [];
  if (definition.taskKind === 'hidden-constraint' && citationDigests.length !== 1) {
    throw new Error(`Hidden task ${definition.taskId} requires exactly one gold citation.`);
  }
  // Citations intentionally remain bound to the graph that existed when the memory was
  // written, while the production preflight must exercise the final public checkout.
  // Rebuilding here is what makes stale/changed/deleted controls representative of the
  // runtime adapter, which also indexes its freshly copied final repository.
  await indexGraph(candidate.executable, repository, home, environment, {
    commit: finalCommit,
    gitExecutable: options.gitExecutable,
    origin,
    safeExecutablePath: options.safeExecutablePath,
  });
  const anchoredBrief = await runPreparedContextBrief(candidate.executable, definition, repository, home, environment, [
    'policy.json',
  ]);
  if (anchoredBrief.version !== 3) {
    throw new Error(`Task ${definition.taskId} anchored preflight did not return Context Brief v3.`);
  }
  const taskOnlyBrief = await runPreparedContextBrief(
    candidate.executable,
    definition,
    repository,
    home,
    environment,
    [],
  );
  if (taskOnlyBrief.version !== 2) {
    throw new Error(`Task ${definition.taskId} task-only preflight did not return Context Brief v2.`);
  }
  const observedCitationDigests = contextBriefExactCitationDigests(anchoredBrief);
  if (JSON.stringify(observedCitationDigests) !== JSON.stringify(preflightExpectedCitationDigests)) {
    throw new Error(`Task ${definition.taskId} anchored preflight citation roster differs from its sealed set.`);
  }
  const preflightExpectedSelectedMemories = codeMemoryLinkContextBriefSelectedMemoriesV1(anchoredBrief);
  if (definition.taskKind === 'hidden-constraint') {
    assertHiddenArmDiscrimination(definition, citationDigests, anchoredBrief, taskOnlyBrief);
  } else if (definition.controlScenario === 'ambiguous') {
    assertAmbiguousControlPreflight(definition, citationDigests, anchoredBrief);
  } else if (
    definition.controlScenario === 'instruction-injection-direct' ||
    definition.controlScenario === 'instruction-injection-lexical'
  ) {
    assertCodeMemoryLinkInstructionInjectionControlPreflightV1(
      definition,
      citationDigests,
      anchoredBrief,
      taskOnlyBrief,
    );
  }
  return {
    citationDigests,
    definition,
    homeFiles: EffectArray.map(sealedMemories, file => ({content: file.content, destination: file.destination})),
    preflightExpectedCitationDigests,
    preflightExpectedResponses: {
      anchored: canonicalizeCodeMemoryLinkContextBriefResultV1(anchoredBrief).receipt,
      noMemory: canonicalizeCodeMemoryLinkContextBriefResultV1(
        CODE_MEMORY_LINK_CANONICAL_EMPTY_CONTEXT_BRIEF_V1.structuredContent,
      ).receipt,
      taskOnly: canonicalizeCodeMemoryLinkContextBriefResultV1(taskOnlyBrief).receipt,
    },
    preflightExpectedSelectedMemories,
  };
}

async function prepareClients(input: {
  readonly binaryFiles: Map<string, PreparedBinaryFile>;
  readonly options: Options;
  readonly outputFiles: Map<string, string>;
  readonly outputRoot: string;
  readonly sealed: CodeMemoryLinkSealedAssemblyV1;
  readonly sourceRoot: string;
}): Promise<readonly CodeMemoryLinkPreparedClientV1[]> {
  const {binaryFiles, options, outputFiles, outputRoot, sealed, sourceRoot} = input;
  const clientEntrypoint = join(sourceRoot, 'scripts/run-code-memory-link-codex-client.ts');
  const proxyEntrypoint = join(sourceRoot, 'scripts/code-memory-link-context-proxy.ts');
  const dependenciesLockPath = join(sourceRoot, 'bun.lock');
  const [clientBundle, proxyBundle] = await Promise.all([
    buildReviewedBundle(clientEntrypoint, sourceRoot, 'Codex client'),
    buildReviewedBundle(proxyEntrypoint, sourceRoot, 'Context Brief proxy'),
  ]);
  const clientBundleSha256 = sha256(clientBundle);
  const proxyBundleSha256 = sha256(proxyBundle);
  const clientBundleRelative = `clients/runtime/client-${Effect2.pipe(clientBundleSha256, EffectString.slice(0, 32))}.mjs`;
  const proxyBundleRelative = `clients/runtime/proxy-${Effect2.pipe(proxyBundleSha256, EffectString.slice(0, 32))}.mjs`;
  addBinaryFile(binaryFiles, clientBundleRelative, clientBundle, 0o500);
  addBinaryFile(binaryFiles, proxyBundleRelative, proxyBundle, 0o500);
  const clientBundlePath = join(outputRoot, clientBundleRelative);
  const proxyBundlePath = join(outputRoot, proxyBundleRelative);
  const safeRuntime = await prepareSafeRuntimeBinaries({binaryFiles, options, outputRoot});
  const [appServerSha256, bunSha256, dependenciesLockHash, entrypointHash] = await Promise.all([
    sha256File(options.codexExecutable),
    sha256File(options.bunExecutable),
    sha256File(dependenciesLockPath),
    sha256File(clientEntrypoint),
  ]);
  const artifactBindings = [
    clientBinding('client-bundle', clientBundlePath, clientBundleSha256),
    clientBinding('client-entrypoint', clientEntrypoint, entrypointHash),
    clientBinding('proxy-bundle', proxyBundlePath, proxyBundleSha256),
  ].sort(compareClientBindings);
  const binaryBindings = [
    clientBinding('client-runtime', options.bunExecutable, bunSha256),
    clientBinding('codex-app-server', options.codexExecutable, appServerSha256),
    ...safeRuntime.bindings,
  ].sort(compareClientBindings);
  const clients: CodeMemoryLinkPreparedClientV1[] = [];
  for (const model of MODEL_IDS) {
    const config = {
      appServer: {
        executable: options.codexExecutable,
        executableSha256: appServerSha256,
        version: CODE_MEMORY_LINK_CODEX_APP_SERVER_VERSION,
      },
      authSourcePath: options.authSource,
      git: {executable: safeRuntime.git.path, executableSha256: safeRuntime.git.sha256},
      limits: {turnTimeoutMilliseconds: options.turnTimeoutMilliseconds},
      model: {id: model, provider: options.modelProvider, reasoningEffort: options.reasoningEffort},
      proxy: {
        bundlePath: proxyBundlePath,
        bundleSha256: proxyBundleSha256,
        bunExecutable: options.bunExecutable,
        bunExecutableSha256: bunSha256,
      },
      safeBinaries: safeRuntime.safeBinaries,
      safeExecutablePath: safeRuntime.root,
      sealedSuite: {layoutArtifactId: String(sealed.adapter.layoutArtifactId), root: outputRoot},
      temporaryRoot: options.temporaryRoot,
      version: 1,
    } as const;
    const parsedConfig = parseCodeMemoryLinkCodexClientConfigV1(config);
    const configContent = jsonFile(config);
    const configurationProjection = projectCodeMemoryLinkCodexClientConfigV1(parsedConfig);
    const configurationProjectionContent = jsonFile(configurationProjection);
    const expectedClientProjection = {
      appServerVersion: Effect2.pipe(CODE_MEMORY_LINK_CODEX_APP_SERVER_VERSION, EffectString.replace('codex-cli ', '')),
      model,
      modelProvider: options.modelProvider,
      proxyTool: {server: CODE_MEMORY_LINK_PROXY_SERVER_NAME, tool: 'context_brief'},
      reasoningEffort: options.reasoningEffort,
    };
    const descriptor = parseCodeMemoryLinkClientImplementationDescriptorV1({
      argumentVectorHash: codeMemoryLinkClientArgumentVectorHash([clientBundlePath]),
      artifactBindings,
      binaryBindings,
      configurationHash: sha256(configContent),
      configurationProjectionHash: sha256(configurationProjectionContent),
      dependenciesLockHash,
      entrypointHash,
      environmentPolicyHash: codeMemoryLinkClientProjectionHash(
        'environment-policy',
        CODE_MEMORY_LINK_CODEX_ENVIRONMENT_POLICY_V1,
      ),
      executionBundleHash: clientBundleSha256,
      expectedClientProjectionHash: codeMemoryLinkClientProjectionHash('expected-client', expectedClientProjection),
      version: 2,
    });
    const implementationDescriptorHash = codeMemoryLinkClientImplementationDescriptorHash(descriptor);
    const clientId = `cli_${Effect2.pipe(domainDigest('client-id', {implementationDescriptorHash, model}), EffectString.slice(0, 32))}`;
    matching(clientId, CLIENT_ID, 'client id');
    const clientConfigurationPath = join(outputRoot, `clients/${clientId}.config.json`);
    const clientConfigurationProjectionPath = join(outputRoot, `clients/${clientId}.config-projection.json`);
    const clientDescriptorPath = join(outputRoot, `clients/${clientId}.descriptor.json`);
    addFile(outputFiles, `clients/${clientId}.config.json`, configContent);
    addFile(outputFiles, `clients/${clientId}.config-projection.json`, configurationProjectionContent);
    addFile(outputFiles, `clients/${clientId}.descriptor.json`, jsonFile(descriptor));
    clients.push({
      clientArguments: [clientBundlePath],
      clientArtifactBindings: EffectArray.map(artifactBindings, binding => ({
        path:
          binding.role === 'client-bundle'
            ? clientBundlePath
            : binding.role === 'proxy-bundle'
              ? proxyBundlePath
              : clientEntrypoint,
        role: binding.role,
      })),
      clientBinaryBindings: EffectArray.map(binaryBindings, binding => ({
        path:
          binding.role === 'client-runtime'
            ? options.bunExecutable
            : binding.role === 'codex-app-server'
              ? options.codexExecutable
              : safeRuntime.byRole.get(binding.role)!,
        role: binding.role,
      })),
      clientCommand: options.bunExecutable,
      clientConfigurationProjectionPath,
      clientConfigurationPath,
      clientDependenciesLockPath: dependenciesLockPath,
      clientDescriptorPath,
      clientId,
      descriptor,
      implementationDescriptorHash,
      model,
    });
  }
  clients.sort((left, right) => compareStrings(left.clientId, right.clientId));
  unique(
    EffectArray.map(clients, client => client.clientId),
    'client ids',
  );
  unique(
    EffectArray.map(clients, client => client.implementationDescriptorHash),
    'client descriptor hashes',
  );
  return clients;
}

async function createManifest(input: {
  readonly assignment: CodeMemoryLinkAgentAbAssignmentV1;
  readonly candidate: CandidateRuntime;
  readonly clients: readonly CodeMemoryLinkPreparedClientV1[];
  readonly options: Options;
  readonly sealed: CodeMemoryLinkSealedAssemblyV1;
  readonly sourceRoot: string;
}): Promise<CodeMemoryLinkAgentAbManifestV1> {
  const manifestClients = EffectArray.map(input.clients, client => ({
    clientId: client.clientId,
    configurationProjectionHash: client.descriptor.configurationProjectionHash,
    environmentPolicyHash: client.descriptor.environmentPolicyHash,
    executionBundleHash: client.descriptor.executionBundleHash,
    expectedClient: {
      appServerVersion: parseExpectedAppServerVersion(
        Effect2.pipe(CODE_MEMORY_LINK_CODEX_APP_SERVER_VERSION, EffectString.replace('codex-cli ', '')),
      ),
      model: client.model,
      modelProvider: input.options.modelProvider,
      reasoningEffort: input.options.reasoningEffort,
    },
    implementationDescriptorHash: client.implementationDescriptorHash,
  })) satisfies readonly CodeMemoryLinkAgentAbManifestClientV1[];
  const evaluatorHash = await sha256File(
    join(input.sourceRoot, 'apps/threadnote/src/evaluation/code-memory-link-agent-ab.ts'),
  );
  const schedule = deriveCodeMemoryLinkAgentAbScheduleV1({
    clients: manifestClients,
    scheduleAlgorithmVersion: CODE_MEMORY_LINK_AGENT_AB_SCHEDULE_ALGORITHM_VERSION,
    scheduleSeed: input.options.scheduleSeed,
    tasks: input.sealed.manifestTasks,
  });
  const withoutHash = {
    adjudicationArtifactHash: input.sealed.suite.judge.judgeHash,
    assignmentHash: input.assignment.assignmentHash,
    candidate: {
      buildIdentityHash: input.candidate.executableSha256,
      commit: input.candidate.sourceCommit,
      dirty: false as const,
    },
    clients: manifestClients,
    evaluatorVersion: `ver_${Effect2.pipe(evaluatorHash, EffectString.slice(0, 32))}`,
    experimentId: `exp_${Effect2.pipe(
      domainDigest('experiment', {
        candidate: input.candidate.sourceCommit,
        clients: manifestClients,
        harnessGovernanceCommit: input.options.harnessGovernanceCommit,
        suiteHash: input.sealed.suite.suiteHash,
      }),
      EffectString.slice(0, 32),
    )}`,
    fixtureHash: input.sealed.fixture.fixtureHash,
    harnessGovernanceCommit: input.options.harnessGovernanceCommit,
    judgeVersion: input.sealed.suite.judge.judgeVersion,
    schedule,
    scheduleAlgorithmVersion: CODE_MEMORY_LINK_AGENT_AB_SCHEDULE_ALGORITHM_VERSION,
    scheduleSeed: input.options.scheduleSeed,
    suiteHash: input.sealed.suite.suiteHash,
    tasks: input.sealed.manifestTasks,
    version: 1 as const,
  };
  return parseCodeMemoryLinkAgentAbManifestV1({
    ...withoutHash,
    manifestHash: codeMemoryLinkAgentAbManifestHash(withoutHash),
  });
}

async function buildReviewedBundle(entrypoint: string, sourceRoot: string, label: string): Promise<Uint8Array> {
  await readReviewedTextFile(entrypoint, `${label} entrypoint`);
  const buildOnce = async (): Promise<Uint8Array> => {
    const result = await Bun.build({
      entrypoints: [entrypoint],
      format: 'esm',
      minify: false,
      packages: 'bundle',
      root: sourceRoot,
      sourcemap: 'none',
      target: 'bun',
    });
    if (!result.success || result.outputs.length !== 1) {
      throw new Error(`${label} dependency-closed bundle could not be built.`);
    }
    return new Uint8Array(await result.outputs[0].arrayBuffer());
  };
  const [bytes, repeated] = await Promise.all([buildOnce(), buildOnce()]);
  if (bytes.byteLength === 0 || bytes.byteLength > 8 * 1_024 * 1_024) {
    throw new Error(`${label} dependency-closed bundle is outside its size limit.`);
  }
  if (bytes.byteLength !== repeated.byteLength || !bytes.every((byte, index) => byte === repeated[index])) {
    throw new Error(`${label} dependency-closed bundle is not reproducible within one preparation.`);
  }
  return bytes;
}

async function prepareSafeRuntimeBinaries(input: {
  readonly binaryFiles: Map<string, PreparedBinaryFile>;
  readonly options: Options;
  readonly outputRoot: string;
}): Promise<{
  readonly bindings: readonly CodeMemoryLinkClientArtifactBindingV2[];
  readonly byRole: ReadonlyMap<string, string>;
  readonly git: {readonly path: string; readonly sha256: string};
  readonly root: string;
  readonly safeBinaries: CodeMemoryLinkCodexClientConfigV1['safeBinaries'];
}> {
  const root = join(input.outputRoot, 'clients/runtime/bin');
  const safeBinaries: Array<CodeMemoryLinkCodexClientConfigV1['safeBinaries'][number]> = [];
  const bindings: CodeMemoryLinkClientArtifactBindingV2[] = [];
  const byRole = new Map<string, string>();
  for (const name of CODE_MEMORY_LINK_SAFE_EXECUTABLE_NAMES) {
    const source =
      name === 'git'
        ? await reviewedRegularFile(input.options.gitExecutable, 'Git executable', false)
        : await resolveSafeExecutable(name, input.options.safeExecutablePath);
    const bytes = new Uint8Array(await readFile(source));
    const digest = sha256(bytes);
    const relativePath = `clients/runtime/bin/${name}`;
    const path = join(input.outputRoot, relativePath);
    addBinaryFile(input.binaryFiles, relativePath, bytes, 0o500);
    safeBinaries.push({name, path, sha256: digest});
    const role = name === 'git' ? 'git' : `safe-${name}`;
    bindings.push(clientBinding(role, path, digest));
    byRole.set(role, path);
  }
  return {
    bindings: bindings.sort(compareClientBindings),
    byRole,
    git: EffectOption.getOrUndefined(EffectArray.findFirst(safeBinaries, binary => binary.name === 'git'))!,
    root,
    safeBinaries,
  };
}

async function resolveSafeExecutable(name: string, safeExecutablePath: string): Promise<string> {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- This separator is not proven nonempty; native split returns [] for an empty receiver with an empty separator while Effect String split returns a nonempty array.
  for (const directory of safeExecutablePath.split(delimiter)) {
    const candidate = join(directory, name);
    try {
      const canonical = await realpath(candidate);
      const metadata = await stat(canonical);
      if (metadata.isFile()) return canonical;
    } catch (cause) {
      if (!isMissingFileError(cause)) throw cause;
    }
  }
  throw new Error(`Safe executable PATH does not provide required ${name}.`);
}

function clientBinding(role: string, path: string, digest: string): CodeMemoryLinkClientArtifactBindingV2 {
  return {pathDigest: codeMemoryLinkClientPathDigest(path), role, sha256: matchingHash(digest, `${role} hash`)};
}

function compareClientBindings(
  left: CodeMemoryLinkClientArtifactBindingV2,
  right: CodeMemoryLinkClientArtifactBindingV2,
): number {
  return compareStrings(left.role, right.role);
}

function createAssignment(fixtureHash: string, assignmentSeed: string): CodeMemoryLinkAgentAbAssignmentV1 {
  const permutation =
    ARM_LABEL_PERMUTATIONS[
      Number.parseInt(Effect2.pipe(assignmentSeed, EffectString.slice(0, 8)), 16) % ARM_LABEL_PERMUTATIONS.length
    ];
  const withoutHash = {
    fixtureHash,
    labels: {X: permutation[0], Y: permutation[1], Z: permutation[2]},
    version: 1 as const,
  };
  return parseCodeMemoryLinkAgentAbAssignmentV1({
    ...withoutHash,
    assignmentHash: codeMemoryLinkAgentAbAssignmentHash(withoutHash),
  });
}

async function initializeRepository(input: {
  readonly gitExecutable: string;
  readonly remote: string;
  readonly repository: string;
  readonly safeExecutablePath: string;
  readonly taskId: string;
}): Promise<string> {
  const environment = gitEnvironment(input.safeExecutablePath, dirname(input.repository));
  const run = (arguments_: readonly string[]) =>
    capture(input.gitExecutable, arguments_, {
      cwd: input.repository,
      environment,
      maxOutputBytes: 64 * 1_024,
      timeoutMilliseconds: 30_000,
    });
  await run(['-c', 'init.defaultBranch=main', 'init', '--object-format=sha1', '--quiet']);
  await run(['remote', 'add', 'origin', input.remote]);
  await run(['add', '--all']);
  await capture(input.gitExecutable, ['commit', '--quiet', '--no-gpg-sign', '-m', `fixture ${input.taskId}`], {
    cwd: input.repository,
    environment: {...environment, ...fixedCommitIdentity()},
    maxOutputBytes: 64 * 1_024,
    timeoutMilliseconds: 30_000,
  });
  await assertCleanRepository(input.gitExecutable, input.repository, input.safeExecutablePath);
  const commit = Effect2.pipe((await run(['rev-parse', 'HEAD'])).stdout, EffectString.trim);
  matching(commit, COMMIT, 'fixture commit');
  return commit;
}

async function commitRepositoryChange(input: {
  readonly gitExecutable: string;
  readonly message: string;
  readonly repository: string;
  readonly safeExecutablePath: string;
}): Promise<string> {
  const environment = gitEnvironment(input.safeExecutablePath, dirname(input.repository));
  await capture(input.gitExecutable, ['add', '--all'], {
    cwd: input.repository,
    environment,
    maxOutputBytes: 64 * 1_024,
    timeoutMilliseconds: 30_000,
  });
  await capture(input.gitExecutable, ['commit', '--quiet', '--no-gpg-sign', '-m', input.message], {
    cwd: input.repository,
    environment: {
      ...environment,
      ...fixedCommitIdentity(),
      GIT_AUTHOR_DATE: '2000-01-02T00:00:00Z',
      GIT_COMMITTER_DATE: '2000-01-02T00:00:00Z',
    },
    maxOutputBytes: 64 * 1_024,
    timeoutMilliseconds: 30_000,
  });
  const head = await capture(input.gitExecutable, ['rev-parse', 'HEAD'], {
    cwd: input.repository,
    environment,
    maxOutputBytes: 64 * 1_024,
    timeoutMilliseconds: 30_000,
  });
  return matching(Effect2.pipe(head.stdout, EffectString.trim), COMMIT, 'final fixture commit');
}

async function assertCleanRepository(
  gitExecutable: string,
  repository: string,
  safeExecutablePath: string,
): Promise<void> {
  const result = await capture(gitExecutable, ['status', '--porcelain=v1'], {
    cwd: repository,
    environment: gitEnvironment(safeExecutablePath, dirname(repository)),
    maxOutputBytes: 64 * 1_024,
    timeoutMilliseconds: 30_000,
  });
  if (result.stdout !== '') throw new Error('Prepared fixture repository is not clean.');
}

async function indexGraph(
  candidateExecutable: string,
  repository: string,
  home: string,
  environment: Readonly<Record<string, string>>,
  expected: {
    readonly commit: string;
    readonly gitExecutable: string;
    readonly origin: string;
    readonly safeExecutablePath: string;
  },
): Promise<PreparedGraphIdentity> {
  await capture(
    candidateExecutable,
    ['graph', 'index', '--home', home, '--cwd', repository, '--no-vectors', '--json'],
    {cwd: repository, environment, maxOutputBytes: 2 * 1_024 * 1_024, timeoutMilliseconds: 300_000},
  );
  const status = await capture(
    candidateExecutable,
    ['graph', 'status', '--home', home, '--cwd', repository, '--json'],
    {
      cwd: repository,
      environment,
      maxOutputBytes: 512 * 1_024,
      timeoutMilliseconds: 120_000,
    },
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(status.stdout) as unknown;
  } catch (cause) {
    throw new Error('Prepared fixture graph status was not JSON.', {cause});
  }
  const validated = assertCodeMemoryLinkGraphStatusPreflight(parsed, {
    commit: expected.commit,
    origin: expected.origin,
    repositoryRoot: repository,
  });
  const statusRecord = object(parsed, 'prepared graph status');
  const identity = object(statusRecord.identity, 'prepared graph identity');
  const readySnapshot = object(statusRecord.readySnapshot, 'prepared ready graph snapshot');
  const extractorSet = matching(readySnapshot.extractorSet, HASH, 'prepared graph extractor set');
  const repositoryObjectFormat = await readRepositoryObjectFormat(
    expected.gitExecutable,
    repository,
    expected.safeExecutablePath,
  );
  const objectFormat = assertPreparedGraphObjectFormat(identity.objectFormat, repositoryObjectFormat);
  const repositoryId = boundedText(identity.repositoryId, 'prepared graph repository id', 256);
  return {
    commit: expected.commit,
    extractorSet,
    graphContentId: validated.graphContentId,
    objectFormat,
    origin: expected.origin,
    repositoryId,
    snapshotId: validated.snapshotId,
  };
}

export function assertPreparedGraphObjectFormat(
  reported: unknown,
  repositoryObjectFormat: GitObjectFormat,
): PreparedGraphIdentity['objectFormat'] {
  if (reported !== 'sha1' && reported !== 'sha256') {
    throw new Error('Prepared fixture graph has an unsupported Git object format.');
  }
  if (repositoryObjectFormat !== 'sha1') {
    throw new Error('Prepared fixture repository must use the SHA-1 object format.');
  }
  if (reported !== repositoryObjectFormat) {
    throw new Error('Prepared fixture graph Git object format differs from the repository.');
  }
  return 'sha1';
}

async function readRepositoryObjectFormat(
  gitExecutable: string,
  repository: string,
  safeExecutablePath: string,
): Promise<GitObjectFormat> {
  const result = await capture(gitExecutable, ['rev-parse', '--show-object-format'], {
    cwd: repository,
    environment: gitEnvironment(safeExecutablePath, dirname(repository)),
    maxOutputBytes: 64 * 1_024,
    timeoutMilliseconds: 30_000,
  });
  const objectFormat = Effect2.pipe(result.stdout, EffectString.trim);
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
    throw new Error('Prepared fixture repository has an unsupported Git object format.');
  }
  return objectFormat;
}

async function rememberSeed(
  candidateExecutable: string,
  repository: string,
  home: string,
  seed: CodeMemoryLinkAgentSuiteTaskDefinitionV1['memorySeeds'][number],
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  const args = [
    'remember',
    '--home',
    home,
    '--kind',
    'durable',
    '--project',
    CODE_MEMORY_LINK_AGENT_SUITE_PROJECT,
    '--topic',
    seed.topic,
    '--status',
    seed.status,
    '--source-agent-client',
    'code-memory-link-gate',
    '--text',
    seed.text,
    ...(seed.citationPath === null ? [] : ['--code-ref', seed.citationPath]),
  ];
  const result = await capture(candidateExecutable, args, {
    cwd: repository,
    environment,
    maxOutputBytes: 256 * 1_024,
    timeoutMilliseconds: 120_000,
  });
  if (!/^Stored memory: threadnote:\/\//u.test(Effect2.pipe(result.stdout, EffectString.trim))) {
    throw new Error('Candidate remember did not return one canonical memory URI.');
  }
}

async function assertMalformedCitationRejected(
  candidateExecutable: string,
  repository: string,
  home: string,
  seed: CodeMemoryLinkAgentSuiteTaskDefinitionV1['memorySeeds'][number],
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  const result = await capture(
    candidateExecutable,
    [
      'remember',
      '--home',
      home,
      '--kind',
      'durable',
      '--project',
      CODE_MEMORY_LINK_AGENT_SUITE_PROJECT,
      '--topic',
      `${seed.topic}-malformed-probe`,
      '--text',
      seed.text,
      '--code-ref',
      '../escape.json',
    ],
    {
      allowFailure: true,
      cwd: repository,
      environment,
      maxOutputBytes: 256 * 1_024,
      timeoutMilliseconds: 120_000,
    },
  );
  if (result.exitCode === 0) throw new Error('Candidate accepted a malformed path-escaping code citation.');
}

async function collectMemoryFiles(
  home: string,
  forbiddenRoot: string,
): Promise<readonly {readonly content: string; readonly destination: string}[]> {
  const dataRoot = join(home, 'data');
  const files = await walkRegularFiles(dataRoot);
  const memories: {content: string; destination: string}[] = [];
  for (const file of files) {
    if (!Effect2.pipe(file, EffectString.endsWith('.md'))) continue;
    const content = await readReviewedTextFile(file, 'prepared memory');
    if (
      Effect2.pipe(content, EffectString.includes(forbiddenRoot)) ||
      Effect2.pipe(content, EffectString.includes(home))
    ) {
      throw new Error('Prepared memory leaked a disposable filesystem path.');
    }
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- This separator is not proven nonempty; native split returns [] for an empty receiver with an empty separator while Effect String split returns a nonempty array.
    const destination = EffectArray.join(relative(home, file).split(sep), '/');
    relativeFile(destination, 'prepared memory destination');
    memories.push({content, destination});
  }
  memories.sort((left, right) => compareStrings(left.destination, right.destination));
  unique(
    EffectArray.map(memories, memory => memory.destination),
    'prepared memory destinations',
  );
  return memories;
}

function memoryCitationIds(content: string): readonly string[] {
  const ids = EffectArray.flatMap(Effect2.pipe(content, EffectString.split(/\r?\n/u)), line => {
    if (!Effect2.pipe(line, EffectString.startsWith('code_citation: '))) return [];
    let citation: unknown;
    try {
      citation = JSON.parse(Effect2.pipe(line, EffectString.slice('code_citation: '.length))) as unknown;
    } catch {
      throw new Error('Prepared memory contains malformed code-citation JSON.');
    }
    if (!Predicate.isObject(citation)) {
      throw new Error('Prepared memory contains a non-object code citation.');
    }
    const id = citation.id;
    return [matching(id, MEMORY_CITATION_ID, 'memory citation id')];
  });
  unique(ids, 'memory citation ids');
  return ids;
}

export function validateCodeMemoryLinkPreparedMemories(
  memories: readonly {readonly content: string; readonly destination: string}[],
  definition: CodeMemoryLinkAgentSuiteTaskDefinitionV1,
  localGraph: PreparedGraphIdentity,
  foreignGraph: PreparedGraphIdentity | null,
): void {
  const identityRoot = `data/${CODE_MEMORY_LINK_AGENT_SUITE_ACCOUNT}/user/${CODE_MEMORY_LINK_AGENT_SUITE_USER}/memories/durable/`;
  const records = EffectArray.map(memories, (memory, index) => {
    if (!Effect2.pipe(memory.destination, EffectString.startsWith(identityRoot))) {
      throw new Error(`Task ${definition.taskId} memory ${index} is outside the canonical managed identity path.`);
    }
    let record: MemoryRecord | undefined;
    try {
      record = parseMemoryDocument(
        `threadnote://user/${CODE_MEMORY_LINK_AGENT_SUITE_USER}/memories/durable/projects/${CODE_MEMORY_LINK_AGENT_SUITE_PROJECT}/fixture-${index}.md`,
        memory.content,
      );
    } catch (cause) {
      throw new Error(`Task ${definition.taskId} memory ${index} is not a canonical managed memory.`, {cause});
    }
    if (!record) throw new Error(`Task ${definition.taskId} memory ${index} is not parseable.`);
    const seed = EffectOption.getOrUndefined(
      EffectArray.findFirst(definition.memorySeeds, candidate => candidate.topic === record.metadata.topic),
    );
    if (!seed) throw new Error(`Task ${definition.taskId} produced an unexpected memory topic.`);
    if (!codeMemoryLinkAgentPreparedMemoryDestinationMatches(memory.destination, seed.status)) {
      throw new Error(`Task ${definition.taskId} memory ${index} is outside its canonical lifecycle path.`);
    }
    return record;
  });
  unique(
    EffectArray.map(records, record => record.metadata.topic ?? ''),
    `${definition.taskId} memory topics`,
  );
  for (const seed of definition.memorySeeds) {
    const record = EffectOption.getOrUndefined(
      EffectArray.findFirst(records, candidate => candidate.metadata.topic === seed.topic),
    );
    if (!record) throw new Error(`Task ${definition.taskId} omitted memory seed ${seed.topic}.`);
    const metadata = record.metadata;
    if (
      record.headerTitle !== 'MEMORY' ||
      record.body !== seed.text ||
      metadata.kind !== 'durable' ||
      metadata.project !== CODE_MEMORY_LINK_AGENT_SUITE_PROJECT ||
      metadata.schemaVersion !== MEMORY_SCHEMA_VERSION ||
      metadata.sourceAgentClient !== 'code-memory-link-gate' ||
      metadata.status !== seed.status ||
      (metadata.citationErrors?.length ?? 0) !== 0
    ) {
      throw new Error(`Task ${definition.taskId} memory seed ${seed.topic} differs from its exact contract.`);
    }
    const citations = metadata.codeCitations ?? [];
    if (seed.citationPath === null) {
      if (citations.length !== 0 || metadata.sourceCommit !== undefined) {
        throw new Error(`Task ${definition.taskId} uncited seed ${seed.topic} unexpectedly contains code evidence.`);
      }
      continue;
    }
    if (citations.length !== 1) {
      throw new Error(`Task ${definition.taskId} cited seed ${seed.topic} requires exactly one citation.`);
    }
    const graph = seed.foreignRepository ? foreignGraph : localGraph;
    if (!graph) throw new Error(`Task ${definition.taskId} seed ${seed.topic} has no matching prepared graph.`);
    const source = EffectOption.getOrUndefined(
      EffectArray.findFirst(definition.initialFiles, file => file.path === seed.citationPath),
    );
    const citation = citations[0];
    if (
      !source ||
      citation.path !== seed.citationPath ||
      citation.repositoryIdentityKind !== 'remote' ||
      citation.repositoryId !== graph.repositoryId ||
      citation.sourceCommit !== graph.commit ||
      citation.sourceDirty !== false ||
      citation.sourceSnapshotId !== graph.snapshotId ||
      citation.sourceGraphContentId !== graph.graphContentId ||
      citation.extractorSet !== graph.extractorSet ||
      citation.fileContentHash.algorithm !== 'sha256' ||
      citation.fileContentHash.value !==
        codeGraphCommittedFileContentHash(graph.objectFormat, new TextEncoder().encode(source.content)) ||
      citation.target.kind !== 'file' ||
      metadata.sourceCommit !== graph.commit
    ) {
      throw new Error(`Task ${definition.taskId} seed ${seed.topic} citation differs from exact graph provenance.`);
    }
  }
}

export function injectCodeMemoryLinkMalformedLegacyCitationV1(content: string): string {
  if (
    Effect2.pipe(content, EffectString.includes('\ncode_citation:')) ||
    Effect2.pipe(content, EffectString.includes('\r'))
  ) {
    throw new Error('Malformed legacy fixture requires one canonical uncited LF memory.');
  }
  const separator = Effect2.pipe(
    content,
    EffectString.indexOf('\n\n'),
    Effect2.Option.getOrElse(() => -1),
  );
  if (separator < 0) throw new Error('Malformed legacy fixture memory has no header/body separator.');
  return `${Effect2.pipe(content, EffectString.slice(0, separator))}\ncode_citation: {not-canonical-json${Effect2.pipe(content, EffectString.slice(separator))}`;
}

export function assertCodeMemoryLinkMalformedSealedMemoryV1(
  content: string,
  definition: CodeMemoryLinkAgentSuiteTaskDefinitionV1,
): void {
  const record = parseMemoryDocument(
    `threadnote://user/${CODE_MEMORY_LINK_AGENT_SUITE_USER}/memories/durable/projects/${CODE_MEMORY_LINK_AGENT_SUITE_PROJECT}/malformed.md`,
    content,
  );
  const citationErrors = record?.metadata.citationErrors;
  if (
    !record ||
    record.body !== definition.memorySeeds[0].text ||
    record.metadata.project !== CODE_MEMORY_LINK_AGENT_SUITE_PROJECT ||
    record.metadata.topic !== definition.memorySeeds[0].topic ||
    record.metadata.codeCitations !== undefined ||
    citationErrors?.length !== 1 ||
    citationErrors[0]?.index !== 0 ||
    citationErrors[0]?.reason !== 'invalid-json'
  ) {
    throw new Error('Malformed-citation control did not produce one readable fail-closed legacy memory.');
  }
}

function assertHiddenArmDiscrimination(
  definition: CodeMemoryLinkAgentSuiteTaskDefinitionV1,
  goldCitationDigests: readonly string[],
  anchored: ReturnType<typeof parseContextBriefV1>,
  taskOnly: ReturnType<typeof parseContextBriefV1>,
): void {
  if (taskOnly.version !== 2 || anchored.version !== 3) {
    throw new Error(`Hidden task ${definition.taskId} did not preserve the preregistered v2/v3 arm distinction.`);
  }
  const primary = EffectOption.getOrUndefined(
    EffectArray.findFirst(definition.memorySeeds, seed => seed.role === 'primary'),
  )!;
  const taskOnlyGold = EffectArray.filter(taskOnly.durableDecisions, memory => memory.excerpt === primary.text);
  const expectedTaskOnlyGold = definition.retrievalClass === 'lexical' ? 1 : 0;
  if (taskOnlyGold.length !== expectedTaskOnlyGold) {
    throw new Error(
      `Hidden task ${definition.taskId} task-only arm returned ${taskOnlyGold.length} gold memories; expected ${expectedTaskOnlyGold}.`,
    );
  }
  const anchoredGold = EffectArray.filter(anchored.durableDecisions, memory => memory.excerpt === primary.text);
  if (
    anchoredGold.length !== 1 ||
    anchoredGold[0].selectionBasis !== 'code-citation' ||
    !EffectOption.getOrUndefined(
      EffectOption.map(EffectOption.fromNullishOr(anchoredGold[0].codeRelations), __effectArrayReceiver =>
        EffectArray.some(
          __effectArrayReceiver,
          __effectArrayValue =>
            !!(relation =>
              (relation.status === 'exact' || relation.status === 'relocated') &&
              goldCitationDigests.includes(codeMemoryLinkGoldCitationDigest(relation.citationId)))(__effectArrayValue),
        ),
      ),
    )
  ) {
    throw new Error(`Hidden task ${definition.taskId} anchored arm did not return its exact gold memory relation.`);
  }
  assertCodeMemoryLinkCanonicalNoMemoryResponseV1();
}

export function assertCodeMemoryLinkCanonicalNoMemoryResponseV1(
  response: {
    readonly content: readonly {readonly text: string; readonly type: string}[];
    readonly structuredContent: {
      readonly evidenceCount: number;
      readonly state: string;
      readonly type: string;
      readonly version: number;
    };
  } = CODE_MEMORY_LINK_CANONICAL_EMPTY_CONTEXT_BRIEF_V1,
): void {
  const empty = response.structuredContent;
  const content = response.content;
  if (
    empty.type !== 'code-memory-link-context-brief-proxy' ||
    empty.version !== 1 ||
    empty.state !== 'empty' ||
    empty.evidenceCount !== 0 ||
    content.length !== 1 ||
    content[0]?.type !== 'text' ||
    content[0]?.text !== JSON.stringify(empty)
  ) {
    throw new Error('Canonical no-memory arm is not a content-equivalent empty response.');
  }
}

function assertAmbiguousControlPreflight(
  definition: CodeMemoryLinkAgentSuiteTaskDefinitionV1,
  expectedCitationDigests: readonly string[],
  brief: ReturnType<typeof parseContextBriefV1>,
): void {
  const selected = EffectArray.map(definition.memorySeeds, seed =>
    EffectOption.getOrUndefined(EffectArray.findFirst(brief.durableDecisions, memory => memory.excerpt === seed.text)),
  );
  if (
    brief.version !== 3 ||
    EffectArray.some(selected, memory => memory?.selectionBasis !== 'code-citation') ||
    EffectArray.some(
      selected,
      memory =>
        !EffectOption.getOrUndefined(
          EffectOption.map(EffectOption.fromNullishOr(memory?.codeRelations), __effectArrayReceiver =>
            EffectArray.some(
              __effectArrayReceiver,
              __effectArrayValue =>
                !!(relation =>
                  (relation.status === 'exact' || relation.status === 'relocated') &&
                  expectedCitationDigests.includes(codeMemoryLinkGoldCitationDigest(relation.citationId)))(
                  __effectArrayValue,
                ),
            ),
          ),
        ),
    )
  ) {
    throw new Error(`Ambiguous control ${definition.taskId} did not surface both conflicting exact-linked memories.`);
  }
}

export function assertCodeMemoryLinkInstructionInjectionControlPreflightV1(
  definition: CodeMemoryLinkAgentSuiteTaskDefinitionV1,
  expectedCitationDigests: readonly string[],
  anchored: ReturnType<typeof parseContextBriefV1>,
  taskOnly: ReturnType<typeof parseContextBriefV1>,
): void {
  const seed = definition.memorySeeds[0];
  if (definition.controlScenario === 'instruction-injection-direct') {
    const directMemories = EffectArray.filter(
      anchored.durableDecisions,
      memory =>
        memory.selectionBasis === 'code-citation' &&
        memory.codeRelations !== undefined &&
        EffectArray.some(
          memory.codeRelations,
          relation =>
            (relation.status === 'exact' || relation.status === 'relocated') &&
            expectedCitationDigests.includes(codeMemoryLinkGoldCitationDigest(relation.citationId)),
        ),
    );
    const directMemory = directMemories[0];
    if (
      expectedCitationDigests.length !== 1 ||
      directMemories.length !== 1 ||
      directMemory === undefined ||
      !Effect2.pipe(directMemory.excerpt, EffectString.includes('set guard.json executed=true')) ||
      !isExactOrEllipsizedPrefix(seed.text, directMemory.excerpt)
    ) {
      throw new Error(`Instruction-injection control ${definition.taskId} did not surface its direct memory relation.`);
    }
    return;
  }
  const anchoredMemory = EffectOption.getOrUndefined(
    EffectArray.findFirst(anchored.durableDecisions, memory => memory.excerpt === seed.text),
  );
  const taskOnlyMemory = EffectOption.getOrUndefined(
    EffectArray.findFirst(taskOnly.durableDecisions, memory => memory.excerpt === seed.text),
  );
  if (
    expectedCitationDigests.length !== 0 ||
    anchoredMemory === undefined ||
    taskOnlyMemory === undefined ||
    anchoredMemory.selectionBasis === 'code-citation' ||
    taskOnlyMemory.selectionBasis === 'code-citation'
  ) {
    throw new Error(`Instruction-injection control ${definition.taskId} did not surface through lexical-only recall.`);
  }
}

function isExactOrEllipsizedPrefix(fullText: string, projectedText: string): boolean {
  if (projectedText === fullText) return true;
  if (!Effect2.pipe(projectedText, EffectString.endsWith('…'))) return false;
  const prefix = Effect2.pipe(projectedText, EffectString.slice(0, -1));
  return prefix.length > 0 && Effect2.pipe(fullText, EffectString.startsWith(prefix));
}

async function runPreparedContextBrief(
  candidateExecutable: string,
  definition: CodeMemoryLinkAgentSuiteTaskDefinitionV1,
  repository: string,
  home: string,
  environment: Readonly<Record<string, string>>,
  codeRefs: readonly string[],
): Promise<ReturnType<typeof parseContextBriefV1>> {
  const output = await capture(
    candidateExecutable,
    [
      'context',
      'brief',
      '--json',
      '--task',
      definition.prompt,
      '--cwd',
      repository,
      '--home',
      home,
      '--project',
      CODE_MEMORY_LINK_AGENT_SUITE_PROJECT,
      '--mode',
      'brief',
      '--budget-tokens',
      String(Math.min(1_250, definition.budget.tokens)),
      ...EffectArray.flatMap(codeRefs, reference => ['--code-ref', reference]),
    ],
    {cwd: repository, environment, maxOutputBytes: 2 * 1_024 * 1_024, timeoutMilliseconds: 120_000},
  );
  try {
    return parseContextBriefV1(JSON.parse(output.stdout) as unknown);
  } catch (cause) {
    throw new Error(`Task ${definition.taskId} Context Brief preflight was invalid.`, {cause});
  }
}

function contextBriefExactCitationDigests(brief: ReturnType<typeof parseContextBriefV1>): readonly string[] {
  const digests = EffectArray.flatMap([...brief.durableDecisions, ...brief.activeHandoffs], memory =>
    memory.selectionBasis !== 'code-citation'
      ? []
      : EffectArray.flatMap(memory.codeRelations ?? [], relation =>
          relation.status === 'exact' || relation.status === 'relocated'
            ? [codeMemoryLinkGoldCitationDigest(relation.citationId)]
            : [],
        ),
  );
  return [...new Set(digests)].sort(compareStrings);
}

async function writeTaskFiles(
  repository: string,
  files: readonly {readonly content: string; readonly path: string}[],
): Promise<void> {
  for (const file of files) {
    const destination = joinWithin(repository, file.path, 'public fixture path');
    await mkdir(dirname(destination), {recursive: true, mode: 0o700});
    await writeExclusiveText(destination, file.content);
  }
}

async function replaceTaskFiles(
  repository: string,
  initial: readonly {readonly path: string}[],
  final: readonly {readonly content: string; readonly path: string}[],
): Promise<void> {
  const finalPaths = new Set(EffectArray.map(final, file => relativeFile(file.path, 'final public fixture path')));
  for (const file of initial) {
    const path = relativeFile(file.path, 'initial public fixture path');
    if (!finalPaths.has(path)) await unlink(joinWithin(repository, path, 'deleted fixture path'));
  }
  for (const file of final) {
    const destination = joinWithin(repository, file.path, 'final fixture path');
    await mkdir(dirname(destination), {recursive: true, mode: 0o700});
    await writeFile(destination, file.content, {mode: 0o600});
  }
}

async function writePreparedFiles(
  root: string,
  files: ReadonlyMap<string, string>,
  binaryFiles: ReadonlyMap<string, PreparedBinaryFile>,
): Promise<void> {
  const paths = [...files.keys()].sort(compareStrings);
  for (const path of paths) {
    const content = files.get(path)!;
    const destination = joinWithin(root, path, 'prepared output path');
    await mkdir(dirname(destination), {recursive: true, mode: 0o700});
    await writeExclusiveText(destination, content);
  }
  for (const path of [...binaryFiles.keys()].sort(compareStrings)) {
    const file = binaryFiles.get(path)!;
    const destination = joinWithin(root, path, 'prepared binary output path');
    await mkdir(dirname(destination), {recursive: true, mode: 0o700});
    await writeFile(destination, file.bytes, {flag: 'wx', mode: file.mode});
  }
}

async function verifyPreparedTree(
  root: string,
  expected: ReadonlyMap<string, string>,
  expectedBinaries: ReadonlyMap<string, PreparedBinaryFile>,
): Promise<void> {
  const files = await walkRegularFiles(root);
  if (files.length !== expected.size + expectedBinaries.size) {
    throw new Error('Prepared output contains an unexpected file count.');
  }
  for (const file of files) {
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- This separator is not proven nonempty; native split returns [] for an empty receiver with an empty separator while Effect String split returns a nonempty array.
    const relativePath = EffectArray.join(relative(root, file).split(sep), '/');
    const expectedContent = expected.get(relativePath);
    if (expectedContent !== undefined) {
      const observed = await readReviewedTextFile(file, `prepared output ${relativePath}`);
      if (observed !== expectedContent) throw new Error(`Prepared output changed for ${relativePath}.`);
      continue;
    }
    const expectedBinary = expectedBinaries.get(relativePath);
    if (expectedBinary === undefined) throw new Error(`Prepared output contains unexpected file ${relativePath}.`);
    const metadata = await lstat(file);
    if ((metadata.mode & 0o777) !== expectedBinary.mode) {
      throw new Error(`Prepared output mode changed for ${relativePath}.`);
    }
    if (sha256(await readFile(file)) !== sha256(expectedBinary.bytes)) {
      throw new Error(`Prepared output bytes changed for ${relativePath}.`);
    }
  }
}

function isAdapterFileMapping(value: unknown): value is {readonly artifactId: string; readonly source: string} {
  return (
    Predicate.isObject(value) &&
    'artifactId' in value &&
    typeof value.artifactId === 'string' &&
    'source' in value &&
    typeof value.source === 'string'
  );
}

async function verifySealedBindingsOnDisk(root: string, sealed: CodeMemoryLinkSealedAssemblyV1): Promise<void> {
  const suite = parseCodeMemoryLinkSealedSuiteV1(
    JSON.parse(await readFile(join(root, 'suite.json'), 'utf8')) as unknown,
  );
  if (suite.suiteHash !== sealed.suite.suiteHash) throw new Error('On-disk sealed suite hash changed.');
  const fixtureById = new Map(EffectArray.map(sealed.fixture.artifacts, artifact => [artifact.artifactId, artifact]));
  const adapter = sealed.adapter;
  const fixtureFilesValue = adapter.fixtureFiles;
  const judgeValue = adapter.judge;
  if (
    !EffectArray.isArray(fixtureFilesValue) ||
    EffectArray.some(fixtureFilesValue, mapping => !isAdapterFileMapping(mapping)) ||
    !Predicate.isObject(judgeValue) ||
    !('files' in judgeValue) ||
    !EffectArray.isArray(judgeValue.files) ||
    EffectArray.some(judgeValue.files, mapping => !isAdapterFileMapping(mapping))
  ) {
    throw new Error('Adapter file mappings are invalid.');
  }
  const mappings = [
    ...EffectArray.filter(fixtureFilesValue, isAdapterFileMapping),
    ...EffectArray.filter(judgeValue.files, isAdapterFileMapping),
  ];
  for (const mapping of mappings) {
    const expected =
      fixtureById.get(mapping.artifactId) ??
      EffectOption.getOrUndefined(
        EffectArray.findFirst(suite.judge.artifacts, value => value.artifactId === mapping.artifactId),
      );
    if (!expected) throw new Error('Adapter mapping names an artifact outside the sealed suite.');
    if ((await sha256File(joinWithin(root, mapping.source, 'adapter artifact source'))) !== expected.sha256) {
      throw new Error('Adapter artifact bytes differ from their sealed hash.');
    }
  }
  assertCodeMemoryLinkSealedSuiteBindingsV1({
    rubrics: sealed.rubrics,
    suite,
    taskPackets: sealed.taskPackets,
  });
  for (const task of sealed.suite.tasks) {
    await loadCodeMemoryLinkCodexSuiteTask({
      expectedLayoutArtifactId: String(sealed.adapter.layoutArtifactId),
      expectedSuiteHash: sealed.suite.suiteHash,
      root,
      taskId: task.taskId,
    });
  }
}

async function assertCleanSourceCheckout(
  sourceRoot: string,
  expectedCommit: string,
  gitExecutable: string,
  safeExecutablePath: string,
): Promise<void> {
  const environment = gitEnvironment(safeExecutablePath, sourceRoot);
  const head = await capture(gitExecutable, ['rev-parse', 'HEAD'], {
    cwd: sourceRoot,
    environment,
    maxOutputBytes: 64 * 1_024,
    timeoutMilliseconds: 30_000,
  });
  if (Effect2.pipe(head.stdout, EffectString.trim) !== expectedCommit) {
    throw new Error('Preparer checkout is not the exact harness governance commit.');
  }
  const status = await capture(gitExecutable, ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: sourceRoot,
    environment,
    maxOutputBytes: 1 * 1_024 * 1_024,
    timeoutMilliseconds: 30_000,
  });
  if (status.stdout !== '') throw new Error('Preparer requires one clean harness governance checkout.');
}

async function reviewedRuntimeHashes(options: Options): Promise<{
  readonly bun: string;
  readonly codex: string;
  readonly git: string;
}> {
  const [bun, codex, git] = await Promise.all([
    sha256File(options.bunExecutable),
    sha256File(options.codexExecutable),
    sha256File(options.gitExecutable),
  ]);
  return {bun, codex, git};
}

async function assertCodexVersion(options: Options): Promise<void> {
  const result = await capture(options.codexExecutable, ['--version'], {
    cwd: dirname(options.codexExecutable),
    environment: {
      HOME: dirname(options.authSource),
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      PATH: options.safeExecutablePath,
    },
    maxOutputBytes: 64 * 1_024,
    timeoutMilliseconds: 10_000,
  });
  if (Effect2.pipe(result.stdout, EffectString.trim) !== CODE_MEMORY_LINK_CODEX_APP_SERVER_VERSION) {
    throw new Error('Reviewed Codex executable version differs from the pinned app-server version.');
  }
}

async function walkRegularFiles(root: string): Promise<readonly string[]> {
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error('Artifact root must be a non-symlink directory.');
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, {withFileTypes: true});
    entries.sort((left, right) => compareStrings(left.name, right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Prepared artifacts cannot contain symbolic links.');
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const fileMetadata = await lstat(path);
        if (fileMetadata.nlink !== 1) throw new Error('Prepared artifacts cannot contain hard links.');
        output.push(path);
      } else throw new Error('Prepared artifacts must contain only directories and regular files.');
    }
  };
  await visit(root);
  return output.sort(compareStrings);
}

async function readReviewedTextFile(path: string, label: string): Promise<string> {
  const canonical = await reviewedRegularFile(path, label, true);
  const bytes = await readFile(canonical);
  if (bytes.byteLength > MAXIMUM_TEXT_ARTIFACT_BYTES) throw new Error(`${label} exceeds the text artifact limit.`);
  let content: string;
  try {
    content = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    throw new Error(`${label} is not UTF-8 text.`);
  }
  if (Effect2.pipe(content, EffectString.includes('\0'))) throw new Error(`${label} contains a NUL byte.`);
  return content;
}

async function reviewedRegularFile(path: string, label: string, rejectHardLinks: boolean): Promise<string> {
  const normalized = normalizedAbsolute(path, label);
  const metadata = await lstat(normalized);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} must be a non-symlink regular file.`);
  if (rejectHardLinks && metadata.nlink !== 1) throw new Error(`${label} must not be hard-linked.`);
  const canonical = await realpath(normalized);
  if (canonical !== normalized || !(await stat(canonical)).isFile()) throw new Error(`${label} must be canonical.`);
  return canonical;
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const normalized = normalizedAbsolute(path, label);
  const metadata = await lstat(normalized);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error(`${label} must be a non-symlink directory.`);
  const canonical = await realpath(normalized);
  if (canonical !== normalized) throw new Error(`${label} must be canonical.`);
  return canonical;
}

async function assertAbsent(path: string, label: string): Promise<void> {
  try {
    await lstat(path);
  } catch (cause) {
    if (isMissingFileError(cause)) return;
    throw cause;
  }
  throw new Error(`${label} already exists; preparation never overwrites artifacts.`);
}

async function writeExclusiveText(path: string, content: string): Promise<void> {
  assertBoundedUtf8(content, 'generated text file');
  await writeFile(path, content, {flag: 'wx', mode: 0o600});
}

function candidateEnvironment(
  home: string,
  safeExecutablePath: string,
  temporaryRoot: string,
): Readonly<Record<string, string>> {
  return {
    CI: '1',
    HOME: home,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
    NO_UPDATE_NOTIFIER: '1',
    PATH: safeExecutablePath,
    THREADNOTE_ACCOUNT: CODE_MEMORY_LINK_AGENT_SUITE_ACCOUNT,
    THREADNOTE_AGENT_ID: CODE_MEMORY_LINK_AGENT_SUITE_AGENT_ID,
    THREADNOTE_HOME: home,
    THREADNOTE_NO_SPINNER: '1',
    THREADNOTE_NO_UPDATE_CHECK: '1',
    THREADNOTE_USER: CODE_MEMORY_LINK_AGENT_SUITE_USER,
    TMPDIR: temporaryRoot,
  };
}

function gitEnvironment(safeExecutablePath: string, temporaryHome: string): Readonly<Record<string, string>> {
  return {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: temporaryHome,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PATH: safeExecutablePath,
  };
}

function fixedCommitIdentity(): Readonly<Record<string, string>> {
  return {
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_AUTHOR_EMAIL: 'fixture@threadnote.invalid',
    GIT_AUTHOR_NAME: 'Threadnote Fixture',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_EMAIL: 'fixture@threadnote.invalid',
    GIT_COMMITTER_NAME: 'Threadnote Fixture',
  };
}

async function capture(
  executable: string,
  arguments_: readonly string[],
  input: {
    readonly allowFailure?: boolean;
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly maxOutputBytes: number;
    readonly timeoutMilliseconds: number;
  },
): Promise<{readonly exitCode: number; readonly stderr: string; readonly stdout: string}> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [...arguments_], {
      cwd: input.cwd,
      env: {...input.environment},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let exceeded = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, input.timeoutMilliseconds);
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
      const exitCode = code ?? -1;
      const output = {
        exitCode,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'),
      };
      if (timedOut) reject(new Error('Reviewed preparation command timed out.'));
      else if (exceeded) reject(new Error('Reviewed preparation command exceeded its output budget.'));
      else if (exitCode !== 0 && input.allowFailure !== true) {
        reject(
          new Error(`Reviewed preparation command failed: ${Effect2.pipe(output.stderr, EffectString.slice(-2_048))}`),
        );
      } else resolvePromise(output);
    });
  });
}

function parseArguments(arguments_: readonly string[]): Options {
  const values: Record<string, string | undefined> = {};
  const supported = new Set([
    '--assignment-seed',
    '--auth-source',
    '--bun-executable',
    '--candidate-commit',
    '--candidate-executable',
    '--candidate-executable-sha256',
    '--codex-executable',
    '--git-executable',
    '--harness-governance-commit',
    '--model-provider',
    '--output',
    '--reasoning-effort',
    '--safe-executable-path',
    '--schedule-seed',
    '--temporary-root',
    '--turn-timeout-ms',
  ]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!supported.has(argument))
      throw ScriptError.make({message: `Unknown Code Memory Link preparation option: ${argument}`});
    if (values[argument] !== undefined)
      throw ScriptError.make({message: `Duplicate Code Memory Link preparation option: ${argument}`});
    values[argument] = required(arguments_[++index], argument);
  }
  const candidateCommit = matching(
    required(values['--candidate-commit'], '--candidate-commit'),
    COMMIT,
    'candidate commit',
  );
  const assignmentSeed = matching(required(values['--assignment-seed'], '--assignment-seed'), HASH, 'assignment seed');
  const scheduleSeed = matching(required(values['--schedule-seed'], '--schedule-seed'), HASH, 'schedule seed');
  return {
    assignmentSeed,
    authSource: normalizedAbsolute(required(values['--auth-source'], '--auth-source'), 'auth source'),
    bunExecutable: normalizedAbsolute(required(values['--bun-executable'], '--bun-executable'), 'Bun executable'),
    candidateCommit,
    candidateExecutable: normalizedAbsolute(
      required(values['--candidate-executable'], '--candidate-executable'),
      'candidate executable',
    ),
    candidateExecutableSha256: matching(
      required(values['--candidate-executable-sha256'], '--candidate-executable-sha256'),
      HASH,
      'candidate executable hash',
    ),
    codexExecutable: normalizedAbsolute(
      required(values['--codex-executable'], '--codex-executable'),
      'Codex executable',
    ),
    gitExecutable: normalizedAbsolute(required(values['--git-executable'], '--git-executable'), 'Git executable'),
    harnessGovernanceCommit: matching(
      required(values['--harness-governance-commit'], '--harness-governance-commit'),
      COMMIT,
      'harness governance commit',
    ),
    modelProvider: portable(required(values['--model-provider'], '--model-provider'), 'model provider'),
    outputRoot: normalizedAbsolute(required(values['--output'], '--output'), 'output root'),
    reasoningEffort: matching(
      required(values['--reasoning-effort'], '--reasoning-effort'),
      /^(?:low|medium|high|xhigh|max)$/u,
      'reasoning effort',
    ),
    safeExecutablePath: required(values['--safe-executable-path'], '--safe-executable-path'),
    scheduleSeed,
    temporaryRoot: normalizedAbsolute(required(values['--temporary-root'], '--temporary-root'), 'temporary root'),
    turnTimeoutMilliseconds: positiveInteger(
      required(values['--turn-timeout-ms'], '--turn-timeout-ms'),
      '--turn-timeout-ms',
      30 * 60_000,
    ),
  };
}

function assertCandidate(options: Options, candidate: CandidateRuntime): void {
  matching(candidate.executableSha256, HASH, 'candidate executable hash');
  matching(candidate.sourceCommit, COMMIT, 'candidate source commit');
  normalizedAbsolute(candidate.executable, 'candidate executable');
  if (candidate.sourceCommit !== options.candidateCommit)
    throw new Error('Managed candidate commit differs from input.');
}

function validateSafeExecutablePath(value: string): void {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- This separator is not proven nonempty; native split returns [] for an empty receiver with an empty separator while Effect String split returns a nonempty array.
  const entries = value.split(delimiter);
  if (entries.length === 0 || EffectArray.some(entries, entry => !isAbsolute(entry) || resolve(entry) !== entry)) {
    throw new Error('Safe executable PATH must contain only normalized absolute directories.');
  }
  unique(entries, 'safe executable PATH entries');
}

function relativeFile(value: string, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4_096 ||
    Effect2.pipe(value, EffectString.includes('\\')) ||
    Effect2.pipe(value, EffectString.includes('\0')) ||
    isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value === '.' ||
    Effect2.pipe(value, EffectString.endsWith('/')) ||
    EffectArray.some(
      Effect2.pipe(value, EffectString.split('/')),
      segment => segment === '' || segment === '.' || segment === '..',
    )
  ) {
    throw new Error(`${label} must be one normalized relative file path.`);
  }
  return value;
}

function joinWithin(root: string, relativePath: string, label: string): string {
  const normalized = relativeFile(relativePath, label);
  const output = resolve(root, ...Effect2.pipe(normalized, EffectString.split('/')));
  if (output !== root && !Effect2.pipe(output, EffectString.startsWith(`${root}${sep}`)))
    throw new Error(`${label} escaped its root.`);
  return output;
}

function normalizedAbsolute(value: string, label: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || Effect2.pipe(value, EffectString.includes('\0'))) {
    throw new Error(`${label} must be a normalized absolute path.`);
  }
  return value;
}

function assertBoundedUtf8(content: string, label: string): void {
  if (typeof content !== 'string' || Effect2.pipe(content, EffectString.includes('\0')))
    throw new Error(`${label} must be UTF-8 text.`);
  if (new TextEncoder().encode(content).byteLength > MAXIMUM_TEXT_ARTIFACT_BYTES) {
    throw new Error(`${label} exceeds the text artifact limit.`);
  }
}

function addFile(files: Map<string, string>, path: string, content: string): void {
  const normalized = relativeFile(path, 'prepared artifact path');
  assertBoundedUtf8(content, `prepared artifact ${normalized}`);
  if (files.has(normalized)) throw new Error(`Prepared artifact path ${normalized} is duplicated.`);
  files.set(normalized, content);
}

function addBinaryFile(files: Map<string, PreparedBinaryFile>, path: string, bytes: Uint8Array, mode: number): void {
  const normalized = relativeFile(path, 'prepared binary artifact path');
  if (files.has(normalized)) throw new Error(`Prepared binary artifact path ${normalized} is duplicated.`);
  if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1_024 * 1_024) {
    throw new Error(`Prepared binary artifact ${normalized} exceeds its size limit.`);
  }
  if (mode !== 0o500) throw new Error('Prepared runtime binaries require immutable executable mode.');
  files.set(normalized, {bytes: new Uint8Array(bytes), mode});
}

function jsonFile(value: unknown): string {
  return `${JSON.stringify(value, undefined, 2)}\n`;
}

function globalArtifactId(label: string): string {
  return `art_${Effect2.pipe(domainDigest('global-artifact-id', label), EffectString.slice(0, 32))}`;
}

function domainDigest(domain: string, value: unknown): string {
  return sha256(`threadnote-code-memory-link-preparation-v1\0${domain}\0${JSON.stringify(value)}\n`);
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(await reviewedRegularFile(path, 'hashed file', false)));
}

function compareArtifacts(left: CodeMemoryLinkArtifactV1, right: CodeMemoryLinkArtifactV1): number {
  return compareStrings(left.artifactId, right.artifactId);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareTasksById(
  left: CodeMemoryLinkAgentSuiteTaskDefinitionV1,
  right: CodeMemoryLinkAgentSuiteTaskDefinitionV1,
): number {
  return compareStrings(left.taskId, right.taskId);
}

function scenarioFamilyForTask(task: CodeMemoryLinkAgentSuiteTaskDefinitionV1): CodeMemoryLinkAgentAbScenarioFamily {
  if (task.taskKind === 'hidden-constraint') {
    if (task.retrievalClass !== 'anchored-only' && task.retrievalClass !== 'lexical') {
      throw new Error('Hidden task retrieval class cannot define a reviewed scenario family.');
    }
    return `hidden:${task.retrievalClass}`;
  }
  if (task.controlScenario === null) {
    throw new Error('Negative-control task requires a reviewed control scenario family.');
  }
  return `control:${task.controlScenario}`;
}

function parseExpectedAppServerVersion(
  value: string,
): CodeMemoryLinkAgentAbManifestClientV1['expectedClient']['appServerVersion'] {
  if (value !== '0.149.0-alpha.4.1') throw new Error('Unexpected Codex app-server version.');
  return value;
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique.`);
}

function matching(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > maximum ||
    Effect2.pipe(value, EffectString.includes('\0'))
  ) {
    throw new Error(`${label} must be bounded nonempty text.`);
  }
  return value;
}

function matchingHash(value: unknown, label: string): string {
  return matching(value, HASH, label);
}

function portable(value: string, label: string): string {
  return matching(value, /^[a-z][a-z0-9_-]{1,63}$/u, label);
}

function positiveInteger(value: string, label: string, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${label} must be a positive integer no greater than ${maximum}.`);
  }
  return parsed;
}

function required(value: string | undefined, option: string): string {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native optional chaining preserves the non-undefined return type after validation.
  if (!value?.trim()) throw ScriptError.make({message: `${option} requires a value.`});
  return value;
}

function isMissingFileError(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT';
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));
