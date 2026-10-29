import {Array, Console, Effect, Path, Schema} from 'effect';
import {CommandExecutor} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {errorMessage, fromSync} from '@threadnote/platform/errors';
import type {DevSkillsReleaseIdentity} from '../dev_skills/contract.js';
import {stableJson} from '../dev_skills/files.js';
import {parseDevSkillsUpdateStatus, parsePreparedDevSkillsUpdate} from '../dev_skills/update_protocol.js';
import {installationRoot} from '../process/standalone_lease.js';

export class DevSkillsUpdatePending extends Schema.TaggedError<DevSkillsUpdatePending>()('DevSkillsUpdatePending', {
  message: Schema.String,
}) {}

export interface PreparedReleaseDevSkills {
  readonly intentId: string;
  readonly release: DevSkillsReleaseIdentity;
}

/** The caller holds the installation lock; the candidate is verified before promotion. */
export const prepareReleaseDevSkills = Effect.fn('update.prepareDevSkills')(function* (
  config: RuntimeConfig,
  releaseRoot: string,
  releaseVersion: string,
  bundleRoot = releaseRoot,
) {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const command = yield* CommandExecutor;
  const env = {...system.environment(), THREADNOTE_INSTALL_ROOT: installationRoot(path, system)};
  const executable = path.join(bundleRoot, system.platform === 'win32' ? 'threadnote.exe' : 'threadnote');
  const response = yield* command.execute(
    executable,
    [
      '--home',
      config.agentContextHome,
      'dev-skills',
      'prepare-update',
      '--protocol-version',
      '1',
      '--release-root',
      releaseRoot,
      '--release-version',
      releaseVersion,
    ],
    {
      maxOutputBytes: 16_384,
      env,
      // Preparation now includes the candidate's full ownership preview and coordinator CAS.
      timeoutMs: 10 * 60_000,
    },
  );
  const prepared = yield* fromSync('read candidate workflow update intent', () =>
    parsePreparedDevSkillsUpdate(JSON.parse(response.stdout)),
  );
  if (
    prepared.release.releaseRoot !== releaseRoot ||
    prepared.release.releaseVersion !== releaseVersion ||
    path.join(prepared.release.installationRoot, 'versions', releaseVersion) !== releaseRoot ||
    path.resolve(releaseRoot) !== releaseRoot
  )
    return yield* DevSkillsUpdatePending.make({
      message: 'Candidate workflow update identity differs from the verified release.',
    });
  const status = yield* command.execute(
    executable,
    [
      '--home',
      config.agentContextHome,
      'dev-skills',
      'update-status',
      '--protocol-version',
      '1',
      '--intent',
      prepared.intentId,
    ],
    {env, maxOutputBytes: 8_000_000, timeoutMs: 30_000},
  );
  const durable = yield* fromSync('verify prepared workflow update intent', () =>
    parseDevSkillsUpdateStatus(JSON.parse(status.stdout)),
  );
  if (durable.intentId !== prepared.intentId || stableJson(durable.release) !== stableJson(prepared.release))
    return yield* DevSkillsUpdatePending.make({
      message: 'Candidate workflow preparation does not match its durable intent.',
    });
  return {intentId: prepared.intentId, release: prepared.release};
});

/** Start only after releasing the parent's installation lock: the child reacquires it. */
export const refreshReleaseDevSkills = Effect.fn('update.refreshDevSkills')(function* (
  config: RuntimeConfig,
  prepared: PreparedReleaseDevSkills,
) {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const command = yield* CommandExecutor;
  const env = {...system.environment(), THREADNOTE_INSTALL_ROOT: installationRoot(path, system)};
  const executable = path.join(
    prepared.release.releaseRoot,
    system.platform === 'win32' ? 'threadnote.exe' : 'threadnote',
  );
  const attempt = yield* command
    .execute(
      executable,
      [
        '--home',
        config.agentContextHome,
        'dev-skills',
        'refresh-update',
        '--protocol-version',
        '1',
        '--intent',
        prepared.intentId,
      ],
      {env, maxOutputBytes: 8_000_000, timeoutMs: 10 * 60_000},
    )
    .pipe(Effect.result);
  if (attempt._tag === 'Failure')
    return yield* DevSkillsUpdatePending.make({
      message: `Threadnote is active, but workflow refresh is pending. Run threadnote update to retry. ${errorMessage(attempt.failure).slice(0, 1500)}`,
    });
  const reply = yield* fromSync('read workflow refresh response', () =>
    parseDevSkillsUpdateStatus(JSON.parse(attempt.success.stdout)),
  ).pipe(
    Effect.mapError(() =>
      DevSkillsUpdatePending.make({
        message: 'Workflow refresh returned an invalid response. Run threadnote update to verify and retry.',
      }),
    ),
  );
  const durable = yield* command
    .execute(
      executable,
      [
        '--home',
        config.agentContextHome,
        'dev-skills',
        'update-status',
        '--protocol-version',
        '1',
        '--intent',
        prepared.intentId,
      ],
      {env, maxOutputBytes: 8_000_000, timeoutMs: 30_000},
    )
    .pipe(
      Effect.flatMap(status =>
        fromSync('read durable workflow update status', () => parseDevSkillsUpdateStatus(JSON.parse(status.stdout))),
      ),
      Effect.mapError(() =>
        DevSkillsUpdatePending.make({
          message: 'Workflow refresh durable status could not be verified. Run threadnote update to verify and retry.',
        }),
      ),
    );
  if (
    !durable ||
    durable.intentId !== prepared.intentId ||
    stableJson(durable.release) !== stableJson(prepared.release) ||
    stableJson(durable) !== stableJson(reply)
  )
    return yield* DevSkillsUpdatePending.make({
      message:
        'Workflow refresh response does not match its durable intent. Run threadnote update to retry the active release.',
    });
  if (durable.repairRequired) {
    if (durable.diagnostics.length) yield* Console.error(Array.join(durable.diagnostics, '\n'));
    const attention = durable.pending
      ? `${durable.pending} workflow target(s) need attention.`
      : 'Workflow refresh is pending.';
    return yield* DevSkillsUpdatePending.make({
      message: `Threadnote is active; ${attention} Run threadnote update again to retry.`,
    });
  }
  yield* Console.log(`Development workflows refreshed (${durable.current} current, ${durable.skipped} skipped).`);
  return durable;
});
