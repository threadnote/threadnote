import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {describe, expect} from 'vitest';
import {CommandExecutor, type CommandOptions, type CommandResult} from '@threadnote/platform/command';
import {initializeNativeWatch, reconcileNativeWatch} from '@threadnote/workflow-automations/watch';
import {
  collectNativeWatchGitHub,
  NativeWatchProviderNow,
  type NativeWatchProviderCache,
} from '../../src/workflow_automation/watch_provider.js';

const pr = 'https://github.com/example/project/pull/7';
const head = 'a'.repeat(40);
const pushedHead = 'b'.repeat(40);
const secretBody = 'PRIVATE-REVIEW-BODY-SENTINEL-DO-NOT-RETURN';

interface Request {
  readonly args: readonly string[];
  readonly input?: unknown;
  readonly at: number;
}
interface Reply {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: unknown | string;
}
type ReplyFor = (args: readonly string[], input: unknown, call: number, now: number) => Reply;

const frame = (reply: Reply): string => {
  const headers = Object.entries(reply.headers ?? {})
    .map(([key, value]) => `${key}: ${value}`)
    .join('\r\n');
  const body = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
  return `HTTP/2.0 ${reply.status ?? 200} ${reply.status === 304 ? 'Not Modified' : 'OK'}\r\n${headers}\r\n\r\n${body}`;
};

const comment = (id: number, body = 'ordinary body') => ({
  id,
  body,
  html_url: `https://github.com/example/project/pull/7#issuecomment-${id}`,
  updated_at: '2026-10-25T10:00:00Z',
});
const review = (id: number) => ({...comment(id), state: 'COMMENTED', commit_id: head});
const check = (id: number, status = 'success') => ({
  id,
  name: `check-${id}`,
  status: 'completed',
  conclusion: status,
  head_sha: head,
  details_url: `https://github.com/example/project/actions/runs/${id}`,
});
const status = (context: string, state = 'success') => ({
  context,
  state,
  target_url: 'https://github.com/example/project/status',
});
const pull = (sha = head) => ({state: 'open', merged: false, head: {sha}});
const apiEndpoint = (args: readonly string[]) =>
  args.find(argument => argument === 'graphql' || argument.startsWith('repos/')) ?? '';
const pageNumber = (endpoint: string) => Number(/(?:[?&])page=(\d+)/u.exec(endpoint)?.[1] ?? 0);

const threadComment = (id: number) => ({
  id: `review-comment-${id}`,
  url: `https://github.com/example/project/pull/7#discussion_r${id}`,
  body: id === 1 ? secretBody : `review comment ${id}`,
  updatedAt: '2026-10-25T10:00:00Z',
});

const defaultReply: ReplyFor = (args, input) => {
  const endpoint = apiEndpoint(args);
  if (endpoint === 'graphql') {
    const payload = input as {readonly query: string; readonly variables: Record<string, unknown>};
    if (payload.query.includes('reviewThreads(first:20'))
      return {
        body: {
          data: {
            repository: {pullRequest: {reviewThreads: {nodes: [], pageInfo: {hasNextPage: false}}}},
            rateLimit: {cost: 1, remaining: 5000, resetAt: '2026-10-25T11:00:00Z'},
          },
        },
      };
    return {
      body: {
        data: {
          node: {id: payload.variables.id, comments: {nodes: [], pageInfo: {hasNextPage: false}}},
          rateLimit: {cost: 1, remaining: 5000, resetAt: '2026-10-25T11:00:00Z'},
        },
      },
    };
  }
  if (endpoint.includes('/pulls/7/reviews')) return {headers: {etag: '"reviews-v1"'}, body: [review(21)]};
  if (endpoint.endsWith('/pulls/7')) return {headers: {etag: '"pull-v1"'}, body: pull()};
  if (endpoint.includes('/issues/7/comments')) return {headers: {etag: '"comments-v1"'}, body: [comment(11)]};
  if (endpoint.includes('/check-runs')) return {headers: {etag: '"checks-v1"'}, body: {check_runs: [check(31)]}};
  if (endpoint.includes('/status?'))
    return {headers: {etag: '"statuses-v1"'}, body: {statuses: [status('build/linux')]}};
  return {status: 404, body: {message: 'unknown fixture route'}};
};

