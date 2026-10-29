import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray} from 'effect';
import {Effect} from 'effect';
import {codeGraphSnapshotAdmissionCurrentForIdentity} from '../admission_freshness.js';
import type {CodeGraphLayout} from '../layout.js';
import {extractorSetIdentityFromPackProvenance} from '../indexer.js';
import {codeGraphLanguagePackProvenance, type CodeGraphLanguagePackRegistryShape} from '../languages/registry.js';
import type {CodeGraphLanguagePackProvenance, CodeGraphStoreShape} from '../store.js';
import type {CodeGraphSnapshot, RepositoryIdentity} from '../types.js';

/** Prove that a snapshot's recorded extractor contract still matches the current language-pack catalog. */
export function codeGraphSnapshotMatchesCurrentLanguagePacks(
  snapshot: Pick<CodeGraphSnapshot, 'extractorSet'>,
  provenance: readonly CodeGraphLanguagePackProvenance[] | undefined,
  languagePacks: CodeGraphLanguagePackRegistryShape,
): boolean {
  if (provenance === undefined) return false;
  const previousIds = new Set(EffectArray.map(provenance, pack => pack.id));
  if (previousIds.size !== provenance.length) return false;
  const currentProvenance = EffectArray.map(
    EffectArrayPipe(languagePacks.packs, __effectArrayValues =>
      EffectArray.filter(
        __effectArrayValues,
        (pack, __effectArrayIndex) => __effectArrayIndex in __effectArrayValues && previousIds.has(pack.id),
      ),
    ),
    codeGraphLanguagePackProvenance,
  );
  if (currentProvenance.length !== previousIds.size) return false;
  return (
    extractorSetIdentityFromPackProvenance(provenance) === snapshot.extractorSet &&
    extractorSetIdentityFromPackProvenance(currentProvenance) === snapshot.extractorSet
  );
}

export function codeGraphSnapshotRuntimeCurrent(
  store: CodeGraphStoreShape,
  databasePath: string,
  snapshot: CodeGraphSnapshot,
  languagePacks: CodeGraphLanguagePackRegistryShape,
  admission?: {
    readonly layout: CodeGraphLayout;
    readonly identity: RepositoryIdentity;
    readonly producingWorktree?: boolean;
  },
) {
  return store.snapshotPackProvenance(databasePath, snapshot.id).pipe(
    Effect.flatMap(provenance => {
      if (!codeGraphSnapshotMatchesCurrentLanguagePacks(snapshot, provenance, languagePacks))
        return Effect.succeed(false);
      return admission === undefined
        ? Effect.succeed(true)
        : codeGraphSnapshotAdmissionCurrentForIdentity(
            admission.layout,
            snapshot,
            admission.identity,
            languagePacks,
            admission.producingWorktree,
          );
    }),
    Effect.orElseSucceed(() => false),
  );
}
