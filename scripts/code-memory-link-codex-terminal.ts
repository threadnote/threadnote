import {Array as EffectArray, Predicate} from 'effect';
import {Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const CODE_MEMORY_LINK_CODEX_TERMINAL_VERSION = 1 as const;
export const CODE_MEMORY_LINK_CODEX_TERMINAL_MARKER = 'THREADNOTE_CODE_MEMORY_LINK_TERMINAL ' as const;

export const CODE_MEMORY_LINK_CODEX_TERMINAL_KINDS = [
  'no-action-budget',
  'preflight-isolation',
  'process-exit',
  'provider-step-budget',
  'provider-terminal',
  'provider-token-budget',
  'turn-timeout',
  'unknown',
] as const;

export type CodeMemoryLinkCodexTerminalKind = (typeof CODE_MEMORY_LINK_CODEX_TERMINAL_KINDS)[number];

export interface CodeMemoryLinkCodexItemCountsV1 {
  readonly agentMessage: number;
  readonly commandExecution: number;
  readonly fileChange: number;
  readonly mcpToolCall: number;
  readonly other: number;
  readonly plan: number;
  readonly reasoning: number;
  readonly userMessage: number;
}

export interface CodeMemoryLinkCodexTerminalDiagnosticsV1 {
  readonly completedItems: CodeMemoryLinkCodexItemCountsV1;
  readonly contextBriefCallStarts: number;
  readonly startedItems: CodeMemoryLinkCodexItemCountsV1;
  readonly totalTaskUsage: {readonly steps: number; readonly tokens: number};
  readonly version: 1;
}

export interface CodeMemoryLinkCodexTerminalReceiptV1 {
  readonly diagnosticHash: string;
  readonly kind: CodeMemoryLinkCodexTerminalKind;
  readonly version: typeof CODE_MEMORY_LINK_CODEX_TERMINAL_VERSION;
}

export class CodeMemoryLinkCodexTerminalError extends Schema.TaggedError<
  CodeMemoryLinkCodexTerminalError,
  {readonly brand: unique symbol}
>()('CodeMemoryLinkCodexTerminalError', {
  diagnostics: Schema.NullOr(Schema.Any),
  kind: Schema.Literals([...CODE_MEMORY_LINK_CODEX_TERMINAL_KINDS]),
  message: Schema.String,
}) {
  static of(
    kind: CodeMemoryLinkCodexTerminalKind,
    message: string,
    diagnostics: CodeMemoryLinkCodexTerminalDiagnosticsV1 | null = null,
  ): CodeMemoryLinkCodexTerminalError {
    return CodeMemoryLinkCodexTerminalError.make({diagnostics, kind, message});
  }
}

export function createCodeMemoryLinkCodexTerminalReceipt(
  kind: CodeMemoryLinkCodexTerminalKind,
): CodeMemoryLinkCodexTerminalReceiptV1 {
  return {
    diagnosticHash: sha256HexSync(`threadnote-code-memory-link-terminal-v1\0${kind}`),
    kind,
    version: CODE_MEMORY_LINK_CODEX_TERMINAL_VERSION,
  };
}

export function classifyCodeMemoryLinkCodexTerminal(error: unknown): CodeMemoryLinkCodexTerminalKind {
  if (Schema.is(CodeMemoryLinkCodexTerminalError)(error)) return error.kind;
  const message = error instanceof Error ? error.message : String(error);
  if (
    /timed out waiting for (?:a )?Codex app-server|timed out waiting for a Codex app-server notification/iu.test(
      message,
    )
  ) {
    return 'turn-timeout';
  }
  if (/exceeded the sealed provider inference-step budget/iu.test(message)) return 'provider-step-budget';
  if (/exceeded the sealed provider token budget|provider-reported usage exceeded/iu.test(message)) {
    return 'provider-token-budget';
  }
  if (/app-server (?:exited early|request failed)|turn did not complete successfully/iu.test(message)) {
    return 'provider-terminal';
  }
  if (
    /approval was rejected|changed the sealed turn settings|Context Brief proxy did not become ready|did not confirm the sealed turn settings|did not enforce|did not honor|unexpected .*server|unexpected .*tool|MCP inventory/iu.test(
      message,
    )
  ) {
    return 'preflight-isolation';
  }
  return 'unknown';
}

export function formatCodeMemoryLinkCodexTerminalReceipt(error: unknown): string {
  const receipt = createCodeMemoryLinkCodexTerminalReceipt(classifyCodeMemoryLinkCodexTerminal(error));
  return `${CODE_MEMORY_LINK_CODEX_TERMINAL_MARKER}${JSON.stringify(receipt)}`;
}

function isCodeMemoryLinkCodexTerminalKind(value: unknown): value is CodeMemoryLinkCodexTerminalKind {
  return typeof value === 'string' && EffectArray.some(CODE_MEMORY_LINK_CODEX_TERMINAL_KINDS, kind => kind === value);
}

export function parseCodeMemoryLinkCodexTerminalReceipt(stderr: string): CodeMemoryLinkCodexTerminalReceiptV1 | null {
  const candidates = EffectArray.filter(
    Effect.pipe(stderr, EffectString.split(/\r?\n/u)),
    __effectArrayValue =>
      !!(line => Effect.pipe(line, EffectString.startsWith(CODE_MEMORY_LINK_CODEX_TERMINAL_MARKER)))(
        __effectArrayValue,
      ),
  );
  if (candidates.length !== 1) return null;
  let value: unknown;
  try {
    value = JSON.parse(
      Effect.pipe(candidates[0], EffectString.slice(CODE_MEMORY_LINK_CODEX_TERMINAL_MARKER.length)),
    ) as unknown;
  } catch {
    return null;
  }
  if (!Predicate.isObject(value)) return null;
  const receipt = value;
  if (
    JSON.stringify(EffectRecord.keys(receipt).sort()) !== JSON.stringify(['diagnosticHash', 'kind', 'version']) ||
    receipt.version !== CODE_MEMORY_LINK_CODEX_TERMINAL_VERSION ||
    typeof receipt.kind !== 'string' ||
    !isCodeMemoryLinkCodexTerminalKind(receipt.kind) ||
    typeof receipt.diagnosticHash !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(receipt.diagnosticHash)
  ) {
    return null;
  }
  const expected = createCodeMemoryLinkCodexTerminalReceipt(receipt.kind);
  return receipt.diagnosticHash === expected.diagnosticHash ? expected : null;
}
