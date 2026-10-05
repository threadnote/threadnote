import {Effect, Option, Predicate, Stream, Schema} from 'effect';
import * as ChildProcess from 'effect/process/ChildProcess';
import {SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {developmentStandaloneScript} from '../isolated/builder.js';
import type {CodeGraphStoreRecovery} from '../types.js';
import type {
  CodeGraphWorksetPrepareBridgeReceiptV1,
  CodeGraphWorksetPrepareCoverageV1,
  CodeGraphWorksetPrepareFailureCodeV1,
  CodeGraphWorksetPrepareIndexActivityV1,
  CodeGraphWorksetPrepareMemberV1,
  CodeGraphWorksetPrepareProgressV1,
  CodeGraphWorksetPrepareResultV1,
  PrepareCodeGraphWorksetOptionsV1,
} from './workset.js';

export const CODE_GRAPH_MANAGER_WORKSET_ORCHESTRATOR_ENV = 'THREADNOTE_MANAGER_WORKSET_ORCHESTRATOR';
const ISOLATED_WORKSET_STDOUT_BYTES_MAXIMUM = 8 * 1_048_576;
const ISOLATED_WORKSET_PROGRESS_LINE_BYTES_MAXIMUM = 64 * 1_024;
const ISOLATED_WORKSET_MEMBER_MAXIMUM = 4_096;
const ISOLATED_WORKSET_TEXT_MAXIMUM = 4_096;
const WORKSET_PROGRESS_PHASES = [
  'bridging',
  'cataloging',
  'completed',
  'failed',
  'indexing',
  'projecting',
  'publishing',
  'starting',
  'waiting',
] as const;
const GRAPH_PROGRESS_PHASES = [
  'activating',
  'embedding',
  'materializing',
  'reclaiming',
  'registering',
  'resolving',
  'scanning',
  'waiting',
] as const;
const GRAPH_WAITING_REASONS = [
  'database-writer',
  'disk-capacity',
  'home-builder-cap',
  'prepared-spool-budget',
  'repository-lock',
  'request-lock',
  'snapshot-build',
] as const;
const STORE_RECOVERIES = [
  'defer',
  'diagnose',
  'fix-permissions',
  'free-space',
  'manual-migration',
  'manual-rebuild',
  'migrate-additive',
  'reconnect-runtime',
  'retry-read-only',
] as const satisfies readonly CodeGraphStoreRecovery[];
const WORKSET_PREPARE_FAILURE_CODES = [
  'busy',
  'catalog',
  'confirmed-corruption',
  'incompatible-schema',
  'no-space',
  'permission',
  'repository',
  'schema-additive',
  'transient-io',
  'unknown',
  'worktree-changed',
] as const satisfies readonly CodeGraphWorksetPrepareFailureCodeV1[];

export class CodeGraphIsolatedWorksetPrepareError extends Schema.TaggedError<CodeGraphIsolatedWorksetPrepareError>()(
  'CodeGraphIsolatedWorksetPrepareError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

export interface CodeGraphIsolatedWorksetPrepareSpawnPlan {
  readonly arguments: readonly string[];
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly executable: string;
}

export function codeGraphIsolatedWorksetPrepareSpawnPlan(
  system: SystemInfoShape,
  options: {
    readonly concurrency?: number;
    readonly manifestPath: string;
    readonly threadnoteHome: string;
    readonly workset: string;
  },
): CodeGraphIsolatedWorksetPrepareSpawnPlan {
  return {
    arguments: [
      ...Option.toArray(developmentStandaloneScript(system)),
      '--home',
      options.threadnoteHome,
      '--manifest',
      options.manifestPath,
      'workset',
      'prepare',
      '--json',
      ...(options.concurrency === undefined ? [] : ['--concurrency', String(options.concurrency)]),
      options.workset,
    ],
    environment: {
      ...system.intendedChildEnvironment(system.environment(), 'graph-builder'),
      [CODE_GRAPH_MANAGER_WORKSET_ORCHESTRATOR_ENV]: '1',
      THREADNOTE_HOME: options.threadnoteHome,
      THREADNOTE_MANIFEST: options.manifestPath,
    },
    executable: system.executablePath,
  };
}

/** Run every workset preparation phase outside a long-lived Manager process. */
export const runIsolatedCodeGraphWorksetPrepare = Effect.fn('codeGraph.workset.prepareIsolated')(function* (
  input: {
    readonly manifestPath: string;
    readonly threadnoteHome: string;
    readonly workset: string;
  },
  options: PrepareCodeGraphWorksetOptionsV1 = {},
) {
  const system = yield* SystemInfo;
  const plan = codeGraphIsolatedWorksetPrepareSpawnPlan(system, {
    concurrency: options.concurrency,
    manifestPath: input.manifestPath,
    threadnoteHome: input.threadnoteHome,
    workset: input.workset,
  });
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* ChildProcess.make(plan.executable, [...plan.arguments], {
        env: {...plan.environment},
        forceKillAfter: 1_000,
        stdin: 'ignore',
      }).pipe(
        Effect.mapError(cause =>
          CodeGraphIsolatedWorksetPrepareError.make({cause, message: 'Could not start isolated workset preparation.'}),
        ),
      );
      const [stdout, , exitCode] = yield* Effect.all(
        [
          collectBoundedWorksetOutput(handle.stdout),
          consumeIsolatedWorksetProgress(handle.stderr, input.workset, options.onProgress),
          handle.exitCode.pipe(Effect.map(Number)),
        ] as const,
        {concurrency: 'unbounded'},
      );
      const result = decodeIsolatedWorksetPrepareResult(stdout);
      if (result === undefined || result.workset !== input.workset) {
        return yield* CodeGraphIsolatedWorksetPrepareError.make({
          message: `Isolated workset preparation exited with code ${exitCode} without a valid result.`,
        });
      }
      if (exitCode !== 0 && result.state !== 'failed') {
        return yield* CodeGraphIsolatedWorksetPrepareError.make({
          message: `Isolated workset preparation exited with code ${exitCode}.`,
        });
      }
      return result;
    }),
  );
});

