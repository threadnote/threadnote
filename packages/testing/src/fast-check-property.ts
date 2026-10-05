import type {Vitest} from '@effect/vitest';
import {Schema, type Effect, type Scope} from 'effect';
import * as Arbitrary from 'effect/Arbitrary';
import * as FC from 'fast-check';

type Inputs = ReadonlyArray<FC.Arbitrary<unknown>> | Readonly<Record<string, FC.Arbitrary<unknown>>>;
type Values<A> = {[K in keyof A]: A[K] extends FC.Arbitrary<infer Value> ? Value : never};

type PropertyOptions = {
  readonly fastCheck?: FC.Parameters<unknown>;
  readonly timeout?: number;
};

type EffectPropertyOptions = {
  readonly fastCheck?: Pick<
    FC.Parameters<unknown>,
    'interruptAfterTimeLimit' | 'markInterruptAsFailure' | 'numRuns' | 'seed'
  >;
  readonly timeout?: number;
};

function inputArbitrary<const A extends Inputs>(inputs: A): FC.Arbitrary<Values<A>> {
  if (Array.isArray(inputs)) {
    return FC.tuple(...inputs) as FC.Arbitrary<Values<A>>;
  }
  return FC.record(inputs as Readonly<Record<string, FC.Arbitrary<unknown>>>) as FC.Arbitrary<Values<A>>;
}

/** Run a Fast-check property independently of Effect's native Arbitrary API. */
export function fcProp<const A extends Inputs, R>(
  it: Vitest.MethodsNonLive<R>,
  name: string,
  inputs: A,
  property: (values: Values<A>) => void | boolean,
  options?: PropertyOptions,
): void {
  it(
    name,
    () =>
      FC.assert(
        FC.property(inputArbitrary(inputs), values => property(values) !== false),
        options?.fastCheck,
      ),
    options?.timeout,
  );
}

/** Preserve custom Fast-check generators while @effect/vitest owns Effect execution and per-case scopes. */
export function fcEffectProp<const A extends Inputs, R, E, Result>(
  it: Vitest.MethodsNonLive<R>,
  name: string,
  inputs: A,
  property: (values: Values<A>) => Effect.Effect<Result, E, R | Scope.Scope>,
  options?: EffectPropertyOptions,
): void {
  const check = options?.fastCheck;
  if (check) {
    for (const key of Object.keys(check)) {
      if (!['interruptAfterTimeLimit', 'markInterruptAsFailure', 'numRuns', 'seed'].includes(key)) {
        throw new Error(`Unsupported Fast-check option in Effect property: ${key}`);
      }
    }
    if (check.markInterruptAsFailure === false) {
      throw new Error('Effect properties require a failing test timeout');
    }
  }
  const source = inputArbitrary(inputs);
  // FC.sample is deterministic for a seed. Native Arbitrary shrinks and replays
  // the seed while @effect/vitest runs every Effect in its own scoped test fiber.
  const generated = Arbitrary.map(
    Arbitrary.schema(Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 0x7fffffff}))),
    seed => FC.sample(source, {numRuns: 1, seed})[0],
  );
  const timeLimit = check?.interruptAfterTimeLimit;
  const timeout = timeLimit === undefined ? options?.timeout : Math.min(options?.timeout ?? timeLimit, timeLimit);
  it.effect.prop(name, [generated], ([values]) => property(values), {
    arbitrary: {
      runs: check?.numRuns,
      seed: check?.seed,
    },
    timeout,
  });
}
