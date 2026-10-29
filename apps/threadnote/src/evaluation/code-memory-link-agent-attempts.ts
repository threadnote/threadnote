import {Array as EffectArray, Schema} from 'effect';
import {Effect, FileSystem, Option, Path, Predicate} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import type {CodeMemoryLinkAgentAbManifestV1, CodeMemoryLinkAgentAbTrialV1} from './code-memory-link-agent-ab.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const CODE_MEMORY_LINK_AGENT_ATTEMPT_VERSION = 1 as const;
export const CODE_MEMORY_LINK_AGENT_RETRY_REASONS = [
  'client-execution',
  'client-no-action-budget',
  'client-output',
  'client-preflight-isolation',
  'client-process-exit',
  'client-provider-step-budget',
  'client-provider-terminal',
  'client-provider-token-budget',
  'client-turn-timeout',
  'client-unknown-terminal',
  'post-run-verification',
  'receipt-validation',
  'receipt-persistence',
  'interrupted-attempt',
] as const;

export type CodeMemoryLinkAgentRetryReason = (typeof CODE_MEMORY_LINK_AGENT_RETRY_REASONS)[number];

export interface CodeMemoryLinkAgentAttemptStartedV1 {
  readonly approvalCommit: string;
  readonly assignmentHash: string;
  readonly attemptId: string;
  readonly blindLabel: 'X' | 'Y' | 'Z';
  readonly clientDescriptorHash: string;
  readonly clientId: string;
  readonly invocationNonce: string;
  readonly manifestHash: string;
  readonly previousEventDigest: string | null;
  readonly retryOfAttemptId: string | null;
  readonly retryReason: CodeMemoryLinkAgentRetryReason | null;
  readonly runBindingHash: string;
  readonly runNonce: string;
  readonly runOrder: number;
  readonly taskId: string;
  readonly type: 'attempt-started';
  readonly version: typeof CODE_MEMORY_LINK_AGENT_ATTEMPT_VERSION;
}

export interface CodeMemoryLinkAgentAttemptFailedV1 {
  readonly attemptId: string;
  readonly diagnosticHash?: string;
  readonly failureKind: Exclude<CodeMemoryLinkAgentRetryReason, 'interrupted-attempt'>;
  readonly previousEventDigest: string;
  readonly type: 'attempt-failed';
  readonly version: typeof CODE_MEMORY_LINK_AGENT_ATTEMPT_VERSION;
}

export type CodeMemoryLinkAgentAttemptEventV1 =
  CodeMemoryLinkAgentAttemptFailedV1 | CodeMemoryLinkAgentAttemptStartedV1;

export interface CodeMemoryLinkAgentAttemptLedgerStateV1 {
  readonly events: readonly CodeMemoryLinkAgentAttemptEventV1[];
  readonly requiredRetry: null | {
    readonly attemptId: string;
    readonly reason: CodeMemoryLinkAgentRetryReason;
    readonly runOrder: number;
  };
}

export interface CodeMemoryLinkAgentLedgerLayout {
  readonly attemptsPath: string;
  readonly evidencePath: string;
  readonly lockPath: string;
  readonly pendingPath: string;
  readonly trialsPath: string;
}

export class CodeMemoryLinkAgentLedgerError extends Schema.TaggedError<
  CodeMemoryLinkAgentLedgerError,
  {readonly brand: unique symbol}
>()('CodeMemoryLinkAgentLedgerError', {message: Schema.String}) {}

const HASH = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const ATTEMPT_ID = /^attempt_[0-9a-f]{32}$/u;
const INVOCATION_NONCE = /^inv_[0-9a-f]{16,64}$/u;
const CLIENT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const TASK_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const RUN_NONCE = /^run_[0-9a-f]{16,64}$/u;

/**
 * Resolve the shared trial, attempt, and evidence ledgers to one canonical directory identity.
 * The explicit sidecar arguments are intentionally required, while their sibling names are fixed so a retry cannot
 * hide an earlier attempt or retained evidence in a second file.
 */
