import {DateTime, Effect, FileSystem, Path, Result, Schema} from 'effect';

import {readBoundedContainedStableRegularFile} from '@threadnote/graph/inventory/contained_file';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {runCommandEffect} from '@threadnote/platform/command';
import {writeFinalCliOutput} from '../../effect/cli/output.js';
import {SystemInfo} from '@threadnote/platform/system';
import {uriSegment} from '@threadnote/workspace/manifest';
import {parseGitCanonicalSharePath} from '@threadnote/remote-memory/git/canonical_store';
import {readTeamsFile} from '../../share/index.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {ShareTeamConfig} from '../../types.js';
import {buildContextHealthReport, type ContextHealthRelationEvidenceV1} from '@threadnote/context/health';
import {collectContextHealth} from './health_commands.js';
import {
  aggregateContextHealthReportsV1,
  buildContextHealthSchedulePlanV1,
  canonicalContextHealthProjectV1,
  canonicalContextHealthTeamsV1,
  renderContextHealthAggregate,
  renderContextHealthSchedulePlan,
  type ContextHealthAggregateSourceV1,
  type ContextHealthAggregateUnknownReasonV1,
} from '@threadnote/context/health_schedule';
import {memoryHeaderValue, parseMemoryDocument, type MemoryRecord} from '@threadnote/memory/document';
import {memoryIdFromIdentityAlias} from '@threadnote/memory/identity-alias';
import {readPersonalProjectMemoryRecords} from '../maintenance/records.js';

const MAXIMUM_TEAM_FILES = 1_000;
const MAXIMUM_TEAM_FILE_BYTES = 256 * 1_024;
const MAXIMUM_TEAM_TOTAL_BYTES = 8 * 1_024 * 1_024;
const MAXIMUM_GIT_OUTPUT_BYTES = 1_048_576;
const GIT_TIMEOUT_MILLISECONDS = 10_000;
const GIT_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

class ContextHealthAggregateReadError extends Schema.TaggedError<ContextHealthAggregateReadError>()(
  'ContextHealthAggregateReadError',
  {cause: Schema.optionalKey(Schema.Defect()), message: Schema.String},
) {}

export interface ContextHealthAggregateOptionsV1 {
  readonly callerCwd: string;
  readonly json?: boolean;
  readonly project: string;
  readonly teams?: readonly string[];
}

export interface ContextHealthScheduleOptionsV1 {
  readonly cadenceMinutes: number;
  readonly json?: boolean;
  readonly project: string;
  readonly teams?: readonly string[];
}

/** Bounded production sources retained by local replay evidence before pure aggregation. */
export interface ContextHealthAggregateSourcesV1 {
  readonly personal: ContextHealthAggregateSourceV1;
  readonly project: string;
  readonly teams: readonly ContextHealthAggregateSourceV1[];
}

export const collectContextHealthAggregateSources = Effect.fn('memory.contextHealth.aggregateSources')(function* (
  config: RuntimeConfig,
  options: ContextHealthAggregateOptionsV1,
) {
  const project = yield* Effect.try({
    try: () => canonicalContextHealthProjectV1(options.project),
    catch: cause => aggregateReadError('Context health project is not a portable project segment.', cause),
  });
  const requestedTeams = yield* Effect.try({
    try: () =>
      options.teams === undefined || options.teams.length === 0
        ? undefined
        : canonicalContextHealthTeamsV1(options.teams),
    catch: cause => aggregateReadError('Context health team selection is invalid.', cause),
  });
  const personal = yield* collectPersonalSource(config, project, options.callerCwd);
  const teamsFile = yield* readTeamsFile(config).pipe(Effect.result);
  const teams: ContextHealthAggregateSourceV1[] = [];
  if (Result.isFailure(teamsFile)) {
    if (requestedTeams && requestedTeams.length > 0) {
      teams.push(...requestedTeams.map(team => unknownTeam(team, 'snapshot-unreadable')));
    } else {
      teams.push(unknownTeamSelection('snapshot-unreadable'));
    }
  } else {
    const selected =
      requestedTeams === undefined
        ? yield* Effect.try({
            try: () => canonicalContextHealthTeamsV1(Object.keys(teamsFile.success.teams)),
            catch: cause => aggregateReadError('Configured context health team selection is invalid.', cause),
          }).pipe(Effect.result)
        : Result.succeed(requestedTeams);
    if (Result.isFailure(selected)) {
      teams.push(unknownTeamSelection('configured-teams-invalid'));
    } else {
      for (const team of selected.success) {
        const teamConfig = teamsFile.success.teams[team];
        teams.push(
          teamConfig === undefined
            ? unknownTeam(team, 'team-not-configured')
            : yield* collectTeamSource(config, project, team, teamConfig),
        );
      }
    }
  }
  return {personal, project, teams} satisfies ContextHealthAggregateSourcesV1;
});

