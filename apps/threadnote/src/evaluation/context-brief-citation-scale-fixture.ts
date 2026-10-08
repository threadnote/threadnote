import {Clock, Data, Effect, FileSystem, Path} from 'effect';
import {
  observeCodeGraphAdmissionEnvironment,
  recordCodeGraphSnapshotAdmission,
} from '@threadnote/graph/admission_freshness';
import {CodeGraphLanguagePackRegistry} from '@threadnote/graph/languages/registry';
import {extractorSetIdentityFromPackProvenance} from '@threadnote/graph/indexer';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {CodeGraphStore} from '@threadnote/graph/store';
import {createCodeGraphWorksetRoutingProjection} from '@threadnote/graph/workset_catalog/projection';
import {
  publishCodeGraphWorksetCatalogGeneration,
  stageCodeGraphWorksetCatalogGeneration,
} from '@threadnote/graph/workset_catalog/store';
import {CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION} from '@threadnote/graph/workset_catalog/types';
import {codeGraphWorksetManifestDigest} from '@threadnote/graph/workset_catalog/workset';
import type {CodeGraphInventoryFile, CodeGraphSnapshot, CodeGraphStatus} from '@threadnote/graph/types';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {runCommandEffect} from '@threadnote/platform/command';
import {createMemoryCodeCitation, formatMemoryCodeCitationLines} from '@threadnote/memory/code/citation';
import {loadRecallIndexData, recallIndexStatus} from '@threadnote/recall/index';
import type {ProjectManifest, ResolvedWorkset, RuntimeConfig} from '@threadnote/workspace/config';
import type {
  ContextBriefCitationScaleBudgetV1,
  ContextBriefCitationScaleFixturePlanProfileV2,
  ContextBriefCitationScaleProfileId,
  ContextBriefCitationScaleProfileV1,
} from './context-brief-citation-scale-contract.js';
import {
  CONTEXT_BRIEF_CITATION_SCALE_FIXTURE_CONTRACT_V2,
  contextBriefCitationScaleFixtureCitationRepositoryOrdinal,
  contextBriefCitationScaleFixturePlan,
} from './context-brief-citation-scale-contract.js';

const PROJECT = CONTEXT_BRIEF_CITATION_SCALE_FIXTURE_CONTRACT_V2.project;
const EXTRACTOR_SET = extractorSetIdentityFromPackProvenance(
  CONTEXT_BRIEF_CITATION_SCALE_FIXTURE_CONTRACT_V2.extractorSet.languagePackProvenance,
);
const FIXED_INSTANT = CONTEXT_BRIEF_CITATION_SCALE_FIXTURE_CONTRACT_V2.fixedInstant;

class ContextBriefCitationScaleFixtureError extends Data.TaggedError('ContextBriefCitationScaleFixtureError')<{
  readonly message: string;
}> {}

export interface ContextBriefCitationScaleRepositoryFixture {
  readonly checkoutId: string;
  readonly databasePath: string;
  readonly name: string;
  readonly repositoryId: string;
  readonly root: string;
  readonly snapshotId: string;
  readonly status: CodeGraphStatus;
  readonly worktreeId: string;
}

export interface ContextBriefCitationScalePreparedProfile {
  readonly generation?: {readonly digest: string; readonly id: string};
  readonly profile: ContextBriefCitationScaleProfileV1;
  readonly repositories: readonly ContextBriefCitationScaleRepositoryFixture[];
  readonly workset?: ResolvedWorkset;
}

export interface ContextBriefCitationScalePreparedFixture {
  readonly config: RuntimeConfig;
  readonly fixtureHash: string;
  readonly indexedMemoryCandidates: number;
  readonly legacyV1MemoryCandidates: number;
  readonly profiles: ReadonlyMap<ContextBriefCitationScaleProfileId, ContextBriefCitationScalePreparedProfile>;
  readonly readyGraphSetupMilliseconds: number;
  readonly recallIndexBuildMilliseconds: number;
  readonly runToken: (profile: ContextBriefCitationScaleProfileId, ordinal: number) => string;
}

