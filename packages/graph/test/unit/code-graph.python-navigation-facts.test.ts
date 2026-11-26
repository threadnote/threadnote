import * as EffectString from 'effect/String';
import * as EffectRecord from 'effect/Record';
import {Array as EffectArray, Effect, FileSystem, Layer, Path} from 'effect';
import {expect, it} from 'vitest';
import {it as effectIt} from '@effect/vitest';
import {Database} from 'bun:sqlite';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {serializeBoundedCodeGraphFact} from '@threadnote/graph/fact/budget';
import {BUILTIN_LANGUAGE_PACK_REGISTRY, packCacheIdentity} from '@threadnote/graph/languages/registry';
import {codeGraphLanguagePack as pythonPack} from '@threadnote/graph/languages/python/pack';
import {parseNavigationFacts} from '@threadnote/graph/navigation_facts';
import {
  NAVIGATION_PROOF_CACHE_IDENTITY,
  PYTHON_NAVIGATION_PROOF_CACHE_IDENTITY,
  navigationProofPack,
  readCodeGraphNavigationFacts,
} from '@threadnote/graph/query/navigation_facts';
import {TreeSitterRuntime} from '@threadnote/graph/tree_sitter/runtime';
import type {CodeGraphFileFacts, CodeGraphInventoryFile, CodeGraphQueryResult} from '@threadnote/graph/types';
import {citationPlatformLayer} from '../helpers/citation-platform.js';

const WRITE = `import os

def save_note(path, text, persist):
    body = text
    if persist:
        with open(path, "w") as handle:
            handle.write(body)
    return body
`;

const edit = (content: string, from: string, to: string) => EffectString.replace(from, to)(content);

function pythonFile(content: string, path = 'notes.py'): CodeGraphInventoryFile {
  return {
    blobId: EffectString.repeat(40)('b'),
    content,
    contentHash: sha256HexSync(content),
    path,
    mode: '100644',
    language: 'python',
    size: Buffer.byteLength(content),
    source: 'worktree',
  };
}
const slice = (content: string, span: {line: number; column: number; endLine: number; endColumn: number}) => {
  const lines = EffectString.split('\n')(content);
  return span.line === span.endLine
    ? EffectString.slice(span.column - 1, span.endColumn - 1)(lines[span.line - 1])
    : undefined;
};

it('pins the Python pack identity that carries navigation proofs and routes paths to their pack', () => {
  expect(packCacheIdentity(pythonPack)).toBe(PYTHON_NAVIGATION_PROOF_CACHE_IDENTITY);
  expect(PYTHON_NAVIGATION_PROOF_CACHE_IDENTITY).not.toBe(NAVIGATION_PROOF_CACHE_IDENTITY);
  expect(EffectArray.map(['a.py', 'a.pyi', 'a.ts', 'a.mjs', 'a.go'], navigationProofPack)).toEqual([
    'python',
    'python',
    'typescript',
    'typescript',
    null,
  ]);
});

