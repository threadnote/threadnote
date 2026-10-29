import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Clock, Effect, FileSystem, Layer, Path} from 'effect';
import * as FC from 'fast-check';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {graphShareParseActionKey} from '@threadnote/graph/sharing/action';
import {sha256Digest, sha256HexFromDigest} from '@threadnote/graph/sharing/digest';
import {graphShareParseResultArtifact} from '@threadnote/graph/sharing/parse/result';
import {
  graphWorkerDeliveryScope,
  listGraphWorkerDeliveryPrincipalScopes,
  markGraphWorkerDeliveryAdmitted,
  prepareGraphWorkerDeliveryOutbox,
  readGraphWorkerDeliveryOutbox,
  retireGraphWorkerDeliveryOutbox,
} from '@threadnote/graph/sharing/worker/delivery_outbox';
import {signGraphWorkerResultAnnouncement} from '@threadnote/graph/sharing/worker/announcement';
import {createGraphWorkerResultArtifact} from '@threadnote/graph/sharing/worker/result';
import {makeGraphWorkerSigner} from '@threadnote/graph/sharing/worker/signing';

import {provideTestLayer} from '../helpers/effect-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const layer = TestSystemInfoLayer.pipe(Layer.provideMerge(BunServices.layer));
const encode = (value: unknown) => new TextEncoder().encode(canonicalJson(value));
const scopeFor = (input: {
  authority: Parameters<typeof graphWorkerDeliveryScope>[0];
  candidate: {organization: string};
}) => graphWorkerDeliveryScope(input.authority, input.candidate.organization);
const scopeRoot = (home: string, scope: ReturnType<typeof scopeFor>) =>
  `${home}/graph-sharing/worker-delivery/${scope.repositoryId}/${sha256HexFromDigest(sha256Digest(canonicalJson(scope)))}`;

const fixture = Effect.fn('test.workerOutbox.fixture')(function* (
  diagnostic = '',
  existingHome?: string,
  principal = 'principal',
) {
  const fs = yield* FileSystem.FileSystem;
  const home = existingHome ?? (yield* fs.makeTempDirectoryScoped({prefix: 'graph-worker-outbox-'}));
  const signer = yield* makeGraphWorkerSigner(home, sha256Digest('outbox fixture'));
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  const action = {
    contentHash: Effect2.pipe('a', EffectString.repeat(64)),
    extractorSet: Effect2.pipe('b', EffectString.repeat(64)),
    languageAndRole: 'typescript:source',
    normalizedPath: 'src/index.ts',
    repositoryId: Effect2.pipe('c', EffectString.repeat(64)),
  };
  const result = graphShareParseResultArtifact({
    ...action,
    actionKey: graphShareParseActionKey(action),
    gitBlobId: Effect2.pipe('d', EffectString.repeat(40)),
    facts: {path: action.normalizedPath, diagnostics: diagnostic ? [diagnostic] : [], edges: [], symbols: []},
  });
  const authority = {
    expiresAt: now + 3600,
    graphAbi: Effect2.pipe('e', EffectString.repeat(64)),
    principalId: sha256Digest(principal),
    profileDigest: sha256Digest(`profile:${principal}`),
    repositoryId: action.repositoryId,
    signingPublicKey: signer.publicKey,
    workerId: 'gw_' + Effect2.pipe('f', EffectString.repeat(32)),
  };
  const sourceCommit = Effect2.pipe('1', EffectString.repeat(40));
  const candidate = {
    actionKey: result.actionKey,
    batchId: sourceCommit,
    casRoot: '/private/cas',
    extractorSet: action.extractorSet,
    graphAbi: authority.graphAbi,
    organization: 'threadnote',
    partialCoverage: false,
    platform: {architecture: 'x64' as const, os: 'linux' as const},
    profileDigest: authority.profileDigest,
    queuedAtMilliseconds: now * 1000,
    releaseIdentity: '4.6.11-local.gfixture',
    resourceLimits: [],
    resultDigest: sha256Digest(encode(result)),
    resultSize: encode(result).byteLength,
    semanticDigest: result.semanticDigest,
    snapshotId: `cgsn_${Effect2.pipe('2', EffectString.repeat(40))}`,
    sourceCommit,
  };
  const artifact = yield* createGraphWorkerResultArtifact({
    metadata: {
      batchId: sourceCommit,
      graphAbi: authority.graphAbi,
      identityClass: 'oauth-principal',
      issuedAt: now,
      partialCoverage: candidate.partialCoverage,
      platform: candidate.platform,
      principalId: authority.principalId,
      profileDigest: authority.profileDigest,
      releaseIdentity: candidate.releaseIdentity,
      repositoryId: authority.repositoryId,
      resourceLimits: [],
      sourceCommit,
      workerId: authority.workerId,
    },
    resultBytes: encode(result),
    signer,
  });
  const announcement = yield* signGraphWorkerResultAnnouncement({artifact, expected: authority, signer});
  const input = {
    announcement,
    artifact,
    authority,
    candidate,
    candidatePageId: Effect2.pipe('3', EffectString.repeat(64)),
    repositoryId: authority.repositoryId,
    threadnoteHome: home,
  };
  return {home, input, result};
});

