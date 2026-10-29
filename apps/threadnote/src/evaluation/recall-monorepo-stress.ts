import {Array as EffectArray} from 'effect';
import {recallWorkspaceScopeMatches} from '@threadnote/recall/index/scope';
import {deriveRecallEligibilityPolicy} from '@threadnote/recall/eligibility';
import {
  deduplicateLogicalRecallCandidates,
  rankRecallCandidates,
  recallMemoryContentHash,
  type RankedRecallSet,
  type RecallCandidate,
} from '@threadnote/recall/rank';
import {
  mergeRecallCandidateLanes,
  prioritizeCrossScopeRecallCandidates,
  prioritizeWorkspaceRecallCandidates,
  recallCrossScopeLaneBudgets,
} from '@threadnote/recall/runtime';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

const FIXED_NOW = new Date('2026-08-20T00:00:00.000Z');
const FIXED_TIMESTAMP = FIXED_NOW.toISOString();

export const MONOREPO_SHARE_RECALL_STRESS_SCENARIOS = ['current-package-target', 'sibling-package-target'] as const;

export const MONOREPO_SHARE_RECALL_STRESS_MODES = [
  'full-corpus',
  'workspace-prefiltered',
  'cross-scope-challenger',
] as const;

export type MonorepoShareRecallStressScenario = (typeof MONOREPO_SHARE_RECALL_STRESS_SCENARIOS)[number];
export type MonorepoShareRecallStressMode = (typeof MONOREPO_SHARE_RECALL_STRESS_MODES)[number];

export interface MonorepoShareRecallStressOptions {
  readonly logicalMemoriesPerPackage: number;
  readonly packages: number;
  /** Number of team-shared copies in addition to each logical memory's personal copy. */
  readonly shareAliasesPerMemory: number;
  readonly siblingPackage: number;
  readonly seed: number;
  /** The package containing the caller, and therefore the current workspace scope. */
  readonly targetPackage: number;
  readonly topK: number;
}

export interface MonorepoShareRecallStressFixture {
  readonly candidates: readonly RecallCandidate[];
  readonly options: MonorepoShareRecallStressOptions;
  readonly query: string;
  readonly relevantMemoryIds: readonly string[];
  readonly relevantWorkspaceScope: string;
  readonly scenario: MonorepoShareRecallStressScenario;
  readonly targetWorkspaceScope: string;
}

export interface MonorepoShareRecallStressSummary {
  readonly admissionLimit: number;
  readonly adversarialTopicalRelevantIndex: number;
  readonly aliasCompressionRate: number;
  readonly candidateRecords: number;
  readonly candidateRepresentation: 'logical-representatives' | 'physical-aliases';
  readonly crossScopeHitsAtK: number;
  readonly crossScopeMemories: number;
  readonly crossScopeRecallAtK: number | null;
  readonly duplicateResultCount: number;
  readonly duplicateResultRate: number;
  readonly logicalCandidates: number;
  readonly mode: MonorepoShareRecallStressMode;
  readonly rankedResults: number;
  readonly relevantHitsAtK: number;
  readonly relevantMemories: number;
  readonly relevantRecallAtK: number;
  readonly scenario: MonorepoShareRecallStressScenario;
  readonly sourceLogicalCandidates: number;
  readonly sourcePhysicalCandidates: number;
  readonly topK: number;
  readonly topMemoryIds: readonly string[];
}

