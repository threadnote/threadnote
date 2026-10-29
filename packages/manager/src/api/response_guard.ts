import {Schema} from 'effect';

export class ManagerResponseContractError extends Schema.TaggedError<
  ManagerResponseContractError,
  {readonly brand: unique symbol}
>()('ManagerResponseContractError', {message: Schema.String}) {}

/** A runtime check that refines a JSON value to a Manager API response contract. */
export type ApiResponseGuard<Value> = (value: unknown) => value is Value;

/** Validate without decoding, cloning, or changing the response object. */
export function requireApiResponse<Value>(value: unknown, guard: ApiResponseGuard<Value>): Value {
  if (!guard(value))
    throw ManagerResponseContractError.make({message: 'Manager returned a response that does not match its contract.'});
  return value;
}
