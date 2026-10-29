import {describe, expect, it} from 'vitest';
import {ResourceNotFound} from '@threadnote/store/resource-store';
import {memoryReadErrorResult} from '@threadnote/threadnote/mcp/server/memory_read_recovery';
import {MemoryPointerNotFound} from '@threadnote/memory/relocation';
import {readAnonymousTelemetryDiagnostic} from '@threadnote/threadnote/telemetry/diagnostic';

describe('MCP memory-read recovery', () => {
  it('projects one identical actionable object for content- and structured-first clients', () => {
    const uri = 'threadnote://user/test-user/memories/durable/projects/threadnote/moved-contract.md';
    const result = memoryReadErrorResult(
      {user: 'test-user'},
      MemoryPointerNotFound.make({message: `Memory resource does not exist: ${uri}`, uri}),
    );
    const text = result.content[0]?.type === 'text' ? result.content[0].text : undefined;

    expect(result.isError).toBe(true);
    expect(JSON.parse(text ?? '')).toEqual(result.structuredContent);
    expect(result.structuredContent).toMatchObject({
      nextAction: {
        arguments: {query: 'moved-contract'},
        tool: 'recall_context',
      },
      recoveryAction: 'recall-canonical-uri',
      requestedUri: uri,
    });
    expect(readAnonymousTelemetryDiagnostic(result)).toEqual({errorType: 'MemoryPointerNotFound'});
  });

  it('does not project relocation recovery for an exact-read mutation probe', () => {
    const uri = 'threadnote://user/test-user/memories/durable/projects/threadnote/missing-source.md';
    const result = memoryReadErrorResult(
      {user: 'test-user'},
      ResourceNotFound.make({message: `Resource does not exist: ${uri}`, uri}),
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toEqual([{type: 'text', text: `Resource does not exist: ${uri}`}]);
    expect(readAnonymousTelemetryDiagnostic(result)).toEqual({errorType: 'ResourceNotFound'});
  });
});
