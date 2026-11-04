import type {Runtime} from 'effect';

/** Native workers keep OS signal handling; their scoped parent owns cancellation. */
export const signalTransparentTeardown: Parameters<typeof Runtime.makeRunMain>[0] = ({fiber, teardown}) => {
  fiber.addObserver(exit => {
    teardown(exit, code => {
      if (code !== 0) process.exit(code);
    });
  });
};
