import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Redacted} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readExternalDocumentManifest} from '@threadnote/store/external-resource';
import {createLinearClient} from '../client.js';
import {runLinearSourceAdd, runLinearSourceInventory, runLinearSourceSync} from '../source.js';
import {renderLinearProject, linearDocumentId} from '../render.js';
import {provideLayer} from './layer.js';
import {
  connection,
  document,
  issue,
  project,
  projectFetch,
  projectSource,
  request,
  response,
  source,
  update,
} from './fixtures.js';
describe('Linear selected project evidence', () => {
  it('paginates >50 native documents and authored updates independently and double-checks revisions', async () => {
    const docs = Array.from({length: 51}, (_, i) => document(100 + i));
    const updates = Array.from({length: 51}, (_, i) => update(200 + i));
    let calls = 0;
    const client = createLinearClient(Redacted.make('synthetic-linear-private-key'), {
      fetch: async (url, init) => {
        const r = request(init);
        calls++;
        if (r.query.includes('LinearDocuments'))
          return response({
            project: {
              id: project.id,
              documents: r.variables.after ? connection(docs.slice(50)) : connection(docs.slice(0, 50), true, 'docs-2'),
            },
          });
        if (r.query.includes('LinearUpdates'))
          return response({
            project: {
              id: project.id,
              projectUpdates: r.variables.after
                ? connection(updates.slice(50))
                : connection(updates.slice(0, 50), true, 'updates-2'),
            },
          });
        return projectFetch(url, init);
      },
    });
    const snapshot = await client.projectSnapshot(projectSource, project.id);
    expect(snapshot.documents).toHaveLength(51);
    expect(snapshot.updates).toHaveLength(51);
    expect(calls).toBe(10);
    const objects = renderLinearProject(projectSource, snapshot);
    expect(objects).toHaveLength(103);
    expect(objects[0].chunks[0].body).toContain('native overview needle');
    expect(objects[1].chunks[0].body).toContain('Inline discussions excluded');
    expect(objects.at(-1)?.chunks[0].body).toContain('Update comments excluded');
    client.close();
  });
  it('requires known native schema fields and rejects changed documents', async () => {
    for (const omission of [true, false]) {
      let reads = 0;
      const client = createLinearClient(Redacted.make('synthetic-linear-private-key'), {
        fetch: async (url, init) => {
          if (request(init).query.includes('LinearDocuments')) {
            reads++;
            return response({
              project: {
                id: project.id,
                documents: connection([
                  {...document(70), content: omission ? undefined : reads > 1 ? 'edited' : 'original'},
                ]),
              },
            });
          }
          return projectFetch(url, init);
        },
      });
      await expect(client.projectSnapshot(projectSource, project.id)).rejects.toMatchObject({
        code: omission ? 'contract-invalid' : 'revision-changed',
      });
      client.close();
    }
  });
  effectIt.effect(
    'publishes only selected projects and prunes absent issues after complete enumeration, preserving them after failed listing',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'linear-project-'}));
        const config = {agentContextHome: home, account: 'local', user: 'tester'} as RuntimeConfig;
        const location = {home, account: 'local', user: 'tester'};
        yield* runLinearSourceAdd(config, {
          ...projectSource,
          apply: true,
          apiToken: Redacted.make('synthetic-linear-private-key'),
        });
        yield* runLinearSourceSync(config, {id: source.id, apply: true, clientOptions: {fetch: projectFetch}});
        expect((yield* runLinearSourceInventory(config, source.id)).entries).toHaveLength(4);
        const doc = linearDocumentId(source.organizationId, 'issue', issue.id);
        const old = yield* readExternalDocumentManifest(location, source.id, doc, 'linear');
        expect(old?.status).toBe('active');
        yield* runLinearSourceSync(config, {
          id: source.id,
          apply: true,
          clientOptions: {
            fetch: async (url, init) =>
              request(init).query.includes('LinearProjectIssues') ? response({}, 503) : projectFetch(url, init),
          },
        });
        expect((yield* readExternalDocumentManifest(location, source.id, doc, 'linear'))?.chunks).toEqual(old?.chunks);
        yield* runLinearSourceSync(config, {
          id: source.id,
          apply: true,
          clientOptions: {
            fetch: async (url, init) =>
              request(init).query.includes('LinearProjectIssues')
                ? response({project: {id: project.id, issues: connection([])}})
                : projectFetch(url, init),
          },
        });
        expect(yield* readExternalDocumentManifest(location, source.id, doc, 'linear')).toBeUndefined();
        expect((yield* runLinearSourceInventory(config, source.id)).entries).toHaveLength(3);
      }).pipe(TestClock.withLive, provideLayer),
  );
});