effectIt.layer(TreeSitterRuntime.layer.pipe(Layer.provideMerge(citationPlatformLayer)))(it => {
  const extract = (content: string) => BUILTIN_LANGUAGE_PACK_REGISTRY.extractRawFile(pythonFile(content));

  it.effect('proves one conditional open-write and survives fact validation', () =>
    Effect.gen(function* () {
      for (const [content, branch] of [
        [WRITE, 'then'],
        [edit(WRITE, '    if persist:\n', '    if persist:\n        body = text\n    else:\n'), 'else'],
      ] as const) {
        const facts = yield* extract(content);
        const proofs = facts.navigationFacts?.proofs ?? [];
        expect(proofs).toHaveLength(1);
        const proof = proofs[0];
        expect(proof).toMatchObject({module: 'builtins', imported: 'open', local: 'open', guard: {branch}});
        expect(slice(content, proof.targetSpan)).toBe('path');
        expect(slice(content, proof.guard.span)).toBe('persist');
        expect(proof.module === 'builtins' && slice(content, proof.modeSpan)).toBe('"w"');
        expect(parseNavigationFacts(facts.navigationFacts, facts.symbols, facts.edges)).toEqual(facts.navigationFacts);
      }
    }),
  );

  it.effect('accepts every valid write-capable mode', () =>
    Effect.gen(function* () {
      for (const mode of ['wb', 'a', 'x+', 'r+', 'at'])
        expect((yield* extract(edit(WRITE, '"w"', `"${mode}"`))).navigationFacts?.proofs).toHaveLength(1);
    }),
  );

  it.effect('refuses every shape outside the finite grammar or with a possible rebinding of open', () =>
    Effect.gen(function* () {
      const refused: Record<string, string> = {
        'read mode': edit(WRITE, '"w"', '"r"'),
        'f-string mode': edit(WRITE, '"w"', 'f"w"'),
        'assigned open': `open = print\n${WRITE}`,
        'parameter open': edit(WRITE, 'persist):', 'persist, open=None):'),
        'builtins module': `import builtins\n${WRITE}`,
        'star import': `from helpers import *\n${WRITE}`,
        'no with statement': edit(
          WRITE,
          '        with open(path, "w") as handle:\n            handle.write(body)\n',
          '        open(path, "w").write(body)\n',
        ),
        'second open call': edit(WRITE, '    return body\n', '    open(path, "a")\n    return body\n'),
        'elif branch': edit(WRITE, '    return body\n', '    elif text:\n        body = text\n    return body\n'),
        'loop in owner': edit(WRITE, '    body = text\n', '    for item in text:\n        body = item\n'),
        decorated: `@cached\n${edit(WRITE, 'import os\n\n', '')}`,
        method: `class Notes:\n${EffectArray.join(
          EffectArray.map(EffectString.split('\n')(edit(WRITE, 'import os\n\n', '')), line =>
            line ? `    ${line}` : line,
          ),
          '\n',
        )}`,
        'non-identifier guard': edit(WRITE, 'if persist:', 'if persist and text:'),
        'computed target': edit(WRITE, 'open(path, "w")', 'open(path + ".bak", "w")'),
        'sys module': `import sys\n${WRITE}`,
        'importlib module': `import importlib\n${WRITE}`,
        'invalid rw mode': edit(WRITE, '"w"', '"rw"'),
        'invalid plus mode': edit(WRITE, '"w"', '"+"'),
        'async with': edit(edit(WRITE, 'def save_note', 'async def save_note'), 'with open', 'async with open'),
        'constant guard': edit(WRITE, '    body = text\n', '    body = text\n    persist = True\n'),
      };
      for (const [name, content] of EffectRecord.toEntries(refused)) {
        const facts = yield* extract(content);
        expect({name, proofs: facts.navigationFacts?.proofs ?? []}).toEqual({name, proofs: []});
      }
      expect((yield* extract('def read(path):\n    return path\n')).navigationFacts).toBeUndefined();
    }),
  );

  it.effect('reads a Python proof only under the Python pack identity, never the TypeScript one', () =>
    Effect.gen(function* () {
      const facts = yield* extract(WRITE);
      for (const identity of [PYTHON_NAVIGATION_PROOF_CACHE_IDENTITY, NAVIGATION_PROOF_CACHE_IDENTITY]) {
        const fixture = yield* storeFixture(facts, WRITE, identity);
        let remaining = 2;
        const read = yield* readCodeGraphNavigationFacts({...fixture, acquireRead: Effect.sync(() => remaining-- > 0)});
        if (identity === PYTHON_NAVIGATION_PROOF_CACHE_IDENTITY) {
          expect(read.files[0]).toMatchObject({path: 'notes.py', state: 'available'});
          expect(read.files[0].facts?.proofs).toHaveLength(1);
        } else {
          // A blob under the TypeScript identity is not this file's pack evidence: nothing is read from it.
          expect(read.files[0]).toMatchObject({path: 'notes.py', state: 'unavailable'});
          expect(read.files[0].facts).toBeUndefined();
        }
      }
    }).pipe(Effect.scoped),
  );
});

