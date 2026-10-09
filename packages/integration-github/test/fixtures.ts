import type {GitHubConversation} from '../src/client.js';
export const timestamp = '2026-10-08T00:00:00Z';
export const conversation: GitHubConversation = {
  id: '11',
  number: 1,
  kind: 'issue',
  repository: {id: '7', name: 'owner/repo', private: false},
  title: 'Issue',
  body: 'Description',
  author: 'alice',
  createdAt: timestamp,
  updatedAt: timestamp,
  state: 'open',
  url: 'https://github.com/owner/repo/issues/1',
  comments: [],
  reviews: [],
  threads: [],
};
export const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json', ...headers}});
export const restItem = (number: number, pull = false) => ({
  id: 10 + number,
  number,
  title: `Issue ${number}`,
  body: `Body ${number}`,
  user: {login: 'alice'},
  created_at: timestamp,
  updated_at: timestamp,
  state: 'open',
  html_url: `https://github.com/owner/repo/${pull ? 'pull' : 'issues'}/${number}`,
  comments: 0,
  ...(pull ? {pull_request: {}} : {}),
});
export const fixtureFetch =
  (items: readonly number[] = [1, 2]) =>
  async (url: URL) => {
    url = new URL(url);
    url.pathname = url.pathname.replace(/^\/repositories\/7(?=\/|$)/, '/repos/owner/repo');
    if (url.pathname === '/repos/owner/repo') return json({id: 7, full_name: 'owner/repo', private: false});
    if (url.pathname === '/repos/owner/repo/issues') return json(items.map(n => restItem(n)));
    if (/\/issues\/\d+$/.test(url.pathname)) return json(restItem(Number(url.pathname.split('/').at(-1))));
    if (url.pathname.endsWith('/comments')) return json([]);
    return json({}, 404);
  };
