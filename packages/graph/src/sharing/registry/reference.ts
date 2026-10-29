import {graphSharingFailure} from '../errors.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const COMPONENT = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
export const GRAPH_SHARE_OCI_REGISTRY = new RegExp(
  `^oci://(${HOST_LABEL}(?:\\.${HOST_LABEL})*)(?::([1-9][0-9]{0,4}))?/(${COMPONENT}(?:/${COMPONENT})*)$`,
  'u',
);

export interface GraphShareRegistryTarget {
  readonly origin: string;
  readonly registry: string;
  readonly repository: string;
  readonly pullScope: string;
}

export function parseGraphShareRegistryTarget(value: string): GraphShareRegistryTarget {
  const match = GRAPH_SHARE_OCI_REGISTRY.exec(value);
  if (
    match === null ||
    value.length > 512 ||
    match[1].length > 253 ||
    match[3].length > 255 ||
    (match[2] !== undefined && Number(match[2]) > 65_535)
  )
    throw graphSharingFailure('OCI registry reference is invalid.');
  let url: URL;
  try {
    url = new URL(`https://${match[1]}${match[2] === undefined ? '' : `:${match[2]}`}`);
  } catch {
    throw graphSharingFailure('OCI registry reference is invalid.');
  }
  if (url.hostname !== match[1]) throw graphSharingFailure('OCI registry host must be canonical.');
  const origin = url.origin;
  const repository = match[3];
  return {
    origin,
    registry: Effect.pipe(origin, EffectString.slice('https://'.length)),
    repository,
    pullScope: `repository:${repository}:pull`,
  };
}

export function isGraphShareRegistryReference(value: string): boolean {
  try {
    parseGraphShareRegistryTarget(value);
    return true;
  } catch {
    return false;
  }
}
