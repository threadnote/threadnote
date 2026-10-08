import {Redacted} from 'effect';
import {describe, expect, it} from 'vitest';
import {probeGitHubSource} from '../../../../scripts/probe-github-source.js';

const token = Redacted.make('synthetic-probe-token');
const date = '2026-10-08T00:00:00Z';
const issue = {
  id: 42,
  number: 1,
  title: 'Synthetic private title',
  body: 'Synthetic private conversation body',
  user: {login: 'synthetic-private-author'},
  created_at: date,
  updated_at: date,
  state: 'open',
  comments: 0,
  html_url: 'https://github.com/example/demo/issues/1',
};

const syntheticFetch = (calls: string[]) => async (url: URL, init: RequestInit) => {
  calls.push(`${init.method} ${url.pathname}`);
  if (url.pathname === '/repos/example/demo') return Response.json({id: 7, full_name: 'example/demo', private: true});
  if (url.pathname === '/repositories/7/issues') return Response.json([issue]);
  if (url.pathname === '/repositories/7/issues/1') return Response.json(issue);
  if (url.pathname === '/repositories/7/issues/1/comments') return Response.json([]);
  throw new Error('Unexpected synthetic request');
};

describe('GitHub contract probe', () => {
  it('reports structural coverage without exposing conversation content, authors or credentials', async () => {
    const calls: string[] = [];
    const result = await probeGitHubSource(token, 'example/demo', {number: 1, fetch: syntheticFetch(calls)});
    expect(result.conversation).toMatchObject({kind: 'issue', observedStable: true, comments: 0});
    expect(result.inventory.scope).toBe('first-page-sample');
    expect(result.externalMutations).toBe(false);
    expect(calls.every(call => call.startsWith('GET '))).toBe(true);
    const serialized = JSON.stringify(result);
    for (const privateValue of [issue.title, issue.body, issue.user.login, Redacted.value(token)])
      expect(serialized).not.toContain(privateValue);
  });

  it('does not hydrate a conversation unless a number is explicitly selected', async () => {
    const calls: string[] = [];
    const result = await probeGitHubSource(token, 'example/demo', {fetch: syntheticFetch(calls)});
    expect(result.conversation).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it('rejects an invalid conversation selection before sending credentials', async () => {
    const calls: string[] = [];
    await expect(
      probeGitHubSource(token, 'example/demo', {number: 0, fetch: syntheticFetch(calls)}),
    ).rejects.toMatchObject({
      code: 'contract-invalid',
    });
    expect(calls).toHaveLength(0);
  });
});
