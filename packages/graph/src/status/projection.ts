import {Array as EffectArray, Option as EffectOption} from 'effect';
import {parseCapacityFailure} from '../build_status/codec.js';
import type {
  CodeGraphBuildActivity,
  CodeGraphBuildStatusSelection,
  ObservedCodeGraphBuildStatus,
} from '../build_status.js';
import type {ObsoleteCodeGraphStoreInventory} from '../maintenance.js';
import type {CodeGraphStorage} from '../storage.js';
import type {CodeGraphStatus} from '../types.js';
import {parseCodeGraphBuildScheduling, type CodeGraphBuildScheduling} from '../build_status/scheduling.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const CODE_GRAPH_STATUS_DEFAULT_BUILD_LIMIT = 4;
export const CODE_GRAPH_STATUS_MINIMUM_BUILD_LIMIT = 1;
export const CODE_GRAPH_STATUS_MAXIMUM_BUILD_LIMIT = 32;
export const CODE_GRAPH_STATUS_DEFAULT_LANGUAGE_PACK_LIMIT = 4;
export const CODE_GRAPH_STATUS_MINIMUM_LANGUAGE_PACK_LIMIT = 1;
export const CODE_GRAPH_STATUS_MAXIMUM_LANGUAGE_PACK_LIMIT = 64;
export const CODE_GRAPH_STATUS_BUILD_SUMMARY_MAXIMUM_BYTES = 4_096;

export interface CodeGraphStatusBoundedListReceiptV3 {
  readonly limit: number;
  readonly omitted: number;
  readonly returned: number;
  readonly total: number;
}

export interface CodeGraphStatusProjectionReceiptV3 {
  readonly builds: CodeGraphStatusBoundedListReceiptV3;
  readonly queuedWorktreeIds: CodeGraphStatusBoundedListReceiptV3;
  readonly waiters: CodeGraphStatusBoundedListReceiptV3;
}

export interface CodeGraphStatusProjectionReceiptV5 extends CodeGraphStatusProjectionReceiptV3 {
  readonly languagePacks: CodeGraphStatusBoundedListReceiptV3;
}

export interface CodeGraphStatusBuildSelectionV5 {
  readonly buildId: string;
  readonly index: number;
  readonly worktreeId: string;
}

export interface CodeGraphStatusBuildSummaryV5 {
  readonly activity?: CodeGraphBuildActivity;
  readonly buildId: string;
  readonly coordination?: NonNullable<ObservedCodeGraphBuildStatus['coordination']>;
  readonly counters: ObservedCodeGraphBuildStatus['counters'];
  readonly error?: NonNullable<ObservedCodeGraphBuildStatus['error']>;
  readonly eta?: NonNullable<ObservedCodeGraphBuildStatus['eta']>;
  readonly identity: Pick<ObservedCodeGraphBuildStatus['identity'], 'commit' | 'worktreeId'>;
  readonly observation: ObservedCodeGraphBuildStatus['observation'];
  readonly phase: ObservedCodeGraphBuildStatus['phase'];
  readonly result?: NonNullable<ObservedCodeGraphBuildStatus['result']>;
  readonly state: ObservedCodeGraphBuildStatus['state'];
  readonly scheduling?: CodeGraphBuildScheduling;
  readonly subphase?: string;
  readonly timestamps: ObservedCodeGraphBuildStatus['timestamps'];
}

export interface CodeGraphStatusActivityProjectionV5 {
  /** Exact selector into `builds`; avoids serializing the selected summary twice. */
  readonly build: CodeGraphStatusBuildSelectionV5 | null;
  readonly builds: readonly CodeGraphStatusBuildSummaryV5[];
  readonly projection: CodeGraphStatusProjectionReceiptV3;
  readonly queuedWorktreeIds: readonly string[];
  /** Exact total, retained for compatibility with the v2 activity surface. */
  readonly waiterCount: number;
  readonly waiters: readonly CodeGraphStatusBuildSummaryV5[];
}

export type CodeGraphStatusJsonDetailsV5 = Pick<
  CodeGraphStatus,
  'databasePath' | 'identity' | 'languagePacks' | 'projectCoverage' | 'semantic' | 'stale'
