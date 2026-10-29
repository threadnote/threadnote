import {Clock, Crypto, Effect, FileSystem, Option, Path, Predicate, Schema} from 'effect';
import {syncDirectoryBestEffort, syncWritableFile} from '@threadnote/platform/file/durability';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {codeGraphRepositoriesRoot, codeGraphRepositoryRoot} from '../layout.js';

class CodeGraphAutomaticCompactionReceiptError extends Schema.TaggedError<CodeGraphAutomaticCompactionReceiptError>()(
  'CodeGraphAutomaticCompactionReceiptError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

export const CODE_GRAPH_AUTOMATIC_COMPACTION_COOLDOWN_MILLISECONDS = 24 * 60 * 60 * 1_000;
export const CODE_GRAPH_AUTOMATIC_COMPACTION_LOW_YIELD_COOLDOWN_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;
export const CODE_GRAPH_AUTOMATIC_COMPACTION_LOW_YIELD_BYTES = 64 * 1_024 * 1_024;
export const CODE_GRAPH_AUTOMATIC_COMPACTION_FAILURE_COOLDOWN_MILLISECONDS = 60 * 60 * 1_000;
export const CODE_GRAPH_AUTOMATIC_COMPACTION_DEFERRED_COOLDOWN_MILLISECONDS = 5 * 60 * 1_000;
export const CODE_GRAPH_AUTOMATIC_COMPACTION_RECEIPT_FILE = 'automatic-compaction-v1.json';
const CODE_GRAPH_AUTOMATIC_COMPACTION_RECEIPT_BYTES_MAXIMUM = 4 * 1_024;
const CODE_GRAPH_AUTOMATIC_COMPACTION_RECEIPT_LOCK_OPTIONS = {
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 60 * 60 * 1_000,
  waitTimeoutMilliseconds: 0,
} as const;

export interface CodeGraphAutomaticCompactionReceiptCandidate {
  readonly checkoutId: string;
  readonly opportunityBytes: number;
}

export interface CodeGraphAutomaticCompactionReceiptResult {
  readonly action: 'compacted' | 'deferred' | 'missing' | 'not-needed' | 'would-compact';
  readonly reclaimedBytes: number;
}

type CodeGraphAutomaticCompactionReceiptAction =
  'attempting' | 'compacted' | 'deferred' | 'failed' | 'missing' | 'not-needed';

interface CodeGraphAutomaticCompactionReceipt {
  readonly action: CodeGraphAutomaticCompactionReceiptAction;
  readonly checkoutId: string;
  readonly opportunityBytes: number;
  readonly reclaimedBytes: number;
  readonly recordedAtMilliseconds: number;
  readonly retryAfterMilliseconds: number;
  readonly version: 1;
}

/** Stable policy shared by automatic and explicit compaction paths. */
export function codeGraphAutomaticCompactionCooldownMilliseconds(
  result: CodeGraphAutomaticCompactionReceiptResult | undefined,
): number {
  if (result === undefined) return CODE_GRAPH_AUTOMATIC_COMPACTION_FAILURE_COOLDOWN_MILLISECONDS;
  if (result.action === 'deferred') return CODE_GRAPH_AUTOMATIC_COMPACTION_DEFERRED_COOLDOWN_MILLISECONDS;
  if (result.action !== 'compacted') return CODE_GRAPH_AUTOMATIC_COMPACTION_FAILURE_COOLDOWN_MILLISECONDS;
  return result.reclaimedBytes < CODE_GRAPH_AUTOMATIC_COMPACTION_LOW_YIELD_BYTES
    ? CODE_GRAPH_AUTOMATIC_COMPACTION_LOW_YIELD_COOLDOWN_MILLISECONDS
    : CODE_GRAPH_AUTOMATIC_COMPACTION_COOLDOWN_MILLISECONDS;
}

/** Read the shared private receipt without claiming the candidate. */
export const codeGraphAutomaticCompactionCandidateAllowed = Effect.fn('codeGraph.automaticCompactionCandidateAllowed')(
  function* (threadnoteHome: string, candidate: CodeGraphAutomaticCompactionReceiptCandidate) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const now = yield* Clock.currentTimeMillis;
    return yield* automaticCompactionReceiptAllows(fs, path, threadnoteHome, candidate.checkoutId, now);
  },
);

