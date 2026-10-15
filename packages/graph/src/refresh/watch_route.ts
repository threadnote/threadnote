import {Effect, Path} from 'effect';
import {expandPath} from '@threadnote/platform/paths';
import {SystemInfo} from '@threadnote/platform/system';
import {USER_MANIFEST_NAME} from '@threadnote/workspace/constants';
import type {CodeGraphWatchOptions} from '../watcher.js';
import {resolveCodeGraphRefreshRoute, type CodeGraphResolvedRefreshRoute} from '../scope/routing.js';

export const resolveCodeGraphWatchOptions = Effect.fn('codeGraph.resolveWatchOptions')(function* (
  options: CodeGraphWatchOptions,
) {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const intent = options.refreshIntent ?? {
    manifestPath: yield* expandPath(
      options.manifestPath ??
        system.environment().THREADNOTE_MANIFEST ??
        path.join(options.threadnoteHome, USER_MANIFEST_NAME),
    ),
    project: options.project,
  };
  const refreshRoute = yield* resolveCodeGraphRefreshRoute(
    intent.manifestPath,
    options.cwd,
    intent.project,
    undefined,
    options.refreshIntent === undefined ? 'verify' : 'resolve',
  );
  return {
    ...options,
    refreshIntent: intent,
    refreshRoute,
    project: refreshRoute.route.state === 'selected' ? refreshRoute.route.project : undefined,
  };
});

export function sameCodeGraphWatchRoute(
  left: CodeGraphResolvedRefreshRoute | undefined,
  right: CodeGraphResolvedRefreshRoute | undefined,
): boolean {
  return (
    left?.manifestPath === right?.manifestPath &&
    left?.manifestRevision === right?.manifestRevision &&
    left?.route.state === right?.route.state &&
    (left?.route.state !== 'selected' ||
      (right?.route.state === 'selected' &&
        left.route.project.name === right.route.project.name &&
        left.route.project.uri === right.route.project.uri))
  );
}