export const resolveCodeMemoryLinkAgentLedgerLayout = Effect.fn('codeMemoryLinkAttempt.resolveLayout')(function* (
  trialsInput: string,
  attemptsInput: string,
  evidenceInput: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const trialsResolved = path.resolve(trialsInput);
  const attemptsResolved = path.resolve(attemptsInput);
  const evidenceResolved = path.resolve(evidenceInput);
  if (
    path.dirname(trialsResolved) !== path.dirname(attemptsResolved) ||
    path.dirname(trialsResolved) !== path.dirname(evidenceResolved)
  ) {
    return yield* CodeMemoryLinkAgentLedgerError.make({
      message: 'The attempts and evidence ledgers must be beside the trials ledger.',
    });
  }
  yield* fs.makeDirectory(path.dirname(trialsResolved), {recursive: true, mode: 0o700});
  const canonicalParent = yield* fs.realPath(path.dirname(trialsResolved));
  const trialsPath = path.join(canonicalParent, path.basename(trialsResolved));
  const attemptsPath = path.join(canonicalParent, path.basename(attemptsResolved));
  const evidencePath = path.join(canonicalParent, path.basename(evidenceResolved));
  if (attemptsPath !== `${trialsPath}.attempts.jsonl`) {
    return yield* CodeMemoryLinkAgentLedgerError.make({
      message: 'The explicit attempts ledger must be named <canonical-trials-path>.attempts.jsonl.',
    });
  }
  if (evidencePath !== `${trialsPath}.evidence.jsonl`) {
    return yield* CodeMemoryLinkAgentLedgerError.make({
      message: 'The explicit evidence ledger must be named <canonical-trials-path>.evidence.jsonl.',
    });
  }
  return {
    attemptsPath,
    evidencePath,
    lockPath: `${trialsPath}.lock`,
    pendingPath: `${trialsPath}.pending.json`,
    trialsPath,
  } satisfies CodeMemoryLinkAgentLedgerLayout;
});

/** Hold one heartbeat-backed cross-process lock for the complete trial transaction. */
export function withCodeMemoryLinkAgentLedgerLock<A, E, R>(
  layout: CodeMemoryLinkAgentLedgerLayout,
  waitTimeoutMilliseconds: number,
  critical: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* assertRegularLedgerTarget(fs, layout.trialsPath);
    yield* assertRegularLedgerTarget(fs, layout.attemptsPath);
    yield* assertRegularLedgerTarget(fs, layout.evidencePath);
    yield* assertRegularLedgerTarget(fs, layout.pendingPath);
    return yield* withExclusiveFileLock(
      fs,
      layout.lockPath,
      {
        heartbeatIntervalMilliseconds: 20_000,
        recoverReusedProcessIdImmediately: true,
        retryIntervalMilliseconds: 100,
        staleAfterMilliseconds: 120_000,
        useCanonicalProcessStartIdentity: true,
        waitTimeoutMilliseconds,
        windowsSharingViolationRetryLimit: 4,
      },
      Effect.gen(function* () {
        yield* assertRegularLedgerTarget(fs, layout.trialsPath);
        yield* assertRegularLedgerTarget(fs, layout.attemptsPath);
        yield* assertRegularLedgerTarget(fs, layout.evidencePath);
        yield* assertRegularLedgerTarget(fs, layout.pendingPath);
        return yield* critical;
      }),
    );
  });
}

export function createCodeMemoryLinkAgentAttemptStartedV1(
  input: Omit<CodeMemoryLinkAgentAttemptStartedV1, 'type' | 'version'>,
): CodeMemoryLinkAgentAttemptStartedV1 {
  const event = parseCodeMemoryLinkAgentAttemptEventV1({
    ...input,
    type: 'attempt-started',
    version: CODE_MEMORY_LINK_AGENT_ATTEMPT_VERSION,
  });
  if (event.type !== 'attempt-started') invalid('attempt start factory returned an unexpected event');
  return event;
}

