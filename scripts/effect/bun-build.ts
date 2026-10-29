import {Array as EffectArray} from 'effect';
import {Effect} from 'effect';
import {ScriptError} from './errors.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

type BunBuild = (options: Bun.BuildConfig) => Promise<Bun.BuildOutput>;

const BUILD_FAILURE_MESSAGE = 'Bun could not build the standalone artifact.';

export function runBunBuild(options: Bun.BuildConfig, build: BunBuild = Bun.build) {
  return Effect.tryPromise({
    try: () => build(options),
    catch: cause => bunBuildScriptError(cause),
  }).pipe(
    Effect.flatMap(result =>
      result.success
        ? Effect.void
        : Effect.fail(
            ScriptError.make({
              message: EffectArray.join(
                EffectArray.filter(
                  EffectArray.map(result.logs, log => log.message),
                  Boolean,
                ),
                '\n',
              ),
            }),
          ),
    ),
  );
}

function bunBuildScriptError(cause: unknown): ScriptError {
  const diagnostics =
    cause instanceof AggregateError
      ? EffectArray.filter(EffectArray.map(cause.errors, renderBuildDiagnostic), Boolean)
      : [];
  return ScriptError.make({message: renderBuildFailure(diagnostics), cause});
}

function renderBuildFailure(diagnostics: ReadonlyArray<string>): string {
  return diagnostics.length === 0
    ? BUILD_FAILURE_MESSAGE
    : `${BUILD_FAILURE_MESSAGE}\nBuild diagnostics:\n${EffectArray.join(diagnostics, '\n')}`;
}

function renderBuildDiagnostic(value: unknown): string {
  const message = diagnosticMessage(value);
  if (!message) return '';

  const position = isRecord(value) && isRecord(value.position) ? value.position : undefined;
  const file = position && typeof position.file === 'string' ? position.file : undefined;
  const line = position && typeof position.line === 'number' ? position.line : undefined;
  const column = position && typeof position.column === 'number' ? position.column : undefined;
  const location = file
    ? EffectArray.join(
        EffectArray.map(
          EffectArray.filter([file, line, column], (part): part is string | number => part !== undefined),
          item => (item === null || item === undefined ? '' : String(item)),
        ),
        ':',
      )
    : undefined;
  const lineText =
    position && typeof position.lineText === 'string'
      ? Effect2.pipe(position.lineText, EffectString.trimEnd)
      : undefined;

  return EffectArray.join(
    EffectArray.filter(
      [`${location ? `${location}: ` : ''}${message}`, lineText ? `  ${lineText}` : undefined],
      (part): part is string => part !== undefined,
    ),
    '\n',
  );
}

function diagnosticMessage(value: unknown): string {
  if (value instanceof Error) return Effect2.pipe(value.message, EffectString.trim);
  if (isRecord(value) && typeof value.message === 'string') return Effect2.pipe(value.message, EffectString.trim);
  return typeof value === 'string' ? Effect2.pipe(value, EffectString.trim) : '';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}
