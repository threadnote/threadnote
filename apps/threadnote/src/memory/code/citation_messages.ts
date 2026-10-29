import {Array as EffectArray} from 'effect';
import type {DeferredCodeAnchorWriteRequest} from '../deferred/code_anchor.js';

export function deferredCodeAnchorStoredMessage(memoryUri: string, request: DeferredCodeAnchorWriteRequest): string {
  if (request.recovery.recovery === 'retry-capture') {
    return EffectArray.join(
      [
        `Stored memory without finalized code citations: ${memoryUri}`,
        `${request.codeRefs.length} code reference(s) are pending in the private local outbox.`,
        'Retry citation finalization after the graph writer is available; Threadnote does not schedule indexing for writer contention.',
        'If the intent remains pending, run `threadnote finalize-code-refs` as a repair fallback.',
      ],
      ' ',
    );
  }
  const preparation = request.recovery.preparation;
  const prepare =
    preparation.target === 'callerCwd'
      ? `Run \`${preparation.command}\` from the cited repository.`
      : `Run \`${preparation.command} ${preparation.arguments[0]}\`.`;
  return EffectArray.join(
    [
      `Stored memory without finalized code citations: ${memoryUri}`,
      `${request.codeRefs.length} code reference(s) are pending in the private local outbox.`,
      prepare,
      preparation.target === 'callerCwd'
        ? 'Threadnote retries automatically after graph indexing and on the next code-linked Context Brief.'
        : 'Threadnote retries automatically after Workset preparation.',
      'If the intent remains pending, run `threadnote finalize-code-refs` as a repair fallback.',
    ],
    ' ',
  );
}
