import {Array as EffectArray, Clock, Effect, Schema} from 'effect';
import {SecureRandom} from 'effect/crypto';
import {Observation, observationKey} from '@threadnote/semantic/contracts';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {LspFault} from './lsp_transport.js';

export const semanticActionChoiceLimits = {
  maxChoices: 128,
  maxListings: 16,
  maxRetainedBytes: 1024 * 1024,
  ttlMilliseconds: 60000,
} as const;
export const SemanticActionChoice = Schema.Struct({
  kind: Schema.Literal('action-choice'),
  title: Schema.String.check(Schema.isMaxLength(8192)),
  actionKind: Schema.String.check(Schema.isMaxLength(512)),
  disabled: Schema.NullOr(Schema.String.check(Schema.isMaxLength(8192))),
  command: Schema.Boolean,
  qualified: Schema.Boolean,
  selector: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  queryDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  blocker: Schema.NullOr(Schema.String.check(Schema.isMaxLength(512))),
});
export type SemanticActionChoice = typeof SemanticActionChoice.Type;
interface Listing {
  readonly binding: string;
  readonly observation: Observation;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly choices: readonly SemanticActionChoice[];
  readonly handles: readonly string[];
  readonly bytes: number;
}
/** Private process-local read capabilities. Restart or any binding change requires explicit relisting. */
export const makeSemanticActionChoices = Effect.fn('semantic.actionChoices')(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const listings: Listing[] = [];
  const prune = (now: number) => {
    for (let i = listings.length - 1; i >= 0; i--)
      if (now < listings[i].createdAt || now >= listings[i].expiresAt) listings.splice(i, 1);
  };
  const retain = (input: unknown, binding: string, observation: Observation) =>
    Effect.gen(function* () {
      const choices = yield* Schema.decodeUnknownEffect(
        Schema.Array(SemanticActionChoice).check(Schema.isMaxLength(semanticActionChoiceLimits.maxChoices)),
      )(input).pipe(Effect.mapError(() => LspFault.make({code: 'protocol'})));
      const bytes =
        new TextEncoder().encode(JSON.stringify([binding, observation, choices])).length + choices.length * 68 + 128;
      const now = yield* Clock.currentTimeMillis;
      prune(now);
      if (
        listings.length >= semanticActionChoiceLimits.maxListings ||
        EffectArray.reduce(listings, bytes, (n, listing) => n + listing.bytes) >
          semanticActionChoiceLimits.maxRetainedBytes
      )
        return yield* LspFault.make({code: 'capacity'});
      const handles: string[] = [];
      for (const _choice of choices) handles.push(sha256HexSync(yield* random.randomBytes(32)));
      // No mutation until the complete list and all capabilities are admitted.
      const current = yield* Clock.currentTimeMillis;
      if (current < now || current >= now + semanticActionChoiceLimits.ttlMilliseconds)
        return yield* LspFault.make({code: 'rejected'});
      prune(current);
      if (
        listings.length >= semanticActionChoiceLimits.maxListings ||
        EffectArray.reduce(listings, bytes, (n, listing) => n + listing.bytes) >
          semanticActionChoiceLimits.maxRetainedBytes
      )
        return yield* LspFault.make({code: 'capacity'});
      const listing: Listing = {
        binding,
        observation: structuredClone(observation),
        createdAt: now,
        expiresAt: now + semanticActionChoiceLimits.ttlMilliseconds,
        choices: structuredClone(choices),
        handles,
        bytes,
      };
      listings.push(listing);
      return {
        createdAt: listing.createdAt,
        expiresAt: listing.expiresAt,
        choices: EffectArray.map(choices, (choice, index) => ({
          choiceHandle: handles[index],
          title: choice.title,
          kind: choice.actionKind,
          disabled: choice.disabled,
          command: choice.command,
          qualified: choice.qualified,
          blocker: choice.blocker,
        })),
      };
    });
  const get = (handle: string, binding: string, observation: Observation) =>
    Effect.gen(function* () {
      prune(yield* Clock.currentTimeMillis);
      for (const listing of listings) {
        const index = listing.handles.indexOf(handle);
        if (index < 0) continue;
        if (listing.binding !== binding || observationKey(listing.observation) !== observationKey(observation))
          return undefined;
        return structuredClone(listing.choices[index]);
      }
      return undefined;
    });
  const discard = (handles: readonly string[], binding: string) =>
    Effect.sync(() => {
      for (let i = listings.length - 1; i >= 0; i--)
        if (
          listings[i].binding === binding &&
          handles.length === listings[i].handles.length &&
          EffectArray.every(handles, (handle, index) => handle === listings[i].handles[index])
        )
          listings.splice(i, 1);
    });
  return {retain, get, discard};
});
