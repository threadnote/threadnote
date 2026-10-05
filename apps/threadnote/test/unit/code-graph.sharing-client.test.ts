import {TestCommandExecutorLayer} from '../helpers/system-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import * as BunHttpClient from '@effect/platform-bun/BunHttpClient';
import * as BunHttpServer from '@effect/platform-bun/BunHttpServer';
import * as HttpServer from 'effect/http/HttpServer';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {it} from 'vitest';
import {Effect, FileSystem, Layer, Path, Schema} from 'effect';
import * as FC from 'fast-check';
import {TestClock} from 'effect/testing';
import {readFile} from '@threadnote/testing/node-fs-promises';
import {dirname, join} from '@threadnote/testing/node-path';
import {fileURLToPath} from '@threadnote/testing/node-url';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {codeGraphCheckpointFileFactCacheIdentity} from '@threadnote/graph/checkpoint/file_fact_identity';
import {encodeCodeGraphCheckpointPackV1} from '@threadnote/graph/checkpoint/pack';
import {
  generateGraphSharePublisherKey,
  parseGraphShareFrontierManifest,
  signGraphShareFrontier,
  type GraphShareFrontierManifestV1,
  type GraphShareFrontierPointerV1,
  type GraphShareSignatureEnvelopeV1,
} from '@threadnote/graph/sharing/artifacts';
import {putCasBytes, putCasFile} from '@threadnote/graph/sharing/cas';
import {putGraphShareCheckpointLayers} from '@threadnote/graph/sharing/checkpoint_cas';
import {
  maybeImportSharedGraphBase,
  captureSharedGraphImportBase,
  runGraphShareStatus,
  selectPublishedAncestorManifest,
} from '@threadnote/graph/sharing/client';
import {sha256Digest, sha256HexFromDigest} from '@threadnote/graph/sharing/digest';
import {GraphSharingError, graphSharingFailure} from '@threadnote/graph/sharing/errors';
import {acceptGraphShareFrontier, readAcceptedGraphShareFrontier} from '@threadnote/graph/sharing/frontier_acceptance';
import {
  graphSharingCasBlobPath,
  graphSharingLayout,
  graphSharingProvenancePath,
} from '@threadnote/graph/sharing/layout';
import {
  casProfilePointer,
  defaultGraphShareProfile,
  graphShareProfileDigest,
  parseGraphShareEnrollment,
} from '@threadnote/graph/sharing/profile';
import {
  loadSharedGraphQuerySource,
  readSharedGraphImportAttempt,
  readSharedGraphProvenance,
  writeSharedGraphImportAttempt,
  writeSharedGraphProvenance,
} from '@threadnote/graph/sharing/provenance';
import {
  trustReceiptFromEnrollment,
  writeGraphShareClientState,
  writeGraphShareTrustReceipt,
} from '@threadnote/graph/sharing/trust';
import type {RepositoryIdentity} from '@threadnote/graph/types';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {runCommandEffect} from '@threadnote/platform/command';

import {CodeGraphLanguagePackRegistry} from '@threadnote/graph/languages/registry';
import {CodeGraphMaintenanceCoordinator} from '@threadnote/graph/maintenance/coordinator';
import {CodeGraphStore} from '@threadnote/graph/store';

const sharingLayer = CodeGraphMaintenanceCoordinator.layer.pipe(
  Layer.provideMerge(CodeGraphLanguagePackRegistry.layer),
  Layer.provideMerge(Layer.merge(CodeGraphStore.layer, TestCommandExecutorLayer)),
  Layer.provideMerge(TestSystemInfoLayer),
  Layer.provideMerge(BunServices.layer),
  Layer.provideMerge(BunHttpClient.layer),
);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const REPOSITORY_ID = 'b'.repeat(64);
const CHECKOUT_ID = 'c'.repeat(64);
const CHECKPOINT_BYTES = new TextEncoder().encode('not-a-checkpoint');

