import {Effect, FileSystem, Layer, Path} from 'effect';
import {
  codeGraphSourceSpanFragment,
  selectCodeGraphCitationContentHashTargets,
  type CodeGraphEffectiveSnapshotCitationEvidence,
  type CodeGraphEffectiveSnapshotCitationEvidenceRequest,
  type CodeGraphSymbolSemanticLocatorV1,
} from '@threadnote/graph/citation/primitives';
import {codeGraphCommittedFileContentHash} from '@threadnote/graph/content_identity';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {CodeGraphStore} from '@threadnote/graph/store';
import type {CodeGraphStoreShape} from '@threadnote/graph/store/shape';
import type {
  CodeGraphInventoryFile,
  CodeGraphSnapshot,
  CodeGraphStatus,
  CodeGraphSymbol,
} from '@threadnote/graph/types';
import {compileContextBriefWith} from '@threadnote/context/compiler';
import {
  retrieveContextBriefCodeLinkedMemoryEvidence,
  retrieveContextBriefMemoryEvidence,
  type ContextBriefGraphEvidenceV1,
  type ProjectedContextBriefV1,
} from '../context_brief/index.js';
import {validateContextBriefMemoryCitations} from '@threadnote/context/citation_validation';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  createMemoryCodeCitation,
  MEMORY_SCHEMA_VERSION,
  type MemoryCodeCitationV1,
} from '@threadnote/memory/code/citation';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {loadRecallIndexData} from '@threadnote/recall/index';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  assertApprovedCodeMemoryLinkBenchFixture,
  CODE_MEMORY_LINK_BENCH_MINIMUM_WARMUPS,
  evaluateCodeMemoryLinkBench,
  parseCodeMemoryLinkBenchFixtureV1,
  type CodeMemoryLinkBenchFixtureV1,
  type CodeMemoryLinkBenchObservationV1,
  type CodeMemoryLinkBenchQueryV1,
  type CodeMemoryLinkBenchRankedMemoryV1,
  type CodeMemoryLinkBenchResultV1,
  type CodeMemoryLinkBenchScenarioKind,
} from './code-memory-link-bench-contract.js';

const USER = 'code-memory-bench';
const PROJECT = 'threadnote';
const REPOSITORY_ID = '1'.repeat(64);
const FOREIGN_REPOSITORY_ID = '2'.repeat(64);
const SOURCE_COMMIT = '3'.repeat(40);
const CURRENT_COMMIT = '4'.repeat(40);
const SOURCE_SNAPSHOT_ID = `cgsn_${'5'.repeat(40)}`;
const CURRENT_SNAPSHOT_ID = `cgsn_${'6'.repeat(40)}`;
const EXTRACTOR_SET = 'code-memory-link-bench-v1';
const GRAPH_CONTENT_ID = `cgc_${'7'.repeat(40)}`;
const WARM_SAMPLES = 25;
const WARM_COHORTS = CODE_MEMORY_LINK_BENCH_MINIMUM_WARMUPS + WARM_SAMPLES;
const HIGH_NOISE_MEMORIES = 256;
const encoder = new TextEncoder();

/**
 * Run the frozen gate through current-anchor capture, the real inverse recall
 * index, canonical memory rereads, citation validation, merge, and v3 projection.
 * Fixture construction and recall refresh are deliberately outside timings.
 */
export const evaluateCodeMemoryLinkBenchRuntime = Effect.fn('evaluation.codeMemoryLinkBenchRuntime')(function* (
  fixtureInput: CodeMemoryLinkBenchFixtureV1 | unknown,
) {
  const fixture = parseCodeMemoryLinkBenchFixtureV1(fixtureInput);
  assertApprovedCodeMemoryLinkBenchFixture(fixture);
  const observations = yield* Effect.scoped(
    Effect.forEach(fixture.queries, query => evaluateRuntimeQuery(query), {concurrency: 1}),
  );
  return evaluateCodeMemoryLinkBench(fixture, {
    fixtureId: fixture.id,
    observations,
    version: 1,
  });
});