export function createCodeMemoryLinkAgentAttemptFailedV1(
  input: Omit<CodeMemoryLinkAgentAttemptFailedV1, 'type' | 'version'>,
): CodeMemoryLinkAgentAttemptFailedV1 {
  const event = parseCodeMemoryLinkAgentAttemptEventV1({
    ...input,
    type: 'attempt-failed',
    version: CODE_MEMORY_LINK_AGENT_ATTEMPT_VERSION,
  });
  if (event.type !== 'attempt-failed') invalid('attempt failure factory returned an unexpected event');
  return event;
}

export function codeMemoryLinkAgentAttemptEventDigest(value: unknown): string {
  return sha256HexSync(`${JSON.stringify(parseCodeMemoryLinkAgentAttemptEventV1(value))}\n`);
}

export function parseCodeMemoryLinkAgentAttemptsJsonl(input: string): readonly CodeMemoryLinkAgentAttemptEventV1[] {
  if (new TextEncoder().encode(input).byteLength > 16 * 1024 * 1024) invalid('attempt JSONL input exceeds 16 MiB');
  return EffectArray.flatMap(Effect2.pipe(input, EffectString.split(/\r?\n/u)), (line, index) => {
    if (!Effect2.pipe(line, EffectString.trim)) return [];
    try {
      return [parseCodeMemoryLinkAgentAttemptEventV1(JSON.parse(line) as unknown)];
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Invalid Code Memory Link attempt JSONL line ${index + 1}: ${detail}`, {cause});
    }
  });
}

export function serializeCodeMemoryLinkAgentAttemptsJsonl(
  events: readonly CodeMemoryLinkAgentAttemptEventV1[],
): string {
  return events.length === 0
    ? ''
    : `${EffectArray.join(
        EffectArray.map(events, event => JSON.stringify(event)),
        '\n',
      )}\n`;
}

/**
 * Validate the event hash chain, bind every attempt to the frozen schedule and
 * client descriptor, and prove every retained receipt came from exactly one
 * persisted start. The only permitted unresolved state is the latest attempt;
 * retrying it requires an explicit exact-id/categorical acknowledgement.
 */
export function assertCodeMemoryLinkAgentAttemptLedgerV1(input: {
  readonly approvalCommit: string;
  readonly events: readonly unknown[];
  readonly manifest: CodeMemoryLinkAgentAbManifestV1;
  readonly trials: readonly CodeMemoryLinkAgentAbTrialV1[];
}): CodeMemoryLinkAgentAttemptLedgerStateV1 {
  const approvalCommit = matching(input.approvalCommit, COMMIT, 'attempt approval commit');
  const events = EffectArray.map(input.events, parseCodeMemoryLinkAgentAttemptEventV1);
  const trialsByInvocation = new Map(
    EffectArray.map(input.trials, trial => [trial.attestation.invocationNonce, trial]),
  );
  if (trialsByInvocation.size !== input.trials.length) invalid('trial invocation nonces must be unique');
  const attemptIds = new Set<string>();
  const matchedTrialNonces = new Set<string>();
  let previousEventDigest: string | null = null;
  let expectedRunOrder = 0;
  let unresolved:
    | {
        readonly failureKind?: Exclude<CodeMemoryLinkAgentRetryReason, 'interrupted-attempt'>;
        readonly start: CodeMemoryLinkAgentAttemptStartedV1;
      }
    | undefined;

  for (const [index, event] of events.entries()) {
    if (event.previousEventDigest !== previousEventDigest) {
      invalid(`attempt ledger event ${index} does not extend the previous event digest`);
    }
    if (event.type === 'attempt-failed') {
      if (!unresolved || unresolved.start.attemptId !== event.attemptId || unresolved.failureKind !== undefined) {
        invalid(`attempt ledger failure ${index} does not close the current started attempt`);
      }
      unresolved = {...unresolved, failureKind: event.failureKind};
      previousEventDigest = codeMemoryLinkAgentAttemptEventDigest(event);
      continue;
    }

    if (attemptIds.has(event.attemptId)) invalid('attempt ids must be unique');
    attemptIds.add(event.attemptId);
    const scheduled = input.manifest.schedule[event.runOrder];
    const client = Option.getOrUndefined(
      EffectArray.findFirst(input.manifest.clients, candidate => candidate.clientId === event.clientId),
    );
    if (
      event.approvalCommit !== approvalCommit ||
      event.assignmentHash !== input.manifest.assignmentHash ||
      event.manifestHash !== input.manifest.manifestHash ||
      !scheduled ||
      event.runOrder !== expectedRunOrder ||
      scheduled.clientId !== event.clientId ||
      scheduled.taskId !== event.taskId ||
      scheduled.blindLabel !== event.blindLabel ||
      scheduled.runNonce !== event.runNonce ||
      !client ||
      client.implementationDescriptorHash !== event.clientDescriptorHash
    ) {
      invalid(`attempt ledger start ${index} does not match the reviewed frozen schedule`);
    }
    if (unresolved) {
      const requiredReason = unresolved.failureKind ?? 'interrupted-attempt';
      if (event.retryOfAttemptId !== unresolved.start.attemptId || event.retryReason !== requiredReason) {
        invalid(`attempt ledger retry ${index} does not acknowledge the exact unresolved attempt and reason`);
      }
    } else if (event.retryOfAttemptId !== null || event.retryReason !== null) {
      invalid(`attempt ledger start ${index} supplies retry metadata without an unresolved attempt`);
    }

    const trial = trialsByInvocation.get(event.invocationNonce);
    if (trial) {
      if (
        trial.approvalCommit !== event.approvalCommit ||
        trial.assignmentHash !== event.assignmentHash ||
        trial.manifestHash !== event.manifestHash ||
        trial.clientId !== event.clientId ||
        trial.taskId !== event.taskId ||
        trial.blindLabel !== event.blindLabel ||
        trial.runNonce !== event.runNonce ||
        trial.runOrder !== event.runOrder
      ) {
        invalid(`attempt ledger start ${index} does not match its retained trial receipt`);
      }
      matchedTrialNonces.add(event.invocationNonce);
      expectedRunOrder += 1;
      unresolved = undefined;
    } else {
      unresolved = {start: event};
    }
    previousEventDigest = codeMemoryLinkAgentAttemptEventDigest(event);
  }

  if (matchedTrialNonces.size !== input.trials.length) {
    invalid('every retained trial receipt must match exactly one persisted attempt start');
  }
  if (expectedRunOrder !== input.trials.length) {
    invalid('attempt ledger success order does not match the retained trial prefix');
  }
  return {
    events,
    requiredRetry: unresolved
      ? {
          attemptId: unresolved.start.attemptId,
          reason: unresolved.failureKind ?? 'interrupted-attempt',
          runOrder: unresolved.start.runOrder,
        }
      : null,
  };
}

export function parseCodeMemoryLinkAgentAttemptEventV1(value: unknown): CodeMemoryLinkAgentAttemptEventV1 {
  const event = record(value, 'attempt event');
  if (event.version !== CODE_MEMORY_LINK_AGENT_ATTEMPT_VERSION) invalid('attempt event version must be 1');
  if (event.type === 'attempt-started') {
    exactKeys(
      event,
      [
        'approvalCommit',
        'assignmentHash',
        'attemptId',
        'blindLabel',
        'clientDescriptorHash',
        'clientId',
        'invocationNonce',
        'manifestHash',
        'previousEventDigest',
        'retryOfAttemptId',
        'retryReason',
        'runBindingHash',
        'runNonce',
        'runOrder',
        'taskId',
        'type',
        'version',
      ],
      'attempt start',
    );
    const retryOfAttemptId =
      event.retryOfAttemptId === null ? null : matching(event.retryOfAttemptId, ATTEMPT_ID, 'retry attempt id');
    const retryReason =
      event.retryReason === null
        ? null
        : literal(event.retryReason, CODE_MEMORY_LINK_AGENT_RETRY_REASONS, 'retry reason');
    if ((retryOfAttemptId === null) !== (retryReason === null)) {
      invalid('retry attempt id and retry reason must either both be null or both be present');
    }
    return {
      approvalCommit: matching(event.approvalCommit, COMMIT, 'attempt approval commit'),
      assignmentHash: matching(event.assignmentHash, HASH, 'attempt assignment hash'),
      attemptId: matching(event.attemptId, ATTEMPT_ID, 'attempt id'),
      blindLabel: literal(event.blindLabel, ['X', 'Y', 'Z'] as const, 'attempt blind label'),
      clientDescriptorHash: matching(event.clientDescriptorHash, HASH, 'attempt client descriptor hash'),
      clientId: matching(event.clientId, CLIENT_ID, 'attempt client id'),
      invocationNonce: matching(event.invocationNonce, INVOCATION_NONCE, 'attempt invocation nonce'),
      manifestHash: matching(event.manifestHash, HASH, 'attempt manifest hash'),
      previousEventDigest:
        event.previousEventDigest === null
          ? null
          : matching(event.previousEventDigest, HASH, 'previous attempt event digest'),
      retryOfAttemptId,
      retryReason,
      runBindingHash: matching(event.runBindingHash, HASH, 'attempt run binding hash'),
      runNonce: matching(event.runNonce, RUN_NONCE, 'attempt run nonce'),
      runOrder: nonNegativeInteger(event.runOrder, 'attempt run order'),
      taskId: matching(event.taskId, TASK_ID, 'attempt task id'),
      type: 'attempt-started',
      version: CODE_MEMORY_LINK_AGENT_ATTEMPT_VERSION,
    };
  }
  if (event.type === 'attempt-failed') {
    const keys = ['attemptId', 'failureKind', 'previousEventDigest', 'type', 'version'];
    if ('diagnosticHash' in event) keys.push('diagnosticHash');
    exactKeys(event, keys, 'attempt failure');
    const failureKind = literal(event.failureKind, CODE_MEMORY_LINK_AGENT_RETRY_REASONS, 'attempt failure kind');
    if (failureKind === 'interrupted-attempt') invalid('an observed failure cannot use the interruption retry reason');
    return {
      attemptId: matching(event.attemptId, ATTEMPT_ID, 'attempt id'),
      ...('diagnosticHash' in event
        ? {diagnosticHash: matching(event.diagnosticHash, HASH, 'attempt failure diagnostic')}
        : {}),
      failureKind,
      previousEventDigest: matching(event.previousEventDigest, HASH, 'previous attempt event digest'),
      type: 'attempt-failed',
      version: CODE_MEMORY_LINK_AGENT_ATTEMPT_VERSION,
    };
  }
  return invalid('attempt event type is unsupported');
}

function assertRegularLedgerTarget(fs: FileSystem.FileSystem, target: string) {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(target))) return;
    if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) {
      return yield* CodeMemoryLinkAgentLedgerError.make({
        message: 'Code Memory Link ledger targets must not be symbolic links.',
      });
    }
    const info = yield* fs.stat(target);
    if (info.type !== 'File') {
      return yield* CodeMemoryLinkAgentLedgerError.make({
        message: 'Code Memory Link ledger targets must be regular files.',
      });
    }
    const linkCount = Option.getOrUndefined(info.nlink);
    if (linkCount !== undefined && linkCount > 1) {
      return yield* CodeMemoryLinkAgentLedgerError.make({
        message: 'Code Memory Link ledger targets must not have hard-link aliases.',
      });
    }
  });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) invalid(`${label} must be an object`);
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = EffectRecord.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) invalid(`${label} fields do not match schema`);
}

function matching(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(`${label} is invalid`);
  return value;
}

function literal<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string') invalid(`${label} is invalid`);
  for (const candidate of values) {
    if (value === candidate) return candidate;
  }
  return invalid(`${label} is invalid`);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid(`${label} must be a non-negative integer`);
  return Number(value);
}

function invalid(message: string): never {
  throw new Error(`Invalid Code Memory Link attempt ledger: ${message}.`);
}
