import {expect, it} from 'vitest';
import {providerOutputSource} from '../../src/writer-system/provider-output-source.js';

it('continues one discard pump after a delivered pull settles, without overlapping backend reads', async () => {
  let discarding = false,
    ended = false,
    active = 0,
    maximum = 0,
    discardRuns = 0;
  const stream = new ReadableStream<Uint8Array>(
    providerOutputSource(
      async controller => {
        active++;
        maximum = Math.max(maximum, active);
        try {
          if (!discarding) {
            controller!.enqueue(new Uint8Array([7]));
            return;
          }
          discardRuns++;
          await Promise.resolve();
          ended = true;
        } finally {
          active--;
        }
      },
      () => {
        discarding = true;
      },
      () => !ended,
    ),
    {highWaterMark: 1},
  );
  const reader = stream.getReader();
  try {
    expect(await reader.read()).toEqual({done: false, value: new Uint8Array([7])});
    await reader.cancel();
    expect(ended).toBe(true);
    expect(discardRuns).toBe(1);
    expect(maximum).toBe(1);
    expect(active).toBe(0);
  } finally {
    reader.releaseLock();
  }
});
