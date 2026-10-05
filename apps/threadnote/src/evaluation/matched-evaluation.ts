import {sha256HexSync} from '@threadnote/platform/sha256';

export const MATCHED_EVALUATION_VERSION = 1 as const;
export const MATCHED_EVALUATION_ADAPTER_PROTOCOL = 'matched-evaluation-adapter-v5' as const;
export const MATCHED_EVALUATION_SCHEDULE_ALGORITHM = 'sha256-counterbalanced-v3' as const;
export const MATCHED_EVALUATION_LEGACY_SCHEDULE_ALGORITHM = 'sha256-counterbalanced-v2' as const;
export const MATCHED_EVALUATION_ARMS = [
  'files',
  'threadnote-graph',
  'threadnote-compact',
  'threadnote-source',
  'reference-scope',
] as const;
export const MATCHED_EVALUATION_BLIND_LABELS = ['A', 'B', 'C', 'D', 'E'] as const;
export const MATCHED_EVALUATION_TASK_CATEGORIES = [
  'unfamiliar-call-path',
  'hidden-architectural-constraint',
  'stale-citation-refactor',
  'same-repository-onboarding',
  'cross-repository-transfer',
] as const;
export const MATCHED_EVALUATION_TASK_VARIANTS = [
  'exact-name',
  'paraphrase',
  'absent-answer',
  'conflicting-records',
  'dirty-worktree',
  'historical-as-issued',
] as const;
export const MATCHED_EVALUATION_MINIMUM_REPETITIONS = 5 as const;

export type MatchedEvaluationArm = (typeof MATCHED_EVALUATION_ARMS)[number];
export type MatchedEvaluationBlindLabel = (typeof MATCHED_EVALUATION_BLIND_LABELS)[number];
export type MatchedEvaluationTaskCategory = (typeof MATCHED_EVALUATION_TASK_CATEGORIES)[number];
export type MatchedEvaluationTaskVariant = (typeof MATCHED_EVALUATION_TASK_VARIANTS)[number];

export interface MatchedEvaluationSourceGoldV1 {
  readonly claim: string;
  readonly endLine: number;
  readonly evidenceId: string;
  readonly path: string;
  readonly repository: string;
  readonly startLine: number;
}

export interface MatchedEvaluationMemoryFixtureV1 {
  readonly memoryId: string;
  readonly repository: string;
  readonly source: {
    readonly endLine: number;
    readonly path: string;
    readonly startLine: number;
  } | null;
  readonly status: 'active' | 'archived' | 'superseded';
  readonly text: string;
}

export interface MatchedEvaluationNegativeControlV1 {
  readonly controlId: string;
  readonly reason: string;
  readonly text: string;
}

export interface MatchedEvaluationRubricV1 {
  readonly completion: string;
  readonly criteria: readonly string[];
  readonly requiredEvidenceIds: readonly string[];
}

export interface MatchedEvaluationCorpusTaskV1 {
  readonly category: MatchedEvaluationTaskCategory;
  readonly memoryFixtures: readonly MatchedEvaluationMemoryFixtureV1[];
  readonly negativeControls: readonly MatchedEvaluationNegativeControlV1[];
  readonly pairId: string | null;
  readonly prompt: string;
  readonly repositoryFixtureHash: string;
  readonly rubric: MatchedEvaluationRubricV1;
  readonly sourceGold: readonly MatchedEvaluationSourceGoldV1[];
  readonly taskId: string;
  readonly variant: MatchedEvaluationTaskVariant;
}

export interface MatchedEvaluationCorpusV1 {
  readonly corpusId: string;
  readonly tasks: readonly MatchedEvaluationCorpusTaskV1[];
  readonly version: typeof MATCHED_EVALUATION_VERSION;
}

export interface MatchedEvaluationArmDefinitionV1 {
  readonly adapterArtifactHash: string;
  readonly adapterConfigurationHash: string;
  readonly adapterProtocol: typeof MATCHED_EVALUATION_ADAPTER_PROTOCOL;
  readonly arm: MatchedEvaluationArm;
  readonly environmentPolicyHash: string;
  readonly tool: {
    readonly artifactHash: string | null;
    readonly lockIdentityHash: string | null;
    readonly name: string;
    readonly version: string;
  };
}

export interface MatchedEvaluationManifestTaskV1 {
  readonly category: MatchedEvaluationTaskCategory;
  readonly memoryFixtureHash: string;
  readonly negativeControlHash: string;
  readonly pairId: string | null;
  readonly promptHash: string;
  readonly repositoryFixtureHash: string;
  readonly rubricHash: string;
  readonly sourceGoldHash: string;
  readonly taskId: string;
  readonly taskIdentityHash: string;
  readonly variant: MatchedEvaluationTaskVariant;
}