> & {
  readonly locks?: {
    readonly databaseWriter?: CodeGraphStatusObservedLock;
    readonly repository?: CodeGraphStatusObservedLock & {readonly worktreeId: string};
  };
  readonly obsoleteStores: ObsoleteCodeGraphStoreInventory;
  readonly readySnapshot: CodeGraphStatus['readySnapshot'] | null;
  readonly storage: CodeGraphStorage;
};

export type CodeGraphStatusObservedLock =
  | {readonly state: 'available' | 'unverified'}
  | {readonly owner: {readonly processId: number}; readonly state: 'active'};

export type CodeGraphStatusOptionsResolution =
  | {readonly buildLimit: number; readonly error?: undefined; readonly languagePackLimit: number}
  | {readonly buildLimit?: undefined; readonly error: string; readonly languagePackLimit?: undefined};

export function codeGraphStatusBuildLimit(value: number | undefined): number | undefined {
  const candidate = value ?? CODE_GRAPH_STATUS_DEFAULT_BUILD_LIMIT;
  return Number.isSafeInteger(candidate) &&
    candidate >= CODE_GRAPH_STATUS_MINIMUM_BUILD_LIMIT &&
    candidate <= CODE_GRAPH_STATUS_MAXIMUM_BUILD_LIMIT
    ? candidate
    : undefined;
}

export function codeGraphStatusLanguagePackLimit(value: number | undefined): number | undefined {
  const candidate = value ?? CODE_GRAPH_STATUS_DEFAULT_LANGUAGE_PACK_LIMIT;
  return Number.isSafeInteger(candidate) &&
    candidate >= CODE_GRAPH_STATUS_MINIMUM_LANGUAGE_PACK_LIMIT &&
    candidate <= CODE_GRAPH_STATUS_MAXIMUM_LANGUAGE_PACK_LIMIT
    ? candidate
    : undefined;
}

export function resolveCodeGraphStatusOptions(options: {
  readonly buildLimit?: number;
  readonly json?: boolean;
  readonly languagePackLimit?: number;
}): CodeGraphStatusOptionsResolution {
  if (!options.json && options.buildLimit !== undefined) {
    return {error: 'Use --build-limit only with --json.'};
  }
  if (!options.json && options.languagePackLimit !== undefined) {
    return {error: 'Use --language-pack-limit only with --json.'};
  }
  const buildLimit = codeGraphStatusBuildLimit(options.buildLimit);
  if (buildLimit === undefined) {
    return {
      error: `Use --build-limit with an integer between ${CODE_GRAPH_STATUS_MINIMUM_BUILD_LIMIT} and ${CODE_GRAPH_STATUS_MAXIMUM_BUILD_LIMIT}.`,
    };
  }
  const languagePackLimit = codeGraphStatusLanguagePackLimit(options.languagePackLimit);
  return languagePackLimit === undefined
    ? {
        error: `Use --language-pack-limit with an integer between ${CODE_GRAPH_STATUS_MINIMUM_LANGUAGE_PACK_LIMIT} and ${CODE_GRAPH_STATUS_MAXIMUM_LANGUAGE_PACK_LIMIT}.`,
      }
    : {buildLimit, languagePackLimit};
}

/**
 * Bound only the CLI JSON projection. The complete selection remains available
 * to human rendering and Manager. The exact current worktree record is pinned
 * even when higher-priority records consume the ordinary prefix budget.
 */
