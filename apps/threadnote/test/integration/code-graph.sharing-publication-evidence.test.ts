import {describe, expect, it as effectIt} from '@effect/vitest';
import {Cause, Crypto, Deferred, Effect, Exit, Fiber, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {runCommandEffect} from '@threadnote/platform/command';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphStore} from '@threadnote/graph/store';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {runCodeGraphCheckpointExport} from '@threadnote/threadnote/code_graph/checkpoint/commands';
import {runGraphShareJoin, runGraphShareLeave} from '@threadnote/graph/sharing/client';
import {graphShareControlGetStatus} from '@threadnote/graph/sharing/control/client';
import {parseSha256Digest} from '@threadnote/graph/sharing/digest';
import {verifyGraphShareParseReceipt, type VerifiedGraphShareParseReceipt} from '@threadnote/graph/sharing/parse/cache';
import {graphSharingLayout, graphSharingFrontierPointerPath} from '@threadnote/graph/sharing/layout';
import {putCasBytes} from '@threadnote/graph/sharing/cas';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {graphShareParseResultArtifact} from '@threadnote/graph/sharing/parse/result';
import {readJsonFile, writePrivateJsonFile} from '@threadnote/graph/sharing/atomic';
import {loadGraphShareCoordinatorState} from '@threadnote/graph/sharing/control/server';
import {lookupGraphShareTrustReceipt, writeGraphShareTrustReceipt} from '@threadnote/graph/sharing/trust';
import {announceGraphShareResult} from '@threadnote/graph/sharing/receipts';
import {sha256Digest} from '@threadnote/graph/sharing/digest';
import {advanceGraphPublisherFrontier} from '@threadnote/graph/sharing/publisher/cycle';
import {
  runGraphPublisherBootstrap,
  runGraphPublisherListen,
  runGraphShareInit,
} from '@threadnote/threadnote/code_graph/sharing/publisher';

