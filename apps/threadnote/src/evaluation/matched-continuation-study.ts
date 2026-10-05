import {sha256HexSync} from '@threadnote/platform/sha256';

export const MATCHED_CONTINUATION_STUDY_VERSION = 1 as const;
export const MATCHED_CONTINUATION_VARIANTS = [
  'files-bare',
  'manual-handoff',
  'threadnote-graph',
  'threadnote-resume',
  'threadnote-preloaded-resume',
] as const;
export const MATCHED_CONTEXT_CONTINUATION_VARIANTS = [
  'files-bare',
  'manual-handoff',
  'threadnote-preloaded-resume',
] as const;
export const AUTOMATED_CONTEXT_CONTINUATION_VARIANTS = ['files-bare', 'threadnote-preloaded-resume'] as const;

export type MatchedContinuationVariant = (typeof MATCHED_CONTINUATION_VARIANTS)[number];

export interface MatchedContinuationStudyTaskV1 {
  readonly checkpointRepositoryFixtureHash: string;
  readonly checkpointRevision: string;
  readonly clusterId: string;
  readonly planSha256: string;
  readonly repositoryUrl: string;
  readonly sourceRepositoryFixtureHash: string;
  readonly sourceRevision: string;
  readonly taskId: string;
}

export interface MatchedContinuationStudyScheduleEntryV1 {
  readonly globalRunOrder: number;
  readonly runNonce: string;
  readonly taskId: string;
  readonly variant: MatchedContinuationVariant;
  readonly withinTaskRunOrder: number;
}

export interface MatchedContinuationStudyV1 {
  readonly bootstrap: {
    readonly confidenceLevelBasisPoints: 9500;
    readonly iterations: number;
    readonly seed: string;
  };
  readonly candidate: {
    readonly adapterArtifactSha256: string;
    readonly sourceCommit: string;
    readonly toolArtifactHash: string;
    readonly toolVersion: string;
  };
  readonly gates: {
    readonly completionNonInferiorityBasisPoints: number;
    readonly maximumAuthorizationLeaks: number;
    readonly maximumFalseCurrentOutcomes: number;
    readonly maximumHarmfulActions: number;
    readonly minimumClusters: number;
    readonly minimumCorrectnessScoreMilli: number;
    readonly minimumTokenReductionBasisPoints: number;
  };
  readonly schedule: readonly MatchedContinuationStudyScheduleEntryV1[];
  readonly sourceEvidence: {
    readonly corpusHash: string;
    readonly exposureAuditSha256: string;
    readonly manifestHash: string;
    readonly matchedPreparationReceiptSha256: string;
    readonly matchedStudyHash: string;
    readonly verificationPlanHash: string;
  };
  readonly studyHash: string;
  readonly studyId: string;
  readonly tasks: readonly MatchedContinuationStudyTaskV1[];
  readonly variants: readonly MatchedContinuationVariant[];
  readonly workflowAccounting: 'phase-one-plus-phase-two-per-attempt';
  readonly version: typeof MATCHED_CONTINUATION_STUDY_VERSION;
}

export interface MatchedContinuationStudyRuntimeV1 {
  readonly corpusPath: string;
  readonly exposureAuditPath: string;
  readonly exposureAuditSha256: string;
  readonly manifestPath: string;
  /** Local-only path mapping. It is not part of the sealed, publishable study. */
  readonly matchedPreparationReceiptPath: string;
  readonly matchedRuntimePath: string;
  readonly matchedStudyPath: string;
  readonly studyHash: string;
  readonly tasks: readonly {
    readonly pilotDirectory: string;
    readonly planSha256: string;
    readonly planPath: string;
    readonly taskId: string;
  }[];
  readonly version: typeof MATCHED_CONTINUATION_STUDY_VERSION;
}

const HASH = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const TASK_ID = /^tsk_[0-9a-f]{16,64}$/u;
const CLUSTER_ID = /^cluster_[0-9a-f]{16,64}$/u;
const RUN_NONCE = /^run_[0-9a-f]{32}$/u;
const STUDY_ID = /^[a-z][a-z0-9-]{2,63}$/u;

export function createMatchedContinuationStudyV1(
  input: Omit<MatchedContinuationStudyV1, 'studyHash' | 'version'>,
): MatchedContinuationStudyV1 {
  const canonical = canonicalStudy(input);
  return parseMatchedContinuationStudyV1({
    ...canonical,
    studyHash: matchedContinuationStudyHashV1(canonical),
    version: MATCHED_CONTINUATION_STUDY_VERSION,
  });
}

