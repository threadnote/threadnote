import {TestError} from '@threadnote/testing/test-error';
import {it as effectIt} from '@effect/vitest';
import {Cause, Deferred, Effect, Exit, Fiber, Option, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {McpProtocol, McpSchema} from 'effect/ai';
import {RpcServer} from 'effect/rpc';
import {describe, expect, it, vi} from 'vitest';
import {
  admitMcpProgressToken,
  type EffectMcpServer,
  installCallToolProgressBridge,
  makeMcpCancellationCompatibleProtocol,
  mcpCallToolResultWithTelemetryMetadata,
  makeMcpToolProgress,
  mcpProgressNotificationForCurrentRequest,
  mcpProgressHeartbeatMilliseconds,
  mcpRequestIdKey,
  mcpResourceNotFoundRecoveryErrorData,
  mcpStdioSerialization,
  MCP_PROGRESS_HEARTBEAT_MILLISECONDS,
  MCP_PROGRESS_MESSAGE_MAX_BYTES,
  MCP_PROGRESS_METADATA_KEY,
  MCP_RESOURCE_ERROR_DATA,
  MCP_RESOURCE_NOT_FOUND_ERROR_DATA,
  StdioSingleClientSet,
  makeInitializeInstructionsTransform,
  mcpProgressNotification,
  mcpResourceFailureResult,
  mcpToolFailureResult,
  type McpProgressNotificationPayload,
  withMcpProgressHeartbeat,
} from '@threadnote/threadnote/effect/ai/mcp';
import {memoryReadRecoveryForRequestedUri} from '@threadnote/memory/read/recovery';
import {
  attachAnonymousTelemetryReportedOutcome,
  readAnonymousTelemetryDiagnostic,
  readAnonymousTelemetryReportedOutcome,
} from '@threadnote/threadnote/telemetry/diagnostic';

const initializeResponse = JSON.stringify({
  id: 1,
  jsonrpc: '2.0',
  result: {
    capabilities: {resources: {listChanged: true, subscribe: true}, tools: {}},
    protocolVersion: '2025-06-18',
    serverInfo: {name: 'threadnote', version: '4.0.0'},
  },
});

const repairedInitializeResponse = {
  id: 1,
  jsonrpc: '2.0',
  result: {
    capabilities: {resources: {listChanged: true, subscribe: false}, tools: {}},
    instructions: 'Use Threadnote context.',
    protocolVersion: '2025-06-18',
    serverInfo: {name: 'threadnote', version: '4.0.0'},
  },
};

describe('Effect 4 direct resource error projection', () => {
  it('strips only the exact internal brand and is idempotent after initialization', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.integer(), fc.string()),
        fc.constantFrom(-32_602, -32_603),
        fc.string(),
        (id, code, message) => {
          const transform = makeInitializeInstructionsTransform('Use Threadnote context.');
          transform(initializeResponse);
          const response = JSON.stringify({error: {code, data: MCP_RESOURCE_ERROR_DATA, message}, id, jsonrpc: '2.0'});
          const transformed = transform(response);
          expect(JSON.parse(String(transformed))).toEqual({error: {code, message}, id, jsonrpc: '2.0'});
          expect(transform(transformed)).toBe(transformed);
          const unrelated = JSON.stringify({error: {code, data: {other: true}, message}, id, jsonrpc: '2.0'});
          expect(transform(unrelated)).toBe(unrelated);
        },
      ),
      {numRuns: 50},
    );
  });
});

function encodedResourceNotFoundCause(recovery: unknown, id: number): string {
  return JSON.stringify({
    error: {
      _tag: 'Cause',
      code: 0,
      data: [
        {
          _tag: 'Fail',
          error: {
            _tag: 'InvalidParams',
            code: -32602,
            data: {
              'threadnote.io/memory-read-recovery': recovery,
              'threadnote.io/resource-read-error': 2,
            },
            message: 'Threadnote resource was not found.',
          },
        },
      ],
      message: 'encoded Effect cause',
    },
    id,
    jsonrpc: '2.0',
  });
}

