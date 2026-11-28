import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import * as EffectString from 'effect/String';
import {describe, expect, vi} from 'vitest';
import {compileContextBriefNavigationWith} from '@threadnote/context/navigation/lane';
import {parseContextBriefNavigationRequestV1} from '@threadnote/context/navigation/request';
import type {NavigationReadEvidenceV1} from '@threadnote/context/navigation/read';
import {EffectMcpServerAdapter} from '@threadnote/threadnote/effect/ai/mcp';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {runContextBrief} from '@threadnote/threadnote/context_brief/commands';
import {registerContextBriefTool} from '@threadnote/threadnote/mcp/server/code_graph';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {Schema} from 'effect';
import {contextBriefNativeReadResponseSchema} from '../../src/context_brief/native_read_boundary.js';

const controls = vi.hoisted(() => ({output: '', briefs: 0, semantic: 0, navigations: [] as unknown[]}));
vi.mock('@threadnote/threadnote/effect/cli/output', async importOriginal => {
  const actual = await importOriginal<typeof import('@threadnote/threadnote/effect/cli/output')>();
  const {Effect: MockEffect} = await import('effect');
  return {
    ...actual,
    writeFinalCliOutput: (text: string) =>
      MockEffect.sync(() => {
        controls.output = text;
      }),
  };
});
vi.mock('@threadnote/threadnote/context_brief/index', async importOriginal => {
  const actual = await importOriginal<typeof import('@threadnote/threadnote/context_brief/index')>();
  const {Effect: MockEffect} = await import('effect');
  return {
    ...actual,
    compileContextBrief: () =>
      MockEffect.sync(() => {
        controls.briefs += 1;
        return {maximumBytes: 0, measurement: {}, structuredContent: {}, text: 'brief'};
      }),
    compileContextBriefNavigation: (_config: unknown, input: unknown) =>
      MockEffect.suspend(() => {
        controls.navigations.push(input);
        return compileContextBriefNavigationWith(
          {
            navigationEvidence: () => MockEffect.succeed(evidence()),
            navigationSemantic: request =>
              MockEffect.sync(() => {
                controls.semantic += 1;
                return request.input;
              }),
          },
          input,
        );
      }),
  };
});

const CWD = '/workspace/store';
const ID = 'cgs_00000000000000000000000000000001';
const config = {
  account: 'local',
  agentContextHome: '/unused',
  agentId: 'codex',
  manifestPath: '/unused/manifest.yaml',
  user: 'test',
};
const scope = {
  repository: 'repository-id',
  worktree: 'worktree-id',
  project: 'repository',
  view: {kind: 'disk', id: 'saved', owner: 'graph', epoch: 0},
} as const;
const observation = {
  repository: {repositoryId: 'repository-id', displayName: 'store'},
  snapshot: {id: 'snapshot-id', commit: EffectString.repeat(40)('a'), worktreeId: 'worktree-id', dirty: false},
  freshness: 'current' as const,
};
const span = {line: 3, column: 1, endLine: 3, endColumn: 20};
function evidence(): NavigationReadEvidenceV1 {
  return {
    status: 'ok',
    identity: {
      caseMode: 'sensitive',
      checkoutId: 'checkout-id',
      displayName: 'store',
      gitCommonDirectory: '/workspace/store/.git',
      headCommit: EffectString.repeat(40)('a'),
      objectFormat: 'sha1',
      repoRoot: CWD,
      repositoryId: 'repository-id',
      worktreeId: 'worktree-id',
    },
    observation,
    repositoryIdentityKind: 'local',
    input: {
      scope,
      target: {kind: 'task'},
      sources: [{...scope, id: 'store', path: 'src/store.ts', contentHash: 'hash', freshness: 'verified-current'}],
      candidates: [
        {
          id: ID,
          sourceId: 'store',
          startLine: 3,
          endLine: 3,
          roles: ['implementation'],
          reason: 'Implementation.',
          relevance: 1,
          basis: ['structural'],
          support: 'evidenced',
        },
      ],
      links: [],
      coverage: {status: 'complete', description: 'Fixture.'},
    },
    proofLocators: [],
    proofContext: {symbols: [], edges: []},
    anchors: [{candidateId: ID, path: 'src/store.ts', contentHash: 'hash', name: 'save', span}],
  };
}
const TASK = 'Where does save write the store file?';
const mcp = () => {
  const server = new EffectMcpServerAdapter('navigation-surfaces-test', '0', 'Navigation surfaces fixture.');
  registerContextBriefTool(server, config);
  return (args: Record<string, unknown>) =>
    server.invokeTool('context_brief', args).pipe(provideTestLayer(ApplicationLayer));
};
const textOf = (result: {readonly content: readonly {readonly type: string; readonly text?: string}[]}) =>
  result.content[0]?.text ?? '';

