import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {
  selectCodeGraphCitationContentHashTargets,
  type CodeGraphEffectiveSnapshotCitationEvidence,
  type CodeGraphEffectiveSnapshotCitationEvidenceRequest,
} from '@threadnote/graph/citation/primitives';
import {codeGraphCommittedFileContentHash} from '@threadnote/graph/content_identity';
import {CodeGraphQueryService, type CodeGraphStatusOptions} from '@threadnote/graph/query';
import {CodeGraphRepositoryError} from '@threadnote/graph/types';
import {CodeGraphStore} from '@threadnote/graph/store';
import type {
  CodeGraphInventoryFile,
  CodeGraphSnapshot,
  CodeGraphStatus,
  RepositoryIdentityExpectation,
} from '@threadnote/graph/types';
import {compileContextBriefWith} from '@threadnote/context/compiler';
import {
  retrieveContextBriefMemoryEvidence,
  type ContextBriefGraphEvidenceV1,
  type ContextBriefMemoryCandidateV1,
} from '../context_brief/index.js';
import {validateContextBriefMemoryCitations} from '@threadnote/context/citation_validation';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {captureMemoryCodeCitations} from '@threadnote/context/citation/capture';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  finalizeContextBriefCitationRuntimeEvaluation,
  parseContextBriefCitationRuntimeFixtureV1,
  type ContextBriefCitationRuntimeEvaluationResultV1,
  type ContextBriefCitationRuntimeFixtureV1,
  type ContextBriefCitationRuntimeObservationV1,
  type ContextBriefCitationRuntimeScenarioV1,
  type ContextBriefCitationRuntimeWarning,
} from './context-brief-citation-runtime-contract.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const LEGACY_TOPIC = 'runtime-evaluation-legacy-v1-continuity';

/**
 * Execute reviewed scenarios through real citation capture, validation, memory
 * retrieval, Context Brief assembly, and projection. The injected graph is a
 * deterministic already-ready snapshot boundary; no indexing or network work
 * is permitted by this release gate.
 */
export const evaluateContextBriefCitationRuntime = Effect.fn('evaluation.contextBriefCitationRuntime')(function* (
  fixtureInput: ContextBriefCitationRuntimeFixtureV1 | unknown,
) {
  const fixture = parseContextBriefCitationRuntimeFixtureV1(fixtureInput);
  const observations = yield* Effect.scoped(
    Effect.gen(function* () {
      const collected: ContextBriefCitationRuntimeObservationV1[] = [];
      for (const scenario of fixture.scenarios) {
        collected.push(
          scenario.kind === 'legacy-v1'
            ? yield* evaluateLegacyScenario(fixture, scenario)
            : yield* evaluateCitedScenario(fixture, scenario),
        );
      }
      return collected;
    }),
  );
  return finalizeContextBriefCitationRuntimeEvaluation(fixture, observations);
});