const evaluateRuntimeQuery = Effect.fn('evaluation.codeMemoryLinkBenchRuntime.query')(function* (
  query: CodeMemoryLinkBenchQueryV1,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({prefix: `threadnote-code-memory-${query.scenario}-`});
  const home = path.join(root, 'threadnote-home');
  const definition = scenarioDefinition(query);
  yield* writeCurrentFiles(fs, path, root, definition.files);
  yield* writeScenarioMemories(fs, path, home, query, definition);
  const config = runtimeConfig(root, home);
  yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: false, limit: 0, query: ''});
  const graph = makeRuntimeGraph(root, definition);
  const program = Effect.gen(function* () {
    const run = (codeRefs: readonly string[] = query.codeRefs) =>
      compileRuntimeBrief(config, root, query, definition, codeRefs);
    const started = monotonicMilliseconds();
    const brief = yield* run();
    const elapsedMilliseconds = elapsed(started);
    let warmIncremental: CodeMemoryLinkBenchObservationV1['warmIncremental'];
    if (query.measureWarmIncrementalLatency) {
      yield* Effect.forEach(
        Array.from({length: CODE_MEMORY_LINK_BENCH_MINIMUM_WARMUPS}),
        (_, index) => run([definition.warmCodeRefs?.[index] ?? query.codeRefs[0]]),
        {concurrency: 1, discard: true},
      );
      const milliseconds = yield* Effect.forEach(
        Array.from({length: WARM_SAMPLES}),
        (_, index) =>
          Effect.gen(function* () {
            const sampleStarted = monotonicMilliseconds();
            const cohort = index + CODE_MEMORY_LINK_BENCH_MINIMUM_WARMUPS;
            yield* run([definition.warmCodeRefs?.[cohort] ?? query.codeRefs[0]]);
            return elapsed(sampleStarted);
          }),
        {concurrency: 1},
      );
      warmIncremental = {milliseconds, warmups: CODE_MEMORY_LINK_BENCH_MINIMUM_WARMUPS};
      const expectedUncachedValidations = 1 + CODE_MEMORY_LINK_BENCH_MINIMUM_WARMUPS + WARM_SAMPLES;
      if (graph.validationEvidenceCalls() < expectedUncachedValidations) {
        throw new Error(
          `Warm CodeMemoryLinkBench samples reused validation-cache receipts: ${graph.validationEvidenceCalls()}/${expectedUncachedValidations} evidence calls.`,
        );
      }
    }
    if (graph.leaseBalance() !== 0) throw new Error(`Unbalanced graph snapshot leases for ${query.id}.`);
    if (graph.maintenanceRequests() !== 0)
      throw new Error(`CodeMemoryLinkBench attempted graph maintenance for ${query.id}.`);
    return observationForBrief(query, brief, elapsedMilliseconds, warmIncremental);
  });
  return yield* Layer.build(graph.layer).pipe(Effect.flatMap(context => program.pipe(Effect.provide(context))));
});

function compileRuntimeBrief(
  config: RuntimeConfig,
  root: string,
  query: CodeMemoryLinkBenchQueryV1,
  definition: ScenarioDefinition,
  codeRefs: readonly string[],
) {
  return compileContextBriefWith(
    {
      citationValidation: (scope, candidates, fence) =>
        validateContextBriefMemoryCitations(config, scope, candidates, fence),
      codeLinkedMemoryEvidence: plan => retrieveContextBriefCodeLinkedMemoryEvidence(config, plan),
      graphEvidence: () => Effect.succeed(runtimeGraphEvidence(definition)),
      memoryEvidence: plan => retrieveContextBriefMemoryEvidence(config, plan),
    },
    {
      budgetTokens: query.budgetClass === 'default' ? 1_250 : 1_500,
      codeRefs,
      mode: 'brief',
      scope: {callerCwd: root, kind: 'repository', project: PROJECT},
      task: query.task,
    },
  );
}

