import {describe, expect, it} from 'vitest';
import {observeStdioClientTransportClose} from '../helpers/stdio-client-transport-close.js';

describe('stdio client transport close observation', () => {
  it('keeps cleanup pending after close resolves until the owned child close event', async () => {
    const transport = {
      onclose: undefined as (() => void) | undefined,
      pid: 42,
      start: async () => {},
    };
    const observation = observeStdioClientTransportClose(transport);
    await transport.start();

    let cleanupReleased = false;
    const clientClose = Promise.resolve();
    await clientClose;
    const waitingForOwnedClose = observation.waitForCloseIfStarted(new AbortController().signal).then(() => {
      cleanupReleased = true;
    });
    await Promise.resolve();
    expect(cleanupReleased).toBe(false);

    transport.onclose?.();
    await waitingForOwnedClose;
    expect(cleanupReleased).toBe(true);
    expect(observation.closeObserved).toBe(true);
  });

  it('retains an early close event and calls the SDK callback before waiting', async () => {
    let sdkCloseCalls = 0;
    const transport = {
      onclose: () => {
        sdkCloseCalls++;
      },
      pid: 42,
      start: async () => {},
    };
    const observation = observeStdioClientTransportClose(transport);
    await transport.start();
    transport.onclose?.();

    await observation.waitForCloseIfStarted(new AbortController().signal);
    expect(observation.closeObserved).toBe(true);
    expect(sdkCloseCalls).toBe(1);
  });

  it('preserves start errors and does not wait when no child was created', async () => {
    const failure = new Error('synthetic spawn failure');
    const transport = {
      onclose: undefined as (() => void) | undefined,
      pid: null,
      start: async () => {
        throw failure;
      },
    };
    const observation = observeStdioClientTransportClose(transport);

    await expect(transport.start()).rejects.toBe(failure);
    await expect(observation.waitForCloseIfStarted(new AbortController().signal)).resolves.toBeUndefined();
    expect(observation.closeObserved).toBe(false);
  });

  it('resolves the close wait while preserving an existing SDK callback error', async () => {
    const failure = new Error('synthetic close callback failure');
    const transport = {
      onclose: () => {
        throw failure;
      },
      pid: 42,
      start: async () => {},
    };
    const observation = observeStdioClientTransportClose(transport);
    await transport.start();

    expect(() => transport.onclose?.()).toThrow(failure);
    await expect(observation.waitForCloseIfStarted(new AbortController().signal)).resolves.toBeUndefined();
    expect(observation.closeObserved).toBe(true);
  });

  it('rejects a never-closing child wait when the test budget is cancelled', async () => {
    const transport = {
      onclose: undefined as (() => void) | undefined,
      pid: 42,
      start: async () => {},
    };
    const observation = observeStdioClientTransportClose(transport);
    await transport.start();
    const controller = new AbortController();
    const cancellation = new Error('synthetic test timeout');
    const waiting = observation.waitForCloseIfStarted(controller.signal);

    controller.abort(cancellation);

    await expect(waiting).rejects.toBe(cancellation);
    expect(observation.closeObserved).toBe(false);
  });
});
