import {Array as EffectArray} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {Sha256Digest} from './digest.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export type GraphShareFrontierPhase =
  'assembling' | 'collecting' | 'failed' | 'frozen' | 'idle' | 'published' | 'verifying';

export interface GraphShareFrontierThresholds {
  readonly maximumAgeSeconds: number;
  readonly maximumChangedBytes: number;
  readonly maximumChangedFiles: number;
}

export interface GraphShareFrontierMachineV1 {
  readonly buildingFrontier: string | null;
  readonly collectingStartedAtSeconds: number | null;
  readonly frozenActionKeys: readonly string[];
  readonly frozenBatchId: string | null;
  readonly generation: number;
  readonly observedHead: string | null;
  readonly pendingRange: readonly string[];
  readonly phase: GraphShareFrontierPhase;
  readonly previousManifestDigest: Sha256Digest | null;
  readonly publishedFrontier: string | null;
}

export function idleGraphShareFrontier(): GraphShareFrontierMachineV1 {
  return {
    buildingFrontier: null,
    collectingStartedAtSeconds: null,
    frozenActionKeys: [],
    frozenBatchId: null,
    generation: 0,
    observedHead: null,
    pendingRange: [],
    phase: 'idle',
    previousManifestDigest: null,
    publishedFrontier: null,
  };
}

export function observeCanonicalHead(
  state: GraphShareFrontierMachineV1,
  input: {readonly commit: string; readonly isDescendantOfPublished: boolean; readonly nowSeconds: number},
): GraphShareFrontierMachineV1 {
  if (!input.isDescendantOfPublished && state.publishedFrontier !== null && input.commit !== state.publishedFrontier) {
    return {
      ...idleGraphShareFrontier(),
      observedHead: input.commit,
      pendingRange: [],
      phase: 'published',
      generation: state.generation,
      previousManifestDigest: state.previousManifestDigest,
      publishedFrontier: state.publishedFrontier,
    };
  }
  if (state.phase === 'failed') {
    if (input.commit === state.publishedFrontier) {
      return {
        ...state,
        collectingStartedAtSeconds:
          state.pendingRange.length > 0 ? (state.collectingStartedAtSeconds ?? input.nowSeconds) : null,
        observedHead: input.commit,
        phase: state.pendingRange.length > 0 ? 'collecting' : 'published',
      };
    }
    const pendingRange = state.pendingRange.includes(input.commit)
      ? state.pendingRange
      : [...state.pendingRange, input.commit];
    return {
      ...state,
      collectingStartedAtSeconds: state.collectingStartedAtSeconds ?? input.nowSeconds,
      observedHead: input.commit,
      pendingRange,
      phase: 'collecting',
    };
  }
  if (state.phase === 'frozen' || state.phase === 'assembling' || state.phase === 'verifying') {
    if (input.commit === state.observedHead || state.pendingRange.includes(input.commit)) return state;
    return {...state, observedHead: input.commit, pendingRange: [...state.pendingRange, input.commit]};
  }
  if (input.commit === state.publishedFrontier || input.commit === state.observedHead) {
    return {...state, observedHead: input.commit};
  }
  const pendingRange =
    state.phase === 'collecting'
      ? state.pendingRange.includes(input.commit)
        ? state.pendingRange
        : [...state.pendingRange, input.commit]
      : [input.commit];
  return {
    ...state,
    collectingStartedAtSeconds: state.collectingStartedAtSeconds ?? input.nowSeconds,
    observedHead: input.commit,
    pendingRange,
    phase: 'collecting',
  };
}

export function freezeGraphShareBatch(
  state: GraphShareFrontierMachineV1,
  input: {
    readonly actionKeys: readonly string[];
    readonly changedBytes: number;
    readonly changedFiles: number;
    readonly nowSeconds: number;
    readonly thresholds: GraphShareFrontierThresholds;
  },
): GraphShareFrontierMachineV1 {
  if (state.phase !== 'collecting' || state.observedHead === null || state.collectingStartedAtSeconds === null) {
    return state;
  }
  const aged = input.nowSeconds - state.collectingStartedAtSeconds >= input.thresholds.maximumAgeSeconds;
  const enoughFiles = input.changedFiles >= input.thresholds.maximumChangedFiles;
  const enoughBytes = input.changedBytes >= input.thresholds.maximumChangedBytes;
  if (!aged && !enoughFiles && !enoughBytes) return state;
  const frozenRange = state.pendingRange;
  return {
    ...state,
    buildingFrontier: state.observedHead,
    frozenActionKeys: [...input.actionKeys],
    frozenBatchId: graphShareBatchId(state.observedHead, frozenRange),
    pendingRange: [],
    phase: 'frozen',
  };
}

export function assembleGraphShareBatch(state: GraphShareFrontierMachineV1): GraphShareFrontierMachineV1 {
  if (state.phase !== 'frozen') return state;
  return {...state, phase: 'assembling'};
}

export function verifyGraphShareBatch(state: GraphShareFrontierMachineV1): GraphShareFrontierMachineV1 {
  if (state.phase !== 'assembling') return state;
  return {...state, phase: 'verifying'};
}

export function publishGraphShareBatch(
  state: GraphShareFrontierMachineV1,
  manifestDigest: Sha256Digest,
): GraphShareFrontierMachineV1 {
  if (state.phase !== 'verifying' && state.phase !== 'frozen' && state.phase !== 'assembling') return state;
  const published = state.buildingFrontier ?? state.observedHead;
  return {
    ...state,
    buildingFrontier: null,
    collectingStartedAtSeconds: null,
    frozenActionKeys: [],
    frozenBatchId: null,
    generation: state.generation + 1,
    pendingRange: state.pendingRange,
    phase: state.pendingRange.length > 0 ? 'collecting' : 'published',
    previousManifestDigest: manifestDigest,
    publishedFrontier: published,
  };
}

export function adoptPublishedFrontier(
  state: GraphShareFrontierMachineV1,
  input: {
    readonly generation: number;
    readonly manifestDigest: Sha256Digest;
    readonly sourceCommit: string;
  },
): GraphShareFrontierMachineV1 {
  return {
    ...state,
    buildingFrontier: null,
    collectingStartedAtSeconds: null,
    frozenActionKeys: [],
    frozenBatchId: null,
    generation: input.generation,
    observedHead: input.sourceCommit,
    pendingRange: [],
    phase: 'published',
    previousManifestDigest: input.manifestDigest,
    publishedFrontier: input.sourceCommit,
  };
}

export function failGraphShareBatch(state: GraphShareFrontierMachineV1): GraphShareFrontierMachineV1 {
  if (state.phase !== 'frozen' && state.phase !== 'assembling' && state.phase !== 'verifying') return state;
  return {
    ...state,
    buildingFrontier: null,
    frozenActionKeys: [],
    frozenBatchId: null,
    phase: 'failed',
  };
}

export function lateResultAdmitted(state: GraphShareFrontierMachineV1, batchId: string): boolean {
  return (
    (state.phase === 'frozen' || state.phase === 'assembling' || state.phase === 'verifying') &&
    state.frozenBatchId === batchId
  );
}

export function graphShareBatchId(head: string, range: readonly string[]): string {
  return Effect.pipe(
    sha256HexSync(EffectArray.join(['threadnote-graph-batch-v1', head, ...range], '\0')),
    EffectString.slice(0, 40),
  );
}