function observationForBrief(
  query: CodeMemoryLinkBenchQueryV1,
  brief: ProjectedContextBriefV1,
  elapsedMilliseconds: number,
  warmIncremental: CodeMemoryLinkBenchObservationV1['warmIncremental'],
): CodeMemoryLinkBenchObservationV1 {
  if (
    brief.structuredContent.graph.continuation?.state === 'rerun-required' &&
    !brief.structuredContent.recommendedFollowUps.some(followUp => followUp.operation === 'inspect-node')
  ) {
    throw new Error(`CodeMemoryLinkBench query ${query.id} returned no executable graph recovery.`);
  }
  const coverage = brief.structuredContent.coverage.memory.codeAnchors;
  if (coverage === undefined) throw new Error(`CodeMemoryLinkBench query ${query.id} did not emit anchor coverage.`);
  const memories = [...brief.structuredContent.activeHandoffs, ...brief.structuredContent.durableDecisions].sort(
    (left, right) => left.rank - right.rank || compareText(left.uri, right.uri),
  );
  const rankedMemories: CodeMemoryLinkBenchRankedMemoryV1[] = memories.map(memory => ({
    freshness: memory.freshness,
    relationStatus: memory.codeRelations?.[0]?.status ?? null,
    selectionBasis: memory.selectionBasis ?? 'lexical',
    uri: memory.uri,
  }));
  return {
    coverage,
    elapsedMilliseconds,
    estimatedTokens: brief.measurement.estimatedTokens,
    queryId: query.id,
    rankedMemories,
    responseBytes: encoder.encode(JSON.stringify(brief.structuredContent)).byteLength,
    ...(warmIncremental === undefined ? {} : {warmIncremental}),
  };
}

interface ScenarioDefinition {
  readonly dirty: boolean;
  readonly files: readonly RuntimeFile[];
  readonly memories: readonly RuntimeMemory[];
  readonly stale: boolean;
  readonly symbols: readonly CodeGraphSymbol[];
  readonly warmCodeRefs?: readonly string[];
}

interface RuntimeFile {
  readonly content: string;
  readonly path: string;
}

interface RuntimeMemory {
  readonly body?: string;
  readonly citations?: readonly MemoryCodeCitationV1[];
  readonly lifecycle?: 'active' | 'archived' | 'superseded';
  readonly raw?: 'legacy' | 'malformed';
  readonly topic: string;
}

