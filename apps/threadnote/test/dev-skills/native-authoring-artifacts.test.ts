import {Effect, Result} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  makeAuthoringArtifacts,
  encodeAuthoringArtifact,
  splitAuthoringText,
} from '../../src/workflow_automation/authoring_artifacts.js';
import {nativeFixture, provideNative} from './native-automation-fixture.js';

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(TestClock.withLive, provideNative);
const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.result);

describe('native authoring artifacts', () => {
  effectIt.effect('round-trips bounded UTF-8 pages and permits repeated content links', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const initialized = yield* f.init();
      const codec = makeAuthoringArtifacts({
        call: f.call,
        runId: 'native-run',
        generation: 'skill-generation-v1',
        storageKind: 'durable',
        codeRefs: [],
        evidenceRefs: [],
      });
      const large = '漢🌊'.repeat(15_000);
      const root = yield* codec.writeData(large);
      expect(yield* codec.readData(root)).toBe(large);

      const repeatedPageText = '🙂'.repeat(2_500);
      const repeatedRoot = yield* codec.writeData(repeatedPageText + repeatedPageText);
      expect(yield* codec.readData(repeatedRoot)).toBe(repeatedPageText + repeatedPageText);

      const statePath = f.statePath();
      const journalPath = f.journalPath(initialized.bindingId);
      const stateBeforeReplay = yield* f.fs.readFileString(statePath);
      const journalBeforeReplay = yield* f.fs.readFileString(journalPath);
      const operationCount = (JSON.parse(stateBeforeReplay) as {operations: unknown[]}).operations.length;
      const retryRoot = yield* codec.writeData(large);
      expect(retryRoot).toEqual(root);
      expect(yield* codec.readData(retryRoot)).toBe(large);
      expect(yield* f.fs.readFileString(statePath)).toBe(stateBeforeReplay);
      expect(yield* f.fs.readFileString(journalPath)).toBe(journalBeforeReplay);
      expect((JSON.parse(yield* f.fs.readFileString(statePath)) as {operations: unknown[]}).operations).toHaveLength(
        operationCount,
      );

      const changedReference = {...root, revision: '0'.repeat(64)};
      const changed = yield* failure(codec.readData(changedReference));
      expect(Result.isFailure(changed)).toBe(true);

      const nativeRootBody = encodeAuthoringArtifact('Spec', 'Root envelope', {
        format: 'threadnote-native-authoring-root',
        version: 1,
        kind: 'spec',
        featureId: 'feature',
        documentHash: '1'.repeat(64),
        intentHash: '2'.repeat(64),
        readiness: 'draft',
        data: root,
        dataHash: '3'.repeat(64),
        documents: [],
      });
      const nativeRoot = yield* codec.write({body: nativeRootBody, nameHint: 'spec'});
      const rootEnvelopeRead = yield* failure(
        codec.readData({
          uri: nativeRoot.uri,
          memoryId: nativeRoot.memoryId,
          revision: nativeRoot.revision,
        }),
      );
      expect(Result.isFailure(rootEnvelopeRead)).toBe(true);

      const leafText = 'a child page';
      const leafBody = encodeAuthoringArtifact('Leaf', 'Structured page', {
        format: 'threadnote-native-authoring-data',
        version: 1,
        contentHash: sha256HexSync(leafText),
        content: btoa(leafText),
      });
      const leaf = yield* codec.write({body: leafBody, nameHint: 'source'});
      const forgedIndexBody = encodeAuthoringArtifact('Forged index', 'Changed child reference', {
        format: 'threadnote-native-authoring-index',
        version: 1,
        depth: 1,
        children: [{uri: leaf.uri, memoryId: leaf.memoryId, revision: '0'.repeat(64)}],
      });
      const forgedIndex = yield* codec.write({body: forgedIndexBody, nameHint: 'index'});
      const childDrift = yield* failure(
        codec.readData({
          uri: forgedIndex.uri,
          memoryId: forgedIndex.memoryId,
          revision: forgedIndex.revision,
        }),
      );
      expect(Result.isFailure(childDrift)).toBe(true);

      const legacy = yield* f.call(
        f.write({
          operationId: 'legacy-authoring-record',
          artifactKey: 'legacy-authoring-record',
          body: '# Old authoring record\n\nUnmarked legacy data.\n',
        }),
      );
      if (!('artifact' in legacy)) throw new Error('Expected a legacy test artifact');
      const legacyRead = yield* failure(
        codec.readData({
          uri: legacy.artifact.uri,
          memoryId: legacy.artifact.memoryId,
          revision: legacy.artifact.revision,
        }),
      );
      expect(Result.isFailure(legacyRead)).toBe(true);

      const beforeOversize = yield* f.fs.readFileString(statePath);
      expect(() => encodeAuthoringArtifact('Oversize', 'Bound check', {payload: 'x'.repeat(60_000)})).toThrow(
        expect.objectContaining({code: 'authoring-size'}),
      );
      expect(yield* f.fs.readFileString(statePath)).toBe(beforeOversize);
    }).pipe(run),
  );

  effectIt.effect('bounds splitting by UTF-8 bytes without dropping code points', () =>
    Effect.sync(() => {
      const input = 'é🌍'.repeat(8_000);
      const pages = splitAuthoringText(input);
      expect(pages.join('')).toBe(input);
      expect(pages.every(page => new TextEncoder().encode(page).byteLength <= 20_000)).toBe(true);
    }),
  );
});
