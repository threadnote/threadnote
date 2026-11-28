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
  readonly jobLogs?: {readonly head: string; readonly entries: readonly JobLogRead[]};
}
interface JobLogRead {
  readonly id: string;
  readonly version: string;
  /** Absent after one failed attempt. Null after a completed read with no usable detail or two failures. */
  readonly detail?: string | null;
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
const summaryNameLimit = 224;
const summaryResultLimit = 32;
const summaryLineLimit = 200;
const summaryLogLines = 6;
const summaryLogChecks = 6;
const summaryDetailSeparator = ' | ';
const summaryInputLimit = 4096;
const summaryLogFailureLimit = 2;
const summaryLogCandidateLimit = 64;
const summaryLogBudgetMs = 5000;
const summaryLogLatestMs = 50_000;
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
const failureSummary = (name: unknown, outcome: unknown, fallback: string) => {
  const label = typeof name === 'string' ? summaryText(name, summaryNameLimit) : '';
  const result = typeof outcome === 'string' ? summaryText(outcome, summaryResultLimit) : '';
  return EffectString.replaceAll('|', '/')(`${label || fallback}: ${result || 'failed'}`);
};

/** An old failed check can lack a label or include log text where current pages keep only the check label and result. */
const needsCheckSummaryRefresh = (page: NativeWatchHttpPage) =>
  EffectString.startsWith('checks:')(page.key) &&
  EffectArray.some(
    page.projection.items,
    ({kind, summary}) =>
      kind === 'ci_error' &&
      (summary === undefined ||
        summary.length > summaryNameLimit + 2 + summaryResultLimit ||
        EffectString.includes(summaryDetailSeparator)(summary) ||
        EffectString.endsWith(' (job log read failed; retrying)')(summary)),
  );

const testFailure = /^FAIL\s+([A-Za-z0-9_./+@-]+\.[cm]?[jt]sx?)\s+>/u;
const bazelFailure = /^(\/\/[A-Za-z0-9_./+@=-]*(?::[A-Za-z0-9_./+@=-]+)?)\s+FAILED\b/u;
const testError = /^(AssertionError|TypeError|ReferenceError|RangeError|SyntaxError|Error)\b/u;

/**
 * Select failing test paths, recognized error classes and failing Bazel labels. Test titles and assertion operands
 * can include customer data, so never copy those fields from a job log.
 */
export function nativeWatchFailureLines(log: string): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  let errorWindow = 0;
  const add = (line: string) => {
    if (seen.has(line) || lines.length >= summaryLogLines) return;
    seen.add(line);
    const value = summaryText(line, summaryLineLimit);
    if (value && !EffectArray.contains(lines, value)) lines.push(value);
  };
  let offset = 0;
  while (offset < log.length && lines.length < summaryLogLines && seen.size < summaryLogCandidateLimit) {
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Effect String cannot search from an offset.
    const newline = log.indexOf('\n', offset);
    const end = newline === -1 ? log.length : newline;
    const prefix = EffectString.slice(offset, Math.min(end, offset + summaryInputLimit))(log);
    offset = end + 1;
    const line = EffectString.trim(stripTerminal(EffectString.replace(logTimestamp, '')(prefix)));
    if (!line) continue;
    const test = testFailure.exec(line);
    if (test) {
      add(`FAIL ${test[1]}`);
      errorWindow = 8;
      continue;
    }
    const target = bazelFailure.exec(line);
    if (target) add(`${target[1]} FAILED`);
    if (errorWindow > 0) {
      errorWindow--;
      const error = testError.exec(line)?.[1];
      if (error || /^expected\b/u.test(line)) {
        add(error ?? 'Assertion failed');
        errorWindow = 0;
      }
    }
  }
  return lines;
}
const isActionsJob = (item: NativeWatchEntity) => {
  const match = item.url
    ? /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+\/job\/(\d+)$/u.exec(item.url)
    : null;
  return match?.[1] === item.id;
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
const httpStatusLine = /^HTTP\/[\d.]+\s+(\d{3})(?:\s|$)/u;

export function nativeWatchHttpResponse(stdout: string) {
  const boundary = /\r?\n\r?\n/u.exec(stdout);
  if (!boundary) throw fail('provider-http');
  const lines = Effect2.pipe(stdout, __effectPipeInput => {
    const __effectPipeStage0 = Effect2.pipe(__effectPipeInput, EffectString.slice(0, boundary.index));
    const __effectPipeStage1 = Effect2.pipe(__effectPipeStage0, EffectString.split(/\r?\n/u));
    return __effectPipeStage1;
  });
  const status = httpStatusLine.exec(lines.shift() ?? '');
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

/** Sensitive command failures discard stdout. Keep only rate-limit metadata from the first HTTP header block. */
const observeJobLogRateLimits = () => {
  const headers = new Map<string, string>();
  let status: number | undefined;
  let remaining = 64;
  const onStdoutLine = (line: string) => {
    if (remaining === 0) return;
    remaining--;
    if (status === undefined) {
      const code = Number(httpStatusLine.exec(line)?.[1]);
      if (code === 403 || code === 429) status = code;
      else remaining = 0;
      return;
    }
    if (line === '' || line === '\r') {
      remaining = 0;
      return;
    }
    const header = /^(retry-after|x-ratelimit-(?:remaining|reset)):[ \t]*([^\r\n]{1,128})\r?$/iu.exec(line);
    if (header) headers.set(EffectString.toLowerCase(header[1]), EffectString.trim(header[2]));
  };
  return {onStdoutLine, response: () => (status === undefined ? undefined : {status, headers})};
};
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
    const reusablePages = EffectArray.filter(previous.pages, page => !needsCheckSummaryRefresh(page));
    const pages = new Map(EffectArray.map(reusablePages, page => [page.key, page]));
    const used = new Set<string>();
    const blockers: {source: string; code: string; retryable: boolean}[] = [];
    let retryAt = started + 60_000;
    let blockedUntil = 0;
    let authenticationFailed = false;
    const recordResponseLimits = (response: Pick<ReturnType<typeof nativeWatchHttpResponse>, 'status' | 'headers'>) => {
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
      const exhausted = seconds('x-ratelimit-remaining') === 0;
      if (exhausted) {
        blockedUntil = Math.max(at + 1000, (seconds('x-ratelimit-reset') ?? at / 1000 + 60) * 1000);
        retryAt = Math.max(retryAt, blockedUntil);
      }
      const rateLimited = response.status === 429 || (response.status === 403 && (retry !== undefined || exhausted));
      if (rateLimited) {
        blockedUntil = Math.max(retryAt, at + 60_000);
        retryAt = blockedUntil;
      }
      return rateLimited;
    };
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
      const rateLimited = recordResponseLimits(response);
      if (response.status === 304 && cached) {
        metrics.notModified++;
        return {response, value: undefined, cached: cached.projection};
      }
      if (response.status === 401) {
        authenticationFailed = true;
        return yield* fail('provider-authentication');
      }
      if (rateLimited) return yield* fail('provider-rate-limit', true);
      if (response.status === 403) return yield* fail('provider-permission');
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
    let jobLogs = previous.jobLogs?.head === before.head ? previous.jobLogs.entries : [];
    const jobFailureLines = (jobId: string, timeoutMs: number) =>
      Effect.gen(function* () {
        metrics.requests++;
        const observed = observeJobLogRateLimits();
        const result = yield* runCommandEffect(
          'gh',
          ['api', '--hostname', 'github.com', '--include', '--method', 'GET', `${base}/actions/jobs/${jobId}/logs`],
          {
            allowFailure: true,
            timeoutMs,
            maxOutputBytes: 8 * 1024 * 1024,
            sensitiveOutput: true,
            onStdoutLine: observed.onStdoutLine,
          },
        ).pipe(Effect.timeout(timeoutMs), Effect.result);
        if (result._tag === 'Failure' || result.success.exitCode !== 0) {
          const response = observed.response();
          if (response) recordResponseLimits(response);
          return undefined;
        }
        const {stdout} = result.success;
        metrics.responseBytes += Buffer.byteLength(stdout);
        const response = yield* Effect.option(Effect.try(() => nativeWatchHttpResponse(stdout)));
        if (Effect2.Option.isNone(response)) return undefined;
        recordResponseLimits(response.value);
        if (response.value.status !== 200) return undefined;
        return nativeWatchFailureLines(response.value.body);
      });
    /** Unreadable logs never fail the checks source. Keep a separate record of attempts that actually ran. */
    const enrichFailedChecks = (items: readonly NativeWatchEntity[]) =>
      Effect.gen(function* () {
        const priorReads = new Map(EffectArray.map(jobLogs, read => [read.id, read]));
        const reads = new Map<string, JobLogRead>();
        const pendingReads: {
          readonly item: NativeWatchEntity;
          readonly retry: boolean;
        }[] = [];
        for (const item of items) {
          if (item.kind !== 'ci_error' || !isActionsJob(item) || !item.summary) continue;
          const prior = priorReads.get(item.id);
          const retained = prior?.version === item.version ? prior : undefined;
          if (retained) reads.set(item.id, retained);
          if (retained?.detail === undefined) pendingReads.push({item, retry: retained !== undefined});
        }
        // Read unread logs before spending the budget on retries.
        const ordered = [
          ...EffectArray.filter(pendingReads, read => !read.retry),
          ...EffectArray.filter(pendingReads, read => read.retry),
        ];
        let consecutiveFailures = 0;
        const deadline = Math.min(now() + summaryLogBudgetMs, started + summaryLogLatestMs);
        for (const {item, retry} of EffectArray.take(ordered, summaryLogChecks)) {
          const at = now();
          const remaining = deadline - at;
          if (
            authenticationFailed ||
            at < blockedUntil ||
            remaining <= 0 ||
            consecutiveFailures >= summaryLogFailureLimit
          )
            break;
          const lines = yield* jobFailureLines(item.id, remaining);
          consecutiveFailures = lines === undefined ? consecutiveFailures + 1 : 0;
          reads.set(item.id, {
            id: item.id,
            version: item.version,
            ...(lines === undefined && !retry
              ? {}
              : {
                  detail: lines?.length
                    ? EffectString.slice(0, summaryLimit)(EffectArray.join(lines, summaryDetailSeparator))
                    : null,
                }),
          });
        }
        jobLogs = [...reads.values()];
        return EffectArray.map(items, item => {
          const detail = reads.get(item.id)?.detail;
          return detail && item.summary
            ? {
                ...item,
                summary: EffectString.slice(0, summaryLimit)(item.summary + summaryDetailSeparator + detail),
                hasJobLogDetails: true as const,
              }
            : item;
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
          for (let page = 1; page <= 101; page++) {
            if (page === 101) return yield* fail('provider-pagination-limit');
            const query =
              endpoint + (Effect2.pipe(endpoint, EffectString.includes('?')) ? '&' : '?') + `per_page=100&page=${page}`;
            const key = source + ':' + (source === 'checks' || source === 'statuses' ? before.head + ':' : '') + page;
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
    // Complete the canonical reads and verify the head before optional log work.
    const checks = EffectArray.findFirstIndex(verifiedSources, source => source.source === 'checks');
    if (before.head === after.head && Effect2.Option.isSome(checks)) {
      const index = checks.value;
      const source = verifiedSources[index];
      if (source.complete) verifiedSources[index] = {...source, items: yield* enrichFailedChecks(source.items)};
    }
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
      cache: {
        pages: EffectArray.filter([...pages.values()], page => used.has(page.key)).slice(-402),
        ...(jobLogs.length ? {jobLogs: {head: before.head, entries: jobLogs}} : {}),
      },
      metrics,
      retryAt,
      blockers,
    } satisfies NativeWatchProviderResult;
  },
  Effect.timeout('60 seconds'),
  Effect.catchIf(Cause.isTimeoutError, () => Effect.fail(fail('provider-sweep-timeout', true))),
);
