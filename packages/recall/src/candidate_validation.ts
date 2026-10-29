import {Array as EffectArray} from 'effect';
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
  if (EffectArray.some(stringValues, key => value[key] !== undefined && typeof value[key] !== 'string')) return false;
  const numberValues = ['feedback', 'reranker', 'semantic'] as const;
  if (EffectArray.some(numberValues, key => value[key] !== undefined && !isFiniteNumber(value[key]))) return false;
  if (value.identityConflict !== undefined && typeof value.identityConflict !== 'boolean') return false;
  if (value.exactTerms !== undefined && !isStringArray(value.exactTerms)) return false;
  if (value.equivalentUris !== undefined && !isStringArray(value.equivalentUris)) return false;
  if (
    value.externalSource !== undefined &&
    (!isPlainRecord(value.externalSource) ||
      !isExternalResourceMetadata(value.externalSource) ||
      !isFiniteNumber(value.externalSource.fetchedAt) ||
      value.externalSource.fetchedAt < 0 ||
      // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
      externalResourceUri(value.externalSource) !== value.uri.split('#', 1)[0])
  )
    return false;
  if (value.fields !== undefined) {
    if (!isPlainRecord(value.fields)) return false;
    const fields = value.fields;
    if (
      !EffectArray.every(
        ['project', 'title', 'topic', 'workspaceScope'],
        key => fields[key] === undefined || typeof fields[key] === 'string',
      ) ||
      !EffectArray.every(['identifiers', 'keywords'], key => fields[key] === undefined || isStringArray(fields[key]))
    ) {
      return false;
    }
  }
  return (
    value.relations === undefined ||
    (EffectArray.isArray(value.relations) &&
      EffectArray.every(
        value.relations,
        relation => isPlainRecord(relation) && typeof relation.type === 'string' && typeof relation.uri === 'string',
      ))
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return EffectArray.isArray(value) && EffectArray.every(value, entry => typeof entry === 'string');
}
