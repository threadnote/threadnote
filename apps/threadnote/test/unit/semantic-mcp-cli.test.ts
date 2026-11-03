import {readFileSync} from '@threadnote/testing/node-fs';
import {it as effectIt} from '@effect/vitest';
import {
  Array as EffectArray,
  Effect,
  Option,
  Stdio,
  Stream,
  Record as EffectRecord,
  Schema,
  String as EffectString,
} from 'effect';
import {Command} from 'effect/cli';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  semanticCapabilities,
  formatSemanticCapabilities,
  readSemanticAgentQueryInput,
} from '../../src/effect/semantic_cli.js';
import {threadnoteCommand} from '../../src/effect/cli.js';
import {EffectMcpServerRegistry} from '../../src/effect/ai/mcp.js';
import {captureConsole} from '../../src/effect/console.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {registerSemanticTool, registerSemanticQueryTool} from '../../src/mcp/server/semantic.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('semantic capability discovery', () => {
  it('reports only selected candidates without inferring installed or qualified support', () => {
    const result = semanticCapabilities();
    expect(result.scope).toBe('distribution-catalog');
    expect(result.status).toBe('ok');
    expect(EffectArray.map(result.providers, provider => provider.id)).toEqual([
      'typescript-language-server',
      'basedpyright',
      'gopls',
      'rust-analyzer',
      'jdtls',
    ]);
    expect(EffectArray.flatMap(result.providers, provider => provider.languages).sort()).toEqual([
      'go',
      'java',
      'javascript',
      'python',
      'rust',
      'typescript',
    ]);
    expect(result.readiness).toEqual({
      installation: 'not-assessed',
      project: 'not-assessed',
      queries: 'requires-host-profile',
    });
    expect(result.readSurface.operations).toContain('diagnostics');
    expect(result.readSurface.operations).toContain('context');
    expect(result.readSurface.pending).not.toContain('context');
    expect(result.readSurface.pending).not.toContain('diagnostics');
    for (const provider of result.providers) {
      expect(provider.productionQualified).toBe(false);
      expect(provider.license.disposition).toBe('release-gated');
      expect(provider.qualification).toBe('pending');
    }
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(8192);
    expect(formatSemanticCapabilities(result)).toContain('installation and project not assessed');
  });

  it('binds runtime candidates to the selected versioned ledger without promoting unqualified pilots', () => {
    const ledger = Schema.decodeUnknownSync(
      Schema.Struct({
        selectedProviders: Schema.Record(Schema.String, Schema.String),
        providers: Schema.Array(
          Schema.Struct({id: Schema.String, version: Schema.String, productionQualified: Schema.Boolean}),
        ),
      }),
    )(
      JSON.parse(
        readFileSync(new URL('../../../../config/semantic-providers/qualification-lock.json', import.meta.url), 'utf8'),
      ),
    );
    const result = semanticCapabilities();
    expect(
      EffectRecord.fromEntries(
        EffectArray.flatMap(result.providers, provider =>
          EffectArray.map(provider.languages, language => [language, provider.id] as const),
        ),
      ),
    ).toEqual(ledger.selectedProviders);
    for (const [language, id] of EffectRecord.toEntries(ledger.selectedProviders)) {
      const provider = Option.getOrUndefined(
        EffectArray.findFirst(result.providers, candidate => candidate.languages.includes(language)),
      );
      const pinned = Option.getOrUndefined(EffectArray.findFirst(ledger.providers, candidate => candidate.id === id));
      expect(provider?.id).toBe(id);
      expect(provider?.candidateVersion).toBe(pinned?.version);
      expect(provider?.productionQualified).toBe(pinned?.productionQualified);
    }
  });

  it('distinguishes deferred Kotlin from an unsupported language without selecting an alternative provider', () => {
    const deferred = semanticCapabilities({language: 'kotlin'});
    expect(deferred.status).toBe('deferred');
    expect(deferred.providers).toEqual([]);
    expect(deferred.reason).toContain('Kotlin is deferred');
    const unsupported = semanticCapabilities({language: 'ruby'});
    expect(unsupported.status).toBe('unsupported');
    expect(unsupported.providers).toEqual([]);
    expect(formatSemanticCapabilities(unsupported)).toContain('No selected provider');
  });

  it('rejects unbounded, malformed and execution-bearing discovery input', () => {
    for (const input of [
      {language: ''},
      {language: 'java\n'},
      {language: EffectString.repeat(513)('x')},
      {executable: '/repo/run'},
      {apply: true},
    ]) {
      expect(() => semanticCapabilities(input)).toThrow();
    }
  });

  it('keeps filtered results deterministic, independent and confined to the requested language', () => {
    const full = semanticCapabilities();
    fc.assert(
      fc.property(fc.constantFrom('typescript', 'javascript', 'python', 'go', 'rust', 'java'), language => {
        const result = semanticCapabilities({language});
        expect(result.status).toBe('ok');
        expect(result.providers).toHaveLength(1);
        expect(result.providers[0].languages).toEqual([language]);
        expect(result.providers[0].id).toBe(
          Option.getOrUndefined(
            EffectArray.findFirst(full.providers, provider => provider.languages.includes(language)),
          )?.id,
        );
        const original = structuredClone(result);
        result.providers[0].languages.push('foreign');
        result.providers[0].candidateVersion = 'forged';
        expect(semanticCapabilities({language})).toEqual(original);
        expect(semanticCapabilities()).toEqual(full);
      }),
      {numRuns: 32},
    );
  });

  effectIt.effect('CLI JSON and registered MCP return the same canonical catalog and compact meaning', () =>
    Effect.gen(function* () {
      const cli = yield* captureConsole(
        Command.runWith(threadnoteCommand, {version: 'test'})([
          'semantic',
          'capabilities',
          '--language',
          'java',
          '--json',
        ]),
      ).pipe(provideTestLayer(ApplicationLayer));
      const registry = new EffectMcpServerRegistry();
      registerSemanticTool(registry);
      const mcp = yield* registry
        .invokeTool('semantic_capabilities', {language: 'java'})
        .pipe(provideTestLayer(ApplicationLayer));
      const canonical = JSON.parse(cli.output);
      expect(mcp.isError).not.toBe(true);
      expect(mcp.structuredContent).toEqual(canonical);
      expect(mcp.content).toEqual([
        {type: 'text', text: formatSemanticCapabilities(semanticCapabilities({language: 'java'}))},
      ]);
    }),
  );
  effectIt.effect('CLI and MCP expose the same unsupported query with one compact default payload', () =>
    Effect.gen(function* () {
      const request = {callerCwd: '/unused', file: 'source.kt', language: 'kotlin', operation: 'symbols'};
      const cli = yield* captureConsole(
        Command.runWith(threadnoteCommand, {version: 'test'})(['semantic', 'query', '--json']),
      ).pipe(
        provideTestLayer(Stdio.layerTest({stdin: Stream.make(new TextEncoder().encode(JSON.stringify(request)))})),
        provideTestLayer(ApplicationLayer),
      );
      const registry = new EffectMcpServerRegistry();
      registerSemanticQueryTool(registry, {
        account: 'local',
        user: 'test',
        agentId: 'test',
        agentContextHome: '/unused',
        manifestPath: '/unused/manifest.json',
      });
      const canonical = JSON.parse(cli.output);
      const agent = yield* registry.invokeTool('semantic_query', {request}).pipe(provideTestLayer(ApplicationLayer));
      expect(agent.structuredContent).toBeUndefined();
      expect(agent.content).toEqual([{type: 'text', text: JSON.stringify(canonical)}]);
      const dual = yield* registry
        .invokeTool('semantic_query', {request, responseFormat: 'dual'})
        .pipe(provideTestLayer(ApplicationLayer));
      expect(dual.content).toEqual(agent.content);
      expect(dual.structuredContent).toEqual(canonical);
    }),
  );
  effectIt.effect(
    'stdin rejects oversized, malformed UTF-8 and incomplete JSON while preserving split codepoints',
    () =>
      Effect.gen(function* () {
        for (const bytes of [new Uint8Array(65537), new Uint8Array([0xff]), new TextEncoder().encode('{')]) {
          expect(
            yield* readSemanticAgentQueryInput.pipe(provideTestLayer(Stdio.layerTest({stdin: Stream.make(bytes)}))),
          ).toBeNull();
        }
        const bytes = new TextEncoder().encode(JSON.stringify({file: 'é.ts'}));
        const split = bytes.indexOf(0xc3) + 1;
        expect(
          yield* readSemanticAgentQueryInput.pipe(
            provideTestLayer(Stdio.layerTest({stdin: Stream.make(bytes.slice(0, split), bytes.slice(split))})),
          ),
        ).toEqual({file: 'é.ts'});
      }),
  );
});