export const collectContextHealthAggregate = Effect.fn('memory.contextHealth.aggregate')(function* (
  config: RuntimeConfig,
  options: ContextHealthAggregateOptionsV1,
) {
  const sources = yield* collectContextHealthAggregateSources(config, options);
  return aggregateContextHealthReportsV1(sources);
});

export const runContextHealthAggregate = Effect.fn('memory.contextHealth.aggregateCommand')(function* (
  config: RuntimeConfig,
  options: Omit<ContextHealthAggregateOptionsV1, 'callerCwd'>,
) {
  const system = yield* SystemInfo;
  const aggregate = yield* collectContextHealthAggregate(config, {
    ...options,
    callerCwd: system.currentDirectory(),
  });
  yield* writeFinalCliOutput(options.json ? JSON.stringify(aggregate) : renderContextHealthAggregate(aggregate));
  yield* Effect.sync(() => system.setExitCode(aggregate.exitCode));
});

export const runContextHealthSchedule = Effect.fn('memory.contextHealth.scheduleCommand')(function* (
  options: ContextHealthScheduleOptionsV1,
) {
  const plan = buildContextHealthSchedulePlanV1(options);
  yield* writeFinalCliOutput(options.json ? JSON.stringify(plan) : renderContextHealthSchedulePlan(plan));
});

const collectPersonalSource = Effect.fn('memory.contextHealth.aggregatePersonal')(function* (
  config: RuntimeConfig,
  project: string,
  callerCwd: string,
) {
  const recordsResult = yield* readPersonalProjectMemoryRecords(config, project).pipe(Effect.result);
  if (Result.isFailure(recordsResult)) return unknownPersonal('snapshot-unreadable');
  const corpus = recordsResult.success;
  const records = corpus.filter(record => record.metadata.status === 'active');
  const evidenceRevision = memoryRecordsRevision('personal', corpus);
  const report = yield* collectContextHealth(config, project, records, callerCwd, {relationCorpus: corpus}).pipe(
    Effect.result,
  );
  return Result.isFailure(report)
    ? unknownPersonal('snapshot-unreadable', evidenceRevision)
    : ({
        evidenceRevision: sha256HexSync(`${evidenceRevision}\n${canonicalJson(report.success)}`),
        report: report.success,
        scope: 'personal',
        state: 'complete',
      } satisfies ContextHealthAggregateSourceV1);
});

const collectTeamSource = Effect.fn('memory.contextHealth.aggregateTeam')(function* (
  config: RuntimeConfig,
  project: string,
  team: string,
  teamConfig: ShareTeamConfig,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!path.isAbsolute(teamConfig.worktree)) return unknownTeam(team, 'snapshot-unreadable');
  const exists = yield* fs.exists(teamConfig.worktree).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return unknownTeam(team, 'snapshot-missing');
  const worktreeLink = yield* fs.readLink(teamConfig.worktree).pipe(Effect.option);
  if (worktreeLink._tag === 'Some') return unknownTeam(team, 'snapshot-unreadable');
  const canonicalWorktree = yield* fs.realPath(teamConfig.worktree).pipe(Effect.result);
  if (Result.isFailure(canonicalWorktree)) return unknownTeam(team, 'snapshot-unreadable');
  const projectSegment = uriSegment(project);
  const beforeResult = yield* observeTeamSnapshot(canonicalWorktree.success, projectSegment).pipe(Effect.result);
  if (Result.isFailure(beforeResult)) return unknownTeam(team, 'snapshot-unreadable');
  const before = beforeResult.success;
  const headRevision = snapshotEvidenceRevision(before.head, []);
  if (before.dirty) return unknownTeam(team, 'snapshot-dirty', headRevision);

  const readResult = yield* readTeamRecords(
    config,
    project,
    projectSegment,
    team,
    canonicalWorktree.success,
    before.head,
  ).pipe(Effect.result);
  const afterResult = yield* observeTeamSnapshot(canonicalWorktree.success, projectSegment).pipe(Effect.result);
  if (Result.isFailure(afterResult) || afterResult.success.head !== before.head || afterResult.success.dirty) {
    return unknownTeam(team, 'snapshot-raced', headRevision);
  }
  if (Result.isFailure(readResult)) return unknownTeam(team, 'snapshot-unreadable', headRevision);
  const {active, all, evidenceRevision} = readResult.success;
  const now = yield* DateTime.nowAsDate;
  const report = buildContextHealthReport({
    citationValidations: [],
    guidanceEvidence: [],
    now,
    project,
    records: active,
    relationEvidence: relationEvidenceWithinSnapshot(active, all),
  });
  return active.some(
    record => (record.metadata.codeCitations?.length ?? 0) > 0 || (record.metadata.citationErrors?.length ?? 0) > 0,
  )
    ? {...unknownTeam(team, 'citation-evidence-unavailable', evidenceRevision), report}
    : ({evidenceRevision, report, scope: 'team', state: 'complete', team} satisfies ContextHealthAggregateSourceV1);
});