export interface MatchedEvaluationScheduleEntryV1 {
  readonly blindLabel: MatchedEvaluationBlindLabel;
  readonly position: 1 | 2 | 3 | 4 | 5;
  readonly repetition: number;
  readonly runNonce: string;
  readonly runOrder: number;
  readonly taskId: string;
}

export interface MatchedEvaluationManifestV1 {
  /** Canonical selected subset. Omitted by legacy manifests, which means all five arms. */
  readonly activeArms?: readonly MatchedEvaluationArm[];
  readonly arms: readonly MatchedEvaluationArmDefinitionV1[];
  readonly blindAssignment: Readonly<Record<MatchedEvaluationBlindLabel, MatchedEvaluationArm>>;
  readonly corpusHash: string;
  readonly manifestHash: string;
  readonly model: {
    readonly model: string;
    readonly parametersHash: string;
    readonly provider: string;
  };
  readonly repetitions: number;
  readonly repository: {
    readonly dirty: boolean;
    readonly fixtureHash: string;
    readonly identityHash: string;
    readonly revision: string;
  };
  readonly schedule: readonly MatchedEvaluationScheduleEntryV1[];
  readonly scheduleAlgorithm:
    typeof MATCHED_EVALUATION_SCHEDULE_ALGORITHM | typeof MATCHED_EVALUATION_LEGACY_SCHEDULE_ALGORITHM;
  readonly scheduleSeed: string;
  readonly tasks: readonly MatchedEvaluationManifestTaskV1[];
  readonly version: typeof MATCHED_EVALUATION_VERSION;
}

const HASH = /^[0-9a-f]{64}$/u;
const TASK_ID = /^tsk_[0-9a-f]{16,64}$/u;
const PAIR_ID = /^pair_[0-9a-f]{16,64}$/u;
const EVIDENCE_ID = /^ev_[0-9a-f]{16,64}$/u;
const MEMORY_ID = /^mem_[0-9a-f]{16,64}$/u;
const CONTROL_ID = /^ctl_[0-9a-f]{16,64}$/u;
const RUN_NONCE = /^run_[0-9a-f]{32}$/u;
const CORPUS_ID = /^[a-z][a-z0-9-]{2,63}$/u;
const REPOSITORY_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/u;
const REVISION = /^[a-zA-Z0-9][a-zA-Z0-9._/+:-]{0,127}$/u;

export function matchedEvaluationReferenceEnvironmentPolicyV1(): Readonly<Record<string, string>> {
  return {DO_NOT_TRACK: '1', HOME: 'isolated-per-trial'};
}

export function matchedEvaluationReferenceEnvironmentPolicyHashV1(): string {
  return digest('matched-evaluation-environment-policy-v1', matchedEvaluationReferenceEnvironmentPolicyV1());
}

export function matchedEvaluationPromptHashV1(prompt: string): string {
  return digest('matched-evaluation-prompt-v1', prompt);
}

export function parseMatchedEvaluationCorpusV1(value: unknown): MatchedEvaluationCorpusV1 {
  const corpus = object(value, 'corpus');
  exactKeys(corpus, ['corpusId', 'tasks', 'version'], 'corpus');
  if (corpus.version !== MATCHED_EVALUATION_VERSION) invalid('corpus version must be 1');
  const tasks = array(corpus.tasks, 'corpus tasks').map((task, index) => parseCorpusTask(task, index));
  if (tasks.length < 5 || tasks.length > 64) invalid('corpus must contain between 5 and 64 tasks');
  unique(
    tasks.map(task => task.taskId),
    'corpus task ids',
  );
  for (const category of MATCHED_EVALUATION_TASK_CATEGORIES) {
    if (!tasks.some(task => task.category === category)) invalid(`corpus does not cover ${category}`);
  }
  assertVariantDesign(tasks);
  return {
    corpusId: matchingString(corpus.corpusId, CORPUS_ID, 'corpus id'),
    tasks: [...tasks].sort((left, right) => left.taskId.localeCompare(right.taskId)),
    version: MATCHED_EVALUATION_VERSION,
  };
}

export function matchedEvaluationCorpusHashV1(value: MatchedEvaluationCorpusV1 | unknown): string {
  return digest('matched-evaluation-corpus-v1', parseMatchedEvaluationCorpusV1(value));
}