export function prepareManagerCodeGraphWorksetIsolated(
  config: RuntimeConfig,
  workset: string,
  options: PrepareCodeGraphWorksetOptionsV1,
) {
  return runIsolatedCodeGraphWorksetPrepare(
    {manifestPath: config.manifestPath, threadnoteHome: config.agentContextHome, workset},
    options,
  );
}

function collectBoundedWorksetOutput(stream: Stream.Stream<Uint8Array, unknown>) {
  const encoder = new TextEncoder();
  return stream.pipe(
    Stream.decodeText,
    Stream.runFoldEffect(
      () => ({chunks: [] as string[], size: 0}),
      (state, chunk) => {
        const size = state.size + encoder.encode(chunk).byteLength;
        if (size > ISOLATED_WORKSET_STDOUT_BYTES_MAXIMUM) {
          return Effect.fail(
            CodeGraphIsolatedWorksetPrepareError.make({message: 'Isolated workset result was too large.'}),
          );
        }
        state.chunks.push(chunk);
        return Effect.succeed({chunks: state.chunks, size});
      },
    ),
    Effect.map(state => state.chunks.join('')),
  );
}

function consumeIsolatedWorksetProgress(
  stream: Stream.Stream<Uint8Array, unknown>,
  expectedWorkset: string,
  onProgress: PrepareCodeGraphWorksetOptionsV1['onProgress'],
) {
  const lines = makeIsolatedWorksetProgressLineDecoder();
  return stream.pipe(
    Stream.runForEach(chunk =>
      Effect.forEach(
        lines.push(chunk),
        line => {
          const progress = decodeIsolatedWorksetPrepareProgress(line);
          if (progress === undefined || progress.workset !== expectedWorkset) return Effect.void;
          return (onProgress?.(progress) ?? Effect.void).pipe(Effect.ignore);
        },
        {discard: true},
      ),
    ),
  );
}

