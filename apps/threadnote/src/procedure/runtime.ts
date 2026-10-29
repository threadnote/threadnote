import {Effect, Schema} from 'effect';

import {CommandExecutor, CommandTimedOut} from '@threadnote/platform/command';
import {
  createProcedureVerificationReceipt,
  parseProcedureManifest,
  procedureStatus,
  type ProcedureStatus,
  type ProcedureStatusInput,
  type ProcedureVerificationReceipt,
} from '@threadnote/context/procedure/contract';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_OUTPUT_BYTES = 65_536;

export class ProcedureRuntimeError extends Schema.TaggedError<ProcedureRuntimeError, {readonly brand: unique symbol}>()(
  'ProcedureRuntimeError',
  {
    message: Schema.String,
  },
) {}

export interface ProcedureVerificationMetadata {
  readonly hostVersion: string;
  readonly threadnoteVersion: string;
  readonly verifiedAt: string;
  readonly verifier: string;
}

export interface VerifyLocalProcedureOptions {
  readonly cwd?: string;
  readonly dryRun?: boolean;
  readonly manifest: unknown;
  /** The author-selected absolute local manifest path; remote URIs are rejected. */
  readonly manifestPath: string;
  readonly metadata: ProcedureVerificationMetadata;
  readonly preview?: boolean;
  readonly timeoutMs?: number;
}

export interface ProcedureVerificationResult {
  readonly executedCommandIds: readonly string[];
  readonly receipt?: ProcedureVerificationReceipt;
}

export interface ProcedureRuntimeStatusInput extends ProcedureStatusInput {
  readonly manifest: unknown;
}

/** Executes only command descriptors from an explicitly selected local manifest. */
export const verifyLocalProcedure = Effect.fn('procedure.verifyLocal')(function* (
  options: VerifyLocalProcedureOptions,
) {
  assertLocalManifestPath(options.manifestPath);
  const manifest = parseProcedureManifest(options.manifest);
  if (options.preview === true || options.dryRun === true) {
    return {executedCommandIds: [], receipt: undefined} satisfies ProcedureVerificationResult;
  }
  const command = yield* CommandExecutor;
  const timeoutMs = verificationTimeout(options.timeoutMs);
  const executedCommandIds: string[] = [];
  for (const descriptor of manifest.verification.commands) {
    const [executable, ...args] = descriptor.argv;
    yield* command
      .execute(executable, args, {cwd: options.cwd, maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES, timeoutMs})
      .pipe(
        Effect.mapError(error =>
          ProcedureRuntimeError.make({
            message: Schema.is(CommandTimedOut)(error)
              ? `Verification command ${descriptor.id} timed out.`
              : `Verification command ${descriptor.id} failed.`,
          }),
        ),
      );
    executedCommandIds.push(descriptor.id);
  }
  return {
    executedCommandIds,
    receipt: createProcedureVerificationReceipt(manifest, options.metadata),
  } satisfies ProcedureVerificationResult;
});

/** Delegates status precedence and receipt/content hash comparison to the pure contract. */
export function procedureRuntimeStatus(input: ProcedureRuntimeStatusInput): ProcedureStatus {
  const {manifest, ...statusInput} = input;
  return procedureStatus(parseProcedureManifest(manifest), statusInput);
}

function assertLocalManifestPath(path: string): void {
  if (!/^(?:\/|[A-Za-z]:[\\/])/.test(path) || Effect2.pipe(path, EffectString.includes('://'))) {
    throw ProcedureRuntimeError.make({message: 'Verification requires an author-selected local manifest path.'});
  }
}

function verificationTimeout(timeoutMs: number | undefined): number {
  if (
    timeoutMs !== undefined &&
    (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_COMMAND_TIMEOUT_MS)
  ) {
    throw ProcedureRuntimeError.make({
      message: `Verification timeout must be between 1 and ${MAX_COMMAND_TIMEOUT_MS}ms.`,
    });
  }
  return timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
}