function scenarioDefinition(query: CodeMemoryLinkBenchQueryV1): ScenarioDefinition {
  const topic = `${query.id}-gold`;
  const standard = (files: readonly RuntimeFile[], citations: readonly MemoryCodeCitationV1[], dirty = false) => ({
    dirty,
    files,
    memories: [{citations, topic}],
    stale: false,
    symbols: [],
  });
  switch (query.scenario) {
    case 'exact-symbol': {
      const file = runtimeFile('src/exact-symbol.ts', 'export function exactSymbol() { return 1; }\n');
      const symbol = runtimeSymbol('1'.repeat(32), file, 'exactSymbol');
      return {...standard([file], [symbolCitation(symbol, file.content)]), symbols: [symbol]};
    }
    case 'exact-file': {
      const file = runtimeFile('src/exact-file.ts', 'export const exactFile = true;\n');
      return standard([file], [fileCitation(file)]);
    }
    case 'relocated-symbol': {
      const oldFile = runtimeFile('src/old/relocated-symbol.ts', 'export function relocatedSymbol() { return 2; }\n');
      const oldSymbol = runtimeSymbol('3'.repeat(32), oldFile, 'relocatedSymbol');
      const currentFile = runtimeFile('src/new/relocated-symbol.ts', oldFile.content);
      const currentSymbol = runtimeSymbol('2'.repeat(32), currentFile, 'relocatedSymbol');
      return {
        ...standard([currentFile], [symbolCitation(oldSymbol, oldFile.content)]),
        symbols: [currentSymbol],
      };
    }
    case 'changed': {
      const oldFile = runtimeFile('src/changed.ts', 'export const changed = "before";\n');
      const currentFile = runtimeFile(oldFile.path, 'export const changed = "after";\n');
      return standard([currentFile], [fileCitation(oldFile)]);
    }
    case 'deleted': {
      const deleted = runtimeFile('src/deleted.ts', 'export const deleted = true;\n');
      return standard([], [fileCitation(deleted)]);
    }
    case 'ambiguous-relocation': {
      const oldFile = runtimeFile('src/ambiguous.ts', 'export const ambiguous = true;\n');
      const copyA = runtimeFile('src/copies/ambiguous-a.ts', oldFile.content);
      const copyB = runtimeFile('src/copies/ambiguous-b.ts', oldFile.content);
      return standard([copyA, copyB], [fileCitation(oldFile)]);
    }
    case 'cross-repository-collision': {
      const file = runtimeFile('src/collision.ts', 'export const collision = true;\n');
      return standard([file], [fileCitation(file, FOREIGN_REPOSITORY_ID)]);
    }
    case 'archived': {
      const file = runtimeFile('src/archived.ts', 'export const archived = true;\n');
      return {...standard([file], []), memories: [{citations: [fileCitation(file)], lifecycle: 'archived', topic}]};
    }
    case 'superseded': {
      const file = runtimeFile('src/superseded.ts', 'export const superseded = true;\n');
      return {...standard([file], []), memories: [{citations: [fileCitation(file)], lifecycle: 'superseded', topic}]};
    }
    case 'conflicting-topic': {
      const file = runtimeFile('src/conflict.ts', 'export const conflict = true;\n');
      return {
        ...standard([file], [fileCitation(file)]),
        memories: [
          {citations: [fileCitation(file)], topic},
          {raw: 'legacy', topic: `${query.id}-lexical-decoy`},
        ],
      };
    }
    case 'malformed-citation': {
      const file = runtimeFile('src/malformed.ts', 'export const malformed = true;\n');
      return {...standard([file], []), memories: [{raw: 'malformed', topic}]};
    }
    case 'stale-graph': {
      const file = runtimeFile('src/stale-graph.ts', 'export const staleGraph = true;\n');
      return {...standard([file], [fileCitation(file)]), stale: true};
    }
    case 'dirty-overlay': {
      const file = runtimeFile('src/dirty-overlay.ts', 'export const dirtyOverlay = true;\n');
      return standard([file], [fileCitation(file, REPOSITORY_ID, true)], true);
    }
    case 'legacy-uncited': {
      const file = runtimeFile('src/legacy.ts', 'export const legacy = true;\n');
      return {...standard([file], []), memories: [{raw: 'legacy', topic}]};
    }
    case 'high-noise-budget': {
      const file = runtimeFile('src/high-noise.ts', 'export const highNoise = true;\n');
      const cohorts = Array.from({length: WARM_COHORTS}, (_, index) =>
        runtimeFile(
          `src/warm-cohorts/high-noise-${index.toString().padStart(2, '0')}.ts`,
          `export const highNoiseCohort${index} = true;\n`,
        ),
      );
      return {
        ...standard([file, ...cohorts], [fileCitation(file)]),
        memories: [
          {citations: [fileCitation(file)], topic},
          ...cohorts.map((cohort, index) => ({
            body: `Unseen validation rotation cohort ${index}.`,
            citations: [fileCitation(cohort)],
            topic: `rotation-${index.toString().padStart(2, '0')}`,
          })),
          ...Array.from({length: HIGH_NOISE_MEMORIES}, (_, index) => ({
            raw: 'legacy' as const,
            topic: `${query.id}-noise-${index.toString().padStart(3, '0')}`,
          })),
        ],
        warmCodeRefs: cohorts.map(cohort => cohort.path),
      };
    }
  }
}

function runtimeFile(path: string, content: string): RuntimeFile {
  return {content, path};
}

function inventoryFile(file: RuntimeFile, dirty: boolean): CodeGraphInventoryFile {
  const contentHash = fileContentHash(file.content);
  return {
    blobId: `bench:${contentHash}`,
    contentHash,
    language: 'typescript',
    mode: '100644',
    path: file.path,
    size: encoder.encode(file.content).byteLength,
    source: dirty ? 'worktree' : 'commit',
  };
}

function runtimeSymbol(seed: string, file: RuntimeFile, name: string): CodeGraphSymbol {
  return {
    contentHash: fileContentHash(file.content),
    exported: true,
    id: `cgs_${seed}`,
    kind: 'function',
    language: 'typescript',
    name,
    path: file.path,
    qualifiedName: name,
    signature: `${name}(): number`,
    span: {column: 1, endColumn: file.content.trimEnd().length + 1, endLine: 1, line: 1},
  };
}

