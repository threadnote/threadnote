import {Array as EffectArray} from 'effect';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Console, Effect} from 'effect';
import {readPrivateCollectionJson} from './threadnote-5-collection-process.js';
import {
  collectThreadnote5Candidate,
  previewThreadnote5Collection,
  sealThreadnote5Collection,
} from './threadnote-5-collection-runner.js';
import {ScriptError} from './effect/errors.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export async function runThreadnote5CollectionCli(args: readonly string[]): Promise<unknown> {
  const [mode, ...rest] = args;
  if (mode === '--help' || mode === undefined) return usage;
  const allowed =
    mode === 'preview'
      ? ['--plan']
      : mode === 'collect'
        ? ['--plan', '--approved-plan-sha256', '--executable', '--private-output']
        : mode === 'seal'
          ? [
              '--collection',
              '--plan',
              '--transcripts',
              '--collection-authority-binding',
              '--collection-authority-binding-sha256',
              '--fixture',
              '--candidate',
              '--authority-manifest',
              '--authority-manifest-sha256',
              '--public-output',
            ]
          : [];
  if (allowed.length === 0) throw new Error('Expected preview, collect, or seal.');
  const options: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (
      !allowed.includes(name) ||
      EffectRecord.has(options, name) ||
      !value ||
      Effect2.pipe(value, EffectString.startsWith('--'))
    )
      throw new Error('Invalid or duplicate collection option.');
    options[name] = value;
  }
  if (EffectArray.some(allowed, name => !EffectRecord.has(options, name)))
    throw new Error('Collection requires every documented input; there are no fixture/default adapters.');
  if (mode === 'preview') return previewThreadnote5Collection(await readPrivateCollectionJson(options['--plan']));
  if (mode === 'collect') {
    const collection = await collectThreadnote5Candidate({
      plan: await readPrivateCollectionJson(options['--plan']),
      approvedPlanHash: options['--approved-plan-sha256'],
      executable: options['--executable'],
      privateOutput: options['--private-output'],
    });
    return {
      version: 1,
      state: 'private-unverified',
      planHash: collection.planHash,
      transcriptDigest: collection.transcriptDigest,
      collectionHash: collection.collectionHash,
      sourceRecords: collection.records.length,
      runtimeBoundaries: collection.runtimeBoundaries.length,
    };
  }
  return await sealThreadnote5Collection({
    collection: await readPrivateCollectionJson(options['--collection']),
    plan: await readPrivateCollectionJson(options['--plan']),
    transcripts: await readPrivateCollectionJson(options['--transcripts'], 64 * 1024 * 1024),
    collectionAuthorityBinding: await readPrivateCollectionJson(options['--collection-authority-binding']),
    expectedCollectionBindingSha256: options['--collection-authority-binding-sha256'],
    fixture: await readPrivateCollectionJson(options['--fixture']),
    candidate: await readPrivateCollectionJson(options['--candidate']),
    authorityManifest: await readPrivateCollectionJson(options['--authority-manifest']),
    expectedAuthorityManifestSha256: options['--authority-manifest-sha256'],
    publicOutput: options['--public-output'],
  });
}

const usage = `Private Threadnote 5 collection (never run against personal state):
  bun scripts/collect-threadnote-5-release-readiness.ts preview --plan <reviewed-recipes.json>
  bun scripts/collect-threadnote-5-release-readiness.ts collect --plan <reviewed-recipes.json> --approved-plan-sha256 <preview-hash> --executable <canonical-native-standalone-payload> --private-output <new-directory-reference>
  bun scripts/collect-threadnote-5-release-readiness.ts seal --collection <private/collection.json> --plan <private/plan.json> --transcripts <private/transcripts.json> --collection-authority-binding <binding.json> --collection-authority-binding-sha256 <independently-reviewed-hash> --fixture <canonical-matrix.json> --candidate <candidate.json> --authority-manifest <externally-reviewed.json> --authority-manifest-sha256 <independently-reviewed-hash> --public-output <new-directory-reference>

All 15 scenario recipes and 24 native projections are mandatory. Collection is expensive and mutates only fresh isolated homes/repositories/local remotes. Native records and transcripts remain private and unverified until independently bound authority passes source replay. Outputs are exclusive-create directory references to privately staged data. Delete both the reference and its target by retention.json's deadline (maximum seven days). This command does not install or activate a binary, publish records, or manufacture missing scenario adapters.`;

if (import.meta.main) {
  BunRuntime.runMain(
    Effect.tryPromise({
      try: () => runThreadnote5CollectionCli(process.argv.slice(2)),
      catch: cause => ScriptError.make({cause, message: 'Threadnote 5 collection failed closed.'}),
    }).pipe(
      Effect.flatMap(value => Console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))),
      Effect.catch(() =>
        Console.error(
          'Threadnote 5 collection failed closed. Inspect reviewed inputs locally; raw errors are not public evidence.',
        ).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              process.exitCode = 1;
            }),
          ),
        ),
      ),
    ),
  );
}
