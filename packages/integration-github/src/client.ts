import {
  isSafeInteger as checkedIsSafeInteger,
  isFiniteNumber as checkedIsFiniteNumber,
} from '@threadnote/platform/validation';
import {Array as EffectArray, Schema} from 'effect';
import {Redacted} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {normalizeGitHubRepository} from './config.js';
import {validGitHubApiToken} from './credentials.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const GITHUB_API_ORIGIN = 'https://api.github.com';
export const GITHUB_API_VERSION = '2022-11-28';
const PAGE_SIZE = 100;
const RESPONSE_LIMIT = 2 * 1024 * 1024;
export const GitHubClientErrorCodeSchema = Schema.Literals([
  'authentication-rejected',
  'access-rejected',
  'not-found',
  'quota-rejected',
  'transport-rejected',
  'response-too-large',
  'contract-invalid',
  'contract-incomplete',
  'credential-reflected',
  'deadline-exceeded',
  'snapshot-changed',
]);
export type GitHubClientErrorCode = typeof GitHubClientErrorCodeSchema.Type;
export class GitHubClientError extends Schema.TaggedError<GitHubClientError, {readonly brand: unique symbol}>()(
  'GitHubClientError',
  {code: GitHubClientErrorCodeSchema, retryAfterMilliseconds: Schema.optional(Schema.Finite)},
) {}
export interface GitHubClientBudget {
  requests: number;
  responseBytes: number;
  readonly maxRequests: number;
  readonly maxResponseBytes: number;
  readonly deadlineAt: number;
}
export interface GitHubClientOptions {
  readonly fetch?: (input: URL, init: RequestInit) => Promise<Response>;
  readonly signal?: AbortSignal;
  readonly requestTimeoutMilliseconds?: number;
  readonly totalTimeoutMilliseconds?: number;
  readonly maxRequests?: number;
  readonly budget?: GitHubClientBudget;
}
export const makeGitHubClientBudget = (milliseconds: number, requests: number): GitHubClientBudget => ({
  requests: 0,
  responseBytes: 0,
  maxRequests: requests,
  maxResponseBytes: 16 * 1024 * 1024,
  deadlineAt: Date.now() + milliseconds,
});
export interface GitHubRepository {
  readonly id: string;
  readonly name: string;
  readonly private: boolean;
}
export interface GitHubCandidate {
  readonly id: string;
  readonly number: number;
  readonly kind: 'issue' | 'pull';
}
export interface GitHubComment {
  readonly id: string;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly url: string;
}
export interface GitHubReview extends GitHubComment {
  readonly state: string;
}
export interface GitHubThread {
  readonly id: string;
  readonly resolved: boolean;
  readonly outdated: boolean;
  readonly path: string;
  readonly line: number | null;
  readonly diffHunk: string;
  readonly comments: readonly GitHubComment[];
}
export interface GitHubConversation extends GitHubCandidate {
  readonly repository: GitHubRepository;
  readonly title: string;
  readonly body: string;
  readonly author: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state: string;
  readonly url: string;
  readonly merged?: boolean;
  readonly draft?: boolean;
  readonly comments: readonly GitHubComment[];
  readonly reviews: readonly GitHubReview[];
  readonly threads: readonly GitHubThread[];
}
export const githubDocumentId = (repositoryId: string, item: GitHubCandidate) => {
  if (!/^\d+$/.test(repositoryId) || !/^\d+$/.test(item.id)) fail('contract-invalid');
  return `r-${repositoryId}-${item.kind}-${item.id}`;
};
export function githubSnapshotHash(value: GitHubConversation): string {
  return sha256HexSync(JSON.stringify(value));
}
function fail(code: GitHubClientErrorCode, retryAfterMilliseconds?: number): never {
  throw GitHubClientError.make({code, ...(retryAfterMilliseconds === undefined ? {} : {retryAfterMilliseconds})});
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !EffectArray.isArray(value);
}
function obj(value: unknown): Record<string, unknown> {
  if (!record(value)) fail('contract-invalid');
  return value;
}
function str(value: unknown, maximum = 1_000_000): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maximum) fail('contract-invalid');
  return value;
}
function id(value: unknown): string {
  if (!checkedIsSafeInteger(value) || value <= 0) fail('contract-invalid');
  return String(value);
}
function integer(value: unknown): number {
  if (!checkedIsSafeInteger(value) || value < 0) fail('contract-invalid');
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') fail('contract-invalid');
  return value;
}
function date(value: unknown): string {
  const result = str(value, 128);
  if (!/^\d{4}-\d\d-\d\dT/.test(result) || !checkedIsFiniteNumber(Date.parse(result))) fail('contract-invalid');
  return result;
}
function author(value: unknown): string {
  return value === null ? '[deleted]' : str(obj(value).login, 256);
}
function body(value: unknown): string {
  return value === null ? '' : str(value);
}
function browserLink(value: unknown, repository: string, number: number): string {
  const link = str(value, 2048);
  const url = new URL(link);
  const [owner, name] = Effect.pipe(repository, EffectString.split('/'));
  const prefix = `/${owner}/${name}/`;
  if (
    url.origin !== 'https://github.com' ||
    url.username ||
    url.password ||
    url.search ||
    !Effect.pipe(url.pathname, EffectString.toLowerCase, EffectString.startsWith(prefix)) ||
    !new RegExp(`^/(?:[^/]+)/[^/]+/(?:issues|pull)/${number}(?:/files)?$`).test(url.pathname) ||
    (url.hash && !/^#[A-Za-z0-9_-]+$/.test(url.hash))
  )
    fail('contract-invalid');
  return link;
}
function retryDelay(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  const delay = raw === null ? NaN : /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now();
  const reset = Number(headers.get('x-ratelimit-reset')) * 1000 - Date.now();
  const candidates = EffectArray.filter(
    [delay, headers.get('x-ratelimit-remaining') === '0' ? reset : NaN],
    value => checkedIsFiniteNumber(value) && value >= 0,
  );
  return candidates.length ? Math.min(Math.max(...candidates), 8_640_000_000_000_000 - Date.now() - 1) : undefined;
}
function pageNumber(value: number): number {
  if (!checkedIsSafeInteger(value) || value < 1) fail('contract-invalid');
  return value;
}
function candidate(value: unknown): GitHubCandidate {
  const item = obj(value);
  return {id: id(item.id), number: integer(item.number), kind: item.pull_request === undefined ? 'issue' : 'pull'};
}
function comments(value: unknown, repository: string, number: number, graphql = false): GitHubComment {
  const item = obj(value);
  return {
    id: graphql ? str(item.id, 256) : id(item.id),
    author: author(graphql ? item.author : item.user),
    body: body(item.body),
    createdAt: date(graphql ? item.createdAt : item.created_at),
    updatedAt: date(graphql ? item.updatedAt : item.updated_at),
    url: browserLink(graphql ? item.url : item.html_url, repository, number),
  };
}
function connection(value: unknown): {nodes: unknown[]; count: number; cursor: string | null; more: boolean} {
  const item = obj(value);
  const info = obj(item.pageInfo);
  if (!EffectArray.isArray(item.nodes) || item.nodes.length > 100) fail('contract-incomplete');
  const more = bool(info.hasNextPage);
  const cursor = info.endCursor === null ? null : str(info.endCursor, 512);
  if (more && (!cursor || item.nodes.length === 0)) fail('contract-incomplete');
  return {nodes: item.nodes, count: integer(item.totalCount), cursor, more};
}
const THREAD_FIELDS = `id isResolved isOutdated path line comments(first:100,after:$commentCursor) { totalCount pageInfo {hasNextPage endCursor} nodes {id author {login} body createdAt updatedAt url diffHunk pullRequestReview {state}} }`;

export function createGitHubClient(token: Redacted.Redacted<string>, options: GitHubClientOptions = {}) {
  if (!validGitHubApiToken(token)) fail('authentication-rejected');
  const secret = Redacted.value(token);
  const fetchImpl = options.fetch ?? fetch;
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, {once: true});
  if (options.signal?.aborted) abort();
  const timeout = Math.min(
    options.totalTimeoutMilliseconds ?? 60_000,
    60_000,
    options.budget === undefined ? Infinity : options.budget.deadlineAt - Date.now(),
  );
  const deadlineAt = Date.now() + Math.max(0, timeout);
  const totalTimer = setTimeout(abort, Math.max(1, timeout));
  let requests = 0;
  let bytes = 0;
  const repositoryIds = new Map<string, string>();
  async function request(
    path: string,
    query?: {query: string; variables: Record<string, unknown>},
    redirects = 0,
  ): Promise<{value: unknown; headers: Headers}> {
    if (
      !(path === '/graphql' && query) &&
      !/^\/(?:repos\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+|repositories\/[1-9][0-9]*)(?:\/(?:issues|pulls)(?:\/[1-9][0-9]*(?:\/(?:comments|reviews))?|\/comments)?)?(?:\?[^#]*)?$/.test(
        path,
      )
    )
      fail('transport-rejected');
    const url = new URL(path, GITHUB_API_ORIGIN);
    if (url.origin !== GITHUB_API_ORIGIN || url.username || url.password || url.hash) fail('transport-rejected');
    if (
      controller.signal.aborted ||
      Date.now() >= deadlineAt ||
      (options.budget &&
        (Date.now() >= options.budget.deadlineAt ||
          options.budget.requests >= options.budget.maxRequests ||
          options.budget.responseBytes >= options.budget.maxResponseBytes))
    )
      fail('deadline-exceeded');
    if (++requests > Math.min(options.maxRequests ?? 256, 1024)) fail('deadline-exceeded');
    if (options.budget) options.budget.requests++;
    const local = new AbortController();
    const cancel = () => local.abort();
    controller.signal.addEventListener('abort', cancel, {once: true});
    const timer = setTimeout(cancel, Math.min(Math.max(options.requestTimeoutMilliseconds ?? 10_000, 1), 30_000));
    const expired = Promise.withResolvers<never>();
    local.signal.addEventListener('abort', () => expired.reject(GitHubClientError.make({code: 'deadline-exceeded'})), {
      once: true,
    });
    try {
      const pending = fetchImpl(url, {
        method: query ? 'POST' : 'GET',
        redirect: 'manual',
        signal: local.signal,
        headers: {
          Authorization: `Bearer ${secret}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
          ...(query ? {'Content-Type': 'application/json'} : {}),
        },
        ...(query ? {body: JSON.stringify(query)} : {}),
      });
      void pending.then(
        response => {
          if (local.signal.aborted) void response.body?.cancel().catch(() => undefined);
        },
        () => undefined,
      );
      const response = await Promise.race([pending, expired.promise]);
      if (response.status === 401) fail('authentication-rejected');
      if (
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0'))
      )
        fail('quota-rejected', retryDelay(response.headers));
      if (response.status === 301 && !query && redirects < 3) {
        const target = new URL(response.headers.get('location') ?? '', GITHUB_API_ORIGIN);
        if (
          target.origin !== GITHUB_API_ORIGIN ||
          target.username ||
          target.password ||
          target.hash ||
          (Effect.pipe(url.pathname, EffectString.startsWith('/repositories/')) && target.pathname !== url.pathname) ||
          !/^\/(?:repos\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+|repositories\/[1-9][0-9]*)(?:\/|$)/.test(target.pathname)
        )
          fail('transport-rejected');
        void response.body?.cancel().catch(() => undefined);
        return await request(target.pathname + target.search, undefined, redirects + 1);
      }
      if (response.status === 403) {
        const reader = response.body?.getReader();
        let errorText = '';
        if (reader)
          try {
            let size = 0;
            const decoder = new TextDecoder();
            while (size < 4096) {
              const part = await Promise.race([reader.read(), expired.promise]);
              if (part.done) break;
              size += part.value.byteLength;
              if (size <= 4096) errorText += decoder.decode(part.value, {stream: true});
            }
          } finally {
            void reader.cancel().catch(() => undefined);
          }
        if (/secondary rate limit|abuse detection|rate limit exceeded/i.test(errorText))
          fail('quota-rejected', retryDelay(response.headers) ?? 60_000);
        fail('access-rejected');
      }
      if (response.status === 404) fail('not-found');
      if (
        response.status !== 200 ||
        !Effect.pipe(
          response.headers.get('content-type'),
          effectOptionalString =>
            effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.toLowerCase),
          effectOptionalString =>
            effectOptionalString == null
              ? undefined
              : Effect.pipe(effectOptionalString, EffectString.startsWith('application/json')),
        )
      )
        fail('transport-rejected');
      if (Number(response.headers.get('content-length')) > RESPONSE_LIMIT || !response.body) fail('response-too-large');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await Promise.race([reader.read(), expired.promise]);
          if (chunk.done) break;
          size += chunk.value.byteLength;
          bytes += chunk.value.byteLength;
          if (options.budget) options.budget.responseBytes += chunk.value.byteLength;
          if (
            size > RESPONSE_LIMIT ||
            bytes > 16 * 1024 * 1024 ||
            (options.budget && options.budget.responseBytes > options.budget.maxResponseBytes)
          )
            fail('response-too-large');
          chunks.push(chunk.value);
        }
      } finally {
        void reader.cancel().catch(() => undefined);
      }
      const joined = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const text = new TextDecoder('utf-8', {fatal: true}).decode(joined);
      if (Effect.pipe(text, EffectString.includes(secret))) fail('credential-reflected');
      const value: unknown = JSON.parse(text);
      const containsSecret = (item: unknown): boolean =>
        typeof item === 'string'
          ? Effect.pipe(item, EffectString.includes(secret))
          : EffectArray.isArray(item)
            ? EffectArray.some(item, containsSecret)
            : record(item)
              ? EffectArray.some(EffectRecord.values(item), containsSecret)
              : false;
      if (containsSecret(value)) fail('credential-reflected');
      return {value, headers: response.headers};
    } catch (error) {
      if (Schema.is(GitHubClientError)(error)) throw error;
      fail(local.signal.aborted || controller.signal.aborted ? 'deadline-exceeded' : 'transport-rejected');
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', cancel);
    }
  }
  const repositoryPath = (repository: string) => `/repos/${normalizeGitHubRepository(repository)}`;
  async function readRepository(name: string): Promise<GitHubRepository> {
    const requested = normalizeGitHubRepository(name);
    const value = obj((await request(repositoryPath(requested))).value);
    const canonical = normalizeGitHubRepository(str(value.full_name, 256));
    const repositoryId = id(value.id);
    for (const key of [requested, canonical]) {
      const pinned = repositoryIds.get(key);
      if (pinned !== undefined && pinned !== repositoryId) fail('access-rejected');
    }
    repositoryIds.set(requested, repositoryId);
    repositoryIds.set(canonical, repositoryId);
    return {id: repositoryId, name: canonical, private: bool(value.private)};
  }
  async function pinnedRepositoryPath(repository: string, expectedId?: string): Promise<string> {
    const name = normalizeGitHubRepository(repository);
    const pinned = repositoryIds.get(name) ?? (await readRepository(name)).id;
    if (expectedId !== undefined && pinned !== expectedId) fail('access-rejected');
    return `/repositories/${pinned}`;
  }
  function continuationPath(link: string, expected: URL, repository: string): string {
    const provided = new URL(link);
    const alias = Effect.pipe(
      expected.pathname,
      EffectString.replace(/^\/repositories\/[1-9][0-9]*/, repositoryPath(repository)),
    );
    if (
      provided.origin !== expected.origin ||
      (provided.pathname !== expected.pathname &&
        Effect.pipe(provided.pathname, EffectString.toLowerCase) !== Effect.pipe(alias, EffectString.toLowerCase)) ||
      provided.username ||
      provided.password ||
      provided.hash
    )
      fail('contract-incomplete');
    const allowed = new Set([...expected.searchParams.keys(), 'after']);
    if (
      EffectArray.some(
        [...provided.searchParams],
        ([key, value]) =>
          !allowed.has(key) ||
          provided.searchParams.getAll(key).length !== 1 ||
          (key === 'after' && !/^[A-Za-z0-9_+=/-]{1,2048}$/.test(value)),
      )
    )
      fail('contract-incomplete');
    if (EffectArray.some([...expected.searchParams], ([key, value]) => provided.searchParams.get(key) !== value))
      fail('contract-incomplete');
    return expected.pathname + provided.search;
  }
  async function page(
    repository: string,
    suffix: string,
    pageIndex: number,
    extra = '',
    continuation?: string,
  ): Promise<{items: unknown[]; hasMore: boolean; continuation?: string}> {
    const expected = new URL(
      `${await pinnedRepositoryPath(repository)}${suffix}?per_page=100&page=${pageNumber(pageIndex)}${extra}`,
      GITHUB_API_ORIGIN,
    );
    const response = await request(
      continuation === undefined
        ? expected.pathname + expected.search
        : continuationPath(continuation, expected, repository),
    );
    if (!EffectArray.isArray(response.value) || response.value.length > PAGE_SIZE) fail('contract-invalid');
    const next = Effect.Option.getOrUndefined(
      Effect.Option.map(Effect.Option.fromNullishOr(response.headers.get('link')), header =>
        Effect.Option.getOrUndefined(
          EffectArray.findFirst(Effect.pipe(header, EffectString.split(',')), part => /;\s*rel="next"/.test(part)),
        ),
      ),
    );
    let nextLink: string | undefined;
    if (next) {
      const match = /^\s*<([^>]+)>;\s*rel="next"\s*$/.exec(next);
      expected.searchParams.set('page', String(pageIndex + 1));
      if (!match || response.value.length === 0) fail('contract-incomplete');
      continuationPath(match[1], expected, repository);
      nextLink = match[1];
    }
    return {
      items: response.value,
      hasMore: nextLink !== undefined,
      ...(nextLink === undefined ? {} : {continuation: nextLink}),
    };
  }
  async function all(repository: string, suffix: string): Promise<unknown[]> {
    const values: unknown[] = [];
    let continuation: string | undefined;
    for (let index = 1; index <= 1000; index++) {
      const result = await page(repository, suffix, index, '', continuation);
      values.push(...result.items);
      if (!result.hasMore) return values;
      continuation = result.continuation;
    }
    return fail('contract-incomplete');
  }
  async function graphql(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await request('/graphql', {query, variables});
    const result = obj(response.value);
    if (result.errors !== undefined && (!EffectArray.isArray(result.errors) || result.errors.length !== 0)) {
      const errors = EffectArray.isArray(result.errors) ? result.errors : [];
      if (EffectArray.some(errors, error => record(error) && error.type === 'RATE_LIMITED'))
        fail('quota-rejected', retryDelay(response.headers) ?? 60_000);
      if (
        EffectArray.some(errors, error => record(error) && (error.type === 'FORBIDDEN' || error.type === 'NOT_FOUND'))
      )
        fail('access-rejected');
      fail('contract-incomplete');
    }
    return obj(result.data);
  }
  async function threads(repository: GitHubRepository, number: number): Promise<GitHubThread[]> {
    const [owner, name] = Effect.pipe(repository.name, EffectString.split('/'));
    const output: GitHubThread[] = [];
    const threadIds = new Set<string>();
    const threadCursors = new Set<string>();
    let cursor: string | null = null;
    let count: number | undefined;
    do {
      const data = await graphql(
        `query($owner:String!,$name:String!,$number:Int!,$cursor:String,$commentCursor:String) { repository(owner:$owner,name:$name) { databaseId pullRequest(number:$number) { reviewThreads(first:100,after:$cursor) {totalCount pageInfo {hasNextPage endCursor} nodes {${THREAD_FIELDS}}} } } }`,
        {owner, name, number, cursor, commentCursor: null},
      );
      const found = obj(data.repository);
      if (id(found.databaseId) !== repository.id) fail('access-rejected');
      const root = obj(found.pullRequest);
      const listed = connection(root.reviewThreads);
      if (count !== undefined && count !== listed.count) fail('snapshot-changed');
      count = listed.count;
      for (const raw of listed.nodes) {
        const node = obj(raw);
        const threadId = str(node.id, 256);
        if (threadIds.has(threadId)) fail('contract-incomplete');
        threadIds.add(threadId);
        const discussion: GitHubComment[] = [];
        const commentIds = new Set<string>();
        const cursors = new Set<string>();
        let nested = connection(node.comments);
        const total = nested.count;
        let diffHunk = '';
        while (true) {
          if (nested.count !== total) fail('snapshot-changed');
          for (const rawComment of nested.nodes) {
            const item = obj(rawComment);
            const comment = comments(item, repository.name, number, true);
            if (commentIds.has(comment.id)) fail('contract-incomplete');
            commentIds.add(comment.id);
            const review = obj(item.pullRequestReview);
            const reviewState = str(review.state, 64);
            if (reviewState !== 'PENDING') {
              discussion.push(comment);
              if (!diffHunk) diffHunk = str(item.diffHunk);
            }
          }
          if (!nested.more) break;
          if (nested.cursor === null || cursors.has(nested.cursor)) fail('contract-incomplete');
          cursors.add(nested.cursor);
          const continuation = await graphql(
            `query($id:ID!,$commentCursor:String) {node(id:$id) {... on PullRequestReviewThread {${THREAD_FIELDS}}}}`,
            {id: threadId, commentCursor: nested.cursor},
          );
          const thread = obj(continuation.node);
          if (
            thread.id !== threadId ||
            thread.isResolved !== node.isResolved ||
            thread.isOutdated !== node.isOutdated ||
            thread.path !== node.path ||
            thread.line !== node.line
          )
            fail('snapshot-changed');
          nested = connection(thread.comments);
        }
        if (commentIds.size !== total) fail('contract-incomplete');
        if (discussion.length)
          output.push({
            id: threadId,
            resolved: bool(node.isResolved),
            outdated: bool(node.isOutdated),
            path: str(node.path, 4096),
            line: node.line === null ? null : integer(node.line),
            diffHunk,
            comments: discussion.sort(
              (a, b) =>
                Effect.pipe(a.createdAt, EffectString.localeCompare(b.createdAt)) ||
                Effect.pipe(a.id, EffectString.localeCompare(b.id)),
            ),
          });
      }
      if (!listed.more) break;
      if (listed.cursor === null || threadCursors.has(listed.cursor)) fail('contract-incomplete');
      threadCursors.add(listed.cursor);
      cursor = listed.cursor;
    } while (cursor !== null);
    if (threadIds.size !== count) fail('contract-incomplete');
    return output.sort((a, b) => Effect.pipe(a.id, EffectString.localeCompare(b.id)));
  }
  async function conversation(repository: GitHubRepository, item: GitHubCandidate): Promise<GitHubConversation> {
    const path = await pinnedRepositoryPath(repository.name, repository.id);
    const raw = obj((await request(`${path}/issues/${item.number}`)).value);
    const identity = candidate(raw);
    if (identity.id !== item.id || identity.kind !== item.kind || identity.number !== item.number)
      fail('contract-invalid');
    const discussion = EffectArray.map(await all(repository.name, `/issues/${item.number}/comments`), value =>
      comments(value, repository.name, item.number),
    );
    if (
      new Set(EffectArray.map(discussion, value => value.id)).size !== discussion.length ||
      integer(raw.comments) !== discussion.length
    )
      fail('snapshot-changed');
    let reviews: GitHubReview[] = [];
    let reviewThreads: GitHubThread[] = [];
    let merged: boolean | undefined;
    let draft: boolean | undefined;
    if (item.kind === 'pull') {
      const pull = obj((await request(`${path}/pulls/${item.number}`)).value);
      if (
        integer(pull.number) !== item.number ||
        browserLink(pull.html_url, repository.name, item.number) !==
          browserLink(raw.html_url, repository.name, item.number)
      )
        fail('contract-invalid');
      merged = bool(pull.merged);
      draft = bool(pull.draft);
      const seen = new Set<string>();
      reviews = EffectArray.flatMap(await all(repository.name, `/pulls/${item.number}/reviews`), value => {
        const review = obj(value);
        const reviewId = id(review.id);
        if (seen.has(reviewId)) fail('contract-incomplete');
        seen.add(reviewId);
        const state = str(review.state, 64);
        if (state === 'PENDING') return [];
        const createdAt = date(review.submitted_at);
        return [
          {
            id: reviewId,
            author: author(review.user),
            body: body(review.body),
            createdAt,
            updatedAt: createdAt,
            state,
            url: browserLink(review.html_url, repository.name, item.number),
          },
        ];
      });
      reviewThreads = await threads(repository, item.number);
    }
    return {
      ...identity,
      repository,
      title: str(raw.title, 4096),
      body: body(raw.body),
      author: author(raw.user),
      createdAt: date(raw.created_at),
      updatedAt: date(raw.updated_at),
      state: str(raw.state, 64),
      url: browserLink(raw.html_url, repository.name, item.number),
      ...(merged === undefined ? {} : {merged, draft}),
      comments: discussion.sort(
        (a, b) =>
          Effect.pipe(a.createdAt, EffectString.localeCompare(b.createdAt)) ||
          Effect.pipe(a.id, EffectString.localeCompare(b.id)),
      ),
      reviews: reviews.sort(
        (a, b) =>
          Effect.pipe(a.createdAt, EffectString.localeCompare(b.createdAt)) ||
          Effect.pipe(a.id, EffectString.localeCompare(b.id)),
      ),
      threads: reviewThreads,
    };
  }
  return {
    repository: readRepository,
    async listIssues(repository: string, pageIndex: number, since?: string, continuation?: string) {
      const extra =
        since === undefined
          ? '&state=all&sort=created&direction=asc'
          : `&state=all&sort=updated&direction=asc&since=${encodeURIComponent(date(since))}`;
      const result = await page(repository, '/issues', pageIndex, extra, continuation);
      const items = EffectArray.map(result.items, candidate);
      if (
        new Set(EffectArray.map(items, item => item.id)).size !== items.length ||
        EffectArray.some(items, item => item.number < 1)
      )
        fail('contract-incomplete');
      return {items, hasMore: result.hasMore, continuation: result.continuation};
    },
    async listChangedNumbers(
      repository: string,
      kind: 'comments' | 'review-comments',
      pageIndex: number,
      since: string,
      continuation?: string,
    ) {
      const result = await page(
        repository,
        kind === 'comments' ? '/issues/comments' : '/pulls/comments',
        pageIndex,
        `&sort=updated&direction=asc&since=${encodeURIComponent(date(since))}`,
        continuation,
      );
      const expected = `${GITHUB_API_ORIGIN}${repositoryPath(repository)}/${kind === 'comments' ? 'issues' : 'pulls'}/`;
      const numbers = EffectArray.map(result.items, value => {
        const item = obj(value);
        id(item.id);
        const link = str(kind === 'comments' ? item.issue_url : item.pull_request_url, 2048);
        const alias = repositoryIds.get(repository);
        const prefixes = [
          expected,
          ...(alias === undefined
            ? []
            : [`${GITHUB_API_ORIGIN}/repositories/${alias}/${kind === 'comments' ? 'issues' : 'pulls'}/`]),
        ];
        const prefix = Effect.Option.getOrUndefined(
          EffectArray.findFirst(prefixes, p =>
            Effect.pipe(link, __effectPipeInput => {
              const __effectPipeStage0 = Effect.pipe(__effectPipeInput, EffectString.toLowerCase);
              const __effectPipeStage1 = Effect.pipe(
                __effectPipeStage0,
                EffectString.startsWith(Effect.pipe(p, EffectString.toLowerCase)),
              );
              return __effectPipeStage1;
            }),
          ),
        );
        if (prefix === undefined || !/^[1-9][0-9]*$/.test(Effect.pipe(link, EffectString.slice(prefix.length))))
          fail('contract-invalid');
        return integer(Number(Effect.pipe(link, EffectString.slice(prefix.length))));
      });
      return {numbers: [...new Set(numbers)], hasMore: result.hasMore, continuation: result.continuation};
    },
    async candidate(repository: string, number: number) {
      return candidate((await request(`${await pinnedRepositoryPath(repository)}/issues/${integer(number)}`)).value);
    },
    conversation,
    async stableConversation(repository: GitHubRepository, item: GitHubCandidate) {
      const first = await conversation(repository, item);
      const second = await conversation(repository, item);
      if (githubSnapshotHash(first) !== githubSnapshotHash(second)) fail('snapshot-changed');
      return second;
    },
    get requests() {
      return requests;
    },
    get expired() {
      return controller.signal.aborted || Date.now() >= deadlineAt;
    },
    close() {
      clearTimeout(totalTimer);
      options.signal?.removeEventListener('abort', abort);
      abort();
    },
  };
}
