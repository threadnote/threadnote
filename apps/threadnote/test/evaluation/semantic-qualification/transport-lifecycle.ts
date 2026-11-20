import {observeStdioClientTransportClose} from '../../helpers/stdio-client-transport-close.js';

interface CandidateTransport {
  onclose?: (() => void) | undefined;
  readonly pid: number | null;
  start: () => Promise<void>;
  close: () => Promise<void>;
}

/** SDK initialization failure can close and clear pid before Client.connect rejects. */
export function observeCandidateTransport(transport: CandidateTransport, own: (pid: number) => void) {
  const observation = observeStdioClientTransportClose(transport);
  let ownedPid: number | null = null;
  const capture = () => {
    const pid = transport.pid;
    if (pid !== null && ownedPid === null) {
      ownedPid = pid;
      own(pid);
    }
  };
  const originalStart = transport.start.bind(transport);
  transport.start = async () => {
    const starting = originalStart();
    // The SDK spawns synchronously, before initialize and before early stderr.
    capture();
    try {
      await starting;
    } finally {
      capture();
    }
  };
  const originalClose = transport.close.bind(transport);
  let closing: Promise<void> | undefined;
  transport.close = () => {
    capture();
    if (!closing) {
      closing = originalClose();
      // SDK auto-close is fire-and-forget; retain failure for our awaited cleanup.
      void closing.catch(() => undefined);
    }
    return closing;
  };
  return {
    get pid() {
      return ownedPid;
    },
    get closeObserved() {
      return observation.closeObserved;
    },
    close: () => transport.close(),
    waitForCloseIfStarted: observation.waitForCloseIfStarted,
  };
}
