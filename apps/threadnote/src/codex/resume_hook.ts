import {Clock, Console, Crypto, DateTime, Effect, FileSystem, Option, Path, Result} from 'effect';
import {compileContextBriefRuntimeProjection} from '../context_brief/index.js';
import {CODEX_RESUME_ADDITIONAL_CONTEXT_LIMIT} from './hooks.js';
import {THREADNOTE_CODEX_RESUME_PRELOAD_ENV} from '../constants.js';
import {readHookPayload} from '../hooks.js';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {worktreeBuildRequestState} from '@threadnote/graph/inventory';
import {readCanonicalMutationGeneration} from '@threadnote/store/resource/mutation_generation';
import {sha256Hex} from '@threadnote/platform/digest';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import {isJsonObject} from '../utils.js';
import {
  recordCodexResumePreloadValueEvent,
  type CodexResumeContinuationEvidenceState,
  type CodexResumePreloadOutcome,
} from '../value_report/events.js';
import {
  compactContinuationCard,
  isContextBriefExactCurrentContinuation,
  projectContextBrief,
} from '@threadnote/context/projector';
import {
  CONTEXT_BRIEF_MAXIMUM_ESTIMATED_TOKENS,
  type ContextBriefContinuationCardV1,
  type ContextBriefEvidenceState,
  type ContextBriefGraphCardV1,
  type ContextBriefLogicalMemoryEvidenceV1,
  type ContextBriefLogicalResultV1,
  type ContextBriefResponseFormat,
  type ProjectedContextBriefV1,
} from '@threadnote/context/types';
import {AGENT_RESPONSE_ESTIMATED_BYTES_PER_TOKEN, measureAgentToolResponse} from '@threadnote/protocol/agent-response';
import type {RuntimeConfig} from '@threadnote/workspace/config';

const CODEX_RESUME_HOOK_TIMEOUT = '10 seconds';
const CODEX_RESUME_RECEIPT_VERSION = 1 as const;
const CODEX_RESUME_RECEIPT_MAXIMUM_BYTES = 1_024;
const CODEX_RESUME_IDENTIFIER_MAXIMUM_BYTES = 512;
const CODEX_RESUME_PATH_MAXIMUM_BYTES = 4_096;
const UTF8 = new TextEncoder();
const RECEIPT_LOCK_OPTIONS = {
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 30_000,
  waitTimeoutMilliseconds: 1_000,
} as const;

export interface CodexResumeHookEvent {
  readonly cwd: string;
  readonly hookEventName: 'UserPromptSubmit';
  readonly prompt: string;
  readonly sessionId: string;
  readonly turnId: string;
}

export interface CodexResumeReceiptV1 {
  readonly evidenceGeneration: string;
  readonly evidenceHash: string;
  readonly version: typeof CODEX_RESUME_RECEIPT_VERSION;
}

export type CodexResumeIneligibilityReason =
  | 'empty-delivery'
  | 'graph-incomplete'
  | 'multiple-selected-handoffs'
  | 'no-ranked-handoff'
  | 'no-selected-handoff'
  | 'not-resume-mode'
  | 'rank-zero-missing'
  | 'scope-not-fresh'
  | 'selected-conflict'
  | 'selected-not-exact-current'
  | 'selected-not-retained';

const CODEX_RESUME_PROJECTION_DIAGNOSTIC = Symbol('codex-resume-projection-diagnostic');
type CodexResumeProjectedContextBrief = ProjectedContextBriefV1 & {
  readonly [CODEX_RESUME_PROJECTION_DIAGNOSTIC]?: CodexResumeIneligibilityReason;
};

export type CodexResumeHookResult =
  | {
      readonly continuationEvidenceState: CodexResumeContinuationEvidenceState;
      readonly context: string;
      readonly estimatedTokens: number;
      readonly evidenceState: ContextBriefEvidenceState;
      readonly outputBytes: number;
      readonly outcome: 'injected';
    }
  | {
      readonly continuationEvidenceState?: CodexResumeContinuationEvidenceState;
      readonly diagnosticReason?: CodexResumeIneligibilityReason;
      readonly estimatedTokens: number;
      readonly evidenceState?: ContextBriefEvidenceState;
      readonly outputBytes: number;
      readonly outcome: Exclude<CodexResumePreloadOutcome, 'injected'>;
    };

