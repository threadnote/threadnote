import {uriSegment} from '@threadnote/workspace/manifest';
export const MEMORY_RECALL_EMPTY_GAP = 'memory-recall-no-active-durable-or-handoff';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {MemoryRecord} from '@threadnote/memory/document';
import {isMemoryId} from '@threadnote/memory/identity-alias';

import type {
  ContextBriefFreshness,
  ContextBriefMemoryCandidateV1,
  ContextBriefMemoryActionCardV1,
  ContextBriefContinuationCardV1,
  ContextBriefMemoryRetrievalV1,
  ContextBriefPreciseEvidenceStatus,
  ContextBriefSnapshotV1,
} from './types.js';

const MEMORY_EXCERPT_BYTES = 240;
const CONTINUATION_FIELD_BYTES = {
  anchors: 320,
  attempted: 384,
  avoidRepeat: 256,
  blockers: 192,
  decisions: 512,
  graphQuery: 256,
  graphQuestion: 384,
  observations: 512,
  invariants: 320,
  nextStep: 384,
  rationale: 384,
  risks: 192,
  task: 192,
  unresolved: 384,
  verification: 512,
} as const;

const CONTINUATION_ELLIPSIS = '…';

const CONTINUATION_ELLIPSIS_BYTES = 3;

const RESUME_ALIGNMENT_STOP_WORDS = new Set([
  'active',
  'and',
  'continue',
  'continuation',
  'current',
  'for',
  'from',
  'handoff',
  'implementation',
  'implement',
  'into',
  'its',
  'next',
  'of',
  'on',
  'resume',
  'status',
  'step',
  'take',
  'task',
  'the',
  'this',
  'to',
  'while',
  'with',
  'work',
]);

const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

const CONTENT_HASH = /^[0-9a-f]{64}$/u;

