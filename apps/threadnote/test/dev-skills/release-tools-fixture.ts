// Compiled test provider/proxy; copied outside the checkout before release isolation.
import {parseMemoryDocument} from '@threadnote/memory/document';
const root = process.env.THREADNOTE_RELEASE_FIXTURE_ROOT;
if (!root) throw new Error('Missing extracted-release fixture root.');
const name = process.execPath
  .split(/[\\/]/u)
  .at(-1)
  ?.replace(/\.exe$/u, '');
const args = process.argv.slice(2);
if (name === 'memory-read') {
  const uri = args[0];
  if (!uri) throw new Error('Provide the canonical memory URI.');
  const record = parseMemoryDocument(uri, await Bun.stdin.text());
  if (!record) throw new Error('Published fixture is not a valid memory document.');
  process.stdout.write(JSON.stringify({body: record.body}));
  process.exit(0);
}
if (name === 'git' || name === 'rg') {
  const paths: Record<string, string> = await Bun.file(root + '/tool-paths.json').json();
  const executable = paths[name];
  if (!executable) throw new Error('Missing native fixture tool.');
  const child = Bun.spawnSync([executable, ...args], {env: process.env, stdin: 'inherit'});
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  process.exit(child.exitCode);
}
if (name !== 'gh') {
  const path = root + '/interpreter-attempts.json';
  const attempts: unknown[] = (await Bun.file(path).exists()) ? await Bun.file(path).json() : [];
  attempts.push({name, args});
  await Bun.write(path, JSON.stringify(attempts));
  process.stderr.write('External interpreters are unavailable in the extracted-release fixture.\n');
  process.exit(97);
}
const state: {head: string; terminal: boolean; revision: number} = await Bun.file(root + '/provider.json').json();
const path = root + '/provider-requests.json';
const requests: unknown[] = (await Bun.file(path).exists()) ? await Bun.file(path).json() : [];
requests.push(args);
await Bun.write(path, JSON.stringify(requests));
const endpoint = args[args.indexOf('--method') + 2];
if (endpoint === 'graphql') await Bun.stdin.text();
const body =
  endpoint === 'graphql'
    ? {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: {hasNextPage: false, endCursor: null},
                nodes: [
                  {
                    id: 'release-thread',
                    isResolved: false,
                    isOutdated: false,
                    path: 'source.ts',
                    line: 1,
                    comments: {pageInfo: {hasNextPage: false, endCursor: null}, nodes: []},
                  },
                ],
              },
            },
          },
          rateLimit: {cost: 1, remaining: 5000, resetAt: '2099-01-01T00:00:00Z'},
        },
      }
    : endpoint?.includes('/comments')
      ? [
          {
            id: 1,
            body: 'Release fixture actionable comment ' + state.revision,
            updated_at: '2026-01-01T00:00:00Z',
            html_url: 'https://github.com/fixture/repo/pull/1#issuecomment-1',
          },
        ]
      : endpoint?.includes('/reviews')
        ? []
        : endpoint?.includes('/check-runs')
          ? {
              check_runs: [
                {
                  id: 2,
                  name: 'release fixture check',
                  status: 'completed',
                  conclusion: 'failure',
                  head_sha: state.head,
                  html_url: 'https://github.com/fixture/repo/pull/1/checks?check_run_id=2',
                },
              ],
            }
          : endpoint?.includes('/status')
            ? {statuses: []}
            : {state: state.terminal ? 'closed' : 'open', merged: state.terminal, head: {sha: state.head}};
process.stdout.write(
  'HTTP/2.0 200 OK\r\nETag: "fixture-' + state.revision + '"\r\nX-Poll-Interval: 1\r\n\r\n' + JSON.stringify(body),
);
