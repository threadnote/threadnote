import {Array as EffectArray} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';

export const GRAPH_SHARE_ACTION_DOMAIN = 'threadnote-graph-action-v1';
export const GRAPH_SHARE_ACTION_KEY = /^[0-9a-f]{64}$/u;

export type GraphShareActionKey = string;

export interface GraphShareParseActionInput {
  readonly contentHash: string;
  readonly extractorSet: string;
  readonly languageAndRole: string;
  readonly normalizedPath: string;
  readonly repositoryId: string;
}

export interface GraphShareMaterializedActionInput {
  readonly contentHash: string;
  readonly graphAbi: string;
  readonly graphContentId: string;
  readonly normalizedPath: string;
  readonly parseResultDigest: string;
  readonly repositoryId: string;
  readonly workspaceFingerprint: string;
}

export function graphShareLanguageAndRole(language: string, role: string): string {
  return `${language}:${role}`;
}

export function graphShareParseActionKey(input: GraphShareParseActionInput): GraphShareActionKey {
  return domainSeparatedActionKey('parse', [
    input.repositoryId,
    input.extractorSet,
    input.normalizedPath,
    input.contentHash,
    input.languageAndRole,
  ]);
}

export function graphShareMaterializedActionKey(input: GraphShareMaterializedActionInput): GraphShareActionKey {
  return domainSeparatedActionKey('materialize', [
    input.repositoryId,
    input.graphAbi,
    input.graphContentId,
    input.workspaceFingerprint,
    input.normalizedPath,
    input.contentHash,
    input.parseResultDigest,
  ]);
}

function domainSeparatedActionKey(kind: 'materialize' | 'parse', parts: readonly string[]): GraphShareActionKey {
  return sha256HexSync(EffectArray.join([GRAPH_SHARE_ACTION_DOMAIN, kind, ...parts], '\0'));
}