/** Atomically reserve one candidate across all local Manager processes. */
export const claimCodeGraphAutomaticCompactionCandidate = Effect.fn('codeGraph.claimAutomaticCompactionCandidate')(
  function* (threadnoteHome: string, candidate: CodeGraphAutomaticCompactionReceiptCandidate) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const lockPath = automaticCompactionReceiptLockPath(path, threadnoteHome, candidate.checkoutId);
    return yield* withExclusiveFileLock(
      fs,
      lockPath,
      CODE_GRAPH_AUTOMATIC_COMPACTION_RECEIPT_LOCK_OPTIONS,
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (!(yield* automaticCompactionReceiptAllows(fs, path, threadnoteHome, candidate.checkoutId, now))) {
          return false;
        }
        yield* writeAutomaticCompactionReceipt(fs, path, threadnoteHome, {
          action: 'attempting',
          checkoutId: candidate.checkoutId,
          opportunityBytes: candidate.opportunityBytes,
          reclaimedBytes: 0,
          recordedAtMilliseconds: now,
          retryAfterMilliseconds: now + CODE_GRAPH_AUTOMATIC_COMPACTION_COOLDOWN_MILLISECONDS,
          version: 1,
        });
        return true;
      }),
    ).pipe(Effect.orElseSucceed(() => false));
  },
);

/** Finalize a claim; a write failure leaves the conservative attempting receipt intact. */
export const recordCodeGraphAutomaticCompactionAttempt = Effect.fn('codeGraph.recordAutomaticCompactionAttempt')(
  function* (
    threadnoteHome: string,
    candidate: CodeGraphAutomaticCompactionReceiptCandidate,
    result: CodeGraphAutomaticCompactionReceiptResult | undefined,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const lockPath = automaticCompactionReceiptLockPath(path, threadnoteHome, candidate.checkoutId);
    yield* withExclusiveFileLock(
      fs,
      lockPath,
      CODE_GRAPH_AUTOMATIC_COMPACTION_RECEIPT_LOCK_OPTIONS,
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* writeAutomaticCompactionReceipt(fs, path, threadnoteHome, {
          action: automaticCompactionReceiptAction(result),
          checkoutId: candidate.checkoutId,
          opportunityBytes: candidate.opportunityBytes,
          reclaimedBytes: result?.reclaimedBytes ?? 0,
          recordedAtMilliseconds: now,
          retryAfterMilliseconds: now + codeGraphAutomaticCompactionCooldownMilliseconds(result),
          version: 1,
        });
      }),
    ).pipe(Effect.ignore);
  },
);

function automaticCompactionReceiptAction(
  result: CodeGraphAutomaticCompactionReceiptResult | undefined,
): CodeGraphAutomaticCompactionReceiptAction {
  if (result === undefined) return 'failed';
  if (result.action === 'compacted' || result.action === 'deferred' || result.action === 'missing') {
    return result.action;
  }
  return 'not-needed';
}

function automaticCompactionReceiptLockPath(path: Path.Path, threadnoteHome: string, checkoutId: string): string {
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'automatic-compaction', `${checkoutId}.lock`);
}

