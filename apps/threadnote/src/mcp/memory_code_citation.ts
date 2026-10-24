import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {Effect, Schema} from 'effect';
import {captureMemoryCodeCitations, MemoryCodeCitationCaptureError} from '@threadnote/context/citation/capture';
import {mcpErrorResult} from './server/common.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';

export function captureMemoryCodeCitationsForMcp(
  config: RuntimeConfig,
  input: {readonly callerCwd: string; readonly project?: string; readonly refs: readonly string[]},
  operation: string,
) {
  if (input.refs.length === 0) {
    return Effect.succeed({citations: [] as const, ok: true as const});
  }
  return captureMemoryCodeCitations(config, {...input, writerWaitTimeoutMilliseconds: 0}).pipe(
    Effect.match({
      onFailure: error => ({
        error: memoryCodeCitationCaptureErrorResult(error, operation),
        failure: error,
        ok: false as const,
      }),
      onSuccess: citations => ({citations, ok: true as const}),
    }),
  );
}

function memoryCodeCitationCaptureErrorResult(error: unknown, operation: string): CallToolResult {
  const result = mcpErrorResult(error);
  if (!Schema.is(MemoryCodeCitationCaptureError)(error) || error.recovery === undefined) return result;
  const recovery = error.recovery;
  if (recovery.recovery === 'retry-capture') {
    result.content = [
      {
        type: 'text',
        text: [
          error.message,
          'No memory was written.',
          `Retry the same ${operation} request unchanged after the graph writer is available.`,
        ].join(' '),
      },
    ];
    result.structuredContent = {
      code: recovery.code,
      graph: recovery.observedGraph,
      indexingStarted: false,
      operation,
      recovery: {action: 'retry-capture', retry: 'same-request'},
      retryCondition: 'after-writer-available',
      retryable: true,
      state: 'blocked',
      type: 'memory-code-citation-write-recovery',
      version: 1,
      writeApplied: false,
    };
    return result;
  }
  const preparation = recovery.preparation;
  result.content = [
    {
      type: 'text',
      text: [
        error.message,
        'No memory was written.',
        `After preparation reports current ready evidence, retry the same ${operation} request unchanged.`,
      ].join(' '),
    },
  ];
  result.structuredContent = {
    code: recovery.code,
    graph: recovery.observedGraph,
    indexingStarted: recovery.indexingStarted,
    operation,
    recovery: {
      action: preparation.action,
      arguments: preparation.arguments,
      command: preparation.command,
      retry: 'same-request',
      runFrom: preparation.target === 'callerCwd' ? 'callerCwd' : 'any-directory',
      target: preparation.target,
    },
    retryCondition: recovery.retryCondition,
    retryable: recovery.retryable,
    state: 'blocked',
    type: 'memory-code-citation-write-recovery',
    version: 1,
    writeApplied: false,
  };
  return result;
}
