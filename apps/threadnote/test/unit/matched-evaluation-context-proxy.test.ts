import {chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import fc from 'fast-check';
import {afterEach, describe, expect, it} from 'vitest';
import {
  assertMatchedEvaluationFollowupBudgetV1,
  handleMatchedEvaluationContextRequest,
  handleMatchedEvaluationFollowupRequest,
  hashExpectedResume,
  hashMatchedEvaluationContextContent,
  hashMatchedEvaluationContextRequest,
  matchedEvaluationContextTools,
  MATCHED_EVALUATION_CONTEXT_PROXY_VERSION,
  renderMatchedEvaluationRuntimeManifestV1,
  type MatchedEvaluationContextProxyPacketV1,
} from '../../../../scripts/matched-evaluation-context-proxy.js';

describe('matched evaluation context proxy', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, {force: true, recursive: true})));
  });

  it('uses a sealed run-local manifest bound to the isolated repository', async () => {
    if (process.platform === 'win32') return;
    const fixture = await contextFixture(roots);

    const result = await handleMatchedEvaluationContextRequest(fixture.packet, {
      callerCwd: fixture.repository,
      project: fixture.packet.project,
    });

    expect(JSON.parse(result.content[0].text)).toEqual(preparedEvidence);
    expect(result.structuredContent).toBeUndefined();
    expect(await fixture.seenResponseFormat()).toBe('agent');
    expect(result.meta).toMatchObject({
      matchedEvaluation: {
        graphReady: true,
        runNonce: fixture.packet.runNonce,
        runtimeManifestSha256: fixture.packet.runtimeManifestSha256,
        contentResponseSha256: sha256HexSync(Buffer.from(result.content[0].text)),
        frozenPromptSha256: sha256HexSync(Buffer.from(fixture.packet.prompt)),
        version: MATCHED_EVALUATION_CONTEXT_PROXY_VERSION,
      },
    });
  });

  it('hashes arbitrary response text deterministically', () => {
    fc.assert(
      fc.property(fc.string({maxLength: 256}), value => {
        expect(hashMatchedEvaluationContextContent(value)).toBe(sha256HexSync(value));
        expect(hashMatchedEvaluationContextContent(value)).toHaveLength(64);
      }),
      {numRuns: 50},
    );
  });

  it('uses the packet prompt verbatim and rejects caller task injection', async () => {
    if (process.platform === 'win32') return;
    const prompt = '## Escaped `prompt`\n\nline \\  \u00a0\n';
    const fixture = await contextFixture(roots, prompt);
    const result = await handleMatchedEvaluationContextRequest(fixture.packet, {
      callerCwd: fixture.repository,
    });

    expect(JSON.parse(result.content[0].text)).toEqual(preparedEvidence);
    expect(await fixture.seenTask()).toBe(prompt);
    await expect(
      handleMatchedEvaluationContextRequest(fixture.packet, {
        callerCwd: fixture.repository,
        task: 'injected task',
      }),
    ).rejects.toThrow('Expected no excess property');
  });

  it('preserves the proxy contract across the real MCP stdio transport', async () => {
    if (process.platform === 'win32') return;
    const fixture = await contextFixture(roots, 'Markdown **prompt** with trailing spaces  \n');
    const packetPath = join(fixture.root, 'packet.json');
    await writeFile(packetPath, JSON.stringify(fixture.packet));
    const transport = new StdioClientTransport({
      args: [join(process.cwd(), 'scripts/matched-evaluation-context-proxy.ts')],
      command: process.execPath,
      cwd: process.cwd(),
      env: {...process.env, MATCHED_EVALUATION_CONTEXT_PACKET: packetPath},
      stderr: 'pipe',
    });
    const client = new Client({name: 'matched-context-proxy-test', version: '1'});
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map(tool => tool.name).sort()).toEqual(
        [...matchedEvaluationContextTools(fixture.packet.detail)].sort(),
      );
      const tool = listed.tools.find(candidate => candidate.name === 'context_brief');
      expect(tool).toBeDefined();
      expect(JSON.stringify(tool?.inputSchema)).not.toContain('task');

      const early = await client.callTool({
        name: 'inspect_code_graph',
        arguments: {callerCwd: fixture.repository, operation: 'query', query: 'fixture'},
      });
      expect(early.isError).toBe(true);

      const result = await client.callTool({
        name: 'context_brief',
        arguments: {callerCwd: fixture.repository, project: fixture.packet.project},
      });
      expect(result.isError).not.toBe(true);
      expect(result.content).toHaveLength(1);
      const content = result.content as readonly {readonly text: string; readonly type: string}[];
      expect(content[0]).toMatchObject({type: 'text'});
      expect('structuredContent' in result).toBe(false);
      expect(result._meta).toMatchObject({
        matchedEvaluation: {
          version: MATCHED_EVALUATION_CONTEXT_PROXY_VERSION,
          runNonce: fixture.packet.runNonce,
          runtimeManifestSha256: fixture.packet.runtimeManifestSha256,
          contentResponseSha256: sha256HexSync(Buffer.from(content[0].text)),
          frozenPromptSha256: sha256HexSync(Buffer.from(fixture.packet.prompt)),
        },
      });

      const injected = await client.callTool({
        name: 'context_brief',
        arguments: {callerCwd: fixture.repository, task: 'injected task'},
      });
      expect(injected.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('starts preloaded resume with follow-ups ready and no context_brief tool', async () => {
    if (process.platform === 'win32') return;
    const fixture = await contextFixture(roots, 'Resume the checkpoint.', 'compact', 'linked', 'resume');
    const requiredGraphQuery = 'find the production caller for the failing regression';
    const packet = {
      ...fixture.packet,
      expectedResume: {...fixture.packet.expectedResume!, requiredGraphQuery},
      initialBriefDelivery: 'preloaded' as const,
    };
    const packetPath = join(fixture.root, 'preloaded-packet.json');
    await writeFile(packetPath, JSON.stringify(packet));
    const transport = new StdioClientTransport({
      args: [join(process.cwd(), 'scripts/matched-evaluation-context-proxy.ts')],
      command: process.execPath,
      cwd: process.cwd(),
      env: {...process.env, MATCHED_EVALUATION_CONTEXT_PACKET: packetPath},
      stderr: 'pipe',
    });
    const client = new Client({name: 'matched-context-preload-test', version: '1'});
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map(tool => tool.name).sort()).toEqual(
        [...matchedEvaluationContextTools(packet.detail, 'preloaded', requiredGraphQuery)].sort(),
      );
      expect(listed.tools.some(tool => tool.name === 'context_brief')).toBe(false);
      expect(listed.tools.map(tool => tool.name)).toEqual(['inspect_code_graph']);
      const followup = await client.callTool({
        name: 'inspect_code_graph',
        arguments: {callerCwd: fixture.repository, operation: 'query', query: requiredGraphQuery},
      });
      expect(followup.isError).not.toBe(true);
    } finally {
      await client.close();
    }
  });

  it('retains legacy preloaded choices and seals diagnostic preloaded inventory to inspect only', async () => {
    expect(matchedEvaluationContextTools('compact', 'preloaded', null)).toEqual([
      'inspect_code_graph',
      'analyze_code_graph',
      'recall_context',
      'read_context',
    ]);
    expect(matchedEvaluationContextTools('compact', 'preloaded', 'find the caller')).toEqual(['inspect_code_graph']);
  });

  it('rejects a wrong sealed diagnostic query before invoking the backend', async () => {
    const fixture = await contextFixture(roots, 'resume prompt', 'compact', 'linked', 'resume');
    const requiredGraphQuery = 'find the production caller for the failing regression';
    const packet = {
      ...fixture.packet,
      initialBriefDelivery: 'preloaded' as const,
      expectedResume: {...fixture.packet.expectedResume!, requiredGraphQuery},
    };
    let invokeCalls = 0;
    const invoke = async () => {
      invokeCalls += 1;
      return {content: [{type: 'text' as const, text: 'unexpected backend call'}]};
    };

    await expect(
      handleMatchedEvaluationFollowupRequest(
        packet,
        'inspect_code_graph',
        {callerCwd: fixture.repository, operation: 'query', query: 'different query'},
        invoke,
      ),
    ).rejects.toThrow('sealed diagnostic graph query');
    expect(invokeCalls).toBe(0);
    await expect(
      handleMatchedEvaluationFollowupRequest(
        {...packet, initialBriefDelivery: 'mcp'},
        'inspect_code_graph',
        {callerCwd: fixture.repository, operation: 'query', query: requiredGraphQuery},
        invoke,
      ),
    ).rejects.toThrow('required graph query is supported only for preloaded resume');
    expect(invokeCalls).toBe(0);
  });

  it('preserves native memory text when structured content is only metadata and authenticates follow-up errors', async () => {
    const fixture = await contextFixture(roots, 'memory prompt', 'compact', 'linked');
    const args = {uri: 'threadnote://memory/tn_prepared'};
    const result = await handleMatchedEvaluationFollowupRequest(fixture.packet, 'read_context', args, async () => ({
      content: [{type: 'text' as const, text: 'The actual memory evidence.'}],
      structuredContent: {type: 'threadnote-read', contentBytes: 27, contentChannel: 'text'},
    }));
    expect(result.content).toEqual([{type: 'text', text: 'The actual memory evidence.'}]);
    expect(result.structuredContent).toBeUndefined();
    const failed = await handleMatchedEvaluationFollowupRequest(fixture.packet, 'read_context', args, async () => {
      throw new Error('bounded backend failure');
    });
    expect(failed.isError).toBe(true);
    expect(failed.meta).toMatchObject({
      matchedEvaluation: {
        toolName: 'read_context',
        success: false,
        requestSha256: hashMatchedEvaluationContextRequest('read_context', args),
        contentResponseSha256: hashMatchedEvaluationContextContent(failed.content[0].text),
      },
    });
    expect(matchedEvaluationContextTools('compact')).toEqual([
      ...matchedEvaluationContextTools('graph-only'),
      'recall_context',
      'read_context',
    ]);
    expect(matchedEvaluationContextTools('source')).toEqual(['context_brief']);
  });

  it('uses the sealed resume mode and rejects an agent-selected mode', async () => {
    if (process.platform === 'win32') return;
    const fixture = await contextFixture(roots, 'resume prompt', 'graph-only', 'disabled', 'resume');
    const result = await handleMatchedEvaluationContextRequest(fixture.packet, {
      callerCwd: fixture.repository,
      mode: 'resume',
    });

    expect(result.isError).not.toBe(true);
    expect(await fixture.seenMode()).toBe('resume');
    await expect(
      handleMatchedEvaluationContextRequest(fixture.packet, {
        callerCwd: fixture.repository,
        mode: 'brief',
      }),
    ).rejects.toThrow('mode differs from the sealed treatment');
  });

  it('bounds continuation follow-ups with the sealed packet budget', async () => {
    const fixture = await contextFixture(roots, 'resume prompt', 'graph-only', 'disabled', 'resume');
    const packet = {...fixture.packet, maximumFollowupCalls: 1};

    expect(() => assertMatchedEvaluationFollowupBudgetV1(packet, 1)).not.toThrow();
    expect(() => assertMatchedEvaluationFollowupBudgetV1(packet, 2)).toThrow('sealed treatment budget');
    expect(() => assertMatchedEvaluationFollowupBudgetV1(packet, 0)).toThrow('positive safe integer');
  });

  it('fails closed when sealed resume evidence is missing or incomplete', async () => {
    if (process.platform === 'win32') return;
    const fixture = await contextFixture(roots, 'resume prompt', 'graph-only', 'disabled', 'resume');
    const packet = {
      ...fixture.packet,
      expectedResume: {
        automaticHandoffUri: 'prepared context',
        requiredGraphQuery: null,
        resumeEvidenceMarker: 'implementation contract',
      },
    };
    const delivered = await handleMatchedEvaluationContextRequest(packet, {
      callerCwd: fixture.repository,
      mode: 'resume',
    });
    const differentlySealedResume = {...packet.expectedResume, resumeEvidenceMarker: 'different sealed marker'};
    expect(delivered.meta).toMatchObject({
      matchedEvaluation: {expectedResumeHash: hashExpectedResume(packet.expectedResume)},
    });
    expect(hashExpectedResume(packet.expectedResume)).not.toBe(hashExpectedResume(differentlySealedResume));
    await expect(
      handleMatchedEvaluationContextRequest(
        {...packet, expectedResume: differentlySealedResume},
        {callerCwd: fixture.repository, mode: 'resume'},
      ),
    ).rejects.toThrow('omitted the sealed automatic handoff URI, continuation evidence, or marker');
    await expect(
      handleMatchedEvaluationContextRequest(
        {
          ...packet,
          expectedResume: {
            automaticHandoffUri: 'absent',
            requiredGraphQuery: null,
            resumeEvidenceMarker: 'implementation contract',
          },
        },
        {callerCwd: fixture.repository, mode: 'resume'},
      ),
    ).rejects.toThrow('omitted the sealed automatic handoff URI, continuation evidence, or marker');

    const incomplete = await contextFixture(roots, 'resume prompt', 'graph-only', 'disabled', 'resume', {
      ...preparedEvidence,
      activeHandoffs: [{uri: 'prepared context'}],
    });
    await expect(
      handleMatchedEvaluationContextRequest(incomplete.packet, {
        callerCwd: incomplete.repository,
        mode: 'resume',
      }),
    ).rejects.toThrow('omitted the sealed automatic handoff URI, continuation evidence, or marker');

    const empty = await contextFixture(roots, 'resume prompt', 'graph-only', 'disabled', 'resume', {
      ...preparedEvidence,
      activeHandoffs: [{continuationCard: {nextStep: '   '}, uri: 'prepared context'}],
    });
    await expect(
      handleMatchedEvaluationContextRequest(empty.packet, {
        callerCwd: empty.repository,
        mode: 'resume',
      }),
    ).rejects.toThrow('omitted the sealed automatic handoff URI, continuation evidence, or marker');

    const dense = await contextFixture(roots, 'resume prompt', 'graph-only', 'disabled', 'resume', {
      answer: 'Resume from the exact handoff and preserve the implementation contract.',
      activeHandoffs: [{uri: 'prepared context'}],
    });
    const denseResult = await handleMatchedEvaluationContextRequest(dense.packet, {
      callerCwd: dense.repository,
      mode: 'resume',
    });
    expect(denseResult.isError).not.toBe(true);
    expect(denseResult.meta).toMatchObject({matchedEvaluation: {success: true}});
  });

  it('rejects tampered, rebound, and escaped runtime manifests', async () => {
    if (process.platform === 'win32') return;
    const fixture = await contextFixture(roots);
    const request = {callerCwd: fixture.repository};

    await writeFile(fixture.manifest, '{}\n');
    await expect(handleMatchedEvaluationContextRequest(fixture.packet, request)).rejects.toThrow(
      'differs from the sealed artifact',
    );

    const rebound = renderMatchedEvaluationRuntimeManifestV1(
      fixture.packet.project,
      join(fixture.root, 'different-repository'),
      fixture.packet.runNonce,
    );
    await writeFile(fixture.manifest, rebound);
    await expect(
      handleMatchedEvaluationContextRequest(
        {...fixture.packet, runtimeManifestSha256: sha256HexSync(Buffer.from(rebound))},
        request,
      ),
    ).rejects.toThrow('does not bind the isolated repository and run');

    const outsideRoot = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-matched-context-outside-')));
    roots.push(outsideRoot);
    const escapedManifest = join(outsideRoot, 'manifest.yaml');
    const expected = renderMatchedEvaluationRuntimeManifestV1(
      fixture.packet.project,
      fixture.repository,
      fixture.packet.runNonce,
    );
    await writeFile(escapedManifest, expected, {mode: 0o600});
    await expect(
      handleMatchedEvaluationContextRequest(
        {
          ...fixture.packet,
          runtimeManifestPath: escapedManifest,
          runtimeManifestSha256: sha256HexSync(Buffer.from(expected)),
        },
        request,
      ),
    ).rejects.toThrow('escaped its isolated private root');
  });

  it('exposes only graph follow-ups for graph-only treatment and binds scope', async () => {
    if (process.platform === 'win32') return;
    const fixture = await contextFixture(roots, 'graph prompt', 'graph-only');
    const invoke = async (_packet: unknown, name: string, args: Record<string, unknown>) => ({
      content: [{type: 'text' as const, text: JSON.stringify({name, args})}],
    });
    const result = await handleMatchedEvaluationFollowupRequest(
      fixture.packet,
      'inspect_code_graph',
      {callerCwd: fixture.repository, project: fixture.packet.project, operation: 'query', query: 'fixture'},
      invoke,
    );
    expect(result.isError).not.toBe(true);
    await expect(
      handleMatchedEvaluationFollowupRequest(
        fixture.packet,
        'recall_context',
        {callerCwd: fixture.repository, project: fixture.packet.project, query: 'memory'},
        invoke,
      ),
    ).rejects.toThrow('Tool is not allowed');
    await expect(
      handleMatchedEvaluationFollowupRequest(
        fixture.packet,
        'inspect_code_graph',
        {callerCwd: fixture.repository, project: 'other', operation: 'query', query: 'fixture'},
        invoke,
      ),
    ).rejects.toThrow('project');
    await expect(
      handleMatchedEvaluationFollowupRequest(
        fixture.packet,
        'inspect_code_graph',
        {callerCwd: fixture.root, project: fixture.packet.project, operation: 'query', query: 'fixture'},
        invoke,
      ),
    ).rejects.toThrow('escaped');
    await expect(
      handleMatchedEvaluationFollowupRequest(
        fixture.packet,
        'inspect_code_graph',
        {
          callerCwd: fixture.repository,
          project: fixture.packet.project,
          operation: 'query',
          query: 'fixture',
          workset: 'escape',
        },
        invoke,
      ),
    ).rejects.toThrow('excess property');
  });

  it('allows compact linked-memory follow-ups and rejects escaped memory reads', async () => {
    if (process.platform === 'win32') return;
    const fixture = await contextFixture(roots, 'compact prompt', 'compact', 'linked');
    const invoke = async () => ({content: [{type: 'text' as const, text: 'linked result'}]});
    const result = await handleMatchedEvaluationFollowupRequest(
      fixture.packet,
      'read_context',
      {uri: 'threadnote://memory/tn_fixture'},
      invoke,
    );
    expect(result.isError).not.toBe(true);
    await expect(
      handleMatchedEvaluationFollowupRequest(
        fixture.packet,
        'read_context',
        {uri: 'threadnote://memory/../escape'},
        invoke,
      ),
    ).rejects.toThrow('outside the isolated');
    await expect(
      handleMatchedEvaluationFollowupRequest(
        fixture.packet,
        'read_context',
        {uri: `threadnote://user/${fixture.packet.threadnoteUser}/memories/../../escape`},
        invoke,
      ),
    ).rejects.toThrow('outside the isolated');
  });

  it('canonicalizes follow-up request hash independently of object key order', () => {
    fc.assert(
      fc.property(fc.string({minLength: 1, maxLength: 32}), fc.string({minLength: 1, maxLength: 32}), (a, b) => {
        const left = {callerCwd: a, project: b, operation: 'stats'};
        const right = {operation: 'stats', project: b, callerCwd: a};
        expect(hashMatchedEvaluationContextRequest('inspect_code_graph', left)).toBe(
          hashMatchedEvaluationContextRequest('inspect_code_graph', right),
        );
      }),
      {numRuns: 50},
    );
  });
});

