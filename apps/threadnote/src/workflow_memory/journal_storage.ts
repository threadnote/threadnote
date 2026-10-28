import {nativeWorkflowOperationLimit} from '@threadnote/workflow-automations/native';
import {stableJson, type WorkflowBinding, type WorkflowJournal} from './protocol.js';

const format = 'threadnote-workflow-journal-shared-values-v1';
// Cover every known slot of a full native run; the outer 64 MiB image bound remains independent.
const maximumScopeReferences = nativeWorkflowOperationLimit * 16;
const maximumTextReferences = nativeWorkflowOperationLimit * 19 + 2;
const packedBindings = new WeakSet<WorkflowBinding>();
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new Error('Invalid workflow journal storage table.');
const hasOwn = (value: Record<string, unknown>, key: string): boolean => Object.hasOwn(value, key);

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
    if (!Array.isArray(next.relations)) throw invalid();
    next = {
      ...next,
      relations: next.relations.map(target => {
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
export const markPackedWorkflowScopes = (binding: WorkflowBinding): void => {
  packedBindings.add(binding);
};

/** Lossless storage image. Exact scope sets and selected text values are shared after decoding. */
export function workflowJournalStorageImage(state: WorkflowJournal, compact: boolean): unknown {
  if (!compact) return state;
  return compactJournalImage(state);
}

function compactJournalImage(state: WorkflowJournal) {
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
  const operations = Object.fromEntries(
    Object.entries(state.operations)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, operation]) => {
        const packedText = replaceOperationText(operation as unknown as Record<string, unknown>, internText);
        const packedRelations = packedText.relations;
        if (!Array.isArray(packedRelations)) throw invalid();
        return [
          key,
          {
            ...packedText,
            relations: packedRelations.map(target => {
              if (!object(target)) throw invalid();
              if (target.allowedUriScopes === undefined) return target;
              if (
                !Array.isArray(target.allowedUriScopes) ||
                target.allowedUriScopes.length > 8192 ||
                target.allowedUriScopes.some(scope => typeof scope !== 'string') ||
                ++references > maximumScopeReferences
              )
                throw invalid();
              let index = identities.get(target.allowedUriScopes);
              if (index === undefined) {
                const identity = JSON.stringify(target.allowedUriScopes);
                index = indexes.get(identity);
                if (index === undefined) {
                  index = scopeSets.length;
                  if (index >= maximumScopeReferences) throw invalid();
                  indexes.set(identity, index);
                  scopeSets.push([...target.allowedUriScopes]);
                }
                identities.set(target.allowedUriScopes, index);
              }
              return {...target, allowedUriScopes: {scopeSet: index}};
            }),
          },
        ] as const;
      }),
  );
  const packedJournal = replaceJournalText({...state, operations}, internText);
  return {journalStorage: format, scopeSets, textValues, journal: packedJournal};
}

// Partition only a container frame; large child values keep the native canonical encoder.
function partitionFrame(
  value: Record<string, unknown>,
  slot: string,
  textValues: (value: unknown) => string = stableJson,
) {
  const ordered = Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
  const keys = Object.keys(ordered);
  const index = keys.indexOf(slot);
  if (index < 0) throw invalid();
  const entry = (key: string) =>
    `${JSON.stringify(key)}:${key === 'textValues' ? textValues(ordered[key]) : stableJson(ordered[key])}`;
  const before = keys.slice(0, index).map(entry);
  const after = keys.slice(index + 1).map(entry);
  return {
    prefix: `{${[...before, `${JSON.stringify(slot)}:`].join(',')}`,
    suffix: `${after.length ? ',' : ''}${after.join(',')}}`,
  };
}

// This closure retains only canonical fragments, not the packed object graph or both full strings.
function siblingContents(prefix: string, suffix: string) {
  return Object.freeze({
    prepared: () => `${prefix}false${suffix}`,
    committed: () => `${prefix}true${suffix}`,
  });
}

/** Pure formatting for one private, immutable native transition; no persistence or scope authority. */
export function workflowJournalStorageImagePair(
  prepared: WorkflowJournal,
  textValues: (value: unknown) => string = stableJson,
) {
  const image = compactJournalImage(prepared);
  const journal = partitionFrame(image.journal, 'manifestCommitted');
  const envelope = partitionFrame(image, 'journal', textValues);
  return siblingContents(envelope.prefix + journal.prefix, journal.suffix + envelope.suffix + '\n');
}

/** Ordinary journals are untouched; packed journals still undergo the full ownership validator. */
export function decodeWorkflowJournalStorageImage(value: unknown): unknown {
  if (!object(value) || value.journalStorage !== format) return value;
  if (
    Object.keys(value).sort().join(',') !== 'journal,journalStorage,scopeSets,textValues' ||
    !Array.isArray(value.scopeSets) ||
    !Array.isArray(value.textValues)
  )
    throw invalid();
  if (
    value.scopeSets.length > maximumScopeReferences ||
    value.textValues.length > maximumTextReferences ||
    value.textValues.some(text => typeof text !== 'string') ||
    !object(value.journal) ||
    !object(value.journal.operations)
  )
    throw invalid();
  const texts = value.textValues as string[];
  if (new Set(texts).size !== texts.length) throw invalid();
  let textReferences = 0;
  const usedTexts = new Set<number>();
  const expandText = (reference: unknown): string => {
    if (
      !object(reference) ||
      Object.keys(reference).join(',') !== 'text' ||
      !Number.isSafeInteger(reference.text) ||
      (reference.text as number) < 0 ||
      (reference.text as number) >= texts.length ||
      ++textReferences > maximumTextReferences
    )
      throw invalid();
    const index = reference.text as number;
    usedTexts.add(index);
    return texts[index];
  };
  const scopes = value.scopeSets.map(set => {
    if (!Array.isArray(set) || set.length > 8192 || set.some(scope => typeof scope !== 'string')) throw invalid();
    return set as string[];
  });
  const seen = new Set<string>();
  for (const set of scopes) {
    const key = JSON.stringify(set);
    if (seen.has(key)) throw invalid();
    seen.add(key);
  }
  let references = 0;
  const used = new Set<number>();
  const operations = Object.fromEntries(
    Object.entries(value.journal.operations).map(([key, operation]) => {
      if (!object(operation) || !Array.isArray(operation.relations)) throw invalid();
      return [
        key,
        {
          ...operation,
          relations: operation.relations.map(target => {
            if (!object(target)) throw invalid();
            if (target.allowedUriScopes === undefined) return target;
            const reference = target.allowedUriScopes;
            if (
              !object(reference) ||
              Object.keys(reference).join(',') !== 'scopeSet' ||
              !Number.isSafeInteger(reference.scopeSet) ||
              (reference.scopeSet as number) < 0 ||
              (reference.scopeSet as number) >= scopes.length ||
              ++references > maximumScopeReferences
            )
              throw invalid();
            const index = reference.scopeSet as number;
            used.add(index);
            return {...target, allowedUriScopes: scopes[index]};
          }),
        },
      ];
    }),
  );
  if (used.size !== scopes.length) throw invalid();
  const decodedOperations = Object.fromEntries(
    Object.entries(operations).map(([key, operation]) => {
      if (!object(operation)) throw invalid();
      return [key, replaceOperationText(operation, expandText)];
    }),
  );
  const journal = replaceJournalText({...value.journal, operations: decodedOperations}, expandText);
  if (usedTexts.size !== texts.length) throw invalid();
  if (!object(journal.binding)) throw invalid();
  markPackedWorkflowScopes(journal.binding as unknown as WorkflowBinding);
  return journal;
}