export function projectCodeGraphStatusActivityV5(
  selection: CodeGraphBuildStatusSelection,
  currentWorktreeId: string,
  limit: number,
): CodeGraphStatusActivityProjectionV5 {
  const boundedLimit = codeGraphStatusBuildLimit(limit);
  if (boundedLimit === undefined) throw new RangeError('Invalid code graph status build limit.');
  const exactCurrent = EffectOption.getOrUndefined(
    EffectArray.findFirst(selection.builds, status => status.identity.worktreeId === currentWorktreeId),
  );
  const selectedBuild =
    exactCurrent ??
    EffectOption.getOrUndefined(
      EffectArray.findFirst(selection.builds, status => status.observation.liveness === 'active'),
    ) ??
    null;
  const selectedBuilds = boundedPrefixPreserving(selection.builds, selectedBuild, boundedLimit);
  const builds = EffectArray.map(selectedBuilds, projectCodeGraphStatusBuildSummaryV5);
  const waiters = EffectArray.map(selection.waiters.slice(0, boundedLimit), projectCodeGraphStatusBuildSummaryV5);
  const allQueuedWorktreeIds = stableUnique(EffectArray.map(selection.waiters, status => status.identity.worktreeId));
  const queuedWorktreeIds = allQueuedWorktreeIds.slice(0, boundedLimit);
  return {
    build:
      selectedBuild === null
        ? null
        : {
            buildId: boundedText(selectedBuild.buildId, 64),
            index: selectedBuilds.indexOf(selectedBuild),
            worktreeId: boundedText(selectedBuild.identity.worktreeId, 64),
          },
    builds,
    projection: {
      builds: listReceipt(selection.builds.length, builds.length, boundedLimit),
      queuedWorktreeIds: listReceipt(allQueuedWorktreeIds.length, queuedWorktreeIds.length, boundedLimit),
      waiters: listReceipt(selection.waiters.length, waiters.length, boundedLimit),
    },
    queuedWorktreeIds,
    waiterCount: selection.waiters.length,
    waiters,
  };
}

export function serializeCodeGraphStatusV5(
  selection: CodeGraphBuildStatusSelection,
  currentWorktreeId: string,
  buildLimit: number,
  languagePackLimit: number,
  details: CodeGraphStatusJsonDetailsV5,
): string {
  const activity = projectCodeGraphStatusActivityV5(selection, currentWorktreeId, buildLimit);
  const languagePacks = projectCodeGraphStatusLanguagePacksV4(details.languagePacks, languagePackLimit);
  return JSON.stringify({
    ...activity,
    ...details,
    languagePacks: languagePacks.items,
    projection: {
      ...activity.projection,
      languagePacks: languagePacks.receipt,
    } satisfies CodeGraphStatusProjectionReceiptV5,
    type: 'code-graph-status',
    version: 5,
  });
}

export function projectCodeGraphStatusBuildSummaryV5(
  status: ObservedCodeGraphBuildStatus,
): CodeGraphStatusBuildSummaryV5 {
  const retainsActiveActivity = status.state === 'queued' || status.state === 'running';
  const scheduling = parseCodeGraphBuildScheduling(status.scheduling);
  const capacity = parseCapacityFailure(status.error?.capacity);
  return {
    ...(retainsActiveActivity && status.activity
      ? {activity: projectCodeGraphStatusBuildActivityV5(status.activity)}
      : {}),
    buildId: boundedText(status.buildId, 64),
    ...(scheduling ? {scheduling} : {}),
    ...(status.coordination
      ? {
          coordination: {
            lockVerified: status.coordination.lockVerified,
            ...(status.coordination.progressSilent === undefined
              ? {}
              : {progressSilent: status.coordination.progressSilent}),
            role: status.coordination.role,
          },
        }
      : {}),
    counters: definedProperties(status.counters, [
      'accepted',
      'completed',
      'edges',
      'embedded',
      'excluded',
      'pagesCompleted',
      'reused',
      'resolved',
      'rowsDeleted',
      'skipped',
      'symbols',
      'total',
      'unit',
    ]),
    ...(status.error
      ? {
          error: {
            summary: boundedText(status.error.summary, 300),
            ...(capacity === undefined ? {} : {capacity}),
          },
        }
      : {}),
    ...(status.eta
      ? {
          eta: {
            ...(status.eta.basis ? {basis: status.eta.basis} : {}),
            confidence: status.eta.confidence,
            remainingMilliseconds: status.eta.remainingMilliseconds,
            scope: status.eta.scope,
          },
        }
      : {}),
    identity: {
      commit: boundedText(status.identity.commit, 64),
      worktreeId: boundedText(status.identity.worktreeId, 64),
    },
    observation: {
      heartbeatAgeMilliseconds: status.observation.heartbeatAgeMilliseconds,
      liveness: status.observation.liveness,
      ...(status.observation.reason ? {reason: status.observation.reason} : {}),
    },
    phase: status.phase,
    ...(status.result
      ? {
          result: {
            dirty: status.result.dirty,
            edges: status.result.edges,
            files: status.result.files,
            ...(status.result.overlayAssessment
              ? {overlayAssessment: {outcome: status.result.overlayAssessment.outcome}}
              : {}),
            snapshotId: boundedText(status.result.snapshotId, 128),
            symbols: status.result.symbols,
          },
        }
      : {}),
    state: status.state,
    ...(status.subphase ? {subphase: boundedText(status.subphase, 64)} : {}),
    timestamps: {
      ...(status.timestamps.completedAt ? {completedAt: boundedText(status.timestamps.completedAt, 64)} : {}),
      heartbeatAt: boundedText(status.timestamps.heartbeatAt, 64),
      lastProgressAt: boundedText(status.timestamps.lastProgressAt, 64),
      phaseStartedAt: boundedText(status.timestamps.phaseStartedAt, 64),
      startedAt: boundedText(status.timestamps.startedAt, 64),
      updatedAt: boundedText(status.timestamps.updatedAt, 64),
    },
  };
}