/**
 * Incrementally frame stderr before decoding it. The fixed-size buffer is
 * abandoned as soon as one unfinished record exceeds the protocol limit, and
 * input is ignored until its newline so a faulty child cannot grow the Manager
 * heap while still allowing later valid progress records through.
 */
export function makeIsolatedWorksetProgressLineDecoder(): {
  readonly bufferedBytes: () => number;
  readonly push: (chunk: Uint8Array) => readonly string[];
} {
  const buffer = new Uint8Array(ISOLATED_WORKSET_PROGRESS_LINE_BYTES_MAXIMUM);
  const decoder = new TextDecoder();
  let bufferedBytes = 0;
  let discardingOversizedLine = false;

  const append = (bytes: Uint8Array): void => {
    if (bytes.byteLength === 0 || discardingOversizedLine) return;
    if (bytes.byteLength > buffer.byteLength - bufferedBytes) {
      bufferedBytes = 0;
      discardingOversizedLine = true;
      return;
    }
    buffer.set(bytes, bufferedBytes);
    bufferedBytes += bytes.byteLength;
  };

  return {
    bufferedBytes: () => bufferedBytes,
    push: chunk => {
      const decoded: string[] = [];
      let segmentStart = 0;
      for (let index = 0; index < chunk.byteLength; index += 1) {
        if (chunk[index] !== 0x0a) continue;
        append(chunk.subarray(segmentStart, index));
        if (!discardingOversizedLine) {
          const lineBytes = bufferedBytes > 0 && buffer[bufferedBytes - 1] === 0x0d ? bufferedBytes - 1 : bufferedBytes;
          decoded.push(decoder.decode(buffer.subarray(0, lineBytes)));
        }
        bufferedBytes = 0;
        discardingOversizedLine = false;
        segmentStart = index + 1;
      }
      append(chunk.subarray(segmentStart));
      return decoded;
    },
  };
}

export function decodeIsolatedWorksetPrepareProgress(content: string): CodeGraphWorksetPrepareProgressV1 | undefined {
  if (new TextEncoder().encode(content).byteLength > ISOLATED_WORKSET_PROGRESS_LINE_BYTES_MAXIMUM) return undefined;
  const value = jsonRecord(content);
  if (
    value === undefined ||
    value.type !== 'code-graph-workset-progress' ||
    value.version !== 1 ||
    !boundedText(value.workset) ||
    !boundedText(value.message) ||
    !isOneOf(value.phase, WORKSET_PROGRESS_PHASES) ||
    !nonnegativeInteger(value.completed) ||
    !nonnegativeInteger(value.elapsedMilliseconds) ||
    !nonnegativeInteger(value.total)
  ) {
    return undefined;
  }
  const activity = decodeIndexActivity(value.activity);
  if (value.activity !== undefined && activity === undefined) return undefined;
  if (value.attempt !== undefined && !nonnegativeInteger(value.attempt)) return undefined;
  if (value.maxAttempts !== undefined && !nonnegativeInteger(value.maxAttempts)) return undefined;
  if (value.project !== undefined && !boundedText(value.project)) return undefined;
  return {
    ...(activity === undefined ? {} : {activity}),
    ...(value.attempt === undefined ? {} : {attempt: value.attempt}),
    completed: value.completed,
    elapsedMilliseconds: value.elapsedMilliseconds,
    ...(value.maxAttempts === undefined ? {} : {maxAttempts: value.maxAttempts}),
    message: value.message,
    phase: value.phase,
    ...(value.project === undefined ? {} : {project: value.project}),
    total: value.total,
    type: 'code-graph-workset-progress',
    version: 1,
    workset: value.workset,
  };
}