export interface CodexResumeDecisionDependencies<Requirements = never> {
  readonly compile: (cwd: string, prompt: string) => Effect.Effect<ProjectedContextBriefV1, unknown, Requirements>;
  readonly deliver: (context: string) => Effect.Effect<void, unknown, Requirements>;
  readonly receipt: Effect.Effect<CodexResumeReceiptV1 | undefined, unknown, Requirements>;
  readonly writeReceipt: (receipt: CodexResumeReceiptV1) => Effect.Effect<void, unknown, Requirements>;
}

export function parseCodexResumeHookEvent(value: unknown): CodexResumeHookEvent | undefined {
  if (
    !isJsonObject(value) ||
    value.hookEventName !== 'UserPromptSubmit' ||
    !validBoundedText(value.cwd, CODEX_RESUME_PATH_MAXIMUM_BYTES) ||
    !validBoundedText(value.prompt, 4_096) ||
    !validBoundedText(value.sessionId, CODEX_RESUME_IDENTIFIER_MAXIMUM_BYTES) ||
    !validBoundedText(value.turnId, CODEX_RESUME_IDENTIFIER_MAXIMUM_BYTES)
  ) {
    return undefined;
  }
  return {
    cwd: value.cwd,
    hookEventName: 'UserPromptSubmit',
    prompt: value.prompt,
    sessionId: value.sessionId,
    turnId: value.turnId,
  };
}

export function codexResumePreloadDisabled(environment: Readonly<Record<string, string | undefined>>): boolean {
  const value = environment[THREADNOTE_CODEX_RESUME_PRELOAD_ENV]?.trim().toLowerCase();
  return value === '0' || value === 'false' || value === 'off';
}

export function promptCarriesActiveHandoff(prompt: string): boolean {
  return prompt.includes('threadnote://') && prompt.includes('/memories/handoffs/active/');
}

export function contextBriefIsEligibleForCodexResume(projected: ProjectedContextBriefV1): boolean {
  return codexResumeIneligibilityReason(projected) === undefined;
}

export function codexResumeIneligibilityReason(
  projected: ProjectedContextBriefV1,
): CodexResumeIneligibilityReason | undefined {
  const brief = projected.structuredContent;
  const handoff = brief.activeHandoffs[0];
  if (brief.mode !== 'resume') return 'not-resume-mode';
  if (brief.scope.freshness !== 'fresh') return 'scope-not-fresh';
  if (handoff === undefined) return 'no-selected-handoff';
  if (brief.activeHandoffs.length !== 1) return 'multiple-selected-handoffs';
  if (!isContextBriefExactCurrentContinuation(handoff)) return 'selected-not-exact-current';
  return projected.text === '' ? 'empty-delivery' : undefined;
}

export function codexResumeProjectionIneligibilityReason(
  projected: ProjectedContextBriefV1,
): CodexResumeIneligibilityReason | undefined {
  return (projected as CodexResumeProjectedContextBrief)[CODEX_RESUME_PROJECTION_DIAGNOSTIC];
}

export function projectCodexResumePreload(
  logical: ContextBriefLogicalResultV1,
  maximumEstimatedTokens: number,
  _responseFormat: ContextBriefResponseFormat,
): ProjectedContextBriefV1 {
  const deliveryTokenLimit = Math.min(maximumEstimatedTokens, CODEX_RESUME_ADDITIONAL_CONTEXT_LIMIT);
  const ordinary = projectContextBrief(logical, CONTEXT_BRIEF_MAXIMUM_ESTIMATED_TOKENS, 'agent');
  const selection = selectCodexResumeHandoff(logical);
  const projectedHandoff = ordinary.structuredContent.activeHandoffs.find(
    candidate => candidate.uri === selection.handoff?.uri,
  );
  const projectionDiagnostic =
    selection.reason ??
    (selection.handoff !== undefined && projectedHandoff === undefined ? 'selected-not-retained' : undefined);
  const text =
    selection.handoff === undefined || projectedHandoff === undefined
      ? ''
      : renderCodexResumePreloadContext(
          selection.handoff,
          logical.task,
          selectCodexResumeSourceLeads(logical, selection.handoff),
        );
  const structuredContent =
    selection.handoff === undefined || projectedHandoff === undefined
      ? ordinary.structuredContent
      : {
          ...ordinary.structuredContent,
          activeHandoffs: [projectedHandoff],
          coverage: {
            ...ordinary.structuredContent.coverage,
            omissions: {
              ...ordinary.structuredContent.coverage.omissions,
              activeHandoffs: Math.max(0, logical.activeHandoffs.length - 1),
            },
          },
        };
  const projected: CodexResumeProjectedContextBrief = {
    maximumBytes: deliveryTokenLimit * AGENT_RESPONSE_ESTIMATED_BYTES_PER_TOKEN,
    measurement: measureAgentToolResponse({text}),
    structuredContent,
    text,
  };
  if (projectionDiagnostic !== undefined) {
    Object.defineProperty(projected, CODEX_RESUME_PROJECTION_DIAGNOSTIC, {value: projectionDiagnostic});
  }
  return projected;
}

