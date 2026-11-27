import {
  isSafeInteger as checkedIsSafeInteger,
  isFiniteNumber as checkedIsFiniteNumber,
} from '@threadnote/platform/validation';
import {Array as EffectArray, Predicate} from 'effect';
import {Cause, Context, Effect, Schema} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {redactSensitiveText} from '@threadnote/platform/scrubber';
import type {
  NativeWatchEntity,
  NativeWatchSourceResult,
  NativeWatchSweep,
} from '@threadnote/workflow-automations/watch';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {stableJson} from '../workflow_memory/protocol.js';

import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

type Source = 'comments' | 'reviews' | 'threads' | 'checks' | 'statuses';
export const NativeWatchProviderNow = Context.Reference<() => number>('threadnote/NativeWatchProviderNow', {
  defaultValue: () => Date.now,
});
interface Pull {
  readonly base?: string;
  readonly mergeable?: boolean | null;
  readonly head: string;
  readonly state: 'open' | 'closed' | 'merged';
  readonly identity?: {
    readonly url: string;
    readonly repository: string;
    readonly baseBranch: string;
    readonly headBranch: string;
  };
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
  if (!Predicate.isObject(value)) throw fail('provider-shape');
  return value;
};
const array = (value: unknown): unknown[] => {
  if (!EffectArray.isArray(value)) throw fail('provider-shape');
  return value;
};
const text = (value: unknown, maximum = 256): string => {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > maximum ||
    EffectArray.some([...value], character => {
      const code = Effect2.pipe(
        character,
        EffectString.charCodeAt(0),
        Effect2.Option.getOrElse(() => NaN),
      );
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
  if (!checkedIsSafeInteger(value) || value < 0) throw fail('provider-shape');
  return value;
};
const fingerprint = (value: unknown) => sha256HexSync(stableJson(value));
const entity = (
  id: string,
  kind: string,
  fields: unknown,
  bootstrap: boolean,
  link?: unknown,
  head?: string,
  summary?: string,
): NativeWatchEntity => ({
  id: text(id),
  kind,
  version: fingerprint(fields),
  bootstrap,
  ...(link === undefined || link === null ? {} : {url: url(link)}),
  ...(head === undefined ? {} : {head: sha(head)}),
  ...(summary ? {summary} : {}),
});

const summaryLimit = 1024;
const summaryLineLimit = 200;
const summaryLogLines = 6;
const summaryLogChecks = 6;
const summaryDetailSeparator = ' | ';
const summaryInputLimit = 4096;
const summaryLogFailureLimit = 2;
const summaryLogUnavailable = 'job log unavailable';
const logTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s?/u;
// oxlint-disable-next-line no-control-regex -- Terminal escapes (OSC hyperlinks, also unterminated, then CSI styles) are removed from CI text.
const terminalEscapes = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\|$)|\u001b\[[0-9;?]*[A-Za-z]/gu;
const invisibleFormatting = /[\p{Cf}\u{e0000}-\u{e007f}]/gu;
const stripTerminal = (value: string) =>
  Effect2.pipe(value, EffectString.replace(terminalEscapes, ''), EffectString.replace(invisibleFormatting, ''));
/**
 * Make untrusted CI text safe to keep: bound its input, remove terminal and invisible formatting, replace characters
 * the watch event schema refuses, redact credential-shaped values and collapse whitespace.
 */
const summaryText = (value: string, maximum: number) =>
  Effect2.pipe(
    stripTerminal(EffectString.slice(0, summaryInputLimit)(value)),
    EffectString.replace(/[^\u0020-\u007e\u00a0-\u{10ffff}]+/gu, ' '),
    redactSensitiveText,
    EffectString.replace(/\s+/gu, ' '),
    EffectString.trim,
    EffectString.slice(0, maximum),
    EffectString.trim,
  );
const failureSummary = (name: unknown, outcome: unknown, fallback: string) =>
  Effect2.pipe(
    summaryText(
      `${typeof name === 'string' && name ? name : fallback}: ${typeof outcome === 'string' && outcome ? outcome : 'failed'}`,
      summaryLimit,
    ),
    EffectString.replaceAll('|', '/'),
  ) || undefined;

/**
 * Select only failing test names, their first error line and failing Bazel targets from a CI job log. The raw log is
 * never retained.
 */
export function nativeWatchFailureLines(log: string): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  let errorWindow = 0;
  const add = (line: string) => {
    const value = summaryText(line, summaryLineLimit);
    if (!value || seen.has(value) || lines.length >= summaryLogLines) return;
    seen.add(value);
    lines.push(value);
  };
  for (const raw of EffectString.split(log, /\r?\n/u)) {
    if (lines.length >= summaryLogLines) break;
    // A crafted long line is cut before any regular expression or redaction pass reads it.
    const line = EffectString.trim(
      stripTerminal(EffectString.replace(logTimestamp, '')(EffectString.slice(0, summaryInputLimit)(raw))),
    );
    if (!line) continue;
    if (/^FAIL\s+\S.*\s>\s\S/u.test(line)) {
      add(line);
      errorWindow = 8;
    } else if (/^\/\/\S+\s+FAILED\b/u.test(line)) add(line);
    else if (errorWindow > 0) {
      errorWindow--;
      if (/^(?:[A-Za-z]*Error\b|expected\b)/u.test(line)) {
        add(line);
        errorWindow = 0;
      }
    }
  }
  return lines;
}
const actionsJobId = (item: NativeWatchEntity) => {
  const match = item.url
    ? /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+\/job\/(\d+)$/u.exec(item.url)
    : null;
  return match?.[1] === item.id ? match[1] : undefined;
};

/** This adapter never accepts a hostname, executable, API URL or credential from PR content. */
export function nativeWatchPullRequest(pr: string) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/u.exec(pr);
  if (!match || !checkedIsSafeInteger(Number(match[3]))) throw fail('invalid-pr');
  return {owner: match[1], repo: match[2], number: Number(match[3])};
}