export function decodeIsolatedWorksetPrepareResult(content: string): CodeGraphWorksetPrepareResultV1 | undefined {
  const value = jsonRecord(content);
  if (
    value === undefined ||
    value.type !== 'code-graph-workset-prepare' ||
    value.version !== 1 ||
    (value.state !== 'failed' && value.state !== 'ready') ||
    !boundedText(value.workset) ||
    !digest(value.manifestDigest) ||
    !Array.isArray(value.members) ||
    value.members.length > ISOLATED_WORKSET_MEMBER_MAXIMUM
  ) {
    return undefined;
  }
  const coverage = decodeCoverage(value.coverage);
  const members: CodeGraphWorksetPrepareMemberV1[] = [];
  for (const rawMember of value.members) {
    const member = decodeMember(rawMember);
    if (member === undefined) return undefined;
    members.push(member);
  }
  if (coverage === undefined) return undefined;
  const published = decodePublished(value.published);
  const bridges = decodeBridges(value.bridges);
  if (value.published !== undefined && published === undefined) return undefined;
  if (value.bridges !== undefined && bridges === undefined) return undefined;
  return {
    ...(bridges === undefined ? {} : {bridges}),
    coverage,
    manifestDigest: value.manifestDigest,
    members,
    ...(published === undefined ? {} : {published}),
    state: value.state,
    type: 'code-graph-workset-prepare',
    version: 1,
    workset: value.workset,
  };
}

function decodeIndexActivity(value: unknown): CodeGraphWorksetPrepareIndexActivityV1 | undefined {
  if (value === undefined) return undefined;
  if (!Predicate.isObject(value) || !isOneOf(value.phase, GRAPH_PROGRESS_PHASES)) return undefined;
  const completed =
    value.completed === undefined ? undefined : nonnegativeInteger(value.completed) ? value.completed : undefined;
  if (value.completed !== undefined && completed === undefined) return undefined;
  const total = value.total === undefined ? undefined : nonnegativeInteger(value.total) ? value.total : undefined;
  if (value.total !== undefined && total === undefined) return undefined;
  const reason =
    value.reason === undefined ? undefined : isOneOf(value.reason, GRAPH_WAITING_REASONS) ? value.reason : undefined;
  if (value.reason !== undefined && reason === undefined) return undefined;
  const subphase = value.subphase === undefined ? undefined : boundedText(value.subphase) ? value.subphase : undefined;
  if (value.subphase !== undefined && subphase === undefined) return undefined;
  const unit =
    value.unit === undefined
      ? undefined
      : isOneOf(value.unit, ['files', 'snapshots', 'symbols'])
        ? value.unit
        : undefined;
  if (value.unit !== undefined && unit === undefined) return undefined;
  return {
    ...(completed === undefined ? {} : {completed}),
    phase: value.phase,
    ...(reason === undefined ? {} : {reason}),
    ...(subphase === undefined ? {} : {subphase}),
    ...(total === undefined ? {} : {total}),
    ...(unit === undefined ? {} : {unit}),
  };
}

function decodeCoverage(value: unknown): CodeGraphWorksetPrepareCoverageV1 | undefined {
  if (!Predicate.isObject(value) || typeof value.complete !== 'boolean') return undefined;
  const excluded = nonnegativeInteger(value.excluded) ? value.excluded : undefined;
  const failed = nonnegativeInteger(value.failed) ? value.failed : undefined;
  const missing = nonnegativeInteger(value.missing) ? value.missing : undefined;
  const ready = nonnegativeInteger(value.ready) ? value.ready : undefined;
  const requested = nonnegativeInteger(value.requested) ? value.requested : undefined;
  if (
    excluded === undefined ||
    failed === undefined ||
    missing === undefined ||
    ready === undefined ||
    requested === undefined
  )
    return undefined;
  return {
    complete: value.complete,
    excluded,
    failed,
    missing,
    ready,
    requested,
  };
}

