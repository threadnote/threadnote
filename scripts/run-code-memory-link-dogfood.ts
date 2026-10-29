#!/usr/bin/env bun
import {isSafeInteger as checkedIsSafeInteger} from '@threadnote/platform/validation';
import {Array as EffectArray, Predicate} from 'effect';

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Clock, Console, Effect, FileSystem, Path} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {measureAgentToolResponse} from '@threadnote/protocol/agent-response';
import {
  codeMemoryLinkDogfoodArtifactHash,
  createCodeMemoryLinkDeferredAnchorObservationV2,
  createCodeMemoryLinkDogfoodObservationV1,
  evaluateCodeMemoryLinkDogfood,
  type CodeMemoryLinkDeferredAnchorObservationSummaryV2,
  type CodeMemoryLinkDogfoodCaseId,
  type CodeMemoryLinkDogfoodGraphStatusV1,
  type CodeMemoryLinkDogfoodObservationSummaryV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-dogfood';
import {parseContextBriefV1, renderContextBriefText} from '@threadnote/context/projector';
import {isDeferredCodeAnchorIntentFilename} from '@threadnote/threadnote/memory/deferred/code_anchor';
import {parseMemoryDocument, type MemoryRecord} from '@threadnote/memory/document';
import {
  resolveManagedDevelopmentExecutableForSource,
  verifyManagedDevelopmentRuntimeForSource,
} from './development-runtime.js';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {atomicWrite, scriptArguments} from './effect/script.js';
import {CODE_MEMORY_LINK_EVALUATION_USER, candidateEnvironment} from './code-memory-link-codex-preflight.js';
import {verifyApprovalCheckout} from './verify-code-memory-link-release.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Option as EffectOption} from 'effect';

const BUDGET_TOKENS = 1_250;
const CITED_FILE = 'packages/recall/src/code_links.ts';
const UNRELATED_FILE = 'packages/workspace/src/runtime-version.ts';
const REVIEWED_POSIX_EXECUTABLE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

const program = Effect.scoped(
  Effect.gen(function* () {
    const options = parseArguments(yield* scriptArguments());
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const executingSourceRoot = yield* path.fromFileUrl(new URL('../', import.meta.url));
    const sourceRoot = yield* verifyDogfoodRunnerCheckout({
      approvalCommit: options.approvalCommit,
      candidateCommit: options.candidateCommit,
      executingSourceRoot,
      requestedSourceRoot: path.resolve(options.repository),
    });
    const resolved = yield* resolveManagedDevelopmentExecutableForSource(options.candidateCommit);
    const candidate = {
      buildIdentityHash: resolved.evidence.executableSha256,
      commit: resolved.evidence.sourceCommit,
      dirty: false as const,
    };
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-code-memory-dogfood-'});
    const repository = path.join(root, 'repository');
    const home = path.join(root, 'home');
    const processHome = path.join(root, 'process-home');
    const temporaryDirectory = path.join(root, 'tmp');
    yield* Effect.all(
      [
        fs.makeDirectory(processHome, {recursive: true, mode: 0o700}),
        fs.makeDirectory(temporaryDirectory, {recursive: true, mode: 0o700}),
      ],
      {concurrency: 2, discard: true},
    );
    yield* runCommandEffect('git', ['clone', '--no-hardlinks', '--no-local', '--quiet', sourceRoot, repository], {
      maxOutputBytes: 64 * 1024,
      timeoutMs: 120_000,
    });
    const cloneHead = yield* git(repository, ['rev-parse', 'HEAD']);
    if (Effect2.pipe(cloneHead.stdout, EffectString.trim) !== options.approvalCommit) {
      return yield* ScriptError.make({message: 'The isolated dogfood clone did not resolve the reviewed harness.'});
    }
    const dogfoodEnvironment = codeMemoryLinkDogfoodEnvironment({
      home: processHome,
      temporaryDirectory,
      threadnoteHome: home,
    });
    const runExact = (args: readonly string[], timeoutMs = 120_000, allowFailure = false) =>
      runCommandEffect(resolved.executable, args, {
        allowFailure,
        cwd: repository,
        env: dogfoodEnvironment,
        maxOutputBytes: 2 * 1024 * 1024,
        timeoutMs,
      });
    yield* runExact(['graph', 'index', '--home', home, '--cwd', repository, '--no-vectors', '--json'], 300_000);
    const graphQuery = yield* runExact([
      'graph',
      'query',
      '--home',
      home,
      '--cwd',
      repository,
      '--query',
      'selectRecallCodeLinks',
      '--freshness',
      'current',
      '--json',
    ]);
    const symbol = findSymbolId(JSON.parse(graphQuery.stdout) as unknown, 'selectRecallCodeLinks');
    if (symbol === null) return yield* ScriptError.make({message: 'Dogfood could not resolve the cited symbol id.'});
    const runId = randomOpaqueId('run');
    const lexicalMarker = randomOpaqueId('marker');
    yield* runExact([
      'remember',
      '--home',
      home,
      '--kind',
      'handoff',
      '--project',
      'threadnote',
      '--topic',
      `code-memory-dogfood-${Effect2.pipe(runId, EffectString.slice(4, 20))}`,
      '--text',
      `${lexicalMarker} exact-installed practical backlink evidence for the recall selector contract.`,
      '--code-ref',
      CITED_FILE,
      '--code-ref',
      symbol,
    ]);

    const rawRuns: RawRun[] = [];
    const invokeBrief = Effect.fn('codeMemoryLinkDogfood.invokeBrief')(function* (
      task: string,
      codeRefs: readonly string[],
    ) {
      const args = [
        'context',
        'brief',
        '--home',
        home,
        '--cwd',
        repository,
        '--project',
        'threadnote',
        '--task',
        task,
        '--budget-tokens',
        String(BUDGET_TOKENS),
        '--json',
        ...EffectArray.flatMap(codeRefs, ref => ['--code-ref', ref]),
      ];
      const result = yield* runExact(args);
      return parseContextBriefV1(JSON.parse(result.stdout) as unknown);
    });
    const runBrief = Effect.fn('codeMemoryLinkDogfood.runBrief')(function* (
      id: CodeMemoryLinkDogfoodCaseId,
      task: string,
      codeRefs: readonly string[],
      graphStatus: CodeMemoryLinkDogfoodGraphStatusV1 | null,
    ) {
      const invocationNonce = randomOpaqueId('inv');
      const brief = yield* invokeBrief(task, codeRefs);
      rawRuns.push({
        invocationNonce,
        summary: summarizeBrief(id, brief, graphStatus),
      });
    });

    yield* runBrief('task-only-memory', lexicalMarker, [], null);
    const anchorTask = 'Assess the implementation contract for this exact code anchor.';
    yield* runBrief('file-backlink', anchorTask, [CITED_FILE], null);
    yield* runBrief('symbol-backlink', anchorTask, [symbol], null);
    yield* runBrief('multi-anchor', anchorTask, [CITED_FILE, symbol], null);
    yield* runBrief('no-backlink', anchorTask, [UNRELATED_FILE], null);
    const citedSource = path.join(repository, CITED_FILE);
    yield* fs.writeFileString(citedSource, `${yield* fs.readFileString(citedSource)}\n`);
    const graphStatusResult = yield* runExact(['graph', 'status', '--home', home, '--cwd', repository, '--json']);
    const graphStatus = projectCodeMemoryLinkDogfoodGraphStatusV1(JSON.parse(graphStatusResult.stdout) as unknown);
    yield* runBrief('stale-graph-abstention', anchorTask, [CITED_FILE], graphStatus);

    const deferredTopic = `code-memory-deferred-${Effect2.pipe(runId, EffectString.slice(4, 20))}`;
    const deferredMemoryUri =
      `threadnote://user/${CODE_MEMORY_LINK_EVALUATION_USER}/memories/durable/projects/threadnote/` +
      `${deferredTopic}.md`;
    const deferredLexicalMarker = randomOpaqueId('deferred');
    const deferredBody = `${deferredLexicalMarker} durable store-now/anchor-later lifecycle evidence.`;
    const deferredRememberArgs = [
      'remember',
      '--home',
      home,
      '--kind',
      'durable',
      '--project',
      'threadnote',
      '--topic',
      deferredTopic,
      '--text',
      deferredBody,
      '--code-ref',
      UNRELATED_FILE,
    ] as const;
    const strictStartedAt = yield* Clock.currentTimeMillis;
    const strictWrite = yield* runExact([...deferredRememberArgs, '--require-current-code-refs'], 120_000, true);
    const strictReceiptMilliseconds = Math.max(0, Math.round((yield* Clock.currentTimeMillis) - strictStartedAt));
    const strictRead = yield* runExact(['read', '--home', home, deferredMemoryUri], 120_000, true);
    const strictStatusRaw = JSON.parse(
      (yield* runExact(['graph', 'status', '--home', home, '--cwd', repository, '--json'])).stdout,
    ) as unknown;

    const deferredStartedAt = yield* Clock.currentTimeMillis;
    const deferredWrite = yield* runExact(deferredRememberArgs);
    const durableReceiptMilliseconds = Math.max(0, Math.round((yield* Clock.currentTimeMillis) - deferredStartedAt));
    if (!Effect2.pipe(deferredWrite.stdout, EffectString.includes(deferredMemoryUri))) {
      return yield* ScriptError.make({message: 'Deferred write did not return the canonical durable memory URI.'});
    }
    const beforeContent = (yield* runExact(['read', '--home', home, deferredMemoryUri])).stdout;
    const beforeMemory = requireMemoryRecord(deferredMemoryUri, beforeContent, 'deferred memory before finalization');
    const pendingTaskBrief = yield* invokeBrief(deferredLexicalMarker, []);
    const pendingMemoryRecallableByTask = contextBriefContainsMemory(pendingTaskBrief, deferredMemoryUri);
    const pendingRoot = path.join(
      home,
      'data',
      'local',
      'user',
      CODE_MEMORY_LINK_EVALUATION_USER,
      'private',
      'deferred-code-anchors',
      'v1',
    );
    const pendingIntentCountAfterStore = yield* countDeferredAnchorIntents(pendingRoot);
    const graphStatusAfterStoreRaw = JSON.parse(
      (yield* runExact(['graph', 'status', '--home', home, '--cwd', repository, '--json'])).stdout,
    ) as unknown;
    const graphStatusAfterStore = projectCodeMemoryLinkDogfoodGraphStatusV1(graphStatusAfterStoreRaw);
    const beforeFinalizeBrief = yield* invokeBrief(anchorTask, [UNRELATED_FILE]);
    const beforeFinalizeProjection = summarizeDirectMemoryEvidence(beforeFinalizeBrief);

    yield* runExact(['graph', 'index', '--home', home, '--cwd', repository, '--no-vectors', '--json'], 300_000);
    const pendingIntentCountAfterFinalize = yield* countDeferredAnchorIntents(pendingRoot);
    const afterContent = (yield* runExact(['read', '--home', home, deferredMemoryUri])).stdout;
    const afterMemory = requireMemoryRecord(deferredMemoryUri, afterContent, 'deferred memory after finalization');
    const afterFinalizeBrief = yield* invokeBrief(anchorTask, [UNRELATED_FILE]);
    const afterFinalizeProjection = summarizeDirectMemoryEvidence(afterFinalizeBrief);
    // The automatic graph-index hook is deliberately silent so it cannot mutate
    // the public graph JSON contract. Derive the stable v2 evaluation projection
    // from the isolated one-intent state transition instead of invoking the
    // explicit repair command and accidentally testing the wrong product path.
    const finalization = projectAutomaticDeferredAnchorTransition({
      citationCountAfter: afterMemory.metadata.codeCitations?.length ?? 0,
      citationCountBefore: beforeMemory.metadata.codeCitations?.length ?? 0,
      pendingIntentCountAfter: pendingIntentCountAfterFinalize,
      pendingIntentCountBefore: pendingIntentCountAfterStore,
    });
    const deferredAnchorSummary: CodeMemoryLinkDeferredAnchorObservationSummaryV2 = {
      canonicalBodyPreserved: beforeMemory.body === afterMemory.body && afterMemory.body === deferredBody,
      canonicalIdentityPreserved:
        beforeMemory.uri === afterMemory.uri && beforeMemory.metadata.memoryId === afterMemory.metadata.memoryId,
      canonicalLifecyclePreserved: sameMemoryLifecycle(beforeMemory, afterMemory),
      canonicalTimestampsPreserved: sameMemoryTimestamps(beforeMemory, afterMemory),
      citationsFinalizedAfterPrepare: (afterMemory.metadata.codeCitations?.length ?? 0) === 1,
      directMatchesAfterFinalize: afterFinalizeProjection.directMatches,
      directMatchesBeforeFinalize: beforeFinalizeProjection.directMatches,
      deferredReceiptGuidanceObserved:
        Effect2.pipe(deferredWrite.stdout, EffectString.includes('Stored memory without finalized code citations')) &&
        Effect2.pipe(deferredWrite.stdout, EffectString.includes('private local outbox')) &&
        Effect2.pipe(deferredWrite.stdout, EffectString.includes('retries automatically after graph indexing')) &&
        Effect2.pipe(deferredWrite.stdout, EffectString.includes('threadnote finalize-code-refs')),
      durableReceiptMilliseconds,
      falseCurrentCount: afterFinalizeProjection.falseCurrentCount,
      finalizedBacklinkTargetsStoredMemory: contextBriefContainsDirectMemory(afterFinalizeBrief, deferredMemoryUri),
      finalization,
      graphStatusAfterStore,
      indexingStartedByWrite: codeGraphStatusHasIndexingActivity(graphStatusAfterStoreRaw),
      memoryStored: beforeMemory.body === deferredBody,
      pendingIntentCountAfterFinalize,
      pendingIntentCountAfterStore,
      pendingMemoryRecallableByTask,
      restartBoundary: true,
      strictIndexingStartedByWrite: codeGraphStatusHasIndexingActivity(strictStatusRaw),
      strictMemoryStored: strictRead.exitCode === 0,
      strictReceiptMilliseconds,
      strictRecoveryGuidanceObserved:
        /(?:exact current graph evidence|already-published ready graph)/u.test(
          `${strictWrite.stdout}\n${strictWrite.stderr}`,
        ) &&
        Effect2.pipe(`${strictWrite.stdout}\n${strictWrite.stderr}`, EffectString.includes('No indexing was started')),
      strictWriteRejected: strictWrite.exitCode !== 0,
    };

    const [after, governanceAfter] = yield* Effect.all([
      verifyManagedDevelopmentRuntimeForSource(options.candidateCommit),
      verifyApprovalCheckout(sourceRoot, options.candidateCommit),
    ]);
    if (governanceAfter.commit !== options.approvalCommit) {
      return yield* ScriptError.make({message: 'The reviewed harness checkout changed during dogfood.'});
    }
    const observations = EffectArray.map(rawRuns, run =>
      createCodeMemoryLinkDogfoodObservationV1({
        candidate,
        harnessCommit: options.approvalCommit,
        invocationNonce: run.invocationNonce,
        observation: run.summary,
        postRuntime: after,
        preRuntime: resolved.evidence,
        runId,
      }),
    );
    const deferredAnchorLifecycle = createCodeMemoryLinkDeferredAnchorObservationV2({
      candidate,
      harnessCommit: options.approvalCommit,
      invocationNonce: randomOpaqueId('inv'),
      observation: deferredAnchorSummary,
      postRuntime: after,
      preRuntime: resolved.evidence,
      runId,
    });
    const evidence = {
      candidate,
      deferredAnchorLifecycle,
      harnessCommit: options.approvalCommit,
      observations,
      runId,
      version: 2 as const,
    };
    const artifact = {...evidence, artifactHash: codeMemoryLinkDogfoodArtifactHash(evidence)};
    const result = evaluateCodeMemoryLinkDogfood(artifact);
    yield* atomicWrite(options.output, `${JSON.stringify(artifact, undefined, 2)}\n`);
    if (result.gate.qualityFailures.length > 0) {
      return yield* ScriptError.make({
        message: `Dogfood evidence was retained at ${options.output}.\n${EffectArray.join(result.gate.qualityFailures, '\n')}`,
      });
    }
    yield* Console.log(
      JSON.stringify({artifactHash: artifact.artifactHash, gate: result.gate, output: options.output}),
    );
  }),
);

interface RawRun {
  readonly invocationNonce: string;
  readonly summary: CodeMemoryLinkDogfoodObservationSummaryV1;
}

function summarizeBrief(
  id: CodeMemoryLinkDogfoodCaseId,
  brief: ReturnType<typeof parseContextBriefV1>,
  graphStatus: CodeMemoryLinkDogfoodGraphStatusV1 | null,
): CodeMemoryLinkDogfoodObservationSummaryV1 {
  const memories = [...brief.activeHandoffs, ...brief.durableDecisions];
  const uniqueUris = new Set(EffectArray.map(memories, memory => memory.uri));
  const direct = EffectArray.filter(memories, memory => memory.selectionBasis === 'code-citation');
  const coverage = brief.coverage.memory.codeAnchors;
  const measurement = measureAgentToolResponse({structuredContent: brief, text: renderContextBriefText(brief)});
  return {
    budgetTokens: BUDGET_TOKENS,
    codeAnchorCoverageComplete: coverage?.complete ?? null,
    directCodeCitationMatches: direct.length,
    duplicateMemoryCount: memories.length - uniqueUris.size,
    estimatedTokens: measurement.estimatedTokens,
    falseCurrentCount: EffectArray.filter(
      direct,
      __effectArrayValue =>
        !!(memory =>
          EffectOption.getOrUndefined(
            EffectOption.map(EffectOption.fromNullishOr(memory.codeRelations), __effectArrayReceiver =>
              EffectArray.some(__effectArrayReceiver, relation => relation.status !== 'exact'),
            ),
          ))(__effectArrayValue),
    ).length,
    graphStatus,
    id,
    memoryMatches: memories.length,
    outputVersion: brief.version,
    requestedAnchors: coverage?.requested ?? 0,
    resolvedAnchors: coverage?.resolved ?? 0,
    responseBytes: measurement.totalBytes,
  };
}

function summarizeDirectMemoryEvidence(brief: ReturnType<typeof parseContextBriefV1>): {
  readonly directMatches: number;
  readonly falseCurrentCount: number;
} {
  const memories = [...brief.activeHandoffs, ...brief.durableDecisions];
  const direct = EffectArray.filter(memories, memory => memory.selectionBasis === 'code-citation');
  return {
    directMatches: direct.length,
    falseCurrentCount: EffectArray.filter(
      direct,
      __effectArrayValue =>
        !!(memory =>
          EffectOption.getOrUndefined(
            EffectOption.map(EffectOption.fromNullishOr(memory.codeRelations), __effectArrayReceiver =>
              EffectArray.some(__effectArrayReceiver, relation => relation.status !== 'exact'),
            ),
          ))(__effectArrayValue),
    ).length,
  };
}

function contextBriefContainsMemory(brief: ReturnType<typeof parseContextBriefV1>, memoryUri: string): boolean {
  return EffectArray.some([...brief.activeHandoffs, ...brief.durableDecisions], memory => memory.uri === memoryUri);
}

function contextBriefContainsDirectMemory(brief: ReturnType<typeof parseContextBriefV1>, memoryUri: string): boolean {
  return EffectArray.some(
    [...brief.activeHandoffs, ...brief.durableDecisions],
    memory => memory.uri === memoryUri && memory.selectionBasis === 'code-citation',
  );
}

export function projectDeferredAnchorFinalization(
  value: unknown,
): CodeMemoryLinkDeferredAnchorObservationSummaryV2['finalization'] {
  const receipt = plainRecord(value, 'Deferred code-anchor finalization receipt');
  if (
    receipt.type !== 'threadnote-deferred-code-anchor-finalization' ||
    receipt.version !== 1 ||
    !EffectArray.isArray(receipt.items)
  ) {
    throw ScriptError.make({message: 'Dogfood finalization did not use the expected v1 receipt contract.'});
  }
  const items = EffectArray.map(receipt.items, (value, index) =>
    plainRecord(value, `Deferred finalization item ${index + 1}`),
  );
  const count = (field: 'conflictCount' | 'failedCount' | 'finalizedCount' | 'pendingCount' | 'scannedCount') => {
    const candidate = receipt[field];
    if (!checkedIsSafeInteger(candidate) || candidate < 0) {
      throw ScriptError.make({message: `Dogfood finalization ${field} must be a non-negative integer.`});
    }
    return candidate;
  };
  const projected = {
    citationCount: EffectArray.reduce(items, 0, (total, item) => {
      const candidate = item.citationCount;
      if (candidate === undefined) return total;
      if (!checkedIsSafeInteger(candidate) || candidate < 0) {
        throw ScriptError.make({message: 'Dogfood finalization citation count must be a non-negative integer.'});
      }
      return total + candidate;
    }),
    conflictCount: count('conflictCount'),
    failedCount: count('failedCount'),
    finalizedCount: count('finalizedCount'),
    pendingCount: count('pendingCount'),
    scannedCount: count('scannedCount'),
  };
  if (
    projected.scannedCount !== items.length ||
    projected.conflictCount !== EffectArray.filter(items, item => item.state === 'conflict').length ||
    projected.failedCount !== EffectArray.filter(items, item => item.state === 'failed').length ||
    projected.finalizedCount !== EffectArray.filter(items, item => item.state === 'finalized').length ||
    projected.pendingCount !== EffectArray.filter(items, item => item.state === 'pending').length
  ) {
    throw ScriptError.make({message: 'Dogfood finalization aggregate counts do not match its item receipts.'});
  }
  return projected;
}

export function codeGraphStatusHasIndexingActivity(value: unknown): boolean {
  const status = plainRecord(value, 'Code graph status');
  if (
    status.type !== 'code-graph-status' ||
    (status.version !== 2 && status.version !== 3 && status.version !== 4 && status.version !== 5) ||
    !EffectArray.isArray(status.builds) ||
    !EffectArray.isArray(status.waiters) ||
    !checkedIsSafeInteger(status.waiterCount) ||
    status.waiterCount < 0 ||
    !('build' in status)
  ) {
    throw ScriptError.make({message: 'Dogfood graph status omitted its build and waiter activity contract.'});
  }
  return status.build !== null || status.builds.length > 0 || status.waiters.length > 0 || status.waiterCount !== 0;
}

const countDeferredAnchorIntents = Effect.fn('codeMemoryLinkDogfood.countDeferredAnchorIntents')(function* (
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fs
    .readDirectory(root, {recursive: true})
    .pipe(Effect.orElseSucceed(() => [] as readonly string[]));
  return countDeferredAnchorIntentNames(EffectArray.map(names, name => path.basename(name)));
});

export function countDeferredAnchorIntentNames(names: readonly string[]): number {
  return EffectArray.filter(names, isDeferredCodeAnchorIntentFilename).length;
}

export function projectAutomaticDeferredAnchorTransition(input: {
  readonly citationCountAfter: number;
  readonly citationCountBefore: number;
  readonly pendingIntentCountAfter: number;
  readonly pendingIntentCountBefore: number;
}): CodeMemoryLinkDeferredAnchorObservationSummaryV2['finalization'] {
  const counts = [
    input.citationCountAfter,
    input.citationCountBefore,
    input.pendingIntentCountAfter,
    input.pendingIntentCountBefore,
  ];
  if (EffectArray.some(counts, count => !checkedIsSafeInteger(count) || count < 0)) {
    throw ScriptError.make({message: 'Automatic deferred-anchor transition counts must be non-negative integers.'});
  }
  const citationCount = Math.max(0, input.citationCountAfter - input.citationCountBefore);
  const finalized =
    input.pendingIntentCountBefore === 1 &&
    input.pendingIntentCountAfter === 0 &&
    input.citationCountBefore === 0 &&
    input.citationCountAfter === 1;
  const remainedPending =
    input.pendingIntentCountBefore === 1 &&
    input.pendingIntentCountAfter === 1 &&
    input.citationCountBefore === 0 &&
    input.citationCountAfter === 0;
  return {
    citationCount,
    conflictCount: 0,
    failedCount: finalized || remainedPending ? 0 : 1,
    finalizedCount: finalized ? 1 : 0,
    pendingCount: input.pendingIntentCountAfter,
    scannedCount: input.pendingIntentCountBefore,
  };
}

function requireMemoryRecord(uri: string, content: string, label: string): MemoryRecord {
  const record = parseMemoryDocument(uri, content);
  if (!record) throw ScriptError.make({message: `${label} is not a canonical Threadnote memory document.`});
  return record;
}

function sameMemoryTimestamps(before: MemoryRecord, after: MemoryRecord): boolean {
  return (
    before.metadata.timestamp === after.metadata.timestamp &&
    before.metadata.createdAt === after.metadata.createdAt &&
    before.metadata.updatedAt === after.metadata.updatedAt
  );
}

function sameMemoryLifecycle(before: MemoryRecord, after: MemoryRecord): boolean {
  const projection = (record: MemoryRecord) => ({
    archivedFrom: record.metadata.archivedFrom,
    headerTitle: record.headerTitle,
    kind: record.metadata.kind,
    project: record.metadata.project,
    status: record.metadata.status,
    supersedes: record.metadata.supersedes,
    topic: record.metadata.topic,
    validFrom: record.metadata.validFrom,
    validTo: record.metadata.validTo,
    visibility: record.metadata.visibility,
  });
  return JSON.stringify(projection(before)) === JSON.stringify(projection(after));
}

export function projectCodeMemoryLinkDogfoodGraphStatusV1(value: unknown): CodeMemoryLinkDogfoodGraphStatusV1 {
  const status = plainRecord(value, 'Code graph status');
  if (
    status.type !== 'code-graph-status' ||
    (status.version !== 2 && status.version !== 3 && status.version !== 4 && status.version !== 5) ||
    typeof status.stale !== 'boolean'
  ) {
    throw ScriptError.make({message: 'Dogfood graph status did not use a supported status contract.'});
  }
  const snapshot = plainRecord(status.readySnapshot, 'Code graph ready snapshot');
  if (
    typeof snapshot.commit !== 'string' ||
    !/^[0-9a-f]{40}$/u.test(snapshot.commit) ||
    typeof snapshot.dirty !== 'boolean' ||
    typeof snapshot.id !== 'string' ||
    !/^cgsn_[0-9a-f]{32,64}$/u.test(snapshot.id)
  ) {
    throw ScriptError.make({message: 'Dogfood graph status did not identify a valid ready snapshot.'});
  }
  return {
    readySnapshotCommit: snapshot.commit,
    readySnapshotDirty: snapshot.dirty,
    readySnapshotId: snapshot.id,
    stale: status.stale,
  };
}

/** Candidate dogfood receives only deterministic runtime inputs, never ambient host credentials or configuration. */
export function codeMemoryLinkDogfoodEnvironment(input: {
  readonly home: string;
  readonly temporaryDirectory: string;
  readonly threadnoteHome: string;
}): Readonly<Record<string, string>> {
  return {
    ...candidateEnvironment(input.threadnoteHome, REVIEWED_POSIX_EXECUTABLE_PATH),
    HOME: input.home,
    TMPDIR: input.temporaryDirectory,
  };
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) {
    throw ScriptError.make({message: `${label} must be an object.`});
  }
  return value;
}

