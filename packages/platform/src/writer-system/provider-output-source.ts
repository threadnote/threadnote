/** Serialize backend pulls and transfer a cancelled reader to continuous native EOF draining. */
export function providerOutputSource(
  pump: (controller?: ReadableStreamDefaultController<Uint8Array>) => Promise<void>,
  discard: () => void,
  canContinue: () => boolean,
): UnderlyingDefaultSource<Uint8Array> {
  let active: Promise<void> | undefined;
  const run = (controller?: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
    if (active) return active;
    const settled = pump(controller).finally(() => {
      if (active === settled) active = undefined;
    });
    active = settled;
    return settled;
  };
  return {
    pull: controller => run(controller),
    async cancel() {
      discard();
      // A delivered chunk can resume its reader before the pull's settlement bookkeeping.
      // Waiting for that pull alone is insufficient: it may not have entered discard mode.
      await active;
      if (canContinue()) await run();
    },
  };
}