function decodeMember(value: unknown): CodeGraphWorksetPrepareMemberV1 | undefined {
  if (!Predicate.isObject(value) || !boundedText(value.project)) return undefined;
  switch (value.state) {
    case 'ready':
      return digest(value.projectionDigest) &&
        digest(value.repositoryId) &&
        boundedText(value.snapshotId) &&
        nonnegativeInteger(value.symbolCount)
        ? {
            project: value.project,
            projectionDigest: value.projectionDigest,
            repositoryId: value.repositoryId,
            snapshotId: value.snapshotId,
            state: 'ready',
            symbolCount: value.symbolCount,
          }
        : undefined;
    case 'excluded':
      return value.reason === 'unknown-project'
        ? {project: value.project, reason: 'unknown-project', state: 'excluded'}
        : undefined;
    case 'missing':
      return value.reason === 'missing-path'
        ? {project: value.project, reason: 'missing-path', state: 'missing'}
        : undefined;
    case 'failed': {
      if (
        (value.reason !== 'index-failed' && value.reason !== 'projection-failed') ||
        !Predicate.isObject(value.detail)
      ) {
        return undefined;
      }
      const detail = value.detail;
      const recovery = isOneOf(detail.recovery, STORE_RECOVERIES) ? detail.recovery : undefined;
      const code = isOneOf(detail.code, WORKSET_PREPARE_FAILURE_CODES) ? detail.code : undefined;
      if (
        code === undefined ||
        !boundedText(detail.errorType) ||
        (detail.recovery !== undefined && recovery === undefined) ||
        typeof detail.retryable !== 'boolean' ||
        !boundedText(detail.summary)
      ) {
        return undefined;
      }
      return {
        detail: {
          code,
          errorType: detail.errorType,
          ...(recovery === undefined ? {} : {recovery}),
          retryable: detail.retryable,
          summary: detail.summary,
        },
        project: value.project,
        reason: value.reason,
        state: 'failed',
      };
    }
    default:
      return undefined;
  }
}

function decodePublished(value: unknown): CodeGraphWorksetPrepareResultV1['published'] | undefined {
  if (value === undefined) return undefined;
  if (
    !Predicate.isObject(value) ||
    !digest(value.digest) ||
    !boundedText(value.id) ||
    !digest(value.manifestDigest) ||
    !nonnegativeInteger(value.memberCount) ||
    value.state !== 'ready' ||
    !boundedText(value.worksetName)
  ) {
    return undefined;
  }
  return {
    digest: value.digest,
    id: value.id,
    manifestDigest: value.manifestDigest,
    memberCount: value.memberCount,
    state: 'ready',
    worksetName: value.worksetName,
  };
}

function decodeBridges(value: unknown): CodeGraphWorksetPrepareBridgeReceiptV1 | undefined {
  if (value === undefined) return undefined;
  if (
    !Predicate.isObject(value) ||
    !nonnegativeInteger(value.bridgeCount) ||
    !digest(value.digest) ||
    !nonnegativeInteger(value.monikerCount) ||
    !nonnegativeInteger(value.rejectionCount) ||
    !nonnegativeInteger(value.resolverVersion) ||
    (value.state !== 'ready' && value.state !== 'unavailable') ||
    !boundedTextArray(value.unavailableRepositories) ||
    !boundedTextArray(value.warnings)
  ) {
    return undefined;
  }
  return {
    bridgeCount: value.bridgeCount,
    digest: value.digest,
    monikerCount: value.monikerCount,
    rejectionCount: value.rejectionCount,
    resolverVersion: value.resolverVersion,
    state: value.state,
    unavailableRepositories: value.unavailableRepositories,
    warnings: value.warnings,
  };
}

function jsonRecord(content: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const value: unknown = JSON.parse(content.trim());
    return Predicate.isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function boundedText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= ISOLATED_WORKSET_TEXT_MAXIMUM;
}

function boundedTextArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= ISOLATED_WORKSET_MEMBER_MAXIMUM && value.every(boundedText);
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isOneOf<const Values extends readonly string[]>(value: unknown, options: Values): value is Values[number] {
  return typeof value === 'string' && options.some(option => option === value);
}