function projectCodeGraphStatusBuildActivityV5(activity: CodeGraphBuildActivity): CodeGraphBuildActivity {
  return {
    batchCompleted: activity.batchCompleted,
    batchTotal: activity.batchTotal,
    bytes: activity.bytes,
    ...(activity.classifier ? {classifier: boundedText(activity.classifier, 64)} : {}),
    ...(activity.degraded === undefined ? {} : {degraded: activity.degraded}),
    ...(activity.factsBytes === undefined ? {} : {factsBytes: activity.factsBytes}),
    language: boundedText(activity.language, 64),
    ...(activity.parseMilliseconds === undefined ? {} : {parseMilliseconds: activity.parseMilliseconds}),
    ...(activity.persistMilliseconds === undefined ? {} : {persistMilliseconds: activity.persistMilliseconds}),
    ...(activity.relations === undefined ? {} : {relations: activity.relations}),
    ...(activity.role ? {role: boundedText(activity.role, 64)} : {}),
    ...(activity.sizeBucket ? {sizeBucket: activity.sizeBucket} : {}),
    stage: activity.stage,
    ...(activity.symbols === undefined ? {} : {symbols: activity.symbols}),
  };
}

export function projectCodeGraphStatusLanguagePacksV4(
  languagePacks: CodeGraphStatus['languagePacks'],
  limit: number,
): {readonly items: CodeGraphStatus['languagePacks']; readonly receipt: CodeGraphStatusBoundedListReceiptV3} {
  const boundedLimit = codeGraphStatusLanguagePackLimit(limit);
  if (boundedLimit === undefined) throw new RangeError('Invalid code graph status language-pack limit.');
  const items = languagePacks.slice(0, boundedLimit);
  return {items, receipt: listReceipt(languagePacks.length, items.length, boundedLimit)};
}

function boundedPrefixPreserving<T>(items: readonly T[], required: T | null, limit: number): readonly T[] {
  const projected = items.slice(0, limit);
  if (required === null || projected.includes(required)) return projected;
  return [...projected.slice(0, -1), required];
}

function stableUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function boundedText(value: string, maximumBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const codePoint of value) {
    const codePointBytes = Buffer.byteLength(codePoint, 'utf8');
    if (bytes > maximumBytes - codePointBytes) break;
    bytes += codePointBytes;
    end += codePoint.length;
  }
  return Effect.pipe(value, EffectString.slice(0, end));
}

function definedProperties<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Partial<Pick<T, K>> {
  const result: Partial<Pick<T, K>> = {};
  for (const key of keys) {
    if (value[key] !== undefined) Reflect.set(result, key, value[key]);
  }
  return result;
}

function listReceipt(total: number, returned: number, limit: number): CodeGraphStatusBoundedListReceiptV3 {
  return {limit, omitted: total - returned, returned, total};
}
