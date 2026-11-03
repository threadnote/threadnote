import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Schema} from 'effect';
import {McpProtocol, McpSchema, McpTest} from 'effect/ai';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import {BackgroundInferenceAdmission} from '@threadnote/inference/background/admission';
import {EffectMcpServerRegistry} from '@threadnote/threadnote/effect/ai/mcp';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {provideTestLayer} from '../helpers/effect-layer.js';

const protocols = [
  McpProtocol.v2025_11_25,
  McpProtocol.v2025_06_18,
  McpProtocol.v2025_03_26,
  McpProtocol.v2024_11_05,
] as const;

function fixture(onHandle: () => void = () => {}) {
  const registry = new EffectMcpServerRegistry();
  let calls = 0;
  registry.registerTool(
    'echo_json',
    {description: 'Synthetic JSON codec fixture.', inputSchema: {payload: Schema.Json}},
    ({payload}) =>
      Effect.sync(() => {
        onHandle();
        calls++;
        return {
          content: [{type: 'text', text: JSON.stringify(payload)}],
          structuredContent: {payload, omitted: undefined},
        };
      }),
  );
  registry.registerTool('declared_failure', {description: 'Synthetic typed failure.', inputSchema: {}}, () =>
    Effect.sync(onHandle).pipe(Effect.andThen(Effect.fail(TestError.make({message: 'synthetic declared failure'})))),
  );
  registry.registerResourceTemplate(
    {name: 'fixture', routerPath: '*', uriTemplate: 'threadnote://{+resourcePath}'},
    uri =>
      Effect.sync(() => {
        onHandle();
        return McpSchema.ReadResourceResult.make({
          contents: [{uri, mimeType: 'text/plain', text: 'synthetic resource'}],
        });
      }),
  );
  return {registry, calls: () => calls};
}

describe('native MCP registrations over the official wire harness', () => {
  for (const protocol of protocols) {
    effectIt.effect(`registers tools and resources before discovery on ${protocol.protocolVersion}`, () =>
      Effect.gen(function* () {
        const f = fixture();
        const client = yield* McpTest.makeClient(f.registry.registrationLayer(), {protocols: [protocol]});
        const tools = yield* client.listTools();
        expect(tools.tools).toHaveLength(2);
        expect(tools.tools[0]).toMatchObject({name: 'echo_json', inputSchema: {type: 'object', required: ['payload']}});
        if (protocol.protocolVersion >= '2025-06-18')
          expect(tools.tools[0]?.inputSchema.additionalProperties).toBe(false);
        const payload = {text: 'ø漢字🙂', items: [false, null, 42]};
        const result = yield* client.callTool({name: 'echo_json', arguments: {payload}});
        expect(result.isError).not.toBe(true);
        expect(result.content).toEqual([{type: 'text', text: JSON.stringify(payload)}]);
        const templates = yield* client.listResourceTemplates();
        expect(templates.resourceTemplates[0].uriTemplate).toBe('threadnote://{+resourcePath}');
        const uri = 'threadnote://synthetic/fixture';
        expect((yield* client.readResource({uri})).contents).toEqual([
          {uri, mimeType: 'text/plain', text: 'synthetic resource'},
        ]);
      }).pipe(provideTestLayer(ApplicationLayer)),
    );
  }

  effectIt.effect('validates inputs before the handler and preserves declared failures', () =>
    Effect.gen(function* () {
      const f = fixture();
      const client = yield* McpTest.makeClient(f.registry.registrationLayer(), {protocols: [McpProtocol.v2025_11_25]});
      expect((yield* client.callTool({name: 'echo_json', arguments: {}})).isError).toBe(true);
      expect(f.calls()).toBe(0);
      const failure = yield* client.callTool({name: 'declared_failure', arguments: {}});
      expect(failure.isError).toBe(true);
      expect(failure.content).toEqual([{type: 'text', text: 'synthetic declared failure'}]);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps captured foreground admission around tool and resource handlers', () =>
    Effect.gen(function* () {
      const actual = yield* BackgroundInferenceAdmission;
      const home = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({prefix: 'mcp-foreground-'});
      let entered = 0;
      let active = 0;
      let released = 0;
      const admission = BackgroundInferenceAdmission.of({
        ...actual,
        withForeground: (_home, program) =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              entered++;
              active++;
            }),
            () => program,
            () =>
              Effect.sync(() => {
                active--;
                released++;
              }),
          ),
      });
      const activeDuringHandlers: number[] = [];
      const f = fixture(() => {
        activeDuringHandlers.push(active);
      });
      const client = yield* McpTest.makeClient(f.registry.registrationLayer({productionLogHome: home}), {
        protocols: [McpProtocol.v2025_11_25],
      }).pipe(Effect.provideService(BackgroundInferenceAdmission, admission));
      yield* client.callTool({name: 'echo_json', arguments: {payload: null}});
      yield* client.callTool({name: 'declared_failure', arguments: {}});
      yield* client.readResource({uri: 'threadnote://synthetic/fixture'});
      expect(activeDuringHandlers).toEqual([1, 1, 1]);
      expect(entered).toBe(3);
      expect(active).toBe(0);
      expect(released).toBe(3);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  fcEffectProp(
    effectIt,
    'round-trips JSON payloads and omits undefined result fields',
    {payload: fc.jsonValue({maxDepth: 2})},
    ({payload}) =>
      Effect.gen(function* () {
        const f = fixture();
        const client = yield* McpTest.makeClient(f.registry.registrationLayer(), {
          protocols: [McpProtocol.v2025_11_25],
        });
        const result = yield* client.callTool({name: 'echo_json', arguments: {payload}});
        expect(result.structuredContent).toEqual({payload: JSON.parse(JSON.stringify(payload))});
        expect(result.content).toEqual([{type: 'text', text: JSON.stringify(payload)}]);
      }).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 40}},
  );
});