describe('Effect MCP initialization instructions', () => {
  it('parses the string initialize response once and passes later large frames through unchanged', () => {
    const transform = makeInitializeInstructionsTransform('Use Threadnote context.');
    const parse = vi.spyOn(JSON, 'parse');
    const initialized = transform(initializeResponse);
    const largeFrame = JSON.stringify({id: 2, jsonrpc: '2.0', result: {content: 'x'.repeat(2 * 1_024 * 1_024)}});
    const passedThrough = transform(largeFrame);
    const parseCalls = parse.mock.calls.length;
    parse.mockRestore();

    expect(parseCalls).toBe(1);
    expect(passedThrough).toBe(largeFrame);
    expect(typeof initialized).toBe('string');
    expect(JSON.parse(initialized as string)).toEqual(repairedInitializeResponse);
  });

  it('preserves Uint8Array output and identity for later large frames', () => {
    const encoder = new TextEncoder();
    const transform = makeInitializeInstructionsTransform('Use Threadnote context.');
    const initialized = transform(encoder.encode(initializeResponse));
    const largeFrame = encoder.encode(
      JSON.stringify({id: 2, jsonrpc: '2.0', result: {content: 'x'.repeat(2 * 1_024 * 1_024)}}),
    );
    const parse = vi.spyOn(JSON, 'parse');
    const passedThrough = transform(largeFrame);
    const parseCalls = parse.mock.calls.length;
    parse.mockRestore();

    expect(parseCalls).toBe(0);
    expect(passedThrough).toBe(largeFrame);
    expect(initialized).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(new TextDecoder().decode(initialized as Uint8Array))).toEqual(repairedInitializeResponse);
  });

  it('unwraps only Effect RPC envelopes carrying recognized MCP protocol errors', () => {
    const transform = makeInitializeInstructionsTransform('Use Threadnote context.');
    transform(initializeResponse);
    const invalidParams = JSON.stringify({
      error: {
        _tag: 'Cause',
        code: -32602,
        data: [
          {
            _tag: 'Fail',
            error: {
              _tag: 'InvalidParams',
              code: -32602,
              data: MCP_RESOURCE_ERROR_DATA,
              message: 'Expected a canonical threadnote:// URI.',
            },
          },
        ],
        message: 'encoded Effect cause',
      },
      id: 2,
      jsonrpc: '2.0',
    });
    const resourceNotFound = JSON.stringify({
      error: {
        _tag: 'Cause',
        code: 0,
        data: [
          {
            _tag: 'Fail',
            error: {
              _tag: 'InvalidParams',
              code: -32602,
              data: MCP_RESOURCE_NOT_FOUND_ERROR_DATA,
              message: 'Threadnote resource was not found.',
            },
          },
        ],
        message: 'encoded Effect cause',
      },
      id: 3,
      jsonrpc: '2.0',
    });
    const recovery = memoryReadRecoveryForRequestedUri(
      'threadnote://user/test-user/memories/durable/projects/threadnote/moved-contract.md',
    );
    expect(recovery).toBeDefined();
    if (recovery === undefined) throw TestError.make({message: 'Expected canonical memory recovery.'});
    const resourceNotFoundWithRecovery = JSON.stringify({
      error: {
        _tag: 'Cause',
        code: 0,
        data: [
          {
            _tag: 'Fail',
            error: {
              _tag: 'InvalidParams',
              code: -32602,
              data: mcpResourceNotFoundRecoveryErrorData(recovery),
              message: 'Threadnote resource was not found.',
            },
          },
        ],
        message: 'encoded Effect cause',
      },
      id: 4,
      jsonrpc: '2.0',
    });

    expect(JSON.parse(transform(invalidParams) as string)).toEqual({
      error: {code: -32602, message: 'Expected a canonical threadnote:// URI.'},
      id: 2,
      jsonrpc: '2.0',
    });
    expect(JSON.parse(transform(resourceNotFound) as string)).toEqual({
      error: {code: -32002, message: 'Threadnote resource was not found.'},
      id: 3,
      jsonrpc: '2.0',
    });
    expect(JSON.parse(transform(resourceNotFoundWithRecovery) as string)).toEqual({
      error: {code: -32002, data: recovery, message: 'Threadnote resource was not found.'},
      id: 4,
      jsonrpc: '2.0',
    });
  });

  it('does not unwrap exact branded envelopes carrying arbitrary invalid recovery candidates', () => {
    const transform = makeInitializeInstructionsTransform('Use Threadnote context.');
    transform(initializeResponse);
    fc.assert(
      fc.property(fc.jsonValue(), fc.integer({max: 10_000, min: 1}), (generated, id) => {
        const candidate =
          typeof generated === 'object' && generated !== null && !Array.isArray(generated)
            ? {...generated, unexpected: 'reject-candidate'}
            : generated;
        const frame = encodedResourceNotFoundCause(candidate, id);
        expect(transform(frame)).toBe(frame);
      }),
      {numRuns: 100},
    );
  });

  it('rejects nested extras and semantically inconsistent recovery actions', () => {
    const transform = makeInitializeInstructionsTransform('Use Threadnote context.');
    transform(initializeResponse);
    const recovery = memoryReadRecoveryForRequestedUri(
      'threadnote://user/test-user/memories/durable/projects/threadnote/moved-contract.md',
    );
    if (recovery === undefined) throw TestError.make({message: 'Expected canonical memory recovery.'});
    const invalidCandidates = [
      {...recovery, unexpected: true},
      {...recovery, nextAction: {...recovery.nextAction, unexpected: true}},
      {
        ...recovery,
        nextAction: {...recovery.nextAction, arguments: {...recovery.nextAction.arguments, unexpected: true}},
      },
      {...recovery, summary: 'ARBITRARY_BOUNDED_TEXT'},
      {
        ...recovery,
        requestedUri: 'threadnote://user/test-user/memories/durable/projects/threadnote/another-contract.md',
      },
      {...recovery, nextAction: {...recovery.nextAction, arguments: {query: 'misleading-action'}}},
      {...recovery, requestedUri: 'threadnote://user/foreign-user/not-even-a-memory'},
    ];

    for (const [index, candidate] of invalidCandidates.entries()) {
      const frame = encodedResourceNotFoundCause(candidate, index + 1);
      expect(transform(frame)).toBe(frame);
    }
  });

  it('leaves unrelated results and Cause-shaped errors byte-for-byte unchanged', () => {
    const transform = makeInitializeInstructionsTransform('Use Threadnote context.');
    transform(initializeResponse);
    const frames = [
      JSON.stringify({
        id: 2,
        jsonrpc: '2.0',
        result: {text: 'repository data may contain "_tag":"Cause" without being a protocol error'},
      }),
      JSON.stringify({
        error: {
          _tag: 'Cause',
          code: 0,
          data: [
            {
              _tag: 'Fail',
              error: {
                _tag: 'InvalidParams',
                code: -32602,
                message: 'unbranded protocol failure',
              },
            },
          ],
        },
        id: 6,
        jsonrpc: '2.0',
      }),
      JSON.stringify({
        error: {
          _tag: 'Cause',
          code: 0,
          data: [
            {
              error: {
                _tag: 'InvalidParams',
                code: -32602,
                data: MCP_RESOURCE_ERROR_DATA,
                message: 'not an Effect Fail reason',
              },
            },
          ],
        },
        id: 7,
        jsonrpc: '2.0',
      }),
      JSON.stringify({
        error: {
          _tag: 'Cause',
          code: 0,
          data: [
            {
              _tag: 'Fail',
              error: {
                _tag: 'InvalidParams',
                code: -32602,
                data: {...MCP_RESOURCE_ERROR_DATA, privateDetail: 'must not be forwarded'},
                message: 'not an exact resource error brand',
              },
            },
          ],
        },
        id: 8,
        jsonrpc: '2.0',
      }),
      JSON.stringify({
        error: {
          _tag: 'Cause',
          code: 7,
          data: [{_tag: 'Fail', error: {_tag: 'InvalidParams', code: -32602, message: 'nested'}}],
        },
        id: 3,
        jsonrpc: '2.0',
      }),
      JSON.stringify({
        error: {
          _tag: 'Cause',
          code: 0,
          data: [{_tag: 'Fail', error: {_tag: 'OtherError', code: -32602, message: 'unrecognized'}}],
        },
        id: 4,
        jsonrpc: '2.0',
      }),
      JSON.stringify({
        error: {
          _tag: 'Cause',
          code: 0,
          data: [
            {_tag: 'Fail', error: {_tag: 'InvalidParams', code: -32602, message: 'first'}},
            {_tag: 'Fail', error: {_tag: 'InvalidParams', code: -32602, message: 'second'}},
          ],
        },
        id: 5,
        jsonrpc: '2.0',
      }),
      JSON.stringify({
        error: {
          _tag: 'Cause',
          code: 0,
          data: [{_tag: 'Fail', error: {_tag: 'InvalidParams', code: -32602, message: 'no id'}}],
        },
        jsonrpc: '2.0',
      }),
    ];

    for (const frame of frames) expect(transform(frame)).toBe(frame);
  });
});

