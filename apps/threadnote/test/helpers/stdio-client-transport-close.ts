interface StdioClientTransportLifecycle {
  onclose?: (() => void) | undefined;
  readonly pid: number | null;
  start: () => Promise<void>;
}

export interface StdioClientTransportCloseObservation {
  readonly closeObserved: boolean;
  readonly waitForCloseIfStarted: (signal: AbortSignal) => Promise<void>;
}

/** Observe the SDK transport's child close event and preserve its callback. */
export function observeStdioClientTransportClose(
  transport: StdioClientTransportLifecycle,
): StdioClientTransportCloseObservation {
  let childMayExist = false;
  let closeObserved = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => {
    resolveClosed = resolve;
  });

  const previousOnClose = transport.onclose;
  transport.onclose = () => {
    closeObserved = true;
    resolveClosed();
    previousOnClose?.();
  };

  const originalStart = transport.start.bind(transport);
  transport.start = async () => {
    try {
      await originalStart();
      childMayExist = true;
    } catch (cause) {
      childMayExist = transport.pid !== null || closeObserved;
      throw cause;
    }
  };

  return {
    get closeObserved() {
      return closeObserved;
    },
    waitForCloseIfStarted: async signal => {
      if (!childMayExist && !closeObserved) return;
      if (closeObserved) return;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          signal.removeEventListener('abort', onAbort);
          reject(signal.reason ?? new Error('Test cancelled before stdio transport close was observed'));
        };
        signal.addEventListener('abort', onAbort, {once: true});
        if (signal.aborted) {
          onAbort();
          return;
        }
        void closed.then(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        });
      });
    },
  };
}