export function createMatchedEvaluationManifestV1(input: {
  readonly activeArms?: readonly MatchedEvaluationArm[];
  readonly arms: readonly MatchedEvaluationArmDefinitionV1[];
  readonly corpus: MatchedEvaluationCorpusV1 | unknown;
  readonly model: MatchedEvaluationManifestV1['model'];
  readonly repetitions: number;
  readonly repository: MatchedEvaluationManifestV1['repository'];
  readonly scheduleSeed: string;
}): MatchedEvaluationManifestV1 {
  const corpus = parseMatchedEvaluationCorpusV1(input.corpus);
  const arms = parseArmDefinitions(input.arms);
  const repetitions = repetitionsValue(input.repetitions);
  const scheduleSeed = matchingString(input.scheduleSeed, HASH, 'schedule seed');
  const tasks = corpus.tasks.map(projectManifestTask);
  const activeArms = canonicalActiveArms(input.activeArms);
  const blindAssignment = deriveMatchedEvaluationBlindAssignmentV1(scheduleSeed);
  const schedule = deriveMatchedEvaluationScheduleV1({activeArms, blindAssignment, repetitions, scheduleSeed, tasks});
  const withoutHash = {
    activeArms,
    arms,
    blindAssignment,
    corpusHash: matchedEvaluationCorpusHashV1(corpus),
    model: parseModel(input.model),
    repetitions,
    repository: parseRepository(input.repository),
    schedule,
    scheduleAlgorithm: MATCHED_EVALUATION_SCHEDULE_ALGORITHM,
    scheduleSeed,
    tasks,
    version: MATCHED_EVALUATION_VERSION,
  };
  return {...withoutHash, manifestHash: matchedEvaluationManifestHashV1(withoutHash)};
}

export function parseMatchedEvaluationManifestV1(value: unknown): MatchedEvaluationManifestV1 {
  const manifest = object(value, 'manifest');
  exactKeys(
    manifest,
    [
      ...(manifest.activeArms === undefined ? [] : ['activeArms']),
      'arms',
      'blindAssignment',
      'corpusHash',
      'manifestHash',
      'model',
      'repetitions',
      'repository',
      'schedule',
      'scheduleAlgorithm',
      'scheduleSeed',
      'tasks',
      'version',
    ],
    'manifest',
  );
  if (manifest.version !== MATCHED_EVALUATION_VERSION) invalid('manifest version must be 1');
  if (
    manifest.scheduleAlgorithm !== MATCHED_EVALUATION_SCHEDULE_ALGORITHM &&
    manifest.scheduleAlgorithm !== MATCHED_EVALUATION_LEGACY_SCHEDULE_ALGORITHM
  ) {
    invalid('manifest schedule algorithm is unsupported');
  }
  const arms = parseArmDefinitions(array(manifest.arms, 'manifest arms'));
  const activeArms = manifest.activeArms === undefined ? undefined : canonicalActiveArms(manifest.activeArms);
  if (manifest.scheduleAlgorithm === MATCHED_EVALUATION_SCHEDULE_ALGORITHM && activeArms === undefined) {
    invalid('v3 schedule must declare active arms');
  }
  if (
    manifest.scheduleAlgorithm === MATCHED_EVALUATION_LEGACY_SCHEDULE_ALGORITHM &&
    manifest.activeArms !== undefined
  ) {
    invalid('legacy schedule algorithm cannot declare active arms');
  }
  const repetitions = repetitionsValue(manifest.repetitions);
  const scheduleSeed = matchingString(manifest.scheduleSeed, HASH, 'manifest schedule seed');
  const tasks = array(manifest.tasks, 'manifest tasks').map((task, index) => parseManifestTask(task, index));
  if (tasks.length < 5 || tasks.length > 64) invalid('manifest must contain between 5 and 64 tasks');
  canonicalUnique(
    tasks.map(task => task.taskId),
    'manifest task ids',
  );
  const blindAssignment = parseBlindAssignment(manifest.blindAssignment);
  const expectedAssignment = deriveMatchedEvaluationBlindAssignmentV1(scheduleSeed);
  if (JSON.stringify(blindAssignment) !== JSON.stringify(expectedAssignment)) {
    invalid('blind assignment does not match the schedule seed');
  }
  const schedule = array(manifest.schedule, 'manifest schedule').map((entry, index) =>
    parseScheduleEntry(entry, index),
  );
  const expectedSchedule = deriveMatchedEvaluationScheduleV1({
    activeArms,
    blindAssignment,
    repetitions,
    scheduleSeed,
    tasks,
  });
  if (JSON.stringify(schedule) !== JSON.stringify(expectedSchedule)) {
    invalid('schedule does not match the content-addressed counterbalanced derivation');
  }
  const withoutHash = {
    ...(activeArms === undefined ? {} : {activeArms}),
    arms,
    blindAssignment,
    corpusHash: matchingString(manifest.corpusHash, HASH, 'manifest corpus hash'),
    model: parseModel(manifest.model),
    repetitions,
    repository: parseRepository(manifest.repository),
    schedule,
    scheduleAlgorithm: manifest.scheduleAlgorithm,
    scheduleSeed,
    tasks,
    version: MATCHED_EVALUATION_VERSION,
  };
  const manifestHash = matchingString(manifest.manifestHash, HASH, 'manifest hash');
  if (manifestHash !== matchedEvaluationManifestHashV1(withoutHash)) {
    invalid('manifest hash does not match its canonical contents');
  }
  return {...withoutHash, manifestHash};
}

export function matchedEvaluationManifestHashV1(input: Omit<MatchedEvaluationManifestV1, 'manifestHash'>): string {
  return digest('matched-evaluation-manifest-v1', input);
}

