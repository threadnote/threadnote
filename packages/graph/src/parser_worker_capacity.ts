import {Effect} from 'effect';
import type {CodeGraphParserPoolShape, ParserWorkerConfigurationError} from './parser_worker.js';

export const CODE_GRAPH_PARSER_WORKERS_ENV = 'THREADNOTE_CODE_GRAPH_PARSER_WORKERS';
export const CODE_GRAPH_NATIVE_PARSER_WORKERS_ENV = 'THREADNOTE_CODE_GRAPH_NATIVE_PARSER_WORKERS';

const PARSER_WORKER_MEMORY_BYTES_PER_SLOT = 8 * 1_024 * 1_024 * 1_024;

/** Which kinds of planned parser work exist: native TypeScript, and every other parser-bound language. */
export interface CodeGraphParserLanePlan {
  readonly native: boolean;
  readonly general: boolean;
  /** General slots the planned work needs (`plannedGeneralParserLanes`); every general slot when omitted. */
  readonly generalSlots?: number;
}

export type ParserWorkerEnvironment = Readonly<Record<string, string | undefined>>;

export interface ParserWorkerCapacityInput {
  readonly effectiveMemoryBytes?: number;
  readonly environment: ParserWorkerEnvironment;
  readonly hardwareConcurrency: number;
  readonly override?: number;
}

/** Slots that may own a native TypeScript compiler pair: an explicit 1..capacity, else a quarter of capacity. */
export function nativeParserWorkerCapacity(capacity: number, environment: ParserWorkerEnvironment): number {
  const configured = Number.parseInt(environment[CODE_GRAPH_NATIVE_PARSER_WORKERS_ENV] ?? '', 10);
  return Number.isSafeInteger(configured) && configured > 0
    ? Math.min(capacity, configured)
    : Math.max(1, Math.floor(capacity / 4));
}

export function parserWorkerCapacity(input: ParserWorkerCapacityInput): number {
  const explicit = explicitParserWorkerCapacity(input.environment, input.override);
  if (explicit !== undefined) return explicit;
  const hardwareConcurrency =
    Number.isSafeInteger(input.hardwareConcurrency) && input.hardwareConcurrency > 0 ? input.hardwareConcurrency : 1;
  const cpuCapacity = Math.max(1, Math.min(4, Math.floor(hardwareConcurrency / 2)));
  const effectiveMemoryBytes = input.effectiveMemoryBytes;
  if (
    typeof effectiveMemoryBytes !== 'number' ||
    !Number.isSafeInteger(effectiveMemoryBytes) ||
    effectiveMemoryBytes <= 0
  ) {
    return 1;
  }
  const memoryCapacity = Math.max(1, Math.floor(effectiveMemoryBytes / PARSER_WORKER_MEMORY_BYTES_PER_SLOT));
  return Math.min(cpuCapacity, memoryCapacity);
}

export function explicitParserWorkerCapacity(
  environment: ParserWorkerEnvironment,
  override?: number,
): number | undefined {
  if (Number.isSafeInteger(override) && override! > 0) return Math.min(8, override!);
  const configured = Number.parseInt(environment[CODE_GRAPH_PARSER_WORKERS_ENV] ?? '', 10);
  return Number.isSafeInteger(configured) && configured > 0 ? Math.min(8, configured) : undefined;
}

export function currentHardwareConcurrency(): number {
  try {
    return navigator.hardwareConcurrency || 1;
  } catch {
    return 1;
  }
}

/**
 * General lanes to run beside the native TypeScript lanes. Each general lane keeps a resident parser worker, so a
 * build runs only enough of them to finish its general work, by static work units, no later than the native lanes
 * finish theirs. Without planned native work or native slots, every general slot runs. At least one general lane runs
 * whenever a general slot exists, so planned general work is never stranded.
 */
export function plannedGeneralParserLanes(
  slots: {readonly nativeCapacity: number; readonly generalCapacity: number},
  work: {readonly nativeWorkUnits: number; readonly generalWorkUnits: number},
): number {
  const generalCapacity = Number.isSafeInteger(slots.generalCapacity) ? Math.max(0, slots.generalCapacity) : 0;
  if (generalCapacity === 0) return 0;
  const {nativeWorkUnits, generalWorkUnits} = work;
  if (
    !Number.isSafeInteger(slots.nativeCapacity) ||
    slots.nativeCapacity <= 0 ||
    !Number.isFinite(nativeWorkUnits) ||
    nativeWorkUnits <= 0 ||
    !Number.isFinite(generalWorkUnits)
  ) {
    return generalCapacity;
  }
  const needed = Math.ceil((Math.max(0, generalWorkUnits) * slots.nativeCapacity) / nativeWorkUnits);
  return Math.min(generalCapacity, Math.max(1, needed));
}

/**
 * General lanes for one extraction window. A window without native work also takes the idle native share, so it keeps
 * the busy lane count of a mixed window. Without a plan, or without native slots, every general slot runs.
 */
export function windowGeneralParserLanes(
  slots: {readonly nativeCapacity: number; readonly generalCapacity: number},
  work: {readonly nativeWorkUnits: number; readonly generalWorkUnits: number} | undefined,
  windowHasNativeWork: boolean,
): number {
  if (work === undefined || slots.nativeCapacity <= 0) return Math.max(0, slots.generalCapacity);
  const planned = plannedGeneralParserLanes(slots, work);
  return Math.min(planned + (windowHasNativeWork ? 0 : slots.nativeCapacity), Math.max(0, slots.generalCapacity));
}

/** Prewarm the planned lanes (every slot without evidence) with the worker kind the inventory needs. */
export function warmPlannedParserCapacity(
  pool: CodeGraphParserPoolShape,
  threadnoteHome: string,
  fileCount: number,
  work?: {
    readonly nativeTypeScript: boolean;
    readonly general: boolean;
    readonly nativeWorkUnits?: number;
    readonly generalWorkUnits?: number;
  },
): Effect.Effect<void, ParserWorkerConfigurationError> {
  const generalSlots =
    work?.nativeWorkUnits === undefined || work.generalWorkUnits === undefined
      ? undefined
      : plannedGeneralParserLanes(
          {nativeCapacity: pool.nativeCapacity, generalCapacity: pool.capacity - pool.nativeCapacity},
          {nativeWorkUnits: work.nativeWorkUnits, generalWorkUnits: work.generalWorkUnits},
        );
  const lanes = work && {
    native: work.nativeTypeScript,
    general: work.general,
    ...(generalSlots === undefined ? {} : {generalSlots}),
  };
  return fileCount <= pool.capacity ? Effect.void : pool.warm(threadnoteHome, fileCount, work?.nativeTypeScript, lanes);
}
