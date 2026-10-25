import {Context, Effect, Schema} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import type {
  NativeWatchEntity,
  NativeWatchSourceResult,
  NativeWatchSweep,
} from '@threadnote/workflow-automations/watch';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {stableJson} from '../workflow_memory/protocol.js';

type Source = 'comments' | 'reviews' | 'threads' | 'checks' | 'statuses';
export const NativeWatchProviderNow = Context.Reference<() => number>('threadnote/NativeWatchProviderNow', {
  defaultValue: () => Date.now,
});
interface Pull {
  readonly head: string;
  readonly state: 'open' | 'closed' | 'merged';
}
interface Projection {
  readonly items: readonly NativeWatchEntity[];
  readonly size: number;
  readonly pending: number;
  readonly failed: number;
  readonly pull?: Pull;
}
export interface NativeWatchHttpPage {
  readonly key: string;
  readonly etag?: string;
  readonly modified?: string;
  readonly projection: Projection;
}
export interface NativeWatchProviderMetrics {
  requests: number;
  notModified: number;
  responseBytes: number;
  graphqlCost: number;
  providerMilliseconds: number;
}
export interface NativeWatchProviderCache {
  readonly pages: readonly NativeWatchHttpPage[];
}
export interface NativeWatchProviderResult {
  readonly sweep: NativeWatchSweep;
  readonly cache: NativeWatchProviderCache;
  readonly metrics: NativeWatchProviderMetrics;
  readonly retryAt: number;
  readonly blockers: readonly {readonly source: string; readonly code: string; readonly retryable: boolean}[];
}
const fail = (code: string, retryable = false) =>
  WorkflowAutomationError.make({code, message: 'GitHub watch source is unavailable: ' + code + '.', retryable});
const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fail('provider-shape');
  return value as Record<string, unknown>;
};
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw fail('provider-shape');
  return value;
};
const text = (value: unknown, maximum = 256): string => {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > maximum ||
    [...value].some(character => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })
  )
    throw fail('provider-shape');
  return value;
};
const sha = (value: unknown): string => {
  const result = text(value);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(result)) throw fail('provider-shape');
  return result;
};
const url = (value: unknown): string => {
  const result = text(value, 2048);
  const parsed = new URL(result);
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password)
    throw fail('provider-shape');
  return result;
};
const number = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw fail('provider-shape');
  return value as number;
};
const fingerprint = (value: unknown) => sha256HexSync(stableJson(value));
const entity = (
  id: string,
  kind: string,
  fields: unknown,
  bootstrap: boolean,
  link?: unknown,
  head?: string,
): NativeWatchEntity => ({
  id: text(id),
  kind,
  version: fingerprint(fields),
  bootstrap,
  ...(link === undefined || link === null ? {} : {url: url(link)}),
  ...(head === undefined ? {} : {head: sha(head)}),
});

/** This adapter never accepts a hostname, executable, API URL or credential from PR content. */
export function nativeWatchPullRequest(pr: string) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/u.exec(pr);
  if (!match || !Number.isSafeInteger(Number(match[3]))) throw fail('invalid-pr');
  return {owner: match[1], repo: match[2], number: Number(match[3])};
}

/** Parse only the selected response headers; raw headers/bodies never enter watch state. */
export function nativeWatchHttpResponse(stdout: string) {
  const boundary = /\r?\n\r?\n/u.exec(stdout);
  if (!boundary) throw fail('provider-http');
  const lines = stdout.slice(0, boundary.index).split(/\r?\n/u);
  const status = /^HTTP\/[\d.]+\s+(\d{3})(?:\s|$)/u.exec(lines.shift() ?? '');
  if (!status) throw fail('provider-http');
  const headers = new Map<string, string>();
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return {status: Number(status[1]), headers, body: stdout.slice(boundary.index + boundary[0].length)};
}
const restProjection = (source: Source, input: unknown, head: string): Projection => {
  const values =
    source === 'checks'
      ? array(object(input).check_runs)
      : source === 'statuses'
        ? array(object(input).statuses)
        : array(input);
  let pending = 0;
  let failed = 0;
  const items = values.map(raw => {
    const value = object(raw);
    const id = source === 'statuses' ? text(value.context) : String(number(value.id));
    if (source === 'checks' || source === 'statuses') {
      const isPending = source === 'checks' ? value.status !== 'completed' : value.state === 'pending';
      const success =
        source === 'checks'
          ? ['success', 'skipped', 'neutral'].includes(String(value.conclusion))
          : value.state === 'success';
      if (source === 'checks' && value.head_sha !== head) throw fail('provider-head-race', true);
      pending += Number(isPending);
      failed += Number(!isPending && !success);
      return entity(
        id,
        !isPending && !success ? 'ci_error' : 'ci_update',
        {
          id,
          name: value.name ?? value.context,
          status: value.status ?? value.state,
          conclusion: value.conclusion,
          startedAt: value.started_at,
          completedAt: value.completed_at,
          updatedAt: value.updated_at,
          target: value.details_url ?? value.target_url,
        },
        !isPending && !success,
        value.html_url ?? value.target_url,
        head,
      );
    }
    return entity(
      id,
      source === 'comments' ? 'comment' : 'review',
      {
        id,
        body: value.body,
        state: value.state,
        submittedAt: value.submitted_at,
        updatedAt: value.updated_at,
        commit: value.commit_id,
      },
      true,
      value.html_url,
      source === 'reviews' && typeof value.commit_id === 'string' ? sha(value.commit_id) : undefined,
    );
  });
  return {items, size: values.length, pending, failed};
};
const pullProjection = (input: unknown): Projection => {
  const value = object(input);
  if (!['open', 'closed'].includes(String(value.state))) throw fail('provider-shape');
  return {
    items: [],
    size: 0,
    pending: 0,
    failed: 0,
    pull: {
      head: sha(object(value.head).sha),
      state: value.merged === true ? 'merged' : (value.state as 'open' | 'closed'),
    },
  };
};
const commentsFields = 'pageInfo{hasNextPage endCursor} nodes{id url body updatedAt}';
const threadFields = 'id isResolved isOutdated path line comments(first:5){' + commentsFields + '}';
const threadsQuery =
  'query($owner:String!,$repo:String!,$number:Int!,$after:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:20,after:$after){pageInfo{hasNextPage endCursor}nodes{' +
  threadFields +
  '}}}}rateLimit{cost remaining resetAt}}';
