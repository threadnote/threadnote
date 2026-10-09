import {Cause, Console, Effect} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';

export interface ManagerIntegrationApiRequest {
  readonly body: Effect.Effect<Record<string, unknown>, unknown>;
  readonly config: RuntimeConfig;
  readonly method: string;
  readonly url: URL;
}
export interface ManagerIntegrationApiResponse<Body = unknown> {
  readonly body: Body;
  readonly status: number;
}

export function captureIntegrationConsole<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Console.consoleWith(parent => {
    const lines: string[] = [];
    const append = (...args: readonly unknown[]): void => {
      lines.push(args.map(String).join(' '));
    };
    return effect.pipe(
      Effect.provideService(Console.Console, {...parent, error: append, log: append, warn: append}),
      Effect.map(value => ({output: lines.join('\n'), value})),
    );
  });
}

export function integrationFeatureError(cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause);
  const invalidInput =
    typeof error === 'object' && error !== null && '_tag' in error && error._tag === 'ManagerRequestInputError';
  return Effect.succeed({
    status: invalidInput ? 400 : 409,
    body: {error: error instanceof Error ? error.message : String(error)},
  });
}