export interface ContextBriefCitationScaleFixtureOptions {
  readonly budget: ContextBriefCitationScaleBudgetV1;
  readonly memoryCandidates: number;
  readonly profileIds: readonly ContextBriefCitationScaleProfileId[];
  readonly runCount: number;
  readonly samples: number;
  readonly warmups: number;
}

/**
 * Build the synthetic scale shape through real Git repositories, prebuilt graph
 * SQLite stores, memory files, recall SQLite, and published workset storage.
 * Snapshot activation is setup work; this deliberately performs no indexing.
 */
export const prepareContextBriefCitationScaleFixture = Effect.fn('evaluation.prepareContextBriefCitationScaleFixture')(
  function* (root: string, options: ContextBriefCitationScaleFixtureOptions) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = path.join(root, 'threadnote-home');
    const manifestPath = path.join(root, 'manifest.json');
    const plan = contextBriefCitationScaleFixturePlan(
      options.budget,
      options.memoryCandidates,
      options.profileIds,
      options.samples,
      options.warmups,
    );
    if (options.runCount !== plan.schedule.runCount) {
      return yield* new ContextBriefCitationScaleFixtureError({
        message: `Scale fixture run count ${options.runCount} disagrees with its ${plan.schedule.samples}/${plan.schedule.warmups} schedule.`,
      });
    }
    yield* fs.makeDirectory(home, {recursive: true});
    const preparedProfiles = new Map<ContextBriefCitationScaleProfileId, ContextBriefCitationScalePreparedProfile>();
    const projects: ProjectManifest[] = [];
    const worksets: Array<{readonly name: string; readonly projects: readonly string[]}> = [];
    const readyGraphSetupStarted = yield* Clock.currentTimeNanos;
    for (const profilePlan of plan.profiles) {
      const profile = profileFromPlan(options.budget, profilePlan);
      const repositories = yield* prepareContextBriefCitationScaleRepositories(
        fs,
        path,
        home,
        root,
        profile,
        plan.schedule.runCount,
      );
      projects.push(...repositories.map(repositoryProject));
      if (profile.id === 'local-100k') {
        preparedProfiles.set(profile.id, {profile, repositories});
        continue;
      }
      const workset: ResolvedWorkset = {
        name: profile.id,
        projects: repositories.map(repositoryProject),
        unresolvedProjects: [],
      };
      worksets.push({name: workset.name, projects: workset.projects.map(project => project.name)});
      preparedProfiles.set(profile.id, {profile, repositories, workset});
    }
    const query = yield* CodeGraphQueryService;
    yield* Effect.forEach(
      [...preparedProfiles.values()].flatMap(profile => profile.repositories),
      repository =>
        query
          .statusForPublishedIdentity(
            home,
            repository.root,
            {
              checkoutId: repository.checkoutId,
              repositoryId: repository.repositoryId,
              worktreeId: repository.worktreeId,
            },
            {observeWorktree: true, requestMaintenance: false},
          )
          .pipe(
            Effect.flatMap(status =>
              !status.stale && status.freshness === 'current' && status.readySnapshot?.id === repository.snapshotId
                ? Effect.void
                : Effect.fail(
                    new ContextBriefCitationScaleFixtureError({
                      message: `Prebuilt scale graph is not current: ${JSON.stringify({
                        actualSnapshot: status.readySnapshot?.id,
                        expectedSnapshot: repository.snapshotId,
                        extractorSet: status.readySnapshot?.extractorSet,
                        freshness: status.freshness,
                        languagePacks: status.languagePacks.map(pack => pack.id),
                        repository: repository.name,
                        stale: status.stale,
                      })}`,
                    }),
                  ),
            ),
          ),
      {concurrency: 16, discard: true},
    );
    const readyGraphSetupFinished = yield* Clock.currentTimeNanos;
    yield* fs.writeFileString(manifestPath, `${JSON.stringify({projects, version: 1, worksets}, undefined, 2)}\n`);
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'context-brief-citation-scale',
      manifestPath,
      user: 'benchmark',
    };
    for (const profileId of ['workset-50', 'workset-128'] as const) {
      const prepared = preparedProfiles.get(profileId)!;
      const staged = yield* stageCodeGraphWorksetCatalogGeneration(home, {
        manifestDigest: codeGraphWorksetManifestDigest(prepared.workset!),
        members: prepared.repositories.map((repository, ordinal) => ({
          projection: createCodeGraphWorksetRoutingProjection({
            checkoutId: repository.checkoutId,
            commitId: repository.status.identity.headCommit,
            componentCount: 0,
            extractorGeneration: 1,
            projectorVersion: CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION,
            repositoryId: repository.repositoryId,
            snapshotDigest: sha256HexSync(`scale-snapshot-digest\0${profileId}\0${ordinal}`),
            snapshotId: repository.snapshotId,
            symbols: [],
            worktreeId: repository.worktreeId,
          }),
          repositoryKey: repository.name,
        })),
        worksetName: prepared.workset!.name,
      });
      yield* publishCodeGraphWorksetCatalogGeneration<never, never>(home, {
        generationId: staged.id,
        worksetName: prepared.workset!.name,
      });
      preparedProfiles.set(profileId, {...prepared, generation: {digest: staged.digest, id: staged.id}});
    }
    const selectedRecords = plan.selectedProfiles.flatMap(profileId => {
      const prepared = preparedProfiles.get(profileId)!;
      return Array.from({length: plan.schedule.runCount}, (_, ordinal) =>
        selectedMemoryRecords(path, home, prepared, ordinal),
      ).flat();
    });
    if (selectedRecords.length !== plan.counts.selectedMemoryCandidates) {
      return yield* new ContextBriefCitationScaleFixtureError({
        message: `Scale selected-record count ${selectedRecords.length} disagrees with the normalized fixture plan.`,
      });
    }
    if (selectedRecords.length > plan.counts.requestedMemoryCandidates) {
      return yield* new ContextBriefCitationScaleFixtureError({
        message: `Scale corpus requires at least ${selectedRecords.length} documents for the selected profiles and samples.`,
      });
    }
    yield* writeRecords(fs, selectedRecords);
    const legacyV1MemoryCandidates = plan.counts.legacyV1MemoryCandidates;
    yield* writeLegacyNoise(fs, path, home, legacyV1MemoryCandidates);
    const buildStarted = yield* Clock.currentTimeNanos;
    yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: false, limit: 0, query: ''});
    const buildFinished = yield* Clock.currentTimeNanos;
    const status = yield* recallIndexStatus(config);
    if (!status.ready || status.documentCount !== plan.counts.indexedMemoryCandidates) {
      return yield* new ContextBriefCitationScaleFixtureError({
        message: `Scale recall index contains ${status.documentCount}/${plan.counts.indexedMemoryCandidates} memory candidates.`,
      });
    }
    const fixtureHash = contextBriefCitationScaleFixtureHash(
      path,
      home,
      options,
      preparedProfiles,
      selectedRecords,
      legacyV1MemoryCandidates,
      status.documentCount,
      plan,
    );
    return {
      config,
      fixtureHash,
      indexedMemoryCandidates: status.documentCount,
      legacyV1MemoryCandidates,
      profiles: preparedProfiles,
      readyGraphSetupMilliseconds: Number(readyGraphSetupFinished - readyGraphSetupStarted) / 1_000_000,
      recallIndexBuildMilliseconds: Number(buildFinished - buildStarted) / 1_000_000,
      runToken,
    } satisfies ContextBriefCitationScalePreparedFixture;
  },
);

