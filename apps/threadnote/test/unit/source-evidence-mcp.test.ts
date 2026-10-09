import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path, Redacted} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {storeExternalCredential} from '@threadnote/integration-core/external-credentials';
import {ResourceStore} from '@threadnote/store/resource-store';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {readSourceEvidence} from '@threadnote/store/source-evidence';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import type {EffectMcpServerAdapter} from '@threadnote/threadnote/effect/ai/mcp';
import {registerSourceEvidenceTools} from '../../src/mcp/server/source_evidence.js';
import {registerObsidianEvidenceTools} from '../../src/mcp/server/obsidian_evidence.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {sourceEvidenceFixture} from '../helpers/source-evidence.js';

type ToolResult = {
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
  readonly content?: readonly {type: string; text?: string}[];
};
function tools(config: RuntimeConfig) {
  const handlers = new Map<string, (input: Record<string, unknown>) => Effect.Effect<ToolResult>>();
  const server = {
    registerTool: (name: string, _definition: unknown, handle: unknown) => {
      expect(handlers.has(name)).toBe(false);
      handlers.set(name, handle as (input: Record<string, unknown>) => Effect.Effect<ToolResult>);
    },
  } as unknown as EffectMcpServerAdapter;
  registerSourceEvidenceTools(server, config);
  registerObsidianEvidenceTools(server, config);
  return (name: string, input: Record<string, unknown>) =>
    Effect.suspend(() => {
      const result = handlers.get(name)!(input);
      return Effect.isEffect(result) ? result : Effect.succeed(result);
    });
}
const reviewedInput = (inspection: Record<string, unknown>) => ({
  resourceUri: inspection.resourceUri,
  fragment: '💡 Preserve this exact fragment.',
  expectedSourceInstanceId: inspection.sourceInstanceId,
  expectedAccessHash: inspection.accessHash,
  expectedRevisionHash: inspection.revisionHash,
  expectedContentHash: inspection.contentHash,
  expectedRendererVersion: inspection.rendererVersion,
  expectedSanitizerVersion: inspection.sanitizerVersion,
  text: 'A derived fact.',
  project: 'threadnote',
  topic: 'accepted',
});

describe('MCP retained integration evidence', () => {
  for (const provider of ['github', 'linear', 'pocket', 'superhuman'] as const) {
    effectIt.effect(`${provider}: review, accept, read historical text and revoke on credential rotation`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: `source-evidence-${provider}-`});
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: path.join(home, 'manifest.yaml'),
          user: 'tester',
        };
        const fixture = yield* sourceEvidenceFixture(config, provider);
        const call = tools(config);
        const inspection = yield* call('inspect_source_evidence', {resourceUri: fixture.resourceUri});
        expect(inspection.isError).not.toBe(true);
        expect(inspection.structuredContent?.provider).toBe(provider);
        const input = reviewedInput(inspection.structuredContent!);
        expect(
          (yield* call('derive_from_source', {resourceUri: fixture.resourceUri, fragment: input.fragment})).isError,
        ).toBe(true);
        expect((yield* call('derive_from_source', {...input, fragment: 'Absent from source.'})).isError).toBe(true);
        const result = yield* call('derive_from_source', input);
        expect(result.isError).not.toBe(true);
        const memoryUri = 'threadnote://user/tester/memories/durable/projects/threadnote/accepted.md';
        const read = () => call('read_source_evidence', {memoryUri});
        expect((yield* read()).structuredContent).toMatchObject({
          historical: 'available',
          currentRevision: 'same',
          fragment: input.fragment,
        });
        yield* fixture.snapshot('A newer source body.');
        expect((yield* read()).structuredContent).toMatchObject({
          historical: 'available',
          currentRevision: 'changed',
          fragment: input.fragment,
        });
        expect((yield* call('derive_from_source', {...input, topic: 'stale'})).isError).toBe(true);
        yield* fixture.snapshot('A newer source body.', true);
        expect((yield* read()).structuredContent).toMatchObject({
          historical: 'available',
          currentRevision: 'removed',
          fragment: input.fragment,
        });
        yield* fixture.snapshot('A newer source body.', true, 'active', 0);
        expect((yield* read()).structuredContent).toMatchObject({
          historical: 'available',
          currentRevision: 'unknown',
          fragment: input.fragment,
        });
        yield* fixture.snapshot('A newer source body.', false, 'quarantined');
        const quarantined = yield* read();
        expect(quarantined.structuredContent).toMatchObject({historical: 'revoked'});
        expect(quarantined.structuredContent?.fragment).toBeUndefined();
        yield* fixture.snapshot('A newer source body.', true);
        yield* storeExternalCredential(config, 'fixture', Redacted.make('pk_synthetic_rotated_fixture'), provider);
        const revoked = yield* read();
        expect(revoked.structuredContent).toMatchObject({historical: 'revoked', currentRevision: 'unknown'});
        expect(revoked.structuredContent?.fragment).toBeUndefined();
        expect(
          (yield* call('read_source_evidence', {
            memoryUri: 'threadnote://user/another/memories/durable/projects/threadnote/accepted.md',
          })).isError,
        ).toBe(true);
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
    );
  }
  effectIt.effect('keeps a committed pin after postcommit failure and discards a rejected duplicate pin', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'source-evidence-postcommit-'});
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath: path.join(home, 'manifest.yaml'),
        user: 'tester',
      };
      const fixture = yield* sourceEvidenceFixture(config, 'pocket');
      const call = tools(config);
      const inspection = yield* call('inspect_source_evidence', {resourceUri: fixture.resourceUri});
      const input = reviewedInput(inspection.structuredContent!);
      expect(
        (yield* call('derive_from_source', {resourceUri: fixture.resourceUri, fragment: input.fragment})).isError,
      ).toBe(true);
      const relocationRoot = path.join(home, 'data', 'local', 'user', 'tester', 'private', 'memory-relocations', 'v1');
      yield* fs.makeDirectory(relocationRoot, {recursive: true});
      yield* fs.chmod(relocationRoot, 0o755);
      expect((yield* call('derive_from_source', input)).isError).toBe(true);
      const store = yield* ResourceStore;
      const memoryUri = 'threadnote://user/tester/memories/durable/projects/threadnote/accepted.md';
      const content = yield* store.read(fixture.location, memoryUri);
      const citation = parseMemoryDocument(memoryUri, content)?.metadata.sourceEvidence;
      expect(citation).toBeDefined();
      expect((yield* readSourceEvidence(fixture.location, citation!)).historical).toBe('available');
      const evidenceDirectory = path.join(home, 'threadnote', 'source-evidence', 'local', 'pocket', 'fixture');
      expect((yield* fs.readDirectory(evidenceDirectory)).filter(name => name.endsWith('.json'))).toHaveLength(1);
      yield* fs.chmod(relocationRoot, 0o700);
      expect((yield* call('derive_from_source', input)).isError).toBe(true);
      expect((yield* readSourceEvidence(fixture.location, citation!)).historical).toBe('available');
      expect((yield* fs.readDirectory(evidenceDirectory)).filter(name => name.endsWith('.json'))).toHaveLength(1);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );
});
