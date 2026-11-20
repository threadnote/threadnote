import * as EffectArray from 'effect/Array';
import {Clock, Effect} from 'effect';
import {assembleNavigationAnswer} from './assemble.js';
import {
  discoverCodeGraphTask,
  acquireTaskDiscoveryRead,
  type TaskDiscoveryRequest,
} from '@threadnote/graph/query/task_discovery';
import type {CodeGraphQueryResult, RepositoryIdentity} from '@threadnote/graph/types';
import {retrieveNavigationSourceProofs} from './source_facts.js';
import {structuralNavigationInput, type NavigationSourceProofs} from './structural.js';
import {projectNavigationAnswer} from './project.js';
import type {NavigationScope} from './model.js';

export interface TaskNavigationRequest extends TaskDiscoveryRequest {
  readonly identity: RepositoryIdentity;
  readonly repositoryKey: string;
  readonly scope: NavigationScope;
  /** Already resolved and validated anchors retain precedence; no task candidate acquisition occurs. */
  readonly anchoredResult?: CodeGraphQueryResult;
  readonly maximumEstimatedTokens?: number;
}

/** Package seam only. Public handlers and provider/session admission remain with their owning phases. */
export const retrieveTaskNavigationAnswer = Effect.fn('navigation.retrieveTaskAnswer')(function* (
  input: TaskNavigationRequest,
) {
  const wholeStarted = yield* Clock.monotonicTimeNanos;
  const anchored = input.anchoredResult;
  if (
    anchored !== undefined &&
    (anchored.repository.repositoryId !== input.observation.repository.repositoryId ||
      anchored.snapshot.id !== input.observation.snapshot.id ||
      anchored.snapshot.worktreeId !== input.observation.snapshot.worktreeId ||
      anchored.snapshot.commit !== input.observation.snapshot.commit ||
      anchored.snapshot.dirty !== input.observation.snapshot.dirty)
  )
    throw new Error('Task navigation anchor observation conflict.');
  const discovery = anchored === undefined ? yield* discoverCodeGraphTask(input) : undefined;
  const discoveryEnded = yield* Clock.monotonicTimeNanos;
  const result = anchored ?? discovery!.result;
  const gaps = [...(discovery?.evidence.gaps ?? [])];
  let acquired: NavigationSourceProofs = {
    facts: {observation: input.observation, files: []},
    source: {excerpts: [], gaps: []},
    proofs: [],
    gaps,
  };
  const selectors = [
    ...new Map(
      EffectArray.map(result.nodes, node => [node.path, {path: node.path, contentHash: node.contentHash}]),
    ).values(),
  ].slice(0, 3);
  // NAV02's reader already bounds stored and decoded payloads to1MiB each. Reserve both, its finite
  // metadata closure and the one source batch BEFORE calling it; unused reservation is returned.
  const metadataReservation =
    selectors.length * 20_480 +
    Math.min(24, result.nodes.length) * 20_480 +
    Math.min(64, result.edges.length) * 131_072;
  const factReservation = 2 * 1024 * 1024 + metadataReservation;
  // The unchanged source reader retains/hashes whole files before clipping excerpts.
  // There is no actual-retained-byte receipt here: conservatively charge its full existing ceiling.
  const retainedSourceReservation = 3 * 512 * 1024;
  const excerptReservation = 64 * 1024;
  const byteAccounting = {
    retainedSourceReservedBytes: 0,
    retainedSourceChargedUpperBoundBytes: 0,
    retainedSourceActualBytes: null,
    excerptBytes: 0,
  };
  if (
    selectors.length > 0 &&
    input.budget.remainingBytes >= factReservation + retainedSourceReservation + excerptReservation &&
    input.budget.remainingReads >= 3
  ) {
    const reservation = factReservation + retainedSourceReservation + excerptReservation;
    byteAccounting.retainedSourceReservedBytes = retainedSourceReservation;
    byteAccounting.retainedSourceChargedUpperBoundBytes = retainedSourceReservation;
    input.budget.remainingBytes -= reservation;
    const source = yield* retrieveNavigationSourceProofs({
      databasePath: input.databasePath,
      result,
      selectors,
      identity: input.identity,
      repositoryKey: input.repositoryKey,
      maximumContentBytes: excerptReservation,
      acquireRead: acquireTaskDiscoveryRead(input.budget),
      deadline: input.budget.deadline,
    }).pipe(Effect.catchTag('ReadDeadlineExceeded', () => Effect.void));
    if (source === undefined) gaps.push('task-source-deadline-exhausted');
    else {
      byteAccounting.excerptBytes = EffectArray.reduce(
        source.source.excerpts,
        0,
        (bytes, excerpt) => bytes + Buffer.byteLength(excerpt.content, 'utf8'),
      );
      const used =
        source.facts.counters.storedBytes +
        source.facts.counters.decodedBytes +
        retainedSourceReservation +
        byteAccounting.excerptBytes;
      input.budget.remainingBytes += Math.max(0, reservation - used - metadataReservation);
      acquired = source;
    }
  } else gaps.push('task-source-byte-or-read-reserve-unavailable');
  const normalizationStarted = yield* Clock.monotonicTimeNanos;
  let normalized = structuralNavigationInput({
    result,
    acquired: {...acquired, gaps: [...new Set([...acquired.gaps, ...gaps])]},
    scope: input.scope,
    target:
      anchored === undefined
        ? {kind: 'task'}
        : {kind: 'anchors', candidateIds: EffectArray.map(anchored.nodes, node => node.id)},
  });
  if (discovery !== undefined) {
    const focus = new Set(
      EffectArray.map(
        EffectArray.filter(discovery.evidence.candidates, candidate => candidate.origin === 'body'),
        candidate => candidate.id,
      ),
    );
    const candidates = EffectArray.map(normalized.input.candidates, candidate => {
      const caller = EffectArray.some(
        normalized.input.links,
        link => link.to !== link.from && link.from === candidate.id && focus.has(link.to) && link.relation === 'calls',
      );
      return caller &&
        !focus.has(candidate.id) &&
        !candidate.roles.includes('tests') &&
        !candidate.roles.includes('effects')
        ? {
            ...candidate,
            roles: ['entrypoint'] as const,
            reason: 'Structural caller of a task-localized candidate; execution and semantic binding remain unknown.',
          }
        : candidate;
    });
    normalized = {...normalized, input: {...normalized.input, candidates}};
  }
  const assemblyStarted = yield* Clock.monotonicTimeNanos;
  const structural = {...normalized, source: acquired.source, answer: assembleNavigationAnswer(normalized.input)};
  const projectionStarted = yield* Clock.monotonicTimeNanos;
  const projection = projectNavigationAnswer(structural, input.maximumEstimatedTokens ?? 1250);
  const completed = yield* Clock.monotonicTimeNanos;
  const milliseconds = (start: bigint, end: bigint) => Number(end - start) / 1e6;
  return {
    discovery,
    byteAccounting,
    acquired,
    structural,
    projection,
    /** Private evaluation observation; no raw graph/CLI/MCP wire field is added. */
    stageMilliseconds: {
      discovery: milliseconds(wholeStarted, discoveryEnded),
      source: milliseconds(discoveryEnded, normalizationStarted),
      normalization: milliseconds(normalizationStarted, assemblyStarted),
      assembly: milliseconds(assemblyStarted, projectionStarted),
      projection: milliseconds(projectionStarted, completed),
      pureCombined: milliseconds(normalizationStarted, completed),
      total: milliseconds(wholeStarted, completed),
    },
  };
});
