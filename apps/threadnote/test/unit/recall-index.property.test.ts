import {Array as EffectArray} from 'effect';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {Database, type SQLQueryBindings} from 'bun:sqlite';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {Effect} from 'effect';
import {
  clearRecallIndexMemoryCache,
  loadRecallExactMatches,
  loadRecallIndexData,
  recallIndexDatabaseFilename,
  recallIndexStatus,
} from '@threadnote/recall/index';
import {join, mkdir, mkdtemp, rm, writeFile} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

interface CorpusPut {
  readonly id: number;
  readonly kind: 'put';
  readonly variant: number;
}

interface CorpusRemove {
  readonly id: number;
  readonly kind: 'remove';
}

type CorpusOperation = CorpusPut | CorpusRemove;

const corpusOperation = FC.oneof(
  FC.record({
    id: FC.integer({max: 4, min: 0}),
    kind: FC.constant('put' as const),
    variant: FC.integer({max: 5, min: 0}),
  }),
  FC.record({
    id: FC.integer({max: 4, min: 0}),
    kind: FC.constant('remove' as const),
  }),
);

describe('SQLite recall index properties', () => {
  fcEffectProp(
    it,
    'matches a simple corpus model across arbitrary put, remove, reopen, and clean-rebuild sequences',
    {
      operations: FC.array(corpusOperation, {maxLength: 7, minLength: 1}),
    },
    ({operations}) =>
      Effect.promise(async () => {
        const home = await mkdtemp('threadnote-recall-property-');
        const model = new Map<number, number>();
        const config = {account: 'local', agentContextHome: home, user: 'property-user'};
        const corpusRoot = join(home, 'data', 'local', 'resources', 'repos', 'property');
        try {
          await mkdir(corpusRoot, {recursive: true});
          for (const operation of operations) {
            await applyCorpusOperation(corpusRoot, model, operation);
            const loaded = await runEffect(
              loadRecallIndexData(config, {
                forceRefresh: true,
                includeInactive: false,
              }),
            );
            assertCorpusMatchesModel(loaded.candidates, model);
            await assertIndexInternalsMatchModel(home, model);
            await assertExactMatchesMatchModel(config, model);
          }

          const first = await runEffect(
            loadRecallIndexData(config, {
              includeInactive: false,
            }),
          );
          const second = await runEffect(
            loadRecallIndexData(config, {
              includeInactive: false,
            }),
          );
          expect(projectCandidates(second.candidates)).toEqual(projectCandidates(first.candidates));
          expect(second.generation).toBe(first.generation);

          const exactBefore = await exactMatches(config, model);
          await rm(join(home, 'indexes', 'lexical'), {force: true, recursive: true});
          await runEffect(clearRecallIndexMemoryCache());
          const rebuilt = await runEffect(
            loadRecallIndexData(config, {
              forceRefresh: true,
              includeInactive: false,
            }),
          );
          assertCorpusMatchesModel(rebuilt.candidates, model);
          expect(await exactMatches(config, model)).toEqual(exactBefore);
          await assertIndexInternalsMatchModel(home, model);
        } finally {
          await rm(home, {force: true, recursive: true});
        }
      }),
    {fastCheck: {numRuns: 12}, timeout: 60_000},
  );
});

async function applyCorpusOperation(
  corpusRoot: string,
  model: Map<number, number>,
  operation: CorpusOperation,
): Promise<void> {
  const path = join(corpusRoot, `document-${operation.id}.md`);
  if (operation.kind === 'remove') {
    model.delete(operation.id);
    await rm(path, {force: true});
    return;
  }
  model.set(operation.id, operation.variant);
  await writeFile(path, documentText(operation.id, operation.variant), 'utf8');
}

function assertCorpusMatchesModel(
  candidates: readonly {readonly text: string; readonly uri: string}[],
  model: ReadonlyMap<number, number>,
): void {
  expect(projectCandidates(candidates)).toEqual(
    EffectArray.map([...model], ([id, variant]) => ({
      text: expect.stringContaining(termFor(variant)),
      uri: uriFor(id),
    })).sort((left, right) => Effect2.pipe(left.uri, EffectString.localeCompare(right.uri))),
  );
}

function projectCandidates(candidates: readonly {readonly text: string; readonly uri: string}[]) {
  return EffectArray.map(candidates, candidate => ({text: candidate.text, uri: candidate.uri})).sort((left, right) =>
    Effect2.pipe(left.uri, EffectString.localeCompare(right.uri)),
  );
}

async function assertIndexInternalsMatchModel(home: string, model: ReadonlyMap<number, number>): Promise<void> {
  const status = await runEffect(
    recallIndexStatus({
      account: 'local',
      agentContextHome: home,
      user: 'property-user',
    }),
  );
  expect(status).toMatchObject({documentCount: model.size, ready: true});

  const database = new Database(join(home, 'indexes', 'lexical', recallIndexDatabaseFilename(false)), {readonly: true});
  try {
    const documents = database
      .query<
        {
          readonly candidate_json: string;
          readonly uri: string;
        },
        SQLQueryBindings[]
      >('SELECT uri, candidate_json FROM documents ORDER BY uri')
      .all();
    expect(EffectArray.map(documents, document => document.uri)).toEqual(
      EffectArray.map([...model.keys()], uriFor).sort(),
    );
    for (const document of documents) {
      expect(JSON.parse(document.candidate_json)).toMatchObject({uri: document.uri});
    }
    expect(
      database
        .query(
          `SELECT COUNT(*) AS count
           FROM postings AS posting
           LEFT JOIN documents AS document ON document.id = posting.document_id
           WHERE document.id IS NULL`,
        )
        .get(),
    ).toEqual({count: 0});
  } finally {
    database.close();
  }
}

async function assertExactMatchesMatchModel(
  config: {readonly account: string; readonly agentContextHome: string; readonly user: string},
  model: ReadonlyMap<number, number>,
): Promise<void> {
  expect(await exactMatches(config, model)).toEqual(
    EffectArray.map([...model], ([id, variant]) => ({terms: [termFor(variant)], uri: uriFor(id)})).sort((left, right) =>
      Effect2.pipe(left.uri, EffectString.localeCompare(right.uri)),
    ),
  );
}

async function exactMatches(
  config: {readonly account: string; readonly agentContextHome: string; readonly user: string},
  model: ReadonlyMap<number, number>,
) {
  const terms = EffectArray.map(
    [...new Set(model.values())].sort((left, right) => left - right),
    termFor,
  );
  const matches = await runEffect(
    loadRecallExactMatches(config, {
      forceRefresh: true,
      includeInactive: false,
      limitPerTerm: 10,
      terms,
      uriScopes: ['threadnote://resources/repos/property'],
    }),
  );
  return EffectArray.map(matches, match => ({terms: [...match.terms].sort(), uri: match.uri})).sort((left, right) =>
    Effect2.pipe(left.uri, EffectString.localeCompare(right.uri)),
  );
}

function documentText(id: number, variant: number): string {
  return `# Document ${id}\n\n${termFor(variant)} property corpus value ${variant}.\n`;
}

function termFor(variant: number): string {
  return `propword${variant}anchor`;
}

function uriFor(id: number): string {
  return `threadnote://resources/repos/property/document-${id}.md`;
}