function findSymbolId(value: unknown, name: string): string | null {
  if (EffectArray.isArray(value)) {
    for (const entry of value) {
      const found = findSymbolId(entry, name);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isStringRecord(value)) return null;
  const object = value;
  if (object.name === name && typeof object.id === 'string' && /^cgs_[0-9a-f]{32,64}$/u.test(object.id)) {
    return object.id;
  }
  return findSymbolId(EffectRecord.values(object), name);
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}

function parseArguments(args: readonly string[]): {
  readonly approvalCommit: string;
  readonly candidateCommit: string;
  readonly output: string;
  readonly repository: string;
} {
  const values: Record<string, string | undefined> = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!['--approval-commit', '--candidate-commit', '--output', '--repository'].includes(argument)) {
      throw ScriptError.make({message: `Unknown Code Memory Link dogfood option: ${argument}`});
    }
    values[argument] = required(args[++index], argument);
  }
  return {
    approvalCommit: required(values['--approval-commit'], '--approval-commit'),
    candidateCommit: required(values['--candidate-commit'], '--candidate-commit'),
    output: required(values['--output'], '--output'),
    repository: required(values['--repository'], '--repository'),
  };
}

function randomOpaqueId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}_${EffectArray.join(
    EffectArray.map([...bytes], value => Effect2.pipe(value.toString(16), EffectString.padStart(2, '0'))),
    '',
  )}`;
}

function required(value: string | undefined, option: string): string {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native optional chaining preserves the non-undefined return type after validation.
  if (!value?.trim()) throw ScriptError.make({message: `${option} requires a value.`});
  return value;
}

function git(cwd: string, args: readonly string[]) {
  return runCommandEffect('git', args, {cwd, maxOutputBytes: 1024 * 1024, timeoutMs: 30_000});
}

export const verifyDogfoodRunnerCheckout = Effect.fn('codeMemoryLinkDogfood.verifyRunnerCheckout')(function* (input: {
  readonly approvalCommit: string;
  readonly candidateCommit: string;
  readonly executingSourceRoot: string;
  readonly requestedSourceRoot: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const [executingSourceRoot, requestedSourceRoot] = yield* Effect.all(
    [fs.realPath(input.executingSourceRoot), fs.realPath(input.requestedSourceRoot)],
    {concurrency: 2},
  );
  if (executingSourceRoot !== requestedSourceRoot) {
    return yield* ScriptError.make({
      message: '--repository must be the canonical checkout that supplied and is executing the dogfood runner.',
    });
  }
  const governance = yield* verifyApprovalCheckout(executingSourceRoot, input.candidateCommit);
  if (governance.commit !== input.approvalCommit) {
    return yield* ScriptError.make({
      message: 'Dogfood requires the executing checkout to be the exact clean reviewed --approval-commit.',
    });
  }
  return executingSourceRoot;
});

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));