export function deriveMatchedEvaluationBlindAssignmentV1(
  scheduleSeed: string,
): Readonly<Record<MatchedEvaluationBlindLabel, MatchedEvaluationArm>> {
  const seed = matchingString(scheduleSeed, HASH, 'schedule seed');
  const shuffled = hashOrder(MATCHED_EVALUATION_ARMS, arm => `${seed}\0assignment\0${arm}`);
  return {
    A: shuffled[0],
    B: shuffled[1],
    C: shuffled[2],
    D: shuffled[3],
    E: shuffled[4],
  };
}

export function deriveMatchedEvaluationScheduleV1(input: {
  readonly activeArms?: readonly MatchedEvaluationArm[];
  readonly blindAssignment: Readonly<Record<MatchedEvaluationBlindLabel, MatchedEvaluationArm>>;
  readonly repetitions: number;
  readonly scheduleSeed: string;
  readonly tasks: readonly Pick<MatchedEvaluationManifestTaskV1, 'taskId'>[];
}): readonly MatchedEvaluationScheduleEntryV1[] {
  const scheduleSeed = matchingString(input.scheduleSeed, HASH, 'schedule seed');
  const repetitions = repetitionsValue(input.repetitions);
  const activeArms = canonicalActiveArms(input.activeArms);
  if (repetitions % activeArms.length !== 0) {
    invalid(`repetitions must be divisible by selected arm count (${activeArms.length})`);
  }
  const tasks = [...input.tasks].sort((left, right) => left.taskId.localeCompare(right.taskId));
  canonicalUnique(
    tasks.map(task => matchingString(task.taskId, TASK_ID, 'schedule task id')),
    'schedule task ids',
  );
  const armToLabel = new Map<MatchedEvaluationArm, MatchedEvaluationBlindLabel>(
    MATCHED_EVALUATION_BLIND_LABELS.map(label => [input.blindAssignment[label], label]),
  );
  if (armToLabel.size !== MATCHED_EVALUATION_ARMS.length) invalid('blind assignment must map every arm exactly once');
  const entries: MatchedEvaluationScheduleEntryV1[] = [];
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const taskOrder = hashOrder(tasks, task => `${scheduleSeed}\0task-order\0${repetition}\0${task.taskId}`);
    for (const task of taskOrder) {
      const base = hashOrder(activeArms, arm => `${scheduleSeed}\0arm-order\0${task.taskId}\0${arm}`);
      const offset = digestInteger(`${scheduleSeed}\0rotation\0${task.taskId}`) % activeArms.length;
      const rotation = (offset + repetition) % activeArms.length;
      const order = [...base.slice(rotation), ...base.slice(0, rotation)];
      for (let position = 0; position < order.length; position += 1) {
        const arm = order[position];
        const blindLabel = armToLabel.get(arm);
        if (blindLabel === undefined) invalid('blind assignment omitted a scheduled arm');
        const runOrder = entries.length;
        entries.push({
          blindLabel,
          position: (position + 1) as 1 | 2 | 3 | 4 | 5,
          repetition,
          runNonce: `run_${digest('matched-evaluation-run-v1', {
            manifestSeed: scheduleSeed,
            position: position + 1,
            repetition,
            runOrder,
            taskId: task.taskId,
          }).slice(0, 32)}`,
          runOrder,
          taskId: task.taskId,
        });
      }
    }
  }
  return entries;
}

export function matchedEvaluationArmForLabelV1(
  manifest: MatchedEvaluationManifestV1,
  label: MatchedEvaluationBlindLabel,
): MatchedEvaluationArm {
  return manifest.blindAssignment[label];
}

function projectManifestTask(task: MatchedEvaluationCorpusTaskV1): MatchedEvaluationManifestTaskV1 {
  const identity = {
    category: task.category,
    memoryFixtureHash: digest('matched-evaluation-memory-fixtures-v1', task.memoryFixtures),
    negativeControlHash: digest('matched-evaluation-negative-controls-v1', task.negativeControls),
    pairId: task.pairId,
    promptHash: matchedEvaluationPromptHashV1(task.prompt),
    repositoryFixtureHash: task.repositoryFixtureHash,
    rubricHash: digest('matched-evaluation-rubric-v1', task.rubric),
    sourceGoldHash: digest('matched-evaluation-source-gold-v1', task.sourceGold),
    taskId: task.taskId,
    variant: task.variant,
  };
  return {...identity, taskIdentityHash: digest('matched-evaluation-task-v1', identity)};
}

