export interface LocalBinsCleanupFacts {
  readonly coordinatorExitWaitCompleted: boolean;
  readonly coordinatorPid: number | null;
  readonly coordinatorPidWasRunning: boolean | null;
  readonly endpointRead: 'present' | 'absent-or-unreadable';
  readonly stdioTransportCloseEvent: 'not-attempted' | 'not-observed' | 'observed';
  readonly terminationOutcome:
    | 'not-applicable'
    | 'not-needed'
    | 'tree-kill-returned'
    | 'tree-kill-failed-but-pid-exited'
    | 'signal-issued'
    | 'signal-failed-but-pid-exited';
}

export type LocalBinsCleanupErrorCode = 'EBUSY' | 'EPERM' | 'ENOTEMPTY' | 'OTHER';

function localBinsCleanupErrorCode(cause: unknown): LocalBinsCleanupErrorCode {
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return 'OTHER';
  const code = Reflect.get(cause, 'code');
  if (code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY') return code;
  return 'OTHER';
}

export function reportLocalBinsCleanupFailure(
  cause: unknown,
  facts: LocalBinsCleanupFacts,
  write: (line: string) => void,
): never {
  try {
    write(
      `${JSON.stringify({
        event: 'local-bins-cleanup-failure',
        stage: 'remove-temporary-root',
        errorCode: localBinsCleanupErrorCode(cause),
        ...facts,
      })}\n`,
    );
  } catch {
    // Diagnostic output is best effort and must not replace the cleanup failure.
  }
  throw cause;
}