describe('graph share import and inspect source', () => {
  it('does not start shared graph import from recall', async () => {
    const [indexer, recall, memory] = await Promise.all([
      readFile(join(repoRoot, 'packages/graph/src/indexer/service.ts'), 'utf8'),
      readFile(join(repoRoot, 'apps/threadnote/src/mcp/server/recall.ts'), 'utf8'),
      readFile(join(repoRoot, 'apps/threadnote/src/mcp/server/memory.ts'), 'utf8'),
    ]);
    expect(indexer).toContain('captureSharedGraphImportBase');
    expect(recall).not.toContain('captureSharedGraphImportBase');
    expect(recall).not.toContain('maybeImportSharedGraphBase');
    expect(memory).not.toContain('maybeImportSharedGraphBase');
    expect(memory).not.toContain('captureSharedGraphImportBase');
    const ensureCommit = indexer.slice(indexer.indexOf('const ensureCommitWithSummary'));
    expect(ensureCommit.indexOf('captureSharedGraphImportBase')).toBeGreaterThan(-1);
    expect(ensureCommit.indexOf('captureSharedGraphImportBase')).toBeLessThan(
      ensureCommit.indexOf('withCodeGraphProcessLock'),
    );
    expect(ensureCommit.indexOf('hydrateSharedParseCache')).toBeLessThan(
      ensureCommit.indexOf('withCodeGraphProcessLock'),
    );
  });

  effectIt.effect('omits inspect source when provenance is corrupt, untrusted, or not the selected snapshot', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-source-'});
      const layout = graphSharingLayout(path, home);
      const provenancePath = graphSharingProvenancePath(path, layout.provenanceRoot, CHECKOUT_ID);
      yield* fs.makeDirectory(path.dirname(provenancePath), {recursive: true, mode: 0o700});
      yield* fs.writeFileString(provenancePath, '{not-json', {mode: 0o600});
      expect(
        yield* loadSharedGraphQuerySource({
          checkoutId: CHECKOUT_ID,
          localCommit: 'a'.repeat(40),
          repositoryId: REPOSITORY_ID,
          snapshot: {id: 'cgsn_imported'},
          threadnoteHome: home,
        }),
      ).toBeUndefined();
      const enrolled = yield* enrolledHome(home, {includeFrontier: false});
      yield* writeSharedGraphProvenance(home, CHECKOUT_ID, {
        checkpointDigest: sha256Digest(CHECKPOINT_BYTES),
        deltaCount: 2,
        frontierCommit: 'a'.repeat(40),
        profileDigest: enrolled.profileDigest,
        repositoryId: REPOSITORY_ID,
        schemaVersion: 1,
        snapshotId: 'cgsn_imported',
      });
      expect(
        yield* loadSharedGraphQuerySource({
          checkoutId: CHECKOUT_ID,
          localCommit: 'a'.repeat(40),
          repositoryId: REPOSITORY_ID,
          snapshot: {id: 'cgsn_local'},
          threadnoteHome: home,
        }),
      ).toBeUndefined();
      expect(
        yield* loadSharedGraphQuerySource({
          checkoutId: CHECKOUT_ID,
          localCommit: 'a'.repeat(40),
          repositoryId: REPOSITORY_ID,
          snapshot: {baseSnapshotId: 'cgsn_imported', id: 'cgsn_overlay'},
          threadnoteHome: home,
        }),
      ).toMatchObject({
        deltaCount: 2,
        kind: 'shared-base-plus-local-overlay',
        profileDigest: enrolled.profileDigest,
      });
    }).pipe(provideTestLayer(sharingLayer)),
  );

  effectIt.effect('skips missing frontiers without quarantine and does not re-hash an installed checkpoint', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-import-'});
      const enrolled = yield* enrolledHome(home, {includeFrontier: false});
      const missing = yield* maybeImportSharedGraphBase(importRequest(enrolled.repo, home));
      expect(missing).toEqual({imported: false, reason: 'unavailable'});
      expect(yield* quarantineNames(home)).toEqual([]);
      const published = yield* enrolledHome(home, {includeFrontier: true, skipCheckpoint: true});
      yield* writeSharedGraphProvenance(home, CHECKOUT_ID, {
        checkpointDigest: published.checkpointDigest,
        deltaCount: 0,
        frontierCommit: 'a'.repeat(40),
        profileDigest: published.profileDigest,
        repositoryId: REPOSITORY_ID,
        schemaVersion: 1,
        snapshotId: 'cgsn_imported',
      });
      const skipped = yield* maybeImportSharedGraphBase(importRequest(published.repo, home));
      expect(skipped).toEqual({
        imported: false,
        reason: 'already-installed',
        snapshotId: 'cgsn_imported',
        checkpointDigest: published.checkpointDigest,
        atGeneration: 1,
      });
      expect(yield* quarantineNames(home)).toEqual([]);
    }).pipe(provideTestLayer(sharingLayer)),
  );

  effectIt.effect('imports a later compaction frontier after a prior checkpoint install', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-compact-apply-'});
      const published = yield* enrolledHome(home, {includeFrontier: true, skipCheckpoint: true});
      yield* writeSharedGraphProvenance(home, CHECKOUT_ID, {
        checkpointDigest: published.checkpointDigest,
        deltaCount: 0,
        frontierCommit: 'a'.repeat(40),
        profileDigest: published.profileDigest,
        repositoryId: REPOSITORY_ID,
        schemaVersion: 1,
        snapshotId: 'cgsn_imported',
      });
      const nextDigest = sha256Digest(new TextEncoder().encode('compact-checkpoint'));
      const compact: GraphShareFrontierManifestV1 = {
        branch: 'refs/heads/main',
        checkpoint: {
          manifestDigest: nextDigest,
          snapshotId: 'cgsn_compacted',
          sourceCommit: 'a'.repeat(40),
        },
        deltas: [],
        generation: 2,
        graphAbi: 'e'.repeat(64),
        graphContentId: `cgc_${'d'.repeat(40)}`,
        logicalGraphDigest: `sha256:${'2'.repeat(64)}`,
        previousManifestDigest: published.manifestDigest,
        profileDigest: published.profileDigest,
        publisherFence: 1,
        repositoryId: REPOSITORY_ID,
        schemaVersion: 1,
        snapshotId: 'cgsn_compacted',
        sourceCommit: 'a'.repeat(40),
      };
      const signed = yield* signGraphShareFrontier(published.key, compact);
      const manifestDigest = yield* putCasBytes(published.casRoot, new TextEncoder().encode(canonicalJson(compact)));
      const envelopeDigest = yield* putCasBytes(
        published.casRoot,
        new TextEncoder().encode(canonicalJson(signed.envelope)),
      );
      const layout = graphSharingLayout(path, home, published.casRoot);
      yield* fs.writeFileString(
        path.join(layout.frontiersRoot, REPOSITORY_ID, 'latest.json'),
        `${JSON.stringify({envelopeDigest, manifestDigest, schemaVersion: 1})}\n`,
      );
      const result = yield* maybeImportSharedGraphBase(importRequest(published.repo, home));
      expect(result).toEqual({imported: false, reason: 'unavailable'});
      expect(yield* quarantineNames(home)).toEqual([]);
    }).pipe(provideTestLayer(sharingLayer)),
  );

  effectIt.effect('skips import when the trust pin disagrees with enrollment', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-pin-'});
      const enrolled = yield* enrolledHome(home, {includeFrontier: true, skipCheckpoint: true});
      yield* writeGraphShareTrustReceipt(home, {
        ...trustReceiptFromEnrollment(enrolled.enrollment, enrolled.profile, enrolled.profileDigest, 'read-only'),
        publisherKeyFingerprint: `sha256:${'f'.repeat(64)}`,
      });
      const result = yield* maybeImportSharedGraphBase(importRequest(enrolled.repo, home));
      expect(result).toEqual({imported: false, reason: 'trust-pin-mismatch'});
      expect(yield* quarantineNames(home)).toEqual([]);
    }).pipe(provideTestLayer(sharingLayer)),
  );

  effectIt.effect('quarantines signature failures once per repository and always deletes the spool', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-quarantine-'});
      const enrolled = yield* enrolledHome(home, {includeFrontier: true, skipCheckpoint: true});
      const tampered: GraphShareSignatureEnvelopeV1 = {
        ...enrolled.envelope,
        signature: flipHex(enrolled.envelope.signature),
      };
      const envelopeDigest = yield* putCasBytes(enrolled.casRoot, new TextEncoder().encode(canonicalJson(tampered)));
      const layout = graphSharingLayout(path, home, enrolled.casRoot);
      yield* fs.writeFileString(
        path.join(layout.frontiersRoot, REPOSITORY_ID, 'latest.json'),
        `${JSON.stringify({
          envelopeDigest,
          manifestDigest: enrolled.manifestDigest,
          schemaVersion: 1,
        })}\n`,
      );
      const first = yield* maybeImportSharedGraphBase(importRequest(enrolled.repo, home));
      const second = yield* maybeImportSharedGraphBase(importRequest(enrolled.repo, home));
      expect(first).toEqual({imported: false, reason: 'quarantined'});
      expect(second).toEqual({imported: false, reason: 'quarantined'});
      expect(yield* quarantineNames(home)).toEqual([`${REPOSITORY_ID}.json`]);
      const failed = yield* enrolledHome(home, {includeFrontier: true, skipCheckpoint: false});
      yield* maybeImportSharedGraphBase(importRequest(failed.repo, home)).pipe(Effect.exit);
      const downloads = path.join(graphSharingLayout(path, home).root, 'downloads');
      const leftover = (yield* fs.exists(downloads)) ? yield* fs.readDirectory(downloads) : [];
      expect([...leftover]).toEqual([]);
    }).pipe(provideTestLayer(sharingLayer)),
  );

  effectIt.effect('treats a missing checkpoint CAS blob as unavailable without quarantine', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-missing-cas-'});
      const enrolled = yield* enrolledHome(home, {includeFrontier: true, skipCheckpoint: true});
      const result = yield* maybeImportSharedGraphBase(importRequest(enrolled.repo, home));
      expect(result).toEqual({imported: false, reason: 'unavailable'});
      expect(yield* quarantineNames(home)).toEqual([]);
    }).pipe(provideTestLayer(sharingLayer)),
  );

  effectIt.effect('rejects a validly signed frontier for another branch before using prior provenance', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-branch-'});
      const enrolled = yield* enrolledHome(home, {includeFrontier: true, skipCheckpoint: true});
      yield* writeSharedGraphProvenance(home, CHECKOUT_ID, {
        checkpointDigest: enrolled.checkpointDigest,
        deltaCount: 0,
        frontierCommit: enrolled.manifest.sourceCommit,
        profileDigest: enrolled.profileDigest,
        repositoryId: REPOSITORY_ID,
        schemaVersion: 1,
        snapshotId: enrolled.manifest.snapshotId,
      });
      const signed = yield* signGraphShareFrontier(enrolled.key, {
        ...enrolled.manifest,
        branch: 'refs/heads/unrelated',
      });
      const manifestDigest = yield* putCasBytes(
        enrolled.casRoot,
        new TextEncoder().encode(canonicalJson(signed.manifest)),
      );
      const envelopeDigest = yield* putCasBytes(
        enrolled.casRoot,
        new TextEncoder().encode(canonicalJson(signed.envelope)),
      );
      const pointer = path.join(
        graphSharingLayout(path, home, enrolled.casRoot).frontiersRoot,
        REPOSITORY_ID,
        'latest.json',
      );
      yield* fs.writeFileString(pointer, JSON.stringify({envelopeDigest, manifestDigest, schemaVersion: 1}));
      expect(yield* maybeImportSharedGraphBase(importRequest(enrolled.repo, home))).toEqual({
        imported: false,
        reason: 'quarantined',
      });
      expect((yield* readSharedGraphProvenance(home, CHECKOUT_ID))?.snapshotId).toBe(enrolled.manifest.snapshotId);
    }).pipe(provideTestLayer(sharingLayer)),
  );

  effectIt.effect('quarantines a mutated checkpoint blob and leaves prior provenance snapshot id unchanged', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-cas-tamper-'});
      const enrolled = yield* enrolledHome(home, {includeFrontier: true, skipCheckpoint: false});
      yield* fs.writeFile(
        graphSharingCasBlobPath(path, enrolled.casRoot, sha256HexFromDigest(enrolled.checkpointDigest)),
        new TextEncoder().encode('mutated-checkpoint'),
      );
      yield* writeSharedGraphProvenance(home, CHECKOUT_ID, {
        checkpointDigest: `sha256:${'9'.repeat(64)}`,
        deltaCount: 0,
        frontierCommit: 'a'.repeat(40),
        profileDigest: enrolled.profileDigest,
        repositoryId: REPOSITORY_ID,
        schemaVersion: 1,
        snapshotId: 'cgsn_previous',
      });
      const result = yield* maybeImportSharedGraphBase(importRequest(enrolled.repo, home));
      expect(result).toEqual({imported: false, reason: 'quarantined'});
      expect(yield* quarantineNames(home)).toEqual([`${REPOSITORY_ID}.json`]);
      expect((yield* readSharedGraphProvenance(home, CHECKOUT_ID))?.snapshotId).toBe('cgsn_previous');
      expect(
        yield* loadSharedGraphQuerySource({
          checkoutId: CHECKOUT_ID,
          localCommit: 'a'.repeat(40),
          repositoryId: REPOSITORY_ID,
          snapshot: {id: 'cgsn_imported'},
          threadnoteHome: home,
        }),
      ).toBeUndefined();
    }).pipe(provideTestLayer(sharingLayer)),
  );

  effectIt.effect('seeds the legacy baseline before remote discovery and never publishes rejected candidates', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-frontier-upgrade-'});
        const f = yield* enrolledHome(home, {includeFrontier: true, skipCheckpoint: true});
        const store = (generation: number, branch = 'refs/heads/main') =>
          Effect.gen(function* () {
            const signed = yield* signGraphShareFrontier(f.key, {
              ...f.manifest,
              branch,
              generation,
              previousManifestDigest: f.manifestDigest,
            });
            return {
              envelopeDigest: yield* putCasBytes(f.casRoot, new TextEncoder().encode(canonicalJson(signed.envelope))),
              manifestDigest: yield* putCasBytes(f.casRoot, new TextEncoder().encode(canonicalJson(signed.manifest))),
              schemaVersion: 1 as const,
            };
          });
        const baseline = yield* store(10);
        let remote: GraphShareFrontierPointerV1 = yield* store(5);
        const pointerPath = path.join(
          graphSharingLayout(path, home, f.casRoot).frontiersRoot,
          REPOSITORY_ID,
          'latest.json',
        );
        const legacy = JSON.stringify(baseline);
        yield* fs.writeFileString(pointerPath, legacy);
        const context = yield* Layer.build(BunHttpServer.layer({hostname: '127.0.0.1', port: 0}));
        const server = yield* HttpServer.HttpServer.pipe(Effect.provide(context));
        let remoteRequests = 0;
        yield* server.serve(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            remoteRequests += 1;
            return request.url.startsWith('/v1/frontiers/')
              ? HttpServerResponse.jsonUnsafe(remote)
              : HttpServerResponse.empty({status: 404});
          }),
        );
        if (server.address._tag === 'UnixPathAddress') return yield* graphSharingFailure('Expected TCP fixture.');
        yield* writeGraphShareTrustReceipt(home, {
          ...trustReceiptFromEnrollment(f.enrollment, f.profile, f.profileDigest, 'read-only'),
          client: {
            casRoot: f.casRoot,
            contributionMode: 'off',
            coordinatorUrl: 'http://127.0.0.1:' + server.address.port,
          },
        });
        yield* writeSharedGraphProvenance(home, CHECKOUT_ID, {
          checkpointDigest: f.checkpointDigest,
          deltaCount: 0,
          frontierCommit: f.manifest.sourceCommit,
          profileDigest: f.profileDigest,
          repositoryId: REPOSITORY_ID,
          schemaVersion: 1,
          snapshotId: f.manifest.snapshotId,
        });
        const scope = {
          branch: f.manifest.branch,
          profileDigest: f.profileDigest,
          repositoryId: REPOSITORY_ID,
          publisherKeyFingerprint: f.key.fingerprint,
        };
        let failedCommit = false;
        const failingOnce = {
          ...fs,
          rename: (from: string, to: string) => {
            if (!failedCommit && to.startsWith(path.join(home, 'graph-sharing', 'accepted-frontiers'))) {
              failedCommit = true;
              return graphSharingFailure('Synthetic baseline persistence failure.');
            }
            return fs.rename(from, to);
          },
        };
        expect(
          yield* maybeImportSharedGraphBase(importRequest(f.repo, home)).pipe(
            Effect.provideService(FileSystem.FileSystem, failingOnce),
          ),
        ).toEqual({imported: false, reason: 'quarantined'});
        expect(failedCommit).toBe(true);
        expect(remoteRequests).toBe(0);
        expect(yield* readAcceptedGraphShareFrontier(home, scope)).toBeUndefined();
        expect(yield* maybeImportSharedGraphBase(importRequest(f.repo, home))).toEqual({
          imported: false,
          reason: 'quarantined',
        });
        expect((yield* readAcceptedGraphShareFrontier(home, scope))?.generation).toBe(10);
        expect(yield* fs.readFileString(pointerPath)).toBe(legacy);
        yield* fs.remove(graphSharingCasBlobPath(path, f.casRoot, sha256HexFromDigest(baseline.manifestDigest)));
        expect(yield* maybeImportSharedGraphBase(importRequest(f.repo, home))).toEqual({
          imported: false,
          reason: 'quarantined',
        });
        expect((yield* readAcceptedGraphShareFrontier(home, scope))?.generation).toBe(10);
        remote = yield* store(11, 'refs/heads/other');
        expect(yield* maybeImportSharedGraphBase(importRequest(f.repo, home))).toEqual({
          imported: false,
          reason: 'quarantined',
        });
        expect((yield* readAcceptedGraphShareFrontier(home, scope))?.generation).toBe(10);
        remote = yield* store(12);
        expect(yield* maybeImportSharedGraphBase(importRequest(f.repo, home))).toMatchObject({
          imported: false,
          reason: 'already-installed',
          atGeneration: 12,
        });
        expect((yield* readAcceptedGraphShareFrontier(home, scope))?.generation).toBe(12);
        expect(yield* fs.readFileString(pointerPath)).toBe(legacy);
      }).pipe(provideTestLayer(sharingLayer)),
    ),
  );

  effectIt.effect('reports accepted discovery ahead of legacy metadata and independently of last import', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-frontier-status-'});
        const repo = path.join(home, 'repository');
        yield* fs.makeDirectory(repo);
        yield* git(repo, ['init', '-q', '--initial-branch=main']);
        yield* git(repo, ['remote', 'add', 'origin', 'https://github.com/acme/graph-share.git']);
        const identity = yield* resolveRepositoryIdentity(repo);
        const f = yield* enrolledHome(home, {includeFrontier: true, repositoryId: identity.repositoryId});
        const pointerPath = path.join(
          graphSharingLayout(path, home, f.casRoot).frontiersRoot,
          identity.repositoryId,
          'latest.json',
        );
        const status = () => runGraphShareStatus(runtimeConfig(home), {cwd: repo, json: true});
        const legacy = JSON.parse(yield* fs.readFileString(pointerPath));
        expect((yield* status()).frontier).toEqual(legacy);
        const signed = yield* signGraphShareFrontier(f.key, {
          ...f.manifest,
          generation: 12,
          previousManifestDigest: f.manifestDigest,
        });
        const next = {
          envelopeDigest: yield* putCasBytes(f.casRoot, new TextEncoder().encode(canonicalJson(signed.envelope))),
          manifestDigest: yield* putCasBytes(f.casRoot, new TextEncoder().encode(canonicalJson(signed.manifest))),
          schemaVersion: 1 as const,
        };
        yield* acceptGraphShareFrontier({
          casRoot: f.casRoot,
          home,
          pointer: next,
          scope: {
            branch: f.manifest.branch,
            profileDigest: f.profileDigest,
            publisherKeyFingerprint: f.key.fingerprint,
            repositoryId: identity.repositoryId,
          },
        });
        yield* writeSharedGraphImportAttempt(home, identity.checkoutId, {imported: false, reason: 'unavailable'});
        expect(yield* status()).toMatchObject({frontier: next, lastImport: {imported: false, reason: 'unavailable'}});
        yield* fs.writeFileString(pointerPath, '{invalid legacy');
        expect((yield* status()).frontier).toEqual(next);
        yield* fs.remove(pointerPath);
        expect((yield* status()).frontier).toEqual(next);
      }).pipe(provideTestLayer(sharingLayer)),
    ),
  );

  effectIt.effect('walks signed predecessor frontiers until HEAD is an ancestor', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-ancestor-'});
      const repo = path.join(home, 'repo');
      yield* fs.makeDirectory(path.join(repo, 'src'), {recursive: true});
      yield* fs.writeFileString(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
      yield* git(repo, ['init', '-q', '--initial-branch=main']);
      yield* git(repo, ['add', '.']);
      yield* git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@threadnote.local', 'commit', '-qm', 'one']);
      const first = (yield* runCommandEffect('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
      yield* fs.writeFileString(path.join(repo, 'src', 'b.ts'), 'export const b = 2;\n');
      yield* git(repo, ['add', '.']);
      yield* git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@threadnote.local', 'commit', '-qm', 'two']);
      const second = (yield* runCommandEffect('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
      const casRoot = path.join(home, 'cas');
      const profileDigest = sha256Digest('profile');
      const gen1 = parseGraphShareFrontierManifest({
        branch: 'refs/heads/main',
        checkpoint: {
          manifestDigest: sha256Digest('c1'),
          snapshotId: 'cgsn_one',
          sourceCommit: first,
        },
        deltas: [],
        generation: 1,
        graphAbi: 'e'.repeat(64),
        graphContentId: `cgc_${'d'.repeat(40)}`,
        logicalGraphDigest: sha256Digest('g1'),
        previousManifestDigest: null,
        profileDigest,
        publisherFence: 1,
        repositoryId: 'b'.repeat(64),
        schemaVersion: 1,
        snapshotId: 'cgsn_one',
        sourceCommit: first,
      });
      const gen1Digest = yield* putCasBytes(casRoot, new TextEncoder().encode(canonicalJson(gen1)));
      const gen2 = parseGraphShareFrontierManifest({
        branch: 'refs/heads/main',
        checkpoint: {
          manifestDigest: sha256Digest('c2'),
          snapshotId: 'cgsn_two',
          sourceCommit: second,
        },
        deltas: [],
        generation: 2,
        graphAbi: 'e'.repeat(64),
        graphContentId: `cgc_${'d'.repeat(40)}`,
        logicalGraphDigest: sha256Digest('g2'),
        previousManifestDigest: gen1Digest,
        profileDigest,
        publisherFence: 1,
        repositoryId: 'b'.repeat(64),
        schemaVersion: 1,
        snapshotId: 'cgsn_two',
        sourceCommit: second,
      });
      yield* git(repo, ['checkout', '-q', first]);
      const identity = {
        branch: 'main',
        caseMode: 'sensitive' as const,
        checkoutId: 'c'.repeat(64),
        displayName: 'graph-share',
        gitCommonDirectory: repo,
        headCommit: first,
        objectFormat: 'sha1' as const,
        remoteIdentity: 'github.com/acme/graph-share',
        repoRoot: repo,
        repositoryId: 'b'.repeat(64),
        worktreeId: 'd'.repeat(64),
      };
      const selected = yield* selectPublishedAncestorManifest(casRoot, identity, gen2);
      expect(selected.sourceCommit).toBe(first);
      expect(selected.generation).toBe(1);
      const unavailable = yield* selectPublishedAncestorManifest(
        casRoot,
        {...identity, headCommit: 'f'.repeat(40)},
        gen1,
      ).pipe(
        Effect.as(false),
        Effect.catchIf(
          error => Schema.is(GraphSharingError)(error) && error.kind === 'unavailable',
          () => Effect.succeed(true),
        ),
      );
      expect(unavailable).toBe(true);
    }).pipe(provideTestLayer(sharingLayer)),
  );

  effectIt.effect('assembles a metadataDigest checkpoint from local layers when the assembled blob is absent', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-layers-import-'});
      const enrolled = yield* enrolledHome(home, {includeFrontier: true, skipCheckpoint: true});
      const pack = encodeCodeGraphCheckpointPackV1(
        clientCheckpointMetadata(3),
        clientCheckpointRecords(['src/a.ts', 'src/b.ts', 'src/c.ts']),
        {limits: {targetUncompressedChunkBytes: 400}},
      );
      expect(pack.header.chunks.length).toBeGreaterThan(1);
      const artifactPath = path.join(home, 'artifact.cgcp');
      yield* fs.writeFile(artifactPath, pack.bytes);
      const artifactDigest = yield* putCasFile(enrolled.casRoot, artifactPath);
      const published = yield* putGraphShareCheckpointLayers(enrolled.casRoot, artifactDigest);
      yield* fs.remove(graphSharingCasBlobPath(path, enrolled.casRoot, sha256HexFromDigest(artifactDigest)));
      const manifest: GraphShareFrontierManifestV1 = {
        branch: 'refs/heads/main',
        checkpoint: {
          manifestDigest: artifactDigest,
          metadataDigest: published.metadataDigest,
          snapshotId: 'cgsn_imported',
          sourceCommit: 'a'.repeat(40),
        },
        deltas: [],
        generation: 1,
        graphAbi: 'e'.repeat(64),
        graphContentId: `cgc_${'d'.repeat(40)}`,
        logicalGraphDigest: `sha256:${'2'.repeat(64)}`,
        previousManifestDigest: null,
        profileDigest: enrolled.profileDigest,
        publisherFence: 1,
        repositoryId: REPOSITORY_ID,
        schemaVersion: 1,
        snapshotId: 'cgsn_imported',
        sourceCommit: 'a'.repeat(40),
      };
      const signed = yield* signGraphShareFrontier(enrolled.key, manifest);
      const manifestDigest = yield* putCasBytes(enrolled.casRoot, new TextEncoder().encode(canonicalJson(manifest)));
      const envelopeDigest = yield* putCasBytes(
        enrolled.casRoot,
        new TextEncoder().encode(canonicalJson(signed.envelope)),
      );
      const layout = graphSharingLayout(path, home, enrolled.casRoot);
      yield* fs.writeFileString(
        path.join(layout.frontiersRoot, REPOSITORY_ID, 'latest.json'),
        `${JSON.stringify({envelopeDigest, manifestDigest, schemaVersion: 1})}\n`,
      );
      const result = yield* maybeImportSharedGraphBase(importRequest(enrolled.repo, home));
      expect(result.imported).toBe(false);
      expect(result.reason).not.toBe('unavailable');
      expect(
        yield* fs.exists(graphSharingCasBlobPath(path, enrolled.casRoot, sha256HexFromDigest(artifactDigest))),
      ).toBe(true);
    }).pipe(provideTestLayer(sharingLayer)),
  );

  effectIt.effect('records lastImport without replacing last-good provenance when transfer misses', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-last-import-'});
      const enrolled = yield* enrolledHome(home, {includeFrontier: false});
      yield* writeSharedGraphProvenance(home, CHECKOUT_ID, {
        checkpointDigest: sha256Digest(CHECKPOINT_BYTES),
        deltaCount: 0,
        frontierCommit: 'a'.repeat(40),
        profileDigest: enrolled.profileDigest,
        repositoryId: REPOSITORY_ID,
        schemaVersion: 1,
        snapshotId: 'cgsn_previous',
      });
      const captured = yield* captureSharedGraphImportBase(importRequest(enrolled.repo, home));
      expect(captured).toEqual({imported: false, reason: 'unavailable'});
      expect((yield* readSharedGraphProvenance(home, CHECKOUT_ID))?.snapshotId).toBe('cgsn_previous');
      expect(yield* readSharedGraphImportAttempt(home, CHECKOUT_ID)).toEqual({
        imported: false,
        reason: 'unavailable',
      });
      yield* git(enrolled.repo, ['init', '-q', '--initial-branch=main']);
      yield* git(enrolled.repo, ['remote', 'add', 'origin', 'https://github.com/acme/graph-share.git']);
      const identity = yield* resolveRepositoryIdentity(enrolled.repo);
      yield* writeSharedGraphImportAttempt(home, identity.checkoutId, {
        imported: false,
        reason: 'unavailable',
      });
      const status = yield* runGraphShareStatus(runtimeConfig(home), {cwd: enrolled.repo, json: true});
      expect(status.lastImport).toEqual({imported: false, reason: 'unavailable'});
      expect(path.join(graphSharingLayout(path, home).attemptsRoot, `${CHECKOUT_ID}.json`)).not.toBe(
        path.join(graphSharingLayout(path, home).provenanceRoot, `${CHECKOUT_ID}.json`),
      );
    }).pipe(provideTestLayer(sharingLayer)),
  );

  fcEffectProp(
    effectIt,
    'already-installed import stays idempotent and keeps provenance snapshot identity',
    {
      suffix: FC.array(FC.constantFrom(...'abcdef0123456789'), {maxLength: 8, minLength: 4}),
    },
    ({suffix}) =>
      Effect.gen(function* () {
        const snapshotId = `cgsn_${'imported'.slice(0, 8)}${suffix.join('')}`.slice(0, 45);
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-idempotent-'});
        const published = yield* enrolledHome(home, {includeFrontier: true, skipCheckpoint: true, snapshotId});
        yield* writeSharedGraphProvenance(home, CHECKOUT_ID, {
          checkpointDigest: published.checkpointDigest,
          deltaCount: 0,
          frontierCommit: 'a'.repeat(40),
          profileDigest: published.profileDigest,
          repositoryId: REPOSITORY_ID,
          schemaVersion: 1,
          snapshotId,
        });
        const first = yield* captureSharedGraphImportBase(importRequest(published.repo, home));
        const second = yield* captureSharedGraphImportBase(importRequest(published.repo, home));
        expect(first).toMatchObject({
          imported: false,
          reason: 'already-installed',
          snapshotId,
          checkpointDigest: published.checkpointDigest,
          atGeneration: 1,
        });
        expect(second).toEqual(first);
        expect((yield* readSharedGraphProvenance(home, CHECKOUT_ID))?.snapshotId).toBe(snapshotId);
        expect(yield* readSharedGraphImportAttempt(home, CHECKOUT_ID)).toEqual({
          imported: false,
          reason: 'already-installed',
          checkpointDigest: published.checkpointDigest,
          atGeneration: 1,
        });
      }).pipe(provideTestLayer(sharingLayer)),
    {fastCheck: {numRuns: 15}},
  );
});

