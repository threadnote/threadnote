import * as EffectString from 'effect/String';
import * as Effect from 'effect';
export const CODE_GRAPH_SLOW_FILE_THRESHOLD_MILLISECONDS = 1_000;
export const CODE_GRAPH_TOP_SLOW_FILE_LIMIT = 10;

export const CODE_GRAPH_SCANNING_STARTED_PROGRESS = {
  accepted: 0,
  completed: 0,
  excluded: 0,
  phase: 'scanning',
  skipped: 0,
  total: 0,
  unit: 'files',
} as const;

export const CODE_GRAPH_SOURCE_SIZE_BUCKETS = ['0-16KiB', '16-64KiB', '64-256KiB', '256KiB-1MiB', '>1MiB'] as const;

export type CodeGraphSourceSizeBucket = (typeof CODE_GRAPH_SOURCE_SIZE_BUCKETS)[number];

export interface CodeGraphSlowFileTelemetry {
  readonly classifier: string;
  readonly degraded?: boolean;
  readonly durationMilliseconds: number;
  readonly extension: string;
  readonly factsBytes?: number;
  readonly language: string;
  readonly pathHash: string;
  readonly relations?: number;
  readonly role: string;
  readonly sizeBucket: CodeGraphSourceSizeBucket;
  readonly sourceBytes: number;
  readonly symbols?: number;
}

export interface CodeGraphExtractionPlanMetrics {
  readonly sourceBytesTotal: number;
  /** Source bytes weighted by language and size class; never a wall-time claim. */
  readonly workUnitsTotal: number;
}

export interface CodeGraphScanningMetrics extends CodeGraphExtractionPlanMetrics {
  readonly degradedFiles?: number;
  readonly factsBytesCompleted: number;
  readonly sourceBytesCompleted: number;
  readonly workUnitsCompleted: number;
}

const STRUCTURED_EXTRACTION_LANGUAGES = new Set([
  'graphql',
  'ini',
  'json',
  'jsonc',
  'msbuild',
  'properties',
  'protobuf',
  'solution',
  'sql',
  'toml',
  'xaml',
  'yaml',
]);

export function codeGraphSourceSizeBucket(bytes: number): CodeGraphSourceSizeBucket {
  if (bytes <= 16 * 1_024) return '0-16KiB';
  if (bytes <= 64 * 1_024) return '16-64KiB';
  if (bytes <= 256 * 1_024) return '64-256KiB';
  if (bytes <= 1_024 * 1_024) return '256KiB-1MiB';
  return '>1MiB';
}

export function isCodeGraphSourceSizeBucket(value: unknown): value is CodeGraphSourceSizeBucket {
  return (
    value === '0-16KiB' || value === '16-64KiB' || value === '64-256KiB' || value === '256KiB-1MiB' || value === '>1MiB'
  );
}

/**
 * Deterministic extraction work denominator. The ETA rate is still calibrated
 * from observed wall time; this only prevents one tiny TS file and one large
 * structured file from counting as equivalent remaining work.
 */
export function codeGraphExtractionWorkUnits(
  sourceBytes: number,
  language: string,
  sizeBucket: CodeGraphSourceSizeBucket,
): number {
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 0) {
    throw new Error('Code graph extraction source bytes are invalid.');
  }
  const languageWeight = STRUCTURED_EXTRACTION_LANGUAGES.has(language)
    ? 4
    : /^(?:javascript|javascriptreact|typescript|typescriptreact)$/u.test(language)
      ? 2
      : 1;
  const sizeWeight = sizeBucket === '>1MiB' ? 4 : sizeBucket === '256KiB-1MiB' ? 3 : sizeBucket === '64-256KiB' ? 2 : 1;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, sourceBytes) * languageWeight * sizeWeight);
}

export function codeGraphExtractionPlanMetrics(
  files: readonly {readonly language: string; readonly size: number}[],
): CodeGraphExtractionPlanMetrics {
  let sourceBytesTotal = 0;
  let workUnitsTotal = 0;
  for (const file of files) {
    sourceBytesTotal = saturatingAdd(sourceBytesTotal, file.size);
    workUnitsTotal = saturatingAdd(
      workUnitsTotal,
      codeGraphExtractionWorkUnits(file.size, file.language, codeGraphSourceSizeBucket(file.size)),
    );
  }
  return {sourceBytesTotal, workUnitsTotal};
}

/**
 * Retains a deterministic, bounded top-slow set independent of completion
 * order. Path hashes are the final tie-breaker and never expose source paths.
 */
export function retainCodeGraphSlowFileTelemetry(
  current: readonly CodeGraphSlowFileTelemetry[],
  candidate: CodeGraphSlowFileTelemetry,
  limit = CODE_GRAPH_TOP_SLOW_FILE_LIMIT,
): readonly CodeGraphSlowFileTelemetry[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) return [];
  return [...current, candidate]
    .sort(
      (left, right) =>
        right.durationMilliseconds - left.durationMilliseconds ||
        Effect.pipe(left.pathHash, EffectString.localeCompare(right.pathHash)) ||
        Effect.pipe(left.language, EffectString.localeCompare(right.language)),
    )
    .slice(0, limit);
}

export function codeGraphPathExtension(path: string): string {
  const basename = Effect.pipe(path, EffectString.split('/')).at(-1) ?? '';
  const separator = Effect.pipe(
    basename,
    EffectString.lastIndexOf('.'),
    Effect.Option.getOrElse(() => -1),
  );
  if (separator <= 0 || separator === basename.length - 1) return 'none';
  return Effect.pipe(basename, EffectString.slice(separator, separator + 16), EffectString.toLowerCase);
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}