export interface NativeWatchPullIdentity {
  readonly url: string;
  readonly number: number;
  readonly baseRepository: string;
  readonly headRepository: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly headSha: string;
  readonly state: 'open' | 'merged';
}

/** Fetches bounded identity fields and the reported merge object for an existing PR. */
export const observeNativeWatchPullIdentity = Effect.fn('nativeWatch.verifyPullIdentity')(function* (pr: string) {
  const target = yield* Effect.try({try: () => nativeWatchPullRequest(pr), catch: () => fail('invalid-pr')});
  const response = yield* runCommandEffect(
    'gh',
    [
      'api',
      '--hostname',
      'github.com',
      '--method',
      'GET',
      `repos/${target.owner}/${target.repo}/pulls/${target.number}`,
      '--jq',
      '{number, url: .html_url, baseRepository: .base.repo.full_name, headRepository: .head.repo.full_name, baseBranch: .base.ref, headBranch: .head.ref, headSha: .head.sha, state, merged, mergeCommit: .merge_commit_sha}',
    ],
    {timeoutMs: 15_000, maxOutputBytes: 16_384, sensitiveOutput: true},
  ).pipe(Effect.mapError(() => fail('provider-transport', true)));
  const identity = yield* Effect.try({
    try: () => object(JSON.parse(response.stdout)),
    catch: () => fail('provider-shape'),
  });
  const state = identity.state;
  if (identity.number !== target.number || identity.url !== pr) return yield* fail('provider-identity-conflict');
  return yield* Effect.try({
    try: () => {
      const normalized: NativeWatchPullIdentity = {
        url: pr,
        number: target.number,
        baseRepository: text(identity.baseRepository, 256),
        headRepository: text(identity.headRepository, 256),
        baseBranch: text(identity.baseBranch, 256),
        headBranch: text(identity.headBranch, 256),
        headSha: sha(identity.headSha),
        state:
          state === 'open' && identity.merged === false
            ? 'open'
            : state === 'closed' && identity.merged === true
              ? 'merged'
              : (() => {
                  throw fail(state === 'closed' ? 'provider-pr-closed' : 'provider-shape');
                })(),
      };
      if (
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(normalized.baseRepository) ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(normalized.headRepository)
      )
        throw fail('provider-shape');
      // A merge object is required only for terminal retarget verification.
      const mergeCommit =
        normalized.state === 'merged' && typeof identity.mergeCommit === 'string' ? identity.mergeCommit : undefined;
      return {identity: normalized, mergeCommit};
    },
    catch: error => (Schema.is(WorkflowAutomationError)(error) ? error : fail('provider-shape')),
  });
});