export function prepareContextBriefCitationScaleRepositories(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
  root: string,
  profile: ContextBriefCitationScaleProfileV1,
  runCount: number,
) {
  return Effect.gen(function* () {
    const store = yield* CodeGraphStore;
    const languagePacks = yield* CodeGraphLanguagePackRegistry;
    return yield* Effect.forEach(
      Array.from({length: profile.worksetMembers}, (_, ordinal) => ordinal),
      ordinal =>
        Effect.gen(function* () {
          const name = `${profile.id}-repo-${String(ordinal).padStart(3, '0')}`;
          const repositoryRoot = path.join(root, 'repositories', name);
          const sourcePaths = repositorySourcePaths(profile, ordinal, runCount);
          yield* fs.makeDirectory(repositoryRoot, {recursive: true});
          yield* fs.writeFileString(path.join(repositoryRoot, '.threadnote-scale-fixture'), `${name}\n`);
          yield* Effect.forEach(
            sourcePaths,
            repositoryPath =>
              fs
                .makeDirectory(path.dirname(path.join(repositoryRoot, repositoryPath)), {recursive: true})
                .pipe(Effect.andThen(fs.writeFileString(path.join(repositoryRoot, repositoryPath), repositoryPath))),
            {concurrency: 32, discard: true},
          );
          yield* runCommandEffect('git', ['init', '--quiet', repositoryRoot], {timeoutMs: 30_000});
          yield* runCommandEffect(
            'git',
            ['-C', repositoryRoot, 'remote', 'add', 'origin', `https://example.invalid/threadnote/${name}.git`],
            {timeoutMs: 30_000},
          );
          yield* runCommandEffect('git', ['-C', repositoryRoot, 'add', '.'], {timeoutMs: 30_000});
          yield* runCommandEffect(
            'git',
            [
              '-C',
              repositoryRoot,
              '-c',
              'user.name=Threadnote Scale',
              '-c',
              'user.email=scale@example.invalid',
              'commit',
              '--quiet',
              '-m',
              'Prepare ready graph fixture',
            ],
            {
              env: {GIT_AUTHOR_DATE: FIXED_INSTANT, GIT_COMMITTER_DATE: FIXED_INSTANT},
              timeoutMs: 30_000,
            },
          );
          const identity = yield* resolveRepositoryIdentity(repositoryRoot);
          const snapshotId = `cgsn_${sha256HexSync(`scale-snapshot\0${name}`).slice(0, 40)}`;
          const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
          const databasePath = layout.databasePath;
          const files = sourcePaths.map(codeGraphInventoryFile);
          const snapshot = {
            commit: identity.headCommit,
            completedAt: FIXED_INSTANT,
            dirty: false,
            edgeCount: 0,
            extractorSet: EXTRACTOR_SET,
            fileCount: files.length,
            graphContentId: `cgc_${sha256HexSync(`scale-graph-content\0${name}`).slice(0, 40)}`,
            id: snapshotId,
            repositoryId: identity.repositoryId,
            state: 'ready',
            symbolCount: 0,
            worktreeId: identity.worktreeId,
          } satisfies CodeGraphSnapshot;
          const admissionEnvironment = yield* observeCodeGraphAdmissionEnvironment(identity);
          yield* store.activate(databasePath, identity, snapshot, files, [], [], []);
          yield* store.promote(databasePath, identity, snapshot.id);
          if ((yield* observeCodeGraphAdmissionEnvironment(identity)) !== admissionEnvironment) {
            return yield* new ContextBriefCitationScaleFixtureError({
              message: `Prebuilt scale graph admission policy changed during publication: ${name}.`,
            });
          }
          yield* recordCodeGraphSnapshotAdmission(layout, snapshot, admissionEnvironment, languagePacks, false);
          const status = {
            databasePath,
            freshness: 'current',
            identity,
            languagePacks: [],
            readySnapshot: snapshot,
            stale: false,
          } satisfies CodeGraphStatus;
          return {
            checkoutId: identity.checkoutId,
            databasePath,
            name,
            repositoryId: identity.repositoryId,
            root: repositoryRoot,
            snapshotId,
            status,
            worktreeId: identity.worktreeId,
          };
        }),
      {concurrency: 16},
    );
  });
}