function parseCorpusTask(value: unknown, index: number): MatchedEvaluationCorpusTaskV1 {
  const task = object(value, `corpus task ${index}`);
  exactKeys(
    task,
    [
      'category',
      'memoryFixtures',
      'negativeControls',
      'pairId',
      'prompt',
      'repositoryFixtureHash',
      'rubric',
      'sourceGold',
      'taskId',
      'variant',
    ],
    `corpus task ${index}`,
  );
  const sourceGold = array(task.sourceGold, `corpus task ${index} source gold`).map((entry, entryIndex) =>
    parseSourceGold(entry, index, entryIndex),
  );
  if (sourceGold.length === 0 || sourceGold.length > 16) invalid(`corpus task ${index} source gold is unbounded`);
  canonicalUnique(
    sourceGold.map(entry => entry.evidenceId),
    `corpus task ${index} source evidence ids`,
  );
  const memoryFixtures = array(task.memoryFixtures, `corpus task ${index} memory fixtures`).map((entry, entryIndex) =>
    parseMemoryFixture(entry, index, entryIndex),
  );
  if (memoryFixtures.length > 32) invalid(`corpus task ${index} has too many memory fixtures`);
  canonicalUnique(
    memoryFixtures.map(entry => entry.memoryId),
    `corpus task ${index} memory fixture ids`,
  );
  const negativeControls = array(task.negativeControls, `corpus task ${index} negative controls`).map(
    (entry, entryIndex) => parseNegativeControl(entry, index, entryIndex),
  );
  if (negativeControls.length === 0 || negativeControls.length > 16) {
    invalid(`corpus task ${index} must have bounded negative controls`);
  }
  canonicalUnique(
    negativeControls.map(entry => entry.controlId),
    `corpus task ${index} negative control ids`,
  );
  const rubric = parseRubric(task.rubric, index);
  if (rubric.requiredEvidenceIds.some(id => !sourceGold.some(entry => entry.evidenceId === id))) {
    invalid(`corpus task ${index} rubric names evidence outside source gold`);
  }
  return {
    category: literal(task.category, MATCHED_EVALUATION_TASK_CATEGORIES, `corpus task ${index} category`),
    memoryFixtures,
    negativeControls,
    pairId: task.pairId === null ? null : matchingString(task.pairId, PAIR_ID, `corpus task ${index} pair id`),
    prompt: boundedString(task.prompt, 1, 12_000, `corpus task ${index} prompt`),
    repositoryFixtureHash: matchingString(
      task.repositoryFixtureHash,
      HASH,
      `corpus task ${index} repository fixture hash`,
    ),
    rubric,
    sourceGold,
    taskId: matchingString(task.taskId, TASK_ID, `corpus task ${index} id`),
    variant: literal(task.variant, MATCHED_EVALUATION_TASK_VARIANTS, `corpus task ${index} variant`),
  };
}

function parseSourceGold(value: unknown, taskIndex: number, index: number): MatchedEvaluationSourceGoldV1 {
  const gold = object(value, `corpus task ${taskIndex} source gold ${index}`);
  exactKeys(gold, ['claim', 'endLine', 'evidenceId', 'path', 'repository', 'startLine'], 'source gold');
  const startLine = positiveInteger(gold.startLine, 'source gold start line');
  const endLine = positiveInteger(gold.endLine, 'source gold end line');
  if (endLine < startLine || endLine - startLine > 200) invalid('source gold range is invalid');
  return {
    claim: boundedString(gold.claim, 1, 2_000, 'source gold claim'),
    endLine,
    evidenceId: matchingString(gold.evidenceId, EVIDENCE_ID, 'source gold evidence id'),
    path: relativePath(gold.path, 'source gold path'),
    repository: matchingString(gold.repository, REPOSITORY_KEY, 'source gold repository'),
    startLine,
  };
}

function parseMemoryFixture(value: unknown, taskIndex: number, index: number): MatchedEvaluationMemoryFixtureV1 {
  const memory = object(value, `corpus task ${taskIndex} memory fixture ${index}`);
  exactKeys(memory, ['memoryId', 'repository', 'source', 'status', 'text'], 'memory fixture');
  let source: MatchedEvaluationMemoryFixtureV1['source'] = null;
  if (memory.source !== null) {
    const raw = object(memory.source, 'memory fixture source');
    exactKeys(raw, ['endLine', 'path', 'startLine'], 'memory fixture source');
    const startLine = positiveInteger(raw.startLine, 'memory fixture source start line');
    const endLine = positiveInteger(raw.endLine, 'memory fixture source end line');
    if (endLine < startLine || endLine - startLine > 200) invalid('memory fixture source range is invalid');
    source = {endLine, path: relativePath(raw.path, 'memory fixture source path'), startLine};
  }
  return {
    memoryId: matchingString(memory.memoryId, MEMORY_ID, 'memory fixture id'),
    repository: matchingString(memory.repository, REPOSITORY_KEY, 'memory fixture repository'),
    source,
    status: literal(memory.status, ['active', 'archived', 'superseded'] as const, 'memory fixture status'),
    text: boundedString(memory.text, 1, 8_000, 'memory fixture text'),
  };
}