function fileCitation(file: RuntimeFile, repositoryId = REPOSITORY_ID, sourceDirty = false): MemoryCodeCitationV1 {
  return createMemoryCodeCitation({
    extractorSet: EXTRACTOR_SET,
    fileContentHash: {algorithm: 'sha256', value: fileContentHash(file.content)},
    path: file.path,
    repositoryId,
    repositoryIdentityKind: 'remote',
    sourceCommit: SOURCE_COMMIT,
    sourceDirty,
    sourceGraphContentId: GRAPH_CONTENT_ID,
    sourceSnapshotId: SOURCE_SNAPSHOT_ID,
    target: {kind: 'file'},
    version: 1,
  });
}

function symbolCitation(symbol: CodeGraphSymbol, source: string): MemoryCodeCitationV1 {
  const fragment = codeGraphSourceSpanFragment(source, symbol.span);
  if (!fragment.ok) throw new Error(`Invalid CodeMemoryLinkBench symbol span: ${fragment.reason}.`);
  return createMemoryCodeCitation({
    extractorSet: EXTRACTOR_SET,
    fileContentHash: {algorithm: 'sha256', value: symbol.contentHash},
    path: symbol.path,
    repositoryId: REPOSITORY_ID,
    repositoryIdentityKind: 'remote',
    sourceCommit: SOURCE_COMMIT,
    sourceDirty: false,
    sourceGraphContentId: GRAPH_CONTENT_ID,
    sourceSnapshotId: SOURCE_SNAPSHOT_ID,
    target: {
      fragmentCanonicalization: 'utf8-source-span-v1',
      fragmentHash: {algorithm: 'sha256', value: fragment.fragment.sha256},
      kind: 'symbol',
      language: symbol.language,
      name: symbol.name,
      nodeId: symbol.id,
      qualifiedName: symbol.qualifiedName,
      ...(symbol.signature === undefined
        ? {}
        : {signatureHash: {algorithm: 'sha256' as const, value: sha256HexSync(symbol.signature)}}),
      span: symbol.span,
      symbolKind: symbol.kind,
    },
    version: 1,
  });
}

const writeCurrentFiles = Effect.fn('evaluation.codeMemoryLinkBenchRuntime.writeFiles')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  files: readonly RuntimeFile[],
) {
  for (const file of files) {
    const target = path.join(root, file.path);
    yield* fs.makeDirectory(path.dirname(target), {recursive: true});
    yield* fs.writeFileString(target, file.content);
  }
});

const writeScenarioMemories = Effect.fn('evaluation.codeMemoryLinkBenchRuntime.writeMemories')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
  query: CodeMemoryLinkBenchQueryV1,
  definition: ScenarioDefinition,
) {
  for (const memory of definition.memories) {
    const lifecycle = memory.lifecycle ?? 'active';
    const segments =
      lifecycle === 'active'
        ? ['projects', PROJECT]
        : lifecycle === 'archived'
          ? ['archived', PROJECT]
          : ['superseded', PROJECT];
    const target = path.join(
      home,
      'data',
      'local',
      'user',
      USER,
      'memories',
      'durable',
      ...segments,
      `${memory.topic}.md`,
    );
    yield* fs.makeDirectory(path.dirname(target), {recursive: true});
    const body = memory.body ?? `CodeMemoryLinkBench ${query.id}: ${query.task}`;
    if (memory.raw === 'legacy') {
      yield* fs.writeFileString(target, legacyMemory(memory.topic, body));
    } else if (memory.raw === 'malformed') {
      yield* fs.writeFileString(target, malformedMemory(memory.topic, body));
    } else {
      yield* fs.writeFileString(
        target,
        formatMemoryDocument(
          'MEMORY',
          {
            codeCitations: memory.citations ?? [],
            kind: 'durable',
            project: PROJECT,
            schemaVersion: MEMORY_SCHEMA_VERSION,
            sourceAgentClient: 'codex',
            status: lifecycle,
            timestamp: '2026-08-28T00:00:00.000Z',
            topic: memory.topic,
          },
          body,
        ),
      );
    }
  }
});

function legacyMemory(topic: string, body: string): string {
  return [
    'MEMORY',
    'kind: durable',
    'status: active',
    `project: ${PROJECT}`,
    `topic: ${topic}`,
    'source_agent_client: codex',
    'timestamp: 2026-08-28T00:00:00.000Z',
    'schema_version: 1',
    '',
    body,
  ].join('\n');
}