function profileFromPlan(
  budget: ContextBriefCitationScaleBudgetV1,
  plan: ContextBriefCitationScaleFixturePlanProfileV2,
): ContextBriefCitationScaleProfileV1 {
  const profile = budget.profiles.find(candidate => candidate.id === plan.id);
  if (!profile) throw new Error(`Missing scale profile ${plan.id}.`);
  if (
    profile.citationCount !== plan.citationCount ||
    profile.citedRepositories !== plan.citedRepositories ||
    profile.selectedMemories !== plan.selectedMemories ||
    profile.worksetMembers !== plan.worksetMembers
  ) {
    throw new Error(`Scale profile ${plan.id} disagrees with the normalized fixture plan.`);
  }
  return profile;
}

function repositorySourcePaths(
  profile: ContextBriefCitationScaleProfileV1,
  repositoryOrdinal: number,
  runCount: number,
): readonly string[] {
  if (repositoryOrdinal >= profile.citedRepositories) return [];
  return Array.from({length: runCount}, (_, runOrdinal) =>
    Array.from({length: profile.citationCount}, (_, citationOrdinal) => citationOrdinal)
      .filter(citationOrdinal => citationOrdinal % profile.citedRepositories === repositoryOrdinal)
      .map(citationOrdinal => citationRepositoryPath(profile.id, runToken(profile.id, runOrdinal), citationOrdinal)),
  ).flat();
}

