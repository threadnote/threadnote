import {Cause, Clock, DateTime, Effect, Scope} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {isStandaloneThreadnoteBuild} from '@threadnote/workspace/runtime-version';
import {SystemInfo} from '@threadnote/platform/system';
import {redactSensitiveText} from '@threadnote/platform/scrubber';
import {requireConfirm} from '@threadnote/manager/request_inputs';
import type {RuntimeUpdateJob, RuntimeUpdates} from '@threadnote/manager/update-contracts';
import {activeInstalledVersion, executingInstalledRelease} from '../installations.js';
import {
  currentPackageVersion,
  fetchLatestVersion,
  resolveReleaseSource,
  runUpdate,
  shouldPreferActiveInstalledVersion,
} from '../release/update.js';
import {selectUpdateChannel} from '../release/channel.js';
import {compareVersions, isDevelopmentBuildVersion} from '../release/version/compare.js';
import {readAutoUpdateStatus, runAutoUpdatePolicyCommand} from '../release/auto_update.js';
import {fetchThreadnoteReleaseNotes, releaseForVersion, releasesBetween, type ReleaseNote} from '../release/notes.js';
import {captureConsoleWithoutProgress} from '../effect/console.js';
import {managerFeatureError} from './feature_errors.js';

interface UpdateRequest {
  readonly body: Effect.Effect<Record<string, unknown>, unknown>;
  readonly config: RuntimeConfig;
  readonly jobContext?: {readonly key: object; readonly scope: Scope.Scope};
  readonly method: string;
  readonly url: URL;
}
interface ReleaseSnapshot {
  readonly version: string;
  readonly checkedAt: string;
  readonly latestVersion?: string;
  readonly checkError?: string;
  readonly notesError?: string;
  readonly notes: readonly ReleaseNote[];
}
interface UpdateSession {
  snapshot?: ReleaseSnapshot;
  checking?: boolean;
  starting?: boolean;
  job?: RuntimeUpdateJob;
}
const sessions = new WeakMap<object, UpdateSession>();
const CACHE_MILLISECONDS = 5 * 60_000;

const readLocalUpdateState = Effect.fn('managerUpdates.readLocal')(function* () {
  const runningVersion = yield* currentPackageVersion();
  const standaloneBuild = isStandaloneThreadnoteBuild();
  const runningInstalledRelease =
    standaloneBuild && !isDevelopmentBuildVersion(runningVersion)
      ? (yield* executingInstalledRelease()) !== undefined
      : false;
  const activeVersion = shouldPreferActiveInstalledVersion({
    packageVersion: runningVersion,
    preferInstalledVersion: true,
    runningInstalledRelease,
    standaloneBuild,
  })
    ? yield* activeInstalledVersion()
    : undefined;
  const installedVersion = activeVersion ?? runningVersion;
  const automatic = yield* readAutoUpdateStatus();
  return {
    installedVersion,
    runningVersion,
    channel: selectUpdateChannel(installedVersion),
    developmentBuild: isDevelopmentBuildVersion(installedVersion) || isDevelopmentBuildVersion(runningVersion),
    restartRequired: runningInstalledRelease && installedVersion !== runningVersion,
    policy: automatic.effectivePolicy,
    policyManaged: automatic.policySource === 'environment',
    automaticRunning: automatic.running !== undefined,
    automaticFailure: automatic.lastFailure?.summary,
  };
});

function readableError(cause: unknown): string {
  return redactSensitiveText(cause instanceof Error ? cause.message : String(cause));
}

const checkReleases = Effect.fn('managerUpdates.checkReleases')(function* (
  local: Effect.Success<ReturnType<typeof readLocalUpdateState>>,
) {
  const system = yield* SystemInfo;
  const latest = yield* Effect.gen(function* () {
    const source = resolveReleaseSource(undefined, undefined, system.environment());
    return yield* fetchLatestVersion(source, local.channel);
  }).pipe(
    Effect.map(latestVersion => ({latestVersion, checkError: undefined})),
    Effect.catchCause(cause =>
      Effect.succeed({latestVersion: undefined, checkError: readableError(Cause.squash(cause))}),
    ),
  );
  const notes = yield* fetchThreadnoteReleaseNotes({includePrereleases: local.channel === 'beta'}).pipe(
    Effect.map(notes => ({notes, notesError: undefined})),
    Effect.catchCause(cause => Effect.succeed({notes: [], notesError: readableError(Cause.squash(cause))})),
  );
  return {
    ...latest,
    ...notes,
    version: local.installedVersion,
    checkedAt: DateTime.formatIso(yield* DateTime.now),
  } satisfies ReleaseSnapshot;
});

