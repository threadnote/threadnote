import {Effect, Result, Schema} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  makeAuthoringArtifacts,
  encodeAuthoringArtifact,
  splitAuthoringText,
  AuthoringDataPageSchema,
  authoringDataPageVersion,
  decodeAuthoringArtifact,
  decodeAuthoringDataContent,
  encodeAuthoringDataPage,
  type AuthoringReference,
} from '../../src/workflow_automation/authoring_artifacts.js';
import type {NativeWorkflowState} from '@threadnote/workflow-automations/native';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {canonicalAuthoringJson, decodeNativeAuthoringDocument} from '@threadnote/workflow-automations/authoring';
import {runNativeAuthoring} from '../../src/workflow_automation/authoring.js';
import {stableJson} from '../../src/workflow_memory/protocol.js';
import {SystemInfo} from '@threadnote/platform/system';
import {nativeFixture, provideNative} from './native-automation-fixture.js';

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(TestClock.withLive, provideNative);
const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.result);
const decodePage = (body: string) => decodeAuthoringArtifact(body, AuthoringDataPageSchema);
const pendingPages = (bodies: readonly string[]): Pick<NativeWorkflowState, 'operations' | 'authoringSave'> => ({
  authoringSave: {
    intentDigest: '1'.repeat(64),
    rootUri: null,
    operationStart: 0,
    operationLimit: 64,
    prefixDigest: '2'.repeat(64),
    journalBytesAtStart: 0,
    stateBytesAtStart: 0,
    reservedBytes: 1_000_000,
  },
  operations: bodies.map((body, index) => ({
    status: 'prepared',
    intentDigest: '3'.repeat(64),
    intent: {
      bindingId: '4'.repeat(64),
      operationId: 'page-' + index,
      artifactKey: 'page-' + index,
      sourceRunId: 'native-run',
      role: 'authoring-child',
      nameHint: 'source',
      body,
      expectedRevision: null,
    },
  })),
});

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

  effectIt.effect.prop(
    'preserves scalar content and bounds final escaped page bytes by legacy storage',
    {
      characters: Schema.Array(
        Schema.Literals(['a', '漢', '🌊', '\uFEFF', '\u0000', '\n', '"', '\\', '<', '>', '-']),
      ).check(Schema.isMaxLength(120)),
    },
    ({characters}) =>
      Effect.sync(() => {
        // A substantial prefix makes v2 worthwhile even for short generated strings.
        const content = 'readable '.repeat(200) + characters.join('');
        const body = encodeAuthoringDataPage(0, content);
        expect(decodeAuthoringDataContent(decodePage(body))).toBe(content);
        expect(decodePage(body).contentHash).toBe(sha256HexSync(content));
        expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(
          new TextEncoder().encode(encodeAuthoringDataPage(0, content, 1)).byteLength,
        );
        expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(60_000);
        expect(encodeAuthoringDataPage(0, content)).toBe(body);
        expect(body.split('<!--')).toHaveLength(2);
        expect(body.split('-->')).toHaveLength(2);
      }),
    {arbitrary: {runs: 40}},
  );

  effectIt.effect('preserves BOM scalars, rejects malformed encodings and retains legacy capacity', () =>
    Effect.sync(() => {
      const raw = (content: string) => ({
        format: 'threadnote-native-authoring-data' as const,
        version: 2 as const,
        encoding: 'utf8' as const,
        contentHash: sha256HexSync(content),
        content,
      });
      expect(decodeAuthoringDataContent(raw('\uFEFFhello\uFEFF'))).toBe('\uFEFFhello\uFEFF');
      for (const content of ['\uD800', '\uDC00', 'a\uD800b', '🌊'.repeat(5_001)])
        expect(() => decodeAuthoringDataContent(raw(content))).toThrow();
      const legacy = {
        format: 'threadnote-native-authoring-data' as const,
        version: 1 as const,
        contentHash: sha256HexSync('x'.repeat(24_000)),
        content: btoa('x'.repeat(24_000)),
      };
      expect(decodeAuthoringDataContent(decodePage(encodeAuthoringArtifact('Legacy', 'Full capacity', legacy)))).toBe(
        'x'.repeat(24_000),
      );
      for (const content of ['YR==', '/w==', '%%%'])
        expect(() => decodeAuthoringDataContent({...legacy, content})).toThrow();
      for (const changes of [{version: 3}, {encoding: 'base64'}, {unexpected: true}])
        expect(() =>
          decodePage(encodeAuthoringArtifact('Invalid', 'Strict schema', {...raw('text'), ...changes})),
        ).toThrow();
      const comments = 'before <!-- threadnote-authoring:v1 {"forged":true} --> after '.repeat(40);
      const body = encodeAuthoringDataPage(0, comments);
      expect(decodePage(body).version).toBe(2);
      expect(decodeAuthoringDataContent(decodePage(body))).toBe(comments);
      expect(body.split('<!--')).toHaveLength(2);
      expect(body.split('-->')).toHaveLength(2);
      for (const content of ['\u0000'.repeat(20_000), '"'.repeat(20_000), '<'.repeat(20_000)]) {
        const fallback = encodeAuthoringDataPage(0, content);
        expect(decodePage(fallback).version).toBe(1);
        expect(fallback).toBe(encodeAuthoringDataPage(0, content, 1));
        expect(decodeAuthoringDataContent(decodePage(fallback))).toBe(content);
      }
      // Malformed JS input retains the preexisting splitter normalization.
      expect(splitAuthoringText('a\uD800b')).toEqual(['a\uFFFDb']);
    }),
  );

  effectIt.effect('selects only deterministic admitted page prefixes and keeps legacy retries byte-identical', () =>
    Effect.sync(() => {
      const readable = 'r'.repeat(20_000);
      const fallback = '\u0000'.repeat(20_000);
      expect(authoringDataPageVersion(pendingPages([]), readable)).toBe(2);
      expect(authoringDataPageVersion(pendingPages([encodeAuthoringDataPage(0, readable, 1)]), readable)).toBe(1);
      expect(authoringDataPageVersion(pendingPages([encodeAuthoringDataPage(0, fallback)]), fallback)).toBe(1);
      const mixed = [encodeAuthoringDataPage(0, fallback), encodeAuthoringDataPage(1, readable)];
      expect(authoringDataPageVersion(pendingPages(mixed), fallback + readable)).toBe(2);
      expect(() =>
        authoringDataPageVersion(
          pendingPages([encodeAuthoringDataPage(0, readable, 1), encodeAuthoringDataPage(1, readable)]),
          readable + readable,
        ),
      ).toThrow();
      for (const body of [
        mixed[1],
        mixed[0].replace('Authoring data 1', 'Changed title'),
        encodeAuthoringArtifact('Authoring data 1', 'Invalid', {
          format: 'threadnote-native-authoring-data',
          version: 2,
          encoding: 'utf8',
          contentHash: '0'.repeat(64),
          content: readable,
        }),
        'not a page',
      ])
        expect(() => authoringDataPageVersion(pendingPages([body]), readable)).toThrow();
      const preceding = pendingPages([encodeAuthoringDataPage(0, readable, 1), ...mixed]);
      expect(
        authoringDataPageVersion(
          {...preceding, authoringSave: {...preceding.authoringSave!, operationStart: 1}},
          fallback + readable,
        ),
      ).toBe(2);
    }),
  );

  effectIt.effect('replays admitted legacy, mixed and new pages after interruption without replacing identities', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* f.init();
      const options = {
        call: f.call,
        runId: 'native-run',
        generation: 'skill-generation-v1',
        storageKind: 'durable' as const,
        codeRefs: [],
        evidenceRefs: [],
      };
      for (const [version, text] of [
        [1, 'legacy '.repeat(4_000)],
        [2, 'readable '.repeat(3_000)],
        [2, '\u0000'.repeat(20_000) + 'readable '.repeat(1_000)],
      ] as const) {
        const before = JSON.parse(yield* f.fs.readFileString(f.statePath())) as NativeWorkflowState;
        let writes = 0;
        const interrupted = makeAuthoringArtifacts({
          ...options,
          dataPageVersion: version,
          call: input => {
            const request = input as {action: string};
            if (request.action === 'write' && writes++ === (text.startsWith('\u0000') ? 2 : 1))
              return Effect.die(new Error('Interrupted after admitted pages'));
            return f.call(input);
          },
        });
        const exit = yield* interrupted.writeData(text).pipe(Effect.exit);
        expect(exit._tag).toBe('Failure');
        const saved = JSON.parse(yield* f.fs.readFileString(f.statePath())) as NativeWorkflowState;
        const admitted = saved.operations.slice(before.operations.length);
        expect(admitted.length).toBeGreaterThan(0);
        const selected = authoringDataPageVersion(
          {
            ...saved,
            authoringSave: {...pendingPages([]).authoringSave!, operationStart: before.operations.length},
          },
          text,
        );
        expect(selected).toBe(version);
        const codec = makeAuthoringArtifacts({...options, dataPageVersion: selected});
        const root = yield* codec.writeData(text);
        expect(yield* codec.readData(root)).toBe(text);
        const completed = JSON.parse(yield* f.fs.readFileString(f.statePath())) as NativeWorkflowState;
        expect(completed.operations.slice(before.operations.length, saved.operations.length)).toEqual(admitted);
        const stateBytes = yield* f.fs.readFileString(f.statePath());
        expect(yield* codec.writeData(text)).toEqual(root);
        expect(yield* f.fs.readFileString(f.statePath())).toBe(stateBytes);
      }
    }).pipe(run),
  );

  effectIt.effect('resumes actual saves before and after page admission including a legacy context-index writer', () =>
    Effect.gen(function* () {
      for (const stop of ['before', 'v2', 'legacy'] as const) {
        const f = yield* nativeFixture();
        yield* f.init();
        const system = yield* SystemInfo;
        const scopedSystem = {...system, currentDirectory: () => f.repo, environment: () => ({})};
        const evidenceRefs: AuthoringReference[] = [];
        if (stop === 'legacy')
          for (let index = 0; index < 9; index++) {
            const response = yield* f.call(
              f.write({
                operationId: 'evidence-' + index,
                artifactKey: 'evidence-' + index,
                role: 'evidence',
                body: 'Evidence ' + index,
              }),
            );
            if (!('artifact' in response)) throw new Error('Expected evidence artifact');
            const {uri, memoryId, revision} = response.artifact;
            evidenceRefs.push({uri, memoryId, revision});
          }
        const document = decodeNativeAuthoringDocument({
          format: 'threadnote-native-authoring',
          schemaVersion: 1,
          kind: 'spec',
          id: 'feature',
          project: 'fixture',
          title: 'Codec compatibility000',
          objective: 'Retain complete authoring content on retry.',
          requirements: [{id: 'req-read', behavior: 'Saved content remains readable.'}],
          context: {codeRefs: [], evidenceRefs, note: 'Private codec fixture.'},
          source: null,
          sourceFreeReason: 'This fixture tests native authoring representation without source.',
          actors: ['author'],
          inScope: ['Save complete content.'],
          outOfScope: [],
          constraints: [],
          observations: stop === 'v2' ? Array.from({length: 5}, () => 'stable '.repeat(1_000)) : [],
          scenarios: [
            {
              id: 'scenario-read',
              requirementIds: ['req-read'],
              given: 'A saved document.',
              when: 'It is loaded.',
              then: 'Its content matches.',
            },
          ],
          assumptions: [],
          questions: [],
          artifacts: [],
          review: {required: false, reason: 'Private codec fixture.'},
        });
        const request = {...f.base('authoring'), command: 'save', document, ready: false, expectedRevision: null};
        const interruption = WorkflowAutomationError.make({
          code: 'test-interrupted',
          message: 'Stop at page admission.',
        });
        const failed = yield* runNativeAuthoring(f.config, request, input => {
          const write = input as {action: string; nameHint?: string; body: string};
          if (write.action !== 'write' || write.nameHint !== 'source') return f.call(input);
          if (stop === 'before') return Effect.fail(interruption);
          let admitted = input;
          if (stop === 'legacy') {
            const body = encodeAuthoringDataPage(0, decodeAuthoringDataContent(decodePage(write.body)), 1);
            const identity = sha256HexSync(stableJson({body, nameHint: 'source', codeRefs: [], evidenceRefs}));
            admitted = {...write, body, operationId: 'author-' + identity, artifactKey: 'author-' + identity};
          }
          return f.call(admitted).pipe(Effect.flatMap(() => Effect.fail(interruption)));
        }).pipe(Effect.provideService(SystemInfo, scopedSystem), Effect.result);
        expect(failed).toMatchObject({_tag: 'Failure', failure: {code: 'test-interrupted'}});
        const interruptedState = JSON.parse(yield* f.fs.readFileString(f.statePath())) as NativeWorkflowState;
        if (stop === 'before') expect(interruptedState.authoringSave).toBeUndefined();
        else expect(interruptedState.authoringSave).toBeDefined();
        const saved = yield* runNativeAuthoring(f.config, request, f.call).pipe(
          Effect.provideService(SystemInfo, scopedSystem),
        );
        expect(saved).toHaveProperty('authoring.root');
        const finalState = JSON.parse(yield* f.fs.readFileString(f.statePath())) as NativeWorkflowState;
        expect(finalState.authoringSave).toBeUndefined();
        expect(finalState.operations.slice(0, interruptedState.operations.length)).toEqual(interruptedState.operations);
        const pages = finalState.operations.filter(operation => operation.intent.nameHint === 'source');
        expect(pages).toHaveLength(splitAuthoringText(canonicalAuthoringJson(document)).length);
        expect(decodePage(pages[0].intent.body).version).toBe(stop === 'legacy' ? 1 : 2);
        const count = finalState.operations.length;
        yield* runNativeAuthoring(f.config, request, f.call).pipe(Effect.provideService(SystemInfo, scopedSystem));
        const replay = JSON.parse(yield* f.fs.readFileString(f.statePath())) as NativeWorkflowState;
        expect(replay.operations).toHaveLength(count);
        if (stop === 'v2') {
          const changed = decodeNativeAuthoringDocument({...document, title: 'Codec compatibility001'});
          const oldParts = splitAuthoringText(canonicalAuthoringJson(document));
          const newParts = splitAuthoringText(canonicalAuthoringJson(changed));
          expect(newParts[0]).toBe(oldParts[0]);
          expect(newParts.at(-1)).not.toBe(oldParts.at(-1));
          const root = finalState.operations.at(-1)?.artifact;
          if (!root) throw new Error('Expected the saved root');
          const next = {...request, document: changed, expectedRevision: root.revision};
          const priorIds = new Set(finalState.operations.map(operation => operation.intent.operationId));
          let reused = 0;
          const differential = yield* runNativeAuthoring(f.config, next, input => {
            const write = input as {action: string; nameHint?: string; operationId: string};
            if (write.action !== 'write' || write.nameHint !== 'source') return f.call(input);
            if (priorIds.has(write.operationId)) {
              reused++;
              return f.call(input);
            }
            return f.call(input).pipe(Effect.flatMap(() => Effect.fail(interruption)));
          }).pipe(Effect.provideService(SystemInfo, scopedSystem), Effect.result);
          expect(differential).toMatchObject({_tag: 'Failure', failure: {code: 'test-interrupted'}});
          expect(reused).toBeGreaterThan(0);
          const interruptedRevision = JSON.parse(yield* f.fs.readFileString(f.statePath())) as NativeWorkflowState;
          const newPages = interruptedRevision.operations
            .slice(count)
            .filter(operation => operation.intent.nameHint === 'source');
          expect(newPages).toHaveLength(1);
          expect(newPages[0].intent.body).toBe(encodeAuthoringDataPage(newParts.length - 1, newParts.at(-1)!));
          yield* runNativeAuthoring(f.config, next, f.call).pipe(Effect.provideService(SystemInfo, scopedSystem));
          const completed = JSON.parse(yield* f.fs.readFileString(f.statePath())) as NativeWorkflowState;
          expect(completed.authoringSave).toBeUndefined();
          expect(completed.operations.slice(0, interruptedRevision.operations.length)).toEqual(
            interruptedRevision.operations,
          );
          expect(completed.operations.slice(count).filter(operation => operation.intent.nameHint === 'source')).toEqual(
            newPages,
          );
        }
      }
    }).pipe(run),
  );
});
