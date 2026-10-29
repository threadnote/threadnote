import {Array as EffectArray, Option as EffectOption} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Database, type SQLQueryBindings} from 'bun:sqlite';
import {Effect, FileSystem, Layer} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';

import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {selectLocalModel} from '@threadnote/inference/models/selection';
import {LocalModelStore, type LocalModelStoreShape} from '@threadnote/inference/models/store';
import type {RecallEligibilityPolicy} from '@threadnote/recall/eligibility';
import type {RecallCandidate} from '@threadnote/recall/rank';
import {
  ensureVectorIndex,
  rebuildVectorIndex,
  selectedSemanticScores,
  vectorIndexDatabaseFilename,
  vectorIndexStatus,
} from '@threadnote/recall/vector-index';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

function requiredRow<Row extends object>(row: Row | null): Row {
  if (row === null) throw TestError.make({message: 'Expected a row for a required SQLite query result.'});
  return row;
}

const manifest = EffectOption.getOrUndefined(
  EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, model => model.id === 'bge-small-en-v1.5-q8'),
)!;
const TARGET_URI = 'threadnote://user/me/memories/durable/projects/target-app/target.md';
const TARGET_ALIAS = 'threadnote://user/me/memories/shared/team/durable/projects/target-app/target.md';
const PROJECTLESS_URI = 'threadnote://resources/global/approved-guidance.md';
const PROJECTLESS_ALIAS = 'threadnote://user/me/memories/shared/team/durable/global/approved-guidance.md';