const evaluateCitedScenario = Effect.fn('evaluation.contextBriefCitationRuntime.citedScenario')(function* (
  fixture: ContextBriefCitationRuntimeFixtureV1,
  scenario: Exclude<ContextBriefCitationRuntimeScenarioV1, {readonly kind: 'legacy-v1'}>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({prefix: `threadnote-citation-runtime-${scenario.kind}-`});
  const sourcePath = path.join(root, fixture.source.path);
  yield* fs.makeDirectory(path.dirname(sourcePath), {recursive: true});
  yield* fs.writeFileString(sourcePath, fixture.source.content);
  const config = runtimeConfig(root, path.join(root, 'threadnote-home'));
  const graph = makeScenarioGraph(root, fixture, scenario);

  const program = Effect.gen(function* () {
    const captureStarted = monotonicMilliseconds();
    const citations = yield* captureMemoryCodeCitations(config, {
      callerCwd: root,
      refs: [fixture.source.path],
    });
    const captureMilliseconds = elapsedMilliseconds(captureStarted);
    graph.beginValidation();
    const citation = citations[0];
    const uri = `threadnote://user/runtime-eval/memories/durable/projects/threadnote/${scenario.id}.md`;
    const candidate: ContextBriefMemoryCandidateV1 | undefined = citation
      ? {
          citationErrorCount: 0,
          codeCitations: [citation],
          excerpt: `Runtime citation evaluation sentinel for ${scenario.id}.`,
          kind: 'durable',
          project: 'threadnote',
          rank: 0,
          sourceCommit: citation.sourceCommit,
          topic: scenario.id,
          uri,
        }
      : undefined;
    let validationMilliseconds = 0;
    const briefStarted = monotonicMilliseconds();
    const brief = yield* compileContextBriefWith(
      {
        citationValidation: (scope, candidates, fence) =>
          Effect.gen(function* () {
            const started = monotonicMilliseconds();
            const validations = yield* validateContextBriefMemoryCitations(config, scope, candidates, fence);
            validationMilliseconds = elapsedMilliseconds(started);
            return validations;
          }),
        graphEvidence: () => Effect.succeed(graphEvidence(fixture, scenario)),
        memoryEvidence: () =>
          Effect.succeed({
            candidates: candidate ? [candidate] : [],
            consideredCandidates: candidate ? 1 : 0,
            gaps: candidate ? [] : ['runtime-citation-capture-empty'],
            trust: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
          }),
      },
      {
        budgetTokens: fixture.thresholds.maximumEstimatedTokens,
        mode: 'brief',
        scope: {callerCwd: root, kind: 'repository', project: 'threadnote'},
        task: `Evaluate runtime citation scenario ${scenario.id}.`,
      },
    );
    const contextBriefMilliseconds = elapsedMilliseconds(briefStarted);
    const memories = [...brief.structuredContent.activeHandoffs, ...brief.structuredContent.durableDecisions];
    const memory = EffectOption.getOrUndefined(EffectArray.findFirst(memories, item => item.uri === uri));
    return {
      capture: {
        ...(citation === undefined ? {} : {citationId: citation.id}),
        milliseconds: captureMilliseconds,
        succeeded: citations.length === 1,
      },
      contextBriefMilliseconds,
      estimatedTokens: brief.measurement.estimatedTokens,
      execution: scenario.execution,
      id: scenario.id,
      leaseBalance: graph.leaseBalance(),
      maintenanceRequests: graph.maintenanceRequests(),
      observedFreshness: memory?.freshness ?? 'unknown',
      observedRecallCount: memory === undefined ? 0 : 1,
      ...(memory?.citationReceipts?.[0]?.status === undefined
        ? {}
        : {observedStatus: memory.citationReceipts[0].status}),
      observedWarning: warningForMemory(brief.structuredContent.stalenessAndConflicts, uri),
      snapshotState: scenario.snapshotState,
      validationEvidenceCalls: graph.validationEvidenceCalls(),
      validationMilliseconds,
    } satisfies ContextBriefCitationRuntimeObservationV1;
  });
  return yield* Layer.build(graph.layer).pipe(Effect.flatMap(context => program.pipe(Effect.provide(context))));
});

const evaluateLegacyScenario = Effect.fn('evaluation.contextBriefCitationRuntime.legacyScenario')(function* (
  fixture: ContextBriefCitationRuntimeFixtureV1,
  scenario: ContextBriefCitationRuntimeScenarioV1,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-citation-runtime-legacy-v1-'});
  const memoryRoot = path.join(
    home,
    'data',
    'local',
    'user',
    'runtime-eval',
    'memories',
    'durable',
    'projects',
    'threadnote',
  );
  yield* fs.makeDirectory(memoryRoot, {recursive: true});
  yield* fs.writeFileString(path.join(memoryRoot, `${LEGACY_TOPIC}.md`), legacyMemory());
  const config = runtimeConfig(home, home);
  const briefStarted = monotonicMilliseconds();
  const brief = yield* compileContextBriefWith(
    {
      graphEvidence: () => Effect.succeed(graphEvidence(fixture, scenario)),
      memoryEvidence: plan => retrieveContextBriefMemoryEvidence(config, plan),
    },
    {
      budgetTokens: fixture.thresholds.maximumEstimatedTokens,
      mode: 'brief',
      scope: {callerCwd: home, kind: 'repository', project: 'threadnote'},
      task: 'Recall the runtime evaluation legacy v1 continuity sentinel.',
    },
  );
  const contextBriefMilliseconds = elapsedMilliseconds(briefStarted);
  const memories = [...brief.structuredContent.activeHandoffs, ...brief.structuredContent.durableDecisions];
  const memory = EffectOption.getOrUndefined(EffectArray.findFirst(memories, item => item.topic === LEGACY_TOPIC));
  return {
    capture: {milliseconds: 0, succeeded: false},
    contextBriefMilliseconds,
    estimatedTokens: brief.measurement.estimatedTokens,
    execution: scenario.execution,
    id: scenario.id,
    leaseBalance: 0,
    maintenanceRequests: 0,
    observedFreshness: memory?.freshness ?? 'unknown',
    observedRecallCount: memory === undefined ? 0 : 1,
    observedWarning: warningForMemory(
      brief.structuredContent.stalenessAndConflicts,
      memory?.uri ?? 'threadnote://missing',
    ),
    snapshotState: scenario.snapshotState,
    validationEvidenceCalls: 0,
    validationMilliseconds: 0,
  } satisfies ContextBriefCitationRuntimeObservationV1;
});