describe('private signed worker delivery outbox', () => {
  effectIt.effect('survives restart and a lost admission ACK, then retires only after exact candidate ACK', () =>
    Effect.gen(function* () {
      const {input} = yield* fixture();
      const first = yield* prepareGraphWorkerDeliveryOutbox(input);
      expect(first.prepared).toBe(true);
      const replay = yield* readGraphWorkerDeliveryOutbox(input.threadnoteHome, scopeFor(input));
      expect(replay).toHaveLength(1);
      expect(replay[0].artifact).toEqual(input.artifact);
      expect((yield* prepareGraphWorkerDeliveryOutbox(input)).prepared).toBe(false);
      const anotherPage = yield* prepareGraphWorkerDeliveryOutbox({
        ...input,
        candidatePageId: Effect2.pipe('8', EffectString.repeat(64)),
      });
      expect(anotherPage.prepared).toBe(false);
      expect(anotherPage.sourcePageId).toBe(Effect2.pipe('8', EffectString.repeat(64)));
      const response = {idempotencyKey: first.operation.operationId, status: 'accepted' as const};
      const ackInput = {
        scope: scopeFor(input),
        candidateIdentity: first.operation.candidateIdentity,
        candidatePageId: first.operation.candidatePageId,
        operationId: first.operation.operationId,
        response,
        threadnoteHome: input.threadnoteHome,
      };
      expect((yield* Effect.result(retireGraphWorkerDeliveryOutbox({...ackInput, candidateAbsent: true})))._tag).toBe(
        'Failure',
      );
      expect(
        (yield* Effect.result(
          markGraphWorkerDeliveryAdmitted({
            ...ackInput,
            response: {...response, idempotencyKey: sha256Digest('wrong')},
          }),
        ))._tag,
      ).toBe('Failure');
      expect((yield* markGraphWorkerDeliveryAdmitted(ackInput)).state).toBe('admitted');
      expect((yield* markGraphWorkerDeliveryAdmitted(ackInput)).state).toBe('admitted');
      expect((yield* readGraphWorkerDeliveryOutbox(input.threadnoteHome, scopeFor(input)))[0].operation.state).toBe(
        'admitted',
      );
      expect(yield* retireGraphWorkerDeliveryOutbox({...ackInput, candidateAbsent: true})).toBe(true);
      expect(yield* retireGraphWorkerDeliveryOutbox({...ackInput, candidateAbsent: true})).toBe(false);
      expect(yield* readGraphWorkerDeliveryOutbox(input.threadnoteHome, scopeFor(input))).toEqual([]);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('rejects replay after a content-addressed blob is changed or replaced by a symlink', () =>
    Effect.gen(function* () {
      const {input} = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const prepared = yield* prepareGraphWorkerDeliveryOutbox(input);
      const blob = path.join(
        scopeRoot(input.threadnoteHome, scopeFor(input)),
        'sha256',
        sha256HexFromDigest(prepared.operation.resultDigest),
      );
      yield* fs.writeFile(blob, new Uint8Array([1, 2, 3]));
      expect((yield* Effect.result(readGraphWorkerDeliveryOutbox(input.threadnoteHome, scopeFor(input))))._tag).toBe(
        'Failure',
      );
      yield* fs.remove(blob);
      yield* fs.symlink(input.threadnoteHome, blob);
      expect((yield* Effect.result(readGraphWorkerDeliveryOutbox(input.threadnoteHome, scopeFor(input))))._tag).toBe(
        'Failure',
      );
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('cleans crash orphans and atomic temporary files before capacity checks', () =>
    Effect.gen(function* () {
      const {input} = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const first = yield* prepareGraphWorkerDeliveryOutbox(input);
      const second = yield* fixture('another result', input.threadnoteHome);
      const directory = path.join(scopeRoot(input.threadnoteHome, scopeFor(input)), 'sha256');
      const payload = new Uint8Array(32 * 1_048_576);
      for (const char of ['4', '5', '6', '7'])
        yield* fs.writeFile(path.join(directory, Effect2.pipe(char, EffectString.repeat(64))), payload);
      const temporary = path.join(
        directory,
        `${Effect2.pipe('9', EffectString.repeat(64))}.12345678-1234-1234-1234-123456789abc.tmp`,
      );
      yield* fs.writeFile(temporary, payload);
      const metadataTemporary = path.join(
        scopeRoot(input.threadnoteHome, scopeFor(input)),
        'outbox.json.12345678-1234-1234-1234-123456789abc.tmp',
      );
      yield* fs.writeFileString(metadataTemporary, '{"interrupted":true}');
      expect((yield* prepareGraphWorkerDeliveryOutbox(second.input)).prepared).toBe(true);
      expect(yield* fs.readDirectory(directory)).toHaveLength(4 + 2);
      expect(yield* fs.exists(temporary)).toBe(false);
      expect(yield* fs.exists(metadataTemporary)).toBe(false);
      expect(
        (yield* readGraphWorkerDeliveryOutbox(input.threadnoteHome, scopeFor(input)))[0].operation.operationId,
      ).toBe(first.operation.operationId);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('recovers orphan blobs before unregistering a scope after an interrupted retirement', () =>
    Effect.gen(function* () {
      const {input} = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const oldScope = scopeFor(input);
      const currentScope = {...oldScope, workerId: `gw_${Effect2.pipe('9', EffectString.repeat(32))}`};
      yield* prepareGraphWorkerDeliveryOutbox(input);
      const root = scopeRoot(input.threadnoteHome, oldScope);
      const blobs = path.join(root, 'sha256');
      expect((yield* fs.readDirectory(blobs)).length).toBeGreaterThan(0);

      // Simulate power loss after the empty outbox rename but before blob cleanup.
      yield* fs.writeFileString(path.join(root, 'outbox.json'), canonicalJson({operations: [], schemaVersion: 1}));
      expect(yield* listGraphWorkerDeliveryPrincipalScopes(input.threadnoteHome, currentScope)).toEqual([currentScope]);
      expect(yield* fs.readDirectory(blobs)).toEqual([]);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('partitions replay and operation capacity by exact principal/profile scope', () =>
    Effect.gen(function* () {
      const old = yield* fixture();
      const current = yield* fixture('current', old.home, 'new-principal');
      yield* prepareGraphWorkerDeliveryOutbox(old.input);
      expect(yield* readGraphWorkerDeliveryOutbox(old.home, scopeFor(current.input))).toEqual([]);
      expect((yield* prepareGraphWorkerDeliveryOutbox(current.input)).prepared).toBe(true);
      expect(yield* readGraphWorkerDeliveryOutbox(old.home, scopeFor(old.input))).toHaveLength(1);
      expect(yield* readGraphWorkerDeliveryOutbox(old.home, scopeFor(current.input))).toHaveLength(1);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect(
    'refuses a 129th operation without evicting any of the 128 prepared entries',
    () =>
      Effect.gen(function* () {
        const first = yield* fixture();
        for (let index = 0; index < 128; index++) {
          const next = index === 0 ? first : yield* fixture(`quota-${index}`, first.home);
          expect((yield* prepareGraphWorkerDeliveryOutbox(next.input)).prepared).toBe(true);
        }
        const extra = yield* fixture('quota-overflow', first.home);
        expect((yield* Effect.result(prepareGraphWorkerDeliveryOutbox(extra.input)))._tag).toBe('Failure');
        expect(yield* readGraphWorkerDeliveryOutbox(first.home, scopeFor(first.input))).toHaveLength(128);
      }).pipe(provideTestLayer(layer)),
    60_000,
  );

  effectIt.effect('refuses metadata that changes signed scope or adds unknown announcement fields', () =>
    Effect.gen(function* () {
      const {input} = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* prepareGraphWorkerDeliveryOutbox(input);
      const metadata = path.join(scopeRoot(input.threadnoteHome, scopeFor(input)), 'outbox.json');
      const original = yield* fs.readFileString(metadata);
      const document = JSON.parse(original);
      document.operations[0].announcement.body.unknown = true;
      yield* fs.writeFileString(metadata, JSON.stringify(document));
      expect((yield* Effect.result(readGraphWorkerDeliveryOutbox(input.threadnoteHome, scopeFor(input))))._tag).toBe(
        'Failure',
      );
      document.operations[0].announcement.body.unknown = undefined;
      document.operations[0].organization = 'another-org';
      yield* fs.writeFileString(metadata, JSON.stringify(document));
      expect((yield* Effect.result(readGraphWorkerDeliveryOutbox(input.threadnoteHome, scopeFor(input))))._tag).toBe(
        'Failure',
      );
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('reuses a verified orphan blob after an interrupted preparation', () =>
    Effect.gen(function* () {
      const {input} = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = path.join(scopeRoot(input.threadnoteHome, scopeFor(input)), 'sha256');
      yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
      const target = path.join(directory, sha256HexFromDigest(sha256Digest(input.artifact.resultBytes)));
      yield* fs.writeFile(target, input.artifact.resultBytes, {mode: 0o600});
      expect(yield* prepareGraphWorkerDeliveryOutbox(input)).toMatchObject({prepared: true});
      expect(
        (yield* readGraphWorkerDeliveryOutbox(input.threadnoteHome, scopeFor(input)))[0].artifact.resultBytes,
      ).toEqual(new Uint8Array(input.artifact.resultBytes));
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('repairs a power-loss-missing referenced blob from the same still-queued signed candidate', () =>
    Effect.gen(function* () {
      const {input} = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const prepared = yield* prepareGraphWorkerDeliveryOutbox(input);
      const target = path.join(
        scopeRoot(input.threadnoteHome, scopeFor(input)),
        'sha256',
        sha256HexFromDigest(prepared.operation.resultDigest),
      );
      yield* fs.remove(target);
      expect((yield* Effect.result(readGraphWorkerDeliveryOutbox(input.threadnoteHome, scopeFor(input))))._tag).toBe(
        'Failure',
      );
      expect((yield* prepareGraphWorkerDeliveryOutbox(input)).prepared).toBe(false);
      expect(
        (yield* readGraphWorkerDeliveryOutbox(input.threadnoteHome, scopeFor(input)))[0].artifact.resultBytes,
      ).toEqual(new Uint8Array(input.artifact.resultBytes));
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('does not report prepared when metadata directory sync fails, then durably resumes', () =>
    Effect.gen(function* () {
      const {input} = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = scopeRoot(input.threadnoteHome, scopeFor(input));
      const metadata = path.join(root, 'outbox.json');
      let interrupted = false;
      const failingFs: FileSystem.FileSystem = {
        ...fs,
        open: (target, options) =>
          fs.open(target, options).pipe(
            Effect.map(handle => ({
              ...handle,
              sync: Effect.gen(function* () {
                yield* handle.sync;
                if (target === root && !interrupted && (yield* fs.exists(metadata))) {
                  interrupted = true;
                  return yield* Effect.die(new Error('injected parent sync failure'));
                }
              }),
            })),
          ),
      };
      expect(
        (yield* Effect.exit(
          prepareGraphWorkerDeliveryOutbox(input).pipe(Effect.provideService(FileSystem.FileSystem, failingFs)),
        ))._tag,
      ).toBe('Failure');
      expect(interrupted).toBe(true);
      expect((yield* prepareGraphWorkerDeliveryOutbox(input)).prepared).toBe(false);
      expect(yield* readGraphWorkerDeliveryOutbox(input.threadnoteHome, scopeFor(input))).toHaveLength(1);
    }).pipe(provideTestLayer(layer)),
  );

  fcEffectProp(
    effectIt,
    'preparation snapshots caller bytes and keeps exact replay across arbitrary facts',
    {
      diagnostic: FC.string({maxLength: 64}),
    },
    ({diagnostic}) =>
      Effect.gen(function* () {
        const {input} = yield* fixture(diagnostic);
        const expected = new Uint8Array(input.artifact.resultBytes);
        const first = yield* prepareGraphWorkerDeliveryOutbox(input);
        input.artifact.resultBytes.fill(0);
        input.candidate.casRoot = '/mutated';
        const replay = yield* readGraphWorkerDeliveryOutbox(input.threadnoteHome, scopeFor(input));
        expect(replay[0].artifact.resultBytes).toEqual(expected);
        expect(replay[0].operation.candidate.casRoot).toBe('/private/cas');
        expect(replay[0].operation.operationId).toBe(first.operation.operationId);
      }).pipe(provideTestLayer(layer)),
  );
});
