import {isSafeInteger as checkedIsSafeInteger} from '@threadnote/platform/validation';
import {Array as EffectArray} from 'effect';
import {nativeWorkflowOperationLimit} from '@threadnote/workflow-automations/native';
import type {WorkflowBinding, WorkflowJournal} from './protocol.js';
import * as EffectRecord from 'effect/Record';

const format = 'threadnote-workflow-journal-shared-values-v1';
// Cover every known slot of a full native run; the outer 64 MiB image bound remains independent.
const maximumScopeReferences = nativeWorkflowOperationLimit * 16;
const maximumTextReferences = nativeWorkflowOperationLimit * 19 + 2;
const packedBindings = new WeakSet<object>();
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !EffectArray.isArray(value);
const isStringArray = (value: unknown): value is readonly string[] =>
  EffectArray.isArray(value) && EffectArray.every(value, (item): item is string => typeof item === 'string');
const invalid = () => new Error('Invalid workflow journal storage table.');
const hasOwn = (value: Record<string, unknown>, key: string): boolean => EffectRecord.has(value, key);

const replaceSlot = (
  value: Record<string, unknown>,
  key: string,
  replace: (value: unknown) => unknown,
): Record<string, unknown> => {
  if (!hasOwn(value, key) || value[key] === undefined) return value;
  return {...value, [key]: replace(value[key])};
};

const replaceOperationText = (
  operation: Record<string, unknown>,
  replace: (value: unknown) => unknown,
): Record<string, unknown> => {
  let next = replaceSlot(operation, 'desired', replace);
  next = replaceSlot(next, 'before', replace);
  if (hasOwn(next, 'request') && next.request !== undefined) {
    if (!object(next.request)) throw invalid();
    next = {...next, request: replaceSlot(next.request, 'body', replace)};
  }
  if (hasOwn(next, 'relations') && next.relations !== undefined) {
    if (!EffectArray.isArray(next.relations)) throw invalid();
    next = {
      ...next,
      relations: EffectArray.map(next.relations, target => {
        if (!object(target)) throw invalid();
        return replaceSlot(target, 'content', replace);
      }),
    };
  }
  return next;
};

const replaceJournalText = (
  journal: Record<string, unknown>,
  replace: (value: unknown) => unknown,
): Record<string, unknown> => {
  let next = replaceSlot(journal, 'manifestContent', replace);
  next = replaceSlot(next, 'previousManifestContent', replace);
  return next;
};

export const hasPackedWorkflowScopes = (binding: WorkflowBinding): boolean => packedBindings.has(binding);
export const markPackedWorkflowScopes = (binding: object): void => {
  packedBindings.add(binding);
};

/** Lossless storage image. Exact scope sets and selected text values are shared after decoding. */
export function workflowJournalStorageImage(state: WorkflowJournal, compact: boolean): unknown {
  if (!compact) return state;
  const scopeSets: string[][] = [];
  const textValues: string[] = [];
  const textIndexes = new Map<string, number>();
  const indexes = new Map<string, number>();
  const identities = new WeakMap<readonly string[], number>();
  let references = 0;
  let textReferences = 0;
  const internText = (value: unknown): unknown => {
    if (typeof value !== 'string' || ++textReferences > maximumTextReferences) throw invalid();
    let index = textIndexes.get(value);
    if (index === undefined) {
      index = textValues.length;
      if (index >= maximumTextReferences) throw invalid();
      textIndexes.set(value, index);
      textValues.push(value);
    }
    return {text: index};
  };
  const operations = EffectRecord.fromEntries(
    EffectArray.map(
      EffectRecord.toEntries(state.operations).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
      ([key, operation]) => {
        const packedText = replaceOperationText({...operation}, internText);
        const packedRelations = packedText.relations;
        if (!EffectArray.isArray(packedRelations)) throw invalid();
        return [
          key,
          {
            ...packedText,
            relations: EffectArray.map(packedRelations, target => {
              if (!object(target)) throw invalid();
              const allowedUriScopes = target.allowedUriScopes;
              if (allowedUriScopes === undefined) return target;
              if (
                !isStringArray(allowedUriScopes) ||
                allowedUriScopes.length > 8192 ||
                ++references > maximumScopeReferences
              )
                throw invalid();
              let index = identities.get(allowedUriScopes);
              if (index === undefined) {
                const identity = JSON.stringify(allowedUriScopes);
                index = indexes.get(identity);
                if (index === undefined) {
                  index = scopeSets.length;
                  if (index >= maximumScopeReferences) throw invalid();
                  indexes.set(identity, index);
                  scopeSets.push([...allowedUriScopes]);
                }
                identities.set(allowedUriScopes, index);
              }
              return {...target, allowedUriScopes: {scopeSet: index}};
            }),
          },
        ] as const;
      },
    ),
  );
  const packedJournal = replaceJournalText({...state, operations}, internText);
  return {journalStorage: format, scopeSets, textValues, journal: packedJournal};
}