const readTeamRecords = Effect.fn('memory.contextHealth.readTeamRecords')(function* (
  config: RuntimeConfig,
  project: string,
  projectSegment: string,
  team: string,
  worktree: string,
  head: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const prefix = `durable/projects/${projectSegment}`;
  const listing = yield* runGit(worktree, ['ls-tree', '-r', '-z', head, '--', prefix]);
  if (listing.exitCode !== 0) return yield* aggregateReadError('Could not list the selected team snapshot.');
  const entries = (yield* Effect.forEach(listing.stdout.split('\0').filter(Boolean), raw =>
    Effect.try({
      try: () => parseTreeEntry(raw),
      catch: cause => aggregateReadError('Team snapshot Git tree is malformed.', cause),
    }),
  )).sort(compareTreeEntry);
  if (entries.length > MAXIMUM_TEAM_FILES) return yield* aggregateReadError('Team snapshot file limit exceeded.');
  const records: MemoryRecord[] = [];
  const evidence: {readonly contentHash: string; readonly path: string}[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    const relative = entry.path;
    const parsedPath = parseGitCanonicalSharePath(relative);
    if (parsedPath?.kind !== 'durable' || parsedPath.project !== projectSegment) {
      return yield* aggregateReadError('Selected team snapshot contains a non-canonical memory path.');
    }
    const bytes = yield* readBoundedContainedStableRegularFile(fs, path, worktree, relative, MAXIMUM_TEAM_FILE_BYTES);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAXIMUM_TEAM_TOTAL_BYTES) {
      return yield* aggregateReadError('Team snapshot byte limit exceeded.');
    }
    const observedObject = yield* runGit(worktree, ['hash-object', '--stdin'], bytes);
    if (observedObject.exitCode !== 0 || observedObject.stdout.trim() !== entry.objectId) {
      return yield* aggregateReadError('Team snapshot content does not match the selected Git revision.');
    }
    const content = yield* Effect.try({
      try: () => new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes),
      catch: cause => aggregateReadError('Team snapshot memory is not valid UTF-8.', cause),
    });
    const uri = `threadnote://user/${uriSegment(config.user)}/memories/shared/${team}/${relative}`;
    const record = parseMemoryDocument(uri, content);
    if (
      record === undefined ||
      record.metadata.kind !== 'durable' ||
      record.metadata.project !== project ||
      // Shared replacements keep a stable path while allowing topic metadata to evolve in place.
      record.metadata.topic === undefined ||
      record.headerTitle !== 'MEMORY' ||
      !isCompatibleTeamVisibility(record)
    ) {
      return yield* aggregateReadError('Team snapshot contains a malformed selected memory.');
    }
    records.push(record);
    evidence.push({contentHash: sha256HexSync(bytes), path: relative});
  }
  const all = records.sort(compareRecord);
  return {
    active: all.filter(record => record.metadata.status === 'active'),
    all,
    evidenceRevision: snapshotEvidenceRevision(head, evidence),
  };
});

function isCompatibleTeamVisibility(record: MemoryRecord): boolean {
  const normalizedContent = record.content.replace(/\r\n?/gu, '\n');
  const header = normalizedContent.split('\n\n', 1)[0] ?? '';
  const visibility = memoryHeaderValue(header, 'visibility');
  return visibility === undefined || visibility === 'personal' || visibility === 'shared';
}

const observeTeamSnapshot = Effect.fn('memory.contextHealth.observeTeamSnapshot')(function* (
  worktree: string,
  project: string,
) {
  const head = yield* runGit(worktree, ['rev-parse', '--verify', 'HEAD']);
  if (head.exitCode !== 0 || !GIT_COMMIT.test(head.stdout.trim())) {
    return yield* aggregateReadError('Team snapshot HEAD is unavailable.');
  }
  const status = yield* runGit(worktree, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--',
    `durable/projects/${project}`,
  ]);
  if (status.exitCode !== 0) return yield* aggregateReadError('Team snapshot status is unavailable.');
  return {dirty: status.stdout.length > 0, head: head.stdout.trim()};
});