function parseNegativeControl(value: unknown, taskIndex: number, index: number): MatchedEvaluationNegativeControlV1 {
  const control = object(value, `corpus task ${taskIndex} negative control ${index}`);
  exactKeys(control, ['controlId', 'reason', 'text'], 'negative control');
  return {
    controlId: matchingString(control.controlId, CONTROL_ID, 'negative control id'),
    reason: boundedString(control.reason, 1, 1_000, 'negative control reason'),
    text: boundedString(control.text, 1, 8_000, 'negative control text'),
  };
}

function parseRubric(value: unknown, taskIndex: number): MatchedEvaluationRubricV1 {
  const rubric = object(value, `corpus task ${taskIndex} rubric`);
  exactKeys(rubric, ['completion', 'criteria', 'requiredEvidenceIds'], `corpus task ${taskIndex} rubric`);
  const criteria = stringArray(rubric.criteria, 1, 16, 1_000, `corpus task ${taskIndex} rubric criteria`);
  const requiredEvidenceIds = array(rubric.requiredEvidenceIds, `corpus task ${taskIndex} required evidence ids`).map(
    value => matchingString(value, EVIDENCE_ID, `corpus task ${taskIndex} required evidence id`),
  );
  canonicalUnique(requiredEvidenceIds, `corpus task ${taskIndex} required evidence ids`);
  return {
    completion: boundedString(rubric.completion, 1, 2_000, `corpus task ${taskIndex} completion rubric`),
    criteria,
    requiredEvidenceIds,
  };
}

function parseManifestTask(value: unknown, index: number): MatchedEvaluationManifestTaskV1 {
  const task = object(value, `manifest task ${index}`);
  exactKeys(
    task,
    [
      'category',
      'memoryFixtureHash',
      'negativeControlHash',
      'pairId',
      'promptHash',
      'repositoryFixtureHash',
      'rubricHash',
      'sourceGoldHash',
      'taskId',
      'taskIdentityHash',
      'variant',
    ],
    `manifest task ${index}`,
  );
  const identity = {
    category: literal(task.category, MATCHED_EVALUATION_TASK_CATEGORIES, `manifest task ${index} category`),
    memoryFixtureHash: matchingString(task.memoryFixtureHash, HASH, `manifest task ${index} memory fixture hash`),
    negativeControlHash: matchingString(task.negativeControlHash, HASH, `manifest task ${index} control hash`),
    pairId: task.pairId === null ? null : matchingString(task.pairId, PAIR_ID, `manifest task ${index} pair id`),
    promptHash: matchingString(task.promptHash, HASH, `manifest task ${index} prompt hash`),
    repositoryFixtureHash: matchingString(
      task.repositoryFixtureHash,
      HASH,
      `manifest task ${index} repository fixture hash`,
    ),
    rubricHash: matchingString(task.rubricHash, HASH, `manifest task ${index} rubric hash`),
    sourceGoldHash: matchingString(task.sourceGoldHash, HASH, `manifest task ${index} source gold hash`),
    taskId: matchingString(task.taskId, TASK_ID, `manifest task ${index} id`),
    variant: literal(task.variant, MATCHED_EVALUATION_TASK_VARIANTS, `manifest task ${index} variant`),
  };
  const taskIdentityHash = matchingString(task.taskIdentityHash, HASH, `manifest task ${index} identity hash`);
  if (taskIdentityHash !== digest('matched-evaluation-task-v1', identity)) {
    invalid(`manifest task ${index} identity hash does not match its contents`);
  }
  return {...identity, taskIdentityHash};
}

function parseArmDefinitions(value: readonly unknown[]): readonly MatchedEvaluationArmDefinitionV1[] {
  if (value.length !== MATCHED_EVALUATION_ARMS.length) invalid('manifest must define every arm');
  const parsed = value.map((entry, index) => {
    const arm = object(entry, `arm definition ${index}`);
    exactKeys(
      arm,
      ['adapterArtifactHash', 'adapterConfigurationHash', 'adapterProtocol', 'arm', 'environmentPolicyHash', 'tool'],
      `arm definition ${index}`,
    );
    const id = literal(arm.arm, MATCHED_EVALUATION_ARMS, `arm definition ${index} id`);
    const tool = object(arm.tool, `arm definition ${index} tool`);
    exactKeys(tool, ['artifactHash', 'lockIdentityHash', 'name', 'version'], `arm definition ${index} tool`);
    const definition: MatchedEvaluationArmDefinitionV1 = {
      adapterArtifactHash: matchingString(arm.adapterArtifactHash, HASH, `arm definition ${index} adapter hash`),
      adapterConfigurationHash: matchingString(
        arm.adapterConfigurationHash,
        HASH,
        `arm definition ${index} adapter configuration hash`,
      ),
      adapterProtocol: literal(
        arm.adapterProtocol,
        [MATCHED_EVALUATION_ADAPTER_PROTOCOL] as const,
        `arm definition ${index} adapter protocol`,
      ),
      arm: id,
      environmentPolicyHash: matchingString(
        arm.environmentPolicyHash,
        HASH,
        `arm definition ${index} environment policy hash`,
      ),
      tool: {
        artifactHash:
          tool.artifactHash === null
            ? null
            : matchingString(tool.artifactHash, HASH, `arm definition ${index} tool artifact hash`),
        lockIdentityHash:
          tool.lockIdentityHash === null
            ? null
            : matchingString(tool.lockIdentityHash, HASH, `arm definition ${index} tool lock hash`),
        name: boundedString(tool.name, 1, 128, `arm definition ${index} tool name`),
        version: boundedString(tool.version, 1, 128, `arm definition ${index} tool version`),
      },
    };
    assertArmDefinition(definition);
    return definition;
  });
  unique(
    parsed.map(arm => arm.arm),
    'arm definition ids',
  );
  return MATCHED_EVALUATION_ARMS.map(requiredArm => parsed.find(arm => arm.arm === requiredArm)!);
}

