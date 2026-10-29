import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe, expect} from 'vitest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {runArchive} from '@threadnote/threadnote/memory/index';
import {createMemoryCodeCitation, MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {loadRecallExactMatches, loadRecallIndexData} from '@threadnote/recall/index';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Array as EffectArray} from 'effect';

describe('recall exact-search citation privacy', () => {
  effectIt.effect('indexes body and discovery metadata without machine citation headers', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-recall-citation-privacy-'});
      const memoryRoot = path.join(home, 'data', 'local', 'user', 'privacy-user', 'memories', 'durable');
      yield* fs.makeDirectory(memoryRoot, {recursive: true});
      const citation = createMemoryCodeCitation({
        extractorSet: 'native-code-graph-13',
        fileContentHash: {algorithm: 'sha256', value: Effect2.pipe('a', EffectString.repeat(64))},
        path: 'src/private.ts',
        repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
        repositoryIdentityKind: 'remote',
        sourceCommit: Effect2.pipe('c', EffectString.repeat(40)),
        sourceDirty: false,
        sourceSnapshotId: `cgsn_${Effect2.pipe('d', EffectString.repeat(40))}`,
        target: {kind: 'file'},
        version: 1,
      });
      yield* fs.writeFileString(
        path.join(memoryRoot, 'citation-privacy.md'),
        formatMemoryDocument(
          'MEMORY',
          {
            codeCitations: [citation],
            kind: 'durable',
            project: 'threadnote',
            schemaVersion: MEMORY_SCHEMA_VERSION,
            sourceAgentClient: 'codex',
            status: 'active',
            timestamp: '2026-08-26T00:00:00.000Z',
            topic: 'citation privacy topic',
          },
          'Useful citation body sentinel remains exactly searchable.',
        ),
      );
      const config = {account: 'local', agentContextHome: home, user: 'privacy-user'};
      yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: false});
      const searchable = ['citation body sentinel', 'citation privacy topic'];
      const privateMachineValues = [
        citation.id,
        citation.repositoryId,
        citation.sourceSnapshotId,
        citation.fileContentHash.value,
      ];
      const matches = yield* loadRecallExactMatches(config, {
        forceRefresh: false,
        includeInactive: false,
        limitPerTerm: 10,
        terms: [...searchable, ...privateMachineValues],
        uriScopes: ['threadnote://user/privacy-user/memories'],
      });
      const matchedTerms = new Set(EffectArray.flatMap(matches, match => match.terms));

      expect(matchedTerms).toEqual(new Set(searchable));
      for (const privateValue of privateMachineValues) expect(matchedTerms).not.toContain(privateValue);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps archived citation identifiers out of inactive exact search and postings', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-archive-citation-privacy-'});
      const user = 'privacy-user';
      const topic = 'archived-citation-privacy';
      const sourceUri = `threadnote://user/${user}/memories/durable/projects/threadnote/${topic}.md`;
      const sourcePath = path.join(
        home,
        'data',
        'local',
        'user',
        user,
        'memories',
        'durable',
        'projects',
        'threadnote',
        `${topic}.md`,
      );
      const citation = createMemoryCodeCitation({
        extractorSet: 'native-code-graph-13',
        fileContentHash: {algorithm: 'sha256', value: Effect2.pipe('e', EffectString.repeat(64))},
        path: 'src/archive-private.ts',
        repositoryId: Effect2.pipe('f', EffectString.repeat(64)),
        repositoryIdentityKind: 'remote',
        sourceCommit: Effect2.pipe('1', EffectString.repeat(40)),
        sourceDirty: false,
        sourceSnapshotId: `cgsn_${Effect2.pipe('2', EffectString.repeat(40))}`,
        target: {kind: 'file'},
        version: 1,
      });
      const source = formatMemoryDocument(
        'MEMORY',
        {
          codeCitations: [citation],
          kind: 'durable',
          project: 'threadnote',
          schemaVersion: MEMORY_SCHEMA_VERSION,
          sourceAgentClient: 'codex',
          status: 'active',
          timestamp: '2026-08-26T00:00:00.000Z',
          topic,
        },
        'Archived source prose sentinel remains retrievable.',
      );
      yield* fs.makeDirectory(path.dirname(sourcePath), {recursive: true});
      yield* fs.writeFileString(sourcePath, source);
      const config = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath: path.join(home, 'manifest.yaml'),
        user,
      };

      yield* runArchive(config, sourceUri, {
        expectedContent: source,
        kind: 'durable',
        project: 'threadnote',
        topic,
      });

      const bodyPostings = yield* loadRecallIndexData(config, {
        forceRefresh: true,
        includeInactive: true,
        limit: 10,
        query: 'archived source prose sentinel',
      });
      const privatePostings = yield* loadRecallIndexData(config, {
        includeInactive: true,
        limit: 10,
        query: citation.id,
      });
      const exact = yield* loadRecallExactMatches(config, {
        includeInactive: true,
        limitPerTerm: 10,
        terms: ['Archived source prose sentinel', citation.id, citation.fileContentHash.value],
        uriScopes: [`threadnote://user/${user}/memories`],
      });

      expect(bodyPostings.candidates).toHaveLength(1);
      expect(bodyPostings.candidates[0]?.text).toContain('Archived source prose sentinel');
      expect(privatePostings.candidates).toHaveLength(0);
      expect(new Set(EffectArray.flatMap(exact, match => match.terms))).toEqual(
        new Set(['Archived source prose sentinel']),
      );
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
});
