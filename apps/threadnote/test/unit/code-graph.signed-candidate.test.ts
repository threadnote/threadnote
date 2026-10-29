import {Array as EffectArray} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Cause, Effect, FileSystem, Layer, Path} from 'effect';
import * as FC from 'fast-check';
import {it} from 'vitest';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {codeGraphCheckpointAbiInputV1} from '@threadnote/graph/checkpoint/compatibility';
import {codeGraphCheckpointAbiDigestV1} from '@threadnote/graph/checkpoint/pack';
import {codeGraphCommittedContentHash} from '@threadnote/graph/content_identity';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '@threadnote/graph/languages/registry';
import {graphShareParseActionKey} from '@threadnote/graph/sharing/action';
import {putCasBytes} from '@threadnote/graph/sharing/cas';
import {sha256Digest, sha256HexFromDigest} from '@threadnote/graph/sharing/digest';
import {graphShareParseResultArtifact} from '@threadnote/graph/sharing/parse/result';
import {
  acknowledgeGraphShareSignedCandidatePage,
  finalizeGraphShareSignedCandidates,
  graphShareSignedCandidateIdentity,
  listGraphShareSignedCandidatePageIds,
  parseGraphSharePendingSignedCandidateQueue,
  parseGraphShareSignedCandidateQueue,
  pendingCandidateQueuePath,
  persistGraphSharePendingSignedCandidates,
  persistGraphShareSignedCandidates,
  readGraphShareSignedCandidatePage,
  signedCandidateQueuePath,
  type GraphSharePendingSignedCandidate,
  type GraphShareSignedCandidateV2,
  type GraphShareSignedCandidateStore,
} from '@threadnote/graph/sharing/signed/candidate';
import type {CodeGraphFileFacts, CodeGraphInventoryFile, CodeGraphSnapshot} from '@threadnote/graph/types';
import {SystemInfo} from '@threadnote/platform/system';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Option as EffectOption} from 'effect';

const layer = TestSystemInfoLayer.pipe(Layer.provideMerge(BunServices.layer));
const packs = BUILTIN_LANGUAGE_PACK_REGISTRY.activePackProvenance(['src/index.ts', 'src/main.py']);
const commit = Effect2.pipe('a', EffectString.repeat(40));
const repositoryId = Effect2.pipe('b', EffectString.repeat(64));
const profileDigest = sha256Digest('producer-profile');
const pathName = 'src/index.ts';
const blobId = Effect2.pipe('d', EffectString.repeat(40));
const contentHash = codeGraphCommittedContentHash('sha1', blobId);
const facts: CodeGraphFileFacts = {diagnostics: [], edges: [], path: pathName, symbols: []};
const file: CodeGraphInventoryFile = {
  blobId,
  contentHash,
  language: 'typescript',
  mode: '100644',
  path: pathName,
  size: 12,
  source: 'commit',
};
const actionKey = graphShareParseActionKey({
  contentHash,
  extractorSet: packs[0].cacheIdentity,
  languageAndRole: 'typescript:source',
  normalizedPath: pathName,
  repositoryId,
});
const result = graphShareParseResultArtifact({
  actionKey,
  contentHash,
  extractorSet: packs[0].cacheIdentity,
  facts,
  gitBlobId: blobId,
  languageAndRole: 'typescript:source',
  normalizedPath: pathName,
  repositoryId,
});
const resultBytes = new TextEncoder().encode(canonicalJson(result));
const snapshot: CodeGraphSnapshot = {
  commit,
  dirty: false,
  edgeCount: 0,
  extractorSet: Effect2.pipe('e', EffectString.repeat(64)),
  fileCount: 2,
  id: `cgsn_${Effect2.pipe('f', EffectString.repeat(40))}`,
  repositoryId,
  state: 'ready',
  symbolCount: 0,
  worktreeId: Effect2.pipe('1', EffectString.repeat(64)),
};
const pendingFixture: GraphSharePendingSignedCandidate = {
  actionKey,
  batchId: commit,
  casRoot: '/private/cas',
  extractorSet: packs[0].cacheIdentity,
  organization: 'acme',
  platform: {architecture: 'arm64', os: 'darwin'},
  profileDigest,
  queuedAtMilliseconds: 1_000,
  releaseIdentity: 'fixture-release',
  resultDigest: sha256Digest(resultBytes),
  resultSize: resultBytes.byteLength,
  semanticDigest: result.semanticDigest,
  sourceCommit: commit,
};
const candidateFixture: GraphShareSignedCandidateV2 = {
  ...pendingFixture,
  graphAbi: Effect2.pipe('2', EffectString.repeat(64)),
  partialCoverage: false,
  resourceLimits: [],
  snapshotId: snapshot.id,
};