export function decideCodexResumePreload<Requirements>(
  dependencies: CodexResumeDecisionDependencies<Requirements>,
  event: CodexResumeHookEvent,
  evidenceGeneration: string,
): Effect.Effect<CodexResumeHookResult, unknown, Requirements> {
  return Effect.gen(function* () {
    const current = yield* dependencies.receipt;
    if (current?.evidenceGeneration === evidenceGeneration) {
      return emptyResult('already-preloaded');
    }

    const projected = yield* dependencies.compile(event.cwd, event.prompt);
    const evidenceState = projected.structuredContent.evidenceState;
    const continuationEvidenceState = codexResumeContinuationEvidenceState(
      projected.structuredContent.activeHandoffs[0]?.continuationCard,
    );
    const diagnosticReason =
      codexResumeProjectionIneligibilityReason(projected) ?? codexResumeIneligibilityReason(projected);
    if (diagnosticReason !== undefined) {
      return {...emptyResult('ineligible-evidence'), continuationEvidenceState, diagnosticReason, evidenceState};
    }
    const outputBytes = UTF8.encode(projected.text).byteLength;
    if (
      projected.measurement.estimatedTokens > CODEX_RESUME_ADDITIONAL_CONTEXT_LIMIT ||
      outputBytes > projected.maximumBytes
    ) {
      return {
        ...emptyResult('over-limit'),
        continuationEvidenceState,
        estimatedTokens: projected.measurement.estimatedTokens,
        evidenceState,
        outputBytes,
      };
    }
    const evidenceHash = yield* sha256Hex(projected.text);
    yield* dependencies.deliver(projected.text);
    yield* dependencies
      .writeReceipt({evidenceGeneration, evidenceHash, version: CODEX_RESUME_RECEIPT_VERSION})
      .pipe(Effect.ignore);
    return {
      context: projected.text,
      continuationEvidenceState,
      estimatedTokens: projected.measurement.estimatedTokens,
      evidenceState,
      outputBytes,
      outcome: 'injected' as const,
    };
  });
}

export function renderCodexResumeHookOutput(context: string): string {
  return JSON.stringify({
    hookSpecificOutput: {hookEventName: 'UserPromptSubmit', additionalContext: context},
  });
}

export function runCodexResumeHook(config: RuntimeConfig, options: {readonly diagnostic?: boolean} = {}) {
  // UserPromptSubmit must fail open. Every lookup and local receipt operation is
  // bounded; an unavailable preload yields no stdout and never blocks the turn.
  return Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const system = yield* SystemInfo;
    const payload = yield* readHookPayload();
    const event = parseCodexResumeHookEvent(payload);
    let result: CodexResumeHookResult;

    if (codexResumePreloadDisabled(system.environment())) {
      result = emptyResult('disabled');
    } else if (event === undefined) {
      result = emptyResult('invalid-input');
    } else if (promptCarriesActiveHandoff(event.prompt)) {
      result = emptyResult('manual-context');
    } else {
      result = yield* runEligibleCodexResumeHook(config, event).pipe(
        Effect.timeoutOrElse({
          duration: CODEX_RESUME_HOOK_TIMEOUT,
          orElse: () => Effect.succeed(emptyResult('lookup-unavailable')),
        }),
        Effect.orElseSucceed(() => emptyResult('lookup-unavailable')),
      );
    }

    const completedAt = yield* Clock.currentTimeMillis;
    yield* recordCodexResumePreloadValueEvent(config.agentContextHome, {
      durationMilliseconds: Math.max(0, completedAt - startedAt),
      estimatedTokens: result.estimatedTokens,
      ...(result.continuationEvidenceState === undefined
        ? {}
        : {continuationEvidenceState: result.continuationEvidenceState}),
      ...(result.evidenceState === undefined ? {} : {evidenceState: result.evidenceState}),
      outcome: result.outcome,
      outputBytes: result.outputBytes,
      timestamp: DateTime.formatIso(DateTime.makeUnsafe(completedAt)),
    }).pipe(Effect.timeoutOrElse({duration: '250 millis', orElse: () => Effect.void}), Effect.ignore);
    if (options.diagnostic) {
      const detail = result.outcome === 'ineligible-evidence' ? `:${result.diagnosticReason ?? 'unspecified'}` : '';
      yield* Console.error(`threadnote codex-resume-hook: ${result.outcome}${detail}`);
    }
  }).pipe(
    Effect.catchCause(() =>
      options.diagnostic ? Console.error('threadnote codex-resume-hook: lookup-unavailable') : Effect.void,
    ),
  );
}