export function createMonorepoShareRecallStressFixture(
  options: MonorepoShareRecallStressOptions,
  scenario: MonorepoShareRecallStressScenario = 'current-package-target',
): MonorepoShareRecallStressFixture {
  validateOptions(options);
  const width = Math.max(3, String(options.packages - 1).length);
  const candidates: RecallCandidate[] = [];
  const relevantPackage = scenario === 'current-package-target' ? options.targetPackage : options.siblingPackage;
  const relevantMemoryId = stressMemoryId(relevantPackage, 0, width);

  for (let packageIndex = 0; packageIndex < options.packages; packageIndex += 1) {
    const workspaceScope = stressWorkspaceScope(packageIndex, width);
    for (let logicalIndex = 0; logicalIndex < options.logicalMemoriesPerPackage; logicalIndex += 1) {
      const memoryId = stressMemoryId(packageIndex, logicalIndex, width);
      const relevant = packageIndex === relevantPackage && logicalIndex === 0;
      const currentScopeDecoy = packageIndex === options.targetPackage && !relevant;
      const siblingDecoy = packageIndex !== options.targetPackage && logicalIndex === 0 && !relevant;
      const topicalDecoy = currentScopeDecoy || siblingDecoy;
      const topic = relevant
        ? 'checkout-retry-contract'
        : topicalDecoy
          ? `checkout-retry-history-${Effect.pipe(String(logicalIndex), EffectString.padStart(3, '0'))}`
          : `operational-note-${Effect.pipe(String(logicalIndex), EffectString.padStart(3, '0'))}`;
      const text = relevant
        ? 'Checkout retry contract uses bounded backoff and deterministic jitter.'
        : topicalDecoy
          ? `Checkout retry history ${logicalIndex} covers a superseded attempt counter and legacy logging.`
          : `Package operational note ${logicalIndex} covers cache lifecycle and logging.`;
      const common: Omit<RecallCandidate, 'authority' | 'uri'> = {
        contentHash: recallMemoryContentHash(text),
        fields: {
          keywords: relevant
            ? ['bounded checkout retry contract']
            : topicalDecoy
              ? ['superseded checkout retry history']
              : ['cache lifecycle logging'],
          project: 'monorepo-stress',
          title: relevant
            ? 'Checkout retry contract'
            : topicalDecoy
              ? `Checkout retry history ${logicalIndex}`
              : `Operational note ${logicalIndex}`,
          topic,
          workspaceScope,
        },
        kind: 'durable',
        memoryId,
        status: 'active',
        text,
        timestamp: FIXED_TIMESTAMP,
        trust: 'approved',
      };
      candidates.push({
        ...common,
        authority: 'user_approved',
        uri: personalMemoryUri(packageIndex, logicalIndex, width),
      });
      for (let shareIndex = 0; shareIndex < options.shareAliasesPerMemory; shareIndex += 1) {
        candidates.push({
          ...common,
          authority: 'reviewed_shared',
          uri: sharedMemoryUri(packageIndex, logicalIndex, shareIndex, width),
        });
      }
    }
  }

  return {
    candidates: deterministicShuffle(candidates, scenarioSeed(options.seed, scenario)),
    options: {...options},
    query: 'checkout retry contract',
    relevantMemoryIds: [relevantMemoryId],
    relevantWorkspaceScope: stressWorkspaceScope(relevantPackage, width),
    scenario,
    targetWorkspaceScope: stressWorkspaceScope(options.targetPackage, width),
  };
}

export function monorepoShareRecallStressCandidates(
  fixture: MonorepoShareRecallStressFixture,
  mode: MonorepoShareRecallStressMode,
): readonly RecallCandidate[] {
  if (mode === 'full-corpus') return fixture.candidates;
  const candidates = fixture.candidates;
  const workspaceCandidates = EffectArray.filter(
    candidates,
    (candidate, index) =>
      index in candidates &&
      recallWorkspaceScopeMatches(fixture.targetWorkspaceScope, candidate.fields?.workspaceScope),
  );
  if (mode === 'workspace-prefiltered') return workspaceCandidates;

  const logicalCandidates = deduplicateLogicalRecallCandidates(fixture.candidates);
  const context = {
    eligibility: deriveRecallEligibilityPolicy({
      explicitProject: 'monorepo-stress',
      originalQuery: fixture.query,
    }),
    now: FIXED_NOW,
    project: 'monorepo-stress',
    workspaceScope: fixture.targetWorkspaceScope,
  };
  const prioritizedWorkspace = prioritizeWorkspaceRecallCandidates(fixture.query, logicalCandidates, context);
  const budgets = recallCrossScopeLaneBudgets(fixture.options.topK);
  const prioritizedCrossScope = prioritizeCrossScopeRecallCandidates(fixture.query, logicalCandidates, context).slice(
    0,
    budgets.crossSelectionLimit,
  );
  return mergeRecallCandidateLanes(
    [crowdedTopicalCandidates(fixture, logicalCandidates)],
    [prioritizedWorkspace],
    [prioritizedCrossScope],
    budgets,
  ).slice(0, budgets.admissionLimit);
}

