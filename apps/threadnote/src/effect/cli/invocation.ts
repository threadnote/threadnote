import {Array as EffectArray} from 'effect';
import {cliAnonymousTelemetryOperation} from '../../telemetry/operations.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export type ProductionLogMode = 'always' | 'never' | 'requires-apply' | 'skips-on-preview';
type CliValueFlagKind = 'other' | 'string';

interface CliCommandRegistration {
  readonly aliases: readonly string[];
  readonly canonicalName: string;
  readonly productionLog: {
    readonly mode?: ProductionLogMode;
    readonly subcommands?: Readonly<Record<string, ProductionLogMode>>;
  };
}

export interface CliInvocationInspection {
  readonly offline?: true;
  /** Release previews must run before process, lease, cache or telemetry writes. */
  readonly observationalUpdate?: true;
  /** CI reserves exit 1 for actionable findings, including when parsing fails before its handler. */
  readonly failureExitCode?: 2;
  readonly homeOverride?: string;
  readonly operation?: string;
  readonly telemetryOperation?: string;
  readonly writeAnonymousTelemetry: boolean;
  readonly writeProductionLog: boolean;
}

const encodedStringPrefix = '\u{f0000}threadnote:';
const valueFlagKinds = new Map<string, CliValueFlagKind>();
const booleanFlagNames = new Set<string>();
const cliRuntimeValueFlagKinds = new Map<string, CliValueFlagKind>([
  ['--completions', 'other'],
  ['--log-level', 'other'],
]);

export function registerCliValueFlag(name: string, kind: CliValueFlagKind): void {
  valueFlagKinds.set(name, kind);
}

export function registerCliBooleanFlag(name: string): void {
  booleanFlagNames.add(name);
}

export function decodeCliStringFlagValue(value: string): string {
  return Effect.pipe(value, EffectString.startsWith(encodedStringPrefix))
    ? Effect.pipe(value, EffectString.slice(encodedStringPrefix.length))
    : value;
}

export function makeCliInvocationInspector(registrations: readonly CliCommandRegistration[]) {
  const operationByName = new Map(
    EffectArray.flatMap(registrations, registration => [
      [registration.canonicalName, registration.canonicalName] as const,
      ...EffectArray.map(registration.aliases, alias => [alias, registration.canonicalName] as const),
    ]),
  );
  const registrationByName = new Map(
    EffectArray.map(registrations, registration => [registration.canonicalName, registration] as const),
  );

  return (arguments_: readonly string[]): CliInvocationInspection => {
    const scanned = scanCliArguments(arguments_);
    const selectedName = scanned.positionals[0];
    const operation = selectedName === undefined ? undefined : (operationByName.get(selectedName) ?? 'unknown');
    const offlinePilot = operation === 'value' && scanned.positionals[1] === 'pilot';
    const observationalUpdate =
      operation === 'update' &&
      scanned.positionals.length === 1 &&
      !scanned.invalidBooleanValue &&
      (scanned.booleanValues.get('--check') === true || scanned.booleanValues.get('--dry-run') === true);
    const telemetryOperation =
      operation === undefined
        ? undefined
        : cliAnonymousTelemetryOperation(operation, scanned.positionals[1], scanned.positionals[2]);
    const registration =
      operation === undefined || operation === 'unknown' ? undefined : registrationByName.get(operation);
    const mode =
      registration?.productionLog.subcommands?.[scanned.positionals[1] ?? ''] ??
      registration?.productionLog.mode ??
      'always';
    const writeProductionLog =
      !observationalUpdate &&
      operation !== undefined &&
      mode !== 'never' &&
      scanned.booleanValues.get('--dry-run') !== true &&
      !scanned.flags.has('--help') &&
      !scanned.flags.has('-h') &&
      !(mode === 'requires-apply' && scanned.booleanValues.get('--apply') !== true) &&
      !(mode === 'skips-on-preview' && scanned.booleanValues.get('--preview') === true);
    const writeAnonymousTelemetry =
      !observationalUpdate &&
      !offlinePilot &&
      operation !== undefined &&
      operation !== 'telemetry' &&
      operation !== 'memory-archive' &&
      !scanned.flags.has('--help') &&
      !scanned.flags.has('-h');
    return {
      ...(offlinePilot ? {offline: true as const} : {}),
      ...(observationalUpdate ? {observationalUpdate: true as const} : {}),
      ...(operation === 'context' && scanned.positionals[1] === 'check' ? {failureExitCode: 2 as const} : {}),
      ...(scanned.homeOverride === undefined ? {} : {homeOverride: scanned.homeOverride}),
      ...(operation === undefined ? {} : {operation}),
      ...(telemetryOperation === undefined ? {} : {telemetryOperation}),
      writeAnonymousTelemetry,
      writeProductionLog,
    };
  };
}

