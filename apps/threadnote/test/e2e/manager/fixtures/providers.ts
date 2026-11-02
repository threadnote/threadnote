import {mkdir, writeFile} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';
import type {ManagerRuntime, NetworkRoute} from './runtime.js';
import {Array as EffectArray, pipe} from 'effect';
import * as EffectString from 'effect/String';
import {releaseRoutes} from './releases.js';

export const providerNames = ['obsidian', 'github', 'linear', 'pocket', 'superhuman'] as const;
const uuid = (n: number) => `00000000-0000-0000-0000-${pipe(String(n), EffectString.padStart(12, '0'))}`;
const timestamp = '2026-10-08T12:00:00.000Z';
const githubIssue = {
  id: 11,
  number: 1,
  title: 'GitHub browser fixture',
  body: 'github-e2e-needle',
  user: {login: 'fixture-author'},
  created_at: timestamp,
  updated_at: timestamp,
  state: 'open',
  html_url: 'https://github.com/fixture/repository/issues/1',
  comments: 0,
};
const linearIssue = {
  id: uuid(4),
  identifier: 'E2E-1',
  title: 'Linear browser fixture',
  description: 'linear-e2e-needle',
  url: 'https://linear.app/fixture/issue/E2E-1/browser',
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: null,
  team: {id: uuid(3), name: 'Fixture team'},
  project: null,
  state: {id: uuid(5), name: 'Started', type: 'started'},
};
const superhumanPage = {
  id: 'page_e2e',
  type: 'page',
  name: 'Superhuman browser fixture',
  isHidden: false,
  isEffectivelyHidden: false,
  contentType: 'canvas',
  updatedAt: timestamp,
};

export function providerRoutes(version: string): readonly NetworkRoute[] {
  const github = (path: string, body: unknown): NetworkRoute => ({origin: 'https://api.github.com', path, body});
  const pocket = (path: string, data: unknown): NetworkRoute => ({
    origin: 'https://public.heypocketai.com',
    path: `/api/v1/public/${path}`,
    body: {success: true, data},
  });
  const linear = (bodyContains: string, data: unknown): NetworkRoute => ({
    origin: 'https://api.linear.app',
    path: '/graphql',
    method: 'POST',
    bodyContains,
    body: {data},
  });
  const superhuman = (path: string, body: unknown): NetworkRoute => ({
    origin: 'https://docs.superhuman.com',
    path,
    body,
  });
  return [
    ...releaseRoutes(version),
    github('/repos/fixture/repository', {id: 7, full_name: 'fixture/repository', private: false}),
    github('/repositories/7', {id: 7, full_name: 'fixture/repository', private: false}),
    github('/repositories/7/issues', [githubIssue]),
    github('/repositories/7/issues/1', githubIssue),
    ...EffectArray.map(
      [
        '/repositories/7/issues/1/comments',
        '/repositories/7/issues/comments',
        '/repositories/7/pulls/comments',
        '/repositories/7/pulls',
      ],
      path => github(path, []),
    ),
    pocket('folders', []),
    pocket('tags', []),
    {
      origin: 'https://public.heypocketai.com',
      path: '/api/v1/public/recordings',
      body: {
        success: true,
        data: [{id: 'record_e2e', title: 'Pocket browser fixture'}],
        pagination: {page: 1, limit: 100, total: 1, total_pages: 1, has_more: false},
      },
    },
    pocket('recordings/record_e2e', {
      id: 'record_e2e',
      title: 'Pocket browser fixture',
      transcript: [{speakerName: 'Fixture author', text: 'pocket-e2e-needle'}],
    }),
    linear('LinearIdentity', {organization: {id: uuid(1)}, viewer: {id: uuid(2)}}),
    linear('LinearTeam', {team: {id: uuid(3), name: 'Fixture team', organization: {id: uuid(1)}}}),
    linear('LinearIssue(', {issue: linearIssue}),
    linear('LinearComments', {
      issue: {id: uuid(4), comments: {nodes: [], pageInfo: {hasNextPage: false, endCursor: null}}},
    }),
    superhuman('/apis/v1/docs/doc_e2e/pages', {items: [superhumanPage]}),
    superhuman('/apis/v1/docs/doc_e2e/pages/page_e2e', superhumanPage),
    superhuman('/apis/v1/docs/doc_e2e/pages/page_e2e/content', {
      items: [
        {
          id: 'line_e2e',
          type: 'line',
          itemContent: {style: 'p', format: 'plainText', content: 'superhuman-e2e-needle'},
        },
      ],
    }),
  ];
}

export async function configureProviders(manager: ManagerRuntime): Promise<void> {
  await manager.setNetwork(providerRoutes(manager.expectedVersion));
  const vault = join(manager.root, 'vault');
  await mkdir(vault, {recursive: true});
  await writeFile(join(vault, 'Browser fixture.md'), '# Obsidian browser fixture\n\nobsidian-e2e-needle\n');
  const common = [
    'source',
    'add',
    '--project',
    'manager-e2e',
    '--refresh-interval-minutes',
    '60',
    '--max-stale-hours',
    '24',
    '--apply',
  ];
  const sources: readonly (readonly string[])[] = [
    ['--type', 'obsidian', '--id', 'fixture-obsidian', '--vault', vault, '--include', '**/*.md'],
    [
      '--type',
      'github',
      '--id',
      'fixture-github',
      '--credential-env',
      'E2E_GITHUB_TOKEN',
      '--repo',
      'fixture/repository',
    ],
    [
      '--type',
      'linear',
      '--id',
      'fixture-linear',
      '--credential-env',
      'E2E_LINEAR_TOKEN',
      '--organization-id',
      uuid(1),
      '--principal-id',
      uuid(2),
      '--team-id',
      uuid(3),
      '--issue-id',
      uuid(4),
    ],
    ['--type', 'pocket', '--id', 'fixture-pocket', '--credential-env', 'E2E_POCKET_TOKEN'],
    [
      '--type',
      'superhuman',
      '--id',
      'fixture-superhuman',
      '--credential-env',
      'E2E_SUPERHUMAN_TOKEN',
      '--doc',
      'doc_e2e',
    ],
  ];
  for (const source of sources) await manager.cli([...common, ...source]);
}
