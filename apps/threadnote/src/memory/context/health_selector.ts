import {Array as EffectArray} from 'effect';
import type {MemoryKind} from '@threadnote/memory/types';
import type {MemoryRecord} from '@threadnote/memory/document';
import type {ContextHealthFindingCategoryV1} from '@threadnote/context/health';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const CONTEXT_HEALTH_SELECTOR_MAXIMUM_BYTES = 256 as const;
const FORBIDDEN_SELECTOR_CHARACTERS = /[\p{Cc}\u2028\u2029]/u;
export const CONTEXT_HEALTH_MEMORY_KINDS = [
  'durable',
  'handoff',
  'incident',
  'preference',
  'smoke',
] as const satisfies readonly MemoryKind[];
export const CONTEXT_HEALTH_FINDING_CATEGORIES = [
  'candidate-contradiction',
  'candidate-possible-duplicate',
  'citation-changed',
  'citation-missing',
  'citation-unknown',
  'exact-duplicate',
  'guidance-locally-modified',
  'guidance-missing-block',
  'guidance-stale-sources',
  'guidance-unavailable',
  'relation-target-conflicted',
  'relation-target-inactive',
  'relation-target-missing',
  'review-overdue',
  'semantic-contradiction',
  'validity-expired',
] as const satisfies readonly ContextHealthFindingCategoryV1[];

export interface ContextHealthSelectorInputV1 {
  readonly after?: string;
  readonly findingCategory?: string;
  readonly kind?: string;
  readonly topic?: string;
}

function isContextHealthFindingCategory(value: string): value is ContextHealthFindingCategoryV1 {
  return EffectArray.some(CONTEXT_HEALTH_FINDING_CATEGORIES, category => category === value);
}

function isContextHealthMemoryKind(value: string): value is MemoryKind {
  return EffectArray.some(CONTEXT_HEALTH_MEMORY_KINDS, kind => kind === value);
}

/** Canonical exact selector. Every supplied field intersects with the others. */
export interface ContextHealthSelectorV1 {
  readonly after?: string;
  readonly findingCategory?: ContextHealthFindingCategoryV1;
  readonly kind?: MemoryKind;
  readonly topic?: string;
}

export function normalizeContextHealthSelector(
  input: ContextHealthSelectorInputV1,
): ContextHealthSelectorV1 | undefined {
  const after = optionalContextHealthCursor(input.after, '--after');
  const findingCategory = optionalSelectorText(input.findingCategory, '--finding-category');
  const kind = optionalSelectorText(input.kind, '--kind');
  const topic = optionalSelectorText(input.topic, '--topic');
  if (findingCategory !== undefined && !isContextHealthFindingCategory(findingCategory)) {
    throw new Error(`Unknown --finding-category: ${findingCategory}.`);
  }
  if (kind !== undefined && !isContextHealthMemoryKind(kind)) {
    throw new Error(`Unknown --kind: ${kind}.`);
  }
  if (after === undefined && findingCategory === undefined && kind === undefined && topic === undefined)
    return undefined;
  return {
    ...(after === undefined ? {} : {after}),
    ...(findingCategory === undefined ? {} : {findingCategory}),
    ...(kind === undefined ? {} : {kind}),
    ...(topic === undefined ? {} : {topic}),
  };
}

export function projectContextHealthRecords(
  records: readonly MemoryRecord[],
  selector: ContextHealthSelectorV1 | undefined,
): readonly MemoryRecord[] {
  if (!contextHealthSelectorHasRecordScope(selector)) return records;
  return EffectArray.filter(
    records,
    record =>
      (selector.kind === undefined || record.metadata.kind === selector.kind) &&
      (selector.topic === undefined || record.metadata.topic === selector.topic),
  );
}

export function contextHealthSelectorHasRecordScope(
  selector: ContextHealthSelectorV1 | undefined,
): selector is ContextHealthSelectorV1 & ({readonly kind: MemoryKind} | {readonly topic: string}) {
  return selector?.kind !== undefined || selector?.topic !== undefined;
}

export function contextHealthSelectorFindingUris(
  selector: ContextHealthSelectorV1 | undefined,
  selectedRecords: readonly MemoryRecord[],
): readonly string[] | undefined {
  return contextHealthSelectorHasRecordScope(selector)
    ? EffectArray.map(selectedRecords, record => record.uri)
    : undefined;
}

export function contextHealthSelectorsEqual(
  left: ContextHealthSelectorV1 | undefined,
  right: ContextHealthSelectorV1 | undefined,
): boolean {
  return contextHealthSelectorKey(left) === contextHealthSelectorKey(right);
}

export function contextHealthSelectorKey(selector: ContextHealthSelectorV1 | undefined): string {
  return JSON.stringify({
    after: selector?.after ?? null,
    findingCategory: selector?.findingCategory ?? null,
    kind: selector?.kind ?? null,
    topic: selector?.topic ?? null,
  });
}

export function contextHealthSelectorDescription(selector: ContextHealthSelectorV1 | undefined): string | undefined {
  if (selector === undefined) return undefined;
  return EffectArray.join(
    EffectArray.filter(
      [
        selector.after === undefined ? undefined : `after=${selector.after}`,
        selector.findingCategory === undefined ? undefined : `finding category=${selector.findingCategory}`,
        selector.kind === undefined ? undefined : `kind=${selector.kind}`,
        selector.topic === undefined ? undefined : `topic=${selector.topic}`,
      ],
      (value): value is string => value !== undefined,
    ),
    ', ',
  );
}

export function contextHealthSelectorCliFlags(
  selector: ContextHealthSelectorV1 | undefined,
  quote: (value: string) => string = value => value,
): string {
  if (selector === undefined) return '';
  return `${selector.after === undefined ? '' : ` --after ${selector.after}`}${
    selector.findingCategory === undefined ? '' : ` --finding-category ${selector.findingCategory}`
  }${selector.kind === undefined ? '' : ` --kind ${selector.kind}`}${
    selector.topic === undefined ? '' : ` --topic ${quote(selector.topic)}`
  }`;
}

function optionalContextHealthCursor(value: string | undefined, name: string): string | undefined {
  const cursor = optionalSelectorText(value, name);
  if (cursor !== undefined && !/^hcx1_[1-9a-z][0-9a-z]*_[0-9a-f]{40}$/u.test(cursor)) {
    throw new Error(`${name} must be an exact context-health continuation cursor.`);
  }
  return cursor;
}

function optionalSelectorText(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (FORBIDDEN_SELECTOR_CHARACTERS.test(value)) {
    throw new Error(`${name} contains control characters.`);
  }
  const text = Effect.pipe(value, EffectString.trim);
  if (!text) throw new Error(`${name} must not be empty.`);
  if (new TextEncoder().encode(text).byteLength > CONTEXT_HEALTH_SELECTOR_MAXIMUM_BYTES) {
    throw new Error(`${name} exceeds ${CONTEXT_HEALTH_SELECTOR_MAXIMUM_BYTES} UTF-8 bytes.`);
  }
  return text;
}
