import * as EffectString from 'effect/String';
import * as EffectRecord from 'effect/Record';
import {Array as EffectArray} from 'effect';
import {describe, expect, it, vi} from 'vitest';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Option, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {Database} from 'bun:sqlite';
import {serializeBoundedCodeGraphFact} from '@threadnote/graph/fact/budget';
import {encodeStoredCodeGraphFact} from '@threadnote/graph/fact/storage';
import * as storage from '@threadnote/graph/fact/storage';
import * as compression from 'fflate';
import fc from 'fast-check';
vi.mock('fflate', {spy: true});
import {
  readCodeGraphNavigationFacts,
  navigationFactMetadataSql,
  NAVIGATION_PROOF_CACHE_IDENTITY,
} from '@threadnote/graph/query/navigation_facts';
import {packCacheIdentity} from '@threadnote/graph/languages/registry';
import {codeGraphLanguagePack} from '@threadnote/graph/languages/typescript/pack';
import type {CodeGraphQueryResult} from '@threadnote/graph/types';
import {citationPlatformLayer} from '../helpers/citation-platform.js';
import {extractFileFacts} from '@threadnote/graph/extractor';
import {createNavigationFactCollector} from '@threadnote/graph/navigation_facts';
import {loadTypeScriptExtractionRuntime} from '@threadnote/graph/typescript_runtime';
import * as graphSession from '@threadnote/graph/store/session';
import {sha256HexSync} from '@threadnote/platform/sha256';
const source =
  "import {writeFile as persistFile} from 'node:fs/promises';\nexport async function saveNote(path: string, text: string, persist: boolean) {\n  if (persist) {\n    await persistFile(path, text);\n  }\n  return text;\n}\n";
function facts(content = source, path = 'operation.ts') {
  return extractFileFacts({
    blobId: EffectString.repeat(40)('a'),
    content,
    contentHash: sha256HexSync(content),
    language: 'typescript',
    mode: '100644',
    path,
    size: new TextEncoder().encode(content).byteLength,
    source: 'worktree',
  });
}
describe('finite graph navigation facts', () => {
  it('retains the canonical import, owner, target and enclosing if as source syntax', () => {
    expect(facts()).toMatchObject({
      navigationFacts: {
        version: 1,
        omitted: false,
        proofs: [
          {
            module: 'node:fs/promises',
            imported: 'writeFile',
            local: 'persistFile',
            importSpan: {line: 1},
            ownerSpan: {line: 2, endLine: 7},
            callSpan: {line: 4},
            calleeSpan: {line: 4},
            targetSpan: {line: 4},
            guard: {span: {line: 3}, branch: 'then'},
          },
        ],
      },
    });
  });
});
const refused = [
  ...EffectArray.map(
    [
      'return;',
      "throw new Error('blocked');",
      'for (;;) {}',
      'switch (persist) {default: break;}',
      'try {} finally {}',
    ],
    statement => [
      `unsupported branch sibling ${statement}`,
      EffectString.replace('    await persistFile', `    ${statement}\n    await persistFile`)(source),
    ],
  ),
  ['owner return before guard', EffectString.replace('  if (persist)', '  return text;\n  if (persist)')(source)],
  [
    'throwing initializer',
    EffectString.replace(
      '  if (persist)',
      "  const blocked = (() => {throw new Error('blocked');})();\n  if (persist)",
    )(source),
  ],
  ['for-of rebind', 'for (persistFile of [() => 0]) {}\n' + source],
  ['for-in rebind', 'for (persistFile in {}) {}\n' + source],
  ['destructured for-of rebind', 'for ({persistFile} of []) {}\n' + source],
  ['non-async owner', EffectString.replace('export async function', 'export function')(source)],
  ['generator owner', EffectString.replace('export async function', 'export async function*')(source)],
  ['parameter shadow', EffectString.replace('persist: boolean)', 'persist: boolean, persistFile: Function)')(source)],
  [
    'block shadow',
    EffectString.replace(
      'if (persist) {',
      'if (persist) { const persistFile = async (...args: unknown[]) => args;',
    )(source),
  ],
  ['destructuring rebind', source + "({persistFile} = {persistFile: () => 'pure'});\n"],
  ['module collision', source + "const persistFile = () => 'pure';\n"],
  ['module hoisted var', "if (false) {var persistFile = () => 'pure';}\n" + source],
  ['type import', EffectString.replace('import {', 'import type {')(source)],
  ['type specifier', EffectString.replace('import {writeFile', 'import {type writeFile')(source)],
  ['reassignment', EffectString.replace('  if (persist)', "  persistFile = () => 'pure';\n  if (persist)")(source)],
  [
    'nested guard',
    EffectString.replace('await persistFile(path, text);', 'if (text) {await persistFile(path, text);} ')(source),
  ],
  ['optional call', EffectString.replace('persistFile(path, text)', 'persistFile?.(path, text)')(source)],
  ['namespace alias', EffectString.replace('{writeFile as persistFile}', '* as persistFile')(source)],
  [
    'nested owner',
    EffectString.replace('export async function', 'export function outer() { async function')(source) + '}',
  ],
  ['parse error', source + '{'],
];
for (const [name, content] of refused)
  it(`refuses ${name}`, () => expect(facts(content).navigationFacts?.proofs ?? []).toEqual([]));