const runGit = Effect.fn('memory.contextHealth.git')(function* (
  worktree: string,
  args: readonly string[],
  input?: Uint8Array,
) {
  const system = yield* SystemInfo;
  return yield* runCommandEffect(
    'git',
    ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-C', worktree, ...args],
    {
      allowFailure: true,
      env: {
        ...system.environment(),
        GIT_NO_LAZY_FETCH: '1',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
      },
      ...(input === undefined ? {} : {input}),
      maxOutputBytes: MAXIMUM_GIT_OUTPUT_BYTES,
      timeoutMs: GIT_TIMEOUT_MILLISECONDS,
    },
  );
});

function relationEvidenceWithinSnapshot(
  active: readonly MemoryRecord[],
  corpus: readonly MemoryRecord[],
): readonly ContextHealthRelationEvidenceV1[] {
  const byMemoryId = new Map<string, MemoryRecord[]>();
  for (const record of corpus) {
    if (record.metadata.memoryId === undefined) continue;
    const matches = byMemoryId.get(record.metadata.memoryId) ?? [];
    matches.push(record);
    byMemoryId.set(record.metadata.memoryId, matches);
  }
  return active.flatMap(record =>
    (record.metadata.relations ?? []).map(relation => {
      const memoryId = memoryIdFromIdentityAlias(relation.uri);
      const matches = memoryId === undefined ? undefined : byMemoryId.get(memoryId);
      const directMatches =
        memoryId === undefined
          ? corpus.filter(
              candidate =>
                candidate.uri === relation.uri ||
                (candidate.metadata.status !== 'active' && candidate.metadata.archivedFrom === relation.uri),
            )
          : undefined;
      const target =
        memoryId === undefined
          ? directMatches?.length === 1
            ? directMatches[0]
            : undefined
          : matches?.length === 1
            ? matches[0]
            : undefined;
      return {
        sourceUri: record.uri,
        status:
          (matches !== undefined && matches.length > 1) || (directMatches !== undefined && directMatches.length > 1)
            ? 'conflicted'
            : target?.metadata.status === 'active'
              ? 'active'
              : target === undefined
                ? 'missing'
                : 'inactive',
        targetUri: relation.uri,
      } satisfies ContextHealthRelationEvidenceV1;
    }),
  );
}

function memoryRecordsRevision(scope: string, records: readonly MemoryRecord[]): string {
  const evidence = records
    .map(record => `${record.uri}\0${sha256HexSync(record.content)}`)
    .sort(compareText)
    .join('\n');
  return sha256HexSync(`context-health-${scope}-v1\n${evidence}`);
}

function snapshotEvidenceRevision(
  head: string,
  evidence: readonly {readonly contentHash: string; readonly path: string}[],
): string {
  return sha256HexSync(
    `context-health-team-v1\n${head}\n${evidence.map(item => `${item.path}\0${item.contentHash}`).join('\n')}`,
  );
}

function unknownPersonal(
  reason: ContextHealthAggregateUnknownReasonV1,
  evidenceRevision?: string,
): ContextHealthAggregateSourceV1 {
  return {scope: 'personal', state: 'unknown', reason, ...(evidenceRevision === undefined ? {} : {evidenceRevision})};
}

function unknownTeam(
  team: string,
  reason: ContextHealthAggregateUnknownReasonV1,
  evidenceRevision?: string,
): ContextHealthAggregateSourceV1 {
  return {scope: 'team', state: 'unknown', team, reason, ...(evidenceRevision === undefined ? {} : {evidenceRevision})};
}

function unknownTeamSelection(reason: ContextHealthAggregateUnknownReasonV1): ContextHealthAggregateSourceV1 {
  return {scope: 'team-selection', state: 'unknown', reason};
}

function compareRecord(left: MemoryRecord, right: MemoryRecord): number {
  return compareText(left.uri, right.uri);
}

interface TeamTreeEntry {
  readonly objectId: string;
  readonly path: string;
}

function parseTreeEntry(raw: string): TeamTreeEntry {
  const separator = raw.indexOf('\t');
  const metadata = separator < 0 ? [] : raw.slice(0, separator).split(' ');
  const path = separator < 0 ? '' : raw.slice(separator + 1);
  if (metadata.length !== 3 || metadata[1] !== 'blob' || !GIT_COMMIT.test(metadata[2] ?? '') || !path) {
    throw new Error('Invalid Git tree entry.');
  }
  return {objectId: metadata[2], path};
}

function compareTreeEntry(left: TeamTreeEntry, right: TeamTreeEntry): number {
  return compareText(left.path, right.path);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function aggregateReadError(message: string, cause?: unknown): ContextHealthAggregateReadError {
  return ContextHealthAggregateReadError.make({message, ...(cause === undefined ? {} : {cause})});
}
