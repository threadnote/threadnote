import {Option} from 'effect';
import {Argument, Flag} from 'effect/cli';
import {decodeCliStringFlagValue, registerCliBooleanFlag, registerCliValueFlag} from './invocation.js';

export const describeFlag = <A>(flag: Flag.Flag<A>, description: string): Flag.Flag<A> =>
  flag.pipe(Flag.withDescription(description));

const valueFlag = <A>(name: string, flag: Flag.Flag<A>, kind: 'other' | 'string'): Flag.Flag<A> => {
  registerCliValueFlag(`--${name}`, kind);
  return flag;
};

const stringFlag = (name: string): Flag.Flag<string> =>
  valueFlag(name, Flag.String(name), 'string').pipe(Flag.map(decodeCliStringFlagValue));

export const integerFlag = (name: string): Flag.Flag<number> => valueFlag(name, Flag.Int(name), 'other');

export const withValueAlias = <A>(flag: Flag.Flag<A>, alias: string, kind: 'other' | 'string'): Flag.Flag<A> => {
  registerCliValueFlag(alias.length === 1 ? `-${alias}` : `--${alias}`, kind);
  return flag.pipe(Flag.withAlias(alias));
};

export const optional = <A>(flag: Flag.Flag<A>): Flag.Flag<A | undefined> =>
  flag.pipe(Flag.optional, Flag.map(Option.getOrUndefined));

export const optionalString = (name: string, description: string): Flag.Flag<string | undefined> =>
  optional(describeFlag(stringFlag(name), description));

export const requiredString = (name: string, description: string): Flag.Flag<string> =>
  describeFlag(stringFlag(name), description);

export const defaultString = (name: string, description: string, value: string): Flag.Flag<string> =>
  describeFlag(stringFlag(name), description).pipe(Flag.withDefault(value));

export const boolean = (name: string, description: string): Flag.Flag<boolean> => {
  registerCliBooleanFlag(`--${name}`);
  return describeFlag(Flag.Boolean(name), description).pipe(Flag.withDefault(false));
};

export const negatedBoolean = (name: string, description: string): Flag.Flag<boolean> => {
  registerCliBooleanFlag(`--no-${name}`);
  return describeFlag(Flag.Boolean(`no-${name}`), description).pipe(
    Flag.withDefault(false),
    Flag.map(value => !value),
  );
};

export const optionalChoice = <const Choices extends readonly string[]>(
  name: string,
  choices: Choices,
  description: string,
): Flag.Flag<Choices[number] | undefined> =>
  optional(describeFlag(valueFlag(name, Flag.Literals(name, choices), 'other'), description));

export const requiredChoice = <const Choices extends readonly string[]>(
  name: string,
  choices: Choices,
  description: string,
): Flag.Flag<Choices[number]> => describeFlag(valueFlag(name, Flag.Literals(name, choices), 'other'), description);

export const defaultChoice = <const Choices extends readonly string[], const Value extends Choices[number]>(
  name: string,
  choices: Choices,
  description: string,
  value: Value,
): Flag.Flag<Choices[number]> =>
  describeFlag(valueFlag(name, Flag.Literals(name, choices), 'other'), description).pipe(Flag.withDefault(value));

export const repeatedString = (name: string, description: string, maximum = 1000): Flag.Flag<ReadonlyArray<string>> =>
  describeFlag(stringFlag(name), description).pipe(Flag.atMost(maximum));

export const argument = (name: string, description: string): Argument.Argument<string> =>
  Argument.String(name).pipe(Argument.withDescription(description));

export const optionalArgument = (name: string, description: string, fallback: string): Argument.Argument<string> =>
  argument(name, description).pipe(Argument.withDefault(fallback));