interface ScenarioGraph {
  readonly beginValidation: () => void;
  readonly layer: Layer.Layer<CodeGraphQueryService | CodeGraphStore>;
  readonly leaseBalance: () => number;
  readonly maintenanceRequests: () => number;
  readonly validationEvidenceCalls: () => number;
}

function makeScenarioGraph(
  root: string,
  fixture: ContextBriefCitationRuntimeFixtureV1,
  scenario: ContextBriefCitationRuntimeScenarioV1,
): ScenarioGraph {
  const sourceHash = codeGraphCommittedFileContentHash('sha1', new TextEncoder().encode(fixture.source.content));
  const changedContent = `${fixture.source.content}// runtime-evaluation-changed\n`;
  const changedHash = codeGraphCommittedFileContentHash('sha1', new TextEncoder().encode(changedContent));
  const sourceFile = inventoryFile(fixture.source.path, sourceHash, fixture.source.content);
  const sourceSnapshot = snapshot(
    fixture,
    fixture.source.sourceCommit,
    fixture.source.sourceSnapshotId,
    1,
    fixture.source.graphContentId,
  );
  const currentRepositoryId =
    scenario.kind === 'cross-repository' ? fixture.source.foreignRepositoryId : fixture.source.repositoryId;
  const currentSnapshot = snapshot(
    fixture,
    scenario.currentCommit,
    scenario.currentSnapshotId,
    scenario.kind === 'incomplete' || scenario.kind === 'deleted' ? 0 : 1,
    undefined,
    currentRepositoryId,
    scenario.execution === 'incremental' ? fixture.source.sourceSnapshotId : undefined,
  );
  const sourceStatus = status(root, fixture, sourceSnapshot, 'current-complete');
  const currentStatus = status(root, fixture, currentSnapshot, scenario.snapshotState, currentRepositoryId);
  let phase: 'capture' | 'validation' = 'capture';
  let acquired = 0;
  let released = 0;
  let maintenanceRequests = 0;
  let validationEvidenceCalls = 0;
  const evidence = (request: CodeGraphEffectiveSnapshotCitationEvidenceRequest) => {
    if (phase === 'validation') validationEvidenceCalls += 1;
    const files =
      phase === 'capture'
        ? [sourceFile]
        : currentFiles(fixture.source.path, fixture.source.content, sourceHash, changedHash, scenario.kind);
    const byPath = new Map(EffectArray.map(files, file => [file.path, file]));
    const paths = [
      ...new Set([
        ...(request.paths ?? []),
        ...EffectArray.map(request.fileRelocationFallbacks ?? [], item => item.path),
      ]),
    ];
    const contentHashes = selectCodeGraphCitationContentHashTargets(
      [...new Set(request.contentHashes ?? [])],
      request.fileRelocationFallbacks ?? [],
      new Set(EffectArray.map(files, file => file.path)),
    );
    return {
      fileInventoryCoverage:
        phase === 'capture' || scenario.snapshotState === 'current-complete' ? 'complete' : 'incomplete',
      filesByContentHashes: EffectArray.map(contentHashes, contentHash => ({
        contentHash,
        files: EffectArray.filter(files, file => file.contentHash === contentHash),
        truncated: false,
      })),
      filesByPaths: EffectArray.map(paths, repositoryPath => ({
        ...(byPath.get(repositoryPath) === undefined ? {} : {file: byPath.get(repositoryPath)!}),
        path: repositoryPath,
      })),
      symbolsByIds: [],
      symbolsBySemanticLocators: EffectArray.map(request.semanticLocators ?? [], locator => ({
        locator,
        symbols: [],
        truncated: false,
      })),
    } satisfies CodeGraphEffectiveSnapshotCitationEvidence;
  };
  const store = {
    activateCleanSnapshotAlias: undefined,
    discardInvalidCachedFacts: undefined,
    existingSnapshotFilePaths: undefined,
    loadSnapshotMaterializedFileShards: undefined,
    reusableCleanBase: undefined,
    reusableCleanBaseForCommitPaths: undefined,
    reusableFoldForwardBase: undefined,
    reusableOverlayBase: undefined,
    snapshotProjectClosureFiles: undefined,
    acquireSnapshotLease: () => Effect.sync(() => `runtime-eval-lease-${++acquired}`),
    effectiveSnapshotCitationEvidence: (
      _databasePath: string,
      _snapshotId: string,
      request: CodeGraphEffectiveSnapshotCitationEvidenceRequest,
    ) => Effect.sync(() => evidence(request)),
    releaseSnapshotLease: () => Effect.sync(() => void ++released),
  };
  const query = {
    withStatusSession: undefined,
    status: (_threadnoteHome: string, _cwd: string, options?: {readonly requestMaintenance?: boolean}) =>
      Effect.sync(() => {
        if (options?.requestMaintenance) maintenanceRequests += 1;
        return phase === 'capture' ? sourceStatus : currentStatus;
      }),
    statusForPublishedIdentity: (
      _threadnoteHome: string,
      _cwd: string,
      expected: RepositoryIdentityExpectation,
      options?: CodeGraphStatusOptions,
    ) =>
      Effect.sync(() => {
        if (options?.requestMaintenance) maintenanceRequests += 1;
        return phase === 'capture' ? sourceStatus : currentStatus;
      }).pipe(
        Effect.filterOrFail(
          observed =>
            observed.identity.checkoutId === expected.checkoutId &&
            observed.identity.repositoryId === expected.repositoryId &&
            observed.identity.worktreeId === expected.worktreeId,
          () =>
            CodeGraphRepositoryError.make({
              message: 'Evaluation graph status identity did not match the published identity.',
            }),
        ),
      ),
  };
  return {
    beginValidation: () => {
      phase = 'validation';
    },
    layer: Layer.merge(Layer.mock(CodeGraphStore, store), Layer.mock(CodeGraphQueryService, query)),
    leaseBalance: () => acquired - released,
    maintenanceRequests: () => maintenanceRequests,
    validationEvidenceCalls: () => validationEvidenceCalls,
  };
}