function automaticCompactionReceiptAllows(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
  now: number,
): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    const authority = yield* inspectAutomaticCompactionReceiptRoot(fs, path, threadnoteHome, checkoutId);
    const target = path.join(authority.root, CODE_GRAPH_AUTOMATIC_COMPACTION_RECEIPT_FILE);
    if (!(yield* fs.exists(target))) return true;
    if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) return false;
    const info = yield* fs.stat(target);
    if (info.type !== 'File') return false;
    const modifiedAt = Option.getOrUndefined(info.mtime)?.getTime();
    const malformedAllowed =
      modifiedAt !== undefined && now - modifiedAt >= CODE_GRAPH_AUTOMATIC_COMPACTION_LOW_YIELD_COOLDOWN_MILLISECONDS;
    if (Number(info.size) > CODE_GRAPH_AUTOMATIC_COMPACTION_RECEIPT_BYTES_MAXIMUM) return malformedAllowed;
    const content = yield* fs.readFileString(target);
    if (new TextEncoder().encode(content).byteLength > CODE_GRAPH_AUTOMATIC_COMPACTION_RECEIPT_BYTES_MAXIMUM) {
      return malformedAllowed;
    }
    const receipt = decodeAutomaticCompactionReceipt(content, checkoutId);
    return receipt === undefined ? malformedAllowed : now >= receipt.retryAfterMilliseconds;
  }).pipe(Effect.orElseSucceed(() => false));
}

const writeAutomaticCompactionReceipt = Effect.fn('codeGraph.writeAutomaticCompactionReceipt')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  threadnoteHome: string,
  receipt: CodeGraphAutomaticCompactionReceipt,
) {
  const crypto = yield* Crypto.Crypto;
  const authority = yield* inspectAutomaticCompactionReceiptRoot(fs, path, threadnoteHome, receipt.checkoutId);
  const root = authority.root;
  const target = path.join(root, CODE_GRAPH_AUTOMATIC_COMPACTION_RECEIPT_FILE);
  if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) {
    return yield* CodeGraphAutomaticCompactionReceiptError.make({message: 'Compaction receipt is not a file.'});
  }
  const content = `${JSON.stringify(receipt)}\n`;
  if (new TextEncoder().encode(content).byteLength > CODE_GRAPH_AUTOMATIC_COMPACTION_RECEIPT_BYTES_MAXIMUM) {
    return yield* CodeGraphAutomaticCompactionReceiptError.make({message: 'Compaction receipt is too large.'});
  }
  const temporary = path.join(
    root,
    `.${CODE_GRAPH_AUTOMATIC_COMPACTION_RECEIPT_FILE}.${yield* crypto.randomUUIDv4()}.tmp`,
  );
  yield* Effect.gen(function* () {
    yield* fs.writeFileString(temporary, content, {flag: 'wx', mode: 0o600});
    yield* syncWritableFile(fs, temporary);
    const revalidated = yield* inspectAutomaticCompactionReceiptRoot(fs, path, threadnoteHome, receipt.checkoutId);
    if (!sameAutomaticCompactionReceiptRoot(authority, revalidated)) {
      return yield* CodeGraphAutomaticCompactionReceiptError.make({
        message: 'Compaction receipt directory changed during publication.',
      });
    }
    if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) {
      return yield* CodeGraphAutomaticCompactionReceiptError.make({message: 'Compaction receipt is not a file.'});
    }
    yield* fs.rename(temporary, target);
    yield* syncDirectoryBestEffort(fs, root);
  }).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
});

interface AutomaticCompactionReceiptRoot {
  readonly dev: bigint;
  readonly ino?: bigint;
  readonly parentDev: bigint;
  readonly parentIno?: bigint;
  readonly root: string;
}