/** Ordinary journals are untouched; packed journals still undergo the full ownership validator. */
export function decodeWorkflowJournalStorageImage(value: unknown): unknown {
  if (!object(value) || value.journalStorage !== format) return value;
  if (
    EffectArray.join(EffectRecord.keys(value).sort(), ',') !== 'journal,journalStorage,scopeSets,textValues' ||
    !EffectArray.isArray(value.scopeSets) ||
    !isStringArray(value.textValues)
  )
    throw invalid();
  if (
    value.scopeSets.length > maximumScopeReferences ||
    value.textValues.length > maximumTextReferences ||
    EffectArray.some(value.textValues, text => typeof text !== 'string') ||
    !object(value.journal) ||
    !object(value.journal.operations)
  )
    throw invalid();
  const texts = value.textValues;
  if (new Set(texts).size !== texts.length) throw invalid();
  let textReferences = 0;
  const usedTexts = new Set<number>();
  const expandText = (reference: unknown): string => {
    if (
      !object(reference) ||
      EffectArray.join(EffectRecord.keys(reference), ',') !== 'text' ||
      !checkedIsSafeInteger(reference.text) ||
      reference.text < 0 ||
      reference.text >= texts.length ||
      ++textReferences > maximumTextReferences
    )
      throw invalid();
    const index = reference.text;
    usedTexts.add(index);
    return texts[index];
  };
  const scopes = EffectArray.map(value.scopeSets, set => {
    if (!isStringArray(set) || set.length > 8192) throw invalid();
    return [...set];
  });
  const seen = new Set<string>();
  for (const set of scopes) {
    const key = JSON.stringify(set);
    if (seen.has(key)) throw invalid();
    seen.add(key);
  }
  let references = 0;
  const used = new Set<number>();
  const operations = EffectRecord.fromEntries(
    EffectArray.map(EffectRecord.toEntries(value.journal.operations), ([key, operation]) => {
      if (!object(operation) || !EffectArray.isArray(operation.relations)) throw invalid();
      return [
        key,
        {
          ...operation,
          relations: EffectArray.map(operation.relations, target => {
            if (!object(target)) throw invalid();
            if (target.allowedUriScopes === undefined) return target;
            const reference = target.allowedUriScopes;
            if (
              !object(reference) ||
              EffectArray.join(EffectRecord.keys(reference), ',') !== 'scopeSet' ||
              !checkedIsSafeInteger(reference.scopeSet) ||
              reference.scopeSet < 0 ||
              reference.scopeSet >= scopes.length ||
              ++references > maximumScopeReferences
            )
              throw invalid();
            const index = reference.scopeSet;
            used.add(index);
            return {...target, allowedUriScopes: scopes[index]};
          }),
        },
      ];
    }),
  );
  if (used.size !== scopes.length) throw invalid();
  const decodedOperations = EffectRecord.fromEntries(
    EffectArray.map(EffectRecord.toEntries(operations), ([key, operation]) => {
      if (!object(operation)) throw invalid();
      return [key, replaceOperationText(operation, expandText)];
    }),
  );
  const journal = replaceJournalText({...value.journal, operations: decodedOperations}, expandText);
  if (usedTexts.size !== texts.length) throw invalid();
  if (!object(journal.binding)) throw invalid();
  markPackedWorkflowScopes(journal.binding);
  return journal;
}