export function parseMatchedContinuationStudyV1(value: unknown): MatchedContinuationStudyV1 {
  const study = object(value, 'continuation study');
  exactKeys(
    study,
    [
      'bootstrap',
      'candidate',
      'gates',
      'schedule',
      'sourceEvidence',
      'studyHash',
      'studyId',
      'tasks',
      'variants',
      'version',
      'workflowAccounting',
    ],
    'continuation study',
  );
  if (study.version !== MATCHED_CONTINUATION_STUDY_VERSION) invalid('continuation study version must be 1');
  const withoutHash = parseStudyWithoutHash(study);
  const studyHash = matchingString(study.studyHash, HASH, 'continuation study hash');
  if (studyHash !== matchedContinuationStudyHashV1(withoutHash)) {
    invalid('continuation study hash does not match its contents');
  }
  return {...withoutHash, studyHash, version: MATCHED_CONTINUATION_STUDY_VERSION};
}

export function matchedContinuationStudyHashV1(
  input: Omit<MatchedContinuationStudyV1, 'studyHash' | 'version'>,
): string {
  return sha256HexSync(JSON.stringify(['matched-continuation-study-v1', canonicalStudy(input)]));
}

export function parseMatchedContinuationStudyRuntimeV1(value: unknown): MatchedContinuationStudyRuntimeV1 {
  const runtime = object(value, 'continuation study runtime');
  exactKeys(
    runtime,
    [
      'corpusPath',
      'exposureAuditPath',
      'exposureAuditSha256',
      'manifestPath',
      'matchedPreparationReceiptPath',
      'matchedRuntimePath',
      'matchedStudyPath',
      'studyHash',
      'tasks',
      'version',
    ],
    'continuation study runtime',
  );
  if (runtime.version !== MATCHED_CONTINUATION_STUDY_VERSION) invalid('continuation runtime version must be 1');
  const tasks = array(runtime.tasks, 'continuation runtime tasks').map((entry, index) => {
    const task = object(entry, `continuation runtime task ${index}`);
    exactKeys(task, ['pilotDirectory', 'planPath', 'planSha256', 'taskId'], `continuation runtime task ${index}`);
    return {
      pilotDirectory: absolutePath(task.pilotDirectory, `continuation runtime task ${index} pilot directory`),
      planPath: absolutePath(task.planPath, `continuation runtime task ${index} plan path`),
      planSha256: matchingString(task.planSha256, HASH, `continuation runtime task ${index} plan hash`),
      taskId: matchingString(task.taskId, TASK_ID, `continuation runtime task ${index} id`),
    };
  });
  unique(
    tasks.map(task => task.taskId),
    'continuation runtime task ids',
  );
  unique(
    tasks.map(task => task.planPath),
    'continuation runtime plan paths',
  );
  unique(
    tasks.map(task => task.pilotDirectory),
    'continuation runtime pilot directories',
  );
  return {
    corpusPath: absolutePath(runtime.corpusPath, 'continuation runtime corpus path'),
    exposureAuditPath: absolutePath(runtime.exposureAuditPath, 'continuation runtime exposure audit path'),
    exposureAuditSha256: matchingString(runtime.exposureAuditSha256, HASH, 'continuation runtime exposure audit hash'),
    manifestPath: absolutePath(runtime.manifestPath, 'continuation runtime manifest path'),
    matchedPreparationReceiptPath: absolutePath(
      runtime.matchedPreparationReceiptPath,
      'continuation runtime matched preparation receipt path',
    ),
    matchedRuntimePath: absolutePath(runtime.matchedRuntimePath, 'continuation runtime matched runtime path'),
    matchedStudyPath: absolutePath(runtime.matchedStudyPath, 'continuation runtime matched study path'),
    studyHash: matchingString(runtime.studyHash, HASH, 'continuation runtime study hash'),
    tasks,
    version: MATCHED_CONTINUATION_STUDY_VERSION,
  };
}