function importRequest(repoRoot: string, home: string) {
  return {
    cwd: repoRoot,
    identity: identity(repoRoot),
    threadnoteHome: home,
  };
}

function runtimeConfig(home: string) {
  return {
    account: 'local' as const,
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: `${home}/seed-manifest.yaml`,
    user: 'local',
  };
}

function identity(repo: string): RepositoryIdentity {
  return {
    caseMode: 'sensitive',
    checkoutId: CHECKOUT_ID,
    displayName: 'graph-share',
    gitCommonDirectory: repo,
    headCommit: 'a'.repeat(40),
    objectFormat: 'sha1',
    remoteIdentity: 'github.com/acme/graph-share',
    repoRoot: repo,
    repositoryId: REPOSITORY_ID,
    worktreeId: 'd'.repeat(64),
  };
}

const enrolledHome = Effect.fn('test.graphShare.enrolledHome')(function* (
  home: string,
  options: {
    readonly includeFrontier: boolean;
    readonly skipCheckpoint?: boolean;
    readonly snapshotId?: string;
    readonly repositoryId?: string;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repo = path.join(home, 'repository');
  const casRoot = path.join(home, 'cas');
  const repositoryId = options.repositoryId ?? REPOSITORY_ID;
  yield* fs.makeDirectory(path.join(repo, '.threadnote'), {recursive: true});
  yield* writeGraphShareClientState(home, casRoot);
  const key = yield* generateGraphSharePublisherKey();
  const profile = defaultGraphShareProfile({
    branch: 'refs/heads/main',
    canonicalRemote: 'github.com/acme/graph-share',
    organization: 'acme',
    publisherKeyFingerprint: key.fingerprint,
    repositoryId,
  });
  const profileDigest = graphShareProfileDigest(profile);
  yield* putCasBytes(casRoot, new TextEncoder().encode(canonicalJson(profile)));
  const enrollment = parseGraphShareEnrollment({
    profile: casProfilePointer(profileDigest),
    publisherKeyFingerprint: key.fingerprint,
    repositoryId,
    schemaVersion: 1,
  });
  yield* fs.writeFileString(path.join(repo, '.threadnote/graph-share.json'), `${JSON.stringify(enrollment)}\n`);
  yield* writeGraphShareTrustReceipt(home, trustReceiptFromEnrollment(enrollment, profile, profileDigest, 'read-only'));
  const checkpointDigest = sha256Digest(CHECKPOINT_BYTES);
  const snapshotId = options.snapshotId ?? 'cgsn_imported';
  const manifest: GraphShareFrontierManifestV1 = {
    branch: 'refs/heads/main',
    checkpoint: {
      manifestDigest: checkpointDigest,
      snapshotId,
      sourceCommit: 'a'.repeat(40),
    },
    deltas: [],
    generation: 1,
    graphAbi: 'e'.repeat(64),
    graphContentId: `cgc_${'d'.repeat(40)}`,
    logicalGraphDigest: `sha256:${'2'.repeat(64)}`,
    previousManifestDigest: null,
    profileDigest,
    publisherFence: 1,
    repositoryId,
    schemaVersion: 1,
    snapshotId,
    sourceCommit: 'a'.repeat(40),
  };
  const signed = yield* signGraphShareFrontier(key, manifest);
  const manifestDigest = yield* putCasBytes(casRoot, new TextEncoder().encode(canonicalJson(manifest)));
  const envelopeDigest = yield* putCasBytes(casRoot, new TextEncoder().encode(canonicalJson(signed.envelope)));
  if (options.includeFrontier) {
    const layout = graphSharingLayout(path, home, casRoot);
    yield* fs.makeDirectory(path.join(layout.frontiersRoot, repositoryId), {recursive: true});
    yield* fs.writeFileString(
      path.join(layout.frontiersRoot, repositoryId, 'latest.json'),
      `${JSON.stringify({envelopeDigest, manifestDigest, schemaVersion: 1})}\n`,
    );
    if (!options.skipCheckpoint) yield* putCasBytes(casRoot, CHECKPOINT_BYTES);
  }
  return {
    casRoot,
    checkpointDigest,
    enrollment,
    envelope: signed.envelope,
    key,
    manifest,
    manifestDigest,
    profile,
    profileDigest,
    repo,
  };
});

function quarantineNames(home: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = graphSharingLayout(path, home).quarantineRoot;
    if (!(yield* fs.exists(root))) return [];
    return [...(yield* fs.readDirectory(root))].sort();
  });
}

