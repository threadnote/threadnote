import {Array as EffectArray} from 'effect';
import {compareCodeUnits} from './ordering.js';
import {codeGraphExtractionWorkUnits, codeGraphSourceSizeBucket} from './progress/telemetry.js';

const REQUEST_COST_SCALE = 1_024;
const FACT_COST_SCALE = 4;
const EXTRACTION_WINDOW_FILES_PER_WORKER = 36;
const EXTRACTION_WINDOW_FILES_MAXIMUM = 96;

export interface CodeGraphExtractionCostFile {
  readonly language: string;
  readonly path: string;
  readonly size: number;
}

export interface CodeGraphExtractionCostGroup {
  readonly files: readonly CodeGraphExtractionCostFile[];
}

export interface CodeGraphExtractionCostEstimate {
  readonly estimatedFactBytes: number;
  readonly estimatedRequestMicroseconds: number;
  readonly score: number;
  readonly staticWorkUnits: number;
}

export interface CodeGraphExtractionCostModel<Group extends CodeGraphExtractionCostGroup> {
  readonly estimate: (group: Group) => CodeGraphExtractionCostEstimate;
  readonly observe: (
    file: CodeGraphExtractionCostFile,
    observation: {readonly factsBytes: number; readonly requestMilliseconds: number},
  ) => void;
}

export interface CodeGraphExtractionLane<Group extends CodeGraphExtractionCostGroup> {
  readonly concurrency: number;
  readonly groups: readonly Group[];
  readonly kind: 'cost-ordered';
}

/**
 * Keep enough independent parser work in flight to absorb file-cost skew
 * while bounding each extraction-result wave. Parser capacity is capped at
 * eight elsewhere, so a wave contains at most 96 files.
 */
export function codeGraphExtractionWindowSize(capacity: number): number {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Code graph parser capacity is invalid.');
  return Math.min(EXTRACTION_WINDOW_FILES_MAXIMUM, capacity * EXTRACTION_WINDOW_FILES_PER_WORKER);
}

interface ExtractionCostAggregate {
  factBytes: number;
  requestMicroseconds: number;
  sourceBytes: number;
  workUnits: number;
}

/**
 * Build a bounded online cost model. The static prior is language/size weighted;
 * completed parser requests then calibrate request time and emitted-fact volume
 * by language and size class. Callers apply observations in deterministic input
 * order, so worker completion races cannot perturb later schedules.
 */
export function createCodeGraphExtractionCostModel<
  Group extends CodeGraphExtractionCostGroup,
>(): CodeGraphExtractionCostModel<Group> {
  const byClass = new Map<string, ExtractionCostAggregate>();
  const global = emptyAggregate();
  return {
    estimate: group => estimateGroup(group, byClass, global),
    observe: (file, observation) => {
      if (
        !Number.isFinite(observation.requestMilliseconds) ||
        observation.requestMilliseconds < 0 ||
        !Number.isSafeInteger(observation.factsBytes) ||
        observation.factsBytes < 0
      ) {
        throw new Error('Code graph extraction cost observation is invalid.');
      }
      const current = byClass.get(costClass(file)) ?? emptyAggregate();
      const workUnits = fileWorkUnits(file);
      const requestMicroseconds = Math.max(0, Math.round(observation.requestMilliseconds * 1_000));
      addObservation(current, file.size, workUnits, observation.factsBytes, requestMicroseconds);
      addObservation(global, file.size, workUnits, observation.factsBytes, requestMicroseconds);
      byClass.set(costClass(file), current);
    },
  };
}

/**
 * Longest-predicted-time first keeps tail work from landing after ordinary
 * files. Effect's bounded `forEach` supplies a shared work queue; parser-pool
 * slots remain the CPU/memory and cross-worktree admission tokens.
 */
export function planCodeGraphExtractionLanes<Group extends CodeGraphExtractionCostGroup>(
  groups: readonly Group[],
  capacity: number,
  model: CodeGraphExtractionCostModel<Group> = createCodeGraphExtractionCostModel<Group>(),
): readonly CodeGraphExtractionLane<Group>[] {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Code graph parser capacity is invalid.');
  if (groups.length === 0) return [];
  const planned = EffectArray.map(groups, (group, inputIndex) => ({
    estimate: model.estimate(group),
    group,
    inputIndex,
    key: groupKey(group),
  }));
  planned.sort(
    (left, right) =>
      right.estimate.score - left.estimate.score ||
      right.estimate.estimatedRequestMicroseconds - left.estimate.estimatedRequestMicroseconds ||
      right.estimate.estimatedFactBytes - left.estimate.estimatedFactBytes ||
      compareCodeUnits(left.key, right.key) ||
      left.inputIndex - right.inputIndex,
  );
  return [{concurrency: capacity, groups: EffectArray.map(planned, item => item.group), kind: 'cost-ordered'}];
}

