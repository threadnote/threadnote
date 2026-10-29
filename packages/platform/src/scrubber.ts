import {Array as EffectArray} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export interface ScrubberPattern {
  readonly name: string;
  // When present, applyScrubber can replace every match with this string when
  // redact=true. Credentials intentionally omit placeholders so publish/share
  // paths block instead of relying on best-effort redaction.
  readonly placeholder?: string;
  readonly regex: RegExp;
}

export interface ScrubberResult {
  readonly blocker?: string;
  readonly cleaned: string;
  readonly redactions: ReadonlyArray<{readonly count: number; readonly name: string}>;
}

export interface ScrubberOptions {
  readonly additionalPatterns?: readonly ScrubberPattern[];
  readonly redact: boolean;
}

export const SCRUBBER_PATTERNS: readonly ScrubberPattern[] = [
  {name: 'private key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/},
  {name: 'API key (sk-...)', regex: /\bsk-[A-Za-z0-9_-]{16,}/},
  {name: 'GitHub token', regex: /\bgh[pousr]_[A-Za-z0-9_]{16,}/},
  {name: 'GitHub fine-grained PAT', regex: /\bgithub_pat_[A-Za-z0-9_]{20,}/},
  {name: 'GitLab PAT', regex: /\bglpat-[A-Za-z0-9_-]{20,}/},
  {name: 'bearer token', regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i},
  {name: 'basic auth header', regex: /\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}\b/i},
  {name: 'JWT', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/},
  {name: 'AWS access key', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/},
  {name: 'AWS secret access key', regex: /\baws_secret_access_key\s*[:=]\s*["']?[A-Za-z0-9/+=]{35,}["']?/i},
  {name: 'AWS session token', regex: /\baws_session_token\s*[:=]\s*["']?[A-Za-z0-9/+=]{40,}["']?/i},
  {name: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/},
  {name: 'Google OAuth token', regex: /\bya29\.[0-9A-Za-z_-]{20,}/},
  {name: 'Stripe key', regex: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/},
  {name: 'Stripe webhook secret', regex: /\bwhsec_[0-9A-Za-z]{16,}\b/},
  {
    name: 'Discord token',
    regex: /\b(?:mfa\.[A-Za-z0-9_-]{20,}|[MN][A-Za-z0-9_-]{23}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,})\b/,
  },
  {
    name: 'Discord webhook',
    regex: /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/i,
  },
  {name: 'Slack token', regex: /\bx(?:app|ox[abcdeprs])(?:-\d-)?[A-Za-z0-9._-]{10,}/i},
  {name: 'Slack webhook', regex: /https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]+/i},
  {
    name: 'database URI',
    regex: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/[^:\s/@]+:[^@\s]+@[^\s)>"'`,]+/i,
  },
  {name: 'URL basic auth', regex: /\bhttps?:\/\/[^:\s/@]+:[^@\s]+@[^\s)>"'`,]+/i},

  {
    name: 'macOS home path',
    placeholder: '<local-path>',
    // Match a real POSIX macOS home root, not Git-Bash/WSL/Windows path
    // fragments such as /c/Users, /mnt/c/Users, or C:/Users.
    regex: /(?<![A-Za-z0-9_:])\/Users\/[^\s)>"'`,]+/,
  },
  {name: 'linux home path', placeholder: '<local-path>', regex: /\/home\/[^\s)>"'`,]+/},
  {
    name: 'Cursor workspace path',
    placeholder: '<local-path>',
    regex: /(?<![A-Za-z0-9_])\/(?:workspace|workspaces)(?:\/[^\s)>"'`,]+)*/i,
  },
  {
    name: 'temporary path',
    placeholder: '<local-path>',
    regex: /(?<![A-Za-z0-9_])\/(?:private\/)?tmp(?:\/[^\s)>"'`,]+)*/i,
  },
  {
    name: 'Windows absolute path',
    placeholder: '<local-path>',
    regex:
      /(?<![A-Za-z0-9_])(?:[A-Za-z]:[\\/][^\s)>"'`,]+|\/[A-Za-z]\/(?:Users|Documents and Settings)[\\/][^\s)>"'`,]+|\\\\[^\\/\s]+[\\/][^\s)>"'`,]+)/i,
  },
  {
    name: 'WSL mounted drive path',
    placeholder: '<local-path>',
    regex: /(?<![A-Za-z0-9_])\/mnt\/[A-Za-z]\/[^\s)>"'`,]+/i,
  },
];

export function applyScrubber(content: string, options: ScrubberOptions): ScrubberResult {
  let cleaned = content;
  const redactions: Array<{count: number; name: string}> = [];
  const patterns = [...SCRUBBER_PATTERNS, ...(options.additionalPatterns ?? [])];
  for (const pattern of patterns) {
    if (!matchesPattern(pattern.regex, cleaned)) {
      continue;
    }
    if (!pattern.placeholder || !options.redact) {
      return {blocker: pattern.name, cleaned: content, redactions: []};
    }
    const globalRegex = globalize(pattern.regex);
    const matches =
      Effect.pipe(
        cleaned,
        EffectString.match(globalRegex),
        Effect.Option.getOrElse(() => null),
      ) ?? [];
    cleaned = Effect.pipe(cleaned, EffectString.replace(globalRegex, pattern.placeholder));
    redactions.push({count: matches.length, name: pattern.name});
  }
  return {cleaned, redactions};
}

export function scrubberBlocker(content: string): string | undefined {
  return applyScrubber(content, {redact: false}).blocker;
}

export function detectSecretMatches(content: string): readonly string[] {
  const matches: string[] = [];
  for (const pattern of SCRUBBER_PATTERNS) {
    if (matchesPattern(pattern.regex, content)) {
      matches.push(pattern.name);
    }
  }
  return matches;
}

export function credentialScrubberBlocker(content: string): string | undefined {
  for (const pattern of SCRUBBER_PATTERNS) {
    if (pattern.placeholder === undefined && matchesPattern(pattern.regex, content)) {
      return pattern.name;
    }
  }
  return undefined;
}

export function redactSensitiveText(content: string): string {
  let redacted = redactCredentialAssignments(content);
  for (const pattern of SCRUBBER_PATTERNS) {
    const placeholder = pattern.placeholder ?? '<secret>';
    redacted = Effect.pipe(redacted, EffectString.replace(globalize(pattern.regex), placeholder));
  }
  return redacted;
}

function redactCredentialAssignments(content: string): string {
  const output: string[] = [];
  let cursor = 0;
  let search = 0;
  while (search < content.length) {
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native search position argument changes the search origin; Effect String has no position parameter.
    const colon = content.indexOf(':', search);
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native search position argument changes the search origin; Effect String has no position parameter.
    const equals = content.indexOf('=', search);
    const separator = colon < 0 ? equals : equals < 0 ? colon : Math.min(colon, equals);
    if (separator < 0) break;
    let keyEnd = separator;
    while (keyEnd > cursor && isAssignmentWhitespace(content[keyEnd - 1])) keyEnd -= 1;
    let keyStart = keyEnd;
    while (keyStart > cursor && isCredentialKeyCharacter(content[keyStart - 1])) keyStart -= 1;
    const key = Effect.pipe(content, EffectString.slice(keyStart, keyEnd), EffectString.toLowerCase);
    let valueStart = separator + 1;
    while (valueStart < content.length && isAssignmentWhitespace(content[valueStart])) valueStart += 1;
    const valueEnd = sensitiveCredentialKey(key) ? credentialValueEnd(content, valueStart) : undefined;
    if (valueEnd === undefined) {
      search = separator + 1;
      continue;
    }
    output.push(Effect.pipe(content, EffectString.slice(cursor, valueStart)), '[REDACTED]');
    cursor = valueEnd;
    search = valueEnd;
  }
  output.push(Effect.pipe(content, EffectString.slice(cursor)));
  return EffectArray.join(output, '');
}

function sensitiveCredentialKey(key: string): boolean {
  return (
    Effect.pipe(key, EffectString.includes('token')) ||
    Effect.pipe(key, EffectString.includes('secret')) ||
    Effect.pipe(key, EffectString.includes('password')) ||
    Effect.pipe(key, EffectString.includes('apikey')) ||
    Effect.pipe(key, EffectString.includes('api_key')) ||
    Effect.pipe(key, EffectString.includes('api-key')) ||
    Effect.pipe(key, EffectString.includes('authorization')) ||
    Effect.pipe(key, EffectString.includes('credential')) ||
    Effect.pipe(key, EffectString.includes('session'))
  );
}

function credentialValueEnd(content: string, start: number): number | undefined {
  if (start >= content.length || isAssignmentWhitespace(content[start])) return undefined;
  const quote = content[start];
  if (quote === '"' || quote === "'") {
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native search position argument changes the search origin; Effect String has no position parameter.
    const closing = content.indexOf(quote, start + 1);
    if (closing > start + 1) return closing + 1;
  }
  if (
    Effect.pipe(content, __effectPipeInput => {
      const __effectPipeStage0 = Effect.pipe(__effectPipeInput, EffectString.slice(start, start + 'Bearer'.length));
      const __effectPipeStage1 = Effect.pipe(__effectPipeStage0, EffectString.toLowerCase);
      return __effectPipeStage1;
    }) === 'bearer'
  ) {
    let tokenStart = start + 'Bearer'.length;
    if (isAssignmentWhitespace(content[tokenStart])) {
      while (tokenStart < content.length && isAssignmentWhitespace(content[tokenStart])) tokenStart += 1;
      let tokenEnd = tokenStart;
      while (
        tokenEnd < content.length &&
        !isAssignmentWhitespace(content[tokenEnd]) &&
        content[tokenEnd] !== '"' &&
        content[tokenEnd] !== "'"
      ) {
        tokenEnd += 1;
      }
      if (tokenEnd > tokenStart) return tokenEnd;
    }
  }
  let end = start;
  while (end < content.length && !isAssignmentWhitespace(content[end])) end += 1;
  return end > start ? end : undefined;
}

function isCredentialKeyCharacter(value: string | undefined): boolean {
  if (!value) return false;
  const code = Effect.pipe(
    value,
    EffectString.charCodeAt(0),
    Effect.Option.getOrElse(() => NaN),
  );
  return (
    value === '_' ||
    value === '.' ||
    value === '-' ||
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

function isAssignmentWhitespace(value: string | undefined): boolean {
  return value === ' ' || value === '\t' || value === '\r' || value === '\n' || value === '\v' || value === '\f';
}

const globalPatterns = new WeakMap<RegExp, {readonly source: string; readonly flags: string; readonly regex: RegExp}>();
const MAXIMUM_CACHED_PATTERN_CODE_UNITS = 64 * 1_024;

function globalize(regex: RegExp): RegExp {
  // Patterns are public and may be recompiled in place. Observe both inputs
  // on every use, and keep the stateful matching clone private.
  const flags = regex.flags;
  const source = regex.source;
  const cached = globalPatterns.get(regex);
  if (cached?.source === source && cached.flags === flags) {
    cached.regex.lastIndex = 0;
    return cached.regex;
  }
  const globalRegex = new RegExp(source, Effect.pipe(flags, EffectString.includes('g')) ? flags : `${flags}g`);
  if (source.length <= MAXIMUM_CACHED_PATTERN_CODE_UNITS)
    globalPatterns.set(regex, {source, flags, regex: globalRegex});
  else globalPatterns.delete(regex);
  return globalRegex;
}

function matchesPattern(regex: RegExp, content: string): boolean {
  return new RegExp(regex.source, regex.flags).test(content);
}