function currentFiles(
  originalPath: string,
  source: string,
  sourceHash: string,
  changedHash: string,
  kind: ContextBriefCitationRuntimeScenarioV1['kind'],
): readonly CodeGraphInventoryFile[] {
  switch (kind) {
    case 'exact':
      return [inventoryFile(originalPath, sourceHash, source)];
    case 'relocated':
      return [inventoryFile('src/relocated/value.ts', sourceHash, source)];
    case 'changed':
      return [inventoryFile(originalPath, changedHash, `${source}// runtime-evaluation-changed\n`)];
    case 'deleted':
      return [];
    case 'ambiguous':
      return [
        inventoryFile('src/copy-a/value.ts', sourceHash, source),
        inventoryFile('src/copy-b/value.ts', sourceHash, source),
      ];
    case 'incomplete':
    case 'cross-repository':
    case 'legacy-v1':
      return [];
  }
}

function inventoryFile(path: string, contentHash: string, content: string): CodeGraphInventoryFile {
  return {
    blobId: `runtime-eval:${contentHash}`,
    contentHash,
    language: 'typescript',
    mode: '100644',
    path,
    size: new TextEncoder().encode(content).byteLength,
    source: 'commit',
  };
}

function snapshot(
  fixture: ContextBriefCitationRuntimeFixtureV1,
  commit: string,
  id: string,
  fileCount: number,
  graphContentId: string | undefined = `cgc_${Effect2.pipe(sha256HexSync(id), EffectString.slice(0, 40))}`,
  repositoryId = fixture.source.repositoryId,
  baseSnapshotId?: string,
): CodeGraphSnapshot {
  return {
    ...(baseSnapshotId === undefined ? {} : {baseSnapshotId}),
    commit,
    completedAt: '2026-08-26T00:00:00.000Z',
    dirty: false,
    edgeCount: 0,
    extractorSet: fixture.source.extractorSet,
    fileCount,
    graphContentId,
    id,
    repositoryId,
    state: 'ready',
    symbolCount: 0,
    worktreeId: sha256HexSync(`runtime-eval-worktree\0${id}`),
  };
}

