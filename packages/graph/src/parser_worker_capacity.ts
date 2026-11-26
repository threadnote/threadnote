export const CODE_GRAPH_PARSER_WORKERS_ENV = 'THREADNOTE_CODE_GRAPH_PARSER_WORKERS';
export const CODE_GRAPH_NATIVE_PARSER_WORKERS_ENV = 'THREADNOTE_CODE_GRAPH_NATIVE_PARSER_WORKERS';

const PARSER_WORKER_MEMORY_BYTES_PER_SLOT = 8 * 1_024 * 1_024 * 1_024;

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
