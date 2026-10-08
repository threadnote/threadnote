import {Data} from 'effect';
import {applyScrubber, credentialScrubberBlocker, redactSensitiveText} from '@threadnote/platform/scrubber';

export type SlackErrorCode =
  | 'invalid-input'
  | 'missing-credential'
  | 'authentication-rejected'
  | 'access-rejected'
  | 'scope-mismatch'
  | 'contract-invalid'
  | 'quota-rejected'
  | 'budget-exhausted'
  | 'deadline-exceeded'
  | 'response-too-large'
  | 'transport-rejected'
  | 'not-found';

/** No provider body, query, credential, URL or nested cause belongs in an error. */
export class SlackPilotError extends Data.TaggedError('SlackPilotError')<{
  readonly code: SlackErrorCode;
  readonly retryAfterSeconds?: number;
}> {}

export function fail(code: SlackErrorCode): never {
  throw new SlackPilotError({code});
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function id(value: unknown, prefix: string): value is string {
  return typeof value === 'string' && new RegExp(`^[${prefix}][A-Z0-9]{5,31}$`).test(value);
}

export function timestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,12}\.\d{1,6}$/.test(value);
}

/** Preserve Slack's microsecond identity without floating-point conversion. */
export function compareTimestamps(a: string, b: string): number {
  const key = (value: string) => {
    const [seconds, fraction] = value.split('.');
    return `${seconds.padStart(12, '0')}${fraction.padEnd(6, '0')}`;
  };
  const left = key(a);
  const right = key(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface SlackPilotInput {
  readonly project: string;
  readonly teamId: string;
  readonly userId: string;
  readonly channelIds: readonly string[];
  readonly question: string;
  readonly keywords: string;
}

function query(value: unknown): value is string {
  // This pilot accepts plain questions/keywords; Slack filter syntax is compiled internally.
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    Buffer.byteLength(value) <= 512 &&
    !/[\p{Cc}\p{Cf}:<>"()|\\]/u.test(value) &&
    !/\bOR\b/i.test(value) &&
    credentialScrubberBlocker(value) === undefined
  );
}

export function parsePilotInput(value: unknown): SlackPilotInput {
  if (
    !record(value) ||
    typeof value.project !== 'string' ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.project) ||
    !id(value.teamId, 'T') ||
    !id(value.userId, 'UW') ||
    !Array.isArray(value.channelIds) ||
    value.channelIds.length < 1 ||
    value.channelIds.length > 3 ||
    !value.channelIds.every(channel => id(channel, 'C')) ||
    new Set(value.channelIds).size !== value.channelIds.length ||
    !query(value.question) ||
    !query(value.keywords)
  )
    return fail('invalid-input');
  return Object.freeze({
    project: value.project,
    teamId: value.teamId,
    userId: value.userId,
    channelIds: Object.freeze([...value.channelIds]),
    question: value.question.trim(),
    keywords: value.keywords.trim(),
  });
}

export interface SlackLiveMessage {
  readonly ts: string;
  readonly authorId: string;
  readonly text: string;
  readonly textTruncated: boolean;
  readonly textRedacted: boolean;
}

export interface SlackLiveCard {
  readonly channelId: string;
  readonly messageTs: string;
  readonly rootTs?: string;
  readonly permalink: string;
  readonly coverage: 'search-excerpt' | 'partial-thread' | 'complete-thread';
  readonly messages: readonly SlackLiveMessage[];
}

export function message(ts: unknown, author: unknown, text: unknown): SlackLiveMessage {
  if (!timestamp(ts) || !id(author, 'UWB') || typeof text !== 'string') return fail('contract-invalid');
  const redacted = redactSensitiveText(text);
  const scrubbed = applyScrubber(redacted, {redact: true});
  if (scrubbed.blocker !== undefined) return fail('contract-invalid');
  const cleaned = scrubbed.cleaned.replace(/[\p{Cc}\p{Cf}]/gu, ' ');
  return {
    ts,
    authorId: author,
    text: cleaned.slice(0, 8_000),
    textTruncated: cleaned.length > 8_000,
    textRedacted: redacted !== text,
  };
}

export function cursor(value: Record<string, unknown>): string | undefined {
  const metadata = value.response_metadata;
  if (metadata === undefined) return undefined;
  if (!record(metadata)) return fail('contract-invalid');
  const next = metadata.next_cursor;
  if (next === undefined || next === '') return undefined;
  if (typeof next !== 'string' || Buffer.byteLength(next) > 512 || /[\p{Cc}]/u.test(next))
    return fail('contract-invalid');
  return next;
}

export function assertScope(value: Record<string, unknown>, input: SlackPilotInput, channel: string): void {
  if (
    (value.team_id !== undefined && value.team_id !== input.teamId) ||
    (value.team !== undefined && value.team !== input.teamId) ||
    (value.channel_id !== undefined && value.channel_id !== channel) ||
    (value.channel !== undefined && value.channel !== channel)
  )
    fail('scope-mismatch');
}

export function checkedPermalink(value: unknown, channel: string, ts: string): string {
  if (typeof value !== 'string' || value.length > 2_048) return fail('contract-invalid');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail('contract-invalid');
  }
  if (
    url.protocol !== 'https:' ||
    !/^[a-z0-9-]+\.slack\.com$/.test(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    url.pathname !== `/archives/${channel}/p${ts.replace('.', '')}`
  )
    return fail('contract-invalid');
  for (const [key, item] of url.searchParams) {
    if ((key !== 'thread_ts' && key !== 'cid') || (key === 'thread_ts' ? !timestamp(item) : item !== channel))
      return fail('contract-invalid');
  }
  return url.href;
}