const fixture = Effect.fn('test.signedCandidate.fixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-signed-candidates-'});
  const casRoot = path.join(home, 'cas');
  const resultDigest = yield* putCasBytes(casRoot, resultBytes);
  const pending = {...pendingFixture, casRoot, resultDigest};
  const root = path.join(home, 'graph-sharing');
  yield* fs.makeDirectory(root, {recursive: true, mode: 0o700});
  yield* fs.writeFileString(
    path.join(root, 'trust-receipts.json'),
    JSON.stringify({
      schemaVersion: 1,
      receipts: [
        {
          accessMode: 'join',
          organization: 'acme',
          policyVersion: 1,
          profileDigest,
          publisherKeyFingerprint: sha256Digest('publisher'),
          registryCanonical: 'cas://local',
          repositoryId,
          client: {casRoot, contributionMode: 'passive'},
        },
      ],
    }),
  );
  const observed: string[] = [];
  const store = {
    snapshotPackProvenance: (_databasePath: string, id: string) => {
      observed.push(`packs:${id}`);
      return Effect.succeed(packs);
    },
    effectiveSnapshotFilesByPaths: (_databasePath: string, id: string, paths: readonly string[]) => {
      observed.push(`files:${id}`);
      return Effect.succeed(
        EffectArray.map(paths, pathValue => ({path: pathValue, file: pathValue === file.path ? file : undefined})),
      );
    },
    loadCachedFacts: (_databasePath, files, extractorSet) => {
      observed.push(`cache:${extractorSet}`);
      return Effect.succeed({
        bytes: resultBytes.byteLength,
        facts: new Map(EffectArray.map(files, item => [item.path, facts])),
      });
    },
  } satisfies GraphShareSignedCandidateStore;
  return {casRoot, fs, home, observed, path, pending, store};
});