export function runMonorepoShareRecallStressPass(
  fixture: MonorepoShareRecallStressFixture,
  candidates: readonly RecallCandidate[],
): RankedRecallSet {
  return rankRecallCandidates(fixture.query, candidates, {
    eligibility: deriveRecallEligibilityPolicy({
      explicitProject: 'monorepo-stress',
      originalQuery: fixture.query,
    }),
    now: FIXED_NOW,
    project: 'monorepo-stress',
    workspaceScope: fixture.targetWorkspaceScope,
  });
}

export function summarizeMonorepoShareRecallStressPass(
  fixture: MonorepoShareRecallStressFixture,
  mode: MonorepoShareRecallStressMode,
  candidates: readonly RecallCandidate[],
  ranked: RankedRecallSet,
): MonorepoShareRecallStressSummary {
  const logicalCandidates = deduplicateLogicalRecallCandidates(candidates).length;
  const sourceLogicalCandidates = deduplicateLogicalRecallCandidates(fixture.candidates).length;
  const resultMemoryIds = EffectArray.flatMap(ranked.results, result =>
    result.candidate.memoryId === undefined ? [] : [result.candidate.memoryId],
  );
  const duplicateResultCount = resultMemoryIds.length - new Set(resultMemoryIds).size;
  const relevant = new Set(fixture.relevantMemoryIds);
  const adversarialTopicalRelevantIndex = EffectOption.getOrElse(
    EffectArray.findFirstIndex(
      crowdedTopicalCandidates(fixture, deduplicateLogicalRecallCandidates(fixture.candidates)),
      __effectArrayValue =>
        !!(candidate => candidate.memoryId !== undefined && relevant.has(candidate.memoryId))(__effectArrayValue),
    ),
    () => -1,
  );
  const topMemoryIds = resultMemoryIds.slice(0, fixture.options.topK);
  const relevantHitsAtK = new Set(EffectArray.filter(topMemoryIds, memoryId => relevant.has(memoryId))).size;
  const relevantIsCrossScope = fixture.relevantWorkspaceScope !== fixture.targetWorkspaceScope;
  return {
    admissionLimit: recallCrossScopeLaneBudgets(fixture.options.topK).admissionLimit,
    adversarialTopicalRelevantIndex,
    aliasCompressionRate: candidates.length === 0 ? 0 : (candidates.length - logicalCandidates) / candidates.length,
    candidateRecords: candidates.length,
    candidateRepresentation: mode === 'cross-scope-challenger' ? 'logical-representatives' : 'physical-aliases',
    crossScopeHitsAtK: relevantIsCrossScope ? relevantHitsAtK : 0,
    crossScopeMemories: relevantIsCrossScope ? relevant.size : 0,
    crossScopeRecallAtK: relevantIsCrossScope ? relevantHitsAtK / relevant.size : null,
    duplicateResultCount,
    duplicateResultRate: resultMemoryIds.length === 0 ? 0 : duplicateResultCount / resultMemoryIds.length,
    logicalCandidates,
    mode,
    rankedResults: ranked.results.length,
    relevantHitsAtK,
    relevantMemories: relevant.size,
    relevantRecallAtK: relevant.size === 0 ? 1 : relevantHitsAtK / relevant.size,
    scenario: fixture.scenario,
    sourceLogicalCandidates,
    sourcePhysicalCandidates: fixture.candidates.length,
    topK: fixture.options.topK,
    topMemoryIds,
  };
}