const harness = (replyFor: ReplyFor = defaultReply) => {
  let now = 1_000_000;
  const calls: Request[] = [];
  const command = CommandExecutor.of({
    execute: (executable: string, args: readonly string[], options?: CommandOptions) => {
      if (executable !== 'gh') return Effect.die(new Error('Unexpected executable in fake provider test'));
      const input = options?.input ? (JSON.parse(new TextDecoder().decode(options.input)) as unknown) : undefined;
      const at = now;
      const reply = replyFor(args, input, calls.length, at);
      calls.push({args: [...args], input, at});
      now += 20;
      const result: CommandResult = {exitCode: 0, stderr: '', stdout: frame(reply)};
      return Effect.succeed(result);
    },
    executeStreaming: () => Effect.die(new Error('Streaming is outside the provider test contract')),
  });
  const sweep = (previous?: NativeWatchProviderCache) =>
    collectNativeWatchGitHub(pr, previous).pipe(
      Effect.provideService(CommandExecutor, command),
      Effect.provideService(NativeWatchProviderNow, () => now),
    );
  return {calls, sweep, currentTime: () => now};
};

describe('native GitHub watch provider', () => {
  for (const exitCode of [127, 124]) {
    effectIt.effect('classifies normalized command exit ' + exitCode + ' without exposing command diagnostics', () =>
      Effect.gen(function* () {
        let calls = 0;
        const command = CommandExecutor.of({
          execute: (executable, args, options) => {
            calls++;
            expect(executable).toBe('gh');
            expect(args).toContain('--include');
            expect(options?.allowFailure).toBe(true);
            expect(options?.timeoutMs).toBe(15_000);
            expect(options?.maxOutputBytes).toBe(8 * 1024 * 1024);
            return Effect.succeed({exitCode, stdout: '', stderr: secretBody + ' /private/host/path ghp_SECRET_TOKEN'});
          },
          executeStreaming: () => Effect.die(new Error('Unexpected streaming request')),
        });
        const result = yield* collectNativeWatchGitHub(pr).pipe(
          Effect.provideService(CommandExecutor, command),
          Effect.result,
        );
        expect(result._tag).toBe('Failure');
        if (result._tag !== 'Failure') throw new Error('Expected provider command failure.');
        expect(result.failure.code).toBe(exitCode === 127 ? 'provider-executable' : 'provider-transport');
        expect(result.failure.retryable).toBe(exitCode === 124);
        expect(calls).toBe(1);
        const serialized = JSON.stringify(result.failure);
        expect(serialized).not.toContain(secretBody);
        expect(serialized).not.toContain('/private/host/path');
        expect(serialized).not.toContain('ghp_SECRET_TOKEN');
        expect(serialized).not.toContain('provider-http');
      }),
    );
  }

  effectIt.effect(
    'bounds and fully projects paginated threads, nested replies and REST pages without retaining bodies',
    () =>
      Effect.gen(function* () {
        const totalThreads = 101;
        const threadReply: ReplyFor = (args, input) => {
          const endpoint = apiEndpoint(args);
          if (endpoint !== 'graphql') return defaultReply(args, input, 0, 0);
          const payload = input as {readonly query: string; readonly variables: Record<string, unknown>};
          if (payload.query.includes('reviewThreads(first:20')) {
            const cursor = payload.variables.after;
            const start = typeof cursor === 'string' ? Number(cursor.replace('threads-', '')) : 0;
            const nodes = Array.from({length: Math.min(20, totalThreads - start)}, (_, offset) => {
              const ordinal = start + offset + 1;
              return {
                id: `thread-${ordinal}`,
                isResolved: ordinal !== 1,
                isOutdated: false,
                path: 'src/example.ts',
                line: ordinal,
                comments: {
                  nodes: ordinal === 1 ? Array.from({length: 5}, (_, index) => threadComment(index + 1)) : [],
                  pageInfo: {hasNextPage: ordinal === 1, endCursor: ordinal === 1 ? 'nested-5' : undefined},
                },
              };
            });
            const end = start + nodes.length;
            return {
              body: {
                data: {
                  repository: {
                    pullRequest: {
                      reviewThreads: {
                        nodes,
                        pageInfo: {hasNextPage: end < totalThreads, endCursor: `threads-${end}`},
                      },
                    },
                  },
                  rateLimit: {cost: 2, remaining: 5000, resetAt: '2026-10-25T11:00:00Z'},
                },
              },
            };
          }
          const replies = Array.from({length: 96}, (_, index) => threadComment(index + 6));
          return {
            body: {
              data: {
                node: {id: 'thread-1', comments: {nodes: replies, pageInfo: {hasNextPage: false}}},
                rateLimit: {cost: 3, remaining: 5000, resetAt: '2026-10-25T11:00:00Z'},
              },
            },
          };
        };
        const pagedReply: ReplyFor = (args, input, call, now) => {
          const endpoint = apiEndpoint(args);
          if (endpoint.includes('/issues/7/comments')) {
            if (pageNumber(endpoint) === 1)
              return {
                headers: {etag: '"comments-page-1"'},
                body: Array.from({length: 100}, (_, index) => comment(index + 1, index === 0 ? secretBody : 'comment')),
              };
            if (pageNumber(endpoint) === 2) return {headers: {etag: '"comments-page-2"'}, body: [comment(101)]};
          }
          return threadReply(args, input, call, now);
        };
        const h = harness(pagedReply);
        const result = yield* h.sweep();
        const comments = result.sweep.sources.find(source => source.source === 'comments');
        const reviews = result.sweep.sources.find(source => source.source === 'reviews');
        const threads = result.sweep.sources.find(source => source.source === 'threads');
        expect(comments?.complete && comments.items.map(item => item.id)).toEqual(
          Array.from({length: 101}, (_, i) => String(i + 1)),
        );
        expect(reviews?.complete && reviews.items.map(item => item.id)).toEqual(['21']);
        expect(threads?.complete).toBe(true);
        if (threads?.complete) {
          const ids = threads.items.map(item => item.id).sort();
          expect(ids).toEqual(
            [
              ...Array.from({length: 101}, (_, index) => `review-comment-${index + 1}`),
              ...Array.from({length: 101}, (_, index) => `thread-${index + 1}`),
            ].sort(),
          );
          expect(threads.items.find(item => item.id === 'thread-1')?.bootstrap).toBe(true);
          expect(threads.items.find(item => item.id === 'review-comment-6')?.bootstrap).toBe(true);
        }
        expect(h.calls.filter(call => call.args.at(-1)?.includes('/issues/7/comments'))).toHaveLength(2);
        expect(
          h.calls.filter(
            call => call.input && (call.input as {query: string}).query.includes('reviewThreads(first:20'),
          ),
        ).toHaveLength(6);
        expect(
          h.calls.filter(
            call => call.input && (call.input as {query: string}).query.includes('comments(first:100,after:$after)'),
          ),
        ).toHaveLength(1);
        expect(JSON.stringify({sweep: result.sweep, cache: result.cache, blockers: result.blockers})).not.toContain(
          secretBody,
        );
        expect(result.sweep.startedHead).toBe(head);
        expect(result.sweep.head).toBe(head);
        expect(result.sweep.ci.complete).toBe(true);
      }),
  );

  effectIt.effect(
    'replays REST ETags exactly, measures smaller 304 responses and still probes a full-page sentinel',
    () =>
      Effect.gen(function* () {
        const responses: ReplyFor = (args, input, call, now) => {
          const endpoint = apiEndpoint(args);
          if (args.includes('If-None-Match: "comments-page-1"'))
            return {status: 304, headers: {etag: '"comments-page-1"'}, body: ''};
          if (args.includes('If-None-Match: "comments-page-2"'))
            return {status: 304, headers: {etag: '"comments-page-2"'}, body: ''};
          if (endpoint.includes('/issues/7/comments') && pageNumber(endpoint) === 1)
            return {headers: {etag: '"comments-page-1"'}, body: Array.from({length: 100}, (_, i) => comment(i + 1))};
          if (endpoint.includes('/issues/7/comments') && pageNumber(endpoint) === 2)
            return {headers: {etag: '"comments-page-2"'}, body: [comment(101)]};
          const base = defaultReply(args, input, call, now);
          return args.includes('If-None-Match: "pull-v1"') || args.some(arg => arg.startsWith('If-None-Match: "'))
            ? {status: 304, headers: base.headers, body: ''}
            : base;
        };
        const first = harness((args, input, call, now) => {
          const endpoint = apiEndpoint(args);
          if (endpoint.includes('/issues/7/comments') && pageNumber(endpoint) === 1)
            return {headers: {etag: '"comments-page-1"'}, body: Array.from({length: 100}, (_, i) => comment(i + 1))};
          if (endpoint.includes('/issues/7/comments') && pageNumber(endpoint) === 2)
            return {headers: {etag: '"comments-page-2"'}, body: [comment(101)]};
          return defaultReply(args, input, call, now);
        });
        const original = yield* first.sweep();
        const second = harness(responses);
        const replay = yield* second.sweep(original.cache);
        expect(replay.sweep).toEqual(original.sweep);
        expect(replay.cache).toEqual(original.cache);
        expect(replay.metrics.notModified).toBe(7);
        expect(replay.metrics.graphqlCost).toBe(1);
        expect(replay.metrics.requests).toBe(second.calls.length);
        expect(replay.metrics.responseBytes).toBeLessThan(original.metrics.responseBytes);
        expect(second.calls.filter(call => apiEndpoint(call.args).includes('/issues/7/comments'))).toHaveLength(2);
        expect(second.calls.some(call => apiEndpoint(call.args).includes('page=2'))).toBe(true);
      }),
  );

  effectIt.effect(
    'keeps complete independent sources on endpoint and GraphQL failures and fails closed on repeated cursors',
    () =>
      Effect.gen(function* () {
        const failedComments = harness((args, input, call, now) => {
          const endpoint = apiEndpoint(args);
          if (endpoint.includes('/issues/7/comments'))
            return {status: 500, body: {message: 'private transport failure'}};
          return defaultReply(args, input, call, now);
        });
        const partial = yield* failedComments.sweep();
        expect(partial.sweep.sources.find(source => source.source === 'comments')).toMatchObject({
          complete: false,
          error: {code: 'provider-server', retryable: true},
        });
        expect(partial.sweep.sources.find(source => source.source === 'reviews')?.complete).toBe(true);
        expect(partial.cache.pages.some(page => page.key.startsWith('reviews:'))).toBe(true);
        expect(JSON.stringify(partial)).not.toContain('private transport failure');

        const graphqlFailure = harness((args, input, call, now) => {
          if (apiEndpoint(args) === 'graphql')
            return {body: {errors: [{message: 'private GraphQL error'}], data: null}};
          return defaultReply(args, input, call, now);
        });
        const rejected = yield* graphqlFailure.sweep();
        expect(rejected.sweep.sources.find(source => source.source === 'threads')).toMatchObject({
          complete: false,
          error: {code: 'provider-graphql'},
        });
        expect(rejected.sweep.ci.complete).toBe(false);
        expect(JSON.stringify(rejected)).not.toContain('private GraphQL error');

        const cursorCycle = harness((args, input, call, now) => {
          if (apiEndpoint(args) === 'graphql')
            return {
              body: {
                data: {
                  repository: {
                    pullRequest: {reviewThreads: {nodes: [], pageInfo: {hasNextPage: true, endCursor: 'same'}}},
                  },
                  rateLimit: {cost: 1, remaining: 5000, resetAt: '2026-10-25T11:00:00Z'},
                },
              },
            };
          return defaultReply(args, input, call, now);
        });
        const cycled = yield* cursorCycle.sweep();
        expect(cycled.sweep.sources.find(source => source.source === 'threads')).toMatchObject({
          complete: false,
          error: {code: 'provider-pagination-race', retryable: true},
        });
        expect(cycled.sweep.ci.complete).toBe(false);
        expect(cursorCycle.calls.filter(call => apiEndpoint(call.args) === 'graphql')).toHaveLength(2);
      }),
  );

  effectIt.effect('fences CI to the original head and keeps an empty complete check source unready', () =>
    Effect.gen(function* () {
      let pullCount = 0;
      const pushed = harness((args, input, call, now) => {
        const endpoint = apiEndpoint(args);
        if (endpoint.endsWith('/pulls/7')) return {body: pull(++pullCount === 1 ? head : pushedHead)};
        return defaultReply(args, input, call, now);
      });
      const raced = yield* pushed.sweep();
      expect(raced.sweep.head).toBe(pushedHead);
      expect(raced.sweep.startedHead).toBe(head);
      expect(raced.sweep.ci).toMatchObject({head, complete: false});
      expect(raced.sweep.sources.find(source => source.source === 'checks')).toMatchObject({complete: true, head});
      expect(raced.sweep.sources.find(source => source.source === 'statuses')).toMatchObject({complete: true, head});

      const empty = harness((args, input, call, now) => {
        const endpoint = apiEndpoint(args);
        if (endpoint.includes('/check-runs')) return {body: {check_runs: []}};
        if (endpoint.includes('/status?')) return {body: {statuses: []}};
        return defaultReply(args, input, call, now);
      });
      const emptySweep = yield* empty.sweep();
      expect(emptySweep.sweep.ci).toMatchObject({complete: true, count: 0});
      const state = reconcileNativeWatch(initializeNativeWatch('watch-1', pr, 0), emptySweep.sweep);
      expect(state.ci).toBeNull();
      expect(state.events.some(event => event.kind === 'ci_complete')).toBe(false);
    }),
  );

  effectIt.effect(
    'stops API calls at rate limits, distinguishes authentication from permission and normalizes rerun CI',
    () =>
      Effect.gen(function* () {
        let rateDeadline = 0;
        const limited = harness((args, input, call, now) => {
          const endpoint = apiEndpoint(args);
          if (endpoint.includes('/issues/7/comments')) {
            rateDeadline = now + 20 + 120_000;
            return {
              status: 429,
              headers: {
                'retry-after': '120',
                'x-ratelimit-remaining': '0',
                'x-ratelimit-reset': String(Math.ceil((now + 20 + 120_000) / 1000)),
              },
              body: {message: 'private rate response'},
            };
          }
          return defaultReply(args, input, call, now);
        });
        const rate = yield* limited.sweep();
        expect(limited.calls).toHaveLength(2); // pull before comments, then rate limit blocks every later API request
        expect(rate.retryAt).toBeGreaterThanOrEqual(rateDeadline);
        expect(rate.blockers.some(blocker => blocker.code === 'provider-rate-limit' && blocker.retryable)).toBe(true);
        expect(JSON.stringify(rate)).not.toContain('private rate response');

        const unauthorized = harness((args, input, call, now) =>
          args.at(-1)?.includes('/issues/7/comments')
            ? {status: 401, body: {message: 'private auth response'}}
            : defaultReply(args, input, call, now),
        );
        const auth = yield* unauthorized.sweep();
        expect(auth.sweep.sources.find(source => source.source === 'comments')).toMatchObject({
          complete: false,
          error: {code: 'provider-authentication', retryable: false},
        });
        expect(unauthorized.calls).toHaveLength(2);

        const forbidden = harness((args, input, call, now) =>
          args.at(-1)?.includes('/issues/7/comments')
            ? {status: 403, body: {message: 'private permission response'}}
            : defaultReply(args, input, call, now),
        );
        const permission = yield* forbidden.sweep();
        expect(permission.sweep.sources.find(source => source.source === 'comments')).toMatchObject({
          complete: false,
          error: {code: 'provider-permission', retryable: false},
        });
        expect(forbidden.calls.length).toBeGreaterThan(2);

        let run = 0;
        const rerun = harness((args, input, call, now) => {
          const endpoint = apiEndpoint(args);
          if (endpoint.includes('/check-runs')) {
            run++;
            return {body: {check_runs: [check(run === 1 ? 31 : 32, run === 1 ? 'success' : 'failure')]}};
          }
          return defaultReply(args, input, call, now);
        });
        const first = yield* rerun.sweep();
        const updated = yield* rerun.sweep(first.cache);
        const firstChecks = first.sweep.sources.find(source => source.source === 'checks');
        const updatedChecks = updated.sweep.sources.find(source => source.source === 'checks');
        expect(firstChecks?.complete && firstChecks.items.map(item => [item.id, item.kind])).toEqual([
          ['31', 'ci_update'],
        ]);
        expect(updatedChecks?.complete && updatedChecks.items.map(item => [item.id, item.kind])).toEqual([
          ['32', 'ci_error'],
        ]);
        expect(updated.sweep.ci.count).toBe(2);
        expect(updated.sweep.ci.failed).toBe(1);
        expect(updated.sweep.ci.version).not.toBe(first.sweep.ci.version);
      }),
  );

  effectIt.effect('turns malformed or unknown responses into bounded errors without exposing bodies', () =>
    Effect.gen(function* () {
      const malformed = harness((args, input, call, now) =>
        args.at(-1)?.includes('/issues/7/comments') ? {body: secretBody} : defaultReply(args, input, call, now),
      );
      const result = yield* malformed.sweep();
      expect(result.sweep.sources.find(source => source.source === 'comments')).toMatchObject({
        complete: false,
        error: {code: 'provider-json'},
      });
      expect(JSON.stringify(result)).not.toContain(secretBody);

      const unknown = harness((args, input, call, now) =>
        args.at(-1)?.includes('/issues/7/comments')
          ? {body: {unexpected: secretBody}}
          : defaultReply(args, input, call, now),
      );
      const unknownResult = yield* unknown.sweep();
      expect(unknownResult.sweep.sources.find(source => source.source === 'comments')).toMatchObject({
        complete: false,
        error: {code: 'provider-shape'},
      });
      expect(JSON.stringify(unknownResult)).not.toContain(secretBody);
      expect(unknownResult.blockers.every(blocker => blocker.code.length <= 64 && blocker.source.length <= 32)).toBe(
        true,
      );
    }),
  );
});