export function assertMatchedContinuationRuntimeMatchesStudyV1(
  studyInput: MatchedContinuationStudyV1 | unknown,
  runtimeInput: MatchedContinuationStudyRuntimeV1 | unknown,
): void {
  const study = parseMatchedContinuationStudyV1(studyInput);
  const runtime = parseMatchedContinuationStudyRuntimeV1(runtimeInput);
  if (runtime.studyHash !== study.studyHash) invalid('continuation runtime refers to a different study');
  if (runtime.exposureAuditSha256 !== study.sourceEvidence.exposureAuditSha256) {
    invalid('continuation runtime exposure audit hash differs from the study');
  }
  const expected = study.tasks.map(task => task.taskId).sort();
  const actual = runtime.tasks.map(task => task.taskId).sort();
  if (expected.length !== actual.length || expected.some((taskId, index) => taskId !== actual[index])) {
    invalid('continuation runtime tasks do not exactly cover the study');
  }
  for (const task of study.tasks) {
    const runtimeTask = runtime.tasks.find(candidate => candidate.taskId === task.taskId);
    if (runtimeTask?.planSha256 !== task.planSha256) {
      invalid(`continuation runtime plan hash differs for task ${task.taskId}`);
    }
  }
}

function parseStudyWithoutHash(
  study: Record<string, unknown>,
): Omit<MatchedContinuationStudyV1, 'studyHash' | 'version'> {
  const bootstrap = object(study.bootstrap, 'continuation study bootstrap');
  exactKeys(bootstrap, ['confidenceLevelBasisPoints', 'iterations', 'seed'], 'continuation study bootstrap');
  if (bootstrap.confidenceLevelBasisPoints !== 9_500) invalid('continuation bootstrap confidence must be 95%');
  const candidate = object(study.candidate, 'continuation study candidate');
  exactKeys(
    candidate,
    ['adapterArtifactSha256', 'sourceCommit', 'toolArtifactHash', 'toolVersion'],
    'continuation study candidate',
  );
  const gates = object(study.gates, 'continuation study gates');
  exactKeys(
    gates,
    [
      'completionNonInferiorityBasisPoints',
      'maximumAuthorizationLeaks',
      'maximumFalseCurrentOutcomes',
      'maximumHarmfulActions',
      'minimumClusters',
      'minimumCorrectnessScoreMilli',
      'minimumTokenReductionBasisPoints',
    ],
    'continuation study gates',
  );
  const sourceEvidence = object(study.sourceEvidence, 'continuation study source evidence');
  exactKeys(
    sourceEvidence,
    [
      'corpusHash',
      'exposureAuditSha256',
      'manifestHash',
      'matchedPreparationReceiptSha256',
      'matchedStudyHash',
      'verificationPlanHash',
    ],
    'continuation study source evidence',
  );
  const variants = canonicalVariantSet(array(study.variants, 'continuation study variants'));
  const tasks = array(study.tasks, 'continuation study tasks')
    .map(parseTask)
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
  unique(
    tasks.map(task => task.taskId),
    'continuation study task ids',
  );
  unique(
    tasks.map(task => task.clusterId),
    'continuation study cluster ids',
  );
  unique(
    tasks.map(task => task.repositoryUrl),
    'continuation study repository URLs',
  );
  unique(
    tasks.map(task => task.planSha256),
    'continuation study plan hashes',
  );
  const parsedGates = {
    completionNonInferiorityBasisPoints: integer(
      gates.completionNonInferiorityBasisPoints,
      0,
      5_000,
      'continuation completion non-inferiority margin',
    ),
    maximumAuthorizationLeaks: integer(
      gates.maximumAuthorizationLeaks,
      0,
      1_000,
      'continuation maximum authorization leaks',
    ),
    maximumFalseCurrentOutcomes: integer(
      gates.maximumFalseCurrentOutcomes,
      0,
      1_000,
      'continuation maximum false-current outcomes',
    ),
    maximumHarmfulActions: integer(gates.maximumHarmfulActions, 0, 1_000, 'continuation maximum harmful actions'),
    minimumClusters: integer(gates.minimumClusters, 5, 64, 'continuation minimum clusters'),
    minimumCorrectnessScoreMilli: integer(
      gates.minimumCorrectnessScoreMilli,
      0,
      1_000,
      'continuation minimum correctness score',
    ),
    minimumTokenReductionBasisPoints: integer(
      gates.minimumTokenReductionBasisPoints,
      0,
      9_999,
      'continuation minimum token reduction',
    ),
  };
  if (tasks.length === 0) invalid('continuation study must contain at least one task');
  const schedule = array(study.schedule, 'continuation study schedule')
    .map(parseScheduleEntry)
    .sort((left, right) => left.globalRunOrder - right.globalRunOrder);
  validateSchedule(tasks, schedule, variants);
  if (study.workflowAccounting !== 'phase-one-plus-phase-two-per-attempt') {
    invalid('continuation study workflow accounting is invalid');
  }
  return {
    bootstrap: {
      confidenceLevelBasisPoints: 9_500,
      iterations: integer(bootstrap.iterations, 200, 100_000, 'continuation bootstrap iterations'),
      seed: matchingString(bootstrap.seed, HASH, 'continuation bootstrap seed'),
    },
    candidate: {
      adapterArtifactSha256: matchingString(
        candidate.adapterArtifactSha256,
        HASH,
        'continuation candidate adapter hash',
      ),
      sourceCommit: matchingString(candidate.sourceCommit, COMMIT, 'continuation candidate source commit'),
      toolArtifactHash: matchingString(candidate.toolArtifactHash, HASH, 'continuation candidate tool hash'),
      toolVersion: boundedString(candidate.toolVersion, 1, 128, 'continuation candidate tool version'),
    },
    gates: parsedGates,
    schedule,
    sourceEvidence: {
      corpusHash: matchingString(sourceEvidence.corpusHash, HASH, 'continuation corpus hash'),
      exposureAuditSha256: matchingString(sourceEvidence.exposureAuditSha256, HASH, 'continuation exposure audit hash'),
      manifestHash: matchingString(sourceEvidence.manifestHash, HASH, 'continuation manifest hash'),
      matchedPreparationReceiptSha256: matchingString(
        sourceEvidence.matchedPreparationReceiptSha256,
        HASH,
        'continuation matched preparation receipt hash',
      ),
      matchedStudyHash: matchingString(sourceEvidence.matchedStudyHash, HASH, 'continuation matched study hash'),
      verificationPlanHash: matchingString(
        sourceEvidence.verificationPlanHash,
        HASH,
        'continuation verification plan hash',
      ),
    },
    studyId: matchingString(study.studyId, STUDY_ID, 'continuation study id'),
    tasks,
    variants,
    workflowAccounting: 'phase-one-plus-phase-two-per-attempt',
  };
}

