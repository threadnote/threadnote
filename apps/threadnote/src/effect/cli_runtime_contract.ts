import type {Effect} from 'effect';
import type {Command} from 'effect/cli';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type * as FileSystemService from 'effect/FileSystem';
import type * as PathService from 'effect/Path';
import type * as PlatformErrorType from 'effect/PlatformError';
import type {ApplicationError} from '@threadnote/platform/errors';
import type {SystemInfo} from '@threadnote/platform/system';

export type CliRuntimeRunner = <E, R>(
  effect: (config: RuntimeConfig) => Effect.Effect<void, E, R>,
) => Effect.Effect<
  void,
  E | ApplicationError | PlatformErrorType.PlatformError,
  R | Command.CommandContext<'threadnote'> | FileSystemService.FileSystem | PathService.Path | SystemInfo
>;
