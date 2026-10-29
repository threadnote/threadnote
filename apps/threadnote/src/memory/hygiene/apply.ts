import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Option, Schema} from 'effect';
import {withMemoryUriLocks} from '@threadnote/memory/lock';
import {ResourceStore, type ResourceStoreShape} from '@threadnote/store/resource-store';
import type {CompactPlan, ForgetAction, KeepUpdateAction, MemoryRecord} from '@threadnote/memory/hygiene';
import {discardDeferredCodeAnchorIntent} from '../deferred/code_anchor.js';
import {discardMemoryRelocation} from '@threadnote/memory/relocation';
import {MemoryOperationError, resourceStoreLocation} from '../migrations.js';
import {writeMemoryFile} from '../../share/index.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export class MemoryHygieneApplyConflict extends Schema.TaggedError<
  MemoryHygieneApplyConflict,
  {readonly brand: unique symbol}
>()('MemoryHygieneApplyConflict', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

interface ExactDuplicateApplyGroup {
  readonly keepUpdate?: KeepUpdateAction;
  readonly retired: readonly ForgetAction[];
  readonly survivorExpectedContent: string;
  readonly survivorUri: string;
}

export interface ExactDuplicateApplyResult {
  readonly forgottenUris: readonly string[];
  readonly updatedSurvivorUris: readonly string[];
}

/**
 * Applies every destructive exact-duplicate group while jointly holding the
 * survivor and retired-URI locks. This closes the gap that previously existed
 * between updating a survivor and deleting its duplicate in separate loops.
 */
export const applyAtomicExactDuplicateActions = Effect.fn('memoryHygiene.applyAtomicExactDuplicateActions')(function* (
  config: RuntimeConfig,
  plan: CompactPlan,
  records: readonly MemoryRecord[],
) {
  const recordContentByUri = new Map(EffectArray.map(records, record => [record.uri, record.content]));
  const keepUpdateByUri = new Map(EffectArray.map(plan.keepUpdates, action => [action.uri, action]));
  const groupsBySurvivor = new Map<
    string,
    {keepUpdate?: KeepUpdateAction; retired: ForgetAction[]; survivorExpectedContent: string}
  >();

  for (const action of plan.forgets) {
    const survivorUris = [...new Set(EffectArray.filter(action.sourceUris, uri => uri !== action.uri))];
    const survivorUri = survivorUris[0];
    if (survivorUris.length !== 1 || !survivorUri) {
      return yield* conflict(
        `Exact-duplicate action for ${action.uri} does not identify one survivor. No duplicate was removed; re-run compact.`,
      );
    }
    const survivorExpectedContent = recordContentByUri.get(survivorUri);
    if (survivorExpectedContent === undefined) {
      return yield* conflict(
        `Exact-duplicate survivor ${survivorUri} is no longer in the hygiene snapshot. No duplicate was removed; re-run compact.`,
      );
    }
    const existing = groupsBySurvivor.get(survivorUri);
    if (existing && existing.survivorExpectedContent !== survivorExpectedContent) {
      return yield* conflict(`Exact-duplicate survivor ${survivorUri} has conflicting snapshots. Re-run compact.`);
    }
    groupsBySurvivor.set(survivorUri, {
      keepUpdate: keepUpdateByUri.get(survivorUri),
      retired: [...(existing?.retired ?? []), action],
      survivorExpectedContent,
    });
  }

  const retiredUris = new Set(EffectArray.map(plan.forgets, action => action.uri));
  for (const survivorUri of groupsBySurvivor.keys()) {
    if (retiredUris.has(survivorUri)) {
      return yield* conflict(
        `Memory ${survivorUri} is both an exact-duplicate survivor and retirement target. Re-run compact.`,
      );
    }
  }

  const groups: ExactDuplicateApplyGroup[] = EffectArray.map(
    [...groupsBySurvivor.entries()],
    ([survivorUri, group]) => ({
      ...group,
      retired: [...group.retired].sort((left, right) => Effect2.pipe(left.uri, EffectString.localeCompare(right.uri))),
      survivorUri,
    }),
  ).sort((left, right) => Effect2.pipe(left.survivorUri, EffectString.localeCompare(right.survivorUri)));
  const fs = yield* FileSystem.FileSystem;
  const store = yield* ResourceStore;
  const location = resourceStoreLocation(config);
  const forgottenUris: string[] = [];
  const updatedSurvivorUris: string[] = [];

  for (const group of groups) {
    const lockedUris = [group.survivorUri, ...EffectArray.map(group.retired, action => action.uri)].sort();
    yield* withMemoryUriLocks(
      fs,
      config.agentContextHome,
      lockedUris,
      Effect.gen(function* () {
        yield* requireExpectedContent(
          store,
          location,
          group.survivorUri,
          group.survivorExpectedContent,
          'survivor changed before the exact-duplicate apply',
        );
        for (const action of group.retired) {
          yield* requireExpectedContent(
            store,
            location,
            action.uri,
            action.expectedContent,
            'duplicate changed before the exact-duplicate apply',
          );
        }

        const survivorPostContent = group.keepUpdate?.content ?? group.survivorExpectedContent;
        if (group.keepUpdate) {
          yield* store.write(location, group.survivorUri, group.keepUpdate.content, {mode: 'replace'});
          yield* discardDeferredCodeAnchorIntent(config, group.survivorUri);
          yield* discardMemoryRelocation(config, group.survivorUri);
        }

        // Revalidate both sides after the survivor write. A writer that
        // mutated or removed the survivor between the former keep/forget
        // phases must leave every unchanged duplicate in place.
        yield* requireExpectedContent(
          store,
          location,
          group.survivorUri,
          survivorPostContent,
          'survivor changed during its hygiene update',
        );
        for (const action of group.retired) {
          yield* requireExpectedContent(
            store,
            location,
            action.uri,
            action.expectedContent,
            'duplicate changed during its survivor update',
          );
        }

        for (const action of group.retired) {
          // Keep checking the survivor while all URI locks remain held. A
          // duplicate is never retired after its preserved copy disappears.
          yield* requireExpectedContent(
            store,
            location,
            group.survivorUri,
            survivorPostContent,
            'survivor changed before duplicate retirement',
          );
          yield* store.remove(location, action.uri);
          yield* discardDeferredCodeAnchorIntent(config, action.uri);
          forgottenUris.push(action.uri);
        }
        if (group.keepUpdate) updatedSurvivorUris.push(group.survivorUri);
      }),
    );
  }

  return {forgottenUris, updatedSurvivorUris} satisfies ExactDuplicateApplyResult;
});

/** Apply every CLI compact keep update while preserving the atomic exact-duplicate retirement boundary. */
export const applyCliCompactKeepUpdates = Effect.fn('memoryHygiene.applyCliCompactKeepUpdates')(function* (
  config: RuntimeConfig,
  plan: CompactPlan,
  records: readonly MemoryRecord[],
) {
  const exactDuplicateApply = yield* applyAtomicExactDuplicateActions(config, plan, records);
  const atomicallyUpdatedUris = new Set(exactDuplicateApply.updatedSurvivorUris);
  const fs = yield* FileSystem.FileSystem;
  const store = yield* ResourceStore;
  const location = resourceStoreLocation(config);
  for (const action of EffectArray.filter(plan.keepUpdates, candidate => !atomicallyUpdatedUris.has(candidate.uri))) {
    yield* withMemoryUriLocks(
      fs,
      config.agentContextHome,
      [action.uri],
      Effect.gen(function* () {
        const current = yield* store.read(location, action.uri).pipe(Effect.option);
        if (Option.isNone(current) || current.value !== action.expectedContent) {
          return yield* MemoryOperationError.make({
            message: `Memory ${action.uri} changed during hygiene apply. Re-run compact.`,
          });
        }
        yield* writeMemoryFile(config, 'threadnote-native', action.uri, action.content, 'replace', false, {
          quiet: true,
        });
        yield* discardDeferredCodeAnchorIntent(config, action.uri);
      }),
    );
  }
});

function requireExpectedContent(
  store: ResourceStoreShape,
  location: ReturnType<typeof resourceStoreLocation>,
  uri: string,
  expectedContent: string,
  reason: string,
) {
  return Effect.gen(function* () {
    const current = yield* store.read(location, uri).pipe(
      Effect.asSome,
      Effect.catchTag('ResourceNotFound', () => Effect.succeedNone),
    );
    if (Option.isNone(current) || current.value !== expectedContent) {
      return yield* conflict(`Memory ${uri} ${reason}. Its exact duplicate was preserved; re-run compact.`);
    }
  });
}

function conflict(message: string): MemoryHygieneApplyConflict {
  return MemoryHygieneApplyConflict.make({message: message});
}