function parseTask(value: unknown, index: number): MatchedContinuationStudyTaskV1 {
  const task = object(value, `continuation study task ${index}`);
  exactKeys(
    task,
    [
      'checkpointRepositoryFixtureHash',
      'checkpointRevision',
      'clusterId',
      'planSha256',
      'repositoryUrl',
      'sourceRepositoryFixtureHash',
      'sourceRevision',
      'taskId',
    ],
    `continuation study task ${index}`,
  );
  const repositoryUrl = boundedString(task.repositoryUrl, 8, 2_048, `continuation study task ${index} repository URL`);
  let url: URL;
  try {
    url = new URL(repositoryUrl);
  } catch {
    invalid(`continuation study task ${index} repository URL is invalid`);
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    invalid(`continuation study task ${index} repository URL must be public HTTPS without credentials or parameters`);
  }
  const sourceRevision = matchingString(
    task.sourceRevision,
    COMMIT,
    `continuation study task ${index} source revision`,
  );
  const checkpointRevision = matchingString(
    task.checkpointRevision,
    COMMIT,
    `continuation study task ${index} checkpoint revision`,
  );
  if (sourceRevision === checkpointRevision) invalid(`continuation study task ${index} checkpoint must advance source`);
  const sourceRepositoryFixtureHash = matchingString(
    task.sourceRepositoryFixtureHash,
    HASH,
    `continuation study task ${index} source fixture hash`,
  );
  const checkpointRepositoryFixtureHash = matchingString(
    task.checkpointRepositoryFixtureHash,
    HASH,
    `continuation study task ${index} checkpoint fixture hash`,
  );
  if (sourceRepositoryFixtureHash === checkpointRepositoryFixtureHash) {
    invalid(`continuation study task ${index} checkpoint fixture must differ from source`);
  }
  return {
    checkpointRepositoryFixtureHash,
    checkpointRevision,
    clusterId: matchingString(task.clusterId, CLUSTER_ID, `continuation study task ${index} cluster id`),
    planSha256: matchingString(task.planSha256, HASH, `continuation study task ${index} plan hash`),
    repositoryUrl,
    sourceRepositoryFixtureHash,
    sourceRevision,
    taskId: matchingString(task.taskId, TASK_ID, `continuation study task ${index} id`),
  };
}