function assertArmDefinition(definition: MatchedEvaluationArmDefinitionV1): void {
  if (definition.arm === 'files') {
    if (
      definition.tool.name !== 'repository-files' ||
      definition.tool.version !== 'builtin-v1' ||
      definition.tool.artifactHash !== null ||
      definition.tool.lockIdentityHash !== null
    ) {
      invalid('files arm must use the repository-files builtin identity');
    }
    return;
  }
  if (definition.tool.artifactHash === null || definition.tool.lockIdentityHash === null) {
    invalid(`${definition.arm} must pin tool artifact and lock identities`);
  }
  if (definition.arm === 'reference-scope') {
    if (
      definition.tool.name === 'threadnote' ||
      definition.tool.name === 'repository-files' ||
      definition.environmentPolicyHash !== matchedEvaluationReferenceEnvironmentPolicyHashV1()
    ) {
      invalid('reference-scope must pin an external tool with the isolated no-tracking environment policy');
    }
  } else if (definition.tool.name !== 'threadnote') {
    invalid(`${definition.arm} must identify the Threadnote executable`);
  }
}

function parseBlindAssignment(value: unknown): Readonly<Record<MatchedEvaluationBlindLabel, MatchedEvaluationArm>> {
  const assignment = object(value, 'blind assignment');
  exactKeys(assignment, MATCHED_EVALUATION_BLIND_LABELS, 'blind assignment');
  const parsed = {
    A: literal(assignment.A, MATCHED_EVALUATION_ARMS, 'blind assignment A'),
    B: literal(assignment.B, MATCHED_EVALUATION_ARMS, 'blind assignment B'),
    C: literal(assignment.C, MATCHED_EVALUATION_ARMS, 'blind assignment C'),
    D: literal(assignment.D, MATCHED_EVALUATION_ARMS, 'blind assignment D'),
    E: literal(assignment.E, MATCHED_EVALUATION_ARMS, 'blind assignment E'),
  };
  unique(Object.values(parsed), 'blind assignment arms');
  return parsed;
}

function parseScheduleEntry(value: unknown, index: number): MatchedEvaluationScheduleEntryV1 {
  const entry = object(value, `schedule entry ${index}`);
  exactKeys(
    entry,
    ['blindLabel', 'position', 'repetition', 'runNonce', 'runOrder', 'taskId'],
    `schedule entry ${index}`,
  );
  if (![1, 2, 3, 4, 5].includes(entry.position as number)) {
    invalid(`schedule entry ${index} position is invalid`);
  }
  const runOrder = nonNegativeInteger(entry.runOrder, `schedule entry ${index} order`);
  if (runOrder !== index) invalid(`schedule entry ${index} is not in canonical run order`);
  return {
    blindLabel: literal(entry.blindLabel, MATCHED_EVALUATION_BLIND_LABELS, `schedule entry ${index} label`),
    position: entry.position as 1 | 2 | 3 | 4 | 5,
    repetition: nonNegativeInteger(entry.repetition, `schedule entry ${index} repetition`),
    runNonce: matchingString(entry.runNonce, RUN_NONCE, `schedule entry ${index} nonce`),
    runOrder,
    taskId: matchingString(entry.taskId, TASK_ID, `schedule entry ${index} task id`),
  };
}

function parseModel(value: unknown): MatchedEvaluationManifestV1['model'] {
  const model = object(value, 'manifest model');
  exactKeys(model, ['model', 'parametersHash', 'provider'], 'manifest model');
  return {
    model: boundedString(model.model, 1, 256, 'manifest model name'),
    parametersHash: matchingString(model.parametersHash, HASH, 'manifest model parameters hash'),
    provider: boundedString(model.provider, 1, 128, 'manifest model provider'),
  };
}