function scanCliArguments(arguments_: readonly string[]) {
  const booleanValues = new Map<string, boolean>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  let homeOverride: string | undefined;
  let invalidBooleanValue = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] ?? '';
    const equalsIndex = Effect.pipe(
      argument,
      EffectString.indexOf('='),
      Effect.Option.getOrElse(() => -1),
    );
    const flagName = equalsIndex > 0 ? Effect.pipe(argument, EffectString.slice(0, equalsIndex)) : argument;
    const valueKind = booleanFlagNames.has(flagName)
      ? undefined
      : (valueFlagKinds.get(flagName) ?? cliRuntimeValueFlagKinds.get(flagName));
    if (valueKind !== undefined) {
      const value =
        equalsIndex > 0 ? Effect.pipe(argument, EffectString.slice(equalsIndex + 1)) : arguments_[index + 1];
      if (flagName === '--home') {
        homeOverride = value;
      }
      if (equalsIndex < 0 && value !== undefined) {
        index += 1;
      }
      continue;
    }
    if (booleanFlagNames.has(flagName)) {
      const inlineValue =
        equalsIndex > 0 ? parseCliBoolean(Effect.pipe(argument, EffectString.slice(equalsIndex + 1))) : undefined;
      const followingValue = equalsIndex < 0 ? parseCliBoolean(arguments_[index + 1]) : undefined;
      if (equalsIndex > 0 && inlineValue === undefined) invalidBooleanValue = true;
      booleanValues.set(flagName, inlineValue ?? followingValue ?? true);
      if (followingValue !== undefined) {
        index += 1;
      }
      continue;
    }
    if (Effect.pipe(argument, EffectString.startsWith('-'))) {
      flags.add(flagName);
    } else {
      positionals.push(argument);
    }
  }
  return {booleanValues, flags, homeOverride, invalidBooleanValue, positionals};
}

function parseCliBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  switch (Effect.pipe(value, EffectString.toLowerCase)) {
    case '1':
    case 'on':
    case 'true':
    case 'yes':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false;
    default:
      return undefined;
  }
}

/**
 * Preserve Commander-compatible string values while Effect 4.0.0-rc.112 still
 * tokenizes dash-prefixed values as flags. The RC lexer preserves inline
 * equals values; normalizing both forms here keeps one reversible string-value
 * path until the remaining dash-prefixed-value gap is fixed upstream.
 */
export function normalizeCliArguments(args: readonly string[]): readonly string[] {
  const normalized: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index] ?? '';
    const equalsIndex = Effect.pipe(
      current,
      EffectString.indexOf('='),
      Effect.Option.getOrElse(() => -1),
    );
    const inlineName = equalsIndex > 0 ? Effect.pipe(current, EffectString.slice(0, equalsIndex)) : current;
    // A spelling can be boolean in one command and valued in another (for
    // example, `init-manifest --replace` versus `remember --replace <uri>`).
    // Effect's selected command can disambiguate those flags. Rewriting them
    // here from the global registry would consume a following flag as a value.
    const kind = booleanFlagNames.has(inlineName) ? undefined : valueFlagKinds.get(inlineName);
    if (!kind) {
      normalized.push(current);
      continue;
    }

    if (equalsIndex > 0) {
      const value = Effect.pipe(current, EffectString.slice(equalsIndex + 1));
      if (kind === 'string') {
        normalized.push(inlineName, encodeStringArgument(value));
      } else {
        normalized.push(current);
      }
      continue;
    }

    const next = args[index + 1];
    if (
      Effect.pipe(next, effectOptionalString =>
        effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.startsWith('-')),
      ) &&
      next !== '-'
    ) {
      normalized.push(kind === 'string' ? current : `${current}=${next}`);
      if (kind === 'string') {
        normalized.push(encodeStringArgument(next));
      }
      index += 1;
      continue;
    }
    normalized.push(current);
  }
  return normalized;
}

function encodeStringArgument(value: string): string {
  return Effect.pipe(value, EffectString.startsWith('-')) ? `${encodedStringPrefix}${value}` : value;
}