const runEligibleCodexResumeHook = Effect.fn('hooks.runCodexResumeEligible')(function* (
  config: RuntimeConfig,
  event: CodexResumeHookEvent,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  if (!pathService.isAbsolute(event.cwd)) return emptyResult('invalid-input');
  const repository = yield* resolveRepositoryIdentity(event.cwd);
  const worktree = yield* worktreeBuildRequestState(repository);
  const canonicalMutationGeneration = yield* readCanonicalMutationGeneration(
    fs,
    pathService,
    config.agentContextHome,
    config.account,
  );
  const repositoryKey = yield* sha256Hex(`${repository.repositoryId}\n${repository.worktreeId}`);
  const receiptKey = yield* sha256Hex(`${event.sessionId}\n${repositoryKey}`);
  const evidenceGeneration = yield* sha256Hex(
    JSON.stringify({
      canonicalMutationGeneration,
      dirty: worktree.dirty,
      fingerprint: worktree.fingerprint,
      headCommit: repository.headCommit,
    }),
  );
  const receiptPath = codexResumeReceiptPath(pathService, config.agentContextHome, receiptKey);
  const lockPath = pathService.join(config.agentContextHome, 'locks', 'codex-resume-hook', `${receiptKey}.lock`);
  return yield* withExclusiveFileLock(
    fs,
    lockPath,
    RECEIPT_LOCK_OPTIONS,
    decideCodexResumePreload(
      {
        compile: (cwd, prompt) =>
          compileContextBriefRuntimeProjection(
            config,
            {
              budgetTokens: CONTEXT_BRIEF_MAXIMUM_ESTIMATED_TOKENS,
              mode: 'resume',
              responseFormat: 'agent',
              scope: {callerCwd: cwd, kind: 'repository'},
              surface: 'codex-cli',
              task: prompt,
            },
            projectCodexResumePreload,
          ),
        deliver: context => Console.log(renderCodexResumeHookOutput(context)),
        receipt: readCodexResumeReceipt(fs, receiptPath),
        writeReceipt: receipt => writeCodexResumeReceipt(fs, pathService, receiptPath, receipt),
      },
      event,
      evidenceGeneration,
    ),
  );
});

function selectCodexResumeHandoff(
  logical: ContextBriefLogicalResultV1,
):
  | {readonly handoff: ContextBriefLogicalMemoryEvidenceV1; readonly reason?: undefined}
  | {readonly handoff?: undefined; readonly reason: CodexResumeIneligibilityReason} {
  if (logical.mode !== 'resume') return {reason: 'not-resume-mode'};
  if (logical.scope.freshness !== 'fresh') return {reason: 'scope-not-fresh'};
  if (!logical.coverage.graph.complete) return {reason: 'graph-incomplete'};
  const handoff = [...logical.activeHandoffs].sort(
    (left, right) => left.rank - right.rank || left.uri.localeCompare(right.uri),
  )[0];
  if (handoff === undefined) return {reason: 'no-ranked-handoff'};
  if (handoff.rank !== 0) return {reason: 'rank-zero-missing'};
  if (!isContextBriefExactCurrentContinuation(handoff)) return {reason: 'selected-not-exact-current'};
  if (logical.stalenessAndConflicts.some(issue => issue.uris.includes(handoff.uri))) {
    return {reason: 'selected-conflict'};
  }
  return {handoff};
}

