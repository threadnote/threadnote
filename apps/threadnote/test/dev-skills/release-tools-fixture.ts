// Compiled test provider/proxy; copied outside the checkout before release isolation.
// Bun 1.4.2 compile cannot bundle the testing node-fs export-star wrapper.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import {closeSync, existsSync, openSync, writeSync} from 'node:fs';
import {join} from '@threadnote/testing/node-path';
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
  await Bun.write(Bun.stdout, JSON.stringify({body: record.body}));
  process.exit(0);
}
if (name === 'git' || name === 'rg') {
  // Each process claims an exclusive slot. No shared read/modify/write and at most
  // 128 * 480 bytes, including incomplete records after an interrupted write.
  const started = Date.now();
  const commandIndex = args[0] === '-C' ? 2 : 0;
  const verb = args[commandIndex];
  const closedVerb = ['show', 'rev-parse', 'config', 'add', 'commit', 'status', 'push', 'fetch'].includes(verb ?? '')
    ? verb
    : 'other';
  const trace = (event: string, fields: Record<string, string | number | boolean | null>) => {
    if (name !== 'git' || process.env.THREADNOTE_RELEASE_PUBLICATION_TRACE !== '1') return;
    try {
      // Claims are immutable and scan in order: the last slot proves every
      // earlier slot was claimed, even if a writer was interrupted. Check once
      // per event so fresh producer processes do not reprobe a saturated prefix.
      if (existsSync(join(root, 'publication-producer-events', '127.json'))) return;
      const record = JSON.stringify({version: 1, pid: process.pid, event, verb: closedVerb, ...fields}) + '\n';
      if (Buffer.byteLength(record) > 480) return;
      for (let slot = 0; slot < 128; slot++) {
        let descriptor: number;
        try {
          descriptor = openSync(join(root, 'publication-producer-events', `${slot}.json`), 'wx');
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'EEXIST') continue;
          return;
        }
        try {
          writeSync(descriptor, record);
        } finally {
          closeSync(descriptor);
        }
        return;
      }
    } catch {
      // Diagnostic I/O must never change the original command outcome.
    }
  };
  const category = (value: Uint8Array) => {
    const error = Buffer.from(value.subarray(0, 8192)).toString('utf8').toLowerCase();
    if (!error) return 'none';
    for (const [token, label] of [
      ['does not exist in', 'missing-path'],
      ['exists on disk, but not in', 'missing-path'],
      ['invalid object name', 'missing-object'],
      ['bad object', 'missing-object'],
      ['not a git repository', 'not-repository'],
      ['dubious ownership', 'unsafe-repository'],
      ['filename too long', 'path-too-long'],
      ['invalid path', 'path-invalid'],
      ['permission denied', 'permission'],
      ['index.lock', 'index-lock'],
    ])
      if (token && error.includes(token)) return label;
    return 'unknown';
  };
  let phase = 'load';
  try {
    const paths: Record<string, string> = await Bun.file(root + '/tool-paths.json').json();
    const executable = paths[name];
    if (!executable) throw new Error('Missing native fixture tool.');
    const spec = verb === 'show' ? (args[commandIndex + 1] ?? '') : '';
    const colon = spec.indexOf(':');
    const revision = colon >= 0 ? spec.slice(0, colon) : spec;
    const relative = colon >= 0 ? spec.slice(colon + 1) : '';
    const form =
      verb !== 'show'
        ? 'other'
        : revision === '' && colon >= 0
          ? 'index'
          : revision === 'HEAD'
            ? 'HEAD'
            : /^[a-f0-9]{40}$/iu.test(revision)
              ? 'SHA40'
              : /^[a-f0-9]{64}$/iu.test(revision)
                ? 'SHA64'
                : 'other';
    phase = 'spawn';
    trace('start', {
      argc: args.length,
      specForm: form,
      pathCharacters: relative.length,
      pathBytes: Buffer.byteLength(relative),
      pathControl: Array.from(relative).some(
        character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ),
      pathBackslash: relative.includes('\\'),
      timeMs: started,
    });
    const child = Bun.spawnSync([executable, ...args], {env: process.env, stdin: 'inherit'});
    trace('result', {
      elapsedMs: Date.now() - started,
      exit: child.exitCode,
      signal: !child.signalCode
        ? 'none'
        : typeof child.signalCode === 'string' &&
            ['SIGTERM', 'SIGKILL', 'SIGPIPE', 'SIGABRT', 'SIGSEGV', 'SIGINT'].includes(child.signalCode)
          ? child.signalCode
          : 'other',
      success: child.success,
      stdoutBytes: child.stdout.length,
      stderrBytes: child.stderr.length,
      stderrCategory: category(child.stderr),
    });
    let stdoutWritten = 0;
    let stderrWritten = 0;
    // Empty Bun writes try to truncate pipes on Windows.
    phase = 'stdout';
    if (child.stdout.length > 0) stdoutWritten = await Bun.write(Bun.stdout, child.stdout);
    phase = 'stderr';
    if (child.stderr.length > 0) stderrWritten = await Bun.write(Bun.stderr, child.stderr);
    trace('forwarded', {elapsedMs: Date.now() - started, stdoutWritten, stderrWritten, complete: true});
    process.exit(child.exitCode);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    const syscall = error instanceof Error && 'syscall' in error ? String(error.syscall) : '';
    trace('exception', {
      phase,
      elapsedMs: Date.now() - started,
      errorCode: ['ENOENT', 'EACCES', 'EPERM', 'EPIPE', 'EBADF', 'EINVAL', 'ENOSPC'].includes(code) ? code : 'other',
      syscall: ['spawn', 'write', 'open', 'read'].includes(syscall) ? syscall : 'other',
    });
    throw error;
  }
}
if (name !== 'gh') {
  const path = root + '/interpreter-attempts.json';
  const attempts: unknown[] = (await Bun.file(path).exists()) ? await Bun.file(path).json() : [];
  attempts.push({name, args});
  await Bun.write(path, JSON.stringify(attempts));
  await Bun.write(Bun.stderr, 'External interpreters are unavailable in the extracted-release fixture.\n');
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
await Bun.write(
  Bun.stdout,
  'HTTP/2.0 200 OK\r\nETag: "fixture-' + state.revision + '"\r\nX-Poll-Interval: 1\r\n\r\n' + JSON.stringify(body),
);