const importEqualsDeclarations = [
  'import persistFile = require("pure");',
  'import persistFile = Pure.persistFile;',
  'import type persistFile = require("pure");',
  'import type persistFile = Pure.persistFile;',
  'export import persistFile = require("pure");',
  'export import persistFile = Pure.persistFile;',
];
for (const declaration of importEqualsDeclarations) {
  it(`refuses the conflicting module binding ${declaration}`, () => {
    expect(facts(source + declaration).navigationFacts).toEqual({version: 1, omitted: false, proofs: []});
  });
  it(`retains canonical proof beside unrelated ${declaration}`, () => {
    const unrelated = EffectString.replace('persistFile =', 'unrelated =')(declaration);
    expect(facts(source + unrelated).navigationFacts?.proofs).toHaveLength(1);
  });
}
it('retains canonical proof beside an export-only alias', () => {
  expect(facts(source + 'export {pure as persistFile} from "pure";').navigationFacts?.proofs).toHaveLength(1);
});
function storeFixture(variant: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'navigation-fact-query-'});
    const databasePath = path.join(root, 'graph.sqlite');
    const db = yield* Effect.acquireRelease(
      Effect.sync(() => new Database(databasePath)),
      value => Effect.sync(() => value.close()),
    );
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE snapshots(id TEXT PRIMARY KEY, repository_id TEXT, worktree_id TEXT, commit_id TEXT, dirty INTEGER, state TEXT, extractor_set TEXT, base_snapshot_id TEXT);
      CREATE TABLE snapshot_files(snapshot_id TEXT, path TEXT, content_hash TEXT, PRIMARY KEY(snapshot_id,path));
      CREATE TABLE file_blobs(content_hash TEXT, extractor_set TEXT, path_hint TEXT, facts_json TEXT, PRIMARY KEY(content_hash,extractor_set,path_hint));
      CREATE TABLE file_blob_authority(extractor_set TEXT,path_hint TEXT,content_hash TEXT,PRIMARY KEY(extractor_set,path_hint,content_hash));
      CREATE TABLE snapshot_pack_provenance(snapshot_id TEXT,pack_id TEXT,cache_identity TEXT,resolution_domain TEXT,resolution_version TEXT);
      CREATE TABLE snapshot_extractor_generations(snapshot_id TEXT PRIMARY KEY,generation INTEGER);
      CREATE TABLE removed_views(worktree_id TEXT,expected_snapshot_id TEXT);
      CREATE INDEX removed_view_worktree ON removed_views(worktree_id);
      CREATE INDEX pack_snapshot ON snapshot_pack_provenance(snapshot_id,pack_id);
      CREATE TABLE snapshot_file_deletions(snapshot_id TEXT,path TEXT,PRIMARY KEY(snapshot_id,path));
      CREATE TABLE snapshot_symbol_deletions(snapshot_id TEXT,symbol_id TEXT,PRIMARY KEY(snapshot_id,symbol_id));
      CREATE TABLE snapshot_edge_deletions(snapshot_id TEXT,edge_id TEXT,PRIMARY KEY(snapshot_id,edge_id));
      CREATE TABLE symbols(snapshot_id TEXT,id TEXT,path TEXT,content_hash TEXT,kind TEXT,span_json TEXT,PRIMARY KEY(snapshot_id,id));
      CREATE TABLE edges(snapshot_id TEXT,id TEXT,source_id TEXT,target_name TEXT,evidence_path TEXT,evidence_span_json TEXT,relation TEXT,provenance TEXT,PRIMARY KEY(snapshot_id,id));`);
    db.query('INSERT INTO snapshot_pack_provenance VALUES(?,?,?,?,?)').run(
      'snapshot',
      'typescript',
      NAVIGATION_PROOF_CACHE_IDENTITY,
      'typescript',
      'typescript-modules-v2-published-surface',
    );
    db.query('INSERT INTO snapshot_extractor_generations VALUES(?,?)').run('snapshot', 14);
    db.query(
      'INSERT INTO snapshots(id,repository_id,worktree_id,commit_id,dirty,state,extractor_set) VALUES(?,?,?,?,?,?,?)',
    ).run('snapshot', 'repository', 'worktree', 'commit', 0, 'ready', 'extractor');
    const paths =
      variant === 'stored aggregate' || variant === 'raw aggregate' ? ['operation.ts', 'second.ts'] : ['operation.ts'];
    const extracted = EffectArray.map(paths, file => facts(source, file));
    const nodes = EffectArray.flatMap(extracted, file =>
      EffectArray.map(file.symbols, symbol => ({...symbol, rank: 0, score: 1})),
    );
    const result: CodeGraphQueryResult = {
      repository: {repositoryId: 'repository', displayName: 'fixture'},
      snapshot: {id: 'snapshot', worktreeId: 'worktree', commit: 'commit', dirty: false},
      freshness: 'current',
      operation: 'node',
      nodes,
      edges: EffectArray.flatMap(extracted, file => file.edges),
      trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
      warnings: [],
      version: 1,
    };
    for (const file of extracted) {
      const rich = EffectString.endsWith('aggregate')(variant)
        ? {...file, diagnostics: [EffectString.repeat(600000)('x')]}
        : file;
      let json = serializeBoundedCodeGraphFact(rich).json;
      if (variant === 'raw aggregate') json = encodeStoredCodeGraphFact(serializeBoundedCodeGraphFact(rich)).json;
      if (variant === 'raw oversize')
        json = JSON.stringify({...file, diagnostics: [EffectString.repeat(1100000)('x')]});
      if (
        EffectArray.contains(
          [
            'declared oversize',
            'declared above codec maximum',
            'declared maximum safe',
            'declared unsafe',
            'declared fractional',
            'declared nonnumeric',
          ],
          variant,
        )
      )
        json = JSON.stringify({
          codec: 'zlib-base64-v1',
          path: file.path,
          pathOccurrences: 1,
          payload: 'AAAA',
          rawBytes:
            variant === 'declared above codec maximum'
              ? 8388609
              : variant === 'declared maximum safe'
                ? Number.MAX_SAFE_INTEGER
                : variant === 'declared unsafe'
                  ? Number.MAX_SAFE_INTEGER + 1
                  : variant === 'declared fractional'
                    ? 1024.5
                    : variant === 'declared nonnumeric'
                      ? 'huge'
                      : 1048577,
          sha256: EffectString.repeat(64)('0'),
        });
      if (variant === 'lying header') {
        const envelope = {
          codec: 'zlib-base64-v1',
          path: file.path,
          pathOccurrences: 1,
          payload: '',
          rawBytes: 1024,
          sha256: EffectString.repeat(64)('0'),
        };
        envelope.payload = EffectString.repeat(2097323 - Buffer.byteLength(JSON.stringify(envelope)))('A');
        json = JSON.stringify(envelope);
        expect(Buffer.byteLength(json)).toBe(2097323);
      }
      if (variant === 'malformed') json = '{';
      if (variant === 'old capability') {
        const {navigationFacts: _proof, ...old} = file;
        json = serializeBoundedCodeGraphFact(old).json;
      }
      const hash = sha256HexSync(source);
      db.query('INSERT INTO snapshot_files VALUES(?,?,?)').run('snapshot', file.path, hash);
      db.query('INSERT INTO file_blobs VALUES(?,?,?,?)').run(hash, NAVIGATION_PROOF_CACHE_IDENTITY, file.path, json);
      db.query('INSERT INTO file_blob_authority VALUES(?,?,?)').run(NAVIGATION_PROOF_CACHE_IDENTITY, file.path, hash);
      for (const symbol of file.symbols)
        db.query('INSERT INTO symbols VALUES(?,?,?,?,?,?)').run(
          'snapshot',
          symbol.id,
          symbol.path,
          symbol.contentHash,
          symbol.kind,
          JSON.stringify(symbol.span),
        );
      for (const edge of file.edges)
        db.query('INSERT INTO edges VALUES(?,?,?,?,?,?,?,?)').run(
          'snapshot',
          edge.id,
          edge.sourceId ?? null,
          edge.targetName,
          edge.evidencePath,
          JSON.stringify(edge.evidenceSpan),
          edge.relation,
          edge.provenance,
        );
    }
    return {
      db,
      databasePath,
      result,
      selectors: EffectArray.map(paths, file => ({path: file, contentHash: sha256HexSync(source)})),
    };
  });
}
const envelopeFields = {
  codec: '"zlib-base64-v1"',
  path: '"operation.ts"',
  pathOccurrences: '1',
  payload: '"AAAA"',
  rawBytes: '1024',
  sha256: JSON.stringify(EffectString.repeat(64)('0')),
};
const duplicateHeaderFields = [
  ['codec', '"raw"', '"zlib-base64-v1"'],
  ['rawBytes', '1024', '2097152'],
  ['path', '"operation.ts"', '"other.ts"'],
  ['pathOccurrences', '1', '2'],
  ['payload', '"AAAA"', '"BBBB"'],
  ['sha256', JSON.stringify(EffectString.repeat(64)('0')), JSON.stringify(EffectString.repeat(64)('1'))],
  ['type', '"raw"', '"compressed"'],
  ['version', '1', '2'],
] as const;
function duplicateHeaderJson(
  key: string,
  first: string,
  last: string,
  escapeAt?: number,
  reverse = false,
  escapeFirst = false,
  position = 0,
  encodedKey?: string,
) {
  const escaped =
    encodedKey ??
    (escapeAt === undefined
      ? key
      : EffectString.slice(0, escapeAt)(key) +
        '\\u' +
        EffectString.padStart(4, '0')(Option.getOrThrow(EffectString.charCodeAt(escapeAt)(key)).toString(16)) +
        EffectString.slice(escapeAt + 1)(key));
  const entries = EffectArray.map(
    EffectArray.filter(EffectRecord.toEntries(envelopeFields), ([name]) => name !== key),
    ([name, value]) => `${JSON.stringify(name)}:${value}`,
  );
  const offset = position % (entries.length + 1);
  return `{${EffectArray.join(
    [
      ...entries.slice(0, offset),
      `"${escapeFirst ? escaped : key}":${reverse ? last : first}`,
      ...entries.slice(offset),
      `"${escapeFirst ? key : escaped}":${reverse ? first : last}`,
    ],
    ',',
  )}}`;
}
function controlHeaderKey(key: string, code: number, position: number, suffix: boolean, unicode: boolean) {
  const character = String.fromCharCode(code);
  const left = EffectString.slice(0, position)(key);
  const right = (suffix ? 'suffix' : '') + EffectString.slice(position)(key);
  const encoded = unicode
    ? '\\u' + EffectString.padStart(4, '0')(code.toString(16))
    : EffectString.slice(1, -1)(JSON.stringify(character));
  return {key: left + character + right, encoded: left + encoded + right};
}
effectIt.layer(citationPlatformLayer)(it => {
  it.effect('rejects duplicate security headers before payload transfer or any oversized decoder allocation', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* storeFixture('valid');
        const decode = vi.spyOn(storage, 'decodeStoredCodeGraphFact');
        const json = vi.spyOn(JSON, 'parse');
        const base64 = vi.spyOn(Buffer, 'from');
        const inflate = vi.spyOn(compression, 'unzlibSync');
        const NativeUint8Array = globalThis.Uint8Array;
        const oversizedAllocations: number[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            globalThis.Uint8Array = NativeUint8Array;
            decode.mockRestore();
            json.mockRestore();
            base64.mockRestore();
            inflate.mockRestore();
          }),
        );
        globalThis.Uint8Array = new Proxy(NativeUint8Array, {
          construct(target, args, newTarget) {
            if (typeof args[0] === 'number' && args[0] > 1048576) oversizedAllocations.push(args[0]);
            return Reflect.construct(target, args, newTarget);
          },
        });
        const cases = [
          duplicateHeaderJson('rawBytes', '1024', '2097152'),
          duplicateHeaderJson('rawBytes', '1024', '8388609'),
          EffectString.replace(
            '"rawBytes":1024',
            '"rawBytes":2097152',
          )(duplicateHeaderJson('codec', '"raw"', '"zlib-base64-v1"')),
          ...EffectArray.flatMap(duplicateHeaderFields, ([key, first, last]) =>
            EffectArray.flatMap([false, true], reverse => [
              duplicateHeaderJson(key, first, last, undefined, reverse),
              duplicateHeaderJson(key, first, last, 0, reverse),
              duplicateHeaderJson(key, first, last, 0, reverse, true),
            ]),
          ),
          duplicateHeaderJson('rawBytes', '1024', '2097152', undefined, false, true, 0, 'rawBytes\\u0000suffix'),
          duplicateHeaderJson('rawBytes', '1024', '2097152', undefined, false, true, 0, 'rawBytes\\u0000'),
          EffectString.replace(
            '"rawBytes":1024',
            '"rawBytes":2097152',
          )(duplicateHeaderJson('codec', '"raw"', '"zlib-base64-v1"', undefined, false, true, 0, 'codec\\u0000suffix')),
          ...EffectArray.flatMap(duplicateHeaderFields, ([key, first, last]) =>
            EffectArray.flatMap([false, true], suffix =>
              EffectArray.flatMap([false, true], reverse =>
                EffectArray.map([false, true], collisionFirst =>
                  duplicateHeaderJson(
                    key,
                    first,
                    last,
                    undefined,
                    reverse,
                    collisionFirst,
                    0,
                    controlHeaderKey(key, 0, key.length, suffix, true).encoded,
                  ),
                ),
              ),
            ),
          ),
        ];
        const header =
          '{' +
          EffectArray.join(
            EffectArray.map(
              EffectRecord.toEntries(envelopeFields),
              ([key, value]) => `${JSON.stringify(key)}:${value}`,
            ),
            ',',
          ) +
          '}';
        const repeated = '"type":1,';
        const repeatedCount = Math.floor((1048576 - Buffer.byteLength(header)) / repeated.length);
        const dense = '{' + EffectString.repeat(repeatedCount)(repeated) + EffectString.slice(1)(header);
        expect(repeatedCount).toBeGreaterThan(100000);
        expect(Buffer.byteLength(dense)).toBeLessThanOrEqual(1048576);
        cases.push(dense);
        cases.push('{' + EffectString.repeat(10000)('"unrelated\\u0000suffix":1,') + EffectString.slice(1)(header));
        for (const storedJson of cases) {
          fixture.db.query('UPDATE file_blobs SET facts_json=?').run(storedJson);
          decode.mockClear();
          json.mockClear();
          base64.mockClear();
          inflate.mockClear();
          oversizedAllocations.length = 0;
          let remaining = 2;
          const read = yield* readCodeGraphNavigationFacts({
            ...fixture,
            acquireRead: Effect.sync(() => remaining-- > 0),
          });
          expect(read.files[0].state).not.toBe('available');
          expect(read.counters).toMatchObject({
            metadataReads: 1,
            payloadReads: 0,
            payloadRows: 0,
            storedBytes: 0,
            declaredRawBytes: 0,
            decodedBytes: 0,
          });
          expect(remaining).toBe(1);
          expect(decode).not.toHaveBeenCalled();
          expect(EffectArray.filter(json.mock.calls, ([text]) => text === storedJson)).toEqual([]);
          expect(EffectArray.filter(base64.mock.calls, args => EffectArray.contains(args, 'base64'))).toEqual([]);
          expect(inflate).not.toHaveBeenCalled();
          expect(oversizedAllocations).toEqual([]);
        }
      }),
    ),
  );
  it.effect('duplicate-key insertion and ordering always invalidate SQL header admission', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* storeFixture('valid');
        const differential = '{"rawBytes":1024,"ra\\u0077Bytes":2097152}';
        expect(fixture.db.query("SELECT json_extract(?, '$.rawBytes') AS bytes").get(differential)).toEqual({
          bytes: 1024,
        });
        expect(JSON.parse(differential)).toEqual({rawBytes: 2097152});
        expect(fixture.db.query('SELECT key FROM json_each(?)').all(differential)).toEqual([
          {key: 'rawBytes'},
          {key: 'rawBytes'},
        ]);
        fc.assert(
          fc.property(
            fc.constantFrom(...duplicateHeaderFields),
            fc.nat({max: 32}),
            fc.boolean(),
            fc.boolean(),
            fc.nat({max: 6}),
            (field, index, reverse, escapeFirst, position) => {
              const [key, first, last] = field;
              const storedJson = duplicateHeaderJson(
                key,
                first,
                last,
                index % key.length,
                reverse,
                escapeFirst,
                position,
              );
              expect(JSON.parse(storedJson)).toHaveProperty(key, JSON.parse(reverse ? first : last));
              expect(fixture.db.query('SELECT key FROM json_each(?) WHERE key=?').all(storedJson, key)).toEqual([
                {key},
                {key},
              ]);
              fixture.db.query('UPDATE file_blobs SET facts_json=?').run(storedJson);
              const rows = fixture.db
                .query(navigationFactMetadataSql)
                .all(
                  'snapshot',
                  'repository',
                  'worktree',
                  'commit',
                  0,
                  JSON.stringify(fixture.selectors),
                  JSON.stringify(EffectArray.map(fixture.result.nodes, node => node.id)),
                  JSON.stringify(EffectArray.map(fixture.result.edges, edge => edge.id)),
                );
              expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({kind: 'fact', valid: 0})]));
            },
          ),
          {numRuns: 80},
        );
      }),
    ),
  );
  it.effect('retains canonical compressed facts under the unchanged raw and stored byte reservations', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* storeFixture('valid');
        const encoded = encodeStoredCodeGraphFact(serializeBoundedCodeGraphFact(facts()));
        expect(encoded.codec).toBe('zlib-base64-v1');
        fixture.db.query('UPDATE file_blobs SET facts_json=?').run(encoded.json);
        let remaining = 2;
        const read = yield* readCodeGraphNavigationFacts({...fixture, acquireRead: Effect.sync(() => remaining-- > 0)});
        expect(read.files[0].state).toBe('available');
        expect(read.files[0].facts?.proofs).toHaveLength(1);
        expect(read.counters).toMatchObject({
          metadataReads: 1,
          payloadReads: 1,
          payloadRows: 1,
          storedBytes: encoded.storedBytes,
          declaredRawBytes: encoded.rawBytes,
          decodedBytes: encoded.rawBytes,
        });
        expect(remaining).toBe(0);
      }),
    ),
  );
  it.effect('NUL and control-key encodings preserve the SQL/JS admission boundary', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* storeFixture('valid');
        const differential = '{"rawBytes\\u0000suffix":1024,"rawBytes":2097152}';
        expect(fixture.db.query("SELECT json_extract(?, '$.rawBytes') AS bytes").get(differential)).toEqual({
          bytes: 1024,
        });
        expect(JSON.parse(differential)).toEqual({'rawBytes\0suffix': 1024, rawBytes: 2097152});
        expect(fixture.db.query('SELECT key, instr(key, char(0)) AS nul FROM json_each(?)').all(differential)).toEqual([
          {key: 'rawBytes\0suffix', nul: 9},
          {key: 'rawBytes', nul: 0},
        ]);
        fc.assert(
          fc.property(
            fc.constantFrom(...duplicateHeaderFields),
            fc.oneof(fc.constant(0), fc.integer({min: 0, max: 31})),
            fc.nat({max: 32}),
            fc.boolean(),
            fc.boolean(),
            fc.boolean(),
            fc.boolean(),
            (field, code, index, suffix, unicode, reverse, collisionFirst) => {
              const [key, first, last] = field;
              const position = index % (key.length + 1);
              const changed = controlHeaderKey(key, code, position, suffix, unicode);
              const storedJson = duplicateHeaderJson(
                key,
                first,
                last,
                undefined,
                reverse,
                collisionFirst,
                index,
                changed.encoded,
              );
              const canonicalValue = JSON.parse(collisionFirst ? (reverse ? first : last) : reverse ? last : first);
              const changedValue = JSON.parse(collisionFirst ? (reverse ? last : first) : reverse ? first : last);
              expect(JSON.parse(storedJson)).toMatchObject({[key]: canonicalValue, [changed.key]: changedValue});
              const keys = fixture.db
                .query('SELECT hex(key) AS hex, instr(key, char(0)) AS nul FROM json_each(?)')
                .all(storedJson);
              expect(keys).toEqual(
                expect.arrayContaining([
                  {
                    hex: EffectString.toUpperCase(Buffer.from(changed.key).toString('hex')),
                    nul: code === 0 ? position + 1 : 0,
                  },
                ]),
              );
              if (code !== 0)
                expect(fixture.db.query('SELECT json_extract(?, ?) AS value').get(storedJson, '$.' + key)).toEqual({
                  value: canonicalValue,
                });
              fixture.db.query('UPDATE file_blobs SET facts_json=?').run(storedJson);
              const rows = fixture.db
                .query(navigationFactMetadataSql)
                .all(
                  'snapshot',
                  'repository',
                  'worktree',
                  'commit',
                  0,
                  JSON.stringify(fixture.selectors),
                  JSON.stringify(EffectArray.map(fixture.result.nodes, node => node.id)),
                  JSON.stringify(EffectArray.map(fixture.result.edges, edge => edge.id)),
                );
              if (code === 0)
                expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({kind: 'fact', valid: 0})]));
            },
          ),
          {numRuns: 80},
        );
      }),
    ),
  );
  it.effect('reserves only the valid sibling when a batch contains a duplicate-header row', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* storeFixture('stored aggregate');
        fixture.db
          .query("UPDATE file_blobs SET facts_json=? WHERE path_hint='operation.ts'")
          .run(duplicateHeaderJson('rawBytes', '1024', '2097152'));
        let remaining = 2;
        const read = yield* readCodeGraphNavigationFacts({...fixture, acquireRead: Effect.sync(() => remaining-- > 0)});
        expect(read.files[0]).toMatchObject({
          path: 'operation.ts',
          state: 'conflict',
          gap: 'navigation-fact-metadata-invalid',
        });
        expect(read.files[1]).toMatchObject({path: 'second.ts', state: 'available'});
        expect(read.files[1].facts?.proofs).toHaveLength(1);
        expect(read.counters).toMatchObject({metadataReads: 1, payloadReads: 1, payloadRows: 1});
        expect(read.counters.storedBytes).toBeGreaterThan(600000);
        expect(read.counters.storedBytes).toBeLessThanOrEqual(1048576);
        expect(read.counters.declaredRawBytes).toBe(read.counters.storedBytes);
        expect(read.counters.decodedBytes).toBe(read.counters.storedBytes);
        expect(remaining).toBe(0);
      }),
    ),
  );
  it.effect('retains raw and compressed proof when NUL occurs only in a fact value', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* storeFixture('valid');
        const bounded = serializeBoundedCodeGraphFact({...facts(), diagnostics: ['contains\0value']});
        const compressed = encodeStoredCodeGraphFact(bounded);
        expect(compressed.codec).toBe('zlib-base64-v1');
        for (const storedJson of [bounded.json, compressed.json]) {
          fixture.db.query('UPDATE file_blobs SET facts_json=?').run(storedJson);
          let remaining = 2;
          const read = yield* readCodeGraphNavigationFacts({
            ...fixture,
            acquireRead: Effect.sync(() => remaining-- > 0),
          });
          expect(read.files[0].state).toBe('available');
          expect(read.files[0].facts?.proofs).toHaveLength(1);
          expect(read.counters).toMatchObject({
            metadataReads: 1,
            payloadReads: 1,
            payloadRows: 1,
            declaredRawBytes: bounded.bytes,
            decodedBytes: bounded.bytes,
          });
          expect(remaining).toBe(0);
        }
      }),
    ),
  );
  for (const variant of [
    'valid',
    'raw oversize',
    'declared oversize',
    'declared above codec maximum',
    'declared maximum safe',
    'declared unsafe',
    'declared fractional',
    'declared nonnumeric',
    'lying header',
    'malformed',
    'stored aggregate',
    'raw aggregate',
    'old capability',
  ]) {
    it.effect(`ready navigation fact read: ${variant}`, () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fixture = yield* storeFixture(variant);
          let remaining = 2;
          const decode = vi.spyOn(storage, 'decodeStoredCodeGraphFact');
          const json = vi.spyOn(JSON, 'parse');
          const base64 = vi.spyOn(Buffer, 'from');
          const inflate = vi.spyOn(compression, 'unzlibSync');
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              decode.mockRestore();
              json.mockRestore();
              base64.mockRestore();
              inflate.mockRestore();
            }),
          );
          const read = yield* readCodeGraphNavigationFacts({
            ...fixture,
            acquireRead: Effect.sync(() => remaining-- > 0),
          });
          expect(read.counters.metadataReads).toBe(1);
          if (
            EffectArray.contains(
              [
                'raw oversize',
                'declared oversize',
                'declared above codec maximum',
                'declared maximum safe',
                'declared unsafe',
                'declared fractional',
                'declared nonnumeric',
                'lying header',
                'malformed',
              ],
              variant,
            )
          ) {
            expect(read.files[0].state).not.toBe('available');
            expect(read.counters).toMatchObject({
              payloadReads: 0,
              payloadRows: 0,
              storedBytes: 0,
              declaredRawBytes: 0,
              decodedBytes: 0,
            });
            expect(decode).not.toHaveBeenCalled();
            expect(
              EffectArray.filter(
                json.mock.calls,
                ([text]) => typeof text === 'string' && /"(?:codec|diagnostics)"/.test(text),
              ),
            ).toEqual([]);
            expect(EffectArray.filter(base64.mock.calls, args => EffectArray.contains(args, 'base64'))).toEqual([]);
            expect(inflate).not.toHaveBeenCalled();
          } else if (EffectString.endsWith('aggregate')(variant)) {
            expect(read.files[0].state).toBe('available');
            expect(read.files[1].state).toBe('omitted');
            expect(read.counters.payloadRows).toBe(1);
            expect(decode).toHaveBeenCalledTimes(1);
          } else {
            expect(read.files[0].state).toBe(variant === 'valid' ? 'available' : 'unsupported');
            expect(read.counters.payloadRows).toBe(1);
            expect(remaining).toBe(0);
          }
        }),
      ),
    );
  }
  it.effect('deduplicates exact selectors before applying the three-file limit', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* storeFixture('valid');
        const read = yield* readCodeGraphNavigationFacts({
          ...fixture,
          selectors: [fixture.selectors[0], fixture.selectors[0], fixture.selectors[0], fixture.selectors[0]],
          acquireRead: Effect.succeed(true),
        });
        expect(read.files).toHaveLength(1);
        expect(read.files[0].state).toBe('available');
        expect(read.counters.payloadRows).toBe(1);
      }),
    ),
  );
  for (const variant of [
    'envelope',
    'policy',
    'previous binding policy',
    'generation',
    'missing pack',
    'duplicate pack',
    'authority',
    'eviction',
    'owner',
    'call',
    'span',
    'provenance',
    'removed view',
    'changed override',
    'deleted',
    'base depth',
  ])
    it.effect(`refuses incompatible effective ready authority: ${variant}`, () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fixture = yield* storeFixture('valid');
          const proof = facts().navigationFacts!.proofs[0];
          if (variant === 'envelope') {
            const unsupported = {...facts(), navigationFacts: {...facts().navigationFacts, version: 2}};
            fixture.db.query('UPDATE file_blobs SET facts_json=?').run(JSON.stringify(unsupported));
          }
          if (variant === 'policy')
            fixture.db.exec(
              "UPDATE snapshot_pack_provenance SET cache_identity='309f69d4bac587350e365bd43bae1832bb4dc481b264a457d815f86aac2a5016'",
            );
          if (variant === 'previous binding policy')
            fixture.db.exec(
              "UPDATE snapshot_pack_provenance SET cache_identity='91db25531778123b551b1661000bcdd5f8133a0297d379669b64b7bf482521ed'",
            );
          if (variant === 'generation') fixture.db.exec('UPDATE snapshot_extractor_generations SET generation=13');
          if (variant === 'missing pack') fixture.db.exec('DELETE FROM snapshot_pack_provenance');
          if (variant === 'duplicate pack')
            fixture.db.exec('INSERT INTO snapshot_pack_provenance SELECT * FROM snapshot_pack_provenance');
          if (variant === 'authority') fixture.db.exec('DELETE FROM file_blob_authority');
          if (variant === 'eviction') fixture.db.exec('DELETE FROM file_blobs');
          if (variant === 'owner') fixture.db.query('DELETE FROM symbols WHERE id=?').run(proof.ownerId);
          if (variant === 'call') fixture.db.query('DELETE FROM edges WHERE id=?').run(proof.callEdgeId);
          if (variant === 'span')
            fixture.db
              .query('UPDATE edges SET evidence_span_json=? WHERE id=?')
              .run(JSON.stringify({...proof.callSpan, column: proof.callSpan.column + 1}), proof.callEdgeId);
          if (variant === 'provenance') fixture.db.exec("UPDATE edges SET provenance='heuristic'");
          if (variant === 'removed view') fixture.db.exec("INSERT INTO removed_views VALUES('worktree','snapshot')");
          if (variant === 'changed override' || variant === 'deleted' || variant === 'base depth') {
            fixture.db.exec(
              "INSERT INTO snapshots SELECT 'base',repository_id,worktree_id,commit_id,dirty,state,extractor_set,NULL FROM snapshots WHERE id='snapshot'; UPDATE snapshot_files SET snapshot_id='base'; UPDATE symbols SET snapshot_id='base'; UPDATE edges SET snapshot_id='base'; UPDATE snapshots SET base_snapshot_id='base' WHERE id='snapshot'",
            );
            if (variant === 'changed override')
              fixture.db
                .query('INSERT INTO snapshot_files VALUES(?,?,?)')
                .run('snapshot', 'operation.ts', EffectString.repeat(64)('b'));
            if (variant === 'deleted')
              fixture.db.exec("INSERT INTO snapshot_file_deletions VALUES('snapshot','operation.ts')");
            if (variant === 'base depth')
              fixture.db.exec("UPDATE snapshots SET base_snapshot_id='deeper' WHERE id='base'");
          }
          const read = yield* readCodeGraphNavigationFacts({...fixture, acquireRead: Effect.succeed(true)});
          expect(read.files[0].facts?.proofs ?? []).toEqual([]);
          expect(read.files[0].state).not.toBe('available');
          expect(read.counters.metadataReads).toBe(1);
          expect(read.counters.payloadReads).toBeLessThanOrEqual(1);
        }),
      ),
    );
  it.effect('refuses a reused call ID when its exact ready callsite span differs', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* storeFixture('valid');
        const proof = facts().navigationFacts!.proofs[0];
        const span = {...proof.callSpan, line: proof.callSpan.line + 1, endLine: proof.callSpan.endLine + 1};
        fixture.db
          .query('UPDATE edges SET evidence_span_json=? WHERE id=?')
          .run(JSON.stringify(span), proof.callEdgeId);
        const read = yield* readCodeGraphNavigationFacts({...fixture, acquireRead: Effect.succeed(true)});
        expect(read.files[0].facts?.proofs).toEqual([]);
        expect(read.files[0].gap).toBe('navigation-ready-closure-missing');
      }),
    ),
  );
  it.effect('resolves an unchanged inherited proof through keyed base rows', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* storeFixture('valid');
        fixture.db.exec(
          "INSERT INTO snapshots SELECT 'base',repository_id,worktree_id,commit_id,dirty,state,extractor_set,NULL FROM snapshots WHERE id='snapshot'; UPDATE snapshot_files SET snapshot_id='base'; UPDATE symbols SET snapshot_id='base'; UPDATE edges SET snapshot_id='base'; UPDATE snapshots SET base_snapshot_id='base' WHERE id='snapshot'",
        );
        const read = yield* readCodeGraphNavigationFacts({...fixture, acquireRead: Effect.succeed(true)});
        expect(read.files[0].facts?.proofs).toHaveLength(1);
        expect(read.counters).toMatchObject({metadataReads: 1, payloadReads: 1, ownerRows: 1, callRows: 1});
      }),
    ),
  );
  it.effect('does not relocate a renamed file to a donor parser cache path', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* storeFixture('valid');
        fixture.db.exec(
          "UPDATE snapshot_files SET path='renamed.ts'; UPDATE symbols SET path='renamed.ts'; UPDATE edges SET evidence_path='renamed.ts'",
        );
        const result = {
          ...fixture.result,
          nodes: EffectArray.map(fixture.result.nodes, node => ({...node, path: 'renamed.ts'})),
        };
        const selectors = [{...fixture.selectors[0], path: 'renamed.ts'}];
        const read = yield* readCodeGraphNavigationFacts({
          ...fixture,
          result,
          selectors,
          acquireRead: Effect.succeed(true),
        });
        expect(read.files[0].state).toBe('unavailable');
        expect(read.counters.payloadRows).toBe(0);
      }),
    ),
  );
  it.effect('does not trust caller spans or provenance as SQL authority', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* storeFixture('valid');
        fixture.db.exec("UPDATE edges SET evidence_span_json='{}',provenance='heuristic'");
        const read = yield* readCodeGraphNavigationFacts({...fixture, acquireRead: Effect.succeed(true)});
        expect(EffectArray.some(fixture.result.edges, edge => edge.provenance === 'syntactic')).toBe(true);
        expect(read.files[0].gap).toBe('navigation-ready-closure-missing');
        expect(read.files[0].facts?.proofs).toEqual([]);
      }),
    ),
  );
  it.effect('does not expand outside admitted working-set anchors', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* storeFixture('valid');
        const read = yield* readCodeGraphNavigationFacts({
          ...fixture,
          result: {...fixture.result, edges: []},
          acquireRead: Effect.succeed(true),
        });
        expect(read.files[0].gap).toBe('navigation-ready-closure-missing');
        expect(read.files[0].facts?.proofs).toEqual([]);
        expect(read.counters).toMatchObject({metadataReads: 1, payloadReads: 1, callRows: 0});
      }),
    ),
  );
  it.effect('caps anchor arrays before SQL or payload copying', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* storeFixture('valid');
        const read = yield* readCodeGraphNavigationFacts({
          ...fixture,
          result: {...fixture.result, nodes: Array.from({length: 25}, () => fixture.result.nodes[0])},
          acquireRead: Effect.die('no SQL admission'),
        });
        expect(read.gaps).toEqual(['navigation-anchor-budget']);
        expect(read.counters).toMatchObject({metadataReads: 0, payloadReads: 0});
      }),
    ),
  );
  it.effect('bounds raw selector work before deduplication', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* storeFixture('valid');
        const read = yield* readCodeGraphNavigationFacts({
          ...fixture,
          selectors: Array.from({length: 25}, () => fixture.selectors[0]),
          acquireRead: Effect.die('no SQL admission'),
        });
        expect(read.gaps).toEqual(['navigation-selector-budget']);
        expect(read.counters.metadataReads).toBe(0);
      }),
    ),
  );
  it.effect('keeps current/base point predicates in the SQL query plan', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* storeFixture('valid');
        const rows = fixture.db
          .query('EXPLAIN QUERY PLAN ' + navigationFactMetadataSql)
          .all(
            'snapshot',
            'repository',
            'worktree',
            'commit',
            0,
            JSON.stringify(fixture.selectors),
            JSON.stringify(EffectArray.map(fixture.result.nodes, node => node.id)),
            JSON.stringify(EffectArray.map(fixture.result.edges, edge => edge.id)),
          );
        const plan = JSON.stringify(rows);
        expect(plan).toContain('snapshot_id=? AND id=?');
        expect(plan).toContain('snapshot_id=? AND path=?');
        expect(plan).not.toMatch(/SCAN (?:node|blob|file)(?:\b|$)/);
      }),
    ),
  );
  it.effect('expires the shared100ms deadline deterministically before a pending first admission', () =>
    Effect.gen(function* () {
      const fixture = yield* TestClock.withLive(storeFixture('valid'));
      const entered = yield* Deferred.make<void>();
      const blocked = yield* Deferred.make<boolean>();
      const fresh = vi.spyOn(graphSession, 'withFreshCodeGraphReadTransaction');
      yield* Effect.addFinalizer(() => Effect.sync(() => fresh.mockRestore()));
      const fiber = yield* Effect.forkChild(
        readCodeGraphNavigationFacts({
          ...fixture,
          acquireRead: Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            return yield* Deferred.await(blocked);
          }),
        }).pipe(Effect.timeoutOption('100 millis')),
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust('100 millis');
      expect((yield* Fiber.join(fiber))._tag).toBe('None');
      expect(fresh).not.toHaveBeenCalled();
    }),
  );
  it.effect(
    'refuses a held-writer read with explicit native zero-wait configuration and scoped ready-stop handshake',
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fixture = yield* storeFixture('valid');
          fixture.db.exec('PRAGMA journal_mode=DELETE');
          const script = `import {Database} from 'bun:sqlite'; const writer=new Database(process.argv[1]);writer.exec('BEGIN EXCLUSIVE');process.stdout.write('ready\\n');const pulse=setInterval(()=>process.stdout.write('beat:'+Date.now()+'\\n'),25);await new Response(Bun.stdin.stream()).text();clearInterval(pulse);writer.exec('ROLLBACK');writer.close();`;
          yield* Effect.acquireUseRelease(
            Effect.sync(() =>
              Bun.spawn([process.execPath, '-e', script, fixture.databasePath], {
                stdin: 'pipe',
                stdout: 'pipe',
                stderr: 'pipe',
              }),
            ),
            child =>
              Effect.gen(function* () {
                const reader = child.stdout.getReader();
                const ready = yield* Effect.promise(() => reader.read());
                const first = new TextDecoder().decode(ready.value);
                expect(EffectString.startsWith('ready\n')(first)).toBe(true);
                let heartbeat = EffectString.slice(6)(first);
                yield* Effect.addFinalizer(() => Effect.sync(() => reader.releaseLock()));
                const query = vi.spyOn(Database.prototype, 'query');
                yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
                const started = performance.now();
                const read = yield* readCodeGraphNavigationFacts({...fixture, acquireRead: Effect.succeed(true)});
                const elapsed = performance.now() - started;
                expect(read.files[0].state).toBe('unavailable');
                expect(read.counters.payloadRows).toBe(0);
                expect(EffectArray.some(query.mock.calls, call => call[0] === 'PRAGMA busy_timeout = 0')).toBe(true);
                expect(EffectArray.some(query.mock.calls, call => call[0] === navigationFactMetadataSql)).toBe(true);
                yield* Effect.promise(async () => {
                  await child.stdin.write('stop');
                  await child.stdin.end();
                });
                expect(yield* Effect.promise(() => child.exited)).toBe(0);
                while (true) {
                  const chunk = yield* Effect.promise(() => reader.read());
                  if (chunk.done) break;
                  heartbeat += new TextDecoder().decode(chunk.value);
                }
                yield* Effect.log(
                  'NAV02_LOCK_DIAGNOSTIC',
                  JSON.stringify({
                    busyTimeout: 0,
                    readElapsedMilliseconds: elapsed,
                    heartbeat,
                    deadlinePolicyMilliseconds: 100,
                    wallQualificationBoundMilliseconds: 250,
                    wallQualification: false,
                  }),
                );
              }),
            child =>
              Effect.gen(function* () {
                if (child.exitCode === null) {
                  child.kill();
                  yield* Effect.promise(() => child.exited);
                }
              }),
          );
        }),
      ),
  );
  it.effect('observes setup, transaction and both bounded data SQL statements', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* storeFixture('valid');
        const query = vi.spyOn(Database.prototype, 'query');
        const run = vi.spyOn(Database.prototype, 'run');
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            query.mockRestore();
            run.mockRestore();
          }),
        );
        const read = yield* readCodeGraphNavigationFacts({...fixture, acquireRead: Effect.succeed(true)});
        const statements = [
          ...EffectArray.map(query.mock.calls, call => String(call[0])),
          ...EffectArray.map(run.mock.calls, call => String(call[0])),
        ];
        expect(EffectArray.filter(statements, sql => /^BEGIN/.test(sql))).toHaveLength(1);
        expect(EffectArray.filter(statements, sql => /^COMMIT/.test(sql))).toHaveLength(1);
        expect(EffectArray.filter(statements, sql => sql === 'PRAGMA busy_timeout = 0')).toHaveLength(1);
        expect(EffectArray.filter(statements, sql => sql === navigationFactMetadataSql)).toHaveLength(1);
        expect(
          EffectArray.filter(statements, sql => EffectString.includes('FROM json_each(?) AS reservation')(sql)),
        ).toHaveLength(1);
        expect(EffectArray.filter(statements, sql => /^PRAGMA busy_timeout = 5000/.test(sql))).toHaveLength(1);
        expect(statements).toHaveLength(6);
        expect(read.counters).toMatchObject({metadataReads: 1, payloadReads: 1, setupStatements: 1});
      }),
    ),
  );
  it.effect('denies an exhausted first allowance before opening any fresh database', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* storeFixture('valid');
        const fresh = vi.spyOn(graphSession, 'withFreshCodeGraphReadTransaction');
        const query = vi.spyOn(Database.prototype, 'query');
        const run = vi.spyOn(Database.prototype, 'run');
        const close = vi.spyOn(Database.prototype, 'close');
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            fresh.mockRestore();
            query.mockRestore();
            run.mockRestore();
            close.mockRestore();
          }),
        );
        const read = yield* readCodeGraphNavigationFacts({...fixture, acquireRead: Effect.succeed(false)});
        expect(read.files[0].gap).toBe('navigation-read-budget-exhausted');
        expect(fresh).not.toHaveBeenCalled();
        expect(query).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
      }),
    ),
  );
  it.effect('pins the metadata and payload in one stable read transaction', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* storeFixture('valid');
        let reads = 0;
        const read = yield* readCodeGraphNavigationFacts({
          ...fixture,
          acquireRead: Effect.sync(() => {
            reads++;
            if (reads === 2)
              fixture.db.query('UPDATE file_blobs SET facts_json=?').run(EffectString.repeat(2097323)('x'));
            return true;
          }),
        });
        expect(read.files[0].state).toBe('available');
        expect(read.counters.storedBytes).toBeLessThan(1048576);
      }),
    ),
  );
  for (const admittedReads of [0, 1])
    it.effect(`shares the caller read allowance without fetching payload after ${admittedReads} reads`, () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fixture = yield* storeFixture('valid');
          let remaining = admittedReads;
          const decode = vi.spyOn(storage, 'decodeStoredCodeGraphFact');
          yield* Effect.addFinalizer(() => Effect.sync(() => decode.mockRestore()));
          const read = yield* readCodeGraphNavigationFacts({
            ...fixture,
            acquireRead: Effect.sync(() => remaining-- > 0),
          });
          expect(read.files[0].state).toBe('omitted');
          expect(read.files[0].gap).toBe('navigation-read-budget-exhausted');
          expect(read.counters.metadataReads).toBe(admittedReads);
          expect(read.counters.payloadRows).toBe(0);
          expect(decode).not.toHaveBeenCalled();
        }),
      ),
    );
  it.effect('keeps cancellation interruptible between metadata and payload admission', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* storeFixture('valid');
        const entered = yield* Deferred.make<void>();
        const blocked = yield* Deferred.make<boolean>();
        let reads = 0;
        const decode = vi.spyOn(storage, 'decodeStoredCodeGraphFact');
        yield* Effect.addFinalizer(() => Effect.sync(() => decode.mockRestore()));
        const fiber = yield* Effect.forkChild(
          readCodeGraphNavigationFacts({
            ...fixture,
            acquireRead: Effect.gen(function* () {
              if (++reads === 1) return true;
              yield* Deferred.succeed(entered, undefined);
              return yield* Deferred.await(blocked);
            }),
          }),
        );
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        expect(reads).toBe(2);
        expect(decode).not.toHaveBeenCalled();
      }),
    ),
  );
});

it('caps the finite proof collection without retaining AST or silently claiming completeness', () => {
  let content = "import {writeFile as persistFile} from 'node:fs/promises';\n";
  for (let index = 0; index < 40; index++)
    content += `export async function save${index}(path: string, persist: boolean) {if (persist) {await persistFile(path, 'x');}}\n`;
  const collected = facts(content).navigationFacts;
  expect(collected?.proofs).toHaveLength(32);
  expect(collected?.omitted).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(collected))).toBeLessThanOrEqual(65536);
});

it('pins the supported proof policy to the explicit recorded TypeScript cache identity', () => {
  expect(packCacheIdentity(codeGraphLanguagePack)).toBe(NAVIGATION_PROOF_CACHE_IDENTITY);
});

it('does not create a collector for unsupported or no canonical import files', () => {
  const {compiler} = loadTypeScriptExtractionRuntime();
  for (const content of [
    'export const plain = 1;',
    "import type {writeFile} from 'node:fs/promises';",
    "import {writeFile} from 'not:canonical';",
  ]) {
    const parsed = compiler.createSourceFile('unsupported.ts', content, compiler.ScriptTarget.Latest, true);
    expect(createNavigationFactCollector(compiler, parsed, new Map())).toBeUndefined();
  }
});