function inspectAutomaticCompactionReceiptRoot(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
): Effect.Effect<AutomaticCompactionReceiptRoot, CodeGraphAutomaticCompactionReceiptError> {
  return Effect.gen(function* () {
    const declaredRoot = codeGraphRepositoryRoot(path, threadnoteHome, checkoutId);
    const declaredParent = codeGraphRepositoriesRoot(path, threadnoteHome);
    if (Option.isSome(yield* fs.readLink(declaredParent).pipe(Effect.option))) {
      return yield* CodeGraphAutomaticCompactionReceiptError.make({
        message: 'Compaction repositories directory is a symbolic link.',
      });
    }
    if (Option.isSome(yield* fs.readLink(declaredRoot).pipe(Effect.option))) {
      return yield* CodeGraphAutomaticCompactionReceiptError.make({
        message: 'Compaction receipt directory is a symbolic link.',
      });
    }
    const canonicalHome = yield* fs.realPath(threadnoteHome);
    const canonicalParent = yield* fs.realPath(declaredParent);
    const root = yield* fs.realPath(declaredRoot);
    const parentInfo = yield* fs.stat(canonicalParent);
    const info = yield* fs.stat(root);
    if (
      parentInfo.type !== 'Directory' ||
      info.type !== 'Directory' ||
      canonicalParent !== path.join(canonicalHome, 'indexes', 'code-graph', 'repositories') ||
      path.dirname(root) !== canonicalParent ||
      path.basename(root) !== checkoutId
    ) {
      return yield* CodeGraphAutomaticCompactionReceiptError.make({
        message: 'Compaction receipt directory escaped graph storage.',
      });
    }
    return {
      dev: info.dev,
      ...(Option.isSome(info.ino) ? {ino: info.ino.value} : {}),
      parentDev: parentInfo.dev,
      ...(Option.isSome(parentInfo.ino) ? {parentIno: parentInfo.ino.value} : {}),
      root,
    };
  }).pipe(
    Effect.mapError(cause =>
      CodeGraphAutomaticCompactionReceiptError.make({
        cause,
        message: 'Could not safely inspect compaction receipt storage.',
      }),
    ),
  );
}

function sameAutomaticCompactionReceiptRoot(
  left: AutomaticCompactionReceiptRoot,
  right: AutomaticCompactionReceiptRoot,
): boolean {
  return (
    left.root === right.root &&
    left.dev === right.dev &&
    (left.ino === undefined || right.ino === undefined || left.ino === right.ino) &&
    left.parentDev === right.parentDev &&
    (left.parentIno === undefined || right.parentIno === undefined || left.parentIno === right.parentIno)
  );
}

function decodeAutomaticCompactionReceipt(
  content: string,
  expectedCheckoutId: string,
): CodeGraphAutomaticCompactionReceipt | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!Predicate.isObject(parsed)) return undefined;
    const receipt = parsed;
    const keys = Object.keys(receipt).sort();
    if (
      JSON.stringify(keys) !==
        JSON.stringify(
          [
            'action',
            'checkoutId',
            'opportunityBytes',
            'reclaimedBytes',
            'recordedAtMilliseconds',
            'retryAfterMilliseconds',
            'version',
          ].sort(),
        ) ||
      receipt.version !== 1 ||
      receipt.checkoutId !== expectedCheckoutId ||
      !automaticCompactionReceiptActionValue(receipt.action) ||
      !automaticCompactionReceiptInteger(receipt.opportunityBytes) ||
      !automaticCompactionReceiptInteger(receipt.reclaimedBytes) ||
      !automaticCompactionReceiptInteger(receipt.recordedAtMilliseconds) ||
      !automaticCompactionReceiptInteger(receipt.retryAfterMilliseconds) ||
      receipt.retryAfterMilliseconds < receipt.recordedAtMilliseconds
    ) {
      return undefined;
    }
    return {
      action: receipt.action,
      checkoutId: receipt.checkoutId,
      opportunityBytes: receipt.opportunityBytes,
      reclaimedBytes: receipt.reclaimedBytes,
      recordedAtMilliseconds: receipt.recordedAtMilliseconds,
      retryAfterMilliseconds: receipt.retryAfterMilliseconds,
      version: 1,
    };
  } catch {
    return undefined;
  }
}

function automaticCompactionReceiptActionValue(value: unknown): value is CodeGraphAutomaticCompactionReceiptAction {
  return (
    typeof value === 'string' &&
    ['attempting', 'compacted', 'deferred', 'failed', 'missing', 'not-needed'].includes(value)
  );
}

function automaticCompactionReceiptInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
