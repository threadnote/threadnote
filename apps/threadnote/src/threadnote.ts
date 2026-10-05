import {Console, Effect, Schema} from 'effect';
import {Command} from 'effect/cli';
import {errorMessage} from '@threadnote/platform/errors';
import {getThreadnoteVersion} from '@threadnote/workspace/runtime-version';
import {ApplicationError} from '@threadnote/platform/errors';
import {CliError, inspectCliInvocation, normalizeCliArguments, threadnoteCommand} from './effect/cli.js';
import {initializeCliUi} from './cli_ui.js';
import {SystemInfo} from '@threadnote/platform/system';
import {withProductionLogging} from './effect/production_log.js';
import {expandPath} from '@threadnote/platform/paths';
import {withAnonymousTelemetry} from './effect/telemetry.js';
import {
  CODE_GRAPH_REFRESH_DEMAND_SUPERSEDED_EXIT_CODE,
  CodeGraphRefreshDemandSuperseded,
} from '@threadnote/graph/refresh/demand';

export const cliEffect = (arguments_: readonly string[]) => {
  const failureExitCode = inspectCliInvocation(arguments_).failureExitCode ?? 1;
  const program = Effect.gen(function* () {
    yield* initializeCliUi();
    const version = yield* getThreadnoteVersion();
    return yield* Command.runWith(threadnoteCommand, {version})(normalizeCliArguments(arguments_));
  });
  const loggedProgram = cliDiagnosticContext(arguments_).pipe(
    Effect.matchEffect({
      onFailure: () => program,
      onSuccess: context =>
        context === undefined
          ? program
          : context.writeAnonymousTelemetry
            ? withAnonymousTelemetry(
                {component: 'cli', operation: context.telemetryOperation},
                context.writeProductionLog
                  ? withProductionLogging(context.home, {component: 'cli', operation: context.operation}, program)
                  : program,
              )
            : context.writeProductionLog
              ? withProductionLogging(context.home, {component: 'cli', operation: context.operation}, program)
              : program,
    }),
  );
  return loggedProgram.pipe(
    Effect.catchDefect(defect =>
      Effect.gen(function* () {
        yield* Console.error(errorMessage(defect));
        const system = yield* SystemInfo;
        yield* Effect.sync(() => system.setExitCode(failureExitCode));
      }),
    ),
    Effect.tapError(error =>
      CliError.isCliError(error)
        ? Effect.void
        : Console.error(errorMessage(Schema.is(ApplicationError)(error) ? error.cause : error)),
    ),
    Effect.catch(error =>
      Effect.flatMap(SystemInfo, system =>
        Effect.sync(() =>
          system.setExitCode(
            Schema.is(CodeGraphRefreshDemandSuperseded)(error)
              ? CODE_GRAPH_REFRESH_DEMAND_SUPERSEDED_EXIT_CODE
              : failureExitCode,
          ),
        ),
      ),
    ),
  );
};

const cliDiagnosticContext = Effect.fn('threadnote.cliDiagnosticContext')(function* (arguments_: readonly string[]) {
  const invocation = inspectCliInvocation(arguments_);
  if ((!invocation.writeProductionLog && !invocation.writeAnonymousTelemetry) || invocation.operation === undefined) {
    return undefined;
  }
  const system = yield* SystemInfo;
  const home = yield* expandPath(invocation.homeOverride ?? system.environment().THREADNOTE_HOME ?? '~/.threadnote');
  return {
    home,
    operation: invocation.operation,
    telemetryOperation: invocation.telemetryOperation ?? 'unknown',
    writeAnonymousTelemetry: invocation.writeAnonymousTelemetry,
    writeProductionLog: invocation.writeProductionLog,
  };
});
