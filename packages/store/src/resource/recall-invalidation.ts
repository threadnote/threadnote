import {Array as EffectArray} from 'effect';
import {Context, Effect, FileSystem, Path} from 'effect';
import type {CanonicalMutationGenerationTransition} from './mutation_generation.js';
import type {SystemInfo} from '@threadnote/platform/system';

export interface ResourceRecallInvalidationShape {
  readonly expire: (
    home: string,
    includeInactive: boolean,
    invalidatedUris: readonly string[],
    canonicalMutationGeneration: CanonicalMutationGenerationTransition,
  ) => Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path | SystemInfo>;
}

export class ResourceRecallInvalidation extends Context.Service<
  ResourceRecallInvalidation,
  ResourceRecallInvalidationShape
>()('@threadnote/store/resource/recall-invalidation/ResourceRecallInvalidation') {}

interface InvalidationLocation {
  readonly home: string;
  readonly account: string;
  readonly user: string;
}

/** Optional request-local acknowledgement, read by the real store at operation time. */
export interface ResourceRecallInvalidationObserver {
  readonly begin: (
    location: InvalidationLocation,
    uris: readonly string[],
    transition: CanonicalMutationGenerationTransition,
    includeInactive: boolean,
  ) => (succeeded: boolean) => void;
}

export const CurrentResourceRecallInvalidationObserver = Context.Reference<
  ResourceRecallInvalidationObserver | undefined
>('@threadnote/store/resource/recall-invalidation/CurrentObserver', {defaultValue: () => undefined});

// A receipt is an opaque, request-local capability, never a caller assertion that
// invalidation happened. Consume it once at the lexical expiry boundary.
// No receipt or observation is persisted or shared.
class InvalidationReceipt {
  #available = true;
  readonly #location: InvalidationLocation;
  readonly #uris: ReadonlySet<string>;
  constructor(location: InvalidationLocation, uris: readonly string[]) {
    this.#location = {...location};
    this.#uris = new Set(uris);
  }
  consume(location: InvalidationLocation, uris: readonly string[]): boolean {
    const available = this.#available;
    this.#available = false;
    return (
      available &&
      this.#location.home === location.home &&
      this.#location.account === location.account &&
      this.#location.user === location.user &&
      EffectArray.every(uris, uri => this.#uris.has(uri))
    );
  }
}
export type ResourceRecallInvalidationReceipt = InvalidationReceipt;
export const consumeResourceRecallInvalidationReceipt = (
  receipt: ResourceRecallInvalidationReceipt | undefined,
  location: InvalidationLocation,
  uris: readonly string[],
): boolean => receipt instanceof InvalidationReceipt && receipt.consume(location, uris);

/** Count expected canonical mutations independently of the store acknowledgements. */
export const makeResourceRecallInvalidationObservation = (location: InvalidationLocation) => {
  let active = true;
  let unknown = false;
  const expected = new Map<string, number>();
  const verified = new Map<string, number>();
  const mutations = new Map<string, {uris: readonly string[]; scopes: Map<boolean, boolean | undefined>}>();
  const increment = (counts: Map<string, number>, uris: readonly string[]) => {
    if (!active) return;
    for (const uri of uris) counts.set(uri, (counts.get(uri) ?? 0) + 1);
  };
  const observer: ResourceRecallInvalidationObserver = {
    begin: (actual, uris, transition, includeInactive) => {
      if (!active) return () => {};
      if (
        actual.home !== location.home ||
        actual.account !== location.account ||
        actual.user !== location.user ||
        !uris.length ||
        !transition.currentGeneration ||
        transition.currentGeneration === transition.previousGeneration
      ) {
        unknown = true;
        return () => {};
      }
      const key = JSON.stringify([transition.previousGeneration, transition.currentGeneration]);
      let mutation = mutations.get(key);
      if (!mutation) {
        mutation = {uris: [...uris], scopes: new Map()};
        mutations.set(key, mutation);
      }
      if (JSON.stringify(mutation.uris) !== JSON.stringify(uris) || mutation.scopes.has(includeInactive))
        unknown = true;
      mutation.scopes.set(includeInactive, undefined);
      let completed = false;
      return succeeded => {
        if (!active) return;
        if (completed) unknown = true;
        completed = true;
        mutation.scopes.set(includeInactive, succeeded);
      };
    },
  };
  return {
    observer,
    expect: (uris: readonly string[]) => increment(expected, uris),
    verify: (uris: readonly string[]) => increment(verified, uris),
    finish: (succeeded: boolean, uris: readonly string[]): ResourceRecallInvalidationReceipt | undefined => {
      if (!active) return undefined;
      active = false;
      if (!succeeded || unknown || !expected.size) return undefined;
      const actual = new Map<string, number>();
      for (const mutation of mutations.values()) {
        if (mutation.scopes.get(false) !== true || mutation.scopes.get(true) !== true) return undefined;
        for (const uri of mutation.uris) actual.set(uri, (actual.get(uri) ?? 0) + 1);
      }
      if (expected.size !== verified.size || expected.size !== actual.size) return undefined;
      for (const [uri, count] of expected)
        if (verified.get(uri) !== count || actual.get(uri) !== count) return undefined;
      if (EffectArray.some(uris, uri => !expected.has(uri))) return undefined;
      return new InvalidationReceipt(location, [...expected.keys()]);
    },
  };
};