describe('publisher contribution evidence with an independent clean control', () => {
  for (const scenario of ['valid', 'forged', 'quarantine', 'abi-transition'] as const) {
    effectIt.effect(
      scenario === 'abi-transition'
        ? 'compacts an independently verified graph when the active language-pack ABI changes'
        : scenario === 'quarantine'
          ? 'rejects a contribution quarantined after assembly and before promotion'
          : scenario === 'forged'
            ? 'rejects a validly hashed forged payload without promotion and verifies a clean retry'
            : 'uses source-verified original contributions with an independent clean graph control',
      () =>
        TestClock.withLive(
          Effect.gen(function* () {
            const eligibleFiles = scenario === 'abi-transition' ? 4 : 3;
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const crypto = yield* Crypto.Crypto;
            const indexer = yield* CodeGraphIndexer;
            const store = yield* CodeGraphStore;
            const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-publication-evidence-'});
            const repo = path.join(root, 'publisher-repo');
            const contributor = path.join(root, 'contributor-repo');
            const home = path.join(root, 'publisher-home');
            const workerHome = path.join(root, 'worker-home');
            const controlHome = path.join(root, 'control-home');
            const cas = path.join(root, 'cas');
            const controlCas = path.join(root, 'control-cas');
            const origin = 'https://github.com/acme/publication-evidence.git';
            yield* fs.makeDirectory(path.join(repo, 'src'), {recursive: true});
            yield* fs.writeFileString(path.join(repo, 'package.json'), '{"private":true,"type":"module"}\n');
            yield* fs.writeFileString(path.join(repo, 'src/a.ts'), 'export const alpha = 1;\n');
            yield* fs.writeFileString(
              path.join(repo, 'src/b.ts'),
              "import {alpha} from './a.js'; export const beta = alpha + 1;\n",
            );
            yield* git(repo, ['init', '-q', '--initial-branch=main']);
            yield* git(repo, ['remote', 'add', 'origin', origin]);
            yield* commit(repo, 'baseline');
            yield* runGraphShareInit(config(home), {cas, cwd: repo, organization: 'acme', writeConfig: true});
            yield* commit(repo, 'enroll');
            yield* indexer.index({cwd: repo, ensureVectors: false, threadnoteHome: home});
            const baseline = yield* runGraphPublisherBootstrap(config(home), {cas, cwd: repo});
            // Share the published baseline and signing identity, but build the control graph independently.
            // Copying a live home races transient locks and SQLite maintenance.
            const publisherKey = graphSharingLayout(path, home).publisherKeyPath;
            const controlKey = graphSharingLayout(path, controlHome).publisherKeyPath;
            yield* fs.makeDirectory(path.dirname(controlKey), {recursive: true, mode: 0o700});
            yield* fs.copyFile(publisherKey, controlKey);
            yield* fs.copy(cas, controlCas);
            yield* indexer.index({cwd: repo, ensureVectors: false, threadnoteHome: controlHome});
            const controlBaseline = yield* runGraphPublisherBootstrap(config(controlHome), {
              cas: controlCas,
              cwd: repo,
            });
            expect(controlBaseline.checkpointDigest).toBe(baseline.checkpointDigest);
            yield* git(root, ['clone', '-q', repo, contributor]);
            yield* git(contributor, ['remote', 'set-url', 'origin', origin]);
            const ready = yield* Deferred.make<string>();
            const listener = yield* Effect.forkScoped(
              runGraphPublisherListen(config(home), {
                cas,
                cwd: repo,
                listen: '127.0.0.1:0',
                onReady: output => Deferred.succeed(ready, output.coordinatorUrl).pipe(Effect.asVoid),
              }),
            );
            const url = yield* Deferred.await(ready);
            yield* runGraphShareJoin(config(workerHome), {
              cas: path.join(root, 'worker-cas'),
              coordinator: url,
              cwd: contributor,
            });
            // Every eligible source file changes, so old local parse facts cannot explain target reuse.
            yield* fs.writeFileString(
              path.join(contributor, 'package.json'),
              '{"private":true,"type":"module","name":"target"}\n',
            );
            yield* fs.writeFileString(
              path.join(contributor, 'src/a.ts'),
              'export function alpha(value: number) { return value * 7; }\n',
            );
            yield* fs.writeFileString(
              path.join(contributor, 'src/b.ts'),
              "import {alpha} from './a.js'; export function beta(value: number) { return alpha(value) + 3; }\n",
            );
            if (scenario === 'abi-transition')
              yield* fs.writeFileString(
                path.join(contributor, 'src/new.py'),
                'def added_python(value):\n    return value + 1\n',
              );
            yield* commit(contributor, 'target');
            const target = yield* resolveRepositoryIdentity(contributor);
            yield* indexer.index({cwd: contributor, ensureVectors: false, threadnoteHome: workerHome});
            const status = yield* graphShareControlGetStatus(url);
            const receipts = status.receipts.filter(receipt => receipt.batchId === target.headCommit);
            expect(receipts).toHaveLength(eligibleFiles);
            const identity = yield* resolveRepositoryIdentity(repo);
            expect(identity.headCommit).toBe(baseline.sourceCommit);
            const databasePath = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId).databasePath;
            const verifiedReceipts: VerifiedGraphShareParseReceipt[] = [];
            for (const announcement of receipts) {
              const verified = yield* verifyGraphShareParseReceipt({
                announcement: {
                  ...announcement,
                  attestationDigest: parseSha256Digest(announcement.attestationDigest),
                  resultManifestDigest: parseSha256Digest(announcement.resultManifestDigest),
                  semanticDigest: parseSha256Digest(announcement.semanticDigest),
                },
                casRoot: cas,
                repositoryId: identity.repositoryId,
              });
              verifiedReceipts.push(verified);
              const cached = yield* store.cachedCommittedFileKeys(databasePath, verified.parsed.extractorSet, [
                {path: verified.parsed.normalizedPath, contentHash: verified.parsed.contentHash},
              ]);
              expect(cached.size).toBe(0);
            }
            // Stop the watch before advancing the publisher clone; publication is now exactly controlled.
            yield* Fiber.interrupt(listener);
            yield* git(repo, ['fetch', '-q', contributor, 'main']);
            yield* git(repo, ['merge', '--ff-only', 'FETCH_HEAD']);
            let sharingRequests = 0;
            const sentinel = yield* Effect.acquireRelease(
              Effect.sync(() =>
                Bun.serve({
                  hostname: '127.0.0.1',
                  port: 0,
                  fetch: () => {
                    sharingRequests += 1;
                    return new Response('unexpected sharing request', {status: 503});
                  },
                }),
              ),
              server => Effect.promise(() => server.stop(true)),
            );
            for (const targetHome of [home, controlHome]) {
              yield* runGraphShareJoin(config(targetHome), {cas: targetHome === home ? cas : controlCas, cwd: repo});
              const trust = yield* lookupGraphShareTrustReceipt(targetHome, identity.repositoryId);
              expect(trust?.client).toBeDefined();
              if (trust?.client === undefined) return yield* Effect.die('Missing graph-sharing fixture settings');
              yield* writeGraphShareTrustReceipt(targetHome, {
                ...trust,
                client: {...trust.client, coordinatorUrl: `http://127.0.0.1:${sentinel.port}`},
              });
            }
            const control = yield* advanceGraphPublisherFrontier(config(controlHome), {
              cas: controlCas,
              cwd: repo,
              forceFreeze: true,
            });
            expect(control.published).toBe(true);
            expect(control.contributionEvidence).toMatchObject({
              selectedResults: 0,
              verifiedResults: 0,
              hydration: {status: 'skipped-source-verification', hydratedResults: 0},
              sourceUse: {consumedActions: 0, consumedResultManifestDigests: [], sourceVerifiedFiles: eligibleFiles},
              index: {reusedFiles: 0, totalFiles: eligibleFiles},
            });
            const publication = advanceGraphPublisherFrontier(config(home), {cas, cwd: repo, forceFreeze: true});
            if (scenario === 'forged') {
              const sharing = graphSharingLayout(path, home, cas);
              const state = yield* loadGraphShareCoordinatorState({
                organization: 'acme',
                repositoryId: identity.repositoryId,
                threadnoteHome: home,
              });
              const original = verifiedReceipts.find(item => item.parsed.normalizedPath === 'src/a.ts')!;
              const forged = graphShareParseResultArtifact({
                ...original.parsed,
                facts: {...original.parsed.facts, diagnostics: ['forged but validly hashed facts']},
              });
              const resultManifestDigest = yield* putCasBytes(cas, new TextEncoder().encode(canonicalJson(forged)));
              const attestationDigest = yield* putCasBytes(
                cas,
                new TextEncoder().encode(
                  canonicalJson({kind: 'contributor-self', payloadDigest: resultManifestDigest, schemaVersion: 1}),
                ),
              );
              const announcement = {
                ...original.announcement,
                resultManifestDigest,
                attestationDigest,
                semanticDigest: forged.semanticDigest,
              };
              yield* writePrivateJsonFile(sharing.coordinatorStatePath, {
                ...state,
                receipts: {
                  ...state.receipts,
                  receipts: state.receipts.receipts.map(receipt =>
                    receipt.resultManifestDigest === original.announcement.resultManifestDigest
                      ? announcement
                      : receipt,
                  ),
                },
              });
              // All existing integrity checks pass: only independent source semantics rejects it.
              yield* verifyGraphShareParseReceipt({announcement, casRoot: cas, repositoryId: identity.repositoryId});
              const pointerPath = graphSharingFrontierPointerPath(path, sharing.frontiersRoot, identity.repositoryId);
              const before = yield* readJsonFile(pointerPath);
              const rejected = yield* Effect.exit(publication);
              expect(Exit.isFailure(rejected)).toBe(true);
              if (Exit.isFailure(rejected))
                expect(Cause.pretty(rejected.cause)).toContain('Contribution source verification failed');
              expect(yield* readJsonFile(pointerPath)).toEqual(before);
              // Restore the original accepted immutable receipt set. A new attempt must collect its own evidence.
              yield* writePrivateJsonFile(sharing.coordinatorStatePath, state);
            }
            if (scenario === 'quarantine') {
              const sharing = graphSharingLayout(path, home, cas);
              const coordinatorOptions = {
                organization: 'acme',
                repositoryId: identity.repositoryId,
                threadnoteHome: home,
              };
              const state = yield* loadGraphShareCoordinatorState(coordinatorOptions);
              const pointerPath = graphSharingFrontierPointerPath(path, sharing.frontiersRoot, identity.repositoryId);
              const before = yield* readJsonFile(pointerPath);
              const original = verifiedReceipts[0];
              const rejected = yield* Effect.exit(
                advanceGraphPublisherFrontier(config(home), {
                  cas,
                  cwd: repo,
                  forceFreeze: true,
                  onMachine: machine =>
                    machine.phase !== 'verifying'
                      ? Effect.void
                      : Effect.gen(function* () {
                          const latest = yield* loadGraphShareCoordinatorState(coordinatorOptions);
                          const conflict = announceGraphShareResult(latest.receipts, {
                            ...original.announcement,
                            resultManifestDigest: sha256Digest('late conflict'),
                            semanticDigest: sha256Digest('conflicting semantics'),
                          });
                          expect(conflict.status).toBe('quarantined');
                          yield* writePrivateJsonFile(sharing.coordinatorStatePath, {
                            ...latest,
                            receipts: conflict.store,
                          });
                        }).pipe(
                          Effect.provideService(FileSystem.FileSystem, fs),
                          Effect.provideService(Path.Path, path),
                          Effect.provideService(Crypto.Crypto, crypto),
                          Effect.orDie,
                        ),
                }),
              );
              expect(Exit.isFailure(rejected)).toBe(true);
              if (Exit.isFailure(rejected)) expect(Cause.pretty(rejected.cause)).toContain('entered quarantine');
              expect(yield* readJsonFile(pointerPath)).toEqual(before);
              yield* writePrivateJsonFile(sharing.coordinatorStatePath, state);
            }
            const advanced = yield* publication;
            expect(advanced.published).toBe(true);
            expect(advanced.sourceCommit).toBe(target.headCommit);
            expect(advanced.generation).toBe(2);
            if (scenario === 'abi-transition') expect(advanced.checkpointDigest).not.toBe(baseline.checkpointDigest);
            expect(advanced.contributionEvidence).toMatchObject({
              selectedResults: eligibleFiles,
              verifiedResults: eligibleFiles,
              resultDigestsTruncated: false,
              hydration: {status: 'skipped-source-verification', hydratedResults: 0},
              sourceUse: {
                consumedActions: eligibleFiles,
                sourceVerifiedFiles: eligibleFiles,
                resultDigestsTruncated: false,
              },
              index: {reusedFiles: 0, totalFiles: eligibleFiles},
            });
            expect(advanced.contributionEvidence?.resultManifestDigests).toEqual(
              receipts.map(item => item.resultManifestDigest).sort(),
            );
            expect(advanced.contributionEvidence?.sourceUse?.consumedResultManifestDigests).toEqual(
              receipts.map(item => item.resultManifestDigest).sort(),
            );
            // Compare whole logical graphs, independently built from the same baseline and target Git source.
            const actual = yield* runCodeGraphCheckpointExport(config(home), {
              cwd: repo,
              output: path.join(root, 'actual.cgcp'),
              quiet: true,
            });
            const clean = yield* runCodeGraphCheckpointExport(config(controlHome), {
              cwd: repo,
              output: path.join(root, 'clean.cgcp'),
              quiet: true,
            });
            expect(actual.logicalDigest).toBe(clean.logicalDigest);
            expect(sharingRequests).toBe(0);
            yield* runGraphShareLeave(config(home), {cwd: repo});
            const forced = yield* indexer.index({cwd: repo, force: true, ensureVectors: false, threadnoteHome: home});
            expect(forced.reusedFiles).toBe(0);
            const unchanged = yield* advanceGraphPublisherFrontier(config(home), {cas, cwd: repo, forceFreeze: true});
            expect(unchanged.published).toBe(false);
            expect(unchanged.contributionEvidence).toBeUndefined();
          }).pipe(provideTestLayer(ApplicationLayer)),
        ),
      180_000,
    );
  }
});

function config(home: string) {
  return {
    account: 'local' as const,
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: `${home}/seed-manifest.yaml`,
    user: 'local',
  };
}
function git(repo: string, args: readonly string[]) {
  return runCommandEffect('git', ['-C', repo, ...args]);
}
const commit = Effect.fn(function* (repo: string, message: string) {
  yield* git(repo, ['add', '.']);
  yield* git(repo, [
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    message,
  ]);
});
