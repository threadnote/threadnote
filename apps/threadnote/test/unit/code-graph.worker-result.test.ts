import {Array as EffectArray} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt, vi} from '@effect/vitest';
import {Clock, Effect, FileSystem, Layer} from 'effect';
import * as FC from 'fast-check';

import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {graphShareParseActionKey} from '@threadnote/graph/sharing/action';
import {sha256Digest} from '@threadnote/graph/sharing/digest';
import {graphShareParseResultArtifact} from '@threadnote/graph/sharing/parse/result';
import {makeGraphWorkerSigner} from '@threadnote/graph/sharing/worker/signing';
import {
  signGraphWorkerResultAnnouncement,
  verifyGraphWorkerResultAnnouncement,
} from '@threadnote/graph/sharing/worker/announcement';
import {
  createGraphWorkerResultArtifact,
  readGraphWorkerResultArtifact,
  verifyGraphWorkerResultIntegrity,
} from '@threadnote/graph/sharing/worker/result';
import {verifyPublisherWorkerReceipt} from '@threadnote/graph/sharing/worker/publisher_receipt';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const layer = TestSystemInfoLayer.pipe(Layer.provideMerge(BunServices.layer));
const encode = (value: unknown) => new TextEncoder().encode(canonicalJson(value));
const fixture = Effect.fn('test.workerResult.fixture')(function* (
  diagnostics: string[] = [],
  sourceCommit = Effect2.pipe('f', EffectString.repeat(40)),
) {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-worker-result-'});
  const signer = yield* makeGraphWorkerSigner(home, sha256Digest('credential identity'));
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  const action = {
    contentHash: Effect2.pipe('a', EffectString.repeat(64)),
    extractorSet: Effect2.pipe('b', EffectString.repeat(64)),
    languageAndRole: 'typescript:source',
    normalizedPath: 'src/index.ts',
    repositoryId: Effect2.pipe('c', EffectString.repeat(64)),
  };
  const parsed = graphShareParseResultArtifact({
    ...action,
    actionKey: graphShareParseActionKey(action),
    gitBlobId: Effect2.pipe('d', EffectString.repeat(40)),
    facts: {path: action.normalizedPath, diagnostics, edges: [], symbols: []},
  });
  const authority = {
    repositoryId: action.repositoryId,
    profileDigest: sha256Digest('profile'),
    principalId: sha256Digest('principal'),
    workerId: 'gw_' + Effect2.pipe('a', EffectString.repeat(32)),
    signingPublicKey: signer.publicKey,
    expiresAt: now + 3600,
    graphAbi: Effect2.pipe('e', EffectString.repeat(64)),
  };
  const metadata = {
    batchId: sourceCommit.slice(0, 40),
    graphAbi: authority.graphAbi,
    issuedAt: now,
    releaseIdentity: '4.6.8-local.gsynthetic',
    identityClass: 'oauth-principal' as const,
    partialCoverage: false,
    resourceLimits: [],
    platform: {os: 'linux' as const, architecture: 'x64' as const},
    principalId: authority.principalId,
    workerId: authority.workerId,
    profileDigest: authority.profileDigest,
    repositoryId: authority.repositoryId,
    sourceCommit,
  };
  const resultBytes = encode(parsed);
  const artifact = yield* createGraphWorkerResultArtifact({metadata, resultBytes, signer});
  return {artifact, authority, metadata, parsed, resultBytes, signer};
});