/** Minimal ready graph tables for one Python file whose blob is stored under `identity`. */
function storeFixture(facts: CodeGraphFileFacts, content: string, identity: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'python-navigation-facts-'});
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
      CREATE TABLE snapshot_file_deletions(snapshot_id TEXT,path TEXT,PRIMARY KEY(snapshot_id,path));
      CREATE TABLE snapshot_symbol_deletions(snapshot_id TEXT,symbol_id TEXT,PRIMARY KEY(snapshot_id,symbol_id));
      CREATE TABLE snapshot_edge_deletions(snapshot_id TEXT,edge_id TEXT,PRIMARY KEY(snapshot_id,edge_id));
      CREATE TABLE symbols(snapshot_id TEXT,id TEXT,path TEXT,content_hash TEXT,kind TEXT,span_json TEXT,PRIMARY KEY(snapshot_id,id));
      CREATE TABLE edges(snapshot_id TEXT,id TEXT,source_id TEXT,target_name TEXT,evidence_path TEXT,evidence_span_json TEXT,relation TEXT,provenance TEXT,PRIMARY KEY(snapshot_id,id));`);
    const hash = sha256HexSync(content);
    // The ready snapshot records both packs at their proof identities; only the blob identity varies.
    for (const [pack, cacheIdentity, version] of [
      ['python', PYTHON_NAVIGATION_PROOF_CACHE_IDENTITY, 'python-static-v1'],
      ['typescript', NAVIGATION_PROOF_CACHE_IDENTITY, 'typescript-modules-v2-published-surface'],
    ] as const)
      db.query('INSERT INTO snapshot_pack_provenance VALUES(?,?,?,?,?)').run(
        'snapshot',
        pack,
        cacheIdentity,
        pack,
        version,
      );
    db.query('INSERT INTO snapshot_extractor_generations VALUES(?,?)').run('snapshot', 14);
    db.query(
      'INSERT INTO snapshots(id,repository_id,worktree_id,commit_id,dirty,state,extractor_set) VALUES(?,?,?,?,?,?,?)',
    ).run('snapshot', 'repository', 'worktree', 'commit', 0, 'ready', 'extractor');
    db.query('INSERT INTO snapshot_files VALUES(?,?,?)').run('snapshot', facts.path, hash);
    db.query('INSERT INTO file_blobs VALUES(?,?,?,?)').run(
      hash,
      identity,
      facts.path,
      serializeBoundedCodeGraphFact(facts).json,
    );
    db.query('INSERT INTO file_blob_authority VALUES(?,?,?)').run(identity, facts.path, hash);
    for (const symbol of facts.symbols)
      db.query('INSERT INTO symbols VALUES(?,?,?,?,?,?)').run(
        'snapshot',
        symbol.id,
        symbol.path,
        symbol.contentHash,
        symbol.kind,
        JSON.stringify(symbol.span),
      );
    for (const edge of facts.edges)
      db.query('INSERT OR IGNORE INTO edges VALUES(?,?,?,?,?,?,?,?)').run(
        'snapshot',
        edge.id,
        edge.sourceId ?? null,
        edge.targetName,
        edge.evidencePath,
        JSON.stringify(edge.evidenceSpan),
        edge.relation,
        edge.provenance,
      );
    const result: CodeGraphQueryResult = {
      repository: {repositoryId: 'repository', displayName: 'fixture'},
      snapshot: {id: 'snapshot', worktreeId: 'worktree', commit: 'commit', dirty: false},
      freshness: 'current',
      operation: 'node',
      nodes: EffectArray.map(facts.symbols, symbol => ({...symbol, rank: 0, score: 1})),
      edges: facts.edges,
      trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
      warnings: [],
      version: 1,
    };
    return {databasePath, result, selectors: [{path: facts.path, contentHash: hash}]};
  });
}
