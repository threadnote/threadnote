import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {ResourceStore} from '@threadnote/store/resource-store';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import type {EffectMcpServerAdapter} from '@threadnote/threadnote/effect/ai/mcp';
import {
  inspectObsidianNote,
  obsidianSourceWork,
  readObsidianEvidence,
  runObsidianSourceAdd,
} from '@threadnote/integration-obsidian/source';
import {registerObsidianEvidenceTools} from '../../src/mcp/server/obsidian_evidence.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('MCP Obsidian evidence acceptance', () => {
  effectIt.effect('keeps a committed pin after relocation cleanup failure and removes a rejected duplicate pin', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-evidence-write-boundary-'});
      const vault = path.join(home, 'vault');
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath: path.join(home, 'manifest.yaml'),
        user: 'tester',
      };
      yield* fs.makeDirectory(vault, {recursive: true});
      yield* fs.writeFileString(path.join(vault, 'Decision.md'), 'A reviewed fact.');
      yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
      yield* runObsidianSourceAdd(config, {apply: true, id: 'notes', include: ['**/*.md'], vault});
      yield* obsidianSourceWork.run(config, 'notes', {mode: 'automatic', requestId: 'test', credentialEnvironment: {}});
      const reviewed = yield* inspectObsidianNote(config, 'notes', 'Decision.md');

      type ToolResult = {readonly isError?: boolean};
      const handlers = new Map<string, (input: Record<string, unknown>) => Effect.Effect<ToolResult>>();
      const server = {
        registerTool: (name: string, _definition: unknown, handle: (input: Record<string, unknown>) => unknown) => {
          handlers.set(name, handle as (input: Record<string, unknown>) => Effect.Effect<ToolResult>);
        },
      } as unknown as EffectMcpServerAdapter;
      registerObsidianEvidenceTools(server, config);
      expect([...handlers.keys()]).toEqual(['inspect_obsidian_note', 'derive_from_obsidian', 'read_source_evidence']);
      const derive = handlers.get('derive_from_obsidian');
      expect(derive).toBeDefined();
      const input = {
        sourceId: 'notes',
        relativePath: 'Decision.md',
        fragment: 'reviewed',
        expectedSourceInstanceId: reviewed.sourceInstanceId,
        expectedNoteId: reviewed.noteId,
        expectedRevisionHash: reviewed.revisionHash,
        expectedSanitizerVersion: reviewed.sanitizerVersion,
        text: 'A derived decision.',
        project: 'threadnote',
        topic: 'postcommit',
      };
      const relocationRoot = path.join(home, 'data', 'local', 'user', 'tester', 'private', 'memory-relocations', 'v1');
      yield* fs.makeDirectory(relocationRoot, {recursive: true});
      yield* fs.chmod(relocationRoot, 0o755);
      const failedAfterCommit = yield* derive!(input);
      expect(failedAfterCommit.isError).toBe(true);

      const uri = 'threadnote://user/tester/memories/durable/projects/threadnote/postcommit.md';
      const store = yield* ResourceStore;
      const content = yield* store.read({account: 'local', home, user: 'tester'}, uri);
      const citation = parseMemoryDocument(uri, content)?.metadata.obsidianEvidence;
      expect(citation).toBeDefined();
      expect((yield* readObsidianEvidence(config, citation!)).historical).toBe('available');

      yield* fs.chmod(relocationRoot, 0o700);
      const evidenceDirectory = path.join(home, 'threadnote', 'sources', 'obsidian', 'notes', 'evidence');
      expect(yield* fs.readDirectory(evidenceDirectory)).toHaveLength(1);
      const duplicate = yield* derive!(input);
      expect(duplicate.isError).toBe(true);
      expect(yield* fs.readDirectory(evidenceDirectory)).toHaveLength(1);
      expect((yield* readObsidianEvidence(config, citation!)).historical).toBe('available');
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );
});