describe('Effect MCP stdio protocol revisions', () => {
  const protocols = [
    McpProtocol.v2025_11_25,
    McpProtocol.v2025_06_18,
    McpProtocol.v2025_03_26,
    McpProtocol.v2024_11_05,
  ] as const;

  it.each([
    ['2024-11-05', false],
    ['2025-03-26', true],
    ['2025-06-18', false],
    ['2025-11-25', false],
  ] as const)('negotiates %s and applies its JSON-RPC batch policy', (protocolVersion, acceptsBatch) => {
    const parser = mcpStdioSerialization(protocols).makeUnsafe();
    const encode = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
    const initialized = parser.decode(
      encode({
        id: 1,
        jsonrpc: '2.0',
        method: 'initialize',
        params: {capabilities: {}, clientInfo: {name: 'stdio-revision-test', version: '1.0.0'}, protocolVersion},
      }),
    );
    const decodedBatch = parser.decode(
      encode([
        {id: 2, jsonrpc: '2.0', method: 'tools/list', params: {}},
        {id: 3, jsonrpc: '2.0', method: 'tools/list', params: {}},
      ]),
    ) as readonly {readonly id?: unknown; readonly tag?: unknown}[];

    expect(initialized).toEqual([
      expect.objectContaining({id: 1, payload: expect.objectContaining({protocolVersion}), tag: 'initialize'}),
    ]);
    expect(decodedBatch).toEqual(
      acceptsBatch
        ? [expect.objectContaining({id: 2, tag: 'tools/list'}), expect.objectContaining({id: 3, tag: 'tools/list'})]
        : [expect.objectContaining({id: null, tag: 'invalid/json-rpc-batch'})],
    );
  });

  it('encodes a rejected stdio batch as one Invalid Request response', () => {
    const parser = mcpStdioSerialization(protocols).makeUnsafe();
    const encoded = parser.encode({
      _tag: 'Exit',
      exit: {_tag: 'Failure', cause: [{_tag: 'Fail', error: {message: 'JSON-RPC batches are not supported'}}]},
      requestId: null,
    });

    expect(typeof encoded).toBe('string');
    expect(JSON.parse(encoded as string)).toMatchObject({
      error: {code: -32_600, message: 'JSON-RPC batches are not supported'},
      id: null,
      jsonrpc: '2.0',
    });
  });

  it('uses the newest advertised policy for an unsupported offered revision', () => {
    const parser = mcpStdioSerialization(protocols).makeUnsafe();
    const encode = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
    parser.decode(
      encode({
        id: 1,
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          capabilities: {},
          clientInfo: {name: 'unknown-revision-test', version: '1.0.0'},
          protocolVersion: '2099-01-01',
        },
      }),
    );

    expect(
      parser.decode(
        encode([
          {id: 2, jsonrpc: '2.0', method: 'tools/list', params: {}},
          {id: 3, jsonrpc: '2.0', method: 'tools/list', params: {}},
        ]),
      ),
    ).toEqual([expect.objectContaining({id: null, tag: 'invalid/json-rpc-batch'})]);
  });

  it('does not relabel an unrelated null-id failure as a rejected batch', () => {
    const parser = mcpStdioSerialization(protocols).makeUnsafe();
    const encoded = parser.encode({
      _tag: 'Exit',
      exit: {
        _tag: 'Failure',
        cause: [
          {
            _tag: 'Fail',
            error: {_tag: 'InvalidRequest', code: -32_600, message: 'Unrelated null-id failure'},
          },
        ],
      },
      requestId: null,
    });

    expect(JSON.parse(encoded as string)).toMatchObject({
      error: {code: -32_600, message: 'Unrelated null-id failure'},
      jsonrpc: '2.0',
    });
  });
});