/** Existing consumers persist only the PR identity. */
export const verifyNativeWatchPullIdentity = (pr: string) =>
  observeNativeWatchPullIdentity(pr).pipe(Effect.map(observed => observed.identity));

/** Renewal observes PR identity only; it neither validates nor adopts the current head. */
export const verifyNativeWatchRenewalPr = Effect.fn('nativeWatch.verifyRenewalPr')(function* (
  pr: string,
  expected: {readonly baseBranch: string; readonly headBranch: string},
) {
  const target = yield* Effect.try({try: () => nativeWatchPullRequest(pr), catch: () => fail('invalid-pr')});
  const response = yield* runCommandEffect(
    'gh',
    [
      'api',
      '--hostname',
      'github.com',
      '--method',
      'GET',
      `repos/${target.owner}/${target.repo}/pulls/${target.number}`,
      '--jq',
      '{number, url: .html_url, baseRepository: .base.repo.full_name, baseBranch: .base.ref, headBranch: .head.ref}',
    ],
    {timeoutMs: 15_000, maxOutputBytes: 16_384, sensitiveOutput: true},
  ).pipe(Effect.mapError(() => fail('provider-transport', true)));
  const identity = yield* Effect.try({
    try: () => object(JSON.parse(response.stdout)),
    catch: () => fail('provider-shape'),
  });
  const repository = EffectString.toLowerCase(`${target.owner}/${target.repo}`);
  if (
    identity.number !== target.number ||
    identity.url !== pr ||
    typeof identity.baseRepository !== 'string' ||
    EffectString.toLowerCase(identity.baseRepository) !== repository ||
    identity.baseBranch !== expected.baseBranch ||
    identity.headBranch !== expected.headBranch
  )
    return yield* fail('watch-identity-conflict');
});

/** Exact existing-PR observation. This receipt never authorizes an external mutation. */
export const verifyNativeWatchBoundPr = Effect.fn('nativeWatch.verifyBoundPr')(function* (
  pr: string,
  expected: {
    readonly head: string;
    readonly baseBranch?: string;
    readonly headBranch?: string;
    readonly state?: 'open' | 'closed' | 'merged';
  },
) {
  const target = yield* Effect.try({try: () => nativeWatchPullRequest(pr), catch: () => fail('invalid-pr')});
  const response = yield* runCommandEffect(
    'gh',
    [
      'api',
      '--hostname',
      'github.com',
      '--method',
      'GET',
      `repos/${target.owner}/${target.repo}/pulls/${target.number}`,
      '--jq',
      '{number, url: .html_url, baseRepository: .base.repo.full_name, baseBranch: .base.ref, headBranch: .head.ref, headSha: .head.sha, state, merged, mergeCommit: .merge_commit_sha}',
    ],
    {timeoutMs: 15_000, maxOutputBytes: 16_384, sensitiveOutput: true},
  ).pipe(Effect.mapError(() => fail('provider-transport', true)));
  const raw = yield* Effect.try({try: () => object(JSON.parse(response.stdout)), catch: () => fail('provider-shape')});
  const state =
    raw.merged === true ? 'merged' : raw.state === 'open' ? 'open' : raw.state === 'closed' ? 'closed' : undefined;
  if (
    !state ||
    raw.number !== target.number ||
    raw.url !== pr ||
    typeof raw.baseRepository !== 'string' ||
    EffectString.toLowerCase(raw.baseRepository) !== EffectString.toLowerCase(`${target.owner}/${target.repo}`) ||
    raw.headSha !== expected.head ||
    typeof raw.baseBranch !== 'string' ||
    typeof raw.headBranch !== 'string' ||
    (expected.baseBranch !== undefined && raw.baseBranch !== expected.baseBranch) ||
    (expected.headBranch !== undefined && raw.headBranch !== expected.headBranch) ||
    (expected.state !== undefined && state !== expected.state)
  )
    return yield* fail('watch-binding-drift');
  const mergeCommit =
    state === 'merged'
      ? yield* Effect.try({try: () => sha(raw.mergeCommit), catch: () => fail('provider-shape')})
      : undefined;
  return {
    url: pr,
    headSha: expected.head,
    baseBranch: text(raw.baseBranch, 256),
    headBranch: text(raw.headBranch, 256),
    state,
    ...(mergeCommit ? {mergeCommit} : {}),
  };
});

