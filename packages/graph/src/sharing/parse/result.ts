import {Array as EffectArray} from 'effect';
import {canonicalJson} from '../../checkpoint/canonical_json.js';
import {parseCodeGraphFileFacts} from '../../fact/validation.js';
import type {CodeGraphFileFacts} from '../../types.js';
import {GRAPH_SHARE_ACTION_KEY, type GraphShareActionKey} from '../action.js';
import {parseSha256Digest, SHA256_DIGEST, SHA256_HEX, sha256Digest, type Sha256Digest} from '../digest.js';
import {graphSharingFailure} from '../errors.js';
import {GRAPH_SHARE_GIT_OBJECT_ID} from '../git.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const GRAPH_SHARE_PARSE_RESULT_SCHEMA_VERSION = 1 as const;

export interface GraphShareParseResultV1 {
  readonly actionKey: GraphShareActionKey;
  readonly contentHash: string;
  readonly extractorSet: string;
  readonly facts: CodeGraphFileFacts;
  readonly gitBlobId: string;
  readonly languageAndRole: string;
  readonly normalizedPath: string;
  readonly repositoryId: string;
  readonly schemaVersion: typeof GRAPH_SHARE_PARSE_RESULT_SCHEMA_VERSION;
  readonly semanticDigest: Sha256Digest;
}

export function graphShareParseResultSemanticDigest(facts: CodeGraphFileFacts): Sha256Digest {
  return sha256Digest(canonicalJson(facts));
}

export function parseGraphShareParseResult(value: unknown): GraphShareParseResultV1 {
  if (!isRecord(value) || value.schemaVersion !== GRAPH_SHARE_PARSE_RESULT_SCHEMA_VERSION) {
    throw graphSharingFailure('Parse-result artifact is invalid.');
  }
  const facts = parseCodeGraphFileFacts(value.facts);
  const result: GraphShareParseResultV1 = {
    actionKey: requiredActionKey(value.actionKey),
    contentHash: requiredHex(value.contentHash, 'contentHash'),
    extractorSet: requiredHex(value.extractorSet, 'extractorSet'),
    facts,
    gitBlobId: requiredGitObjectId(value.gitBlobId),
    languageAndRole: requiredText(value.languageAndRole, 'languageAndRole'),
    normalizedPath: requiredText(value.normalizedPath, 'normalizedPath'),
    repositoryId: requiredHex(value.repositoryId, 'repositoryId'),
    schemaVersion: GRAPH_SHARE_PARSE_RESULT_SCHEMA_VERSION,
    semanticDigest: parseDigest(value.semanticDigest, 'semanticDigest'),
  };
  if (JSON.stringify(EffectRecord.keys(value).sort()) !== JSON.stringify(EffectRecord.keys(result).sort())) {
    throw graphSharingFailure('Parse-result artifact contains unsupported fields.');
  }
  if (result.facts.path !== result.normalizedPath) {
    throw graphSharingFailure('Parse-result path does not match the fact path.');
  }
  if (result.semanticDigest !== graphShareParseResultSemanticDigest(facts)) {
    throw graphSharingFailure('Parse-result semantic digest does not match the facts.');
  }
  return result;
}

export function graphShareParseResultArtifact(input: {
  readonly actionKey: GraphShareActionKey;
  readonly contentHash: string;
  readonly extractorSet: string;
  readonly facts: CodeGraphFileFacts;
  readonly gitBlobId: string;
  readonly languageAndRole: string;
  readonly normalizedPath: string;
  readonly repositoryId: string;
}): GraphShareParseResultV1 {
  return parseGraphShareParseResult({
    ...input,
    schemaVersion: GRAPH_SHARE_PARSE_RESULT_SCHEMA_VERSION,
    semanticDigest: graphShareParseResultSemanticDigest(input.facts),
  });
}

function requiredActionKey(value: unknown): GraphShareActionKey {
  if (typeof value !== 'string' || !GRAPH_SHARE_ACTION_KEY.test(value)) {
    throw graphSharingFailure('Parse-result action key is invalid.');
  }
  return value;
}

function requiredGitObjectId(value: unknown): string {
  if (typeof value !== 'string' || !GRAPH_SHARE_GIT_OBJECT_ID.test(value)) {
    throw graphSharingFailure('Parse-result git blob id is invalid.');
  }
  return value;
}

function requiredHex(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
    throw graphSharingFailure(`Parse-result ${label} is invalid.`);
  }
  return value;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || Effect.pipe(value, EffectString.trim).length === 0 || value.length > 4_096) {
    throw graphSharingFailure(`Parse-result ${label} is invalid.`);
  }
  return value;
}

function parseDigest(value: unknown, label: string): Sha256Digest {
  if (typeof value !== 'string' || !SHA256_DIGEST.test(value)) {
    throw graphSharingFailure(`Parse-result ${label} is invalid.`);
  }
  return parseSha256Digest(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}
