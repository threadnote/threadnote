import {Array as EffectArray} from 'effect';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {BunRuntime} from '@effect/platform-bun';
import {Effect, FileSystem, Path} from 'effect';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import * as EffectRecord from 'effect/Record';

export interface MixedNxBazelGateEvidence {
  readonly analysisMilliseconds: number;
  readonly analysisPeakRssBytes: number;
  readonly boundedStaleReadMilliseconds: number;
  readonly coldIndexMilliseconds: number;
  readonly crashRecoveryForegroundMilliseconds: number;
  readonly currentQueryMilliseconds: number;
  readonly inventoryMilliseconds: number;
  readonly movingTarget: {
    readonly newestRefreshCoalesced: boolean;
    readonly postTargetMaterializationMode: 'incremental-clean' | 'incremental-overlay' | 'full';
    readonly stagedFiles: number;
    readonly targetCommitExposed: boolean;
    readonly totalFiles: number;
  };
  readonly oneFileIncrementalMilliseconds: number;
  readonly oneFileIncrementalPeakRssBytes: number;
  readonly postChurnStorageGrowthPercent: number;
  readonly stableNoopMilliseconds: number;
}

export interface MixedNxBazelGateBudgets {
  readonly maximum: Omit<Record<keyof MixedNxBazelGateEvidence, number>, 'movingTarget'>;
}

export function validateMixedNxBazelGate(evidence: MixedNxBazelGateEvidence, budgets: MixedNxBazelGateBudgets): void {
  const failures: string[] = [];
  for (const [name, maximum] of EffectRecord.toEntries(budgets.maximum)) {
    const value = evidence[name];
    if (!Number.isFinite(maximum) || !Number.isFinite(value) || value > maximum) {
      failures.push(`${name} ${String(value)} exceeds ${String(maximum)}`);
    }
  }
  const target = evidence.movingTarget;
  if (!target.targetCommitExposed) failures.push('moving target commit was not exposed');
  if (!target.newestRefreshCoalesced) failures.push('moving target refreshes were not coalesced');
  if (target.postTargetMaterializationMode === 'full') failures.push('post-target refresh replayed a full graph');
  if (
    !Number.isSafeInteger(target.stagedFiles) ||
    !Number.isSafeInteger(target.totalFiles) ||
    target.stagedFiles < 0 ||
    target.totalFiles < 1 ||
    target.stagedFiles >= target.totalFiles
  ) {
    failures.push('post-target closure was not bounded');
  }
  if (failures.length > 0)
    throw ScriptError.make({message: `Mixed Nx/Bazel P2 gate failed: ${EffectArray.join(failures, '; ')}`});
}

const run = Effect.fn('mixedNxBazelGate.run')(function* (args: readonly string[] = process.argv.slice(2)) {
  let evidencePath: string | undefined;
  let budgetsPath = 'apps/threadnote/test/evaluation/baselines/code-graph-v1/mixed-nx-bazel-budgets.json';
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--evidence') evidencePath = args[++index];
    else if (args[index] === '--budgets') budgetsPath = args[++index]!;
    else throw ScriptError.make({message: `Unknown mixed-monorepo gate option: ${args[index]}`});
  }
  if (!evidencePath) throw ScriptError.make({message: '--evidence requires a JSON artifact.'});
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const [evidence, budgets] = yield* Effect.all([
    fs.readFileString(path.resolve(evidencePath)).pipe(Effect.map(JSON.parse)),
    fs.readFileString(path.resolve(budgetsPath)).pipe(Effect.map(JSON.parse)),
  ]);
  if (!isMixedNxBazelGateEvidence(evidence) || !isMixedNxBazelGateBudgets(budgets)) {
    return yield* ScriptError.make({message: 'Mixed Nx/Bazel evidence or budget artifact has an invalid shape.'});
  }
  validateMixedNxBazelGate(evidence, budgets);
});

const MIXED_NX_BAZEL_EVIDENCE_NUMERIC_FIELDS = [
  'analysisMilliseconds',
  'analysisPeakRssBytes',
  'boundedStaleReadMilliseconds',
  'coldIndexMilliseconds',
  'crashRecoveryForegroundMilliseconds',
  'currentQueryMilliseconds',
  'inventoryMilliseconds',
  'oneFileIncrementalMilliseconds',
  'oneFileIncrementalPeakRssBytes',
  'postChurnStorageGrowthPercent',
  'stableNoopMilliseconds',
] as const satisfies readonly (keyof Omit<MixedNxBazelGateEvidence, 'movingTarget'>)[];

const MIXED_NX_BAZEL_BUDGET_FIELDS = [
  'analysisMilliseconds',
  'analysisPeakRssBytes',
  'boundedStaleReadMilliseconds',
  'coldIndexMilliseconds',
  'crashRecoveryForegroundMilliseconds',
  'currentQueryMilliseconds',
  'inventoryMilliseconds',
  'oneFileIncrementalMilliseconds',
  'oneFileIncrementalPeakRssBytes',
  'postChurnStorageGrowthPercent',
  'stableNoopMilliseconds',
] as const;

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}

function isMixedNxBazelGateEvidence(value: unknown): value is MixedNxBazelGateEvidence {
  if (
    !isStringRecord(value) ||
    !EffectArray.every(MIXED_NX_BAZEL_EVIDENCE_NUMERIC_FIELDS, field => typeof value[field] === 'number') ||
    !('movingTarget' in value) ||
    !isStringRecord(value.movingTarget)
  )
    return false;
  const target = value.movingTarget;
  return (
    typeof target.newestRefreshCoalesced === 'boolean' &&
    (target.postTargetMaterializationMode === 'incremental-clean' ||
      target.postTargetMaterializationMode === 'incremental-overlay' ||
      target.postTargetMaterializationMode === 'full') &&
    typeof target.stagedFiles === 'number' &&
    typeof target.targetCommitExposed === 'boolean' &&
    typeof target.totalFiles === 'number'
  );
}

function isMixedNxBazelGateBudgets(value: unknown): value is MixedNxBazelGateBudgets {
  if (!isStringRecord(value) || !('maximum' in value) || !isStringRecord(value.maximum)) return false;
  const maximum = value.maximum;
  return EffectArray.every(MIXED_NX_BAZEL_BUDGET_FIELDS, field => typeof maximum[field] === 'number');
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(run(), ApplicationLayer));