/**
 * Bound the parser results retained before persistence. Oversized reuse groups
 * are split without changing their reuse identity; the materializer's
 * cross-window donor cache preserves single-extraction reuse for those files.
 */
export function takeCodeGraphExtractionWindow<Group extends CodeGraphExtractionCostGroup>(
  groups: readonly Group[],
  maximumFiles: number,
): readonly [selected: readonly Group[], remaining: readonly Group[]] {
  if (!Number.isSafeInteger(maximumFiles) || maximumFiles < 1) {
    throw new Error('Code graph extraction window is invalid.');
  }
  const totalFiles = EffectArray.reduce(groups, 0, (total, group) => total + group.files.length);
  const windowCount = Math.ceil(totalFiles / maximumFiles);
  const targetFiles = windowCount === 0 ? 0 : Math.ceil(totalFiles / windowCount);
  const selected: Group[] = [];
  const remaining: Group[] = [];
  let selectedFiles = 0;
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (group.files.length === 0) throw new Error('Code graph extraction group is empty.');
    const available = targetFiles - selectedFiles;
    if (available === 0) {
      remaining.push(...groups.slice(index));
      break;
    }
    if (group.files.length <= available) {
      selected.push(group);
      selectedFiles += group.files.length;
      continue;
    }
    selected.push({...group, files: group.files.slice(0, available)});
    remaining.push({...group, files: group.files.slice(available)}, ...groups.slice(index + 1));
    break;
  }
  return [selected, remaining];
}

function estimateGroup<Group extends CodeGraphExtractionCostGroup>(
  group: Group,
  byClass: ReadonlyMap<string, ExtractionCostAggregate>,
  global: ExtractionCostAggregate,
): CodeGraphExtractionCostEstimate {
  if (group.files.length === 0) throw new Error('Code graph extraction group is empty.');
  const representative = [...group.files].sort(
    (left, right) => fileWorkUnits(right) - fileWorkUnits(left) || compareCodeUnits(left.path, right.path),
  )[0];
  const staticWorkUnits = fileWorkUnits(representative);
  const aggregate = byClass.get(costClass(representative)) ?? (global.workUnits > 0 ? global : undefined);
  const estimatedRequestMicroseconds =
    aggregate === undefined
      ? staticWorkUnits
      : scaledRatio(staticWorkUnits, aggregate.requestMicroseconds, aggregate.workUnits);
  const estimatedFactBytesPerFile =
    aggregate === undefined
      ? 0
      : scaledRatio(Math.max(1, representative.size), aggregate.factBytes, aggregate.sourceBytes);
  const estimatedFactBytes = saturatingMultiply(estimatedFactBytesPerFile, group.files.length);
  const score = saturatingAdd(
    saturatingMultiply(estimatedRequestMicroseconds, REQUEST_COST_SCALE),
    saturatingMultiply(estimatedFactBytes, FACT_COST_SCALE),
  );
  return {estimatedFactBytes, estimatedRequestMicroseconds, score, staticWorkUnits};
}

function addObservation(
  aggregate: ExtractionCostAggregate,
  sourceBytes: number,
  workUnits: number,
  factBytes: number,
  requestMicroseconds: number,
): void {
  aggregate.factBytes = saturatingAdd(aggregate.factBytes, factBytes);
  aggregate.requestMicroseconds = saturatingAdd(aggregate.requestMicroseconds, requestMicroseconds);
  aggregate.sourceBytes = saturatingAdd(aggregate.sourceBytes, Math.max(1, sourceBytes));
  aggregate.workUnits = saturatingAdd(aggregate.workUnits, workUnits);
}

function emptyAggregate(): ExtractionCostAggregate {
  return {factBytes: 0, requestMicroseconds: 0, sourceBytes: 0, workUnits: 0};
}

function costClass(file: CodeGraphExtractionCostFile): string {
  return `${file.language}\0${codeGraphSourceSizeBucket(file.size)}`;
}

function fileWorkUnits(file: CodeGraphExtractionCostFile): number {
  return codeGraphExtractionWorkUnits(file.size, file.language, codeGraphSourceSizeBucket(file.size));
}

function groupKey(group: CodeGraphExtractionCostGroup): string {
  return EffectArray.map([...group.files], file => file.path).sort(compareCodeUnits)[0] ?? '';
}

function scaledRatio(value: number, numerator: number, denominator: number): number {
  if (denominator <= 0 || numerator <= 0 || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round((value * numerator) / denominator));
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function saturatingMultiply(left: number, right: number): number {
  if (left === 0 || right === 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, left * right);
}
