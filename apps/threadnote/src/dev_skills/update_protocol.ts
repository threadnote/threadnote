import {Array as A, Effect, FileSystem, Path, Record as R, String as S} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import {fromSync} from '@threadnote/platform/errors';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {DevSkillsRefreshResult, DevSkillsReleaseIdentity} from './contract.js';
import {fail, isRecord, requireValue} from './files.js';
import {readDevSkillsRuntimeCapabilities} from './capabilities.js';
import {devSkillsRuntimeVersion} from './manifest.js';
import {prepareDevSkillsRefresh, previewDevSkillsRefresh} from './refresh_preview.js';
import {runDevSkillsRefresh} from './refresh.js';
import {digest, readDevSkillsRefresh, version} from './refresh_state.js';

/** This wire contract stays independent of candidate manifest and journal schemas. */
export interface PreparedDevSkillsUpdate {
  readonly protocolVersion: 1;
  readonly intentId: string;
  readonly release: DevSkillsReleaseIdentity;
}
export interface DevSkillsUpdateStatus extends PreparedDevSkillsUpdate {
  readonly current: number;
  readonly skipped: number;
  readonly pending: number;
  readonly repairRequired: boolean;
  readonly diagnostics: readonly string[];
}
const boundedPath = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 4096;
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2048;

function parsePrepared(value: unknown, fields: readonly string[]): PreparedDevSkillsUpdate {
  requireValue(
    isRecord(value) &&
      A.every(R.keys(value), key => ['protocolVersion', 'intentId', 'release', ...fields].includes(key)) &&
      value.protocolVersion === 1 &&
      digest(value.intentId) &&
      isRecord(value.release),
    'Invalid workflow update protocol response.',
  );
  const release = value.release;
  requireValue(
    A.every(R.keys(release), key =>
      ['installationRoot', 'releaseRoot', 'releaseVersion', 'bundleDigest'].includes(key),
    ) &&
      boundedPath(release.installationRoot) &&
      boundedPath(release.releaseRoot) &&
      version(release.releaseVersion) &&
      digest(release.bundleDigest),
    'Invalid workflow update release identity.',
  );
  return {
    protocolVersion: 1,
    intentId: value.intentId,
    release: {
      installationRoot: release.installationRoot,
      releaseRoot: release.releaseRoot,
      releaseVersion: release.releaseVersion,
      bundleDigest: release.bundleDigest,
    },
  };
}
export const parsePreparedDevSkillsUpdate = (value: unknown): PreparedDevSkillsUpdate => parsePrepared(value, []);
export function parseDevSkillsUpdateStatus(value: unknown): DevSkillsUpdateStatus {
  const prepared = parsePrepared(value, ['current', 'skipped', 'pending', 'repairRequired', 'diagnostics']);
  requireValue(isRecord(value), 'Invalid workflow update status.');
  const {current, skipped, pending, repairRequired, diagnostics} = value;
  requireValue(
    count(current) &&
      count(skipped) &&
      count(pending) &&
      current + skipped + pending <= 2048 &&
      typeof repairRequired === 'boolean' &&
      A.isArray(diagnostics) &&
      diagnostics.length <= 64 &&
      A.every(diagnostics, (item): item is string => typeof item === 'string' && item.length <= 1000) &&
      (repairRequired || (pending === 0 && diagnostics.length === 0)),
    'Invalid workflow update status.',
  );
  return {
    ...prepared,
    current,
    skipped,
    pending,
    repairRequired,
    diagnostics,
  };
}
export function projectDevSkillsUpdateStatus(result: DevSkillsRefreshResult): DevSkillsUpdateStatus {
  const diagnostics = A.map(result.issues ?? [], issue => issue.message);
  const counts = {current: 0, skipped: 0, pending: 0};
  for (const target of result.targets) {
    counts[target.outcome.state] += 1;
    if (target.outcome.state === 'pending')
      for (const issue of target.outcome.issues) diagnostics.push(`${target.target.surfaceId}: ${issue.message}`);
  }
  const rendered = A.map(A.take(diagnostics, 64), message =>
    message.length > 1000 ? `${S.slice(0, 997)(message)}...` : message,
  );
  if (diagnostics.length > rendered.length)
    rendered[63] = 'Additional workflow diagnostics omitted. Run dev-skills status to inspect the pending targets.';
  return parseDevSkillsUpdateStatus({
    protocolVersion: 1,
    intentId: result.intentId,
    release: result.release,
    ...counts,
    repairRequired: result.repairRequired,
    diagnostics: rendered,
  });
}

/** The verified candidate owns its manifest parsing; the parent holds the installation lock. */
export const prepareCandidateDevSkillsUpdate = Effect.fn('devSkills.prepareCandidateUpdate')(function* (
  config: RuntimeConfig,
  releaseRoot: string,
  releaseVersion: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  const executable = system.executablePath;
  const expectedName = system.platform === 'win32' ? 'threadnote.exe' : 'threadnote';
  if (
    path.basename(executable) !== expectedName ||
    (yield* fs.realPath(executable)) !== executable ||
    (yield* fs.stat(executable)).type !== 'File' ||
    (yield* devSkillsRuntimeVersion()) !== releaseVersion
  )
    return yield* fail('invalid-candidate', 'Update preparation requires the exact candidate executable and version.');
  const capabilities = yield* readDevSkillsRuntimeCapabilities();
  const preview = yield* previewDevSkillsRefresh(config, {
    releaseRoot,
    releaseVersion,
    bundleRoot: path.dirname(executable),
    capabilities,
  });
  const prepared = yield* prepareDevSkillsRefresh(config, preview, {expectedDigest: preview.previewDigest});
  return {protocolVersion: 1 as const, ...prepared};
});
export const refreshCandidateDevSkillsUpdate = Effect.fn('devSkills.refreshCandidateUpdate')(function* (
  config: RuntimeConfig,
  intentId: string,
) {
  const result = yield* runDevSkillsRefresh(config, intentId);
  return yield* fromSync('project workflow update result', () => projectDevSkillsUpdateStatus(result));
});
export const readCandidateDevSkillsUpdate = Effect.fn('devSkills.readCandidateUpdate')(function* (
  config: RuntimeConfig,
  intentId: string,
) {
  const result = yield* readDevSkillsRefresh(config);
  if (!digest(intentId) || result?.intentId !== intentId)
    return yield* fail('invalid-intent', 'Workflow update status requires its exact durable intent.');
  return yield* fromSync('project durable workflow update status', () => projectDevSkillsUpdateStatus(result));
});