const preparedEvidence = {
  answer: 'prepared context',
  activeHandoffs: [
    {continuationCard: {nextStep: 'continue the prepared implementation contract'}, uri: 'prepared context'},
  ],
  graph: {cards: [{path: 'service.ts', summary: 'current implementation evidence'}]},
  durableDecisions: [{summary: 'linked memory contract'}],
  coverage: {gaps: []},
};

async function contextFixture(
  roots: string[],
  prompt = 'Inspect the isolated repository.',
  detail: 'compact' | 'graph-only' | 'source' = 'graph-only',
  memoryAccess: 'disabled' | 'linked' = 'disabled',
  mode: 'brief' | 'resume' = 'brief',
  evidence: unknown = preparedEvidence,
): Promise<{
  readonly manifest: string;
  readonly packet: MatchedEvaluationContextProxyPacketV1;
  readonly repository: string;
  readonly root: string;
  readonly seenTask: () => Promise<string>;
  readonly seenMode: () => Promise<string>;
  readonly seenResponseFormat: () => Promise<string>;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-matched-context-')));
  roots.push(root);
  const repository = join(root, 'repository');
  const threadnoteHome = join(root, 'threadnote-home');
  const privateRoot = join(root, 'agent', 'private');
  await Promise.all([
    mkdir(repository, {recursive: true}),
    mkdir(threadnoteHome, {recursive: true}),
    mkdir(privateRoot, {recursive: true}),
  ]);
  const project = 'matched-evaluation-fixture';
  const runNonce = 'run_0123456789abcdef0123456789abcdef';
  const manifest = join(privateRoot, 'manifest.json');
  const manifestText = renderMatchedEvaluationRuntimeManifestV1(project, repository, runNonce);
  const manifestBytes = Buffer.from(manifestText);
  const executable = join(root, 'threadnote');
  const seenTaskPath = join(root, 'seen-task');
  const seenModePath = join(root, 'seen-mode');
  const seenResponseFormatPath = join(root, 'seen-response-format');
  await writeFile(
    executable,
    fakeThreadnoteMcpProgram(
      {
        project,
        repository,
        runNonce,
        seenModePath,
        seenResponseFormatPath,
        seenTaskPath,
      },
      evidence,
    ),
    {mode: 0o700},
  );
  await chmod(executable, 0o700);
  await writeFile(manifest, manifestBytes, {mode: 0o600});
  return {
    manifest,
    packet: {
      budgetTokens: 1_500,
      detail,
      mode,
      expectedContext: {
        graphContentHash: '1'.repeat(64),
        graphSnapshotHash: '2'.repeat(64),
        linkReceiptsHash: memoryAccess === 'linked' ? '4'.repeat(64) : null,
        memoryAccess,
        studyHash: '3'.repeat(64),
        taskContextHash: memoryAccess === 'linked' ? '5'.repeat(64) : null,
      },
      expectedResume:
        mode === 'resume'
          ? {
              automaticHandoffUri: 'prepared context',
              requiredGraphQuery: null,
              resumeEvidenceMarker: 'implementation contract',
            }
          : null,
      initialBriefDelivery: 'mcp',
      maximumFollowupCalls: mode === 'resume' ? 1 : detail === 'source' ? 0 : 4,
      project,
      prompt,
      repositoryRoot: repository,
      runNonce,
      runtimeManifestPath: manifest,
      runtimeManifestSha256: sha256HexSync(manifestBytes),
      threadnoteAccount: 'local',
      threadnoteExecutable: executable,
      threadnoteExecutableSha256: sha256HexSync(await readFile(executable)),
      threadnoteHome,
      threadnoteUser: 'evaluation-user',
      version: MATCHED_EVALUATION_CONTEXT_PROXY_VERSION,
    },
    repository,
    root,
    seenTask: () => readFile(seenTaskPath, 'utf8'),
    seenMode: () => readFile(seenModePath, 'utf8'),
    seenResponseFormat: () => readFile(seenResponseFormatPath, 'utf8'),
  };
}