describe('vector recall eligibility', () => {
  effectIt.effect(
    'filters project and authority before semantic top-k and does not expand aliases from rejected representatives',
    () =>
      withVectorHome(
        semanticRuntime(input =>
          Effect2.pipe(input, EffectString.includes('eligible-weaker-vector')) ? blendedVector() : unitVector(0),
        ),
        home =>
          Effect.gen(function* () {
            const candidates: RecallCandidate[] = [
              ...Array.from({length: 8}, (_, index) =>
                candidate({
                  alias: `threadnote://user/me/memories/shared/team/durable/projects/other-app/wrong-${index}.md`,
                  approved: true,
                  project: 'other-app',
                  text: `# Strong other project ${index}\n\nstrong-disallowed-vector`,
                  uri: `threadnote://user/me/memories/durable/projects/other-app/wrong-${index}.md`,
                }),
              ),
              ...Array.from({length: 8}, (_, index) =>
                candidate({
                  alias: `threadnote://user/me/memories/shared/team/durable/projects/target-app/unapproved-${index}.md`,
                  approved: false,
                  project: 'target-app',
                  text: `# Strong unapproved ${index}\n\nstrong-disallowed-vector`,
                  uri: `threadnote://user/me/memories/durable/projects/target-app/unapproved-${index}.md`,
                }),
              ),
              candidate({
                alias: PROJECTLESS_ALIAS,
                approved: true,
                text: '# Approved global guidance\n\nstrong-projectless-vector',
                uri: PROJECTLESS_URI,
              }),
              candidate({
                alias: TARGET_ALIAS,
                approved: true,
                project: 'TARGET-APP',
                text: '# Eligible target\n\neligible-weaker-vector',
                uri: TARGET_URI,
              }),
            ];
            yield* rebuildVectorIndex({agentContextHome: home}, manifest, candidates);

            const unrestricted = yield* selectedSemanticScores({agentContextHome: home}, 'semantic target query', {
              limit: 5,
            });
            const projectOnly = yield* selectedSemanticScores({agentContextHome: home}, 'semantic target query', {
              eligibility: eligibility('any'),
              limit: 5,
            });
            const approvedProject = yield* selectedSemanticScores({agentContextHome: home}, 'semantic target query', {
              eligibility: eligibility('approved-authoritative'),
              limit: 5,
            });
            const pinnedAlias = yield* selectedSemanticScores({agentContextHome: home}, 'semantic target query', {
              allowedUriScopes: [TARGET_ALIAS],
              eligibility: {kind: 'pinned-hard-uri-bypass'},
              limit: 1,
            });

            expect(unrestricted?.has(TARGET_URI)).toBe(false);
            expect(projectOnly?.has(TARGET_URI)).toBe(false);
            expect(approvedProject?.size).toBe(4);
            expect(approvedProject?.get(TARGET_URI)).toBeCloseTo(0.8);
            expect(approvedProject?.get(TARGET_ALIAS)).toBeCloseTo(0.8);
            expect(approvedProject?.get(PROJECTLESS_URI)).toBeCloseTo(1);
            expect(approvedProject?.get(PROJECTLESS_ALIAS)).toBeCloseTo(1);
            expect([...approvedProject!.keys()]).not.toEqual(
              expect.arrayContaining([expect.stringContaining('/other-app/'), expect.stringContaining('/unapproved-')]),
            );
            expect(pinnedAlias?.size).toBe(1);
            expect(pinnedAlias?.get(TARGET_ALIAS)).toBeCloseTo(0.8);
            expect(pinnedAlias?.has(TARGET_URI)).toBe(false);
          }),
      ),
  );

  effectIt.effect('invalidates metadata-only mappings while reusing their content vectors', () => {
    const embeddedDocuments: string[] = [];
    return withVectorHome(
      semanticRuntime(
        () => unitVector(0),
        inputs => embeddedDocuments.push(...inputs),
      ),
      home =>
        Effect.gen(function* () {
          const initial = [
            candidate({
              approved: false,
              project: 'other-app',
              text: '# Stable vector\n\nMetadata changes without changing this content.',
              uri: TARGET_URI,
            }),
          ];
          const approved = [
            candidate({
              approved: true,
              project: ' TARGET-APP ',
              text: initial[0].text,
              uri: TARGET_URI,
            }),
          ];

          const first = yield* ensureVectorIndex({agentContextHome: home}, manifest, initial);
          const initialRow = yield* readOnlyVectorRow(home);
          const refreshed = yield* ensureVectorIndex({agentContextHome: home}, manifest, approved);
          const approvedRow = yield* readOnlyVectorRow(home);
          const staleStatus = yield* vectorIndexStatus(home, manifest, initial);
          const currentStatus = yield* vectorIndexStatus(home, manifest, approved);
          const rebuilt = yield* rebuildVectorIndex({agentContextHome: home}, manifest, initial);
          const rebuiltRow = yield* readOnlyVectorRow(home);

          expect(first).toMatchObject({embeddedChunkCount: 1, reusedChunkCount: 0});
          expect(refreshed).toMatchObject({embeddedChunkCount: 0, reusedChunkCount: 1});
          expect(refreshed.generation).not.toBe(first.generation);
          expect(approvedRow).toEqual({
            approved_authoritative: 1,
            project: 'target-app',
            vector_id: initialRow.vector_id,
          });
          expect(staleStatus).toMatchObject({ready: false, reason: 'stale; canonical documents changed'});
          expect(currentStatus.ready).toBe(true);
          expect(rebuilt).toMatchObject({embeddedChunkCount: 0, reusedChunkCount: 1});
          expect(rebuilt.generation).not.toBe(refreshed.generation);
          expect(rebuiltRow).toEqual({
            approved_authoritative: 0,
            project: 'other-app',
            vector_id: initialRow.vector_id,
          });
          expect(embeddedDocuments).toHaveLength(1);
        }),
    );
  });

  fcEffectProp(
    effectIt,
    'keeps vector mapping identity stable across candidate permutations',
    {
      order: fc.shuffledSubarray([0, 1, 2, 3], {maxLength: 4, minLength: 4}),
    },
    ({order}) => {
      const embeddedDocuments: string[] = [];
      return withVectorHome(
        semanticRuntime(
          () => unitVector(0),
          inputs => embeddedDocuments.push(...inputs),
        ),
        home =>
          Effect.gen(function* () {
            const candidates = Array.from({length: 4}, (_, index) =>
              candidate({
                alias: `threadnote://user/me/memories/shared/team/durable/projects/project-${index}/doc.md`,
                approved: index % 2 === 0,
                project: `project-${index}`,
                text: `# Stable ${index}\n\nPermutation-safe vector ${index}.`,
                uri: `threadnote://user/me/memories/durable/projects/project-${index}/doc.md`,
              }),
            );
            const first = yield* ensureVectorIndex({agentContextHome: home}, manifest, candidates);
            const permuted = yield* ensureVectorIndex(
              {agentContextHome: home},
              manifest,
              EffectArray.map(order, index => candidates[index]),
            );

            expect(permuted.generation).toBe(first.generation);
            expect(permuted).toMatchObject({embeddedChunkCount: 0, reusedChunkCount: 4});
            expect(embeddedDocuments).toHaveLength(4);
          }),
      );
    },
    {fastCheck: {numRuns: 8}},
  );
});