function response(
  local: Effect.Success<ReturnType<typeof readLocalUpdateState>>,
  session: UpdateSession,
): RuntimeUpdates {
  const snapshot = session.snapshot;
  const latestVersion = snapshot?.version === local.installedVersion ? snapshot.latestVersion : undefined;
  const updateAvailable =
    !local.developmentBuild &&
    latestVersion !== undefined &&
    compareVersions(local.installedVersion, latestVersion) < 0;
  return {
    ...local,
    latestVersion,
    updateAvailable,
    checkedAt: snapshot?.checkedAt,
    checkError: snapshot?.checkError,
    notesError: snapshot?.notesError,
    installedNotes: releaseForVersion(snapshot?.notes ?? [], local.installedVersion),
    availableNotes: updateAvailable
      ? releasesBetween(snapshot?.notes ?? [], local.installedVersion, latestVersion)
      : [],
    job: session.job,
  };
}

const routeUpdates = Effect.fn('managerUpdates.handleRequest')(function* (request: UpdateRequest) {
  if (request.url.pathname !== '/api/runtime/updates') return undefined;
  if (request.method !== 'GET' && request.method !== 'POST') return {status: 405, body: {error: 'Method not allowed'}};
  const context = request.jobContext;
  if (!context) return {status: 503, body: {error: 'Manager update services are unavailable.'}};
  let session = sessions.get(context.key);
  if (!session) {
    session = {};
    sessions.set(context.key, session);
  }
  const currentSession = session;
  const body = request.method === 'POST' ? yield* request.body : {};
  const action = body.action;
  let local = yield* readLocalUpdateState();
  if (request.method === 'POST' && action !== 'check') {
    requireConfirm(body);
    if (action === 'policy') {
      if (local.policyManaged) throw new Error('Automatic updates are controlled by an environment setting.');
      if (body.policy !== 'automatic' && body.policy !== 'notify') throw new Error('Choose a valid update policy.');
      yield* captureConsoleWithoutProgress(runAutoUpdatePolicyCommand(body.policy));
      local = yield* readLocalUpdateState();
    } else if (action === 'update') {
      if (currentSession.starting || currentSession.job?.status === 'running') {
        return {status: 202, body: response(local, currentSession)};
      }
      if (local.developmentBuild)
        throw new Error('This is a development installation. Update it from its owning checkout.');
      if (local.automaticRunning) throw new Error('An automatic update is already running.');
      // The CLI rechecks eligibility and takes the installation lock before writing.
      currentSession.starting = true;
      currentSession.job = {status: 'running', message: 'Downloading and installing Threadnote…'};
      const worker = captureConsoleWithoutProgress(runUpdate(request.config, {yes: true})).pipe(
        Effect.matchCauseEffect({
          onSuccess: result =>
            Effect.sync(() => {
              currentSession.snapshot = undefined;
              currentSession.job = {
                status: 'completed',
                message: 'Update finished. New Threadnote sessions will use the installed version.',
                output: redactSensitiveText(result.output).slice(-16_000),
              };
            }),
          onFailure: cause =>
            Effect.sync(() => {
              currentSession.snapshot = undefined;
              currentSession.job = {status: 'failed', message: readableError(Cause.squash(cause))};
            }),
        }),
      );
      yield* worker.pipe(
        Effect.forkIn(context.scope),
        Effect.ensuring(Effect.sync(() => (currentSession.starting = false))),
      );
      return {status: 202, body: response(local, currentSession)};
    } else throw new Error('Unknown update action.');
  }
  const now = yield* Clock.currentTimeMillis;
  const stale =
    !currentSession.snapshot ||
    currentSession.snapshot.version !== local.installedVersion ||
    now - Date.parse(currentSession.snapshot.checkedAt) >= CACHE_MILLISECONDS;
  // Status polls and Manager's heartbeat never perform release discovery.
  const check =
    action === 'check' || (request.method === 'GET' && request.url.searchParams.get('view') !== 'status' && stale);
  if (check && !currentSession.checking && currentSession.job?.status !== 'running') {
    currentSession.checking = true;
    yield* checkReleases(local).pipe(
      Effect.tap(snapshot => Effect.sync(() => (currentSession.snapshot = snapshot))),
      Effect.ensuring(Effect.sync(() => (currentSession.checking = false))),
    );
  }
  return {status: 200, body: response(local, currentSession)};
});

export const handleManagerUpdateRequest = (request: UpdateRequest) =>
  routeUpdates(request).pipe(Effect.catchCause(managerFeatureError));