function status(
  root: string,
  fixture: ContextBriefCitationRuntimeFixtureV1,
  readySnapshot: CodeGraphSnapshot,
  state: ContextBriefCitationRuntimeScenarioV1['snapshotState'],
  repositoryId = fixture.source.repositoryId,
): CodeGraphStatus {
  return {
    databasePath: `${root}/runtime-evaluation.sqlite`,
    freshness: state === 'current-complete' ? 'current' : 'deferred',
    identity: {
      caseMode: 'sensitive',
      checkoutId: `runtime-eval-${readySnapshot.id}`,
      displayName: 'threadnote/runtime-evaluation',
      gitCommonDirectory: `${root}/.git`,
      headCommit: readySnapshot.commit,
      objectFormat: 'sha1',
      remoteIdentity: 'https://github.com/threadnote/runtime-evaluation.git',
      repoRoot: root,
      repositoryId,
      worktreeId: readySnapshot.worktreeId,
    },
    languagePacks: [],
    readySnapshot,
    stale: state !== 'current-complete',
  };
}

function graphEvidence(
  fixture: ContextBriefCitationRuntimeFixtureV1,
  scenario: ContextBriefCitationRuntimeScenarioV1,
): ContextBriefGraphEvidenceV1 {
  const complete = scenario.snapshotState === 'current-complete';
  return {
    cards: [],
    citationValidationFence: {
      kind: 'repository',
      repositoryId: fixture.source.repositoryId,
      snapshotId: scenario.currentSnapshotId,
    },
    contracts: [],
    coverage: {
      complete,
      consideredRepositories: 1,
      readyRepositories: complete ? 1 : 0,
      requestedRepositories: 1,
      states: complete ? {current: 1} : {deferred: 1},
    },
    gaps: complete ? [] : ['runtime-evaluation-incomplete-graph'],
    resolvedSnapshots: complete
      ? [
          {
            commit: scenario.currentCommit,
            dirty: false,
            freshness: 'fresh',
            repositoryId: fixture.source.repositoryId,
            repositoryKey: 'runtime-evaluation',
            snapshotId: scenario.currentSnapshotId,
          },
        ]
      : [],
    trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
    warnings: [],
  };
}

function warningForMemory(
  issues: readonly {readonly kind: string; readonly uris: readonly string[]}[],
  uri: string,
): ContextBriefCitationRuntimeWarning {
  const issue = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      issues,
      __effectArrayValue => !!(candidate => candidate.uris.includes(uri))(__effectArrayValue),
    ),
  );
  switch (issue?.kind) {
    case 'stale-link':
    case 'stale-memory':
    case 'unknown-memory-freshness':
      return issue.kind;
    default:
      return 'none';
  }
}

function legacyMemory(): string {
  return EffectArray.join(
    [
      'MEMORY',
      'kind: durable',
      'status: active',
      'project: threadnote',
      `topic: ${LEGACY_TOPIC}`,
      'source_agent_client: codex',
      'timestamp: 2025-01-01T00:00:00.000Z',
      'schema_version: 1',
      '',
      'Runtime evaluation legacy v1 continuity sentinel remains recallable after the schema-v4 upgrade.',
    ],
    '\n',
  );
}

function runtimeConfig(root: string, home: string): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome: home,
    agentId: 'runtime-evaluation',
    manifestPath: `${root}/manifest.yaml`,
    user: 'runtime-eval',
  };
}

function monotonicMilliseconds(): number {
  return performance.now();
}

function elapsedMilliseconds(started: number): number {
  return Math.max(0, performance.now() - started);
}

export type {ContextBriefCitationRuntimeEvaluationResultV1};
