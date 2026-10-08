import {sha256HexSync} from '@threadnote/platform/sha256';
import {isIsoDateOrCanonicalIsoInstant, type MemoryRecord} from '@threadnote/memory/document';

export const CONTEXT_HEALTH_SEMANTIC_ANALYZER_VERSION = 2 as const;
export const MAXIMUM_CONTEXT_HEALTH_SEMANTIC_RECORDS = 128 as const;
export const MAXIMUM_CONTEXT_HEALTH_SEMANTIC_CLAIMS = 256 as const;
export const MAXIMUM_CONTEXT_HEALTH_SEMANTIC_CLAIMS_PER_RECORD = 16 as const;
export const MAXIMUM_CONTEXT_HEALTH_SEMANTIC_CONTRADICTIONS = 100 as const;

const MAXIMUM_BODY_CODE_UNITS = 65_536;
const MAXIMUM_CLAIM_CODE_UNITS = 512;
const CONTRADICTION_SIMILARITY_MILLI = 550;
const NEGATION = /\b(?:cannot|disabled|doesn't|do not|must not|never|no|not)\b/iu;
const TOKEN = /[a-z0-9][a-z0-9_.-]{2,}/gu;
const VALUE_ASSERTION = /^(.+?)(?:\s+(must be|required to be|shall be|is)\s+|\s*(<=|>=|=|<|>)\s*)(.+)$/u;
const POLARITY_ASSERTION = /^(.+?) (must|shall|does|do)(?: (not|never))? (.+)$/u;

export type ContextHealthSemanticUnknownReasonV2 =
  | 'body-limit'
  | 'claim-budget'
  | 'claim-limit'
  | 'claim-too-large'
  | 'contradiction-limit'
  | 'no-claims'
  | 'record-limit'
  | 'unsupported-extraction';

export interface ContextHealthSemanticClaimReferenceV2 {
  readonly claimFingerprint: string;
  readonly claimId: string;
  readonly recordUri: string;
  readonly recordContentFingerprint: string;
  readonly text: string;
  /** UTF-16 offsets into the unchanged record body. */
  readonly span: {readonly start: number; readonly end: number};
  readonly context: ContextHealthSemanticContextV2;
  readonly role: 'descriptive' | 'normative' | 'historical';
  readonly extraction: 'numeric-constraint' | 'finite-set' | 'explicit-polarity' | 'unsupported';
  readonly subject?: string;
  readonly property?: string;
  readonly constraint?: SemanticConstraint;
}

export interface ContextHealthSemanticContextV2 {
  readonly headings: readonly string[];
  readonly headingEvidence: readonly {
    readonly text: string;
    readonly span: {readonly start: number; readonly end: number};
  }[];
  readonly project?: string;
  readonly workspaceScope?: string;
  readonly environment?: string;
  readonly validFrom?: string;
  readonly validTo?: string;
}

export type SemanticConstraint =
  | {
      readonly kind: 'numeric';
      readonly dimension: string;
      readonly lower: number | null;
      readonly upper: number | null;
      readonly lowerInclusive: boolean;
      readonly upperInclusive: boolean;
    }
  | {readonly kind: 'set'; readonly values: readonly string[]}
  | {readonly kind: 'polarity'; readonly denied: boolean};

export interface ContextHealthSemanticContradictionV2 {
  readonly basisFingerprint: string;
  readonly contradictionId: string;
  readonly left: ContextHealthSemanticClaimReferenceV2;
  readonly right: ContextHealthSemanticClaimReferenceV2;
  readonly similarityMilli: number;
  readonly classification: 'incompatibility' | 'uncertain-comparison';
  readonly reason: 'incompatible-values' | 'opposite-polarity' | 'policy-conflict' | 'unsupported-interpretation';
  readonly uncertainty: readonly string[];
}

export interface ContextHealthSemanticCompletenessV2 {
  readonly analyzedRecords: number;
  readonly claimsAnalyzed: number;
  readonly supportedClaims: number;
  readonly unsupportedClaims: number;
  readonly coverage: 'bounded-English-extraction';
  readonly contradictionCount: number;
  readonly eligibleRecords: number;
  readonly omittedContradictions: number;
  readonly pairsCompared: number;
  readonly state: 'complete' | 'partial' | 'unavailable';
  readonly unknownReasons: readonly {
    readonly count: number;
    readonly reason: ContextHealthSemanticUnknownReasonV2;
  }[];
  readonly unknownRecords: number;
  readonly version: typeof CONTEXT_HEALTH_SEMANTIC_ANALYZER_VERSION;
}

export interface ContextHealthSemanticAnalysisV2 {
  readonly completeness: ContextHealthSemanticCompletenessV2;
  readonly contradictions: readonly ContextHealthSemanticContradictionV2[];
}

export interface ContextHealthSemanticAnalysisInputV2 {
  readonly project: string;
  readonly records: readonly MemoryRecord[];
}

interface SemanticClaim extends ContextHealthSemanticClaimReferenceV2 {
  readonly basisTokens: readonly string[];
  readonly denied: boolean;
  readonly scopeUncertain: boolean;
}

interface ExtractedClaims {
  readonly claims: readonly SemanticClaim[];
  readonly reasons: readonly ContextHealthSemanticUnknownReasonV2[];
}

/** Deterministic local heuristic. Results are review evidence, never an automatic lifecycle decision. */
export function analyzeContextHealthSemantics(
  input: ContextHealthSemanticAnalysisInputV2,
): ContextHealthSemanticAnalysisV2 {
  const eligible = input.records
    .filter(
      record =>
        record.metadata.kind === 'durable' &&
        record.metadata.status === 'active' &&
        record.metadata.project === input.project,
    )
    .sort(compareRecords);
  const selected = eligible.slice(0, MAXIMUM_CONTEXT_HEALTH_SEMANTIC_RECORDS);
  const unknownByRecord = new Map<string, Set<ContextHealthSemanticUnknownReasonV2>>();
  for (const record of eligible.slice(MAXIMUM_CONTEXT_HEALTH_SEMANTIC_RECORDS)) {
    addUnknown(unknownByRecord, record.uri, 'record-limit');
  }

  const claims: SemanticClaim[] = [];
  let analyzedRecords = 0;
  for (const record of selected) {
    const extracted = extractClaims(record);
    for (const reason of extracted.reasons) addUnknown(unknownByRecord, record.uri, reason);
    const available = Math.max(0, MAXIMUM_CONTEXT_HEALTH_SEMANTIC_CLAIMS - claims.length);
    claims.push(...extracted.claims.slice(0, available));
    if (extracted.claims.length > available) addUnknown(unknownByRecord, record.uri, 'claim-budget');
    if (!unknownByRecord.has(record.uri)) analyzedRecords += 1;
  }
  claims.sort(compareClaims);

  const found: ContextHealthSemanticContradictionV2[] = [];
  let pairsCompared = 0;
  for (let leftIndex = 0; leftIndex < claims.length; leftIndex += 1) {
    const left = claims[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < claims.length; rightIndex += 1) {
      const right = claims[rightIndex];
      if (left.recordUri === right.recordUri) continue;
      pairsCompared += 1;
      const comparison = compareMeaning(left, right);
      if (comparison) found.push(contradiction(left, right, comparison));
    }
  }
  found.sort((left, right) => compareText(left.contradictionId, right.contradictionId));
  const contradictions = found.slice(0, MAXIMUM_CONTEXT_HEALTH_SEMANTIC_CONTRADICTIONS);
  const omittedContradictions = found.length - contradictions.length;
  const unknownReasonCounts = reasonCounts(unknownByRecord);
  if (omittedContradictions > 0) {
    unknownReasonCounts.set('contradiction-limit', omittedContradictions);
  }
  const unknownRecords = unknownByRecord.size;
  const state =
    unknownRecords === 0 && omittedContradictions === 0
      ? 'complete'
      : analyzedRecords === 0 && eligible.length > 0
        ? 'unavailable'
        : 'partial';
  return {
    completeness: {
      analyzedRecords,
      claimsAnalyzed: claims.length,
      supportedClaims: claims.filter(claim => claim.extraction !== 'unsupported').length,
      unsupportedClaims: claims.filter(claim => claim.extraction === 'unsupported').length,
      coverage: 'bounded-English-extraction',
      contradictionCount: found.length,
      eligibleRecords: eligible.length,
      omittedContradictions,
      pairsCompared,
      state,
      unknownReasons: [...unknownReasonCounts]
        .map(([reason, count]) => ({count, reason}))
        .sort((left, right) => compareText(left.reason, right.reason)),
      unknownRecords,
      version: CONTEXT_HEALTH_SEMANTIC_ANALYZER_VERSION,
    },
    contradictions,
  };
}

function extractClaims(record: MemoryRecord): ExtractedClaims {
  const reasons = new Set<ContextHealthSemanticUnknownReasonV2>();
  if (record.body.length > MAXIMUM_BODY_CODE_UNITS) reasons.add('body-limit');
  const body = record.body.slice(0, MAXIMUM_BODY_CODE_UNITS);
  const claims: SemanticClaim[] = [];
  const headings: {text: string; span: {start: number; end: number}; truncated: boolean}[] = [];
  let fenced = false;
  let offset = 0;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/\r$/u, '');
    const lineOffset = offset;
    offset += rawLine.length + 1;
    if (/^\s*(?:```|~~~)/u.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const heading = /^\s*(#{1,6})\s+(.+?)\s*#*$/u.exec(line);
    if (heading) {
      headings.splice(heading[1].length - 1);
      const text = heading[2].slice(0, MAXIMUM_CLAIM_CODE_UNITS);
      const start = lineOffset + line.indexOf(heading[2]);
      const truncated = text.length !== heading[2].length;
      if (truncated) reasons.add('claim-too-large');
      headings[heading[1].length - 1] = {text, span: {start, end: start + text.length}, truncated};
      continue;
    }
    for (const match of line.matchAll(/(?:[^.!?]|\.(?=[0-9]))+(?:[.!?](?=\s|$)|$)/gu)) {
      const sentence = match[0];
      const prefix = /^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)?/u.exec(sentence)?.[0].length ?? 0;
      const text = sentence.slice(prefix).trimEnd();
      if (!text || tokens(text).length < 2) continue;
      if (text.length > MAXIMUM_CLAIM_CODE_UNITS) {
        reasons.add('claim-too-large');
        continue;
      }
      const inheritedEvidence = headings.filter(Boolean);
      const inherited = inheritedEvidence.map(heading => heading.text);
      const contextTruncated = inheritedEvidence.some(heading => heading.truncated);
      const extraction: ParsedClaim = contextTruncated
        ? {role: 'descriptive', extraction: 'unsupported'}
        : parseClaim(text, inherited);
      const {scopeText, ...parsed} = extraction;
      const environment = extractEnvironment(scopeText ?? '', inherited);
      const context: ContextHealthSemanticContextV2 = {
        headings: [...inherited],
        headingEvidence: inheritedEvidence.map(({text, span}) => ({text, span})),
        ...(record.metadata.project === undefined ? {} : {project: record.metadata.project}),
        ...(record.metadata.workspaceScope === undefined ? {} : {workspaceScope: record.metadata.workspaceScope}),
        ...(environment.value === undefined ? {} : {environment: environment.value}),
        ...(record.metadata.validFrom === undefined ? {} : {validFrom: record.metadata.validFrom}),
        ...(record.metadata.validTo === undefined ? {} : {validTo: record.metadata.validTo}),
      };
      if (!parsed.constraint) reasons.add('unsupported-extraction');
      const start = lineOffset + (match.index ?? 0) + prefix;
      const span = {start, end: start + text.length};
      const recordContentFingerprint = sha256HexSync(record.content);
      const claimFingerprint = sha256HexSync(
        JSON.stringify({text, context, span, recordContentFingerprint, ...parsed}),
      );
      claims.push({
        ...parsed,
        context,
        text,
        span,
        recordContentFingerprint,
        claimFingerprint,
        claimId: `tnclaim_${sha256HexSync(`${record.uri}\u0000${claimFingerprint}`).slice(0, 32)}`,
        recordUri: record.uri,
        basisTokens: tokens(withoutNegation(text)),
        denied: NEGATION.test(text),
        scopeUncertain: environment.ambiguous || contextTruncated,
      });
    }
  }
  claims.sort(compareClaims);
  if (claims.length === 0) reasons.add('no-claims');
  if (claims.length > MAXIMUM_CONTEXT_HEALTH_SEMANTIC_CLAIMS_PER_RECORD) reasons.add('claim-limit');
  return {
    claims: claims.slice(0, MAXIMUM_CONTEXT_HEALTH_SEMANTIC_CLAIMS_PER_RECORD),
    reasons: [...reasons].sort(compareText),
  };
}

interface ParsedClaim {
  readonly scopeText?: string;
  readonly role: ContextHealthSemanticClaimReferenceV2['role'];
  readonly extraction: ContextHealthSemanticClaimReferenceV2['extraction'];
  readonly subject?: string;
  readonly property?: string;
  readonly constraint?: SemanticConstraint;
}

function extractEnvironment(text: string, headings: readonly string[]): {value?: string; ambiguous: boolean} {
  const prefix = /^(?:the )?(production|local|staging|development|testing)\b/iu.exec(text.trim());
  const inline = prefix ? [prefix[1].toLowerCase()] : [];
  const inherited = headings.flatMap(environmentWords);
  const values = [...new Set([...inline, ...inherited])];
  if (values.length === 1) return {value: values[0], ambiguous: false};
  if (values.length > 1) return {ambiguous: true};
  if (/\b(?:repo(?:sitory)?[- ]wide|all environments)\b/iu.test([text, ...headings].join(' '))) {
    return {value: '*', ambiguous: false};
  }
  return {ambiguous: false};
}

function environmentWords(value: string): string[] {
  return [...value.toLowerCase().matchAll(/\b(?:production|local|staging|development|testing)\b/gu)].map(
    match => match[0],
  );
}

function parseClaim(text: string, headings: readonly string[]): ParsedClaim {
  const value = text
    .toLowerCase()
    .replace(/[.!?]$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const role =
    /\b(?:history|historical|previous(?:ly)?|formerly)\b/iu.test(headings.join(' ')) ||
    /\b(?:was|were|used to)\b/u.test(value)
      ? 'historical'
      : /\b(?:must|shall|required)\b/u.test(value)
        ? 'normative'
        : 'descriptive';
  const unsupported: ParsedClaim = {role, extraction: 'unsupported'};
  if (
    /\b(?:maybe|approximately|about|usually|sometimes|unless|except|if|when|could|might|may|should|either)\b/u.test(
      value,
    )
  )
    return unsupported;
  const numeric = VALUE_ASSERTION.exec(value);
  if (numeric) {
    const identity = claimIdentity(numeric[1]);
    if (!identity) return unsupported;
    const operator = numeric[2] ?? numeric[3];
    const constraint = parseNumeric(operator, numeric[4]);
    if (constraint) return {...identity, role, extraction: 'numeric-constraint', constraint, scopeText: numeric[1]};
    const set = parseSet(numeric[4], identity.property, operator);
    if (set && !['<', '>', '<=', '>='].includes(operator)) {
      return {...identity, role, extraction: 'finite-set', constraint: set, scopeText: numeric[1]};
    }
    return unsupported;
  }
  const polarity = POLARITY_ASSERTION.exec(value);
  if (polarity) {
    const subject = canonicalSubject(polarity[1]);
    const property = polarity[4];
    if (/^[a-z][a-z -]*$/u.test(subject) && /^[a-z][a-z -]*$/u.test(property)) {
      return {
        role,
        extraction: 'explicit-polarity',
        scopeText: polarity[1],
        subject,
        property,
        constraint: {kind: 'polarity', denied: Boolean(polarity[3])},
      };
    }
  }
  return unsupported;
}

function canonicalSubject(value: string): string {
  return value
    .replace(/\b(?:production|local|staging|development|testing|the|all)\b/gu, '')
    .replace(/\b(?:repo(?:sitory)?[- ]wide|environments)\b/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function claimIdentity(value: string): {subject: string; property: string} | undefined {
  const canonical = canonicalSubject(value);
  if (!/^[a-z][a-z -]*$/u.test(canonical)) return undefined;
  const parts = canonical.split(' ');
  return {subject: parts.slice(0, -1).join(' ') || 'self', property: parts.at(-1)!};
}

const NUMBER = '(?:[0-9]+(?:,[0-9]{3})*(?:\\.[0-9]+)?)';
const UNIT = '(milliseconds?|ms|seconds?|s|minutes?|min|hours?|h|bytes?|kilobytes?|kb|megabytes?|mb)';
const UNIT_FACTORS: Readonly<Record<string, readonly [string, number]>> = {
  millisecond: ['duration-ms', 1],
  milliseconds: ['duration-ms', 1],
  ms: ['duration-ms', 1],
  second: ['duration-ms', 1000],
  seconds: ['duration-ms', 1000],
  s: ['duration-ms', 1000],
  minute: ['duration-ms', 60_000],
  minutes: ['duration-ms', 60_000],
  min: ['duration-ms', 60_000],
  hour: ['duration-ms', 3_600_000],
  hours: ['duration-ms', 3_600_000],
  h: ['duration-ms', 3_600_000],
  byte: ['bytes', 1],
  bytes: ['bytes', 1],
  kilobyte: ['bytes', 1000],
  kilobytes: ['bytes', 1000],
  kb: ['bytes', 1000],
  megabyte: ['bytes', 1_000_000],
  megabytes: ['bytes', 1_000_000],
  mb: ['bytes', 1_000_000],
};

function parseNumeric(operator: string, value: string): SemanticConstraint | undefined {
  const range = new RegExp(`^between (${NUMBER}) and (${NUMBER}) ${UNIT}$`, 'u').exec(value);
  const single = new RegExp(`^(${NUMBER}) ${UNIT}$`, 'u').exec(value);
  if (!range && !single) return undefined;
  const unit = range ? range[3] : single![2];
  const [dimension, factor] = UNIT_FACTORS[unit];
  const normalized = (raw: string) => {
    const [whole, fraction = ''] = raw.replace(/,/gu, '').split('.');
    const numerator = BigInt(whole + fraction) * BigInt(factor);
    if (fraction.length > 12 || numerator > BigInt(Number.MAX_SAFE_INTEGER)) return NaN;
    return Number(numerator) / 10 ** fraction.length;
  };
  const first = normalized(range ? range[1] : single![1]);
  const second = range ? normalized(range[2]) : first;
  if (!Number.isFinite(first) || !Number.isFinite(second) || first > second) return undefined;
  if (range && !['is', '=', 'must be', 'shall be', 'required to be'].includes(operator)) return undefined;
  return {
    kind: 'numeric',
    dimension,
    lower: operator === '<' || operator === '<=' ? null : first,
    upper: operator === '>' || operator === '>=' ? null : second,
    lowerInclusive: operator !== '>',
    upperInclusive: operator !== '<',
  };
}

function parseSet(value: string, property: string, operator: string): SemanticConstraint | undefined {
  const multiple = /^one of \[([a-z][a-z0-9_-]*(?:, ?[a-z][a-z0-9_-]*)+)\]$/u.exec(value);
  if (multiple)
    return {kind: 'set', values: [...new Set(multiple[1].split(',').map(part => part.trim()))].sort(compareText)};
  // Single identifier values intentionally exclude prose, measurements, and inferred synonyms.
  if (
    (operator === '=' || ['engine', 'protocol', 'format', 'mode'].includes(property)) &&
    /^[a-z][a-z0-9_-]*$/u.test(value)
  )
    return {kind: 'set', values: [value]};
  return undefined;
}

interface Comparison {
  readonly reason: ContextHealthSemanticContradictionV2['reason'];
  readonly uncertainty: readonly string[];
  readonly similarityMilli: number;
}

function compareMeaning(left: SemanticClaim, right: SemanticClaim): Comparison | undefined {
  if (left.role === 'historical' || right.role === 'historical') return undefined;
  const uncertainty: string[] = [];
  const a = left.context,
    b = right.context;
  if (left.scopeUncertain || right.scopeUncertain) uncertainty.push('ambiguous-environment');
  else if (a.environment && b.environment) {
    if (a.environment !== '*' && b.environment !== '*' && a.environment !== b.environment) return undefined;
  } else uncertainty.push('unknown-environment');
  const workspace = compareWorkspace(a.workspaceScope, b.workspaceScope);
  if (workspace === 'disjoint') return undefined;
  if (workspace === 'unknown') uncertainty.push('invalid-workspace-scope');
  const validity = compareValidity(a, b);
  if (validity === 'disjoint') return undefined;
  if (validity !== 'overlap') uncertainty.push(validity);
  const similarityMilli = tokenSimilarityMilli(left.basisTokens, right.basisTokens);
  if (!left.constraint || !right.constraint) {
    if (left.denied === right.denied || similarityMilli < CONTRADICTION_SIMILARITY_MILLI) return undefined;
    return {
      reason: 'unsupported-interpretation',
      uncertainty: [...uncertainty, 'unsupported-extraction'].sort(compareText),
      similarityMilli,
    };
  }
  if (left.subject !== right.subject || left.property !== right.property) return undefined;
  const incompatible = constraintsIncompatible(left.constraint, right.constraint);
  if (incompatible === false) return undefined;
  if (incompatible === undefined) uncertainty.push('incomparable-constraints');
  const reason =
    incompatible === undefined
      ? 'unsupported-interpretation'
      : left.role !== right.role
        ? 'policy-conflict'
        : left.constraint.kind === 'polarity' && right.constraint.kind === 'polarity'
          ? 'opposite-polarity'
          : 'incompatible-values';
  return {reason, uncertainty: uncertainty.sort(compareText), similarityMilli};
}

function compareWorkspace(left: string | undefined, right: string | undefined): 'overlap' | 'disjoint' | 'unknown' {
  const valid = (value: string | undefined) =>
    value === undefined ||
    value === '.' ||
    (/^(?:[a-zA-Z0-9_-]+)(?:\/[a-zA-Z0-9_.-]+)*$/u.test(value) && !value.split('/').includes('..'));
  if (!valid(left) || !valid(right)) return 'unknown';
  // MemoryMetadata explicitly defines absent workspaceScope as repo-wide.
  if (left === undefined || right === undefined || left === '.' || right === '.' || left === right) return 'overlap';
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`) ? 'overlap' : 'disjoint';
}

function compareValidity(
  a: ContextHealthSemanticContextV2,
  b: ContextHealthSemanticContextV2,
): 'overlap' | 'disjoint' | 'unknown-validity' | 'invalid-validity' {
  const interval = (context: ContextHealthSemanticContextV2) => {
    const parse = (raw: string | undefined, absent: number) =>
      raw === undefined ? absent : isIsoDateOrCanonicalIsoInstant(raw) ? Date.parse(raw) : NaN;
    return {
      start: parse(context.validFrom, -Infinity),
      end: parse(context.validTo, Infinity),
      known: context.validFrom !== undefined || context.validTo !== undefined,
    };
  };
  const left = interval(a),
    right = interval(b);
  if (
    Number.isNaN(left.start) ||
    Number.isNaN(left.end) ||
    Number.isNaN(right.start) ||
    Number.isNaN(right.end) ||
    left.start >= left.end ||
    right.start >= right.end
  )
    return 'invalid-validity';
  if (left.end <= right.start || right.end <= left.start) return 'disjoint';
  return left.known && right.known ? 'overlap' : 'unknown-validity';
}

function constraintsIncompatible(left: SemanticConstraint, right: SemanticConstraint): boolean | undefined {
  if (left.kind !== right.kind) return undefined;
  if (left.kind === 'polarity' && right.kind === 'polarity') return left.denied !== right.denied;
  if (left.kind === 'set' && right.kind === 'set') return !left.values.some(value => right.values.includes(value));
  if (left.kind === 'numeric' && right.kind === 'numeric') {
    if (left.dimension !== right.dimension) return undefined;
    const separated = (a: typeof left, b: typeof right) =>
      a.upper !== null &&
      b.lower !== null &&
      (a.upper < b.lower || (a.upper === b.lower && !(a.upperInclusive && b.lowerInclusive)));
    return separated(left, right) || separated(right, left);
  }
  return undefined;
}

function contradiction(
  first: SemanticClaim,
  second: SemanticClaim,
  comparison: Comparison,
): ContextHealthSemanticContradictionV2 {
  const [left, right] = compareClaims(first, second) <= 0 ? [first, second] : [second, first];
  const basisFingerprint = sha256HexSync(JSON.stringify({subject: left.subject, property: left.property, comparison}));
  const contradictionId = sha256HexSync(
    ['threadnote-semantic-contradiction-v2', left.claimId, right.claimId, basisFingerprint].join('\u0000'),
  );
  return {
    basisFingerprint,
    contradictionId,
    left: claimReference(left),
    right: claimReference(right),
    similarityMilli: comparison.similarityMilli,
    reason: comparison.reason,
    uncertainty: comparison.uncertainty,
    classification: comparison.uncertainty.length > 0 ? 'uncertain-comparison' : 'incompatibility',
  };
}

function claimReference(claim: SemanticClaim): ContextHealthSemanticClaimReferenceV2 {
  const {basisTokens: _basisTokens, denied: _denied, scopeUncertain: _scopeUncertain, ...reference} = claim;
  return reference;
}

function withoutNegation(value: string): string {
  return value
    .replace(/\bcannot\b/giu, 'can')
    .replace(/\bdisabled\b/giu, 'enabled')
    .replace(/\bdoesn't\b/giu, 'does')
    .replace(/\bdo not\b/giu, 'do')
    .replace(/\bmust not\b/giu, 'must')
    .replace(/\b(?:never|no|not)\b/giu, '');
}

function tokens(value: string): readonly string[] {
  return [...new Set([...value.toLowerCase().matchAll(TOKEN)].map(match => match[0]))].sort(compareText);
}

function tokenSimilarityMilli(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left);
  const intersection = right.filter(token => leftSet.has(token)).length;
  const union = new Set([...left, ...right]).size;
  return Math.round((intersection / union) * 1_000);
}

function addUnknown(
  target: Map<string, Set<ContextHealthSemanticUnknownReasonV2>>,
  uri: string,
  reason: ContextHealthSemanticUnknownReasonV2,
): void {
  const reasons = target.get(uri) ?? new Set();
  reasons.add(reason);
  target.set(uri, reasons);
}

function reasonCounts(
  unknownByRecord: ReadonlyMap<string, ReadonlySet<ContextHealthSemanticUnknownReasonV2>>,
): Map<ContextHealthSemanticUnknownReasonV2, number> {
  const counts = new Map<ContextHealthSemanticUnknownReasonV2, number>();
  for (const reasons of unknownByRecord.values()) {
    for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return counts;
}

function compareRecords(left: MemoryRecord, right: MemoryRecord): number {
  return compareText(left.uri, right.uri);
}

function compareClaims(left: SemanticClaim, right: SemanticClaim): number {
  return compareText(`${left.recordUri}\u0000${left.claimId}`, `${right.recordUri}\u0000${right.claimId}`);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