describe('Effect MCP resource interruption', () => {
  effectIt.effect('re-fails resource cancellation instead of converting it to a protocol error', () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.never.pipe(Effect.catchCause(mcpResourceFailureResult), Effect.forkChild);
      yield* Effect.yieldNow;

      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
    }),
  );

  effectIt.effect('preserves an ordinary typed resource protocol failure', () =>
    Effect.gen(function* () {
      const expected = McpSchema.InvalidParams.make({
        data: MCP_RESOURCE_ERROR_DATA,
        message: 'bounded fixture failure',
      });
      const exit = yield* expected.pipe(Effect.catchCause(mcpResourceFailureResult), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.findErrorOption(exit.cause)).toEqual(expect.objectContaining({_tag: 'Some', value: expected}));
      }
    }),
  );

  effectIt.effect('maps defects to a bounded protocol error without exposing their details', () =>
    Effect.gen(function* () {
      const exit = yield* Effect.die(TestError.make({message: '/private/path: secret fixture'})).pipe(
        Effect.catchCause(mcpResourceFailureResult),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause);
        expect(error).toMatchObject({code: -32603, message: 'Threadnote resource request failed.'});
        expect(String(error)).not.toContain('/private/path');
        expect(String(error)).not.toContain('secret fixture');
      }
    }),
  );
});

describe('Effect MCP tool interruption', () => {
  it('preserves private reported outcome metadata while adapting the SDK result class', () => {
    const source = attachAnonymousTelemetryReportedOutcome(
      {content: [{type: 'text', text: 'Retry after indexing.'}]},
      'unavailable',
    );
    const adapted = mcpCallToolResultWithTelemetryMetadata(source);

    expect(adapted).toBeInstanceOf(McpSchema.CallToolResult);
    expect(readAnonymousTelemetryReportedOutcome(adapted)).toBe('unavailable');
    expect(JSON.stringify(adapted)).toBe(JSON.stringify(source));
  });

  it('normalizes optional structured fields with JSON wire semantics before SDK validation', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            optional: fc.option(fc.jsonValue(), {nil: undefined}),
            required: fc.jsonValue(),
          }),
          {maxLength: 8},
        ),
        entries => {
          const structuredContent = {entries};
          const adapted = mcpCallToolResultWithTelemetryMetadata({
            content: [{type: 'text', text: 'Structured result.'}],
            structuredContent,
          });

          expect(adapted.structuredContent).toEqual(JSON.parse(JSON.stringify(structuredContent)));
        },
      ),
      {numRuns: 100},
    );
  });

  effectIt.effect('re-fails transport cancellation instead of returning an isError payload', () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.never.pipe(Effect.catchCause(mcpToolFailureResult), Effect.forkChild);
      yield* Effect.yieldNow;

      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }),
  );

  effectIt.effect('still converts ordinary tool failures into an isError payload', () =>
    Effect.gen(function* () {
      const result = yield* TestError.make({message: 'bounded fixture failure'}).pipe(
        Effect.catchCause(mcpToolFailureResult),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{type: 'text', text: 'bounded fixture failure'}]);
      expect(readAnonymousTelemetryDiagnostic(result)).toEqual({errorType: 'UnknownError'});
      expect(JSON.stringify(result)).not.toContain('anonymous-telemetry');
    }),
  );
});

