import {Schema} from 'effect';
import {MemoryCodeCitationCaptureError} from '@threadnote/context/citation/capture';
import type {DeferredCodeAnchorFinalizeItemV1} from './code_anchor.js';

/** Project private capture failures into bounded model-facing recovery without echoing locators. */
export function deferredCodeAnchorCaptureFailureItem(
  error: unknown,
  memoryUri: string,
): DeferredCodeAnchorFinalizeItemV1 | undefined {
  if (!Schema.is(MemoryCodeCitationCaptureError)(error)) return undefined;
  if (error.recovery !== undefined) {
    if (error.recovery.recovery === 'retry-capture') {
      return {
        code: error.recovery.code,
        memoryUri,
        reason: 'graph-writer-busy',
        recoveryAction: 'retry-capture',
        retryable: true,
        state: 'pending',
      };
    }
    return {
      code: error.recovery.code,
      memoryUri,
      reason: 'exact-current-graph-unavailable',
      recoveryAction: 'prepare-current-graph',
      retryable: true,
      state: 'pending',
    };
  }
  if (error.failureCode === 'outside-project-graph') {
    return {
      code: error.failureCode,
      memoryUri,
      reason:
        'At least one requested code reference is outside the selected project graph; replace this memory with code references admitted by that graph.',
      recoveryAction: 'replace-memory-code-refs',
      retryable: false,
      state: 'failed',
    };
  }
  if (error.failureCode !== 'code-reference-unresolved') return undefined;
  return {
    code: error.failureCode,
    memoryUri,
    reason:
      'At least one requested code reference is absent from the exact-current graph; replace this memory with corrected graph-indexed codeRefs.',
    recoveryAction: 'replace-memory-code-refs',
    retryable: false,
    state: 'failed',
  };
}
