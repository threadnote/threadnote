import {Effect} from 'effect';
import type {CodeGraphDirectPersistentCapacityBoundary} from '../disk/capacity.js';
import type {CodeGraphQueryResult, CodeGraphStatus, RepositoryIdentity} from '../types.js';
import {worktreeOverlayState} from '../inventory.js';
import type {CodeGraphQueryScope} from './scope.js';

export function sameCodeGraphRepositoryIdentity(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
  return (
    left.repoRoot === right.repoRoot &&
    left.gitCommonDirectory === right.gitCommonDirectory &&
    left.checkoutId === right.checkoutId &&
    left.worktreeId === right.worktreeId &&
    left.repositoryId === right.repositoryId &&
    left.headCommit === right.headCommit &&
    left.objectFormat === right.objectFormat
  );
}

export function codeGraphSnapshotMatchesWorktree(
  snapshot: {readonly commit: string; readonly dirty: boolean; readonly overlayFingerprint?: string},
  headCommit: string,
  overlay: {readonly dirty: boolean; readonly fingerprint?: string},
): boolean {
  return (
    snapshot.commit === headCommit &&
    snapshot.dirty === overlay.dirty &&
    (!overlay.dirty || snapshot.overlayFingerprint === overlay.fingerprint)
  );
}

export type CodeGraphStaleInspectionOperation = CodeGraphQueryResult['operation'];

export function codeGraphInspectionAllowsStaleReady(operation: CodeGraphStaleInspectionOperation): boolean {
  return operation !== 'impact' && operation !== 'path';
}

export function codeGraphInspectionObservesWorktree(operation: CodeGraphStaleInspectionOperation): boolean {
  return !codeGraphInspectionAllowsStaleReady(operation);
}

export function codeGraphInspectionStartsRefresh(
  status: {readonly readySnapshot?: unknown; readonly stale: boolean},
  operation: CodeGraphStaleInspectionOperation,
): boolean {
  return !codeGraphInspectionAllowsStaleReady(operation) && (!status.readySnapshot || status.stale);
}

export function codeGraphInspectionNeedsReadyAttachment(status: {
  readonly readySnapshot?: unknown;
  readonly stale: boolean;
}): boolean {
  return status.readySnapshot === undefined || status.stale;
}

export function codeGraphInspectionObservation(
  observation: CodeGraphStatusObservation | undefined,
  operation: CodeGraphStaleInspectionOperation,
): CodeGraphStatusObservation | undefined {
  if (observation === undefined || codeGraphInspectionObservesWorktree(operation)) return observation;
  return {
    identity: observation.identity,
    ...(observation.borrowedSnapshotId === undefined ? {} : {borrowedSnapshotId: observation.borrowedSnapshotId}),
    ...(observation.manifestPath === undefined ? {} : {manifestPath: observation.manifestPath}),
    ...(observation.projectScope === undefined ? {} : {projectScope: observation.projectScope}),
    ...(observation.readySnapshotId === undefined ? {} : {readySnapshotId: observation.readySnapshotId}),
  };
}

export interface CodeGraphStatusOptions {
  readonly project?: string;
  readonly manifestPath?: string;
  /** @internal Run after the owned identity resolution and before reading graph status. */
  readonly afterIdentityObserved?: (
    identity: RepositoryIdentity,
    project?: CodeGraphQueryScope['project'],
  ) => Effect.Effect<void, unknown>;
  readonly observeWorktree?: boolean;
  /** @internal Evidence harnesses can isolate status work from the detached maintenance lane. */
  readonly requestMaintenance?: boolean;
  /** @internal Closed anonymous query-stage observer supplied only by reviewed request surfaces. */
  readonly telemetry?: CodeGraphQueryTelemetryObserver;
  /** @internal Reattribute observation owned by snapshot resolution rather than the initial status phase. */
  readonly telemetryPhase?: CodeGraphQueryTelemetryPhase;
  /** @internal Mark a repeated observation that was required only because prior evidence was incomplete. */
  readonly telemetryWorktreeDisposition?: Exclude<CodeGraphQueryTelemetryStageDisposition, 'skipped'>;
}

export type CodeGraphQueryTelemetryPhase = 'graph.query.execute' | 'graph.query.snapshot' | 'graph.query.status';

export type CodeGraphQueryTelemetryStage =
  'query-repository-identity' | 'query-serialization' | 'query-strict-reobservation' | 'query-worktree-observation';

export type CodeGraphQueryTelemetryStageDisposition = 'fallback' | 'skipped';

export interface CodeGraphQueryTelemetryObservation {
  readonly disposition?: CodeGraphQueryTelemetryStageDisposition;
  readonly durationMilliseconds: number;
  readonly outcome: 'failure' | 'interrupted' | 'success';
  readonly phase: CodeGraphQueryTelemetryPhase;
  readonly stage: CodeGraphQueryTelemetryStage;
}

/** Closed internal stage boundary that cannot accept repository-derived labels or text. */
export interface CodeGraphQueryTelemetryObserver {
  readonly skip: (phase: CodeGraphQueryTelemetryPhase, stage: CodeGraphQueryTelemetryStage) => Effect.Effect<void>;
  readonly stage: <A, E, R>(
    phase: CodeGraphQueryTelemetryPhase,
    stage: CodeGraphQueryTelemetryStage,
    effect: Effect.Effect<A, E, R>,
    disposition?: Exclude<CodeGraphQueryTelemetryStageDisposition, 'skipped'>,
  ) => Effect.Effect<A, E, R>;
}

