import {Console, Effect, Path, Schema} from 'effect';
import {CommandExecutor} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {errorMessage, fromSync} from '@threadnote/platform/errors';
import {prepareDevSkillsRefresh, previewDevSkillsRefresh, readDevSkillsRefresh} from '../dev_skills/index.js';
import type {DevSkillsReleaseIdentity} from '../dev_skills/contract.js';
import {parseCapabilities} from '../dev_skills/refresh_state.js';
import {stableJson} from '../dev_skills/files.js';

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
  const executable = path.join(bundleRoot, system.platform === 'win32' ? 'threadnote.exe' : 'threadnote');
  const response = yield* command.execute(
    executable,
    ['--home', config.agentContextHome, 'dev-skills', 'runtime-capabilities', '--json'],
    {
      maxOutputBytes: 16_384,
      timeoutMs: 30_000,
    },
  );
  const capabilities = yield* fromSync('read candidate workflow capabilities', () =>
    parseCapabilities(JSON.parse(response.stdout)),
  );
  const preview = yield* previewDevSkillsRefresh(config, {releaseRoot, releaseVersion, bundleRoot, capabilities});
  return yield* prepareDevSkillsRefresh(config, preview, {expectedDigest: preview.previewDigest});
});

/** Start only after releasing the parent's installation lock: the child reacquires it. */
export const refreshReleaseDevSkills = Effect.fn('update.refreshDevSkills')(function* (
  config: RuntimeConfig,
  prepared: PreparedReleaseDevSkills,
) {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const command = yield* CommandExecutor;
  const executable = path.join(
    prepared.release.releaseRoot,
    system.platform === 'win32' ? 'threadnote.exe' : 'threadnote',
  );
  const attempt = yield* command
    .execute(
      executable,
      ['--home', config.agentContextHome, 'dev-skills', 'refresh-enrolled', '--intent', prepared.intentId, '--json'],
      {maxOutputBytes: 8_000_000, timeoutMs: 10 * 60_000},
    )
    .pipe(Effect.result);
  if (attempt._tag === 'Failure')
    return yield* DevSkillsUpdatePending.make({
      message: `Threadnote is active, but workflow refresh is pending. Run threadnote update to retry. ${errorMessage(attempt.failure).slice(0, 1500)}`,
    });
  const reply = yield* fromSync(
    'read workflow refresh response',
    () => JSON.parse(attempt.success.stdout) as unknown,
  ).pipe(
    Effect.mapError(() =>
      DevSkillsUpdatePending.make({
        message: 'Workflow refresh returned an invalid response. Run threadnote update to verify and retry.',
      }),
    ),
  );
  const durable = yield* readDevSkillsRefresh(config);
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
    const pending = durable.targets.filter(target => target.outcome.state === 'pending');
    const batchIssues = (durable.issues ?? []).map(issue => issue.message);
    const diagnostics = [
      ...batchIssues,
      ...pending.map(
        target => `${target.target.surfaceId}: ${target.outcome.issues.map(issue => issue.message).join(' ')}`,
      ),
    ];
    if (diagnostics.length) yield* Console.error(diagnostics.join('\n'));
    const attention = pending.length
      ? `${pending.length} workflow target(s) need attention.`
      : 'Workflow refresh is pending.';
    const detail = batchIssues.length ? ` ${batchIssues.join(' ')}` : '';
    return yield* DevSkillsUpdatePending.make({
      message: `Threadnote is active; ${attention}${detail} Run threadnote update again to retry.`,
    });
  }
  yield* Console.log(
    `Development workflows refreshed (${durable.targets.filter(target => target.outcome.state === 'current').length} current, ${durable.targets.filter(target => target.outcome.state === 'skipped').length} skipped).`,
  );
  return durable;
});
