import type {Path} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {GraphShareActionKey} from './action.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const GRAPH_SHARE_CAS_CANONICAL = 'cas://local';
export const GRAPH_SHARE_CAS_WORKER = 'cas://local/worker';

export function graphShareFrontierDiscoveryTag(repositoryId: string, branchRef: string): string {
  return `tn-frontier-${Effect.pipe(sha256HexSync(`${repositoryId}${branchRef}`), EffectString.slice(0, 40))}`;
}

export function graphShareActionDiscoveryTag(actionKey: GraphShareActionKey): string {
  return `tn-action-${actionKey}`;
}

export function graphShareWorkDiscoveryTag(batchId: string): string {
  return `tn-work-${Effect.pipe(batchId, EffectString.slice(0, 40))}`;
}

export function graphShareWorkerCasRoot(path: Path.Path, casRoot: string): string {
  return path.join(casRoot, 'worker');
}

export function graphShareCanonicalCasRoot(path: Path.Path, casRoot: string): string {
  return casRoot;
}

export function isGraphShareWorkerRegistry(value: string): boolean {
  return value === GRAPH_SHARE_CAS_WORKER || Effect.pipe(value, EffectString.endsWith('/worker'));
}

export function isGraphShareCanonicalRegistry(value: string): boolean {
  return value === GRAPH_SHARE_CAS_CANONICAL || Effect.pipe(value, EffectString.endsWith('/canonical'));
}
