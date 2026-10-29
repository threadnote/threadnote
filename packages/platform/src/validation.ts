declare const numericValidation: unique symbol;
type CheckedNumber<Kind extends string> = number & {readonly [numericValidation]: Kind};

/** Native membership with a type predicate for validated literal and enum inputs. */
export function isOneOf<const Values extends readonly unknown[]>(
  values: Values,
  value: unknown,
): value is Values[number] {
  return values.includes(value);
}

/** Safe-integer validation that retains the checked number type. */
export function isSafeInteger(value: unknown): value is CheckedNumber<'safe-integer'> {
  return Number.isSafeInteger(value);
}

/** Finite-number validation that retains the checked number type. */
export function isFiniteNumber(value: unknown): value is CheckedNumber<'finite'> {
  return Number.isFinite(value);
}

/** Integer validation that retains the checked number type. */
export function isInteger(value: unknown): value is CheckedNumber<'integer'> {
  return Number.isInteger(value);
}