const repliesQuery =
  'query($id:ID!,$after:String){node(id:$id){...on PullRequestReviewThread{id comments(first:100,after:$after){' +
  commentsFields +
  '}}}rateLimit{cost remaining resetAt}}';

/** All requests are serial and bounded. A failed source retains its previous checkpoint independently. */
export const collectNativeWatchGitHub = Effect.fn('workflowWatch.collectGitHub')(function* (
  pr: string,
  previous: NativeWatchProviderCache = {pages: []},
) {
  const target = nativeWatchPullRequest(pr);
  const base = `repos/${target.owner}/${target.repo}`;
  const now = yield* NativeWatchProviderNow;
  const started = now();
  const metrics: NativeWatchProviderMetrics = {
    requests: 0,
    notModified: 0,
    responseBytes: 0,
    graphqlCost: 0,
    providerMilliseconds: 0,
  };
  const pages = new Map(previous.pages.map(page => [page.key, page]));
  const used = new Set<string>();
  const blockers: {source: string; code: string; retryable: boolean}[] = [];
  let retryAt = started + 60_000;
  let blockedUntil = 0;
  let authenticationFailed = false;
  const request = Effect.fn('workflowWatch.request')(function* (
    endpoint: string,
    data?: unknown,
    cached?: NativeWatchHttpPage,
  ) {
    if (authenticationFailed) return yield* fail('provider-authentication');
    if (now() < blockedUntil) return yield* fail('provider-rate-limit', true);
    if (now() - started > 45_000) return yield* fail('provider-sweep-timeout', true);
    metrics.requests++;
    const args = [
      'api',
      '--hostname',
      'github.com',
      '--include',
      '--method',
      data === undefined ? 'GET' : 'POST',
      endpoint,
    ];
    if (cached?.etag) args.push('-H', 'If-None-Match: ' + cached.etag);
    else if (cached?.modified) args.push('-H', 'If-Modified-Since: ' + cached.modified);
    if (data !== undefined) args.push('--input', '-');
    const result = yield* runCommandEffect('gh', args, {
      allowFailure: true,
      timeoutMs: 15_000,
      maxOutputBytes: 8 * 1024 * 1024,
      ...(data === undefined ? {} : {input: new TextEncoder().encode(JSON.stringify(data))}),
    }).pipe(Effect.mapError(() => fail('provider-transport', true)));
    metrics.responseBytes += new TextEncoder().encode(result.stdout).byteLength;
    const response = yield* Effect.try({
      try: () => nativeWatchHttpResponse(result.stdout),
      catch: () => fail('provider-http', true),
    });
    const at = now();
    const seconds = (name: string) => {
      const value = response.headers.get(name);
      return value !== undefined && /^\d+$/u.test(value) ? Number(value) : undefined;
    };
    const poll = seconds('x-poll-interval');
    if (poll !== undefined) retryAt = Math.max(retryAt, at + poll * 1000);
    const retry = response.headers.get('retry-after');
    if (retry !== undefined) {
      const until = /^\d+$/u.test(retry) ? at + Number(retry) * 1000 : Date.parse(retry);
      if (Number.isFinite(until)) retryAt = Math.max(retryAt, until);
    }
    if (seconds('x-ratelimit-remaining') === 0) {
      blockedUntil = Math.max(at + 1000, (seconds('x-ratelimit-reset') ?? at / 1000 + 60) * 1000);
      retryAt = Math.max(retryAt, blockedUntil);
    }
    if (response.status === 304 && cached) {
      metrics.notModified++;
      return {response, value: undefined, cached: cached.projection};
    }
    if (response.status === 401) {
      authenticationFailed = true;
      return yield* fail('provider-authentication');
    }
    if (response.status === 403 || response.status === 429) {
      if (retry !== undefined || seconds('x-ratelimit-remaining') === 0 || response.status === 429) {
        blockedUntil = Math.max(retryAt, at + 60_000);
        return yield* fail('provider-rate-limit', true);
      }
      return yield* fail('provider-permission');
    }
    if (response.status >= 500) return yield* fail('provider-server', true);
    if (response.status !== 200) return yield* fail('provider-http-' + response.status);
    const value = yield* Effect.try({
      try: () => JSON.parse(response.body) as unknown,
      catch: () => fail('provider-json', true),
    });
    return {response, value, cached: undefined};
  });
  const rest = Effect.fn('workflowWatch.rest')(function* (
    key: string,
    endpoint: string,
    project: (input: unknown) => Projection,
  ) {
    const old = pages.get(key);
    const result = yield* request(endpoint, undefined, old);
    const projection =
      result.cached ??
      (yield* Effect.try({
        try: () => project(result.value),
        catch: error => (Schema.is(WorkflowAutomationError)(error) ? error : fail('provider-shape')),
      }));
    const etag = result.response.headers.get('etag') ?? old?.etag;
    const modified = result.response.headers.get('last-modified') ?? old?.modified;
    if ((etag?.length ?? 0) > 1024 || (modified?.length ?? 0) > 128) return yield* fail('provider-shape');
    pages.set(key, {key, projection, ...(etag ? {etag} : {}), ...(modified ? {modified} : {})});
    used.add(key);
    return projection;
  });
  const graphql = Effect.fn('workflowWatch.graphql')(function* (query: string, variables: unknown) {
    const result = yield* request('graphql', {query, variables});
    const value = yield* Effect.try({try: () => object(result.value), catch: () => fail('provider-shape')});
    if (value.errors !== undefined) {
      const errors = array(value.errors);
      const rateLimited = errors.some(error => object(error).type === 'RATE_LIMITED');
      if (rateLimited) {
        blockedUntil = Math.max(retryAt, now() + 60_000);
        retryAt = blockedUntil;
      }
      return yield* fail(rateLimited ? 'provider-rate-limit' : 'provider-graphql', rateLimited);
    }
    const data = object(value.data);
    const rate = object(data.rateLimit);
    metrics.graphqlCost += number(rate.cost);
    if (number(rate.remaining) === 0) {
      const reset = Date.parse(text(rate.resetAt));
      if (!Number.isFinite(reset)) return yield* fail('provider-shape');
      blockedUntil = Math.max(now() + 1000, reset);
      retryAt = Math.max(retryAt, blockedUntil);
    }
    return data;
  });
  const pullEndpoint = `${base}/pulls/${target.number}`;
  const before = (yield* rest('pull', pullEndpoint, pullProjection)).pull!;
  const sources: NativeWatchSourceResult[] = [];
  const all: NativeWatchEntity[] = [];
  let pending = 0;
  let failed = 0;
  const capture = <R>(source: Source, body: Effect.Effect<readonly NativeWatchEntity[], WorkflowAutomationError, R>) =>
    Effect.gen(function* () {
      const result = yield* body.pipe(
        Effect.catchDefect(error =>
          Effect.fail(Schema.is(WorkflowAutomationError)(error) ? error : fail('provider-shape')),
        ),
        Effect.result,
      );
      if (result._tag === 'Failure') {
        const error = result.failure;
        blockers.push({source, code: error.code, retryable: error.retryable === true});
        sources.push({
          source,
          complete: false,
          error: {code: error.code, retryable: error.retryable === true},
          at: now(),
        });
      } else
        sources.push({
          source,
          complete: true,
          items: [...result.success],
          ...(source === 'checks' || source === 'statuses' ? {head: before.head} : {}),
          at: now(),
        });
    });
  for (const source of ['comments', 'reviews', 'checks', 'statuses'] as const) {
    const endpoint =
      source === 'comments'
        ? `${base}/issues/${target.number}/comments`
        : source === 'reviews'
          ? `${base}/pulls/${target.number}/reviews`
          : source === 'checks'
            ? `${base}/commits/${before.head}/check-runs?filter=latest`
            : `${base}/commits/${before.head}/status`;
    yield* capture(
      source,
      Effect.gen(function* () {
        const items: NativeWatchEntity[] = [];
        const oldKeys = new Set(used);
        for (let page = 1; page <= 101; page++) {
          if (page === 101) return yield* fail('provider-pagination-limit');
          const query = endpoint + (endpoint.includes('?') ? '&' : '?') + `per_page=100&page=${page}`;
          const projection = yield* rest(
            source + ':' + (source === 'checks' || source === 'statuses' ? before.head + ':' : '') + page,
            query,
            input => restProjection(source, input, before.head),
          );
          items.push(...projection.items);
          if (source === 'checks' || source === 'statuses') {
            all.push(...projection.items);
            pending += projection.pending;
            failed += projection.failed;
          }
          // Poll the next page even when a cached full page has no new Link header.
          if (projection.size < 100) break;
        }
        if (items.length > 10_000 || new Set(items.map(item => item.id)).size !== items.length) {
          for (const key of used) if (!oldKeys.has(key)) used.delete(key);
          return yield* fail('provider-pagination-race', true);
        }
        return items;
      }),
    );
  }
  yield* capture(
    'threads',
    Effect.gen(function* () {
      const items: NativeWatchEntity[] = [];
      let after: string | null = null;
      const cursors = new Set<string>();
      for (let page = 0; page < 100; page++) {
        const data = yield* graphql(threadsQuery, {...target, after});
        const connection = object(object(object(data.repository).pullRequest).reviewThreads);
        for (const raw of array(connection.nodes)) {
          const thread = object(raw);
          const id = text(thread.id);
          if (typeof thread.isResolved !== 'boolean' || typeof thread.isOutdated !== 'boolean')
            return yield* fail('provider-shape');
          const comments: Record<string, unknown>[] = [];
          let connection = object(thread.comments);
          const commentCursors = new Set<string>();
          for (let nested = 0; nested < 100; nested++) {
            comments.push(...array(connection.nodes).map(object));
            const info = object(connection.pageInfo);
            if (info.hasNextPage === false) break;
            const next = text(info.endCursor, 1024);
            if (nested === 99 || commentCursors.has(next)) return yield* fail('provider-pagination-race', true);
            commentCursors.add(next);
            const nextPage = yield* graphql(repliesQuery, {id, after: next});
            const node = object(nextPage.node);
            if (node.id !== id) return yield* fail('provider-pagination-race', true);
            connection = object(node.comments);
          }
          const unresolved = !thread.isResolved;
          const link = comments[0]?.url;
          const versions = comments.map(comment =>
            entity(
              text(comment.id),
              'review_comment',
              {
                id: comment.id,
                body: comment.body,
                updatedAt: comment.updatedAt,
              },
              unresolved,
              comment.url,
            ),
          );
          items.push(
            entity(
              id,
              'review_thread',
              {
                id,
                resolved: thread.isResolved,
                outdated: thread.isOutdated,
                path: thread.path,
                line: thread.line,
                comments: versions.map(comment => [comment.id, comment.version]),
              },
              unresolved,
              link,
            ),
            ...versions,
          );
          if (items.length > 10_000) return yield* fail('provider-pagination-limit');
        }
        const info = object(connection.pageInfo);
        if (info.hasNextPage === false) break;
        const next = text(info.endCursor, 1024);
        if (page === 99 || cursors.has(next)) return yield* fail('provider-pagination-race', true);
        cursors.add(next);
        after = next;
      }
      if (new Set(items.map(item => item.id)).size !== items.length)
        return yield* fail('provider-pagination-race', true);
      return items;
    }),
  );
  const finalPull = yield* rest('pull', pullEndpoint, pullProjection).pipe(Effect.result);
  const after = finalPull._tag === 'Success' ? finalPull.success.pull! : before;
  if (finalPull._tag === 'Failure')
    blockers.push({source: 'pull', code: finalPull.failure.code, retryable: finalPull.failure.retryable === true});
  const verifiedSources =
    finalPull._tag === 'Success'
      ? sources
      : sources.map(source =>
          source.source === 'checks' || source.source === 'statuses'
            ? {
                source: source.source,
                complete: false as const,
                error: {code: 'provider-head-unverified', retryable: true},
                at: now(),
              }
            : source,
        );
  const at = now();
  metrics.providerMilliseconds = at - started;
  const complete =
    verifiedSources.length === 5 && verifiedSources.every(source => source.complete) && before.head === after.head;
  return {
    sweep: {
      head: after.head,
      startedHead: before.head,
      state: after.state,
      at,
      sources: verifiedSources,
      ci: {
        head: before.head,
        complete,
        count: all.length,
        pending,
        failed,
        version: fingerprint(all.map(item => [item.id, item.version]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
      },
    },
    cache: {pages: [...pages.values()].filter(page => used.has(page.key)).slice(-402)},
    metrics,
    retryAt,
    blockers,
  } satisfies NativeWatchProviderResult;
});
