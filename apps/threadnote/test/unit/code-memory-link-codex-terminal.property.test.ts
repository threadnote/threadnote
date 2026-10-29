import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  assertCodeMemoryLinkTurnProgress,
  summarizeCodeMemoryLinkCodexEvents,
} from '../../../../scripts/code-memory-link-app-server-client.js';
import {
  CODE_MEMORY_LINK_CODEX_TERMINAL_KINDS,
  CodeMemoryLinkCodexTerminalError,
  createCodeMemoryLinkCodexTerminalReceipt,
  formatCodeMemoryLinkCodexTerminalReceipt,
  parseCodeMemoryLinkCodexTerminalReceipt,
} from '../../../../scripts/code-memory-link-codex-terminal.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('Code Memory Link Codex terminal receipts', () => {
  it('round-trips every closed privacy-safe terminal class and rejects tampering', () => {
    fc.assert(
      fc.property(fc.constantFrom(...CODE_MEMORY_LINK_CODEX_TERMINAL_KINDS), kind => {
        const marker = formatCodeMemoryLinkCodexTerminalReceipt(
          CodeMemoryLinkCodexTerminalError.of(kind, 'private diagnostic text must not be retained'),
        );
        expect(marker).not.toContain('private diagnostic text');
        expect(parseCodeMemoryLinkCodexTerminalReceipt(`${marker}\n`)).toEqual(
          createCodeMemoryLinkCodexTerminalReceipt(kind),
        );
        expect(
          parseCodeMemoryLinkCodexTerminalReceipt(
            Effect.pipe(marker, EffectString.replace(/"diagnosticHash":"[0-9a-f]/u, '"diagnosticHash":"z')),
          ),
        ).toBeNull();
      }),
      {numRuns: 32},
    );
  });

  it('admits the exact sealed budget and rejects any provider overrun even after a file change', () => {
    fc.assert(
      fc.property(fc.integer({min: 2, max: 64}), fc.integer({min: 2_000, max: 512_000}), (stepBudget, tokenBudget) => {
        const taskBudget = {steps: stepBudget, tokens: tokenBudget};
        expect(() => assertCodeMemoryLinkTurnProgress(usageEvents(stepBudget, tokenBudget), taskBudget)).not.toThrow();
        expect(() => assertCodeMemoryLinkTurnProgress(usageEvents(stepBudget + 1, tokenBudget), taskBudget)).toThrow(
          /inference-step budget/u,
        );
        expect(() => assertCodeMemoryLinkTurnProgress(usageEvents(stepBudget, tokenBudget + 1), taskBudget)).toThrow(
          /provider token budget/u,
        );
        expect(() =>
          assertCodeMemoryLinkTurnProgress(
            [...fileChangeStarted(), ...usageEvents(stepBudget, tokenBudget + 1)],
            taskBudget,
          ),
        ).toThrow(/provider token budget/u);
      }),
      {numRuns: 64},
    );
  });

  it('summarizes only closed event classes and aggregate usage', () => {
    fc.assert(
      fc.property(
        fc.uuid().map(value => `private-${value}`),
        privateText => {
          const events = [
            {method: 'item/started', params: {item: {content: privateText, type: 'reasoning'}}},
            {method: 'item/completed', params: {item: {command: privateText, type: 'commandExecution'}}},
            {method: 'item/started', params: {item: {tool: 'context_brief', type: 'mcpToolCall'}}},
            ...usageEvents(2, 321),
          ];
          const summary = summarizeCodeMemoryLinkCodexEvents(events);
          expect(summary).toEqual({
            completedItems: {
              agentMessage: 0,
              commandExecution: 1,
              fileChange: 0,
              mcpToolCall: 0,
              other: 0,
              plan: 0,
              reasoning: 0,
              userMessage: 0,
            },
            contextBriefCallStarts: 1,
            startedItems: {
              agentMessage: 0,
              commandExecution: 0,
              fileChange: 0,
              mcpToolCall: 1,
              other: 0,
              plan: 0,
              reasoning: 1,
              userMessage: 0,
            },
            totalTaskUsage: {steps: 2, tokens: 321},
            version: 1,
          });
          expect(JSON.stringify(summary)).not.toContain(privateText);
        },
      ),
      {numRuns: 32},
    );
  });
});

function usageEvents(steps: number, totalTokens: number): readonly Record<string, unknown>[] {
  return Array.from({length: steps}, (_, index) => ({
    method: 'thread/tokenUsage/updated',
    params: {
      tokenUsage: {
        total: {totalTokens: Math.ceil((totalTokens * (index + 1)) / steps)},
      },
    },
  }));
}

function fileChangeStarted(): readonly Record<string, unknown>[] {
  return [{method: 'item/started', params: {item: {id: 'edit-1', type: 'fileChange'}}}];
}