describe('Effect MCP tool progress', () => {
  it('keeps production cadence fixed and admits a shortened heartbeat only in explicit tests', () => {
    const testOverride = {THREADNOTE_TEST_MCP_PROGRESS_HEARTBEAT_MILLISECONDS: '1'};
    const removedProductionOverride = {THREADNOTE_MCP_PROGRESS_HEARTBEAT_MILLISECONDS: '1'};

    expect(mcpProgressHeartbeatMilliseconds({})).toBe(MCP_PROGRESS_HEARTBEAT_MILLISECONDS);
    expect(mcpProgressHeartbeatMilliseconds({...removedProductionOverride, NODE_ENV: 'production'})).toBe(
      MCP_PROGRESS_HEARTBEAT_MILLISECONDS,
    );
    expect(mcpProgressHeartbeatMilliseconds({...testOverride, NODE_ENV: 'production'})).toBe(
      MCP_PROGRESS_HEARTBEAT_MILLISECONDS,
    );
    expect(mcpProgressHeartbeatMilliseconds({...removedProductionOverride, NODE_ENV: 'test'})).toBe(
      MCP_PROGRESS_HEARTBEAT_MILLISECONDS,
    );
    expect(mcpProgressHeartbeatMilliseconds({NODE_ENV: 'test'})).toBe(MCP_PROGRESS_HEARTBEAT_MILLISECONDS);
    expect(
      mcpProgressHeartbeatMilliseconds({
        NODE_ENV: 'test',
        THREADNOTE_TEST_MCP_PROGRESS_HEARTBEAT_MILLISECONDS: 'invalid',
      }),
    ).toBe(MCP_PROGRESS_HEARTBEAT_MILLISECONDS);
    expect(mcpProgressHeartbeatMilliseconds({...testOverride, NODE_ENV: 'test'})).toBe(1);
  });

  it('keys numeric and string request ids without collisions', () => {
    fc.assert(
      fc.property(fc.integer(), id => {
        expect(mcpRequestIdKey(id)).not.toBe(mcpRequestIdKey(String(id)));
        expect(mcpRequestIdKey(id)).toBe(mcpRequestIdKey(id));
        expect(mcpRequestIdKey(String(id))).toBe(mcpRequestIdKey(String(id)));
      }),
      {numRuns: 100},
    );
  });

  effectIt.effect('isolates queued cancelled progress from a fresh request reusing the opaque token', () =>
    Effect.gen(function* () {
      type ProtocolService = RpcServer.Protocol['Service'];
      type Receive = Parameters<ProtocolService['run']>[0];
      type Received = Parameters<Receive>[1];
      type Sent = Parameters<ProtocolService['send']>[1];
      const ready = yield* Deferred.make<void>();
      const received: Received[] = [];
      const sent: Sent[] = [];
      const stampedProgress: Sent[] = [];
      let receive: Receive | undefined;
      const baseProtocol = {
        end: () => Effect.void,
        run: (handle: Receive) =>
          Effect.sync(() => {
            receive = handle;
          }).pipe(Effect.andThen(Deferred.succeed(ready, undefined)), Effect.andThen(Effect.never)),
        send: (_clientId: number, response: Sent) => Effect.sync(() => sent.push(response)),
      } as unknown as ProtocolService;
      const protocol = makeMcpCancellationCompatibleProtocol(baseProtocol);
      const fiber = yield* protocol
        .run((_clientId, incoming) => {
          received.push(incoming);
          if (incoming._tag !== 'Request' || incoming.tag !== 'tools/call') return Effect.void;
          return mcpProgressNotificationForCurrentRequest(
            mcpProgressNotification('shared-token', 1, {
              message: 'Preparing recall results.',
              phase: 'recall.finalizing',
            }),
          ).pipe(
            Effect.tap(notification =>
              Effect.sync(() =>
                stampedProgress.push({
                  _tag: 'Request',
                  headers: [],
                  id: 0,
                  payload: notification,
                  tag: 'notifications/progress',
                } as unknown as Sent),
              ),
            ),
            Effect.asVoid,
          );
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(ready);
      const dispatch = receive as Receive;
      const request = {
        _tag: 'Request' as const,
        headers: [],
        id: 9,
        payload: {_meta: {progressToken: 'shared-token'}},
        tag: 'tools/call',
      };
      yield* dispatch(7, request);
      const normalizedRequest = received[0];
      expect(normalizedRequest?._tag).toBe('Request');
      if (normalizedRequest?._tag !== 'Request') return;
      yield* dispatch(7, {
        _tag: 'Request',
        headers: [],
        id: '',
        payload: {requestId: 9},
        tag: 'notifications/cancelled',
      });
      const oldProgress = stampedProgress[0];
      const unrelatedProgress = {
        _tag: 'Request',
        headers: [],
        id: 0,
        payload: {progressToken: 9},
        tag: 'notifications/progress',
      } as unknown as Sent;
      const exit = {
        _tag: 'Exit',
        exit: {_tag: 'Failure', cause: [{_tag: 'Interrupt', fiberId: 1}]},
        requestId: normalizedRequest.id,
      } as Sent;

      yield* protocol.send(7, unrelatedProgress);
      yield* protocol.send(7, oldProgress);
      yield* protocol.send(7, exit);
      yield* protocol.send(7, oldProgress);

      expect(sent).toEqual([unrelatedProgress]);

      const ordinaryRequest = {...request, id: 10};
      yield* dispatch(7, ordinaryRequest);
      const normalizedOrdinaryRequest = received[2];
      expect(normalizedOrdinaryRequest?._tag).toBe('Request');
      if (normalizedOrdinaryRequest?._tag !== 'Request') return;
      const freshProgress = stampedProgress[1];
      yield* protocol.send(7, freshProgress);
      yield* protocol.send(7, {
        _tag: 'Exit',
        exit: {_tag: 'Success', value: 'complete'},
        requestId: normalizedOrdinaryRequest.id,
      });
      expect(sent).toEqual([
        unrelatedProgress,
        {
          ...(freshProgress as object),
          payload: mcpProgressNotification('shared-token', 1, {
            message: 'Preparing recall results.',
            phase: 'recall.finalizing',
          }),
        },
        {
          _tag: 'Exit',
          exit: {_tag: 'Success', value: 'complete'},
          requestId: 10,
        },
      ]);
      expect(JSON.stringify(sent)).not.toContain('threadnote.io/private/progress-generation');

      yield* Fiber.interrupt(fiber);
    }),
  );

  effectIt.effect('routes concurrent numeric and string twin ids without cross-talk', () =>
    Effect.gen(function* () {
      type ProtocolService = RpcServer.Protocol['Service'];
      type Receive = Parameters<ProtocolService['run']>[0];
      type Received = Parameters<Receive>[1];
      type Sent = Parameters<ProtocolService['send']>[1];
      const ready = yield* Deferred.make<void>();
      const received: Received[] = [];
      const sent: Sent[] = [];
      let receive: Receive | undefined;
      const baseProtocol = {
        end: () => Effect.void,
        run: (handle: Receive) =>
          Effect.sync(() => {
            receive = handle;
          }).pipe(Effect.andThen(Deferred.succeed(ready, undefined)), Effect.andThen(Effect.never)),
        send: (_clientId: number, response: Sent) => Effect.sync(() => sent.push(response)),
      } as unknown as ProtocolService;
      const protocol = makeMcpCancellationCompatibleProtocol(baseProtocol);
      const fiber = yield* protocol
        .run((_clientId, request) => Effect.sync(() => received.push(request)))
        .pipe(Effect.forkChild);
      yield* Deferred.await(ready);
      const dispatch = receive as Receive;
      const numericRequest = {
        _tag: 'Request' as const,
        headers: [],
        id: 9,
        payload: {_meta: {progressToken: 'numeric-token'}},
        tag: 'tools/call',
      };
      const stringRequest = {...numericRequest, id: '9', payload: {_meta: {progressToken: 'string-token'}}};

      yield* dispatch(7, numericRequest);
      yield* dispatch(7, stringRequest);
      const normalizedNumeric = received[0];
      const normalizedString = received[1];
      expect(normalizedNumeric?._tag).toBe('Request');
      expect(normalizedString?._tag).toBe('Request');
      if (normalizedNumeric?._tag !== 'Request' || normalizedString?._tag !== 'Request') return;
      expect(normalizedNumeric.id).not.toBe(normalizedString.id);

      yield* dispatch(7, {_tag: 'Ack', requestId: 9});
      yield* dispatch(7, {_tag: 'Interrupt', requestId: '9'});
      expect(received.slice(2)).toEqual([
        {_tag: 'Ack', requestId: normalizedNumeric.id},
        {_tag: 'Interrupt', requestId: normalizedString.id},
      ]);

      yield* protocol.send(7, {
        _tag: 'Chunk',
        requestId: normalizedNumeric.id,
        values: ['numeric'],
      });
      yield* dispatch(7, {
        _tag: 'Request',
        headers: [],
        id: '',
        payload: {requestId: 9},
        tag: 'notifications/cancelled',
      });
      const numericProgress = {
        _tag: 'Request',
        headers: [],
        id: 0,
        payload: {progressToken: 'numeric-token'},
        tag: 'notifications/progress',
      } as unknown as Sent;
      const stringProgress = {
        ...numericProgress,
        payload: {progressToken: 'string-token'},
      } as unknown as Sent;
      yield* protocol.send(7, numericProgress);
      yield* protocol.send(7, stringProgress);
      yield* protocol.send(7, {
        _tag: 'Exit',
        exit: {_tag: 'Success', value: 'string'},
        requestId: normalizedString.id,
      });
      yield* protocol.send(7, {
        _tag: 'Exit',
        exit: {_tag: 'Success', value: 'numeric'},
        requestId: normalizedNumeric.id,
      });
      expect(sent).toEqual([
        {_tag: 'Chunk', requestId: 9, values: ['numeric']},
        stringProgress,
        {_tag: 'Exit', exit: {_tag: 'Success', value: 'string'}, requestId: '9'},
      ]);

      yield* Fiber.interrupt(fiber);
    }),
  );

  effectIt.effect('does not emit or register progress when the request has no token', () =>
    Effect.gen(function* () {
      const notifications: McpProgressNotificationPayload[] = [];
      const progress = makeMcpToolProgress(undefined, notification =>
        Effect.sync(() => notifications.push(notification)),
      );

      yield* progress.report({message: 'Resolving recall scope.', phase: 'recall.workspace-context'});

      expect(progress.enabled).toBe(false);
      expect(notifications).toEqual([]);
    }),
  );

  effectIt.effect('installs the request bridge once and preserves the original callTool receiver', () =>
    Effect.gen(function* () {
      const server = fakeEffectMcpServer();
      const original = server.callTool;

      expect(installCallToolProgressBridge(server)).toBe(true);
      const installed = server.callTool;
      expect(installed).not.toBe(original);
      expect(installCallToolProgressBridge(server)).toBe(true);
      expect(server.callTool).toBe(installed);
      expect(server).not.toHaveProperty('initializedClients');

      const result = yield* server
        .callTool({arguments: {}, name: 'fixture'})
        .pipe(Effect.provideService(McpSchema.McpServerClient, fixtureMcpServerClient(17)));

      expect(result.content).toEqual([{type: 'text', text: 'receiver-preserved'}]);
      expect(server).not.toHaveProperty('initializedClients');
    }),
  );

  it('leaves a frozen Effect service unchanged when the bridge cannot be installed safely', () => {
    const server = Object.freeze(fakeEffectMcpServer());
    const original = server.callTool;

    expect(installCallToolProgressBridge(server)).toBe(false);
    expect(server.callTool).toBe(original);
  });

  effectIt.effect.prop(
    'preserves the originating client and opaque token in Effect 4 request context',
    [Schema.Int, Schema.String],
    ([clientId, progressToken]) =>
      Effect.gen(function* () {
        const server: EffectMcpServer = {
          ...fakeEffectMcpServer(),
          callTool: () =>
            Effect.gen(function* () {
              const context = yield* Effect.serviceOption(McpSchema.McpRequestContext);
              expect(Option.isSome(context)).toBe(true);
              if (Option.isSome(context)) {
                expect(context.value.clientId).toBe(clientId);
                expect(context.value.requestMetadata?.progressToken).toBe(progressToken);
                expect(context.value.protocolVersion).toBe('2025-06-18');
              }
              return McpSchema.CallToolResult.make({content: []});
            }),
        };
        expect(installCallToolProgressBridge(server)).toBe(true);
        yield* server
          .callTool({_meta: {progressToken}, arguments: {}, name: 'fixture'})
          .pipe(Effect.provideService(McpSchema.McpServerClient, fixtureMcpServerClient(clientId)));
        expect(server).not.toHaveProperty('initializedClients');
      }),
    {arbitrary: {runs: 50}},
  );

  it('leaves a non-writable Effect service unchanged when the bridge cannot be installed safely', () => {
    const server = fakeEffectMcpServer();
    const original = server.callTool;
    Object.defineProperty(server, 'callTool', {writable: false});

    expect(installCallToolProgressBridge(server)).toBe(false);
    expect(server.callTool).toBe(original);
    expect(server).not.toHaveProperty('initializedClients');
  });

  it('preserves the exact callTool method when binding the request bridge fails', () => {
    const target = fakeEffectMcpServer();
    const original = target.callTool;
    const server = new Proxy(target, {
      defineProperty(object, property, descriptor) {
        if (property === 'callTool') throw TestError.make({message: 'fixture rejects request bridge binding'});
        return Reflect.defineProperty(object, property, descriptor);
      },
      set(object, property, value) {
        return Reflect.set(object, property, value, object);
      },
    });

    expect(installCallToolProgressBridge(server)).toBe(false);
    expect(target.callTool).toBe(original);
    expect(target).not.toHaveProperty('initializedClients');
  });

  effectIt.effect('refuses a second client without leaking its token or mutating the routing set', () =>
    Effect.gen(function* () {
      const initializedClients = new Set([11]);
      const notifications: McpProgressNotificationPayload[] = [];
      const admitted = admitMcpProgressToken('second-client-token', 22, initializedClients);
      const progress = makeMcpToolProgress(admitted, notification =>
        Effect.sync(() => notifications.push(notification)),
      );

      yield* progress.report({message: 'Resolving recall scope.', phase: 'recall.workspace-context'});

      expect(admitted).toBeUndefined();
      expect(progress.enabled).toBe(false);
      expect(initializedClients).toEqual(new Set([11]));
      expect(notifications).toEqual([]);
    }),
  );

  it('admits only the first/current client on an empty or current-only stdio routing set', () => {
    const initializedClients = new Set<number>();

    expect(admitMcpProgressToken('first-token', 11, initializedClients)).toBe('first-token');
    expect(initializedClients).toEqual(new Set([11]));
    expect(admitMcpProgressToken('same-client-token', 11, initializedClients)).toBe('same-client-token');
    expect(admitMcpProgressToken('foreign-token', 22, initializedClients)).toBeUndefined();
    expect(initializedClients).toEqual(new Set([11]));
  });

  it('keeps an enqueued notification isolated when a foreign client appears before queue drain', () => {
    const initializedClients = new StdioSingleClientSet();
    initializedClients.add(11);
    const queued = [{progressToken: 'client-11-token'}];

    // Private stdio admission stays with its first client for its entire
    // lifetime, even after deletion; Effect separately routes each notification
    // using the request context captured when it was enqueued.
    initializedClients.add(22);
    const deliveries = queued.flatMap(notification =>
      [...initializedClients].map(clientId => ({clientId, notification})),
    );

    expect(deliveries).toEqual([{clientId: 11, notification: {progressToken: 'client-11-token'}}]);
    initializedClients.delete(11);
    initializedClients.add(22);
    expect([...initializedClients]).toEqual([]);
  });

  effectIt.effect('preserves the opaque token and emits monotonic canonical payloads', () =>
    Effect.gen(function* () {
      const notifications: McpProgressNotificationPayload[] = [];
      const progress = makeMcpToolProgress('opaque-fixture-token', notification =>
        Effect.sync(() => notifications.push(notification)),
      );

      yield* progress.report({message: 'Refreshing shared memories.', phase: 'recall.shared-sync'});
      yield* progress.report({message: 'Searching memory indexes.', phase: 'recall.semantic-retrieval'});

      expect(notifications).toEqual([
        {
          _meta: {[MCP_PROGRESS_METADATA_KEY]: {phase: 'recall.shared-sync', version: 1}},
          message: 'Refreshing shared memories.',
          progress: 1,
          progressToken: 'opaque-fixture-token',
        },
        {
          _meta: {[MCP_PROGRESS_METADATA_KEY]: {phase: 'recall.semantic-retrieval', version: 1}},
          message: 'Searching memory indexes.',
          progress: 2,
          progressToken: 'opaque-fixture-token',
        },
      ]);
    }),
  );

  effectIt.effect('runs a long phase once, heartbeats at a bounded cadence, and preserves cancellation', () =>
    Effect.gen(function* () {
      const notifications: McpProgressNotificationPayload[] = [];
      let phaseInvocations = 0;
      let phaseInterruptions = 0;
      const phaseStarted = yield* Deferred.make<void>();
      const progress = makeMcpToolProgress(42, notification => Effect.sync(() => notifications.push(notification)));
      const phase = Effect.sync(() => {
        phaseInvocations += 1;
      }).pipe(
        Effect.andThen(Deferred.succeed(phaseStarted, undefined)),
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Effect.sync(() => (phaseInterruptions += 1))),
      );
      const fiber = yield* withMcpProgressHeartbeat(
        progress,
        {message: 'Refreshing shared memories.', phase: 'recall.shared-sync'},
        phase,
        1_000,
      ).pipe(Effect.forkChild);
      yield* Deferred.await(phaseStarted);
      yield* Effect.yieldNow;

      for (let tick = 0; tick < 3; tick += 1) {
        yield* TestClock.adjust(1_000);
        for (let spin = 0; spin < 16 && notifications.length < tick + 2; spin += 1) {
          yield* Effect.yieldNow;
        }
        expect(notifications).toHaveLength(tick + 2);
        // Let the heartbeat fiber schedule its next virtual sleep before the
        // next clock adjustment; parallel test-file load can otherwise advance
        // the clock while the reporter is still completing its bounded yields.
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
      }
      expect(phaseInvocations).toBe(1);
      expect(notifications.map(notification => notification.progress)).toEqual([1, 2, 3, 4]);

      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      const notificationCount = notifications.length;
      yield* TestClock.adjust(10_000);

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(phaseInterruptions).toBe(1);
      expect(notifications).toHaveLength(notificationCount);
    }),
  );

  effectIt.effect('re-fails cancellation while a progress notification is being sent', () =>
    Effect.gen(function* () {
      const progress = makeMcpToolProgress('blocked-token', () => Effect.never);
      const fiber = yield* progress
        .report({message: 'Searching memory indexes.', phase: 'recall.semantic-retrieval'})
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }),
  );

  effectIt.effect('keeps tool work alive when the client rejects an optional progress notification', () =>
    Effect.gen(function* () {
      let phaseInvocations = 0;
      const progress = makeMcpToolProgress('disconnected-token', () =>
        Effect.fail(TestError.make({message: '/private/progress-transport-fixture'})),
      );

      const result = yield* withMcpProgressHeartbeat(
        progress,
        {message: 'Searching memory indexes.', phase: 'recall.semantic-retrieval'},
        Effect.sync(() => {
          phaseInvocations += 1;
          return 'completed';
        }),
      );

      expect(result).toBe('completed');
      expect(phaseInvocations).toBe(1);
    }),
  );

  it('bounds arbitrary progress fields while preserving any valid opaque token', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.double({noDefaultInfinity: true, noNaN: true})),
        fc.string(),
        fc.string(),
        fc.integer(),
        (token, message, phase, sequence) => {
          const notification = mcpProgressNotification(token, sequence, {
            message,
            phase,
          });
          const metadata = notification._meta[MCP_PROGRESS_METADATA_KEY];

          expect(notification.progressToken).toBe(token);
          expect(notification.progress).toBe(Number.isSafeInteger(sequence) && sequence > 0 ? sequence : 1);
          expect(new TextEncoder().encode(notification.message).byteLength).toBeLessThanOrEqual(
            MCP_PROGRESS_MESSAGE_MAX_BYTES,
          );
          expect(
            [...notification.message].some(character => {
              const codePoint = character.codePointAt(0) ?? 0;
              return codePoint <= 31 || codePoint === 127;
            }),
          ).toBe(false);
          expect(metadata.phase.length).toBeLessThanOrEqual(64);
          expect(metadata.phase).toMatch(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u);
          expect(metadata).not.toHaveProperty('retryAfterMilliseconds');
        },
      ),
      {numRuns: 100},
    );
  });

  effectIt.effect('keeps 128 concurrent progress streams token-local', () =>
    Effect.gen(function* () {
      const notifications: McpProgressNotificationPayload[] = [];
      yield* Effect.all(
        Array.from({length: 128}, (_, index) => {
          const progress = makeMcpToolProgress(`token-${index}`, notification =>
            Effect.sync(() => notifications.push(notification)),
          );
          return progress
            .report({message: 'Resolving recall scope.', phase: 'recall.workspace-context'})
            .pipe(Effect.andThen(progress.report({message: 'Preparing recall results.', phase: 'recall.finalizing'})));
        }),
        {concurrency: 'unbounded'},
      );

      expect(notifications).toHaveLength(256);
      for (let index = 0; index < 128; index += 1) {
        expect(
          notifications
            .filter(notification => notification.progressToken === `token-${index}`)
            .map(notification => notification.progress),
        ).toEqual([1, 2]);
      }
    }),
  );
});

function fakeEffectMcpServer(): EffectMcpServer {
  const server = {
    marker: 'receiver-preserved',
    notifications: {'notifications/progress': () => Effect.void},
    callTool(this: {readonly marker: string}) {
      return Effect.succeed(McpSchema.CallToolResult.make({content: [{type: 'text', text: this.marker}]}));
    },
  };
  return server as unknown as EffectMcpServer;
}

function fixtureMcpServerClient(clientId: number): McpSchema.McpServerClient['Service'] {
  return McpSchema.McpServerClient.of({
    clientCapabilities: {},
    clientId,
    clientInfo: {name: 'effect-ai-mcp-test', version: '1.0.0'},
    getClient: Effect.never,
    initializePayload: {} as McpSchema.McpServerClient['Service']['initializePayload'],
    protocolVersion: '2025-06-18',
  });
}