function candidate(input: {
  readonly alias?: string;
  readonly approved: boolean;
  readonly project?: string;
  readonly text: string;
  readonly uri: string;
}): RecallCandidate {
  return {
    authority: input.approved ? 'canonical_repo' : 'agent_generated',
    equivalentUris: input.alias === undefined ? undefined : [input.alias],
    fields: input.project === undefined ? undefined : {project: input.project},
    text: input.text,
    trust: input.approved ? 'approved' : 'inferred',
    uri: input.uri,
  };
}

function eligibility(authority: 'any' | 'approved-authoritative'): RecallEligibilityPolicy {
  return {
    authority,
    kind: 'candidate-policy',
    projects: {mode: 'allow-projects-and-projectless', projects: ['target-app']},
  };
}

function withVectorHome<A, E, R>(
  runtimeLayer: Layer.Layer<LocalModelRuntime>,
  use: (home: string) => Effect.Effect<A, E, R>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-eligibility-'});
      const catalog = yield* LocalModelCatalog;
      yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
      return yield* use(home);
    }),
  ).pipe(
    provideTestLayer(runtimeLayer),
    provideTestLayer(modelStoreLayer),
    provideTestLayer(LocalModelCatalog.layer([manifest])),
    provideTestLayer(TestSystemInfoLayer),
    provideTestLayer(BunServices.layer),
    TestClock.withLive,
  );
}

function readOnlyVectorRow(home: string) {
  return Effect.acquireUseRelease(
    Effect.sync(() => new Database(vectorDatabasePath(home), {readonly: true})),
    database =>
      Effect.sync(() =>
        requiredRow(
          database
            .query<
              {
                readonly approved_authoritative: number;
                readonly project: string | null;
                readonly vector_id: number;
              },
              SQLQueryBindings[]
            >('SELECT project, approved_authoritative, vector_id FROM vector_chunks LIMIT 1')
            .get(),
        ),
      ),
    database => Effect.sync(() => database.close()),
  );
}

const modelStoreLayer = Layer.succeed(
  LocalModelStore,
  LocalModelStore.of({
    install: () => Effect.die(TestError.make({message: 'Unexpected install'})),
    path: home => `${home}/models/fake.gguf`,
    remove: () => Effect.succeed(false),
    status: home => Effect.succeed(installation(home)),
    verify: home => Effect.succeed(installation(home)),
  } satisfies LocalModelStoreShape),
);

function semanticRuntime(
  vector: (input: string) => readonly number[],
  onInputs: (inputs: readonly string[]) => void = () => undefined,
) {
  return Layer.succeed(
    LocalModelRuntime,
    LocalModelRuntime.of({
      diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 4}),
      embedMany: ({inputs}) =>
        Effect.sync(() => {
          onInputs(inputs);
          return EffectArray.map(inputs, vector);
        }),
      generate: () => Effect.die(TestError.make({message: 'Unexpected generation'})),
      rerank: () => Effect.die(TestError.make({message: 'Unexpected reranking'})),
    }),
  );
}

function installation(home: string) {
  return {
    bytes: manifest.size,
    installed: true,
    modelId: manifest.id,
    partialBytes: 0,
    path: `${home}/models/fake.gguf`,
    verified: true,
  };
}

function vectorIndexDatabasePath(home: string): string {
  return `${home}/indexes/vectors/${manifest.id}/${vectorIndexDatabaseFilename()}`;
}

function vectorDatabasePath(home: string): string {
  return vectorIndexDatabasePath(home);
}

function unitVector(index: number): readonly number[] {
  const vector = new Array<number>(manifest.dimensions).fill(0);
  vector[index] = 1;
  return vector;
}

function blendedVector(): readonly number[] {
  const vector = new Array<number>(manifest.dimensions).fill(0);
  vector[0] = 0.8;
  vector[1] = 0.6;
  return vector;
}
