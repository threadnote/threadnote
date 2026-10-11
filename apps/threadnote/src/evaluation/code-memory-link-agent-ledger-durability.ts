import {Crypto, Effect, FileSystem, Path} from 'effect';
import {syncWritableFile} from '@threadnote/platform/file/durability';
import type {CodeMemoryLinkAgentLedgerLayout} from './code-memory-link-agent-attempts.js';

export const CODE_MEMORY_LINK_AGENT_LEDGER_DURABILITY_STEPS = [
  'attempt-start-durable',
  'pending-durable',
  'evidence-durable',
  'trial-durable',
  'pending-removal-durable',
] as const;

export type CodeMemoryLinkAgentLedgerDurabilityStep = (typeof CODE_MEMORY_LINK_AGENT_LEDGER_DURABILITY_STEPS)[number];

export interface CodeMemoryLinkAgentLedgerFaultInjection<E = never, R = never> {
  readonly afterStep?: (step: CodeMemoryLinkAgentLedgerDurabilityStep) => Effect.Effect<void, E, R>;
}

export interface CodeMemoryLinkAgentLedgerProjection {
  /** Omit only while recovering a pending commit that is already durable. */
  readonly pendingSource?: string;
  /** Omit only when recovery proves the durable evidence projection is already exact. */
  readonly evidenceSource?: string;
  /** Omit only when recovery proves the durable trial projection is already exact. */
  readonly trialsSource?: string;
}

/** Persist the write-ahead attempt start before control can pass to external execution. */
export function persistCodeMemoryLinkAgentAttemptStartDurably<E = never, R = never>(
  attemptsPath: string,
  attemptsSource: string,
  faultInjection: CodeMemoryLinkAgentLedgerFaultInjection<E, R> = {},
) {
  return durablyReplaceCodeMemoryLinkAgentLedger(attemptsPath, attemptsSource).pipe(
    Effect.andThen(faultInjection.afterStep?.('attempt-start-durable') ?? Effect.void),
  );
}

/**
 * Replace one evaluation ledger through a file-sync, atomic rename, and strict parent-directory sync.
 * Unlike general application state, governed release evidence fails closed when directory fsync is unsupported.
 */
export const durablyReplaceCodeMemoryLinkAgentLedger = Effect.fn('codeMemoryLinkLedger.durablyReplace')(function* (
  targetInput: string,
  content: string,
) {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.resolve(targetInput);
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${yield* crypto.randomUUIDv4()}.durable.tmp`);
  yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
  yield* Effect.gen(function* () {
    yield* fs.writeFileString(temporary, content, {flag: 'wx', mode: 0o600});
    yield* syncWritableFile(fs, temporary);
    yield* fs.rename(temporary, target);
    yield* syncDirectoryStrict(fs, directory);
  }).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
});

/** Remove a governed ledger marker, then make the unlink durable in its containing directory. */
export const durablyRemoveCodeMemoryLinkAgentLedger = Effect.fn('codeMemoryLinkLedger.durablyRemove')(function* (
  targetInput: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.resolve(targetInput);
  const directory = path.dirname(target);
  yield* fs.remove(target, {force: true});
  yield* syncDirectoryStrict(fs, directory);
});

/**
 * Publish the two projections behind an already validated write-ahead commit. Every callback runs only after the
 * preceding state is file- and directory-durable, so tests can model an abrupt host stop at every recovery boundary.
 */
export function projectCodeMemoryLinkAgentPendingCommitDurably<E = never, R = never>(
  layout: CodeMemoryLinkAgentLedgerLayout,
  projection: CodeMemoryLinkAgentLedgerProjection,
  faultInjection: CodeMemoryLinkAgentLedgerFaultInjection<E, R> = {},
) {
  return Effect.gen(function* () {
    if (projection.pendingSource !== undefined) {
      yield* durablyReplaceCodeMemoryLinkAgentLedger(layout.pendingPath, projection.pendingSource);
      yield* faultInjection.afterStep?.('pending-durable') ?? Effect.void;
    }
    if (projection.evidenceSource !== undefined) {
      yield* durablyReplaceCodeMemoryLinkAgentLedger(layout.evidencePath, projection.evidenceSource);
      yield* faultInjection.afterStep?.('evidence-durable') ?? Effect.void;
    }
    if (projection.trialsSource !== undefined) {
      yield* durablyReplaceCodeMemoryLinkAgentLedger(layout.trialsPath, projection.trialsSource);
      yield* faultInjection.afterStep?.('trial-durable') ?? Effect.void;
    }
    yield* durablyRemoveCodeMemoryLinkAgentLedger(layout.pendingPath);
    yield* faultInjection.afterStep?.('pending-removal-durable') ?? Effect.void;
  });
}

function syncDirectoryStrict(fs: FileSystem.FileSystem, directory: string) {
  return Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fs.open(directory, {flag: 'r'});
      yield* handle.sync;
    }),
  );
}