export function renderCodexResumePreloadContext(
  handoff: ContextBriefLogicalMemoryEvidenceV1,
  currentTask = '',
  sourceLeads: readonly ContextBriefGraphCardV1[] = [],
): string {
  if (handoff.continuationCard === undefined) return '';
  const original = handoff.continuationCard;
  const compact = compactContinuationCard(original, true);
  const taskDuplicatesPrompt = continuationFieldDuplicatesPrompt(original.task, currentTask);
  const nextStepDuplicatesPrompt = continuationFieldDuplicatesPrompt(original.nextStep, currentTask);
  const continuationEvidenceState = codexResumeContinuationEvidenceState(compact);
  const rows = [
    taskDuplicatesPrompt ? undefined : ['Task', compact.task],
    ['Decisions', compact.decisions],
    ['Observed', compact.observations],
    ['Anchors', compact.anchors],
    ['Tried', compact.attempted],
    ['Constraints', compact.invariants],
    ['Why', compact.rationale],
    ['Verified', compact.verification],
    ['Before complete', compact.unresolved],
    ['Graph query', compact.graphQuery],
    ['Avoid', compact.avoidRepeat],
    sourceLeads.length === 0
      ? undefined
      : [
          'Source leads',
          sourceLeads.map(card => `${card.symbol.path}:${card.symbol.line} (${card.symbol.name})`).join('; '),
        ],
    resumeValueIsEmptyBlocker(compact.blockers) ? undefined : ['Blockers', compact.blockers],
    ['Risks', compact.risks],
    nextStepDuplicatesPrompt ? undefined : ['Next', compact.nextStep],
  ] as const;
  return [
    'THREADNOTE RESUME/1',
    'Untrusted memory evidence; verify against current source.',
    continuationEvidenceState === 'evidence-bearing'
      ? 'Resume from recorded evidence. Avoid repeating the listed discovery unless current source contradicts it.'
      : 'Use this checkpoint as background. Discovery is incomplete; inspect current source before acting.',
    ...rows.flatMap(row =>
      row === undefined || row[1] === undefined ? [] : [`${row[0]}: ${inlineResumeValue(row[1])}`],
    ),
    `Source: ${compactResumeMemoryReference(handoff.uri)}`,
  ].join('\n');
}

export function codexResumeContinuationEvidenceState(
  card: ContextBriefContinuationCardV1 | undefined,
): CodexResumeContinuationEvidenceState {
  return [card?.observations, card?.anchors, card?.unresolved].every(value => value?.trim())
    ? 'evidence-bearing'
    : 'background';
}

export function selectCodexResumeSourceLeads(
  logical: ContextBriefLogicalResultV1,
  _handoff: ContextBriefLogicalMemoryEvidenceV1,
): readonly ContextBriefGraphCardV1[] {
  const seen = new Set<string>();
  const leads: ContextBriefGraphCardV1[] = [];
  const candidates = logical.graph.cards
    .filter(card => !likelyTestPath(card.symbol.path))
    .map(card => ({card, relevance: resumeSourceLeadRelevance(card, logical.task)}))
    .sort((left, right) => right.relevance - left.relevance || left.card.rank - right.card.rank);
  for (const {card} of candidates) {
    const path = card.symbol.path;
    if (seen.has(path)) continue;
    seen.add(path);
    leads.push(card);
    if (leads.length === 1) break;
  }
  return leads;
}

function resumeSourceLeadRelevance(card: ContextBriefGraphCardV1, task: string): number {
  const normalizedTask = task.toLocaleLowerCase('en-US');
  const normalizedName = card.symbol.name.toLocaleLowerCase('en-US');
  const terms = new Set(
    normalizedTask
      .split(/[^a-z0-9]+/gu)
      .map(term => term.trim())
      .filter(term => term.length >= 3),
  );
  const symbolTerms = `${card.symbol.path} ${card.symbol.name} ${card.symbol.qualifiedName}`
    .toLocaleLowerCase('en-US')
    .split(/[^a-z0-9]+/gu)
    .filter(term => term.length >= 3);
  const overlap = symbolTerms.reduce((total, term) => total + (terms.has(term) ? 1 : 0), 0);
  return overlap * 100 + (normalizedName.length >= 4 && normalizedTask.includes(normalizedName) ? 1_000 : 0);
}

