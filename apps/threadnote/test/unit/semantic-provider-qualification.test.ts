import * as EffectArray from 'effect/Array';
import * as EffectOption from 'effect/Option';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import {fileURLToPath} from 'node:url';
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Static checked-in fixture bytes for the inventory contract.
import {readFileSync} from 'node:fs';
import {probeGuardedExchange} from '../fixtures/semantic/editor/proposal-wire.cjs';
import {describe, expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {Schema} from 'effect';
import {
  ProbeConfig,
  expandProbeScratch,
  providerFixture,
} from '../../../../tools/semantic/semantic_provider_fixture.js';
import {
  ProbeFrameDecoder,
  encodeProbeFrame,
  startSemanticProbe,
  observeProbeReadiness,
  appendProbeStderr,
} from '../../../../tools/semantic/semantic_lsp_probe.js';
import {
  checkProbeDefinition,
  checkProbeReferences,
  checkProbeRename,
  checkProbeShutdown,
} from '../../../../tools/semantic/semantic_probe_assertions.js';
describe('disposable semantic provider qualification', () => {
  it('denies unqualified and forged bridge clients over framed JSON-RPC', async () => {
    // Local socket boundary; real host fixtures additionally perform conditional buffer mutations.
    let applyCalls = 0;
    await probeGuardedExchange({
      apply: async () => {
        applyCalls++;
        return {status: 'applied', applied: [0, 1, 2]};
      },
    });
    expect(applyCalls).toBe(2);
  });
  it('covers the release inventory without advertising pilot evidence as production support', () => {
    const ledger = Schema.decodeUnknownSync(
      Schema.Struct({
        automaticDownloadOrExecution: Schema.Boolean,
        requiredPlatforms: Schema.Array(Schema.String),
        releaseLanguages: Schema.Array(Schema.String),
        selectedProviders: Schema.Record(Schema.String, Schema.String),
        providers: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            languages: Schema.Array(Schema.String),
            productionQualified: Schema.Boolean,
            platforms: Schema.Record(Schema.String, Schema.Unknown),
            pilotEvidence: Schema.optional(
              Schema.Array(
                Schema.Struct({
                  reportSha256: Schema.String,
                  configSha256: Schema.String,
                  sourceHashes: Schema.Record(Schema.String, Schema.String),
                }),
              ),
            ),
          }),
        ),
      }),
    )(
      JSON.parse(
        readFileSync(new URL('../../../../config/semantic-providers/qualification-lock.json', import.meta.url), 'utf8'),
      ),
    );
    expect(ledger.automaticDownloadOrExecution).toBe(false);
    const targetSource = readFileSync(new URL('../../../../scripts/release-targets.ts', import.meta.url), 'utf8');
    const targets = EffectArray.map(
      [...EffectString.matchAll(/['"]bun-([a-z0-9-]+)['"]/gu)(targetSource)],
      match => match[1],
    );
    expect(targets.length).toBeGreaterThan(0);
    expect([...ledger.requiredPlatforms].sort()).toEqual(targets.sort());
    expect([...ledger.releaseLanguages].sort()).toEqual(
      ['typescript', 'javascript', 'python', 'go', 'rust', 'java'].sort(),
    );
    expect(EffectRecord.keys(ledger.selectedProviders).sort()).toEqual([...ledger.releaseLanguages].sort());
    expect(new Set(EffectArray.map(ledger.providers, x => x.id)).size).toBe(ledger.providers.length);
    for (const provider of ledger.providers) {
      expect(provider.productionQualified).toBe(false);
      expect(EffectRecord.keys(provider.platforms).sort()).toEqual([...ledger.requiredPlatforms].sort());
    }
    for (const [language, id] of EffectRecord.toEntries(ledger.selectedProviders)) {
      const provider = EffectOption.getOrUndefined(EffectArray.findFirst(ledger.providers, x => x.id === id));
      expect(provider?.languages).toContain(language);
      expect(provider?.pilotEvidence?.length).toBeGreaterThan(0);
      for (const evidence of provider?.pilotEvidence ?? []) {
        expect(evidence.reportSha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(evidence.configSha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(EffectRecord.keys(evidence.sourceHashes).sort()).toEqual(
          ['harness', 'fixtures', 'transport', 'assertions', 'process'].sort(),
        );
        for (const hash of EffectRecord.values(evidence.sourceHashes)) expect(hash).toMatch(/^[a-f0-9]{64}$/u);
      }
    }
  });
  it('clamps each readiness request to the remaining overall deadline', async () => {
    // Promise/timer boundary: no real provider or wall-clock wait is involved.
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'performance']});
    try {
      const start = performance.now();
      const requests: {
        at: number;
        budget: number;
      }[] = [];
      let result: Awaited<ReturnType<typeof observeProbeReadiness>> | undefined;
      const pending = observeProbeReadiness(
        budget => {
          requests.push({at: performance.now(), budget});
          return new Promise(resolve => setTimeout(() => resolve(null), budget));
        },
        () => false,
        25000,
      ).then(value => {
        result = value;
      });
      await vi.advanceTimersByTimeAsync(25000);
      expect(result?.ready).toBe(false);
      expect(requests).toHaveLength(2);
      for (const request of requests) expect(request.at + request.budget).toBeLessThanOrEqual(start + 25000);
      await pending;
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
  it('bounds retained readiness observations without hiding the total attempt count', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'performance']});
    try {
      const pending = observeProbeReadiness(
        async () => null,
        () => false,
        10000,
      );
      await vi.advanceTimersByTimeAsync(10000);
      const result = await pending;
      expect(result.ready).toBe(false);
      expect(result.attemptCount).toBeGreaterThan(32);
      expect(result.attempts).toHaveLength(32);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
  it('rejects a logged provider panic or failed shutdown even with exit code zero', () => {
    const clean = {
      code: 0,
      forced: false,
      exitObserved: true,
      exitTimedOut: false,
      stderr: '',
      panicObserved: false,
      shutdownCompleted: true,
      stdioClosed: true,
      cleanup: {scope: 'posix-process-group', drained: true},
    };
    expect(checkProbeShutdown(clean)).toBe(true);
    expect(checkProbeShutdown({...clean, stderr: 'WARNING: incubator module'})).toBe(true);
    expect(
      checkProbeShutdown({
        ...clean,
        stderr: "thread 'Worker9' (21426371) panicked at crates/rust-analyzer/src/reload.rs:308",
      }),
    ).toBe(false);
    expect(checkProbeShutdown({...clean, shutdownError: 'request rejected'})).toBe(false);
    expect(checkProbeShutdown({...clean, exitObserved: false})).toBe(false);
    expect(checkProbeShutdown({...clean, shutdownCompleted: false})).toBe(false);
    expect(checkProbeShutdown({...clean, stdioClosed: false})).toBe(false);
    expect(checkProbeShutdown({...clean, panicObserved: true})).toBe(false);
  });
  it('retains panic observations across arbitrary stderr chunks and bounded tails', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.string({maxLength: 512}), fc.constantFrom('pani', 'cked at', 'panicked at')), {
          maxLength: 20,
        }),
        chunks => {
          const result = EffectArray.reduce(chunks, {stderr: '', panicObserved: false}, appendProbeStderr);
          const complete = EffectArray.join(chunks, '');
          expect(result).toEqual({
            stderr: EffectString.slice(-4096)(complete),
            panicObserved: EffectString.includes('panicked at')(complete),
          });
        },
      ),
      {numRuns: 100},
    );
  });
  it('rejects a final panic whose header has fallen outside the retained stderr tail', async () => {
    const peer = startSemanticProbe(
      process.execPath,
      [fileURLToPath(new URL('../fixtures/semantic/fake-provider.ts', import.meta.url)), 'panic-on-exit'],
      process.cwd(),
    );
    try {
      await peer.request('echo', {});
    } finally {
      const stopped = await peer.stop();
      expect(stopped).toMatchObject({code: 0, panicObserved: true, shutdownCompleted: true, stdioClosed: true});
      expect(stopped.stderr).toHaveLength(4096);
      expect(stopped.stderr).not.toContain('panicked at');
      expect(checkProbeShutdown(stopped)).toBe(false);
    }
  });
  it('rejects an exit-zero provider that terminates before the shutdown handshake', async () => {
    const peer = startSemanticProbe(
      process.execPath,
      [fileURLToPath(new URL('../fixtures/semantic/fake-provider.ts', import.meta.url))],
      process.cwd(),
    );
    try {
      await peer.request('exit-early', {});
      await expect(peer.request('hang', {}, 1000)).rejects.toThrow();
    } finally {
      const stopped = await peer.stop();
      expect(stopped).toMatchObject({code: 0, shutdownCompleted: false, stdioClosed: true});
      expect(stopped.shutdownError).toBeTypeOf('string');
      expect(checkProbeShutdown(stopped)).toBe(false);
    }
  });
  it.skipIf(process.platform === 'win32')('rejects final writes after the provider closes its input', async () => {
    const peer = startSemanticProbe(
      process.execPath,
      [fileURLToPath(new URL('../fixtures/semantic/fake-provider.ts', import.meta.url)), 'close-input-on-shutdown'],
      process.cwd(),
    );
    try {
      await peer.request('echo', {});
    } finally {
      const stopped = await peer.stop();
      expect(peer.events).toContain('probe/input-closed');
      expect(stopped).toMatchObject({shutdownCompleted: false, stdioClosed: true, cleanup: {drained: true}});
      expect(stopped.shutdownError).toBeTypeOf('string');
      expect(checkProbeShutdown(stopped)).toBe(false);
    }
  });
  it('observes provider notification payloads used for quiescence qualification', async () => {
    const observed: unknown[] = [];
    const peer = startSemanticProbe(
      process.execPath,
      [fileURLToPath(new URL('../fixtures/semantic/fake-provider.ts', import.meta.url))],
      process.cwd(),
      {},
      (method, params) => observed.push({method, params}),
    );
    try {
      const params = {health: 'ok', quiescent: true};
      await peer.request('emit-status', params);
      expect(observed).toContainEqual({method: 'experimental/serverStatus', params});
    } finally {
      expect(await peer.stop()).toMatchObject({code: 0, forced: false});
    }
  });
  it.each([
    ['typescript', 3],
    ['javascript', 3],
    ['python', 3],
    ['go', 2],
    ['rust', 4],
    ['java', 3],
  ] as const)('authors a deterministic two-file %s fixture with %i occurrences', (language, count) => {
    const fixture = providerFixture({language});
    expect(EffectRecord.keys(fixture.sources)).toHaveLength(2);
    expect(
      EffectOption.getOrNull(
        EffectString.match(/SavedName/gu)(EffectArray.join(EffectRecord.values(fixture.sources), '')),
      ),
    ).toHaveLength(count);
    expect(EffectArray.join(EffectRecord.values(fixture.sources), '')).toContain('🧵');
    for (const source of EffectRecord.values(fixture.sources)) {
      expect(EffectString.endsWith('\r\n')(source)).toBe(true);
      expect(EffectString.replaceAll('\r\n', '')(source)).not.toContain('\n');
    }
    const original = structuredClone(fixture);
    fixture.sources[EffectRecord.keys(fixture.sources)[0]] = 'changed';
    expect(providerFixture({language})).toEqual(original);
  });
  it('requires explicit build/import expectations and rejects mismatched fixture settings', () => {
    const decode = Schema.decodeUnknownSync(ProbeConfig, {onExcessProperty: 'error'});
    const base = {id: 'test', version: '1', command: 'provider', args: [], language: 'rust'};
    expect(decode(base).fixture).toBeUndefined();
    for (const extra of [
      {fixture: 'java-gradle', expectedBuildExecution: true},
      {fixture: 'rust-build-script'},
      {expectedBuildExecution: false},
      {buildScriptProbe: true},
      {language: 'kotlin'},
      {language: 'java'},
    ])
      expect(() => decode({...base, ...extra})).toThrow();
    for (const expectedBuildExecution of [false, true]) {
      const config = decode({...base, fixture: 'rust-build-script', expectedBuildExecution});
      const fixture = providerFixture(config);
      expect(fixture.executionMarker).toBe('probe-build-script-ran');
      expect(fixture.projectFiles['build.rs']).toContain('"executed"');
    }
    const gradle = providerFixture(
      decode({
        ...base,
        language: 'java',
        configurationTemplate: 'jdt',
        fixture: 'java-gradle',
        expectedBuildExecution: false,
      }),
    );
    expect(gradle.executionMarker).toBe('probe-gradle-import-ran');
    expect(gradle.runtimeFiles['gradle/gradle.properties']).toContain('idletimeout=1000');
    expect(gradle.projectFiles).not.toHaveProperty('pom.xml');
    expect(providerFixture({language: 'java'}).projectFiles).toHaveProperty('pom.xml');
  });
  it('expands settings string values without corrupting Windows paths or JSON syntax', () => {
    const scratch = 'C:\\temp\\"quoted"';
    expect(expandProbeScratch({'{scratch}': ['{scratch}/cache', null, 3]}, scratch)).toEqual({
      '{scratch}': [scratch + '/cache', null, 3],
    });
    fc.assert(
      fc.property(fc.jsonValue(), value => {
        const before = JSON.stringify(value);
        const expanded = expandProbeScratch(Schema.decodeUnknownSync(Schema.Json)(value), scratch);
        expect(expandProbeScratch(expanded, scratch)).toEqual(expanded);
        expect(JSON.stringify(value)).toBe(before);
        expect(JSON.stringify(JSON.parse(JSON.stringify(expanded)))).toBe(JSON.stringify(expanded));
      }),
      {numRuns: 100},
    );
  });
  it('does not qualify an incomplete reference set or rename preview', () => {
    const files = {'a.py': 'UnsavedName\r\n', 'b.py': 'UnsavedName\r\n'};
    const range = {start: {line: 0, character: 0}, end: {line: 0, character: 11}};
    const references = EffectArray.map(EffectRecord.keys(files), name => ({uri: `file:///fixture/${name}`, range}));
    expect(checkProbeReferences(files, references)).toBe(true);
    expect(checkProbeReferences(files, references.slice(0, 1))).toBe(false);
    expect(checkProbeReferences(files, [...references, references[0]])).toBe(false);
    expect(
      checkProbeReferences(
        files,
        EffectArray.map(references, x => ({...x, uri: EffectString.replace('/fixture/', '/another/')(x.uri)})),
      ),
    ).toBe(false);
    const changes = EffectRecord.fromEntries(
      EffectArray.map(references, x => [x.uri, [{range, newText: 'RenamedName'}]]),
    );
    expect(checkProbeRename(files, {changes})).toBe(true);
    expect(checkProbeRename(files, {changes: {'file:///fixture/a.py': changes['file:///fixture/a.py']}})).toBe(false);
    expect(checkProbeRename(files, {changes: {...changes, 'file:///fixture/escape.py': []}})).toBe(false);
    expect(checkProbeRename(files, {changes: {'file:///fixture/a.py': [{range, newText: 'SavedName'}]}})).toBe(false);
    expect(checkProbeRename(files, {changes, documentChanges: []})).toBe(false);
    const documentChanges = EffectArray.map(references, x => ({
      textDocument: {uri: x.uri, version: 2},
      edits: [{range, newText: 'RenamedName'}],
    }));
    expect(checkProbeRename(files, {documentChanges})).toBe(true);
    expect(
      checkProbeRename(files, {
        documentChanges: EffectArray.map(documentChanges, x => ({...x, textDocument: {...x.textDocument, version: 1}})),
      }),
    ).toBe(false);
    expect(checkProbeRename(files, {documentChanges: [{kind: 'delete', uri: references[0].uri}]})).toBe(false);
    expect(checkProbeDefinition(files, references[0])).toBe(true);
    expect(checkProbeDefinition(files, references[1])).toBe(false);
    expect(checkProbeDefinition(files, [{...references[0], range: {...range, end: {line: 0, character: 10}}}])).toBe(
      false,
    );
    expect(checkProbeDefinition(files, references)).toBe(false);
  });
  it('decodes Unicode JSON-RPC frames under arbitrary transport chunking', () => {
    fc.assert(
      fc.property(
        fc.array(fc.jsonValue(), {maxLength: 5}),
        fc.array(fc.integer({min: 1, max: 31}), {minLength: 1, maxLength: 10}),
        (values, sizes) => {
          const expected = EffectArray.map(values, (value, id) => ({jsonrpc: '2.0', id, result: value}));
          const bytes = Buffer.concat(EffectArray.map(expected, encodeProbeFrame));
          const decoder = new ProbeFrameDecoder();
          const actual = [];
          let step = 0;
          for (let offset = 0; offset < bytes.length;) {
            const end = Math.min(bytes.length, offset + sizes[step++ % sizes.length]);
            actual.push(...decoder.push(bytes.subarray(offset, end)));
            offset = end;
          }
          // JSON canonicalizes -0 to 0; compare wire values, not JavaScript-only number identity.
          expect(actual).toEqual(JSON.parse(JSON.stringify(expected)));
        },
      ),
      {numRuns: 100},
    );
  });
  it('counts UTF-8 bytes independently of UTF-16 positions and preserves CRLF', () => {
    const message = {jsonrpc: '2.0', id: 1, result: '🧵\r\n漢字'};
    const encoded = encodeProbeFrame(message);
    const decoder = new ProbeFrameDecoder();
    const actual = EffectArray.flatMap([...encoded], byte => decoder.push(Buffer.from([byte])));
    expect(actual).toEqual([message]);
    const files = {'a.ts': '/* 🧵 */ UnsavedName\r\n'};
    const range = {start: {line: 0, character: 9}, end: {line: 0, character: 20}};
    const location = {uri: 'file:///fixture/a.ts', range};
    expect(checkProbeReferences(files, [location])).toBe(true);
    expect(checkProbeRename(files, {changes: {[location.uri]: [{range, newText: 'RenamedName'}]}})).toBe(true);
    expect(
      checkProbeRename(files, {
        changes: {[location.uri]: [{range: {...range, start: {line: 0, character: 8}}, newText: 'RenamedName'}]},
      }),
    ).toBe(false);
  });
  it.each([
    'Content-Length: 1\r\nContent-Length: 1\r\n\r\n0',
    'Content-Length: -1\r\n\r\n',
    'Content-Length: 999999999999999999999\r\n\r\n',
    'Content-Length: 2\r\n\r\n[]',
  ])('rejects malformed or excessive framing', bytes => {
    expect(() => new ProbeFrameDecoder(256).push(Buffer.from(bytes))).toThrow();
  });
  it('bounds an unfinished header', () => {
    expect(() => new ProbeFrameDecoder().push(Buffer.alloc(8193, 65))).toThrow('header');
  });
  it('cancels a timed-out request and cleanly stops the owned process', async () => {
    // OS child-process boundary: this deliberately uses plain async Vitest.
    const peer = startSemanticProbe(
      process.execPath,
      [fileURLToPath(new URL('../fixtures/semantic/fake-provider.ts', import.meta.url))],
      process.cwd(),
    );
    try {
      expect(await peer.request('echo', {text: '🧵\r\n'})).toEqual({text: '🧵\r\n'});
      await expect(peer.request('hang', {}, 20)).rejects.toThrow('timeout');
    } finally {
      expect(await peer.stop()).toMatchObject({code: 0, forced: false});
    }
    expect(peer.events).toContain('probe/cancelled');
  });
  it.skipIf(process.platform === 'win32')('reaps an owned descendant after its provider leader exits', async () => {
    const peer = startSemanticProbe(
      process.execPath,
      [fileURLToPath(new URL('../fixtures/semantic/fake-provider.ts', import.meta.url))],
      process.cwd(),
    );
    let pid: number | undefined;
    try {
      pid = Schema.decodeUnknownSync(Schema.Finite)(await peer.request('spawn-descendant', {}));
    } finally {
      expect(await peer.stop()).toMatchObject({
        code: 0,
        forced: true,
        cleanup: {scope: 'posix-process-group', drained: true},
      });
    }
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