describe('signed OCI worker parse-result artifacts', () => {
  effectIt.effect('publisher rechecks signed OCI closure, source commit, and independent target ABI', () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        [],
        Effect2.pipe('f', EffectString.repeat(40)) + Effect2.pipe('a', EffectString.repeat(24)),
      );
      const announcement = yield* signGraphWorkerResultAnnouncement({
        artifact: f.artifact,
        expected: f.authority,
        signer: f.signer,
      });
      const receipt = {
        admittedAt: f.metadata.issuedAt,
        announcement,
        announcementDigest: sha256Digest(canonicalJson(announcement)),
        authorityExpiresAt: f.authority.expiresAt,
        graphAbi: f.authority.graphAbi,
        signedBodyDigest: sha256Digest(canonicalJson(announcement.body)),
        sourceCommit: f.metadata.sourceCommit,
      };
      const blobs = new Map<string, Uint8Array>(
        EffectArray.map([encode({}), f.artifact.resultBytes, f.artifact.attestationBytes], bytes => [
          sha256Digest(bytes),
          bytes,
        ]),
      );
      const reader = {
        readWorkerManifest: (_digest: string) => Effect.succeed(f.artifact.manifestBytes),
        readBlob: (digest: string) => Effect.succeed(blobs.get(digest) ?? new Uint8Array()),
      };
      const {graphAbi: _graphAbi, ...authority} = f.authority;
      const input = {
        authority,
        expectedGraphAbi: f.authority.graphAbi,
        reader,
        receipt,
        sourceCommit: f.metadata.sourceCommit,
      };
      const verified = yield* verifyPublisherWorkerReceipt(input);
      expect(verified.parsed).toEqual(f.parsed);
      expect(verified.sourceCommit).toBe(f.metadata.sourceCommit);
      expect(verified.operationId).toBe(announcement.body.idempotencyKey);
      expect(
        (yield* Effect.result(
          verifyPublisherWorkerReceipt({
            ...input,
            sourceCommit: Effect2.pipe('f', EffectString.repeat(40)) + Effect2.pipe('b', EffectString.repeat(24)),
          }),
        ))._tag,
      ).toBe('Failure');
      expect(
        (yield* Effect.result(
          verifyPublisherWorkerReceipt({...input, expectedGraphAbi: Effect2.pipe('0', EffectString.repeat(64))}),
        ))._tag,
      ).toBe('Failure');
      for (const changed of [
        {profileDigest: sha256Digest('other profile')},
        {principalId: sha256Digest('other principal')},
        {signingPublicKey: Effect2.pipe('0', EffectString.repeat(64))},
        {expiresAt: 0},
      ])
        expect(
          (yield* Effect.result(verifyPublisherWorkerReceipt({...input, authority: {...authority, ...changed}})))._tag,
        ).toBe('Failure');
      expect(
        (yield* Effect.result(
          verifyPublisherWorkerReceipt({
            ...input,
            reader: {...reader, readWorkerManifest: () => Effect.succeed(encode({}))},
          }),
        ))._tag,
      ).toBe('Failure');
      blobs.delete(sha256Digest(f.artifact.resultBytes));
      expect((yield* Effect.result(verifyPublisherWorkerReceipt(input)))._tag).toBe('Failure');
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('signs idempotent scoped announcements and refuses signature or operation substitution', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const input = {artifact: f.artifact, expected: f.authority, signer: f.signer};
      const signed = yield* signGraphWorkerResultAnnouncement(input);
      expect(yield* signGraphWorkerResultAnnouncement(input)).toEqual(signed);
      expect(yield* verifyGraphWorkerResultAnnouncement(signed, f.authority)).toEqual(signed.body);
      expect(signed.body.resultManifestDigest).toBe(f.artifact.manifestDigest);
      expect(signed.body.attestationDigest).toBe(sha256Digest(f.artifact.attestationBytes));
      for (const override of [
        {batchId: Effect2.pipe('0', EffectString.repeat(40))},
        {principalId: sha256Digest('other')},
        {resultManifestDigest: sha256Digest('other')},
        {idempotencyKey: sha256Digest('other')},
        {unknown: true},
      ])
        expect(
          (yield* Effect.result(
            verifyGraphWorkerResultAnnouncement({...signed, body: {...signed.body, ...override}}, f.authority),
          ))._tag,
        ).toBe('Failure');
      const signature = yield* f.signer.sign('attestation', encode(signed.body));
      expect(
        (yield* Effect.result(verifyGraphWorkerResultAnnouncement({...signed, signature}, f.authority)))._tag,
      ).toBe('Failure');
      expect(
        (yield* Effect.result(verifyGraphWorkerResultAnnouncement(signed, {...f.authority, expiresAt: 0})))._tag,
      ).toBe('Failure');
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('returns the verified announcement snapshot when caller input changes during verification', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const signed = yield* signGraphWorkerResultAnnouncement({
        artifact: f.artifact,
        expected: f.authority,
        signer: f.signer,
      });
      const expected = {...signed.body};
      const original = crypto.subtle.verify.bind(crypto.subtle);
      yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          vi.spyOn(crypto.subtle, 'verify').mockImplementation(async (...args) => {
            const valid = await original(...args);
            Object.assign(signed.body, {resultManifestDigest: sha256Digest('substituted')});
            return valid;
          }),
        ),
        () =>
          Effect.gen(function* () {
            expect(yield* verifyGraphWorkerResultAnnouncement(signed, f.authority)).toEqual(expected);
          }),
        mock => Effect.sync(() => mock.mockRestore()),
      );
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('retrieves the retained result closure by digest and rejects missing or altered layers', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const config = encode({});
      const blobs = new Map<string, Uint8Array>(
        EffectArray.map([config, f.artifact.resultBytes, f.artifact.attestationBytes], bytes => [
          sha256Digest(bytes),
          bytes,
        ]),
      );
      const requested: string[] = [];
      const reader = {
        readWorkerManifest: (digest: string) =>
          Effect.sync(() => {
            expect(digest).toBe(f.artifact.manifestDigest);
            return f.artifact.manifestBytes;
          }),
        readBlob: (digest: string, size?: number) =>
          Effect.sync(() => {
            requested.push(digest);
            const bytes = blobs.get(digest) ?? new Uint8Array();
            if (bytes.byteLength > 0) expect(bytes.byteLength).toBe(size);
            return bytes;
          }),
      };
      expect((yield* readGraphWorkerResultArtifact(reader, f.artifact.manifestDigest, f.authority)).parsed).toEqual(
        f.parsed,
      );
      expect(new Set(requested)).toEqual(new Set(blobs.keys()));
      blobs.delete(sha256Digest(f.artifact.resultBytes));
      expect(
        (yield* Effect.result(readGraphWorkerResultArtifact(reader, f.artifact.manifestDigest, f.authority)))._tag,
      ).toBe('Failure');
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('verifies an immutable input snapshot across asynchronous signature checks', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const altered = encode({...f.parsed, gitBlobId: Effect2.pipe('e', EffectString.repeat(40))});
      expect(altered.byteLength).toBe(f.artifact.resultBytes.byteLength);
      const original = crypto.subtle.verify.bind(crypto.subtle);
      yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          vi.spyOn(crypto.subtle, 'verify').mockImplementation(async (...args) => {
            const valid = await original(...args);
            f.artifact.resultBytes.set(altered);
            return valid;
          }),
        ),
        () =>
          Effect.gen(function* () {
            const verified = yield* verifyGraphWorkerResultIntegrity({...f.artifact, expected: f.authority});
            expect(verified.parsed).toEqual(f.parsed);
          }),
        mock => Effect.sync(() => mock.mockRestore()),
      );
    }).pipe(provideTestLayer(layer)),
  );

  fcEffectProp(
    effectIt,
    'round-trips original facts with deterministic artifact identities and leaves caller bytes unchanged',
    {diagnostics: FC.array(FC.string({maxLength: 30}), {maxLength: 4})},
    ({diagnostics}) =>
      Effect.gen(function* () {
        const f = yield* fixture(diagnostics);
        const again = yield* createGraphWorkerResultArtifact({
          metadata: f.metadata,
          resultBytes: f.resultBytes,
          signer: f.signer,
        });
        expect(again.manifestDigest).toBe(f.artifact.manifestDigest);
        expect(again.attestationBytes).toEqual(f.artifact.attestationBytes);
        expect(f.resultBytes).toEqual(encode(f.parsed));
        expect(f.artifact.resultBytes).not.toBe(f.resultBytes);
        const verified = yield* verifyGraphWorkerResultIntegrity({...f.artifact, expected: f.authority});
        expect(verified.parsed).toEqual(f.parsed);
        expect(verified.attestation.claims.batchId).toBe(f.metadata.batchId);
        expect(verified.attestation.claims.sourceCommit).toBe(f.metadata.sourceCommit);
        const manifest = JSON.parse(new TextDecoder().decode(f.artifact.manifestBytes));
        expect(manifest.layers).toHaveLength(2);
        expect(manifest.layers.map((entry: {digest: string}) => entry.digest)).toEqual([
          sha256Digest(f.resultBytes),
          sha256Digest(f.artifact.attestationBytes),
        ]);
      }).pipe(provideTestLayer(layer)),
    {fastCheck: {numRuns: 25}},
  );

  effectIt.effect('rejects byte tampering, foreign enrollment scope, wrong ABI and expired worker authority', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      for (const field of ['manifestBytes', 'resultBytes', 'attestationBytes'] as const) {
        const bytes = new Uint8Array(f.artifact[field]);
        bytes[0] ^= 1;
        expect(
          (yield* Effect.result(
            verifyGraphWorkerResultIntegrity({...f.artifact, [field]: bytes, expected: f.authority}),
          ))._tag,
        ).toBe('Failure');
      }
      for (const changed of [
        {principalId: sha256Digest('other')},
        {profileDigest: sha256Digest('other')},
        {repositoryId: Effect2.pipe('0', EffectString.repeat(64))},
        {workerId: 'gw_' + Effect2.pipe('b', EffectString.repeat(32))},
        {signingPublicKey: Effect2.pipe('0', EffectString.repeat(64))},
        {graphAbi: Effect2.pipe('0', EffectString.repeat(64))},
        {expiresAt: 0},
      ])
        expect(
          (yield* Effect.result(
            verifyGraphWorkerResultIntegrity({...f.artifact, expected: {...f.authority, ...changed}}),
          ))._tag,
        ).toBe('Failure');
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('verifies a producer ABI without a predecessor expectation but rejects malformed signed claims', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const {graphAbi, ...identity} = f.authority;
      expect(
        (yield* verifyGraphWorkerResultIntegrity({...f.artifact, expected: identity})).attestation.claims.graphAbi,
      ).toBe(graphAbi);
      const attestation = JSON.parse(new TextDecoder().decode(f.artifact.attestationBytes));
      const claims = {...attestation.claims, graphAbi: 'invalid'};
      const attestationBytes = encode({
        ...attestation,
        claims,
        signature: yield* f.signer.sign('attestation', encode(claims)),
      });
      const manifest = JSON.parse(new TextDecoder().decode(f.artifact.manifestBytes));
      manifest.layers[1] = {
        ...manifest.layers[1],
        digest: sha256Digest(attestationBytes),
        size: attestationBytes.byteLength,
      };
      const manifestBytes = encode(manifest);
      expect(
        (yield* Effect.result(
          verifyGraphWorkerResultIntegrity({
            ...f.artifact,
            attestationBytes,
            expected: identity,
            manifestBytes,
            manifestDigest: sha256Digest(manifestBytes),
          }),
        ))._tag,
      ).toBe('Failure');
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('attests the full SHA-256 source commit while preserving its 40-character batch identity', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const sourceCommit = f.metadata.batchId + Effect2.pipe('a', EffectString.repeat(24));
      const artifact = yield* createGraphWorkerResultArtifact({
        metadata: {...f.metadata, sourceCommit},
        resultBytes: f.resultBytes,
        signer: f.signer,
      });
      const verified = yield* verifyGraphWorkerResultIntegrity({...artifact, expected: f.authority});
      expect(verified.attestation.claims.sourceCommit).toBe(sourceCommit);
      expect(verified.attestation.claims.batchId).toBe(f.metadata.batchId);
      const attestation = JSON.parse(new TextDecoder().decode(artifact.attestationBytes));
      const alteredAttestationBytes = encode({
        ...attestation,
        claims: {...attestation.claims, sourceCommit: f.metadata.batchId + Effect2.pipe('b', EffectString.repeat(24))},
      });
      const manifest = JSON.parse(new TextDecoder().decode(artifact.manifestBytes));
      manifest.layers[1] = {
        ...manifest.layers[1],
        digest: sha256Digest(alteredAttestationBytes),
        size: alteredAttestationBytes.byteLength,
      };
      const alteredManifestBytes = encode(manifest);
      expect(
        (yield* Effect.result(
          verifyGraphWorkerResultIntegrity({
            ...artifact,
            attestationBytes: alteredAttestationBytes,
            manifestBytes: alteredManifestBytes,
            manifestDigest: sha256Digest(alteredManifestBytes),
            expected: f.authority,
          }),
        ))._tag,
      ).toBe('Failure');
      expect(
        (yield* Effect.result(
          createGraphWorkerResultArtifact({
            metadata: {...f.metadata, sourceCommit: Effect2.pipe('0', EffectString.repeat(64))},
            resultBytes: f.resultBytes,
            signer: f.signer,
          }),
        ))._tag,
      ).toBe('Failure');
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect(
    'rejects a valid contributor signature over substituted facts, unsupported fields or future issuance',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const attestation = JSON.parse(new TextDecoder().decode(f.artifact.attestationBytes));
        for (const override of [
          {semanticDigest: sha256Digest('other')},
          {actionKey: Effect2.pipe('0', EffectString.repeat(64))},
          {issuedAt: f.metadata.issuedAt + 121},
          {sourceCommit: Effect2.pipe('0', EffectString.repeat(40))},
          {unknown: 'not-supported'},
        ]) {
          const claims = {...attestation.claims, ...override};
          const signature = yield* f.signer.sign('attestation', encode(claims));
          const attestationBytes = encode({...attestation, claims, signature});
          const manifest = JSON.parse(new TextDecoder().decode(f.artifact.manifestBytes));
          manifest.layers[1] = {
            ...manifest.layers[1],
            digest: sha256Digest(attestationBytes),
            size: attestationBytes.byteLength,
          };
          const manifestBytes = encode(manifest);
          expect(
            (yield* Effect.result(
              verifyGraphWorkerResultIntegrity({
                ...f.artifact,
                manifestBytes,
                manifestDigest: sha256Digest(manifestBytes),
                attestationBytes,
                expected: f.authority,
              }),
            ))._tag,
          ).toBe('Failure');
        }
      }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('refuses noncanonical result identities and bounded metadata with extra layers or destinations', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      expect(
        (yield* Effect.result(
          createGraphWorkerResultArtifact({
            metadata: f.metadata,
            resultBytes: encode({...f.parsed, actionKey: Effect2.pipe('0', EffectString.repeat(64))}),
            signer: f.signer,
          }),
        ))._tag,
      ).toBe('Failure');
      const manifest = JSON.parse(new TextDecoder().decode(f.artifact.manifestBytes));
      for (const override of [
        {urls: ['https://foreign.example.test']},
        {layers: []},
        {layers: [...manifest.layers, manifest.layers[0]]},
        {layers: [{...manifest.layers[0], urls: ['https://foreign.example.test']}, manifest.layers[1]]},
        {source: 'synthetic source'},
        {config: {...manifest.config, urls: ['https://foreign.example.test']}},
        {config: {digest: sha256Digest('not empty')}},
      ]) {
        const manifestBytes = encode({...manifest, ...override});
        expect(
          (yield* Effect.result(
            verifyGraphWorkerResultIntegrity({
              ...f.artifact,
              manifestBytes,
              manifestDigest: sha256Digest(manifestBytes),
              expected: f.authority,
            }),
          ))._tag,
        ).toBe('Failure');
      }
      expect(
        (yield* Effect.result(
          verifyGraphWorkerResultIntegrity({...f.artifact, manifestBytes: new Uint8Array(8193), expected: f.authority}),
        ))._tag,
      ).toBe('Failure');
    }).pipe(provideTestLayer(layer)),
  );
});