/** Parse only the selected response headers; raw headers/bodies never enter watch state. */
export function nativeWatchHttpResponse(stdout: string) {
  const boundary = /\r?\n\r?\n/u.exec(stdout);
  if (!boundary) throw fail('provider-http');
  const lines = Effect2.pipe(stdout, __effectPipeInput => {
    const __effectPipeStage0 = Effect2.pipe(__effectPipeInput, EffectString.slice(0, boundary.index));
    const __effectPipeStage1 = Effect2.pipe(__effectPipeStage0, EffectString.split(/\r?\n/u));
    return __effectPipeStage1;
  });
  const status = /^HTTP\/[\d.]+\s+(\d{3})(?:\s|$)/u.exec(lines.shift() ?? '');
  if (!status) throw fail('provider-http');
  const headers = new Map<string, string>();
  for (const line of lines) {
    const colon = Effect2.pipe(
      line,
      EffectString.indexOf(':'),
      Effect2.Option.getOrElse(() => -1),
    );
    if (colon > 0)
      headers.set(
        Effect2.pipe(line, EffectString.slice(0, colon), EffectString.trim, EffectString.toLowerCase),
        Effect2.pipe(line, EffectString.slice(colon + 1), EffectString.trim),
      );
  }
  return {
    status: Number(status[1]),
    headers,
    body: Effect2.pipe(stdout, EffectString.slice(boundary.index + boundary[0].length)),
  };
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
  const items = EffectArray.map(values, raw => {
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
        !isPending && !success
          ? failureSummary(value.name ?? value.context, source === 'checks' ? value.conclusion : value.state, id)
          : undefined,
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
  const state = value.state;
  if (state !== 'open' && state !== 'closed') throw fail('provider-shape');
  if (value.mergeable !== undefined && value.mergeable !== null && typeof value.mergeable !== 'boolean')
    throw fail('provider-shape');
  return {
    items: [],
    size: 0,
    pending: 0,
    failed: 0,
    pull: {
      head: sha(object(value.head).sha),
      ...(value.base === undefined ? {} : {base: sha(object(value.base).sha)}),
      mergeable: value.mergeable === undefined ? null : value.mergeable,
      state: value.merged === true ? 'merged' : state,
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
export const collectNativeWatchGitHub = Effect.fn('workflowWatch.collectGitHub')(
  function* (
    pr: string,
    previous: NativeWatchProviderCache = {pages: []},
    expected?: {readonly head: string; readonly baseBranch: string; readonly headBranch: string},
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
    const pages = new Map(EffectArray.map(previous.pages, page => [page.key, page]));
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
      // allowFailure normalizes spawn/timeout/output-limit failures into these
      // exit codes with no HTTP response. Never expose command diagnostics.
      if (result.exitCode === 127) return yield* fail('provider-executable');
      if (result.exitCode === 124) return yield* fail('provider-transport', true);
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
        if (checkedIsFiniteNumber(until)) retryAt = Math.max(retryAt, until);
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
      // Old pull projections need one unconditional refresh within this scheduled request.
      const refreshPull =
        // oxlint-disable-next-line effecttsgo/prefer-effect-record -- This value is not a total homogeneous readonly record accepted by Effect Record.
        key === 'pull' && old?.projection.pull !== undefined && !Object.hasOwn(old.projection.pull, 'mergeable');
      const result = yield* request(endpoint, undefined, refreshPull ? undefined : old);
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
        const rateLimited = EffectArray.some(errors, error => object(error).type === 'RATE_LIMITED');
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
        if (!checkedIsFiniteNumber(reset)) return yield* fail('provider-shape');
        blockedUntil = Math.max(now() + 1000, reset);
        retryAt = Math.max(retryAt, blockedUntil);
      }
      return data;
    });
    const pullEndpoint = `${base}/pulls/${target.number}`;
    const projectPull = (input: unknown): Projection => {
      const projection = pullProjection(input);
      if (!expected) return projection;
      const raw = object(input);
      const base = object(raw.base);
      const head = object(raw.head);
      const repository = text(object(base.repo).full_name);
      if (
        raw.number !== target.number ||
        raw.html_url !== pr ||
        EffectString.toLowerCase(repository) !== EffectString.toLowerCase(`${target.owner}/${target.repo}`) ||
        base.ref !== expected.baseBranch ||
        head.ref !== expected.headBranch ||
        head.sha !== expected.head
      )
        throw fail('watch-binding-drift');
      return {
        ...projection,
        pull: {
          ...projection.pull!,
          identity: {url: pr, repository, baseBranch: expected.baseBranch, headBranch: expected.headBranch},
        },
      };
    };
    const verifyPull = (pull: Pull) => {
      if (
        expected &&
        (pull.head !== expected.head ||
          pull.identity?.url !== pr ||
          pull.identity.baseBranch !== expected.baseBranch ||
          pull.identity.headBranch !== expected.headBranch ||
          EffectString.toLowerCase(pull.identity.repository) !==
            EffectString.toLowerCase(`${target.owner}/${target.repo}`))
      )
        throw fail('watch-binding-drift');
      return pull;
    };
    if (expected && !pages.get('pull')?.projection.pull?.identity) pages.delete('pull');
    const verifiedPull = (pull: Pull) =>
      Effect.try({
        try: () => verifyPull(pull),
        catch: error => (Schema.is(WorkflowAutomationError)(error) ? error : fail('provider-shape')),
      });
    const before = yield* verifiedPull((yield* rest('pull', pullEndpoint, projectPull)).pull!);
    // A completed check run is immutable, so a prior summary for the same id and version is reused as is.
    const priorSummaries = new Map(
      EffectArray.flatMap(previous.pages, page =>
        EffectArray.flatMap(page.projection.items, item =>
          item.summary ? [[`${item.id}\u0000${item.version}`, item.summary] as const] : [],
        ),
      ),
    );
    const jobFailureLines = (jobId: string) =>
      Effect.gen(function* () {
        metrics.requests++;
        const result = yield* runCommandEffect(
          'gh',
          ['api', '--hostname', 'github.com', '--method', 'GET', `${base}/actions/jobs/${jobId}/logs`],
          {allowFailure: true, timeoutMs: 15_000, maxOutputBytes: 8 * 1024 * 1024, sensitiveOutput: true},
        ).pipe(Effect.result);
        if (result._tag === 'Failure' || result.success.exitCode !== 0) return undefined;
        metrics.responseBytes += Buffer.byteLength(result.success.stdout);
        return nativeWatchFailureLines(result.success.stdout);
      });
    /**
     * Best effort: an unreadable log keeps the base summary for a retry in a later sweep and never fails the checks
     * source. An event carries the summary of its emitting sweep only; a later summary never re-emits it.
     */
    const enrichFailedChecks = (items: readonly NativeWatchEntity[]) =>
      Effect.gen(function* () {
        const summaries = new Map<string, string>();
        const pendingReads: {
          readonly item: NativeWatchEntity & {readonly summary: string};
          readonly jobId: string;
          readonly retry: boolean;
        }[] = [];
        for (const item of items) {
          const prior = priorSummaries.get(`${item.id}\u0000${item.version}`);
          const jobId = item.kind === 'ci_error' ? actionsJobId(item) : undefined;
          // Only a finished read adds the ` | ` separator; the base summary never contains it.
          if (prior !== undefined && EffectString.includes(summaryDetailSeparator)(prior))
            summaries.set(item.id, summaryText(prior, summaryLimit));
          else if (jobId && item.summary)
            pendingReads.push({item: {...item, summary: item.summary}, jobId, retry: prior !== undefined});
        }
        // First-seen failures emit their event in this sweep, so they read their logs first.
        const ordered = [
          ...EffectArray.filter(pendingReads, read => !read.retry),
          ...EffectArray.filter(pendingReads, read => read.retry),
        ];
        let consecutiveFailures = 0;
        for (const {item, jobId, retry} of EffectArray.take(ordered, summaryLogChecks)) {
          if (
            authenticationFailed ||
            now() < blockedUntil ||
            now() - started > 20_000 ||
            consecutiveFailures >= summaryLogFailureLimit
          )
            break;
          const lines = yield* jobFailureLines(jobId);
          consecutiveFailures = lines === undefined ? consecutiveFailures + 1 : 0;
          // The first failed read keeps the base summary for one retry; a second failure is final.
          if (lines === undefined && !retry) continue;
          const detail =
            lines === undefined ? [summaryLogUnavailable] : lines.length ? lines : ['no failing test lines in job log'];
          summaries.set(
            item.id,
            summaryText(EffectArray.join([item.summary, ...detail], summaryDetailSeparator), summaryLimit),
          );
        }
        return EffectArray.map(items, item => {
          const summary = summaries.get(item.id);
          return summary === undefined ? item : {...item, summary};
        });
      });
    const sources: NativeWatchSourceResult[] = [];
    const all: NativeWatchEntity[] = [];
    let pending = 0;
    let failed = 0;
    const capture = <R>(
      source: Source,
      body: Effect.Effect<readonly NativeWatchEntity[], WorkflowAutomationError, R>,
    ) =>
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
          const pageKeys: string[] = [];
          for (let page = 1; page <= 101; page++) {
            if (page === 101) return yield* fail('provider-pagination-limit');
            const query =
              endpoint + (Effect2.pipe(endpoint, EffectString.includes('?')) ? '&' : '?') + `per_page=100&page=${page}`;
            const key = source + ':' + (source === 'checks' || source === 'statuses' ? before.head + ':' : '') + page;
            pageKeys.push(key);
            const projection = yield* rest(key, query, input => restProjection(source, input, before.head));
            items.push(...projection.items);
            if (source === 'checks' || source === 'statuses') {
              all.push(...projection.items);
              pending += projection.pending;
              failed += projection.failed;
            }
            // Poll the next page even when a cached full page has no new Link header.
            if (projection.size < 100) break;
          }
          if (items.length > 10_000 || new Set(EffectArray.map(items, item => item.id)).size !== items.length) {
            for (const key of used) if (!oldKeys.has(key)) used.delete(key);
            return yield* fail('provider-pagination-race', true);
          }
          if (source !== 'checks') return items;
          const enriched = yield* enrichFailedChecks(items);
          const byId = new Map(EffectArray.map(enriched, item => [item.id, item]));
          // Cache the enriched items so a not-modified sweep keeps their summaries without a log request.
          for (const key of pageKeys) {
            const page = pages.get(key);
            if (page)
              pages.set(key, {
                ...page,
                projection: {
                  ...page.projection,
                  items: EffectArray.map(page.projection.items, item => byId.get(item.id) ?? item),
                },
              });
          }
          return enriched;
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
              comments.push(...EffectArray.map(array(connection.nodes), object));
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
            const versions = EffectArray.map(comments, comment =>
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
                  comments: EffectArray.map(versions, comment => [comment.id, comment.version]),
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
        if (new Set(EffectArray.map(items, item => item.id)).size !== items.length)
          return yield* fail('provider-pagination-race', true);
        return items;
      }),
    );
    const finalPull = yield* rest('pull', pullEndpoint, projectPull).pipe(Effect.result);
    if (expected && finalPull._tag === 'Failure') return yield* finalPull.failure;
    const after = finalPull._tag === 'Success' ? yield* verifiedPull(finalPull.success.pull!) : before;
    if (finalPull._tag === 'Failure')
      blockers.push({source: 'pull', code: finalPull.failure.code, retryable: finalPull.failure.retryable === true});
    const verifiedSources =
      finalPull._tag === 'Success'
        ? sources
        : EffectArray.map(sources, source =>
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
      verifiedSources.length === 5 &&
      EffectArray.every(verifiedSources, source => source.complete) &&
      before.head === after.head;
    return {
      sweep: {
        head: after.head,
        startedHead: before.head,
        ...(after.base === undefined ? {} : {base: after.base}),
        ...(before.base === undefined ? {} : {startedBase: before.base}),
        ...(finalPull._tag === 'Success' && after.mergeable !== undefined ? {mergeable: after.mergeable} : {}),
        state: after.state,
        at,
        sources: verifiedSources,
        ci: {
          head: before.head,
          complete,
          count: all.length,
          pending,
          failed,
          version: fingerprint(
            EffectArray.map(all, item => [item.id, item.version]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          ),
        },
      },
      cache: {pages: EffectArray.filter([...pages.values()], page => used.has(page.key)).slice(-402)},
      metrics,
      retryAt,
      blockers,
    } satisfies NativeWatchProviderResult;
  },
  Effect.timeout('60 seconds'),
  Effect.catchIf(Cause.isTimeoutError, () => Effect.fail(fail('provider-sweep-timeout', true))),
);
