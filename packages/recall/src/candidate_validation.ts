import {externalResourceUri, isExternalResourceMetadata} from '@threadnote/store/external-resource';
import type {RecallCandidate} from './rank.js';

/** Runtime guard for candidate JSON loaded from the rebuildable SQLite index. */
export function recallCandidateIsValid(value: unknown): value is RecallCandidate {
  if (!isPlainRecord(value) || typeof value.uri !== 'string' || typeof value.text !== 'string') return false;
  const stringValues = [
    'authority',
    'contentHash',
    'kind',
    'memoryId',
    'status',
    'timestamp',
    'trust',
    'validFrom',
    'validTo',
  ] as const;
  if (stringValues.some(key => value[key] !== undefined && typeof value[key] !== 'string')) return false;
  const numberValues = ['feedback', 'reranker', 'semantic'] as const;
  if (numberValues.some(key => value[key] !== undefined && !isFiniteNumber(value[key]))) return false;
  if (value.identityConflict !== undefined && typeof value.identityConflict !== 'boolean') return false;
  if (value.exactTerms !== undefined && !isStringArray(value.exactTerms)) return false;
  if (value.equivalentUris !== undefined && !isStringArray(value.equivalentUris)) return false;
  if (
    value.externalSource !== undefined &&
    (!isPlainRecord(value.externalSource) ||
      !isExternalResourceMetadata(value.externalSource) ||
      !isFiniteNumber(value.externalSource.fetchedAt) ||
      value.externalSource.fetchedAt < 0 ||
      externalResourceUri(value.externalSource) !== value.uri.split('#', 1)[0])
  )
    return false;
  if (value.fields !== undefined) {
    if (!isPlainRecord(value.fields)) return false;
    const fields = value.fields;
    if (
      !['project', 'title', 'topic', 'workspaceScope'].every(
        key => fields[key] === undefined || typeof fields[key] === 'string',
      ) ||
      !['identifiers', 'keywords'].every(key => fields[key] === undefined || isStringArray(fields[key]))
    ) {
      return false;
    }
  }
  return (
    value.relations === undefined ||
    (Array.isArray(value.relations) &&
      value.relations.every(
        relation => isPlainRecord(relation) && typeof relation.type === 'string' && typeof relation.uri === 'string',
      ))
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string');
}
