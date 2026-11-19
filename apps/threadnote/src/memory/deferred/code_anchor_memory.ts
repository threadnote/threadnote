import {Array as EffectArray, Effect, Option} from 'effect';
import {sha256Hex} from '@threadnote/platform/digest';
import {ResourceStore} from '@threadnote/store/resource-store';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import {canonicalMemoryDocumentContent, parseMemoryDocument, type MemoryRecord} from '@threadnote/memory/document';

export interface DeferredMemoryObservation {
  readonly content: string;
  readonly hash: string;
  readonly record: MemoryRecord;
}

export function deferredCodeAnchorFinalizationVerified(expected: string, actual: string): boolean {
  return canonicalMemoryDocumentContent(actual) === canonicalMemoryDocumentContent(expected);
}

export const readDeferredMemoryObservation = Effect.fn('memoryCodeAnchor.readMemory')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
  memoryUri: string,
) {
  const store = yield* ResourceStore;
  const content = yield* store.read(resourceStoreLocation(config), memoryUri).pipe(
    Effect.asSome,
    Effect.catchTag('ResourceNotFound', () => Effect.succeedNone),
  );
  if (Option.isNone(content)) return undefined;
  const record = parseMemoryDocument(memoryUri, content.value);
  if (!record) return undefined;
  return {
    content: content.value,
    hash: yield* memoryContentHash(content.value),
    record,
  } satisfies DeferredMemoryObservation;
});

export function reconcileInterruptedDeferredCodeAnchorCommit<A, E, R>(
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
  memoryUri: string,
  expectedMemory: string,
  cleanup: Effect.Effect<A, E, R>,
) {
  return Effect.uninterruptible(
    Effect.gen(function* () {
      const store = yield* ResourceStore;
      const actual = yield* store.read(resourceStoreLocation(config), memoryUri).pipe(Effect.option);
      if (Option.isNone(actual)) return;
      const record = parseMemoryDocument(memoryUri, actual.value);
      if (!record || !deferredCodeAnchorFinalizationVerified(expectedMemory, actual.value)) return;
      yield* cleanup;
    }).pipe(Effect.ignoreCause),
  );
}

export function memoryContentHash(content: string) {
  return sha256Hex(canonicalMemoryDocumentContent(content));
}

export function resourceStoreLocation(config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>) {
  return {account: config.account, home: config.agentContextHome, user: config.user} as const;
}

/** The shared source commit of a citation set, or undefined when citations span commits. */
export function commonCitationSourceCommit(citations: readonly MemoryCodeCitationV1[]): string | undefined {
  const commits = new Set(EffectArray.map(citations, citation => citation.sourceCommit));
  return commits.size === 1 ? citations[0]?.sourceCommit : undefined;
}