describe('producer-bound signed candidate evidence', () => {
  effectIt.effect(
    'reconciles durable pre-cache evidence after restart using exact ready snapshot facts and full ABI',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* persistGraphSharePendingSignedCandidates({
          candidates: [f.pending],
          repositoryId,
          threadnoteHome: f.home,
        });
        const outcome = yield* finalizeGraphShareSignedCandidates({
          databasePath: '/exact/ready.sqlite',
          repositoryId,
          skippedFiles: 3,
          snapshot,
          store: f.store,
          threadnoteHome: f.home,
        });
        expect(outcome).toEqual({examined: 1, queued: 1, verified: 1});
        const finalIds = yield* listGraphShareSignedCandidatePageIds(f.home, repositoryId);
        expect(finalIds).toHaveLength(1);
        const final = yield* readGraphShareSignedCandidatePage(f.home, repositoryId, finalIds[0]);
        expect(final?.candidates).toHaveLength(1);
        expect(final!.candidates[0]).toMatchObject({
          actionKey,
          graphAbi: codeGraphCheckpointAbiDigestV1(codeGraphCheckpointAbiInputV1(packs)).digest,
          organization: 'acme',
          partialCoverage: true,
          profileDigest,
          releaseIdentity: 'fixture-release',
          resourceLimits: [],
          sourceCommit: commit,
        });
        expect(final!.candidates[0].graphAbi).not.toBe(
          codeGraphCheckpointAbiDigestV1(codeGraphCheckpointAbiInputV1([packs[0]])).digest,
        );
        expect(f.observed).toEqual([`packs:${snapshot.id}`, `files:${snapshot.id}`, `cache:${packs[0].cacheIdentity}`]);
        const pending = JSON.parse(yield* f.fs.readFileString(pendingCandidateQueuePath(f.path, f.home, repositoryId)));
        expect(pending.segments).toEqual([]);
        if ((yield* SystemInfo).platform !== 'win32')
          expect((yield* f.fs.stat(signedCandidateQueuePath(f.path, f.home, repositoryId))).mode & 0o777).toBe(0o600);
      }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect(
    'refuses dirty and source-mismatched snapshots with valid provenance, and missing provenance separately',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* persistGraphSharePendingSignedCandidates({
          candidates: [f.pending],
          repositoryId,
          threadnoteHome: f.home,
        });
        const finalize = (current: CodeGraphSnapshot, store = f.store) =>
          finalizeGraphShareSignedCandidates({
            databasePath: '/exact/ready.sqlite',
            repositoryId,
            skippedFiles: 0,
            snapshot: current,
            store,
            threadnoteHome: f.home,
          });
        expect((yield* finalize({...snapshot, dirty: true})).queued).toBe(0);
        expect(f.observed).toEqual([]);
        expect((yield* finalize({...snapshot, commit: Effect2.pipe('9', EffectString.repeat(40))})).queued).toBe(0);
        expect(f.observed).toEqual([`packs:${snapshot.id}`]);
        const missing = {
          effectiveSnapshotFilesByPaths: () => Effect.succeed([]),
          loadCachedFacts: () => Effect.succeed({bytes: 0, facts: new Map<string, CodeGraphFileFacts>()}),
          snapshotPackProvenance: () => Effect.succeed([]),
        } satisfies GraphShareSignedCandidateStore;
        expect((yield* finalize(snapshot, missing)).queued).toBe(0);
        expect(yield* f.fs.exists(signedCandidateQueuePath(f.path, f.home, repositoryId))).toBe(false);
      }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('keeps pending evidence when the trust profile changes', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* persistGraphSharePendingSignedCandidates({candidates: [f.pending], repositoryId, threadnoteHome: f.home});
      const target = f.path.join(f.home, 'graph-sharing', 'trust-receipts.json');
      const switched = JSON.parse(yield* f.fs.readFileString(target));
      switched.receipts[0].profileDigest = sha256Digest('different-profile');
      yield* f.fs.writeFileString(target, JSON.stringify(switched));
      expect(
        (yield* finalizeGraphShareSignedCandidates({
          databasePath: '/exact/ready.sqlite',
          repositoryId,
          skippedFiles: 0,
          snapshot,
          store: f.store,
          threadnoteHome: f.home,
        })).queued,
      ).toBe(0);
      expect(yield* f.fs.exists(signedCandidateQueuePath(f.path, f.home, repositoryId))).toBe(false);
      const pending = JSON.parse(yield* f.fs.readFileString(pendingCandidateQueuePath(f.path, f.home, repositoryId)));
      expect(pending.segments).toHaveLength(1);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('refuses changed CAS bytes and cached facts without losing producer evidence', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* persistGraphSharePendingSignedCandidates({candidates: [f.pending], repositoryId, threadnoteHome: f.home});
      const finalize = (store: GraphShareSignedCandidateStore) =>
        finalizeGraphShareSignedCandidates({
          databasePath: '/exact/ready.sqlite',
          repositoryId,
          skippedFiles: 0,
          snapshot,
          store,
          threadnoteHome: f.home,
        });
      const casPath = f.path.join(f.casRoot, 'sha256', sha256HexFromDigest(f.pending.resultDigest));
      yield* f.fs.writeFileString(casPath, 'changed result bytes');
      expect((yield* finalize(f.store)).queued).toBe(0);
      yield* f.fs.writeFile(casPath, resultBytes);
      const changedCache = {
        ...f.store,
        loadCachedFacts: () =>
          Effect.succeed({bytes: 1, facts: new Map([[pathName, {...facts, path: 'src/changed.ts'}]])}),
      } satisfies GraphShareSignedCandidateStore;
      expect((yield* finalize(changedCache)).queued).toBe(0);
      expect((yield* finalize(f.store)).verified).toBe(1);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('retains more than 512 pending and final records across a restart and acknowledges exactly one', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-signed-journal-capacity-'});
      const additions = Array.from({length: 600}, (_, index) => ({
        ...pendingFixture,
        actionKey: Effect2.pipe(index.toString(16), EffectString.padStart(64, '0')),
      }));
      expect(
        (yield* persistGraphSharePendingSignedCandidates({
          candidates: additions,
          repositoryId,
          threadnoteHome: home,
        })).queued,
      ).toBe(600);
      const pendingPath = pendingCandidateQueuePath(path, home, repositoryId);
      const pendingManifest = JSON.parse(yield* fs.readFileString(pendingPath));
      expect(pendingManifest.schemaVersion).toBe(2);
      expect(pendingManifest.segments.length).toBeGreaterThan(1);
      const recovered: GraphSharePendingSignedCandidate[] = [];
      for (const segment of pendingManifest.segments) {
        const page = parseGraphSharePendingSignedCandidateQueue(
          JSON.parse(yield* fs.readFileString(path.join(`${pendingPath}.d`, `${segment.id}.json`))),
        );
        recovered.push(...page.candidates);
      }
      expect(EffectArray.map(recovered, candidate => candidate.actionKey)).toEqual(
        EffectArray.map(additions, candidate => candidate.actionKey),
      );
      const final = EffectArray.map(recovered, candidate => ({
        ...candidate,
        graphAbi: candidateFixture.graphAbi,
        partialCoverage: false,
        resourceLimits: [],
        snapshotId: snapshot.id,
      }));
      expect((yield* persistGraphShareSignedCandidates(home, repositoryId, final)).queued).toBe(600);
      const ids = yield* listGraphShareSignedCandidatePageIds(home, repositoryId);
      expect(ids.length).toBeGreaterThan(1);
      const pages = [];
      for (const id of ids) pages.push((yield* readGraphShareSignedCandidatePage(home, repositoryId, id))!);
      expect(
        EffectArray.map(
          EffectArray.flatMap(pages, page => page.candidates),
          candidate => candidate.actionKey,
        ),
      ).toEqual(EffectArray.map(additions, candidate => candidate.actionKey));
      const identity = graphShareSignedCandidateIdentity(pages[0].candidates[0]);
      expect(
        (yield* acknowledgeGraphShareSignedCandidatePage(home, repositoryId, ids[0], new Set([identity]))).acknowledged,
      ).toBe(1);
      expect(
        (yield* acknowledgeGraphShareSignedCandidatePage(home, repositoryId, ids[0], new Set([identity]))).absent,
      ).toBe(true);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('reconciles 520 committed source files from durable pending pages after producer restart', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const files = new Map<string, CodeGraphInventoryFile>();
      const factsByPath = new Map<string, typeof facts>();
      const pending: GraphSharePendingSignedCandidate[] = [];
      for (let index = 0; index < 520; index++) {
        const filePath = `src/file-${index}.ts`;
        const gitBlobId = Effect2.pipe((index + 1).toString(16), EffectString.padStart(40, '0'));
        const fileContentHash = codeGraphCommittedContentHash('sha1', gitBlobId);
        const fileFacts = {...facts, path: filePath};
        const key = graphShareParseActionKey({
          contentHash: fileContentHash,
          extractorSet: packs[0].cacheIdentity,
          languageAndRole: 'typescript:source',
          normalizedPath: filePath,
          repositoryId,
        });
        const artifact = graphShareParseResultArtifact({
          actionKey: key,
          contentHash: fileContentHash,
          extractorSet: packs[0].cacheIdentity,
          facts: fileFacts,
          gitBlobId,
          languageAndRole: 'typescript:source',
          normalizedPath: filePath,
          repositoryId,
        });
        const bytes = new TextEncoder().encode(canonicalJson(artifact));
        pending.push({
          ...f.pending,
          actionKey: key,
          resultDigest: yield* putCasBytes(f.casRoot, bytes),
          resultSize: bytes.byteLength,
          semanticDigest: artifact.semanticDigest,
        });
        files.set(filePath, {...file, blobId: gitBlobId, contentHash: fileContentHash, path: filePath});
        factsByPath.set(filePath, fileFacts);
      }
      expect(
        (yield* persistGraphSharePendingSignedCandidates({
          candidates: pending,
          repositoryId,
          threadnoteHome: f.home,
        })).queued,
      ).toBe(520);
      const restartedStore = {
        snapshotPackProvenance: () => Effect.succeed(packs),
        effectiveSnapshotFilesByPaths: (_databasePath: string, _snapshotId: string, paths: readonly string[]) =>
          Effect.succeed(EffectArray.map(paths, filePath => ({path: filePath, file: files.get(filePath)}))),
        loadCachedFacts: (_databasePath, selected) =>
          Effect.succeed({
            bytes: 0,
            facts: new Map(EffectArray.map(selected, item => [item.path, factsByPath.get(item.path) ?? facts])),
          }),
      } satisfies GraphShareSignedCandidateStore;
      const finalized = yield* finalizeGraphShareSignedCandidates({
        databasePath: '/exact/ready.sqlite',
        repositoryId,
        skippedFiles: 0,
        snapshot: {...snapshot, fileCount: 520},
        store: restartedStore,
        threadnoteHome: f.home,
      });
      expect(finalized).toEqual({examined: 520, queued: 520, verified: 520});
      const ids = yield* listGraphShareSignedCandidatePageIds(f.home, repositoryId);
      const observed: string[] = [];
      for (const id of ids) {
        const page = yield* readGraphShareSignedCandidatePage(f.home, repositoryId, id);
        observed.push(
          ...(EffectOption.getOrUndefined(
            EffectOption.map(EffectOption.fromNullishOr(page?.candidates), __effectArrayReceiver =>
              EffectArray.map(__effectArrayReceiver, candidate => candidate.actionKey),
            ),
          ) ?? []),
        );
      }
      expect(observed).toEqual(EffectArray.map(pending, candidate => candidate.actionKey));
      const pendingManifest = JSON.parse(
        yield* f.fs.readFileString(pendingCandidateQueuePath(f.path, f.home, repositoryId)),
      );
      expect(pendingManifest.segments).toEqual([]);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('recovers an orphaned segment and a final append interrupted before pending acknowledgement', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const pendingPath = pendingCandidateQueuePath(f.path, f.home, repositoryId);
      const orphan = {...f.pending, actionKey: Effect2.pipe('0', EffectString.repeat(64))};
      const orphanBytes = `${JSON.stringify({candidates: [orphan], schemaVersion: 1})}\n`;
      const orphanPath = f.path.join(`${pendingPath}.d`, `${sha256HexSync(orphanBytes)}.json`);
      yield* f.fs.makeDirectory(f.path.dirname(orphanPath), {recursive: true});
      yield* f.fs.writeFileString(orphanPath, orphanBytes);
      yield* persistGraphSharePendingSignedCandidates({candidates: [f.pending], repositoryId, threadnoteHome: f.home});
      expect(yield* f.fs.exists(orphanPath)).toBe(false);
      const finished = {
        ...f.pending,
        graphAbi: codeGraphCheckpointAbiDigestV1(codeGraphCheckpointAbiInputV1(packs)).digest,
        partialCoverage: false,
        resourceLimits: [],
        snapshotId: snapshot.id,
      };
      yield* persistGraphShareSignedCandidates(f.home, repositoryId, [finished]);
      const replay = yield* finalizeGraphShareSignedCandidates({
        databasePath: '/exact/ready.sqlite',
        repositoryId,
        skippedFiles: 0,
        snapshot,
        store: f.store,
        threadnoteHome: f.home,
      });
      expect(replay).toEqual({examined: 1, queued: 0, verified: 1});
      expect(yield* listGraphShareSignedCandidatePageIds(f.home, repositoryId)).toHaveLength(1);
      const pendingManifest = JSON.parse(yield* f.fs.readFileString(pendingPath));
      expect(pendingManifest.segments).toEqual([]);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('deduplicates overlapping batches and rereads a rewritten page for the second acknowledgement', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const a = {...f.pending, actionKey: Effect2.pipe('1', EffectString.repeat(64))};
      const b = {...f.pending, actionKey: Effect2.pipe('2', EffectString.repeat(64))};
      const c = {...f.pending, actionKey: Effect2.pipe('3', EffectString.repeat(64))};
      expect(
        (yield* persistGraphSharePendingSignedCandidates({
          candidates: [a, b],
          repositoryId,
          threadnoteHome: f.home,
        })).queued,
      ).toBe(2);
      expect(
        (yield* persistGraphSharePendingSignedCandidates({
          candidates: [a, c],
          repositoryId,
          threadnoteHome: f.home,
        })).queued,
      ).toBe(1);
      const final = (candidate: GraphSharePendingSignedCandidate): GraphShareSignedCandidateV2 => ({
        ...candidate,
        graphAbi: candidateFixture.graphAbi,
        partialCoverage: false,
        resourceLimits: [],
        snapshotId: snapshot.id,
      });
      expect((yield* persistGraphShareSignedCandidates(f.home, repositoryId, [final(a), final(b)])).queued).toBe(2);
      expect((yield* persistGraphShareSignedCandidates(f.home, repositoryId, [final(a), final(c)])).queued).toBe(1);
      const ids = yield* listGraphShareSignedCandidatePageIds(f.home, repositoryId);
      const first = (yield* readGraphShareSignedCandidatePage(f.home, repositoryId, ids[0]))!;
      expect(EffectArray.map(first.candidates, candidate => candidate.actionKey)).toEqual([a.actionKey, b.actionKey]);
      const second = (yield* readGraphShareSignedCandidatePage(f.home, repositoryId, ids[1]))!;
      expect(EffectArray.map(second.candidates, candidate => candidate.actionKey)).toEqual([c.actionKey]);
      expect(
        (yield* acknowledgeGraphShareSignedCandidatePage(
          f.home,
          repositoryId,
          first.id,
          new Set([graphShareSignedCandidateIdentity(final(a))]),
        )).acknowledged,
      ).toBe(1);
      const stale = yield* acknowledgeGraphShareSignedCandidatePage(
        f.home,
        repositoryId,
        first.id,
        new Set([graphShareSignedCandidateIdentity(final(b))]),
      );
      expect(stale).toEqual({acknowledged: 0, absent: false});
      const currentIds = yield* listGraphShareSignedCandidatePageIds(f.home, repositoryId);
      const replacement = (yield* readGraphShareSignedCandidatePage(f.home, repositoryId, currentIds[0]))!;
      expect(EffectArray.map(replacement.candidates, candidate => candidate.actionKey)).toEqual([b.actionKey]);
      expect(
        (yield* acknowledgeGraphShareSignedCandidatePage(
          f.home,
          repositoryId,
          replacement.id,
          new Set([graphShareSignedCandidateIdentity(final(b))]),
        )).acknowledged,
      ).toBe(1);
      expect(
        (yield* acknowledgeGraphShareSignedCandidatePage(
          f.home,
          repositoryId,
          first.id,
          new Set([graphShareSignedCandidateIdentity(final(b))]),
        )).absent,
      ).toBe(true);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('rejects a symlinked segment directory before touching its target', () =>
    Effect.gen(function* () {
      if ((yield* SystemInfo).platform === 'win32') return;
      const f = yield* fixture();
      const pendingPath = pendingCandidateQueuePath(f.path, f.home, repositoryId);
      const outside = f.path.join(f.home, 'outside');
      yield* f.fs.makeDirectory(outside);
      const marker = f.path.join(outside, 'marker.txt');
      yield* f.fs.writeFileString(marker, 'unchanged');
      yield* f.fs.makeDirectory(f.path.dirname(pendingPath), {recursive: true});
      yield* f.fs.symlink(outside, `${pendingPath}.d`);
      const attempt = yield* Effect.exit(
        persistGraphSharePendingSignedCandidates({
          candidates: [f.pending],
          repositoryId,
          threadnoteHome: f.home,
        }),
      );
      expect(attempt._tag).toBe('Failure');
      if (attempt._tag === 'Failure') expect(Cause.pretty(attempt.cause)).toContain('symbolic link');
      expect(yield* f.fs.readFileString(marker)).toBe('unchanged');
      expect(yield* f.fs.exists(pendingPath)).toBe(false);
    }).pipe(provideTestLayer(layer)),
  );

  fcEffectProp(
    effectIt,
    'overlapping journal batches preserve first-seen order without duplicates',
    {
      first: FC.array(FC.integer({min: 0, max: 80}), {maxLength: 45}),
      second: FC.array(FC.integer({min: 0, max: 80}), {maxLength: 45}),
    },
    ({first, second}) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-signed-journal-property-'});
        const additions = EffectArray.map([...first, ...second], index => ({
          ...pendingFixture,
          actionKey: Effect2.pipe(index.toString(16), EffectString.padStart(64, '0')),
        }));
        const before = JSON.stringify(additions);
        yield* persistGraphSharePendingSignedCandidates({
          candidates: additions.slice(0, first.length),
          repositoryId,
          threadnoteHome: home,
        });
        const secondAdmission = yield* persistGraphSharePendingSignedCandidates({
          candidates: additions.slice(first.length),
          repositoryId,
          threadnoteHome: home,
        });
        expect(secondAdmission.queued).toBe(new Set([...first, ...second]).size - new Set(first).size);
        expect(
          (yield* persistGraphSharePendingSignedCandidates({
            candidates: additions,
            repositoryId,
            threadnoteHome: home,
          })).queued,
        ).toBe(0);
        expect(JSON.stringify(additions)).toBe(before);
        const pendingPath = pendingCandidateQueuePath(path, home, repositoryId);
        if (additions.length === 0) {
          expect(yield* fs.exists(pendingPath)).toBe(false);
          return;
        }
        const manifest = JSON.parse(yield* fs.readFileString(pendingPath));
        const observed: string[] = [];
        for (const segment of manifest.segments) {
          const page = parseGraphSharePendingSignedCandidateQueue(
            JSON.parse(yield* fs.readFileString(path.join(`${pendingPath}.d`, `${segment.id}.json`))),
          );
          observed.push(...EffectArray.map(page.candidates, candidate => candidate.actionKey));
        }
        expect(observed).toEqual([...new Set(EffectArray.map(additions, candidate => candidate.actionKey))]);
      }).pipe(provideTestLayer(layer)),
    {fastCheck: {numRuns: 20}},
  );

  it('discards pre-release final v1 evidence and rejects unsupported fields or commit/batch mismatch', () => {
    expect(parseGraphShareSignedCandidateQueue({candidates: [candidateFixture], schemaVersion: 1})).toEqual({
      candidates: [],
      schemaVersion: 2,
    });
    expect(() =>
      parseGraphShareSignedCandidateQueue({candidates: [{...candidateFixture, invented: true}], schemaVersion: 2}),
    ).toThrow();
    expect(() =>
      parseGraphSharePendingSignedCandidateQueue({candidates: [{...pendingFixture, invented: true}], schemaVersion: 1}),
    ).toThrow();
    expect(() =>
      parseGraphSharePendingSignedCandidateQueue({
        candidates: [{...pendingFixture, batchId: Effect2.pipe('0', EffectString.repeat(40))}],
        schemaVersion: 1,
      }),
    ).toThrow();
  });
});