function codeGraphInventoryFile(repositoryPath: string): CodeGraphInventoryFile {
  return {
    blobId: sha256HexSync(`scale-blob\0${repositoryPath}`).slice(0, 40),
    contentHash: sha256HexSync(repositoryPath),
    language: 'typescript',
    mode: '100644',
    path: repositoryPath,
    size: new TextEncoder().encode(repositoryPath).byteLength,
    source: 'commit',
  };
}

function repositoryProject(repository: ContextBriefCitationScaleRepositoryFixture): ProjectManifest {
  return {
    name: repository.name,
    path: repository.root,
    seed: [],
    uri: `threadnote://resources/repos/${repository.name}`,
  };
}

function selectedMemoryRecords(
  path: Path.Path,
  home: string,
  prepared: ContextBriefCitationScalePreparedProfile,
  ordinal: number,
): readonly {readonly content: string; readonly path: string}[] {
  const token = runToken(prepared.profile.id, ordinal);
  const citationsPerMemory = prepared.profile.citationCount / prepared.profile.selectedMemories;
  const project = contextBriefCitationScaleProject(prepared);
  const root = path.join(home, 'data', 'local', 'user', 'benchmark', 'memories', 'durable', 'projects', project);
  return Array.from({length: prepared.profile.selectedMemories}, (_, memoryOrdinal) => {
    const citations = Array.from({length: citationsPerMemory}, (_, citationOrdinal) => {
      const index = memoryOrdinal * citationsPerMemory + citationOrdinal;
      const repository =
        prepared.repositories[
          contextBriefCitationScaleFixtureCitationRepositoryOrdinal(index, prepared.profile.citedRepositories)
        ];
      const repositoryPath = citationRepositoryPath(prepared.profile.id, token, index);
      return createMemoryCodeCitation({
        extractorSet: EXTRACTOR_SET,
        fileContentHash: {algorithm: 'sha256', value: sha256HexSync(repositoryPath)},
        path: repositoryPath,
        repositoryId: repository.repositoryId,
        repositoryIdentityKind: 'remote',
        sourceCommit: repository.status.identity.headCommit,
        sourceDirty: false,
        sourceGraphContentId: repository.status.readySnapshot!.graphContentId,
        sourceSnapshotId: repository.snapshotId,
        target: {kind: 'file'},
        version: 1,
      });
    });
    const topic = [
      prepared.profile.id,
      token,
      String(memoryOrdinal).padStart(
        CONTEXT_BRIEF_CITATION_SCALE_FIXTURE_CONTRACT_V2.selectedMemory.memoryOrdinalWidth,
        '0',
      ),
    ].join(CONTEXT_BRIEF_CITATION_SCALE_FIXTURE_CONTRACT_V2.selectedMemory.topicSeparator);
    const content = [
      'MEMORY',
      'kind: durable',
      'status: active',
      `project: ${project}`,
      `topic: ${topic}`,
      'source_agent_client: benchmark',
      `timestamp: ${FIXED_INSTANT}`,
      `schema_version: ${CONTEXT_BRIEF_CITATION_SCALE_FIXTURE_CONTRACT_V2.selectedMemory.schemaVersion}`,
      ...formatMemoryCodeCitationLines(citations),
      '',
      CONTEXT_BRIEF_CITATION_SCALE_FIXTURE_CONTRACT_V2.selectedMemory.body.replace('<run-token>', token),
    ].join('\n');
    return {
      content,
      path: path.join(
        root,
        prepared.profile.id,
        token,
        `${topic}${CONTEXT_BRIEF_CITATION_SCALE_FIXTURE_CONTRACT_V2.selectedMemory.extension}`,
      ),
    };
  });
}