const NODE_ID = /^cgs_(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/u;

export interface ContextBriefPreciseCodeEvidenceV1 {
  readonly contentHash: string;
  readonly nodeId?: string;
  readonly path: string;
  readonly repositoryId: string;
  readonly sourceCommit: string;
}

export interface ContextBriefPreciseCodeObservationV1 {
  readonly contentHash?: string;
  readonly exists: boolean;
  readonly nodeId?: string;
  readonly path?: string;
  readonly repositoryId: string;
  readonly snapshotCommit: string;
}

/** Pure classification boundary shared by citation validation and focused tests. */
export function validateContextBriefPreciseCodeEvidence(input: {
  readonly evidence: ContextBriefPreciseCodeEvidenceV1;
  readonly observation?: ContextBriefPreciseCodeObservationV1;
}): ContextBriefPreciseEvidenceStatus {
  const evidence = parsePreciseEvidence(input.evidence);
  if (input.observation === undefined) return 'unknown';
  const observation = parsePreciseObservation(input.observation);
  if (observation.repositoryId !== evidence.repositoryId) return 'unknown';
  if (!observation.exists) return 'deleted';
  if (observation.contentHash === undefined) return 'unknown';
  if (observation.contentHash !== evidence.contentHash) return 'changed';
  if (observation.path === undefined) return 'unknown';
  if (observation.path !== evidence.path) return 'relocated';
  if (evidence.nodeId !== undefined) {
    if (observation.nodeId === undefined) return 'unknown';
    if (observation.nodeId !== evidence.nodeId) return 'relocated';
  }
  return 'exact';
}

/** Precise cited bytes supersede commit-only freshness; unknown evidence never guesses. */
export function reconcileContextBriefMemoryFreshness(
  coarse: ContextBriefFreshness,
  precise: ContextBriefPreciseEvidenceStatus,
): ContextBriefFreshness {
  switch (precise) {
    case 'changed':
    case 'deleted':
      return 'stale';
    case 'unknown':
      return 'unknown';
    case 'exact':
    case 'relocated':
      return 'fresh';
  }
}

/** Coarse freshness is intentionally unknown unless exactly one ready repository snapshot resolved. */
export function classifyMemoryFreshness(
  sourceCommit: string | undefined,
  resolvedSnapshots: readonly ContextBriefSnapshotV1[],
): ContextBriefFreshness {
  if (sourceCommit === undefined || !COMMIT.test(sourceCommit) || resolvedSnapshots.length !== 1) return 'unknown';
  const snapshot = resolvedSnapshots[0];
  if (snapshot.dirty || snapshot.freshness !== 'fresh') return 'unknown';
  return snapshot.commit === sourceCommit ? 'fresh' : 'stale';
}

/** Only explicit single-line sections are promoted; arbitrary memory prose stays in the full read. */
export function parseMemoryActionCard(body: string): ContextBriefMemoryActionCardV1 | undefined {
  const fields = new Map<string, string>();
  let fence: MarkdownFence | undefined;
  for (const line of body.split(/\r?\n/gu).slice(0, 80)) {
    const fenceLine = parseMarkdownFenceLine(line);
    if (fence !== undefined) {
      if (fenceLine !== undefined && closesMarkdownFence(fence, fenceLine)) fence = undefined;
      continue;
    }
    if (fenceLine !== undefined && opensMarkdownFence(fenceLine)) {
      fence = {marker: fenceLine.marker, length: fenceLine.length};
      continue;
    }
    const match = /^\s{0,3}(?:#{1,3}\s*)?(Applies to|Invariant|Avoid|Verify):\s*(.+?)\s*$/iu.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    if (fields.has(key)) continue;
    const value = match[2].replace(/\s+/gu, ' ').trim();
    if (
      value &&
      ![...value].some(character => {
        const code = character.codePointAt(0) ?? 0;
        return code < 32 || code === 127;
      })
    )
      fields.set(key, utf8Prefix(value, 96));
  }
  const appliesTo = fields.get('applies to');
  const invariant = fields.get('invariant');
  if (!appliesTo || !invariant) return undefined;
  return {
    appliesTo,
    invariant,
    ...(fields.get('avoid') === undefined ? {} : {avoid: fields.get('avoid')}),
    ...(fields.get('verify') === undefined ? {} : {verify: fields.get('verify')}),
  };
}

/** Explicitly distinguish bounded inverse-search abstention from evidence of no backlink. */
export function contextBriefCodeLinkRecallGaps(
  complete: boolean,
  candidateCount: number,
  truncatedSelectorCount: number,
): readonly string[] {
  return stableUnique([
    ...(complete ? [] : ['code-anchors-unresolved']),
    ...(truncatedSelectorCount > 0 ? ['code-anchor-recall-truncated'] : []),
    ...(candidateCount === 0 ? ['code-anchor-recall-no-active-memory'] : []),
  ]);
}

/** @internal Restore requested-ref ordinals after unresolved anchors are omitted from the reverse lookup. */
export function mapContextBriefCodeLinkMatches(
  matches: readonly {
    readonly anchorOrdinal: number;
    readonly citationId: string;
    readonly matchKind: NonNullable<ContextBriefMemoryCandidateV1['codeLinkMatches']>[number]['matchKind'];
    readonly uri: string;
  }[],
  resolvedAnchors: readonly {
    readonly anchorNodeId?: string;
    readonly anchorOrdinal: number;
    readonly anchorPath: string;
  }[],
): ReadonlyMap<string, NonNullable<ContextBriefMemoryCandidateV1['codeLinkMatches']>> {
  const matchesByUri = new Map<string, NonNullable<ContextBriefMemoryCandidateV1['codeLinkMatches']>>();
  const seen = new Set<string>();
  for (const match of matches) {
    const anchor = resolvedAnchors[match.anchorOrdinal];
    if (anchor === undefined) continue;
    const identity = `${match.uri}\u0000${anchor.anchorOrdinal}\u0000${match.citationId}\u0000${match.matchKind}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const uriMatches = matchesByUri.get(match.uri) ?? [];
    matchesByUri.set(match.uri, [
      ...uriMatches,
      {
        ...(anchor.anchorNodeId === undefined ? {} : {anchorNodeId: anchor.anchorNodeId}),
        anchorOrdinal: anchor.anchorOrdinal,
        anchorPath: anchor.anchorPath,
        citationId: match.citationId,
        matchKind: match.matchKind,
      },
    ]);
  }
  for (const [uri, uriMatches] of matchesByUri) {
    matchesByUri.set(
      uri,
      [...uriMatches].sort(
        (left, right) =>
          left.anchorOrdinal - right.anchorOrdinal ||
          contextBriefCodeLinkMatchPriority(left.matchKind) - contextBriefCodeLinkMatchPriority(right.matchKind) ||
          compareText(left.citationId, right.citationId),
      ),
    );
  }
  return matchesByUri;
}

function contextBriefCodeLinkMatchPriority(
  matchKind: NonNullable<ContextBriefMemoryCandidateV1['codeLinkMatches']>[number]['matchKind'],
): number {
  switch (matchKind) {
    case 'symbol-node':
      return 0;
    case 'symbol-locator':
      return 1;
    case 'file-path':
      return 2;
    case 'file-content':
      return 3;
  }
}

export function unavailableContextBriefMemoryEvidence(
  gap = 'memory-recall-unavailable',
): ContextBriefMemoryRetrievalV1 {
  return {
    candidates: [],
    consideredCandidates: 0,
    gaps: [gap],
    trust: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
  };
}

export function unavailableContextBriefCodeLinkedMemoryEvidence(
  requested: number,
  gap = 'code-anchor-recall-unavailable',
  resolvedOrdinals: readonly number[] = [],
): ContextBriefMemoryRetrievalV1 {
  const unresolvedOrdinals = unresolvedContextBriefCodeAnchorOrdinals(requested, resolvedOrdinals);
  return {
    codeAnchorCoverage: {
      complete: unresolvedOrdinals.length === 0,
      matchedMemories: 0,
      requested,
      resolved: requested - unresolvedOrdinals.length,
      ...(unresolvedOrdinals.length === 0 ? {} : {unresolvedOrdinals}),
    },
    candidates: [],
    consideredCandidates: 0,
    gaps: [gap],
    trust: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
  };
}

/** Preserve successful anchor resolution when inverse recall or canonical reads abstain. */
export function unavailableContextBriefCodeLinkedMemoryEvidenceAfterCapture(
  requested: number,
  resolvedOrdinals: readonly number[],
  gap: string,
  additionalGaps: readonly string[] = [],
): ContextBriefMemoryRetrievalV1 {
  const evidence = unavailableContextBriefCodeLinkedMemoryEvidence(requested, gap, resolvedOrdinals);
  return {
    ...evidence,
    gaps: stableUnique([
      ...evidence.gaps,
      ...additionalGaps,
      ...(evidence.codeAnchorCoverage?.complete === false ? ['code-anchors-unresolved'] : []),
    ]),
  };
}

/** Return a deterministic, privacy-safe complement of resolved request positions. */
export function unresolvedContextBriefCodeAnchorOrdinals(
  requested: number,
  resolvedOrdinals: readonly number[],
): readonly number[] {
  const resolved = new Set(
    resolvedOrdinals.filter(ordinal => Number.isSafeInteger(ordinal) && ordinal >= 0 && ordinal < requested),
  );
  return Array.from({length: requested}, (_, ordinal) => ordinal).filter(ordinal => !resolved.has(ordinal));
}

/** Keep direct citation matches ahead of topical recall without mixing their ranking semantics. */
export function mergeContextBriefMemoryEvidence(
  lexical: ContextBriefMemoryRetrievalV1,
  codeLinked: ContextBriefMemoryRetrievalV1 | undefined,
  candidateLimit: number,
  directCandidateLimit = candidateLimit,
): ContextBriefMemoryRetrievalV1 {
  if (codeLinked === undefined) return lexical;
  const candidates: ContextBriefMemoryCandidateV1[] = [];
  const seen = new Set<string>();
  const lexicalUris = new Set(lexical.candidates.map(candidate => candidate.uri));
  const boundedDirectCandidateLimit = Math.max(0, Math.min(candidateLimit, directCandidateLimit));
  for (const candidate of codeLinked.candidates) {
    if (candidates.length >= boundedDirectCandidateLimit) break;
    if (seen.has(candidate.uri)) continue;
    seen.add(candidate.uri);
    candidates.push({
      ...candidate,
      ...(lexicalUris.has(candidate.uri) ? {lexicallySelected: true as const} : {}),
      rank: candidates.length,
    });
    if (candidates.length >= candidateLimit) break;
  }
  for (const candidate of lexical.candidates) {
    if (candidates.length >= candidateLimit) break;
    if (seen.has(candidate.uri)) continue;
    seen.add(candidate.uri);
    candidates.push({...candidate, rank: candidates.length});
    if (candidates.length >= candidateLimit) break;
  }
  const lexicalGaps =
    candidates.length === 0 ? lexical.gaps : lexical.gaps.filter(gap => gap !== MEMORY_RECALL_EMPTY_GAP);
  return {
    ...(codeLinked.codeAnchorCoverage === undefined ? {} : {codeAnchorCoverage: codeLinked.codeAnchorCoverage}),
    candidates,
    consideredCandidates: lexical.consideredCandidates + codeLinked.consideredCandidates,
    gaps: stableUnique([...lexicalGaps, ...codeLinked.gaps]),
    trust: lexical.trust,
  };
}

/** Restrict code backlinks to the current user's canonical memory namespace before SQL bounds apply. */
export function contextBriefMemoryUriScope(user: string): string {
  return `threadnote://user/${uriSegment(user)}/memories`;
}

export function contextBriefMemoryRecordIsEligible(record: MemoryRecord | undefined): record is MemoryRecord {
  return (
    record !== undefined &&
    record.metadata.status === 'active' &&
    (record.metadata.kind === 'durable' || record.metadata.kind === 'handoff')
  );
}

export function contextBriefMemoryCandidate(
  record: MemoryRecord,
  rank: number,
  codeLinkMatches: ContextBriefMemoryCandidateV1['codeLinkMatches'],
  memoryIdentityResolvable = true,
): ContextBriefMemoryCandidateV1 {
  if (record.metadata.kind !== 'durable' && record.metadata.kind !== 'handoff') {
    throw new Error('Context Brief memory candidate must be durable or handoff.');
  }
  const sourceCommit = boundedSourceCommit(record.metadata.sourceCommit);
  const citationIds = new Set((record.metadata.codeCitations ?? []).map(citation => citation.id));
  const currentCodeLinkMatches = codeLinkMatches?.filter(match => citationIds.has(match.citationId));
  const actionCard = record.metadata.kind === 'durable' ? parseMemoryActionCard(record.body) : undefined;
  const continuationCard =
    record.metadata.kind === 'handoff' ? parseContextBriefContinuationCard(record.body) : undefined;
  return {
    ...(actionCard === undefined ? {} : {actionCard}),
    ...(continuationCard === undefined ? {} : {continuationCard}),
    ...(record.metadata.authority === undefined ? {} : {authority: record.metadata.authority}),
    citationErrorCount: record.metadata.citationErrors?.length ?? 0,
    codeCitations: record.metadata.codeCitations ?? [],
    ...(currentCodeLinkMatches === undefined || currentCodeLinkMatches.length === 0
      ? {}
      : {codeLinkMatches: currentCodeLinkMatches}),
    excerpt:
      record.metadata.kind === 'handoff'
        ? handoffEvidenceExcerpt(record.body, continuationCard)
        : memoryEvidenceExcerpt(record.body),
    kind: record.metadata.kind,
    ...(memoryIdentityResolvable && record.metadata.memoryId !== undefined && isMemoryId(record.metadata.memoryId)
      ? {memoryId: record.metadata.memoryId}
      : {}),
    ...(record.metadata.project === undefined ? {} : {project: record.metadata.project}),
    rank,
    ...(sourceCommit === undefined ? {} : {sourceCommit}),
    ...(record.metadata.topic === undefined ? {} : {topic: record.metadata.topic}),
    ...(record.metadata.trust === undefined ? {} : {trust: record.metadata.trust}),
    uri: record.uri,
  };
}

/** Rank explicit continuation identity against the requested resume task without inspecting arbitrary body prose. */
export function contextBriefResumeTaskAlignmentScore(
  task: string,
  candidate: Pick<ContextBriefMemoryCandidateV1, 'continuationCard' | 'topic'>,
): number {
  const query = resumeAlignmentTerms(task);
  const fields = [
    {terms: resumeAlignmentTerms(candidate.topic ?? ''), weight: 3},
    {terms: resumeAlignmentTerms(candidate.continuationCard?.task ?? ''), weight: 2},
  ];
  const matchedWords = new Set<string>();
  let matchedPhrases = 0;
  let score = 0;
  for (const field of fields) {
    for (const word of field.terms.words) {
      if (!query.words.has(word)) continue;
      matchedWords.add(word);
      score += field.weight;
    }
    for (const phrase of field.terms.phrases) {
      if (!query.phrases.has(phrase)) continue;
      matchedPhrases += 1;
      score += field.weight * 3;
    }
  }
  return matchedPhrases > 0 || matchedWords.size >= 2 ? score : 0;
}

function resumeAlignmentTerms(value: string): {
  readonly phrases: ReadonlySet<string>;
  readonly words: ReadonlySet<string>;
} {
  const orderedWords = (
    value
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).filter(word => word.length >= 3 && !RESUME_ALIGNMENT_STOP_WORDS.has(word));
  return {
    phrases: new Set(orderedWords.slice(1).map((word, index) => `${orderedWords[index]}\u0000${word}`)),
    words: new Set(orderedWords),
  };
}

export function memoryEvidenceExcerpt(body: string): string {
  const evidence = body
    .split(/\r?\n/gu)
    .map(line => line.replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/u, '').trim())
    .filter(line => line && !line.startsWith('```'))
    .slice(0, 3)
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return utf8Prefix(evidence, MEMORY_EXCERPT_BYTES);
}

/** Select only explicit handoff workflow fields; local paths and raw diffs stay out of the brief. */
export function handoffEvidenceExcerpt(
  body: string,
  parsedCard: ContextBriefContinuationCardV1 | undefined = parseContextBriefContinuationCard(body),
): string {
  const card = parsedCard;
  if (card === undefined) return memoryEvidenceExcerpt(body);
  return utf8Prefix(
    [
      card.task === undefined ? undefined : `task: ${card.task}`,
      card.decisions === undefined ? undefined : `decisions: ${card.decisions}`,
      card.graphQuestion === undefined ? undefined : `graph_question: ${card.graphQuestion}`,
      card.graphQuery === undefined ? undefined : `graph_query: ${card.graphQuery}`,
      card.observations === undefined ? undefined : `observed: ${card.observations}`,
      card.anchors === undefined ? undefined : `anchors: ${card.anchors}`,
      card.attempted === undefined ? undefined : `attempted: ${card.attempted}`,
      card.invariants === undefined ? undefined : `invariants: ${card.invariants}`,
      card.rationale === undefined ? undefined : `rationale: ${card.rationale}`,
      card.verification === undefined ? undefined : `verification: ${card.verification}`,
      card.unresolved === undefined ? undefined : `unresolved: ${card.unresolved}`,
      card.avoidRepeat === undefined ? undefined : `avoid_repeat: ${card.avoidRepeat}`,
      card.blockers === undefined ? undefined : `blockers: ${card.blockers}`,
      card.risks === undefined ? undefined : `risks: ${card.risks}`,
      card.nextStep === undefined ? undefined : `next_step: ${card.nextStep}`,
    ]
      .filter((value): value is string => value !== undefined)
      .join(' '),
    MEMORY_EXCERPT_BYTES,
  );
}

/** Deterministic Markdown projection; fenced code is evidence-free and aliases collapse into stable fields. */
export function parseContextBriefContinuationCard(body: string): ContextBriefContinuationCardV1 | undefined {
  const values = new Map<keyof ContextBriefContinuationCardV1, CappedContinuationValue>();
  let fence: MarkdownFence | undefined;
  let current: keyof ContextBriefContinuationCardV1 | undefined;
  for (const rawLine of body.split(/\r?\n/gu)) {
    const fenceLine = parseMarkdownFenceLine(rawLine);
    if (fence !== undefined) {
      if (fenceLine !== undefined && closesMarkdownFence(fence, fenceLine)) fence = undefined;
      continue;
    }
    if (fenceLine !== undefined && opensMarkdownFence(fenceLine)) {
      fence = {marker: fenceLine.marker, length: fenceLine.length};
      continue;
    }
    const match = rawLine.match(
      /^\s{0,3}(?:#{1,6}\s*)?(task|decisions|graph_query|graph query|graph_question|graph question|observed|observations|findings|anchors|attempted|tried|avoid_repeat|avoid repeat|constraints|invariants|rationale|verification|untested_invariant|untested invariant|unresolved|unknowns|blockers|risks|next_step|next step)\s*:\s*(.*)$/iu,
    );
    if (match !== null) {
      const key = continuationKey(match[1]);
      current = key;
      const value = compactContinuationText(match[2]);
      if (value !== '') appendContinuationValue(values, key, value);
      continue;
    }
    const value = compactContinuationText(rawLine.replace(/^\s*[-*+]\s+/u, ''));
    if (current !== undefined && value !== '') appendContinuationValue(values, current, value);
  }
  const card = Object.fromEntries(
    [...values.entries()]
      .map(([key, value]) => [key, continuationValueText(value)])
      .filter(([, value]) => value !== ''),
  ) as ContextBriefContinuationCardV1;
  return Object.keys(card).length === 0 ? undefined : card;
}

interface MarkdownFence {
  readonly length: number;
  readonly marker: string;
}

interface MarkdownFenceLine extends MarkdownFence {
  readonly suffix: string;
}

interface CappedContinuationValue {
  readonly byteLength: number;
  readonly text: string;
  readonly truncated: boolean;
}

/** Match CommonMark-style fences, including nested block quote and list prefixes. */
function parseMarkdownFenceLine(line: string): MarkdownFenceLine | undefined {
  const match = /^ {0,3}(?:(?:>|[-+*]|\d+[.)])[ \t]+)*(`{3,}|~{3,})(.*)$/u.exec(line);
  return match === null ? undefined : {length: match[1].length, marker: match[1][0], suffix: match[2]};
}

function closesMarkdownFence(fence: MarkdownFence, line: MarkdownFenceLine): boolean {
  return line.marker === fence.marker && line.length >= fence.length && line.suffix.trim() === '';
}

function opensMarkdownFence(line: MarkdownFenceLine): boolean {
  return line.marker === '~' || !line.suffix.includes('`');
}

/** Keep continuation capture linear in input size while preserving the visible UTF-8 budget. */
function appendContinuationValue(
  values: Map<keyof ContextBriefContinuationCardV1, CappedContinuationValue>,
  key: keyof ContextBriefContinuationCardV1,
  value: string,
): void {
  const limit = CONTINUATION_FIELD_BYTES[key];
  const current = values.get(key);
  if (current?.truncated) return;
  let text = current?.text ?? '';
  let byteLength = current?.byteLength ?? 0;
  for (const character of `${text === '' ? '' : ' '}${value}`) {
    const characterBytes = utf8CharacterBytes(character);
    if (byteLength + characterBytes > limit) {
      const truncated = utf8PrefixWithoutEllipsis(text, limit - CONTINUATION_ELLIPSIS_BYTES);
      values.set(key, {
        byteLength: utf8ByteLength(truncated),
        text: truncated,
        truncated: true,
      });
      return;
    }
    text += character;
    byteLength += characterBytes;
  }
  values.set(key, {byteLength, text, truncated: false});
}

function continuationValueText(value: CappedContinuationValue): string {
  return value.truncated ? `${value.text}${CONTINUATION_ELLIPSIS}` : value.text;
}

function utf8CharacterBytes(character: string): number {
  const code = character.codePointAt(0) ?? 0;
  return code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
}

function utf8ByteLength(value: string): number {
  let byteLength = 0;
  for (const character of value) byteLength += utf8CharacterBytes(character);
  return byteLength;
}

function continuationKey(value: string): keyof ContextBriefContinuationCardV1 {
  switch (value.toLowerCase().replace(/\s+/gu, '_')) {
    case 'constraints':
    case 'invariants':
      return 'invariants';
    case 'graph_query':
      return 'graphQuery';
    case 'graph_question':
      return 'graphQuestion';
    case 'observed':
    case 'findings':
    case 'observations':
      return 'observations';
    case 'tried':
    case 'attempted':
      return 'attempted';
    case 'unknowns':
    case 'untested_invariant':
    case 'unresolved':
      return 'unresolved';
    case 'avoid_repeat':
      return 'avoidRepeat';
    case 'next_step':
      return 'nextStep';
    default:
      return value.toLowerCase() as Exclude<keyof ContextBriefContinuationCardV1, 'invariants' | 'nextStep'>;
  }
}

function compactContinuationText(value: string): string {
  return value
    .replace(/(?:^|\s)(?:\/[\w.~-]+){2,}/gu, ' [path omitted]')
    .replace(/\s+/gu, ' ')
    .trim();
}

function parsePreciseEvidence(value: ContextBriefPreciseCodeEvidenceV1): ContextBriefPreciseCodeEvidenceV1 {
  exactKeys(value, ['contentHash', 'nodeId', 'path', 'repositoryId', 'sourceCommit'], 'precise evidence');
  if (!CONTENT_HASH.test(value.contentHash)) throw invalid('contentHash');
  if (value.nodeId !== undefined && !NODE_ID.test(value.nodeId)) throw invalid('nodeId');
  repositoryPath(value.path);
  if (!CONTENT_HASH.test(value.repositoryId)) throw invalid('repositoryId');
  if (!COMMIT.test(value.sourceCommit)) throw invalid('sourceCommit');
  return value;
}

function parsePreciseObservation(value: ContextBriefPreciseCodeObservationV1): ContextBriefPreciseCodeObservationV1 {
  exactKeys(
    value,
    ['contentHash', 'exists', 'nodeId', 'path', 'repositoryId', 'snapshotCommit'],
    'precise observation',
  );
  if (value.contentHash !== undefined && !CONTENT_HASH.test(value.contentHash)) throw invalid('observed contentHash');
  if (typeof value.exists !== 'boolean') throw invalid('exists');
  if (value.nodeId !== undefined && !NODE_ID.test(value.nodeId)) throw invalid('observed nodeId');
  if (value.path !== undefined) repositoryPath(value.path);
  if (!CONTENT_HASH.test(value.repositoryId)) throw invalid('observed repositoryId');
  if (!COMMIT.test(value.snapshotCommit)) throw invalid('snapshotCommit');
  return value;
}

function exactKeys(value: object, allowed: readonly string[], label: string): void {
  const keys = Object.keys(value);
  const extras = keys.filter(key => !allowed.includes(key));
  if (extras.length > 0) throw new Error(`Invalid Context Brief ${label}: unsupported field ${extras.sort()[0]}.`);
}

function repositoryPath(value: string): void {
  if (
    !value ||
    new TextEncoder().encode(value).byteLength > 4_096 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').some(segment => !segment || segment === '.' || segment === '..')
  ) {
    throw invalid('repository-relative path');
  }
}

function boundedSourceCommit(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.normalize('NFKC').trim();
  return normalized && new TextEncoder().encode(normalized).byteLength <= 128 ? normalized : undefined;
}

function utf8Prefix(value: string, maximumBytes: number): string {
  if (new TextEncoder().encode(value).byteLength <= maximumBytes) return value;
  return `${utf8PrefixWithoutEllipsis(value, maximumBytes - CONTINUATION_ELLIPSIS_BYTES)}${CONTINUATION_ELLIPSIS}`;
}

function utf8PrefixWithoutEllipsis(value: string, maximumBytes: number): string {
  let output = '';
  let byteLength = 0;
  for (const character of value) {
    const characterBytes = utf8CharacterBytes(character);
    if (byteLength + characterBytes > maximumBytes) break;
    output += character;
    byteLength += characterBytes;
  }
  return output;
}

export function stableUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(field: string): Error {
  return new Error(`Invalid Context Brief precise code evidence ${field}.`);
}

/** Stable identity helper for future structured-evidence receipts. */
export function contextBriefPreciseEvidenceId(evidence: ContextBriefPreciseCodeEvidenceV1): string {
  const value = parsePreciseEvidence(evidence);
  return `cbpe_${sha256HexSync(
    `${value.repositoryId}\u0000${value.sourceCommit}\u0000${value.path}\u0000${value.nodeId ?? ''}\u0000${value.contentHash}`,
  ).slice(0, 24)}`;
}