function malformedMemory(topic: string, body: string): string {
  return [
    'MEMORY',
    'kind: durable',
    'status: active',
    `project: ${PROJECT}`,
    `topic: ${topic}`,
    'source_agent_client: codex',
    'timestamp: 2026-08-28T00:00:00.000Z',
    `schema_version: ${MEMORY_SCHEMA_VERSION}`,
    'code_citation: {not-canonical-json',
    '',
    body,
  ].join('\n');
}

interface RuntimeGraph {
  readonly layer: Layer.Layer<CodeGraphQueryService | CodeGraphStore>;
  readonly leaseBalance: () => number;
  readonly maintenanceRequests: () => number;
  readonly validationEvidenceCalls: () => number;
}

function makeRuntimeGraph(root: string, definition: ScenarioDefinition): RuntimeGraph {
  const files = definition.files.map(file => inventoryFile(file, definition.dirty));
  const filesByPath = new Map(files.map(file => [file.path, file]));
  let acquired = 0;
  let released = 0;
  let maintenance = 0;
  let validationEvidenceCalls = 0;
  const store = CodeGraphStore.of({
    acquireSnapshotLease: () => Effect.sync(() => `code-memory-bench-lease-${++acquired}`),
    effectiveSnapshotCitationEvidence: (
      _databasePath: string,
      _snapshotId: string,
      request: CodeGraphEffectiveSnapshotCitationEvidenceRequest,
    ) =>
      Effect.sync(() => {
        if ((request.fileRelocationFallbacks?.length ?? 0) > 0) validationEvidenceCalls += 1;
        return runtimeCitationEvidence(
          request,
          files,
          filesByPath,
          definition.symbols,
          definition.stale ? 'incomplete' : 'complete',
        );
      }),
    releaseSnapshotLease: () => Effect.sync(() => void ++released),
  } as unknown as CodeGraphStoreShape);
  const status = runtimeStatus(root, definition);
  const query = CodeGraphQueryService.of({
    status: (_threadnoteHome: string, _cwd: string, options: {readonly requestMaintenance?: boolean}) =>
      Effect.sync(() => {
        if (options.requestMaintenance) maintenance += 1;
        return status;
      }),
  } as unknown as Parameters<typeof CodeGraphQueryService.of>[0]);
  return {
    layer: Layer.merge(Layer.succeed(CodeGraphStore, store), Layer.succeed(CodeGraphQueryService, query)),
    leaseBalance: () => acquired - released,
    maintenanceRequests: () => maintenance,
    validationEvidenceCalls: () => validationEvidenceCalls,
  };
}

function runtimeCitationEvidence(
  request: CodeGraphEffectiveSnapshotCitationEvidenceRequest,
  files: readonly CodeGraphInventoryFile[],
  filesByPath: ReadonlyMap<string, CodeGraphInventoryFile>,
  symbols: readonly CodeGraphSymbol[],
  fileInventoryCoverage: CodeGraphEffectiveSnapshotCitationEvidence['fileInventoryCoverage'],
): CodeGraphEffectiveSnapshotCitationEvidence {
  const paths = [
    ...new Set([...(request.paths ?? []), ...(request.fileRelocationFallbacks ?? []).map(item => item.path)]),
  ];
  const hashes = selectCodeGraphCitationContentHashTargets(
    [...new Set(request.contentHashes ?? [])],
    request.fileRelocationFallbacks ?? [],
    new Set(files.map(file => file.path)),
  );
  return {
    fileInventoryCoverage,
    filesByContentHashes: hashes.map(contentHash => ({
      contentHash,
      files: files.filter(file => file.contentHash === contentHash),
      truncated: false,
    })),
    filesByPaths: paths.map(repositoryPath => ({
      ...(filesByPath.get(repositoryPath) === undefined ? {} : {file: filesByPath.get(repositoryPath)!}),
      path: repositoryPath,
    })),
    symbolsByIds: symbols.filter(symbol => request.symbolIds?.includes(symbol.id) ?? false),
    symbolsBySemanticLocators: (request.semanticLocators ?? []).map(locator => ({
      locator,
      symbols: symbols.filter(symbol => matchesLocator(symbol, locator)),
      truncated: false,
    })),
  };
}