function writeRecords(
  fs: FileSystem.FileSystem,
  records: readonly {readonly content: string; readonly path: string}[],
) {
  return Effect.forEach(
    records,
    record =>
      fs
        .makeDirectory(record.path.replace(/[\\/][^\\/]+$/u, ''), {recursive: true})
        .pipe(Effect.andThen(fs.writeFileString(record.path, record.content))),
    {concurrency: 32, discard: true},
  );
}

function writeLegacyNoise(fs: FileSystem.FileSystem, path: Path.Path, home: string, count: number) {
  const root = path.join(
    home,
    'data',
    'local',
    'user',
    'benchmark',
    'memories',
    'durable',
    'projects',
    PROJECT,
    CONTEXT_BRIEF_CITATION_SCALE_FIXTURE_CONTRACT_V2.legacyNoise.directory,
  );
  const content = legacyNoiseContent();
  return Effect.gen(function* () {
    for (
      let offset = 0;
      offset < count;
      offset += CONTEXT_BRIEF_CITATION_SCALE_FIXTURE_CONTRACT_V2.legacyNoise.shardSize
    ) {
      const end = Math.min(count, offset + CONTEXT_BRIEF_CITATION_SCALE_FIXTURE_CONTRACT_V2.legacyNoise.shardSize);
      yield* Effect.forEach(
        Array.from({length: end - offset}, (_, index) => offset + index),
        index => {
          const shard = String(
            Math.floor(index / CONTEXT_BRIEF_CITATION_SCALE_FIXTURE_CONTRACT_V2.legacyNoise.shardSize),
          ).padStart(CONTEXT_BRIEF_CITATION_SCALE_FIXTURE_CONTRACT_V2.legacyNoise.shardWidth, '0');
          const file = path.join(
            root,
            shard,
            `${String(index).padStart(CONTEXT_BRIEF_CITATION_SCALE_FIXTURE_CONTRACT_V2.legacyNoise.ordinalWidth, '0')}${CONTEXT_BRIEF_CITATION_SCALE_FIXTURE_CONTRACT_V2.legacyNoise.extension}`,
          );
          return fs
            .makeDirectory(path.dirname(file), {recursive: true})
            .pipe(Effect.andThen(fs.writeFileString(file, content)));
        },
        {concurrency: 64, discard: true},
      );
    }
  });
}