function parseRepository(value: unknown): MatchedEvaluationManifestV1['repository'] {
  const repository = object(value, 'manifest repository');
  exactKeys(repository, ['dirty', 'fixtureHash', 'identityHash', 'revision'], 'manifest repository');
  if (typeof repository.dirty !== 'boolean') invalid('manifest repository dirty must be boolean');
  return {
    dirty: repository.dirty,
    fixtureHash: matchingString(repository.fixtureHash, HASH, 'manifest repository fixture hash'),
    identityHash: matchingString(repository.identityHash, HASH, 'manifest repository identity hash'),
    revision: matchingString(repository.revision, REVISION, 'manifest repository revision'),
  };
}

function assertVariantDesign(tasks: readonly MatchedEvaluationCorpusTaskV1[]): void {
  const historical = tasks.filter(task => task.variant === 'historical-as-issued');
  if (historical.length > 0) {
    if (historical.length !== tasks.length) invalid('historical-as-issued tasks cannot mix with synthetic variants');
    if (historical.some(task => task.pairId !== null))
      invalid('historical-as-issued tasks cannot declare synthetic pairs');
    return;
  }
  for (const variant of MATCHED_EVALUATION_TASK_VARIANTS) {
    if (variant !== 'historical-as-issued' && !tasks.some(task => task.variant === variant)) {
      invalid(`corpus does not cover ${variant}`);
    }
  }
  const exact = tasks.filter(task => task.variant === 'exact-name');
  const paraphrases = tasks.filter(task => task.variant === 'paraphrase');
  if (exact.length === 0 || paraphrases.length === 0) invalid('corpus requires exact-name and paraphrase pairs');
  for (const task of [...exact, ...paraphrases]) {
    if (task.pairId === null) invalid('exact-name and paraphrase tasks require a pair id');
    const peers = tasks.filter(candidate => candidate.pairId === task.pairId);
    if (
      peers.length !== 2 ||
      !peers.some(peer => peer.variant === 'exact-name') ||
      !peers.some(peer => peer.variant === 'paraphrase')
    ) {
      invalid(`pair ${task.pairId} must contain exactly one exact-name and one paraphrase task`);
    }
  }
}

function repetitionsValue(value: unknown): number {
  const repetitions = positiveInteger(value, 'manifest repetitions');
  if (repetitions < MATCHED_EVALUATION_MINIMUM_REPETITIONS || repetitions > 40) {
    invalid('manifest repetitions must be between 5 and 40');
  }
  return repetitions;
}

function canonicalActiveArms(value: unknown): readonly MatchedEvaluationArm[] {
  const arms =
    value === undefined
      ? [...MATCHED_EVALUATION_ARMS]
      : array(value, 'active arms').map((arm, index) => literal(arm, MATCHED_EVALUATION_ARMS, `active arm ${index}`));
  if (arms.length === 0 || arms.length > MATCHED_EVALUATION_ARMS.length)
    invalid('active arms must select at least one arm');
  unique(arms, 'active arms');
  return [...arms].sort(
    (left, right) => MATCHED_EVALUATION_ARMS.indexOf(left) - MATCHED_EVALUATION_ARMS.indexOf(right),
  );
}

function hashOrder<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...values].sort((left, right) => {
    const comparison = sha256HexSync(key(left)).localeCompare(sha256HexSync(key(right)));
    return comparison === 0 ? String(left).localeCompare(String(right)) : comparison;
  });
}

function digestInteger(input: string): number {
  return Number.parseInt(sha256HexSync(input).slice(0, 8), 16);
}

function digest(label: string, value: unknown): string {
  return sha256HexSync(`${label}\0${JSON.stringify(value)}\n`);
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

function matchingString(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(`${label} is invalid`);
  return value;
}

function boundedString(value: unknown, minimum: number, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || value.includes('\0')) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = nonNegativeInteger(value, label);
  if (parsed === 0) invalid(`${label} must be positive`);
  return parsed;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(`${label} must be a non-negative integer`);
  }
  return value;
}

function literal<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) invalid(`${label} is invalid`);
  return value;
}

function stringArray(
  value: unknown,
  minimum: number,
  maximum: number,
  maximumLength: number,
  label: string,
): readonly string[] {
  const values = array(value, label);
  if (values.length < minimum || values.length > maximum) invalid(`${label} has invalid bounds`);
  return values.map((entry, index) => boundedString(entry, 1, maximumLength, `${label} ${index}`));
}

function relativePath(value: unknown, label: string): string {
  const path = boundedString(value, 1, 4_096, label);
  if (
    path.includes('\\') ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    invalid(`${label} must be a normalized repository-relative file`);
  }
  return path;
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label} must be unique`);
}

function canonicalUnique(values: readonly string[], label: string): void {
  unique(values, label);
  if (values.some((value, index) => value !== [...values].sort()[index])) invalid(`${label} must be sorted`);
}

function invalid(message: string): never {
  throw new Error(`Invalid matched evaluation: ${message}.`);
}