export interface CodeGraphQueryInterlock {
  readonly afterObservation?: () => Effect.Effect<void>;
  /** @internal Deterministic barrier used to exercise concurrent ready-snapshot acquisition. */
  readonly afterSnapshotSelected?: () => Effect.Effect<void>;
  /** @internal Deterministic barrier used to verify that leases cover the complete read session. */
  readonly beforeReadCompletion?: () => Effect.Effect<void>;
}

export const observeCodeGraphQueryWorktree = Effect.fn('codeGraph.observeWorktree')(function* (
  identity: RepositoryIdentity,
  interlock: CodeGraphQueryInterlock | undefined,
) {
  const observation = yield* worktreeOverlayState(identity);
  yield* interlock?.afterObservation?.() ?? Effect.void;
  return observation;
});

export interface CodeGraphTraversalTimeBudgets {
  readonly semanticMilliseconds?: number;
  readonly traversalMilliseconds?: number;
}

export interface CodeGraphStatusObservation {
  readonly manifestPath?: string;
  readonly projectScope?: CodeGraphQueryScope;
  /** Read-only shared evidence selected without changing this worktree's active pointer. */
  readonly borrowedSnapshotId?: string;
  /** Exact ready snapshot selected by the parent status pass. */
  readonly readySnapshotId?: string;
  readonly identity: RepositoryIdentity;
  /** Present only when status performed an exact worktree observation. */
  readonly overlay?: {readonly dirty: boolean; readonly fingerprint?: string};
}

export interface CodeGraphSharedReadyAttachInterlock {
  /** Allow local ordinary reads to borrow stale evidence without promoting it. */
  readonly allowBorrowedStale?: boolean;
  /** @internal Deterministic barrier after the optimistic candidate read and before target-lock acquisition. */
  readonly afterOptimisticCandidate?: () => Effect.Effect<void>;
  /** @internal Deterministic barrier after promotion and before final identity validation. */
  readonly afterPromotion?: () => Effect.Effect<void>;
  /** @internal Deterministic observer before each full identity resolution owned by shared attachment. */
  readonly beforeIdentityResolution?: () => Effect.Effect<void>;
  /** @internal Deterministic fresh-capacity probe used by promotion fault tests. */
  readonly diskCapacityAvailableBytes?: (
    path: string,
    boundary: CodeGraphDirectPersistentCapacityBoundary,
  ) => Effect.Effect<number | undefined, unknown>;
  /** @internal Evidence harnesses can isolate shared-ready attachment from detached maintenance. */
  readonly requestMaintenance?: boolean;
  /** @internal Closed anonymous query-stage observer supplied only by reviewed request surfaces. */
  readonly telemetry?: CodeGraphQueryTelemetryObserver;
}

const CODE_GRAPH_STATUS_OBSERVATION = Symbol('threadnote/codeGraph/statusObservation');

type ObservedCodeGraphStatus = CodeGraphStatus & {
  readonly [CODE_GRAPH_STATUS_OBSERVATION]?: CodeGraphStatusObservation;
};

export function withCodeGraphQueryTelemetryStage<A, E, R>(
  telemetry: CodeGraphQueryTelemetryObserver | undefined,
  phase: CodeGraphQueryTelemetryPhase,
  stage: CodeGraphQueryTelemetryStage,
  effect: Effect.Effect<A, E, R>,
  disposition?: Exclude<CodeGraphQueryTelemetryStageDisposition, 'skipped'>,
): Effect.Effect<A, E, R> {
  return telemetry?.stage(phase, stage, effect, disposition) ?? effect;
}

export function skipCodeGraphQueryTelemetryStage(
  telemetry: CodeGraphQueryTelemetryObserver | undefined,
  phase: CodeGraphQueryTelemetryPhase,
  stage: CodeGraphQueryTelemetryStage,
): Effect.Effect<void> {
  return telemetry?.skip(phase, stage) ?? Effect.void;
}

/** Retrieve pre-read identity and optional exact overlay evidence without exposing it in command or MCP output. */
export function observationFromCodeGraphStatus(status: CodeGraphStatus): CodeGraphStatusObservation | undefined {
  return (status as ObservedCodeGraphStatus)[CODE_GRAPH_STATUS_OBSERVATION];
}

export function attachCodeGraphStatusObservation(
  status: CodeGraphStatus,
  observation: CodeGraphStatusObservation | undefined,
): CodeGraphStatus {
  if (observation === undefined) return status;
  const {readySnapshotId: _readySnapshotId, ...baseObservation} = observation;
  const selectedObservation =
    status.readySnapshot === undefined
      ? baseObservation
      : {...baseObservation, readySnapshotId: status.readySnapshot.id};
  Object.defineProperty(status, CODE_GRAPH_STATUS_OBSERVATION, {
    configurable: false,
    enumerable: false,
    value: selectedObservation,
    writable: false,
  });
  return status;
}

/** Decide whether one clean shared snapshot can be promoted without inventory or rematerialization. */
export function shouldAttachSharedReadySnapshot(input: {
  readonly candidate?: {readonly commit: string; readonly dirty: boolean; readonly id: string};
  readonly overlayDirty: boolean;
  readonly readySnapshot?: {readonly commit: string; readonly id: string};
  readonly headCommit: string;
}): boolean {
  if (input.overlayDirty) return false;
  return (
    input.candidate !== undefined &&
    input.candidate.dirty === false &&
    input.candidate.commit === input.headCommit &&
    input.candidate.id !== input.readySnapshot?.id
  );
}