describe('native pull mergeability projection', () => {
  effectIt.effect('propagates final PR truth and start/end base without extra requests', () =>
    Effect.gen(function* () {
      let reads = 0;
      const fake = harness((args, input, call, now) =>
        apiEndpoint(args).endsWith('/pulls/7')
          ? {
              headers: {etag: '"new-pull"'},
              body: {
                ...pull(),
                base: {sha: (++reads === 1 ? 'c' : 'd').repeat(40)},
                mergeable: reads === 1 ? true : false,
              },
            }
          : defaultReply(args, input, call, now),
      );
      const result = yield* fake.sweep();
      expect(result.sweep).toMatchObject({base: 'd'.repeat(40), startedBase: 'c'.repeat(40), mergeable: false});
      expect(fake.calls).toHaveLength(7);
      expect(result.metrics.requests).toBe(7);
    }),
  );
  effectIt.effect('refreshes legacy pull once in the scheduled request and preserves explicit null across 304', () =>
    Effect.gen(function* () {
      const seeded = yield* harness().sweep();
      const legacy: NativeWatchProviderCache = {
        pages: seeded.cache.pages.map(page =>
          page.key === 'pull' ? {...page, projection: {...page.projection, pull: {head, state: 'open'}}} : page,
        ),
      };
      let reads = 0;
      const fake = harness((args, input, call, now) => {
        if (!apiEndpoint(args).endsWith('/pulls/7')) return defaultReply(args, input, call, now);
        reads++;
        if (reads === 1) {
          expect(args.some(arg => arg.startsWith('If-None-Match:') || arg.startsWith('If-Modified-Since:'))).toBe(
            false,
          );
          return {headers: {etag: '"fresh"'}, body: {...pull(), base: {sha: 'c'.repeat(40)}}};
        }
        expect(args).toContain('If-None-Match: "fresh"');
        return {status: 304, body: ''};
      });
      const result = yield* fake.sweep(legacy);
      expect(fake.calls).toHaveLength(7);
      expect(result.sweep).toMatchObject({base: 'c'.repeat(40), startedBase: 'c'.repeat(40), mergeable: null});
      expect(result.cache.pages.find(page => page.key === 'pull')?.projection.pull).toMatchObject({mergeable: null});
      const cached = harness((args, input, call, now) =>
        apiEndpoint(args).endsWith('/pulls/7') ? {status: 304, body: ''} : defaultReply(args, input, call, now),
      );
      const next = yield* cached.sweep(result.cache);
      expect(next.sweep.mergeable).toBeNull();
      expect(cached.calls).toHaveLength(7);
    }),
  );
  for (const metadata of [{mergeable: 'dirty'}, {mergeable: 0}, {base: {sha: 'invalid'}}]) {
    effectIt.effect('rejects malformed PR metadata ' + JSON.stringify(metadata), () =>
      Effect.gen(function* () {
        const fake = harness((args, input, call, now) =>
          apiEndpoint(args).endsWith('/pulls/7')
            ? {body: {...pull(), ...metadata}}
            : defaultReply(args, input, call, now),
        );
        const result = yield* fake.sweep().pipe(Effect.result);
        expect(result._tag).toBe('Failure');
        if (result._tag === 'Failure') expect(result.failure.code).toBe('provider-shape');
        expect(fake.calls).toHaveLength(1);
      }),
    );
  }
});