/**
 * Adversarial topical source ordering for the pure admission benchmark: the
 * current package consumes the bounded head before any sibling candidate.
 * This deliberately models candidate-window crowding rather than SQLite's
 * BM25 order; the production lane helpers still own all reserve and ranking
 * decisions exercised by the challenger mode.
 */
function crowdedTopicalCandidates(
  fixture: MonorepoShareRecallStressFixture,
  candidates: readonly RecallCandidate[],
): readonly RecallCandidate[] {
  return [...candidates].sort((left, right) => {
    const leftCurrent = left.fields?.workspaceScope === fixture.targetWorkspaceScope;
    const rightCurrent = right.fields?.workspaceScope === fixture.targetWorkspaceScope;
    return Number(rightCurrent) - Number(leftCurrent) || compareCodeUnits(left.uri, right.uri);
  });
}

function validateOptions(options: MonorepoShareRecallStressOptions): void {
  for (const [name, value] of [
    ['packages', options.packages],
    ['logicalMemoriesPerPackage', options.logicalMemoriesPerPackage],
    ['seed', options.seed],
    ['topK', options.topK],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  }
  if (options.packages < 2) throw new RangeError('packages must include a current package and a sibling package');
  if (!Number.isSafeInteger(options.shareAliasesPerMemory) || options.shareAliasesPerMemory < 0) {
    throw new RangeError('shareAliasesPerMemory must be a non-negative integer');
  }
  for (const [name, value] of [
    ['targetPackage', options.targetPackage],
    ['siblingPackage', options.siblingPackage],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0 || value >= options.packages) {
      throw new RangeError(`${name} must identify one generated package`);
    }
  }
  if (options.siblingPackage === options.targetPackage) {
    throw new RangeError('siblingPackage must differ from targetPackage');
  }
}

function scenarioSeed(seed: number, scenario: MonorepoShareRecallStressScenario): number {
  return scenario === 'current-package-target' ? seed : seed ^ 0x51b1_1a9e;
}

function stressWorkspaceScope(packageIndex: number, width: number): string {
  return `apps/package-${Effect.pipe(String(packageIndex), EffectString.padStart(width, '0'))}`;
}

function stressMemoryId(packageIndex: number, logicalIndex: number, width: number): string {
  return `tn_stress_p${Effect.pipe(String(packageIndex), EffectString.padStart(width, '0'))}_m${Effect.pipe(String(logicalIndex), EffectString.padStart(4, '0'))}`;
}

function personalMemoryUri(packageIndex: number, logicalIndex: number, width: number): string {
  return `threadnote://user/benchmark/memories/durable/projects/monorepo-stress/package-${Effect.pipe(String(packageIndex), EffectString.padStart(width, '0'))}-memory-${Effect.pipe(String(logicalIndex), EffectString.padStart(4, '0'))}.md`;
}

function sharedMemoryUri(packageIndex: number, logicalIndex: number, shareIndex: number, width: number): string {
  return `threadnote://user/benchmark/memories/shared/team-${Effect.pipe(String(shareIndex), EffectString.padStart(2, '0'))}/durable/projects/monorepo-stress/package-${Effect.pipe(String(packageIndex), EffectString.padStart(width, '0'))}-memory-${Effect.pipe(String(logicalIndex), EffectString.padStart(4, '0'))}.md`;
}

function deterministicShuffle<T>(values: readonly T[], seed: number): readonly T[] {
  const shuffled = [...values];
  let state = seed >>> 0;
  const random = (): number => {
    state += 0x6d2b_79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const replacement = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[replacement]] = [shuffled[replacement], shuffled[index]];
  }
  return shuffled;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