function flipHex(value: string): string {
  const last = value.at(-1) === 'a' ? 'b' : 'a';
  return `${value.slice(0, -1)}${last}`;
}

function git(repo: string, args: readonly string[]) {
  return runCommandEffect('git', ['-C', repo, ...args]);
}

const CLIENT_SHA256_ZERO = '0'.repeat(64);
const CLIENT_SHA1_ZERO = '0'.repeat(40);
const CLIENT_UTF8 = new TextEncoder();

function clientCheckpointMetadata(eligibleFiles: number) {
  return {
    abi: {
      checkpointSemanticVersion: 1 as const,
      graphSchemaVersion: 1,
      inventoryPolicyVersion: 1,
      languagePacks: [],
      lexicalLogicalFormatVersion: 1,
      pathPolicy: 'repository-relative-posix-v1' as const,
      referenceResolutionVersion: 'resolution-v1' as const,
      workspaceModelVersion: 'workspace-v1' as const,
    },
    coverage: {eligibleFiles, excludedFiles: 0, reasons: [], state: 'complete' as const},
    repository: {
      caseMode: 'sensitive' as const,
      displayName: 'checkpoint-fixture',
      objectFormat: 'sha1' as const,
      repositoryId: CLIENT_SHA256_ZERO,
    },
    source: {
      commit: CLIENT_SHA1_ZERO,
      extractorSet: 'typescript-v1',
      graphContentId: `cgc_${CLIENT_SHA1_ZERO}`,
    },
  };
}

function clientCheckpointRecords(paths: readonly string[]) {
  return paths.flatMap(filePath => {
    const facts = {diagnostics: [], edges: [], path: filePath, symbols: []};
    return [
      {
        blobId: CLIENT_SHA1_ZERO,
        contentHash: CLIENT_SHA256_ZERO,
        kind: 'file' as const,
        language: 'typescript',
        mode: '100644',
        path: filePath,
        size: CLIENT_UTF8.encode(filePath).byteLength,
        source: 'commit' as const,
      },
      {
        cacheIdentity: codeGraphCheckpointFileFactCacheIdentity(facts),
        factRole: 'materialized' as const,
        facts,
        kind: 'file-fact' as const,
        path: filePath,
      },
    ];
  });
}