function fakeThreadnoteMcpProgram(
  input: {
    readonly project: string;
    readonly repository: string;
    readonly runNonce: string;
    readonly seenModePath: string;
    readonly seenResponseFormatPath: string;
    readonly seenTaskPath: string;
  },
  evidence: unknown,
): string {
  return `#!${process.execPath}
import {readFileSync, writeFileSync} from 'node:fs';

const expected = ${JSON.stringify(input)};
const preparedEvidence = ${JSON.stringify(evidence)};
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf('\\n');
    if (newline === -1) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line !== '') handle(JSON.parse(line));
  }
});

function handle(message) {
  if (message.method === 'initialize') {
    send({
      id: message.id,
      jsonrpc: '2.0',
      result: {
        capabilities: {tools: {}},
        protocolVersion: message.params.protocolVersion,
        serverInfo: {name: 'fixture-threadnote', version: '1'},
      },
    });
    return;
  }
  if (message.method === 'notifications/initialized') return;
  if (message.method !== 'tools/call') {
    if (message.id !== undefined) {
      send({error: {code: -32601, message: 'Unsupported fixture method'}, id: message.id, jsonrpc: '2.0'});
    }
    return;
  }
  try {
    const manifestPath = process.env.THREADNOTE_MANIFEST;
    if (!manifestPath) throw new Error('missing manifest');
    const manifest = readFileSync(manifestPath, 'utf8');
    if (
      !manifest.includes(JSON.stringify(expected.project)) ||
      !manifest.includes(JSON.stringify(expected.repository)) ||
      !manifest.includes(JSON.stringify(expected.runNonce))
    ) throw new Error('manifest mismatch');
    if (process.env.THREADNOTE_ACCOUNT !== 'local' || process.env.THREADNOTE_USER !== 'evaluation-user') {
      throw new Error('identity mismatch');
    }
    const arguments_ = message.params.arguments;
    if (message.params.name === 'inspect_code_graph') {
      send({
        id: message.id,
        jsonrpc: '2.0',
        result: {content: [{text: JSON.stringify({nodes: [{path: 'service.ts'}]}), type: 'text'}]},
      });
      return;
    }
    if (message.params.name !== 'context_brief') throw new Error('tool mismatch');
    writeFileSync(expected.seenTaskPath, arguments_.task);
    writeFileSync(expected.seenModePath, arguments_.mode);
    writeFileSync(expected.seenResponseFormatPath, arguments_.responseFormat);
    send({
      id: message.id,
      jsonrpc: '2.0',
      result: {content: [{text: JSON.stringify(preparedEvidence), type: 'text'}]},
    });
  } catch (cause) {
    send({
      error: {code: -32603, message: cause instanceof Error ? cause.message : 'fixture failure'},
      id: message.id,
      jsonrpc: '2.0',
    });
  }
}
`;
}
