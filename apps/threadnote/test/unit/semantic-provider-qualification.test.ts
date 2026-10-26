import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {
  ProbeFrameDecoder,
  encodeProbeFrame,
  startSemanticProbe,
} from '../../../../tools/semantic/semantic_lsp_probe.js';
import {
  checkProbeDefinition,
  checkProbeReferences,
  checkProbeRename,
} from '../../../../tools/semantic/semantic_probe_assertions.js';

describe('disposable semantic provider qualification', () => {
  it('does not qualify an incomplete reference set or rename preview', () => {
    const files = {'a.py': 'UnsavedName\r\n', 'b.py': 'UnsavedName\r\n'};
    const range = {start: {line: 0, character: 0}, end: {line: 0, character: 11}};
    const references = Object.keys(files).map(name => ({uri: `file:///fixture/${name}`, range}));
    expect(checkProbeReferences(files, references)).toBe(true);
    expect(checkProbeReferences(files, references.slice(0, 1))).toBe(false);
    expect(checkProbeReferences(files, [...references, references[0]])).toBe(false);
    expect(
      checkProbeReferences(
        files,
        references.map(x => ({...x, uri: x.uri.replace('/fixture/', '/another/')})),
      ),
    ).toBe(false);
    const changes = Object.fromEntries(references.map(x => [x.uri, [{range, newText: 'RenamedName'}]]));
    expect(checkProbeRename(files, {changes})).toBe(true);
    expect(checkProbeRename(files, {changes: {'file:///fixture/a.py': changes['file:///fixture/a.py']}})).toBe(false);
    expect(checkProbeRename(files, {changes: {...changes, 'file:///fixture/escape.py': []}})).toBe(false);
    expect(checkProbeRename(files, {changes: {'file:///fixture/a.py': [{range, newText: 'SavedName'}]}})).toBe(false);
    expect(checkProbeRename(files, {changes, documentChanges: []})).toBe(false);
    const documentChanges = references.map(x => ({
      textDocument: {uri: x.uri, version: 2},
      edits: [{range, newText: 'RenamedName'}],
    }));
    expect(checkProbeRename(files, {documentChanges})).toBe(true);
    expect(
      checkProbeRename(files, {
        documentChanges: documentChanges.map(x => ({...x, textDocument: {...x.textDocument, version: 1}})),
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
          const expected = values.map((value, id) => ({jsonrpc: '2.0', id, result: value}));
          const bytes = Buffer.concat(expected.map(encodeProbeFrame));
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
    const actual = [...encoded].flatMap(byte => decoder.push(Buffer.from([byte])));
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
      pid = (await peer.request('spawn-descendant', {})) as number;
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