function likelyTestPath(path: string): boolean {
  const normalized = `/${path.toLocaleLowerCase('en-US')}`;
  const name = normalized.slice(normalized.lastIndexOf('/') + 1);
  return (
    normalized.includes('/test/') ||
    normalized.includes('/tests/') ||
    name.startsWith('test_') ||
    name.includes('.test.') ||
    name.includes('.spec.') ||
    name.endsWith('_test.py')
  );
}

function continuationFieldDuplicatesPrompt(value: string | undefined, prompt: string): boolean {
  if (value === undefined || prompt === '') return false;
  const normalizedValue = normalizeContinuationText(value);
  const normalizedPrompt = normalizeContinuationText(prompt);
  return (
    normalizedValue === normalizedPrompt ||
    truncatedContinuationPrefixMatches(normalizedValue, normalizedPrompt) ||
    truncatedContinuationPrefixMatches(normalizedPrompt, normalizedValue)
  );
}

function normalizeContinuationText(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

function truncatedContinuationPrefixMatches(candidate: string, complete: string): boolean {
  if (!candidate.endsWith('…')) return false;
  const prefix = candidate.slice(0, -1).trimEnd();
  return prefix.length >= 64 && complete.startsWith(prefix);
}

function resumeValueIsEmptyBlocker(value: string | undefined): boolean {
  return value === undefined || /^(?:none|n\/a|no blockers?)[.!]?$/iu.test(value.trim());
}

function inlineResumeValue(value: string): string {
  return value
    .replace(/[\t\r\n]+/gu, ' ')
    .replace(/\s{2,}/gu, ' ')
    .trim();
}

function compactResumeMemoryReference(uri: string): string {
  return uri.replace(/^threadnote:\/\/user\/[^/]+\//u, '');
}

function codexResumeReceiptPath(path: Path.Path, agentContextHome: string, receiptKey: string): string {
  return path.join(agentContextHome, 'cache', 'codex-resume-hook', 'v1', `${receiptKey}.json`);
}

function readCodexResumeReceipt(
  fs: FileSystem.FileSystem,
  receiptPath: string,
): Effect.Effect<CodexResumeReceiptV1 | undefined, never> {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(receiptPath))) return undefined;
    if (Option.isSome(yield* fs.readLink(receiptPath).pipe(Effect.option))) return undefined;
    const info = yield* fs.stat(receiptPath);
    if (info.type !== 'File' || Number(info.size) > CODEX_RESUME_RECEIPT_MAXIMUM_BYTES) return undefined;
    const raw = yield* fs.readFileString(receiptPath);
    const parsed = Result.try((): unknown => JSON.parse(raw));
    if (Result.isFailure(parsed) || !isJsonObject(parsed.success)) return undefined;
    const value = parsed.success;
    return value.version === CODEX_RESUME_RECEIPT_VERSION &&
      typeof value.evidenceGeneration === 'string' &&
      /^[0-9a-f]{64}$/u.test(value.evidenceGeneration) &&
      typeof value.evidenceHash === 'string' &&
      /^[0-9a-f]{64}$/u.test(value.evidenceHash)
      ? (value as unknown as CodexResumeReceiptV1)
      : undefined;
  }).pipe(Effect.orElseSucceed(() => undefined));
}

function writeCodexResumeReceipt(
  fs: FileSystem.FileSystem,
  pathService: Path.Path,
  receiptPath: string,
  receipt: CodexResumeReceiptV1,
) {
  return Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    yield* fs.makeDirectory(pathService.dirname(receiptPath), {recursive: true, mode: 0o700});
    const temporary = `${receiptPath}.${yield* crypto.randomUUIDv4}.tmp`;
    yield* fs.writeFileString(temporary, `${JSON.stringify(receipt)}\n`, {flag: 'wx', mode: 0o600});
    yield* fs
      .rename(temporary, receiptPath)
      .pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
  });
}

function emptyResult<Outcome extends Exclude<CodexResumePreloadOutcome, 'injected'>>(
  outcome: Outcome,
): {readonly estimatedTokens: 0; readonly outcome: Outcome; readonly outputBytes: 0} {
  return {estimatedTokens: 0, outcome, outputBytes: 0};
}

function validBoundedText(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    !value.includes('\0') &&
    UTF8.encode(value).byteLength <= maximumBytes
  );
}