function legacyNoiseContent(): string {
  return [
    'MEMORY',
    'kind: durable',
    'status: active',
    `project: ${PROJECT}`,
    `topic: ${CONTEXT_BRIEF_CITATION_SCALE_FIXTURE_CONTRACT_V2.legacyNoise.topic}`,
    'source_agent_client: benchmark',
    `timestamp: ${FIXED_INSTANT}`,
    `schema_version: ${CONTEXT_BRIEF_CITATION_SCALE_FIXTURE_CONTRACT_V2.legacyNoise.schemaVersion}`,
    '',
    CONTEXT_BRIEF_CITATION_SCALE_FIXTURE_CONTRACT_V2.legacyNoise.body,
  ].join('\n');
}

function contextBriefCitationScaleFixtureHash(
  path: Path.Path,
  home: string,
  options: ContextBriefCitationScaleFixtureOptions,
  preparedProfiles: ReadonlyMap<ContextBriefCitationScaleProfileId, ContextBriefCitationScalePreparedProfile>,
  selectedRecords: readonly {readonly content: string; readonly path: string}[],
  legacyV1MemoryCandidates: number,
  indexedMemoryCandidates: number,
  plan: ReturnType<typeof contextBriefCitationScaleFixturePlan>,
): string {
  return sha256HexSync(
    JSON.stringify({
      plan,
      extractorSet: EXTRACTOR_SET,
      fixedInstant: FIXED_INSTANT,
      indexedMemoryCandidates,
      legacyNoise: {
        contentHash: sha256HexSync(legacyNoiseContent()),
        count: legacyV1MemoryCandidates,
        pathContract: CONTEXT_BRIEF_CITATION_SCALE_FIXTURE_CONTRACT_V2.legacyNoise.pathContract,
      },
      profiles: plan.profiles.map(profilePlan => {
        const profile = profileFromPlan(options.budget, profilePlan);
        const prepared = preparedProfiles.get(profile.id)!;
        return {
          id: profile.id,
          repositories: prepared.repositories.map((repository, ordinal) => ({
            commit: repository.status.identity.headCommit,
            graphContentId: repository.status.readySnapshot!.graphContentId,
            name: repository.name,
            repositoryId: repository.repositoryId,
            snapshotId: repository.snapshotId,
            sourcePathsHash: sha256HexSync(repositorySourcePaths(profile, ordinal, plan.schedule.runCount).join('\0')),
          })),
        };
      }),
      requestedMemoryCandidates: plan.counts.requestedMemoryCandidates,
      runCount: plan.schedule.runCount,
      selectedRecords: selectedRecords.map(record => ({
        contentHash: sha256HexSync(record.content),
        path: path.relative(home, record.path).split(path.sep).join('/'),
      })),
      selectedProfiles: plan.selectedProfiles,
      version: 2,
    }),
  );
}

function runToken(profile: ContextBriefCitationScaleProfileId, ordinal: number): string {
  return `tnscale${profile.replaceAll('-', '')}run${String(ordinal).padStart(3, '0')}`;
}

function citationRepositoryPath(profile: ContextBriefCitationScaleProfileId, token: string, index: number): string {
  return `${CONTEXT_BRIEF_CITATION_SCALE_FIXTURE_CONTRACT_V2.repositorySource.directory}/${profile}/${token}/${String(index).padStart(3, '0')}${CONTEXT_BRIEF_CITATION_SCALE_FIXTURE_CONTRACT_V2.repositorySource.extension}`;
}

export function contextBriefCitationScaleProject(prepared: ContextBriefCitationScalePreparedProfile): string {
  const project = prepared.repositories[0]?.name;
  if (project === undefined) throw new Error(`Missing first repository for ${prepared.profile.id}.`);
  return project;
}

export function contextBriefCitationScaleExtractorSet(): string {
  return EXTRACTOR_SET;
}