function parseScheduleEntry(value: unknown, index: number): MatchedContinuationStudyScheduleEntryV1 {
  const entry = object(value, `continuation study schedule entry ${index}`);
  exactKeys(
    entry,
    ['globalRunOrder', 'runNonce', 'taskId', 'variant', 'withinTaskRunOrder'],
    `continuation study schedule entry ${index}`,
  );
  return {
    globalRunOrder: integer(entry.globalRunOrder, 1, 320, `continuation schedule entry ${index} global order`),
    runNonce: matchingString(entry.runNonce, RUN_NONCE, `continuation schedule entry ${index} nonce`),
    taskId: matchingString(entry.taskId, TASK_ID, `continuation schedule entry ${index} task id`),
    variant: literal(entry.variant, MATCHED_CONTINUATION_VARIANTS, `continuation schedule entry ${index} variant`),
    withinTaskRunOrder: integer(entry.withinTaskRunOrder, 1, 5, `continuation schedule entry ${index} task order`),
  };
}

function validateSchedule(
  tasks: readonly MatchedContinuationStudyTaskV1[],
  schedule: readonly MatchedContinuationStudyScheduleEntryV1[],
  variants: readonly MatchedContinuationVariant[],
): void {
  if (schedule.length !== tasks.length * variants.length) {
    invalid('continuation schedule does not contain one attempt per task and variant');
  }
  unique(
    schedule.map(entry => String(entry.globalRunOrder)),
    'continuation schedule global orders',
  );
  unique(
    schedule.map(entry => entry.runNonce),
    'continuation schedule nonces',
  );
  if (schedule.some((entry, index) => entry.globalRunOrder !== index + 1)) {
    invalid('continuation schedule global orders must be contiguous');
  }
  for (const task of tasks) {
    const entries = schedule.filter(entry => entry.taskId === task.taskId);
    if (
      entries.length !== variants.length ||
      !sameStrings(entries.map(entry => entry.variant).sort(), [...variants].sort()) ||
      !sameNumbers(
        entries.map(entry => entry.withinTaskRunOrder).sort((left, right) => left - right),
        variants.map((_, index) => index + 1),
      )
    ) {
      invalid(`continuation schedule is incomplete for task ${task.taskId}`);
    }
  }
  if (schedule.some(entry => !tasks.some(task => task.taskId === entry.taskId))) {
    invalid('continuation schedule refers to an unknown task');
  }
}

function canonicalStudy(
  input: Omit<MatchedContinuationStudyV1, 'studyHash' | 'version'>,
): Omit<MatchedContinuationStudyV1, 'studyHash' | 'version'> {
  return {
    ...input,
    schedule: [...input.schedule].sort((left, right) => left.globalRunOrder - right.globalRunOrder),
    tasks: [...input.tasks].sort((left, right) => left.taskId.localeCompare(right.taskId)),
    variants: canonicalVariantSet(input.variants),
  };
}

function canonicalVariantSet(values: readonly unknown[]): readonly MatchedContinuationVariant[] {
  const variants = values.map((variant, index) =>
    literal(variant, MATCHED_CONTINUATION_VARIANTS, `continuation study variant ${index}`),
  );
  unique(variants, 'continuation study variants');
  for (const supported of [
    AUTOMATED_CONTEXT_CONTINUATION_VARIANTS,
    MATCHED_CONTEXT_CONTINUATION_VARIANTS,
    MATCHED_CONTINUATION_VARIANTS,
  ] as const) {
    if (sameStrings([...variants].sort(), [...supported].sort())) return supported;
  }
  invalid('continuation study variants must be a complete supported treatment set');
}

function absolutePath(value: unknown, label: string): string {
  const path = boundedString(value, 1, 4_096, label);
  if (!path.startsWith('/')) invalid(`${label} must be absolute`);
  return path;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalid(`${label} has unsupported or missing fields`);
  }
}

function boundedString(value: unknown, minimum: number, maximum: number, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length < minimum ||
    value.length > maximum ||
    value.includes('\0') ||
    value !== value.trim()
  ) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function matchingString(value: unknown, pattern: RegExp, label: string): string {
  const text = boundedString(value, 1, 4_096, label);
  if (!pattern.test(text)) invalid(`${label} is invalid`);
  return text;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid(`${label} is invalid`);
  }
  return value as number;
}

function literal<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) invalid(`${label} is invalid`);
  return value;
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label} must be unique`);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function invalid(message: string): never {
  throw new Error(`Invalid matched continuation study: ${message}.`);
}