function matchesLocator(symbol: CodeGraphSymbol, locator: CodeGraphSymbolSemanticLocatorV1): boolean {
  return (
    symbol.kind === locator.kind &&
    symbol.language === locator.language &&
    symbol.name === locator.name &&
    symbol.qualifiedName === locator.qualifiedName
  );
}

function runtimeSnapshot(definition: ScenarioDefinition): CodeGraphSnapshot {
  return {
    commit: CURRENT_COMMIT,
    completedAt: '2026-08-28T00:00:00.000Z',
    dirty: definition.dirty,
    edgeCount: 0,
    extractorSet: EXTRACTOR_SET,
    fileCount: definition.files.length,
    graphContentId: GRAPH_CONTENT_ID,
    id: CURRENT_SNAPSHOT_ID,
    repositoryId: REPOSITORY_ID,
    state: 'ready',
    symbolCount: definition.symbols.length,
    worktreeId: sha256HexSync(`code-memory-link-bench\0${definition.dirty}`).slice(0, 64),
  };
}

function runtimeStatus(root: string, definition: ScenarioDefinition): CodeGraphStatus {
  const snapshot = runtimeSnapshot(definition);
  return {
    databasePath: `${root}/code-memory-link-bench.sqlite`,
    freshness: definition.stale ? 'stale' : 'current',
    identity: {
      caseMode: 'sensitive',
      checkoutId: 'code-memory-link-bench',
      displayName: 'threadnote/code-memory-link-bench',
      gitCommonDirectory: `${root}/.git`,
      headCommit: CURRENT_COMMIT,
      objectFormat: 'sha1',
      remoteIdentity: 'https://github.com/threadnote/code-memory-link-bench.git',
      repoRoot: root,
      repositoryId: REPOSITORY_ID,
      worktreeId: snapshot.worktreeId,
    },
    languagePacks: [],
    readySnapshot: snapshot,
    stale: definition.stale,
  };
}

function runtimeGraphEvidence(definition: ScenarioDefinition): ContextBriefGraphEvidenceV1 {
  const snapshot = runtimeSnapshot(definition);
  const complete = !definition.stale;
  return {
    cards: complete
      ? [
          {
            id: 'code-memory-link-bench-card',
            rank: 0,
            reason: 'Exact ready graph evidence for the backlink benchmark.',
            ref: `cgs_${'a'.repeat(32)}`,
            repositoryKey: 'code-memory-link-bench',
            symbol: {
              kind: 'file',
              language: 'typescript',
              line: 1,
              name: 'benchmark-target',
              path: definition.files[0]?.path ?? 'src/missing.ts',
              qualifiedName: 'benchmark-target',
            },
          },
        ]
      : [],
    ...(complete
      ? {citationValidationFence: {kind: 'repository' as const, repositoryId: REPOSITORY_ID, snapshotId: snapshot.id}}
      : {}),
    contracts: [],
    coverage: {
      complete,
      consideredRepositories: 1,
      readyRepositories: complete ? 1 : 0,
      requestedRepositories: 1,
      states: complete ? {current: 1} : {stale: 1},
    },
    gaps: complete ? [] : ['code-memory-link-bench-stale-graph'],
    resolvedSnapshots: complete
      ? [
          {
            commit: snapshot.commit,
            dirty: snapshot.dirty,
            freshness: snapshot.dirty ? 'unknown' : 'fresh',
            repositoryId: REPOSITORY_ID,
            repositoryKey: 'code-memory-link-bench',
            snapshotId: snapshot.id,
          },
        ]
      : [],
    trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
    warnings: [],
  };
}

function runtimeConfig(root: string, home: string): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome: home,
    agentId: 'code-memory-link-bench',
    manifestPath: `${root}/manifest.yaml`,
    user: USER,
  };
}

function fileContentHash(content: string): string {
  return codeGraphCommittedFileContentHash('sha1', encoder.encode(content));
}

function monotonicMilliseconds(): number {
  return performance.now();
}

function elapsed(started: number): number {
  return Math.max(0, performance.now() - started);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export type {CodeMemoryLinkBenchResultV1, CodeMemoryLinkBenchScenarioKind};