describe('navigate across surfaces', () => {
  effectIt.effect('gives the same agent answer through the CLI and MCP for an identical evidence outcome', () =>
    Effect.gen(function* () {
      controls.output = '';
      controls.navigations = [];
      yield* runContextBrief(config, {cwd: CWD, mode: 'navigate', task: TASK, detail: 'compact'}).pipe(
        provideTestLayer(ApplicationLayer),
      );
      const cli = controls.output;
      const call = mcp();
      const viaMcp = textOf(yield* call({callerCwd: CWD, mode: 'navigate', task: TASK}));
      expect(JSON.parse(cli)).toMatchObject({type: 'context-brief-navigation', version: 1});
      expect(viaMcp).toBe(cli);
      // Both surfaces normalize to the same lane request.
      expect(parseContextBriefNavigationRequestV1(controls.navigations[0])).toEqual(
        parseContextBriefNavigationRequestV1(controls.navigations[1]),
      );
      const repeated = textOf(yield* call({callerCwd: CWD, mode: 'navigate', task: TASK}));
      expect(repeated).toBe(viaMcp);
    }),
  );

  effectIt.effect('keeps the other modes on Context Brief and refuses a continuation outside navigate', () =>
    Effect.gen(function* () {
      controls.briefs = 0;
      controls.semantic = 0;
      controls.navigations = [];
      const call = mcp();
      yield* call({callerCwd: CWD, mode: 'brief', task: TASK});
      expect(controls.briefs).toBe(1);
      expect(controls.navigations).toHaveLength(0);
      expect(controls.semantic).toBe(0);
      const refused = yield* call({callerCwd: CWD, mode: 'brief', task: TASK, continuation: 'AAAA'});
      expect(refused.isError).toBe(true);
      expect(controls.navigations).toHaveLength(0);
    }),
  );

  effectIt.effect('decodes a navigation reply strictly at the worker boundary', () =>
    Effect.gen(function* () {
      const reply = {
        protocol: 1,
        binding: 'b',
        commandsJoined: true,
        ok: true,
        operation: 'navigation',
        value: evidence(),
      };
      const decoded = yield* Schema.decodeUnknownEffect(contextBriefNativeReadResponseSchema)(reply, {
        onExcessProperty: 'error',
      });
      expect(decoded).toEqual(reply);
      const memory = {
        status: 'ok',
        observedAt: '2026-11-27T00:00:00.000Z',
        memoryProjects: {mode: 'allow-projects-and-projectless', projects: ['store']},
        memory: {
          candidates: [],
          citationValidations: [],
          consideredCandidates: 0,
          gaps: [],
          trust: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
        },
      };
      const withMemory = {...reply, value: {...evidence(), memory}};
      expect(
        yield* Schema.decodeUnknownEffect(contextBriefNativeReadResponseSchema)(withMemory, {
          onExcessProperty: 'error',
        }),
      ).toEqual(withMemory);
      for (const extra of [
        {...reply, value: {...evidence(), graph: {}}},
        {...reply, value: {...evidence(), memory: {...memory, memoryProjects: {mode: 'unrestricted'}}}},
      ]) {
        const refused = yield* Schema.decodeUnknownEffect(contextBriefNativeReadResponseSchema)(extra, {
          onExcessProperty: 'error',
        }).pipe(Effect.result);
        expect(refused._tag).toBe('Failure');
      }
    }),
  );
});
