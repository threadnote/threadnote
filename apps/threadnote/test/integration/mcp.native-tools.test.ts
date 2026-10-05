import {TestError} from '@threadnote/testing/test-error';
import {createHash} from '@threadnote/testing/node-crypto';
import {existsSync} from '@threadnote/testing/node-fs';
import {mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {execFileSync} from '@threadnote/testing/node-child-process';
import {tmpdir} from '@threadnote/testing/node-os';
import {basename, join} from '@threadnote/testing/node-path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {AGENT_RESPONSE_ESTIMATED_BYTES_PER_TOKEN} from '@threadnote/protocol/agent-response';
import {renderSessionStartRecallQueue} from '@threadnote/threadnote/hooks';
import {
  createMemoryCodeCitation,
  MAX_MEMORY_CODE_CITATIONS,
  MEMORY_SCHEMA_VERSION,
} from '@threadnote/memory/code/citation';
import {
  canonicalMemoryDocumentContent,
  formatMemoryDocument,
  MAX_MEMORY_RELATIONS,
  MEMORY_RELATION_TYPES,
  parseMemoryDocument,
} from '@threadnote/memory/document';
import {memoryIdentityAlias} from '@threadnote/memory/identity-alias';
import {isDeferredCodeAnchorIntentFilename} from '@threadnote/threadnote/memory/deferred/code_anchor';
import {recallIndexDatabaseFilename} from '@threadnote/recall/index';
import {
  parseContextBriefJsonText,
  parseContextBriefV1,
  projectContextBriefAgentView,
} from '@threadnote/context/projector';
import {MCP_RESOURCE_READ_MAX_BYTES} from '@threadnote/threadnote/effect/ai/mcp_resource';
import {MEMORY_READ_PAGE_BYTES} from '@threadnote/memory/read/projection';
import {
  compactPersonalMemoryReferences,
  compactPersonalMemoryStructuredReferences,
  requiredResourceUriList,
} from '../../src/mcp/server/common.js';

interface TextContent {
  readonly text: string;
  readonly type: 'text';
}

interface ThreadnoteProgress {
  readonly _meta?: Readonly<Record<string, unknown>>;
  readonly message?: string;
  readonly progress: number;
  readonly total?: number;
}

interface ReadStructuredContent {
  readonly canonicalUri?: string;
  readonly complete: boolean;
  readonly content: string;
  readonly contentBytes: number;
  readonly nextOffsetBytes?: number;
  readonly offsetBytes?: number;
  readonly requestedUri?: string;
  readonly resourceCount: number;
  readonly sourceHash?: string;
  readonly totalBytes?: number;
  readonly type: 'threadnote-read';
}

async function listDeferredCodeAnchorIntentRelativePaths(root: string): Promise<readonly string[]> {
  const names = await readdir(root, {recursive: true});
  return names.filter(name => isDeferredCodeAnchorIntentFilename(basename(name))).sort();
}

const RECALL_PROGRESS_PHASES = [
  'recall.shared-sync',
  'recall.obsidian-sync',
  'recall.workspace-context',
  'recall.semantic-retrieval',
  'recall.lexical-ranking',
] as const;

const COLD_BUILD_TOOL_TIMEOUT_MILLISECONDS = 10_000;

const CORE_TOOL_NAMES = [
  'complete_activation_retrieval_proof',
  'recall_context',
  'inspect_code_graph',
  'analyze_code_graph',
  'context_brief',
  'read_context',
  'list_context',
  'remember_context',
  'finalize_code_refs',
  'review_session_context',
  'apply_memory_candidates',
  'obsidian_publish',
  'context_health',
  'context_health_aggregate',
  'context_health_schedule',
  'context_health_repair_preview',
  'context_health_repair_apply',
  'context_metadata_preview',
  'context_metadata_apply',
  'recall_feedback',
  'threadnote_guide',
  'share_propose',
  'procedure_publish_preview',
  'procedure_publish_apply',
  'share_publish',
];

const ADVANCED_TOOL_NAMES = [
  'context_maintenance_status',
  'context_maintain',
  'context_maintenance_packet',
  'search',
  'read',
  'list',
  'store',
  'archive',
  'archive_context',
  'compact_context',
  'forget',
  'add_resource',
  'grep',
  'glob',
  'health',
  'share_conflicts',
  'share_conflict_show',
  'share_conflict_resolve',
  'share_skill',
  'share_bundle',
  'list_shared_skills',
  'install_shared_skill',
];

const LIFECYCLE_TOOL_NAMES = [
  'context_health',
  'context_health_aggregate',
  'context_health_schedule',
  'context_health_repair_preview',
  'context_health_repair_apply',
  'context_metadata_preview',
  'context_metadata_apply',
  'recall_feedback',
  'procedure_publish_preview',
  'procedure_publish_apply',
];

interface McpFixture {
  readonly home: string;
  readonly root: string;
}

interface McpClientOptions {
  readonly environment?: Readonly<Record<string, string>>;
  readonly maxBufferSize?: number;
  readonly toolset?: 'core' | 'full' | null;
}

async function withMcpClient<T>(
  fn: (client: Client, fixture: McpFixture) => Promise<T>,
  options: McpClientOptions = {},
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'threadnote-mcp-native-'));
  const home = join(root, 'home');
  await mkdir(home, {recursive: true});
  const fixture = {home, root};
  try {
    return await withMcpClientForFixture(fixture, fn, options);
  } finally {
    await rm(root, {force: true, recursive: true});
  }
}

async function withMcpClientForFixture<T>(
  fixture: McpFixture,
  fn: (client: Client, fixture: McpFixture) => Promise<T>,
  options: McpClientOptions = {},
): Promise<T> {
  const client = await connectMcpClient(fixture, options);
  try {
    return await fn(client, fixture);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function connectMcpClient(fixture: McpFixture, options: McpClientOptions = {}): Promise<Client> {
  const repoRoot = process.cwd();
  const environment = {
    ...process.env,
    ...options.environment,
    THREADNOTE_ACCOUNT: 'local',
    THREADNOTE_AGENT_ID: 'threadnote',
    THREADNOTE_HOME: fixture.home,
    THREADNOTE_MANIFEST: join(fixture.home, 'seed-manifest.yaml'),
    THREADNOTE_USER: 'test-user',
  } as Record<string, string>;
  if (options.toolset === null) {
    delete environment.THREADNOTE_MCP_TOOLSET;
  } else {
    environment.THREADNOTE_MCP_TOOLSET = options.toolset ?? 'full';
  }
  const transport = new StdioClientTransport({
    args: [join(repoRoot, 'apps', 'threadnote', 'src', 'standalone.ts'), 'mcp-server'],
    command: process.execPath,
    cwd: repoRoot,
    env: environment,
    maxBufferSize: options.maxBufferSize,
    stderr: 'pipe',
  });
  const client = new Client({name: 'threadnote-test', version: '0.0.0'});
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

async function callCodeGraphUntilReady(client: Client, arguments_: Readonly<Record<string, unknown>>) {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const result = await client.callTool(
      {arguments: {responseFormat: 'dual', ...arguments_}, name: 'inspect_code_graph'},
      undefined,
      {
        timeout: 30_000,
      },
    );
    const structured = result.structuredContent as
      {readonly reason?: unknown; readonly retryAfterMilliseconds?: unknown; readonly state?: unknown} | undefined;
    if (structured?.state === 'unavailable') {
      throw TestError.make({
        message: `Code graph was unavailable while waiting for a ready snapshot (reason=${String(structured.reason)}).`,
      });
    }
    if (!isRetryableCodeGraphState(structured?.state)) return result;
    if (Date.now() >= deadline) {
      throw TestError.make({message: `Code graph remained ${String(structured?.state)} for 90 seconds.`});
    }
    const requestedDelay =
      typeof structured?.retryAfterMilliseconds === 'number' ? structured.retryAfterMilliseconds : 250;
    await new Promise(resolve => setTimeout(resolve, Math.max(50, Math.min(1_000, requestedDelay))));
  }
}

function indexCodeGraph(fixture: McpFixture, repository: string): void {
  execFileSync(
    process.execPath,
    [join(process.cwd(), 'apps', 'threadnote', 'src', 'standalone.ts'), 'graph', 'index', '--no-vectors'],
    {
      cwd: repository,
      env: {
        ...process.env,
        THREADNOTE_ACCOUNT: 'local',
        THREADNOTE_AGENT_ID: 'threadnote',
        THREADNOTE_HOME: fixture.home,
        THREADNOTE_MANIFEST: join(fixture.home, 'seed-manifest.yaml'),
        THREADNOTE_USER: 'test-user',
      },
      stdio: 'pipe',
    },
  );
}

function isRetryableCodeGraphState(state: unknown): boolean {
  return state === 'indexing' || state === 'timed-out' || state === 'timed_out';
}

function canonicalMemoryContent(topic: string, body: string): string {
  return [
    'MEMORY',
    'kind: durable',
    'status: active',
    'project: threadnote',
    `topic: ${topic}`,
    'source_agent_client: integration-test',
    'timestamp: 2026-08-01T00:00:00.000Z',
    '',
    body,
  ].join('\n');
}

function largeReadBody(label: string, lineCount: number): string {
  return Array.from(
    {length: lineCount},
    (_, index) => `${label} ${index.toString().padStart(5, '0')} ${'payload '.repeat(8)}payload`,
  ).join('\n');
}

async function writeCanonicalMemory(home: string, filename: string, content: string): Promise<void> {
  const directory = join(home, 'data', 'local', 'user', 'test-user', 'memories', 'durable', 'projects', 'threadnote');
  await mkdir(directory, {recursive: true});
  await writeFile(join(directory, filename), content, 'utf8');
}

function recallProgressPhases(updates: readonly ThreadnoteProgress[]): string[] {
  return updates.map(update => {
    const metadata = update._meta?.['threadnote.io/progress'] as
      {readonly phase?: unknown; readonly version?: unknown} | undefined;
    expect(metadata?.version).toBe(1);
    expect(metadata).not.toHaveProperty('retryAfterMilliseconds');
    expect(typeof metadata?.phase).toBe('string');
    return metadata?.phase as string;
  });
}

function collapseConsecutive<T>(values: readonly T[]): T[] {
  return values.filter((value, index) => index === 0 || value !== values[index - 1]);
}

function expectOrderedRecallProgress(updates: readonly ThreadnoteProgress[]): string[] {
  expect(updates.length).toBeGreaterThanOrEqual(RECALL_PROGRESS_PHASES.length);
  expect(updates.map(update => update.progress)).toEqual(Array.from({length: updates.length}, (_, index) => index + 1));
  const phases = recallProgressPhases(updates);
  expect(collapseConsecutive(phases)).toEqual(RECALL_PROGRESS_PHASES);
  return phases;
}

function expectRequestLocalRecallProgress(updates: readonly ThreadnoteProgress[]): void {
  expect(updates.length).toBeGreaterThan(0);
  expect(updates.map(update => update.progress)).toEqual(Array.from({length: updates.length}, (_, index) => index + 1));
  const phases = collapseConsecutive(recallProgressPhases(updates));
  expect(phases).toEqual(RECALL_PROGRESS_PHASES.slice(0, phases.length));
}

describe('Threadnote MCP toolsets', () => {
  it('compacts only exact raw and canonical personal memory references for the active user', () => {
    const currentUser = 'test user';
    const text = [
      'threadnote://user/test%20user/memories/durable/projects/threadnote/current.md',
      'threadnote://user/test-user/memories/durable/projects/threadnote/canonical.md',
      'threadnote://user/other/memories/durable/projects/threadnote/other.md',
      'threadnote://memory/tn_stable',
      'threadnote://user/test%20user/memories/durable/%2e%2e/secret.md',
      'threadnote://user/test%20user/memories/durable/projects/threadnote/%zz.md',
    ].join('\n');

    expect(compactPersonalMemoryReferences(text, currentUser)).toBe(
      [
        'memories/durable/projects/threadnote/current.md',
        'memories/durable/projects/threadnote/canonical.md',
        'threadnote://user/other/memories/durable/projects/threadnote/other.md',
        'threadnote://memory/tn_stable',
        'threadnote://user/test%20user/memories/durable/%2e%2e/secret.md',
        'threadnote://user/test%20user/memories/durable/projects/threadnote/%zz.md',
      ].join('\n'),
    );
    expect(compactPersonalMemoryReferences(text, currentUser, false)).toBe(text);
    expect(
      requiredResourceUriList(
        'memories/durable/projects/threadnote/current.md',
        'read_context',
        'threadnote://user/test-user/memories/durable/projects/threadnote/current.md',
        {personalMemoryUser: currentUser},
      ),
    ).toEqual({
      ok: true,
      value: ['threadnote://user/test-user/memories/durable/projects/threadnote/current.md'],
    });
  });

  it('preserves Markdown delimiters around compacted personal memory references', () => {
    const trailingPunctuation = ','.repeat(10_000);
    const text = [
      '`threadnote://user/test-user/memories/durable/projects/threadnote/inline.md`',
      '```text',
      'threadnote://user/test-user/memories/durable/projects/threadnote/fenced.md',
      '```',
      `threadnote://user/test-user/memories/durable/projects/threadnote/punctuated.md${trailingPunctuation}`,
    ].join('\n');

    expect(compactPersonalMemoryReferences(text, 'test user')).toBe(
      [
        '`memories/durable/projects/threadnote/inline.md`',
        '```text',
        'memories/durable/projects/threadnote/fenced.md',
        '```',
        `memories/durable/projects/threadnote/punctuated.md${trailingPunctuation}`,
      ].join('\n'),
    );
  });

  it('compacts canonical current-user memory references deterministically', () => {
    const word = fc.stringMatching(/^[a-z]{1,8}$/u);
    const topic = fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/u);
    fc.assert(
      fc.property(word, word, word, topic, (first, last, foreign, memoryTopic) => {
        const currentUser = `${first.toUpperCase()}.${last} ${first}`;
        const canonicalUser = `${first}.${last}-${first}`;
        const rawCurrentUri = `threadnote://user/${encodeURIComponent(currentUser)}/memories/durable/projects/threadnote/${memoryTopic}.md`;
        const canonicalCurrentUri = `threadnote://user/${canonicalUser}/memories/durable/projects/threadnote/${memoryTopic}.md`;
        const foreignUri = `threadnote://user/${encodeURIComponent(foreign)}/memories/durable/projects/threadnote/${memoryTopic}.md`;
        const input = [rawCurrentUri, canonicalCurrentUri, foreignUri, 'threadnote://memory/tn_stable'].join('\n');
        const expected = [
          `memories/durable/projects/threadnote/${memoryTopic}.md`,
          `memories/durable/projects/threadnote/${memoryTopic}.md`,
          foreignUri,
          'threadnote://memory/tn_stable',
        ].join('\n');

        const compacted = compactPersonalMemoryReferences(input, currentUser);
        expect(compacted).toBe(expected);
        expect(compactPersonalMemoryReferences(compacted, currentUser)).toBe(expected);

        const sharedCurrentUri = rawCurrentUri.replace('/memories/', '/memories/shared/default/');
        const structured = {
          nested: [{uri: rawCurrentUri}, {uri: sharedCurrentUri}, {uri: foreignUri}],
          text: `Read ${canonicalCurrentUri} first.`,
        };
        const original = JSON.stringify(structured);
        const compactedStructured = compactPersonalMemoryStructuredReferences(structured, currentUser);
        expect(compactedStructured).toEqual({
          nested: [
            {uri: `memories/durable/projects/threadnote/${memoryTopic}.md`},
            {uri: `memories/shared/default/durable/projects/threadnote/${memoryTopic}.md`},
            {uri: foreignUri},
          ],
          text: `Read memories/durable/projects/threadnote/${memoryTopic}.md first.`,
        });
        expect(JSON.stringify(structured)).toBe(original);
        expect(compactPersonalMemoryStructuredReferences(compactedStructured, currentUser)).toEqual(
          compactedStructured,
        );
      }),
      {numRuns: 50},
    );
  });

  it('keeps the core server instructions compact and self-contained', async () => {
    await withMcpClient(
      async client => {
        const instructions = client.getInstructions() ?? '';
        expect(Buffer.byteLength(instructions)).toBeLessThanOrEqual(300);
        expect(instructions).toContain('Choose the tool whose description matches the evidence gap');
        expect(instructions).toContain('verify returned evidence in source');
        expect(instructions).toContain('Writes stay private unless sharing is confirmed');
        expect(instructions).toContain(
          'Never auto-apply/share or store secrets, credentials, customer data, or raw logs',
        );
        expect(instructions).not.toContain('For non-trivial work call');
        expect(instructions).not.toContain('Finish with private');
        const reviewTool = (await client.listTools()).tools.find(tool => tool.name === 'review_session_context');
        expect(reviewTool?.description).toContain('five-field Knowledge Delta');
        expect(reviewTool?.description).toContain('handoff is separate and required');
        expect(reviewTool?.description).toContain('explicit approval is required');
        expect(reviewTool?.description).not.toContain('After routine durable and handoff writes');
      },
      {toolset: 'core'},
    );
  });

  it('advertises only the core tools by default', async () => {
    await withMcpClient(
      async client => {
        const tools = await client.listTools();
        expect(tools.tools.map(tool => tool.name)).toEqual(CORE_TOOL_NAMES);
        for (const lifecycleTool of LIFECYCLE_TOOL_NAMES) {
          expect(tools.tools.map(tool => tool.name)).toContain(lifecycleTool);
        }
        for (const fullOnlyTool of ['archive', 'compact_context', 'forget', 'share_conflicts', 'share_skill']) {
          expect(tools.tools.map(tool => tool.name)).not.toContain(fullOnlyTool);
        }
        const serializedToolsBytes = Buffer.byteLength(JSON.stringify(tools.tools));
        // Ratchet the eager-host fallback catalog; search-capable hosts can defer these definitions.
        expect(serializedToolsBytes).toBeLessThanOrEqual(31_000);
        expect(tools.tools.find(tool => tool.name === 'recall_context')?.description).toContain(
          'unread threadnote:// pointers, not evidence',
        );
        expect(tools.tools.find(tool => tool.name === 'finalize_code_refs')?.inputSchema).toMatchObject({
          properties: {
            uri: {type: 'string'},
          },
        });
        expect(tools.tools.find(tool => tool.name === 'share_publish')?.inputSchema).toMatchObject({
          properties: {
            allowUncitedPendingCodeRefs: {type: 'boolean'},
          },
        });
        const readContext = tools.tools.find(tool => tool.name === 'read_context');
        expect(readContext?.description).toContain(`${MCP_RESOURCE_READ_MAX_BYTES} bytes`);
        expect(readContext?.description).toContain('mode=outline or section');
        expect(readContext?.description).toContain('offsetBytes=0');
        expect(readContext?.inputSchema.properties).toHaveProperty('responseFormat');
        expect(readContext?.inputSchema.properties).not.toHaveProperty('budgetTokens');
        expect(readContext?.inputSchema.properties).not.toHaveProperty('cursor');
        for (const name of ['inspect_code_graph', 'context_brief']) {
          const tool = tools.tools.find(candidate => candidate.name === name);
          expect(JSON.stringify(tool?.inputSchema)).toContain('responseFormat');
          expect(JSON.stringify(tool?.inputSchema)).toContain('agent');
          expect(tool?.description).toContain('semantic truncation');
        }
      },
      {toolset: null},
    );
  });

  it('advertises bounded Threadnote resource discovery without enumerating private memories', async () => {
    await withMcpClient(
      async client => {
        expect(client.getServerCapabilities()?.resources).toEqual({listChanged: true, subscribe: false});
        await expect(client.listResources()).resolves.toEqual({resources: []});

        const templates = await client.listResourceTemplates();
        expect(templates.resourceTemplates).toEqual([
          expect.objectContaining({
            mimeType: 'text/plain; charset=utf-8',
            name: 'Threadnote canonical resource',
            uriTemplate: 'threadnote://{+resourcePath}',
          }),
        ]);
        expect(templates.resourceTemplates[0]?._meta).toEqual({
          'threadnote.io/max-resource-bytes': MCP_RESOURCE_READ_MAX_BYTES,
        });
      },
      {toolset: 'core'},
    );
  });

  it('reads one canonical Threadnote URI through the standard MCP resource protocol', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const uri = 'threadnote://user/test-user/memories/durable/projects/threadnote/protocol-resource.md';
        const content = canonicalMemoryContent('protocol-resource', 'Protocol resource body.');
        await writeCanonicalMemory(fixture.home, 'protocol-resource.md', content);

        await expect(client.readResource({uri})).resolves.toEqual({
          contents: [{mimeType: 'text/plain; charset=utf-8', text: content, uri}],
        });
      },
      {toolset: 'core'},
    );
  });

  it('rejects invalid, missing, and oversized protocol resources with bounded privacy-safe errors', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const missingUri =
          'threadnote://user/test-user/memories/durable/projects/threadnote/missing-protocol-resource.md';
        const crossUserUri =
          'threadnote://user/other-user/memories/durable/projects/threadnote/private-protocol-resource.md';
        const crossAccountUri = 'threadnote://resources/private-protocol-resource.txt';
        const invalidUtf8Uri = 'threadnote://resources/invalid-utf8-protocol-resource.txt';
        const oversizedUri =
          'threadnote://user/test-user/memories/durable/projects/threadnote/oversized-protocol-resource.md';
        await writeCanonicalMemory(
          fixture.home,
          'oversized-protocol-resource.md',
          canonicalMemoryContent(
            'oversized-protocol-resource',
            `LOCAL_RESOURCE_PRIVATE_SENTINEL\n${'x'.repeat(1_000_000)}`,
          ),
        );
        const foreignAccountResources = join(fixture.home, 'data', 'other-account', 'resources');
        await mkdir(foreignAccountResources, {recursive: true});
        await writeFile(
          join(foreignAccountResources, 'private-protocol-resource.txt'),
          'foreign account secret',
          'utf8',
        );
        const activeAccountResources = join(fixture.home, 'data', 'local', 'resources');
        await mkdir(activeAccountResources, {recursive: true});
        await writeFile(join(activeAccountResources, 'invalid-utf8-protocol-resource.txt'), Uint8Array.of(0xc3, 0x28));

        const invalidError = await client.readResource({uri: 'file:///tmp/private-memory.md'}).then(
          () => undefined,
          error => error as Error & {readonly code?: number; readonly data?: unknown},
        );
        expect(invalidError).toMatchObject({
          code: -32602,
          message: expect.stringContaining('canonical threadnote:// URI'),
        });
        expect(invalidError?.message).not.toContain('/tmp/private-memory.md');
        expect(invalidError?.data).toBeUndefined();
        await expect(client.readResource({uri: `${missingUri}/`})).rejects.toMatchObject({
          code: -32602,
          message: expect.stringContaining('canonical threadnote:// URI'),
        });
        await expect(
          client.readResource({uri: missingUri.replace('threadnote://', 'viking://')}),
        ).rejects.toMatchObject({
          code: -32602,
          message: expect.stringContaining('canonical threadnote:// URI'),
        });
        const missingError = await client.readResource({uri: missingUri}).then(
          () => undefined,
          error => error as Error & {readonly code?: number; readonly data?: unknown},
        );
        expect(missingError).toMatchObject({
          code: -32002,
          message: expect.stringContaining('Threadnote resource was not found.'),
        });
        expect(missingError?.data).toMatchObject({
          code: 'memory-resource-not-found',
          nextAction: {
            arguments: {query: 'missing-protocol-resource'},
            tool: 'recall_context',
          },
          recoveryAction: 'recall-canonical-uri',
          requestedUri: missingUri,
          retryable: false,
          type: 'threadnote-memory-read-recovery',
          version: 1,
        });
        const crossUserError = await client.readResource({uri: crossUserUri}).then(
          () => undefined,
          error => error as Error & {readonly code?: number; readonly data?: unknown},
        );
        expect(crossUserError).toMatchObject({
          code: -32602,
          message: expect.stringContaining('not readable in the active account'),
        });
        expect(crossUserError?.message).not.toContain('other-user');
        expect(crossUserError?.data).toBeUndefined();
        const crossAccountError = await client.readResource({uri: crossAccountUri}).then(
          () => undefined,
          error => error as Error & {readonly code?: number; readonly data?: unknown},
        );
        expect(crossAccountError).toMatchObject({
          code: -32002,
          message: expect.stringContaining('Threadnote resource was not found.'),
        });
        expect(crossAccountError?.message).not.toContain('other-account');
        expect(crossAccountError?.message).not.toContain(fixture.root);
        expect(crossAccountError?.data).toBeUndefined();
        const invalidUtf8Error = await client.readResource({uri: invalidUtf8Uri}).then(
          () => undefined,
          error => error as Error & {readonly code?: number; readonly data?: unknown},
        );
        expect(invalidUtf8Error).toMatchObject({
          code: -32603,
          message: expect.stringContaining('Threadnote resource could not be read safely.'),
        });
        expect(invalidUtf8Error?.message).not.toContain('invalid-utf8-protocol-resource');
        expect(invalidUtf8Error?.message).not.toContain(fixture.root);
        expect(invalidUtf8Error?.data).toBeUndefined();
        const oversizedError = await client.readResource({uri: oversizedUri}).then(
          () => undefined,
          error => error as Error & {readonly code?: number; readonly data?: unknown},
        );
        expect(oversizedError).toMatchObject({
          code: -32602,
          message: expect.stringContaining(
            `Threadnote resource exceeds the ${MCP_RESOURCE_READ_MAX_BYTES}-byte resources/read limit; use read_context with mode=outline or section, or pass one URI with offsetBytes=0 for explicit pages.`,
          ),
        });
        expect(oversizedError?.message).not.toContain('LOCAL_RESOURCE_PRIVATE_SENTINEL');
      },
      {toolset: 'core'},
    );
  });

  it('emits and enforces Effect Schema inputs over stdio', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const tools = await client.listTools();
        const recall = tools.tools.find(tool => tool.name === 'recall_context');
        expect(recall?.inputSchema).toMatchObject({
          additionalProperties: false,
          properties: {
            budgetTokens: {maximum: 1_500, minimum: 700, type: 'integer'},
            callerCwd: {type: 'string'},
            explain: {type: 'boolean'},
            nodeLimit: {maximum: 100, minimum: 1, type: 'integer'},
            project: {type: 'string'},
            query: {description: expect.stringContaining('optional when memoryRefs'), type: 'string'},
            responseFormat: {enum: ['dual', 'agent']},
            threshold: {maximum: 1, minimum: 0, type: 'number'},
          },
          type: 'object',
        });
        expect(recall?.inputSchema.properties).toMatchObject({
          memoryRefs: {
            anyOf: [{type: 'string'}, {items: {type: 'string'}, maxItems: 8, type: 'array'}],
          },
          relationTypes: {
            anyOf: [
              {enum: MEMORY_RELATION_TYPES, type: 'string'},
              {items: {enum: MEMORY_RELATION_TYPES, type: 'string'}, maxItems: 5, type: 'array'},
            ],
          },
        });
        expect(JSON.stringify(recall?.inputSchema)).not.toContain('null');
        const read = tools.tools.find(tool => tool.name === 'read_context');
        expect(read?.inputSchema.properties).not.toHaveProperty('full');
        expect(read?.inputSchema.properties).toMatchObject({
          responseFormat: {enum: ['agent', 'dual', 'text']},
        });
        for (const name of ['remember_context', 'review_session_context']) {
          const codeReferenceTool = tools.tools.find(tool => tool.name === name);
          expect(codeReferenceTool?.inputSchema).toMatchObject({
            properties: {
              codeRefs: {
                anyOf: [
                  {type: 'string'},
                  {
                    items: {type: 'string'},
                    maxItems: MAX_MEMORY_CODE_CITATIONS,
                    type: 'array',
                  },
                ],
                description: expect.stringContaining(`max ${MAX_MEMORY_CODE_CITATIONS}`),
              },
            },
          });
          expect(JSON.stringify(codeReferenceTool?.inputSchema)).toContain('Graph-indexed repository-relative path');
        }
        const remember = tools.tools.find(tool => tool.name === 'remember_context');
        expect(remember?.description).toContain('task; decisions/invariants; verification; blockers/risks; next_step');
        expect(remember?.description).toContain('CodeRefs enable compact resume');
        expect(remember?.description).toContain('Skip Knowledge Delta review');
        expect(remember?.inputSchema).toMatchObject({
          properties: {
            citationPolicy: {enum: ['require-current', 'defer'], type: 'string'},
            clearKeywords: {
              description: expect.stringContaining('handoff/smoke allowed'),
              type: 'boolean',
            },
            keywords: {
              description: expect.stringContaining('no handoff/smoke'),
            },
            regenerateKeywords: {
              description: expect.stringContaining('no handoff/smoke'),
              type: 'boolean',
            },
            relations: {
              items: {
                additionalProperties: true,
                properties: {
                  type: {enum: MEMORY_RELATION_TYPES, type: 'string'},
                  uri: {type: 'string'},
                },
                required: ['type', 'uri'],
                type: 'object',
              },
              maxItems: MAX_MEMORY_RELATIONS,
              type: 'array',
            },
          },
        });

        const validationError = await callErrorText(client, 'recall_context', {
          nodeLimit: 0,
          query: 'threadnote',
        });
        expect(validationError).toContain('greater than or equal to 1');
        const missingQueryAndMemoryRefs = await callErrorText(client, 'recall_context', {
          project: 'threadnote',
        });
        expect(missingQueryAndMemoryRefs).toContain(
          'needs either a non-empty "query" or at least one "memoryRefs" seed',
        );
        const missingMemoryRefs = await callErrorText(client, 'recall_context', {
          query: 'threadnote',
          relationTypes: ['depends_on'],
        });
        expect(missingMemoryRefs).toContain('relationTypes requires memoryRefs');
        const tooManyMemoryRefs = await callErrorText(client, 'recall_context', {
          memoryRefs: Array.from({length: 9}, (_, index) => `threadnote://memory/tn_${index}`),
          query: 'threadnote',
        });
        expect(tooManyMemoryRefs).toContain('at most 8');
        const tooManyCodeRefs = await callErrorText(client, 'remember_context', {
          callerCwd: fixture.root,
          codeRefs: Array.from({length: MAX_MEMORY_CODE_CITATIONS + 1}, (_, index) => `src/${index}.ts`),
          text: 'This memory must not be stored.',
        });
        expect(tooManyCodeRefs).toContain(`at most ${MAX_MEMORY_CODE_CITATIONS}`);
        const tooManyRelations = await callErrorText(client, 'remember_context', {
          relations: Array.from({length: MAX_MEMORY_RELATIONS + 1}, (_, index) => ({
            type: 'related_to',
            uri: `threadnote://memory/tn_${index}`,
          })),
          text: 'This memory must not be stored.',
        });
        expect(tooManyRelations).toContain(`at most ${MAX_MEMORY_RELATIONS}`);
        const inactiveDeferred = await callErrorText(client, 'remember_context', {
          callerCwd: fixture.root,
          citationPolicy: 'defer',
          codeRefs: ['apps/threadnote/src/types.ts'],
          status: 'archived',
          text: 'Inactive memories cannot own pending anchors.',
        });
        expect(inactiveDeferred).toContain('citationPolicy=defer requires status=active');
        const handoffKeywords = await callErrorText(client, 'remember_context', {
          keywords: ['invalid handoff keyword'],
          kind: 'handoff',
          text: 'Handoff keyword schema guidance regression.',
        });
        expect(handoffKeywords).toContain('Keyword authoring is not supported for handoff memories');

        const unanchoredHandoff = await client.callTool(
          {
            arguments: {
              kind: 'handoff',
              project: 'threadnote',
              text: 'task: Continue implementation.\nnext_step: Inspect the changed source.',
              topic: 'unanchored-resume',
            },
            name: 'remember_context',
          },
          undefined,
          {timeout: 5000},
        );
        expect((unanchoredHandoff.content as TextContent[]).map(item => item.text).join('\n')).toContain(
          'No codeRefs: compact exact-current resume is unavailable for this handoff.',
        );
        expect(unanchoredHandoff.structuredContent).toMatchObject({
          exactCurrentResume: {eligible: false, reason: 'missing-code-refs'},
        });

        const pendingHandoff = await client.callTool(
          {
            arguments: {
              callerCwd: process.cwd(),
              citationPolicy: 'defer',
              codeRefs: ['apps/threadnote/src/mcp/server/store.ts'],
              kind: 'handoff',
              project: 'threadnote',
              text: 'task: Continue implementation.\nnext_step: Verify the cited store behavior.',
              topic: 'anchored-resume',
            },
            name: 'remember_context',
          },
          undefined,
          {timeout: 5000},
        );
        expect((pendingHandoff.content as TextContent[]).map(item => item.text).join('\n')).toContain(
          'CodeRefs pending: compact exact-current resume remains unavailable until citations finalize.',
        );
        expect(pendingHandoff.structuredContent).toMatchObject({
          exactCurrentResume: {eligible: false, reason: 'pending-code-refs'},
        });
      },
      {toolset: 'core'},
    );
  });

  it('returns a budgeted unread queue and gates full ranking explanations behind explain', async () => {
    await withMcpClient(
      async (client, fixture) => {
        await writeCanonicalMemory(
          fixture.home,
          'structured-recall.md',
          canonicalMemoryContent('structured-recall', 'Structured recall ranking anchor qz-structured-7788.'),
        );
        const defaultResult = await client.callTool(
          {
            arguments: {project: 'threadnote', query: 'qz-structured-7788', threshold: 0},
            name: 'recall_context',
          },
          undefined,
          {timeout: 5000},
        );
        expect(defaultResult.structuredContent).toBeUndefined();
        const defaultText = (defaultResult.content as TextContent[])[0]?.text ?? '';
        expect(defaultText).toMatch(/^TN-RECALL\/1\n/);
        expect(defaultText).toContain('URI: memories/durable/projects/threadnote/structured-recall.md');
        expect(defaultText).not.toContain('threadnote://user/test-user/');
        const compactRead = await client.callTool(
          {arguments: {uri: 'memories/durable/projects/threadnote/structured-recall.md'}, name: 'read_context'},
          undefined,
          {timeout: 5_000},
        );
        expect(compactRead.isError, JSON.stringify(compactRead)).not.toBe(true);
        expect((compactRead.content as TextContent[])[0]?.text ?? '').toContain('qz-structured-7788');

        const result = await client.callTool(
          {
            arguments: {
              project: 'threadnote',
              query: 'qz-structured-7788',
              responseFormat: 'dual',
              threshold: 0,
            },
            name: 'recall_context',
          },
          undefined,
          {timeout: 5000},
        );

        expect(result.structuredContent).toMatchObject({
          confidence: {
            level: expect.stringMatching(/^(?:high|medium|low|no_answer)$/),
          },
          nextAction: {tool: 'read_context', uris: expect.any(Array)},
          output: {budgetTokens: 1_500, explain: false, returnedResults: expect.any(Number)},
          rankerVersion: 'hybrid-v8',
          results: expect.any(Array),
        });
        const compact = result.structuredContent as {
          readonly nextAction: {readonly uris: readonly string[]};
          readonly results: readonly Record<string, unknown>[];
        };
        expect(compact.results.length).toBeGreaterThan(0);
        expect(compact.results[0]).toMatchObject({
          readState: 'unread',
          reason: expect.any(String),
          uri: 'memories/durable/projects/threadnote/structured-recall.md',
        });
        expect(compact.results[0]).not.toHaveProperty('reasons');
        expect(compact.results[0]).not.toHaveProperty('signals');
        expect(compact.nextAction.uris[0]).toBe(compact.results[0]?.uri);
        const compactText = (result.content as TextContent[]).map(item => item.text).join('\n');
        expect(compactText).toContain('read_context for memories/durable/projects/threadnote/structured-recall.md');
        expect(compactText).not.toContain('threadnote://user/test-user/');
        expect(
          Buffer.byteLength(JSON.stringify(result.structuredContent)) + Buffer.byteLength(compactText),
        ).toBeLessThanOrEqual(1_500 * 3);
        expect(result.structuredContent).not.toHaveProperty('codeGraph');

        const explained = await client.callTool(
          {
            arguments: {
              explain: true,
              project: 'threadnote',
              query: 'qz-structured-7788',
              responseFormat: 'dual',
              threshold: 0,
            },
            name: 'recall_context',
          },
          undefined,
          {timeout: 5000},
        );
        const explainedResults = (explained.structuredContent as {readonly results: readonly Record<string, unknown>[]})
          .results;
        expect(explainedResults[0]).toMatchObject({reasons: expect.any(Array), signals: expect.any(Object)});

        const tooSmall = await callErrorText(client, 'recall_context', {
          budgetTokens: 699,
          project: 'threadnote',
          query: 'qz-structured-7788',
          threshold: 0,
        });
        expect(tooSmall).toContain('greater than or equal to 700');
      },
      {toolset: 'core'},
    );
  });

  it('supports pure seed-only navigation with coherent confidence and next action', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const memory = (topic: string, memoryId: string, body: string, relation?: string) =>
          [
            'MEMORY',
            'kind: durable',
            'status: active',
            'project: threadnote',
            `topic: ${topic}`,
            'source_agent_client: integration-test',
            'timestamp: 2026-08-31T00:00:00.000Z',
            `memory_id: ${memoryId}`,
            ...(relation ? [`relation: ${relation}`] : []),
            '',
            body,
          ].join('\n');
        await writeCanonicalMemory(
          fixture.home,
          'mcp-connection-seed.md',
          memory(
            'mcp-connection-seed',
            'tn_mcp_connection_seed',
            'Seed body is lexically unrelated.',
            'depends_on threadnote://memory/tn_mcp_connection_target',
          ),
        );
        await writeCanonicalMemory(
          fixture.home,
          'mcp-connection-target.md',
          memory('mcp-connection-target', 'tn_mcp_connection_target', 'Direct neighbor is also lexically unrelated.'),
        );

        const result = await client.callTool(
          {
            arguments: {
              memoryRefs: ['threadnote://memory/tn_mcp_connection_seed'],
              project: 'threadnote',
              relationTypes: ['depends_on'],
              responseFormat: 'dual',
            },
            name: 'recall_context',
          },
          undefined,
          {timeout: 5_000},
        );

        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        const structured = result.structuredContent as {
          readonly confidence?: {readonly basis?: string; readonly level?: string; readonly reason?: string};
          readonly memoryConnections?: {
            readonly connections: readonly Record<string, unknown>[];
            readonly coverage: Record<string, unknown>;
            readonly premises: readonly Record<string, unknown>[];
          };
          readonly nextAction?: {readonly tool?: string; readonly uris?: readonly string[]};
          readonly results?: readonly {readonly uri?: string}[];
        };
        expect(structured.memoryConnections?.premises).toEqual([
          expect.objectContaining({memoryId: 'tn_mcp_connection_seed', state: 'current'}),
        ]);
        expect(structured.memoryConnections?.connections).toEqual([
          expect.objectContaining({
            currentness: 'current',
            direction: 'outgoing',
            neighborMemoryId: 'tn_mcp_connection_target',
            relationType: 'depends_on',
            resolution: 'resolved',
          }),
        ]);
        expect(structured.results).toEqual([
          expect.objectContaining({uri: expect.stringContaining('mcp-connection-target.md')}),
        ]);
        expect(structured.confidence).toMatchObject({
          basis: 'explicit-memory-connection',
          level: 'high',
          reason: expect.stringContaining('navigation only, not entailment'),
        });
        expect(structured.nextAction).toEqual({
          tool: 'read_context',
          uris: [structured.results?.[0]?.uri],
        });
        expect(structured.memoryConnections).not.toHaveProperty('diagnostics');
        expect((result.content as TextContent[]).map(item => item.text).join('\n')).toContain(
          'Relations are navigation evidence, not entailment.',
        );
      },
      {toolset: 'core'},
    );
  });

  it('returns a typed identity-conflict warning in the default compact recall result', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const memory = (topic: string, body: string) =>
          [
            'MEMORY',
            'kind: durable',
            'status: active',
            'project: threadnote',
            `topic: ${topic}`,
            'source_agent_client: integration-test',
            'timestamp: 2026-08-01T00:00:00.000Z',
            'memory_id: tn_mcp_identity_conflict',
            '',
            body,
          ].join('\n');
        await writeCanonicalMemory(
          fixture.home,
          'identity-conflict-target.md',
          memory('identity-conflict-target', 'Identity conflict anchor qz-identity-7788.'),
        );
        const sharedPath = join(
          fixture.home,
          'data',
          'local',
          'user',
          'test-user',
          'memories',
          'shared',
          'platform',
          'durable',
          'projects',
          'threadnote',
          'identity-conflict-alias.md',
        );
        await mkdir(join(sharedPath, '..'), {recursive: true});
        await writeFile(sharedPath, memory('identity-conflict-alias', 'A divergent body.'), 'utf8');

        const result = await client.callTool(
          {
            arguments: {
              project: 'threadnote',
              query: 'qz-identity-7788',
              responseFormat: 'dual',
              threshold: 0,
            },
            name: 'recall_context',
          },
          undefined,
          {timeout: 5_000},
        );

        expect(result.isError).not.toBe(true);
        const structured = result.structuredContent as {
          readonly output?: {readonly explain?: boolean};
          readonly results?: readonly {
            readonly rankWarnings?: unknown;
            readonly warnings?: readonly {readonly code?: unknown; readonly message?: unknown}[];
          }[];
        };
        expect(structured.output?.explain).toBe(false);
        expect(structured.results?.[0]?.warnings).toEqual([
          expect.objectContaining({
            code: 'memory_identity_conflict',
            message: expect.stringContaining('divergent bodies'),
          }),
        ]);
        expect(structured.results?.[0]).not.toHaveProperty('rankWarnings');
      },
      {toolset: 'core'},
    );
  });

  it('honors THREADNOTE_RECALL_THRESHOLD as the topical relevanceScore floor', async () => {
    await withMcpClient(
      async (client, fixture) => {
        await writeCanonicalMemory(
          fixture.home,
          'environment-threshold.md',
          canonicalMemoryContent('environment-threshold', 'Environment threshold anchor qz-environment-8811.'),
        );

        const configured = await client.callTool(
          {
            arguments: {project: 'threadnote', query: 'qz-environment-8811', responseFormat: 'dual'},
            name: 'recall_context',
          },
          undefined,
          {timeout: 5_000},
        );
        expect((configured.structuredContent as {readonly results?: readonly unknown[]} | undefined)?.results).toEqual(
          [],
        );

        const broadened = await client.callTool(
          {
            arguments: {
              project: 'threadnote',
              query: 'qz-environment-8811',
              responseFormat: 'dual',
              threshold: 0,
            },
            name: 'recall_context',
          },
          undefined,
          {timeout: 5_000},
        );
        expect(
          (broadened.structuredContent as {readonly results?: readonly unknown[]} | undefined)?.results?.length,
        ).toBeGreaterThan(0);
      },
      {environment: {THREADNOTE_RECALL_THRESHOLD: '1'}, toolset: 'core'},
    );
  });

  it('keeps progress opt-in and leaves unrelated tool handlers unchanged', async () => {
    await withMcpClient(
      async client => {
        const progressUpdates: ThreadnoteProgress[] = [];
        const result = await client.callTool({arguments: {}, name: 'list_context'}, undefined, {
          onprogress: update => progressUpdates.push(update),
          resetTimeoutOnProgress: true,
          timeout: 5000,
        });

        expect(result.isError).not.toBe(true);
        expect(progressUpdates).toEqual([]);
      },
      {toolset: 'core'},
    );
  });

  it('records one-time recall pre-sync and read-only retrieval phases without private inputs', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const privateQuery = 'private-phase-timing-query-7788';
        const progressUpdates: ThreadnoteProgress[] = [];
        await writeFile(
          join(fixture.home, 'layout.json'),
          `${JSON.stringify({createdBy: 'threadnote', version: 2})}\n`,
          'utf8',
        );
        await writeCanonicalMemory(
          fixture.home,
          'phase-timing.md',
          canonicalMemoryContent('phase-timing', `Lexical anchor ${privateQuery}.`),
        );

        const result = await client.callTool(
          {arguments: {project: 'threadnote', query: privateQuery}, name: 'recall_context'},
          undefined,
          {
            onprogress: update => progressUpdates.push(update),
            resetTimeoutOnProgress: true,
            timeout: 5000,
          },
        );
        expect(result.isError).not.toBe(true);

        expectOrderedRecallProgress(progressUpdates);
        expect(JSON.stringify(progressUpdates)).not.toContain(privateQuery);

        const productionLog = await readFile(join(fixture.home, 'logs', 'threadnote.log'), 'utf8');
        const entries = productionLog
          .trim()
          .split('\n')
          .map(line => JSON.parse(line) as Record<string, unknown>);
        const finished = entries
          .filter(entry => entry.event === 'invocation.finished' && entry.operation === 'recall_context')
          .at(-1);
        const phaseTimings = finished?.phaseTimings as
          readonly {readonly outcome: string; readonly phase: string}[] | undefined;

        expect(phaseTimings?.filter(timing => timing.phase === 'recall.shared-sync')).toHaveLength(1);
        expect(phaseTimings?.filter(timing => timing.phase === 'recall.obsidian-sync')).toHaveLength(1);
        expect(phaseTimings?.filter(timing => timing.phase === 'recall.workspace-context')).toHaveLength(1);
        expect(phaseTimings?.filter(timing => timing.phase === 'recall.semantic-retrieval')).toHaveLength(1);
        expect(phaseTimings?.filter(timing => timing.phase === 'recall.lexical-ranking').length).toBeGreaterThanOrEqual(
          1,
        );
        expect(phaseTimings?.find(timing => timing.phase === 'recall.semantic-retrieval')?.outcome).toBe('unavailable');
        expect(productionLog).not.toContain(privateQuery);
      },
      {toolset: 'core'},
    );
  });

  it('returns a typed degraded warning when exact and ranked lexical recovery both fail', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const lexicalRoot = join(fixture.home, 'indexes', 'lexical');
        await mkdir(lexicalRoot, {recursive: true});
        await writeFile(join(lexicalRoot, recallIndexDatabaseFilename(false)), 'not a sqlite database', 'utf8');
        await writeFile(join(lexicalRoot, 'generations'), 'blocks index recovery', 'utf8');

        const result = await client.callTool(
          {
            arguments: {
              project: 'threadnote',
              query: 'degraded lexical exact anchor 7788',
              responseFormat: 'dual',
            },
            name: 'recall_context',
          },
          undefined,
          {timeout: 10_000},
        );
        expect(result.isError).not.toBe(true);
        const structured = result.structuredContent as {
          readonly results?: readonly unknown[];
          readonly warnings?: readonly {
            readonly code?: unknown;
            readonly message?: unknown;
            readonly remediation?: unknown;
          }[];
        };
        expect(structured.results).toEqual([]);
        expect(structured.warnings).toEqual([
          expect.objectContaining({
            code: 'lexical_index_unavailable',
            message: expect.stringContaining('could not be read or recovered'),
            remediation: expect.stringContaining('threadnote doctor --dry-run'),
          }),
        ]);
        const text = (result.content as TextContent[]).map(item => item.text).join('\n');
        expect(text).toContain('Recall index warning:');
        expect(text).toContain('Recall returned 0/0 unread pointer(s)');

        const hookQueue = renderSessionStartRecallQueue('threadnote', text);
        expect(hookQueue).toContain('recall ran in degraded mode');
        expect(hookQueue).toContain('Do not treat this empty queue as proof that no memory exists.');
        expect(hookQueue).not.toContain('there is no recalled memory to treat as context');
      },
      {toolset: 'core'},
    );
  });

  it('keeps eight concurrent recall progress streams request-local under load', async () => {
    await withMcpClient(
      async client => {
        const calls = await Promise.all(
          Array.from({length: 8}, async (_, index) => {
            const privateQuery = `private-concurrent-progress-${index}-7788`;
            const progressUpdates: ThreadnoteProgress[] = [];
            const result = await client.callTool(
              {arguments: {project: 'threadnote', query: privateQuery}, name: 'recall_context'},
              undefined,
              {
                onprogress: update => progressUpdates.push(update),
                resetTimeoutOnProgress: true,
                timeout: 10_000,
              },
            );
            return {privateQuery, progressUpdates, result};
          }),
        );

        for (const {privateQuery, progressUpdates, result} of calls) {
          expect(result.isError).not.toBe(true);
          expectRequestLocalRecallProgress(progressUpdates);
          expect(JSON.stringify(progressUpdates)).not.toContain(privateQuery);
        }
      },
      {toolset: 'core'},
    );
  });

  it('repeats real stdio heartbeats until response or cancellation without reordering phases', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const privateQuery = 'private-short-heartbeat-query-7788';
        await Promise.all(
          Array.from({length: 128}, (_, index) =>
            writeCanonicalMemory(
              fixture.home,
              `short-heartbeat-${index.toString().padStart(3, '0')}.md`,
              canonicalMemoryContent(
                `short-heartbeat-${index}`,
                `${privateQuery} bounded lexical corpus entry ${index}.`,
              ),
            ),
          ),
        );

        const protocolErrors: Error[] = [];
        const originalOnError = client.onerror;
        client.onerror = error => protocolErrors.push(error);
        try {
          const completedUpdates: ThreadnoteProgress[] = [];
          const completed = await client.callTool(
            {arguments: {project: 'threadnote', query: privateQuery}, name: 'recall_context'},
            undefined,
            {
              maxTotalTimeout: 10_000,
              onprogress: update => completedUpdates.push(update),
              resetTimeoutOnProgress: true,
              timeout: 5_000,
            },
          );
          expect(completed.isError).not.toBe(true);
          const completedPhases = expectOrderedRecallProgress(completedUpdates);
          expect(completedPhases.some((phase, index) => index > 0 && phase === completedPhases[index - 1])).toBe(true);
          expect(JSON.stringify(completedUpdates)).not.toContain(privateQuery);
          await new Promise(resolve => setTimeout(resolve, 150));
          expect(protocolErrors).toEqual([]);

          const controller = new AbortController();
          const cancelledUpdates: ThreadnoteProgress[] = [];
          const cancelled = client.callTool(
            {arguments: {project: 'threadnote', query: privateQuery}, name: 'recall_context'},
            undefined,
            {
              maxTotalTimeout: 10_000,
              onprogress: update => {
                cancelledUpdates.push(update);
                if (!controller.signal.aborted) controller.abort();
              },
              resetTimeoutOnProgress: true,
              signal: controller.signal,
              timeout: 5_000,
            },
          );

          await expect(cancelled).rejects.toMatchObject({
            code: -32_001,
            message: expect.stringContaining('AbortError'),
          });
          expect(controller.signal.aborted).toBe(true);
          expect(recallProgressPhases(cancelledUpdates)).toEqual(['recall.shared-sync']);
          await new Promise(resolve => setTimeout(resolve, 400));
          expect(protocolErrors).toEqual([]);

          const followUp = await client.callTool({arguments: {}, name: 'list_context'}, undefined, {timeout: 5_000});
          expect(followUp.isError).not.toBe(true);
        } finally {
          client.onerror = originalOnError;
        }
      },
      {
        environment: {
          NODE_ENV: 'test',
          THREADNOTE_TEST_MCP_PROGRESS_HEARTBEAT_MILLISECONDS: '100',
          THREADNOTE_TEST_MCP_PROGRESS_SHARED_SYNC_DELAY_MILLISECONDS: '300',
        },
        toolset: 'core',
      },
    );
  });

  it('returns exact Unicode content in one complete read_context result', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const uri = 'threadnote://user/test-user/memories/durable/projects/threadnote/bounded-read.md';
        const content = canonicalMemoryContent('bounded-read', `${'Unicode evidence 🙂漢字\n'.repeat(1_000)}terminal`);
        await writeCanonicalMemory(fixture.home, 'bounded-read.md', content);

        const result = await client.callTool(
          {arguments: {responseFormat: 'dual', uri}, name: 'read_context'},
          undefined,
          {timeout: 30_000},
        );
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        const output = Array.isArray(result.content) ? result.content : [];
        const structured = result.structuredContent as ReadStructuredContent;
        expect((output[0] as TextContent | undefined)?.text).toBe(content);
        expect(structured).toMatchObject({
          complete: true,
          content,
          type: 'threadnote-read',
        });
        expect(structured).not.toHaveProperty('cursor');
        expect(structured).not.toHaveProperty('budgetTokens');
        expect(result._meta).not.toHaveProperty('threadnote.io/canonical-read');
      },
      {toolset: 'core'},
    );
  }, 40_000);

  it('returns complete body and compact metadata once in the default read_context agent format', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const uri = 'threadnote://user/test-user/memories/durable/projects/threadnote/text-read.md';
        const body = `${'Evidence 🙂漢字\n'.repeat(500)}terminal`;
        const citation = createMemoryCodeCitation({
          extractorSet: 'mcp-read-agent-projection',
          fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
          path: 'packages/memory/src/read/projection.ts',
          repositoryId: 'b'.repeat(64),
          repositoryIdentityKind: 'remote',
          sourceCommit: 'c'.repeat(40),
          sourceDirty: false,
          sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
          target: {kind: 'file'},
          version: 1,
        });
        const content = formatMemoryDocument(
          'MEMORY',
          {
            codeCitations: [citation],
            kind: 'durable',
            project: 'threadnote',
            schemaVersion: MEMORY_SCHEMA_VERSION,
            sourceAgentClient: 'integration-test',
            status: 'active',
            timestamp: '2026-08-01T00:00:00.000Z',
            topic: 'text-read',
          },
          body,
        );
        await writeCanonicalMemory(fixture.home, 'text-read.md', content);

        const result = await client.callTool(
          {arguments: {uri: 'memories/durable/projects/threadnote/text-read.md'}, name: 'read_context'},
          undefined,
          {timeout: 30_000},
        );
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        const output = Array.isArray(result.content) ? result.content : [];
        const structured = result.structuredContent as Record<string, unknown>;
        const text = (output[0] as TextContent | undefined)?.text ?? '';
        expect(text).toContain('TN-MEMORY/1');
        expect(text).toContain('Memory: kind=durable; status=active; project=threadnote; topic=text-read');
        expect(text).toContain(body);
        expect(text).toContain(
          `Code evidence [remote:${citation.repositoryId.slice(0, 12)} @ ${citation.sourceCommit}]: packages/memory/src/read/projection.ts`,
        );
        expect(text).not.toContain('source_agent_client:');
        expect(structured).toMatchObject({
          complete: true,
          contentBytes: Buffer.byteLength(content),
          contentChannel: 'agent',
          type: 'threadnote-read',
          version: 2,
        });
        expect(structured).not.toHaveProperty('uri');
        expect(structured).not.toHaveProperty('content');

        const canonical = await client.callTool(
          {arguments: {responseFormat: 'text', uri}, name: 'read_context'},
          undefined,
          {timeout: 30_000},
        );
        const canonicalOutput = Array.isArray(canonical.content) ? canonical.content : [];
        expect((canonicalOutput[0] as TextContent | undefined)?.text).toBe(content);

        for (const invalidUri of ['projects/threadnote/text-read.md', 'memories/../durable/text-read.md']) {
          const invalid = await client.callTool({arguments: {uri: invalidUri}, name: 'read_context'}, undefined, {
            timeout: 5_000,
          });
          expect(invalid.isError).toBe(true);
        }
      },
      {toolset: 'core'},
    );
  }, 40_000);

  it('returns complete text for a formerly paged memory even when image projection is enabled', async () => {
    await withMcpClient(
      async (client, fixture) => {
        await mkdir(join(fixture.home, 'image-projection'), {recursive: true});
        await writeFile(
          join(fixture.home, 'image-projection', 'config.json'),
          `${JSON.stringify({enabled: true, version: 1})}\n`,
        );
        const uri = 'threadnote://user/test-user/memories/durable/projects/threadnote/imaged-read.md';
        const content = canonicalMemoryContent(
          'imaged-read',
          `${'ASCII evidence line for image projection.\n'.repeat(400)}terminal tn_imagedread`,
        );
        await writeCanonicalMemory(fixture.home, 'imaged-read.md', content);

        const result = await client.callTool(
          {arguments: {responseFormat: 'dual', uri}, name: 'read_context'},
          undefined,
          {
            timeout: 30_000,
          },
        );
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        const output = Array.isArray(result.content) ? result.content : [];
        const structured = result.structuredContent as ReadStructuredContent;
        expect(structured.type).toBe('threadnote-read');
        expect(structured.complete).toBe(true);
        expect(structured.content).toBe(content);
        expect((output[0] as TextContent | undefined)?.text).toBe(content);
        expect(output.some(item => item.type === 'image')).toBe(false);
      },
      {toolset: 'core'},
    );
  }, 40_000);

  it('refuses an over-cap memory with an outline instead of a truncated first page', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const uri = 'threadnote://user/test-user/memories/durable/projects/threadnote/huge-read.md';
        const sentinel = 'HUGE_READ_PRIVATE_SENTINEL';
        const content = canonicalMemoryContent('huge-read', `# Ledger\n## Open\n${sentinel}\n${'x'.repeat(70_000)}`);
        await writeCanonicalMemory(fixture.home, 'huge-read.md', content);

        const result = await client.callTool({arguments: {uri}, name: 'read_context'}, undefined, {timeout: 30_000});
        expect(result.isError).toBe(true);
        const output = Array.isArray(result.content) ? result.content : [];
        const text = (output[0] as TextContent | undefined)?.text ?? '';
        expect(text).toContain(`${MCP_RESOURCE_READ_MAX_BYTES} bytes`);
        expect(text).toContain('mode=outline');
        expect(text).toContain('## Open');
        expect(text).not.toContain(sentinel);
        expect(text).not.toContain('x'.repeat(80));
      },
      {toolset: 'core'},
    );
  }, 40_000);

  it('explicitly pages a 110 KB heading-less memory without losing Unicode or hiding incompleteness', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const uri = 'threadnote://user/test-user/memories/durable/projects/threadnote/headingless-read.md';
        const content = canonicalMemoryContent('headingless-read', '🙂'.repeat(28_000));
        await writeCanonicalMemory(fixture.home, 'headingless-read.md', content);
        const refusal = await client.callTool({arguments: {uri}, name: 'read_context'});
        expect(refusal.isError).toBe(true);
        const refusalContent = Array.isArray(refusal.content) ? refusal.content : [];
        expect((refusalContent[0] as TextContent).text).toContain('offsetBytes=0');

        let offsetBytes = 0;
        let sourceHash: string | undefined;
        const parts: string[] = [];
        for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
          const result = await client.callTool({
            arguments: {offsetBytes, responseFormat: 'dual', sourceHash, uri},
            name: 'read_context',
          });
          expect(result.isError, JSON.stringify(result)).not.toBe(true);
          const page = result.structuredContent as ReadStructuredContent;
          const resultContent = Array.isArray(result.content) ? result.content : [];
          expect(page.contentBytes).toBeLessThanOrEqual(MEMORY_READ_PAGE_BYTES);
          expect((resultContent[0] as TextContent).text).toBe(page.content);
          expect(page.offsetBytes).toBe(offsetBytes);
          expect(page.totalBytes).toBe(Buffer.byteLength(content, 'utf8'));
          if (!page.complete) expect((resultContent[1] as TextContent).text).toContain('Incomplete memory page');
          parts.push(page.content);
          sourceHash = page.sourceHash;
          if (page.complete) {
            expect(page.nextOffsetBytes).toBeUndefined();
            break;
          }
          expect(page.nextOffsetBytes).toBeGreaterThan(offsetBytes);
          offsetBytes = page.nextOffsetBytes!;
        }
        expect(parts.join('')).toBe(content);
      },
      {toolset: 'core'},
    );
  }, 40_000);

  it('resolves a relocated memory with requested and canonical URIs in both MCP result channels', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const requestedUri = 'threadnote://user/test-user/memories/durable/projects/threadnote/relocated-request.md';
        const canonicalUri = 'threadnote://user/test-user/memories/durable/projects/threadnote/relocated-canonical.md';
        const memoryId = 'tn_mcp_relocated';
        const content = canonicalMemoryContent('relocated-canonical', 'Canonical relocated evidence.').replace(
          'source_agent_client:',
          `memory_id: ${memoryId}\nsource_agent_client:`,
        );
        await writeCanonicalMemory(fixture.home, 'relocated-canonical.md', content);
        const receiptRoot = join(
          fixture.home,
          'data',
          'local',
          'user',
          'test-user',
          'private',
          'memory-relocations',
          'v1',
        );
        await mkdir(receiptRoot, {recursive: true, mode: 0o700});
        const receiptPath = join(receiptRoot, `${createHash('sha256').update(requestedUri).digest('hex')}.json`);
        await writeFile(
          receiptPath,
          `${JSON.stringify(
            {
              fromUri: requestedUri,
              memoryId,
              toUri: canonicalUri,
              type: 'threadnote-memory-relocation',
              version: 1,
              visibility: 'private-local',
            },
            undefined,
            2,
          )}\n`,
          {mode: 0o600},
        );

        const result = await client.callTool(
          {arguments: {responseFormat: 'dual', uri: requestedUri}, name: 'read_context'},
          undefined,
          {timeout: 30_000},
        );
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        const output = Array.isArray(result.content) ? result.content : [];
        const structured = result.structuredContent as ReadStructuredContent;
        expect((output[0] as TextContent | undefined)?.text).toBe(content);
        expect((output[1] as TextContent | undefined)?.text).toContain(`requested ${requestedUri}`);
        expect((output[1] as TextContent | undefined)?.text).toContain(`canonical ${canonicalUri}`);
        expect(structured).toMatchObject({
          canonicalUri,
          complete: true,
          content,
          requestedUri,
          type: 'threadnote-read',
        });
        expect(result._meta).not.toHaveProperty('threadnote.io/canonical-read');
        await expect(client.readResource({uri: requestedUri})).resolves.toEqual({
          contents: [{mimeType: 'text/plain; charset=utf-8', text: content, uri: canonicalUri}],
        });
        const recalled = await client.callTool(
          {arguments: {project: 'threadnote', query: 'Canonical relocated evidence'}, name: 'recall_context'},
          undefined,
          {timeout: 30_000},
        );
        expect(recalled.isError, JSON.stringify(recalled)).not.toBe(true);
        const identityAlias = `threadnote://memory/${memoryId}`;
        const aliasRead = await client.callTool(
          {arguments: {responseFormat: 'dual', uri: identityAlias}, name: 'read_context'},
          undefined,
          {timeout: 30_000},
        );
        expect(aliasRead.isError, JSON.stringify(aliasRead)).not.toBe(true);
        expect(aliasRead.structuredContent).toMatchObject({content, requestedUri: identityAlias});
        expect(aliasRead.structuredContent).not.toHaveProperty('canonicalUri');
        await expect(client.readResource({uri: identityAlias})).resolves.toEqual({
          contents: [{mimeType: 'text/plain; charset=utf-8', text: content, uri: identityAlias}],
        });
      },
      {toolset: 'core'},
    );
  });

  it('reads stable identity aliases through tools and resources without leaking a canonical URI', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const memoryId = 'tn_mcp_identity_alias';
        const alias = `threadnote://memory/${memoryId}`;
        const canonicalUri = 'threadnote://user/test-user/memories/durable/projects/threadnote/identity-alias.md';
        const content = canonicalMemoryContent('identity-alias', 'Identity alias anchor qz-alias-4411.').replace(
          'source_agent_client:',
          `memory_id: ${memoryId}\nsource_agent_client:`,
        );
        await writeCanonicalMemory(fixture.home, 'identity-alias.md', content);
        const recalled = await client.callTool(
          {arguments: {project: 'threadnote', query: 'qz-alias-4411'}, name: 'recall_context'},
          undefined,
          {timeout: 30_000},
        );
        expect(recalled.isError, JSON.stringify(recalled)).not.toBe(true);

        const result = await client.callTool(
          {arguments: {responseFormat: 'dual', uri: alias}, name: 'read_context'},
          undefined,
          {timeout: 30_000},
        );
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        const output = Array.isArray(result.content) ? result.content : [];
        const structured = result.structuredContent as ReadStructuredContent;
        expect((output[0] as TextContent | undefined)?.text).toBe(structured.content);
        expect(structured.requestedUri).toBe(alias);
        expect(structured.canonicalUri).toBeUndefined();
        expect(JSON.stringify(result)).not.toContain(canonicalUri);

        const replacement = await client.callTool(
          {
            arguments: {
              kind: 'durable',
              project: 'threadnote',
              replaceUri: alias,
              sourceAgentClient: 'integration-test',
              status: 'active',
              text: 'Identity alias replacement evidence.',
              topic: 'identity-alias',
            },
            name: 'remember_context',
          },
          undefined,
          {timeout: 30_000},
        );
        expect(replacement.isError, JSON.stringify(replacement)).not.toBe(true);
        expect(replacement.structuredContent).toMatchObject({
          memoryUri: canonicalUri,
          replacementCleanupPending: false,
        });
        await expect(
          readFile(
            join(
              fixture.home,
              'data',
              'local',
              'user',
              'test-user',
              'memories',
              'durable',
              'projects',
              'threadnote',
              'identity-alias.md',
            ),
            'utf8',
          ),
        ).resolves.toContain('Identity alias replacement evidence.');

        await expect(client.readResource({uri: alias})).resolves.toEqual({
          contents: [
            expect.objectContaining({
              mimeType: 'text/plain; charset=utf-8',
              text: expect.stringContaining('Identity alias replacement evidence.'),
              uri: alias,
            }),
          ],
        });

        const missingAlias = 'threadnote://memory/tn_mcp_identity_missing';
        const missing = await client.callTool({arguments: {uri: missingAlias}, name: 'read_context'}, undefined, {
          timeout: 30_000,
        });
        expect(missing.isError).toBe(true);
        const missingOutput = Array.isArray(missing.content) ? missing.content : [];
        expect((missingOutput[0] as TextContent | undefined)?.text).toBe(JSON.stringify(missing.structuredContent));
        expect(missing.structuredContent).toMatchObject({
          alias: missingAlias,
          reason: 'not-found',
          type: 'threadnote-memory-identity-error',
          version: 1,
        });
        expect(JSON.stringify(missing)).not.toContain(canonicalUri);
        await expect(client.readResource({uri: missingAlias})).rejects.toThrow(/does not resolve/u);
      },
      {toolset: 'core'},
    );
  }, 40_000);

  it('gives content- and structured-first clients recovery for a legacy moved pointer without a receipt', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const requestedUri =
          'threadnote://user/test-user/memories/durable/projects/my-product/legacy-published-pointer.md';
        const canonicalUri =
          'threadnote://user/test-user/memories/shared/default/durable/projects/my-product/legacy-published-pointer.md';
        const content = canonicalMemoryContent(
          'Legacy Published Pointer',
          'Legacy published pointer recovery anchor qz-legacy-published-7788.',
        ).replace('project: threadnote', 'project: My Product');
        const sharedPath = join(
          fixture.home,
          'data',
          'local',
          'user',
          'test-user',
          'memories',
          'shared',
          'default',
          'durable',
          'projects',
          'my-product',
          'legacy-published-pointer.md',
        );
        await mkdir(join(sharedPath, '..'), {recursive: true});
        await writeFile(sharedPath, content, 'utf8');
        const result = await client.callTool({arguments: {uri: requestedUri}, name: 'read_context'}, undefined, {
          timeout: 30_000,
        });

        expect(result.isError).toBe(true);
        const output = Array.isArray(result.content) ? result.content : [];
        const recovery = {
          code: 'memory-resource-not-found',
          nextAction: {
            arguments: {query: 'legacy-published-pointer'},
            tool: 'recall_context',
          },
          recoveryAction: 'recall-canonical-uri',
          requestedUri,
          retryable: false,
          summary:
            'The memory may have moved or been published before relocation receipts were available. Recall by its stable topic, then read the canonical URI returned.',
          type: 'threadnote-memory-read-recovery',
          version: 1,
        };
        expect(JSON.parse((output[0] as TextContent | undefined)?.text ?? '')).toEqual(recovery);
        expect(result.structuredContent).toEqual(recovery);

        const recalled = await client.callTool(
          {arguments: {...recovery.nextAction.arguments, responseFormat: 'dual'}, name: recovery.nextAction.tool},
          undefined,
          {timeout: 5_000},
        );
        expect(recalled.isError).not.toBe(true);
        const recalledUris = (
          recalled.structuredContent as {readonly results?: readonly {readonly uri?: unknown}[]}
        ).results?.map(entry => entry.uri);
        expect(recalledUris).toContain(
          'memories/shared/default/durable/projects/my-product/legacy-published-pointer.md',
        );

        const canonical = await client.callTool(
          {arguments: {responseFormat: 'dual', uri: canonicalUri}, name: 'read_context'},
          undefined,
          {timeout: 5_000},
        );
        expect(canonical.isError).not.toBe(true);
        expect((canonical.structuredContent as ReadStructuredContent).content).toBe(content);
      },
      {toolset: 'core'},
    );
  });

  it('keeps the old URI readable after remember_context relocates a personal memory', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const requestedUri = 'threadnote://user/test-user/memories/durable/projects/threadnote/mcp-replace-old.md';
        const canonicalUri = 'threadnote://user/test-user/memories/durable/projects/threadnote/mcp-replace-new.md';
        const original = canonicalMemoryContent('mcp-replace-old', 'Original replacement body.').replace(
          'source_agent_client:',
          'memory_id: tn_mcp_replace\nsource_agent_client:',
        );
        await writeCanonicalMemory(fixture.home, 'mcp-replace-old.md', original);

        const replaced = await client.callTool(
          {
            arguments: {
              kind: 'durable',
              project: 'threadnote',
              replaceUri: requestedUri,
              sourceAgentClient: 'integration-test',
              status: 'active',
              text: 'Replacement evidence.',
              topic: 'mcp-replace-new',
            },
            name: 'remember_context',
          },
          undefined,
          {timeout: 30_000},
        );
        expect(replaced.isError, JSON.stringify(replaced)).not.toBe(true);
        expect(replaced.structuredContent).toMatchObject({memoryUri: canonicalUri, replacementCleanupPending: false});

        const read = await client.callTool(
          {arguments: {responseFormat: 'dual', uri: requestedUri}, name: 'read_context'},
          undefined,
          {timeout: 30_000},
        );
        expect(read.isError, JSON.stringify(read)).not.toBe(true);
        const output = Array.isArray(read.content) ? read.content : [];
        const structured = read.structuredContent as ReadStructuredContent;
        expect((output[0] as TextContent | undefined)?.text).toContain('Replacement evidence.');
        expect((output[1] as TextContent | undefined)?.text).toContain(`canonical ${canonicalUri}`);
        expect(structured).toMatchObject({canonicalUri, requestedUri});
      },
      {toolset: 'core'},
    );
  });

  it('normalizes remember_context relations to stable identities and rejects duplicate or self links', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const targetUri = 'threadnote://user/test-user/memories/durable/projects/threadnote/relation-target.md';
        const target = canonicalMemoryContent('relation-target', 'Relation target evidence.').replace(
          'source_agent_client:',
          'memory_id: tn_relation_target\nsource_agent_client:',
        );
        await writeCanonicalMemory(fixture.home, 'relation-target.md', target);

        const stored = await client.callTool(
          {
            arguments: {
              project: 'threadnote',
              relations: [{type: 'depends_on', uri: targetUri}],
              text: 'Relation source evidence.',
              topic: 'relation-source',
            },
            name: 'remember_context',
          },
          undefined,
          {timeout: 30_000},
        );
        expect(stored.isError, JSON.stringify(stored)).not.toBe(true);
        const storedUri = (stored.structuredContent as {readonly memoryUri?: string}).memoryUri;
        expect(storedUri).toBe('threadnote://user/test-user/memories/durable/projects/threadnote/relation-source.md');

        const read = await client.callTool(
          {arguments: {responseFormat: 'text', uri: storedUri}, name: 'read_context'},
          undefined,
          {timeout: 30_000},
        );
        const readContent = Array.isArray(read.content) ? read.content : [];
        expect((readContent[0] as TextContent | undefined)?.text).toContain(
          `relation: depends_on ${memoryIdentityAlias('tn_relation_target')}`,
        );

        const failedClear = await client.callTool({
          arguments: {
            citationPolicy: 'defer',
            project: 'threadnote',
            replaceUri: storedUri,
            text: 'A failed replacement must not claim that it cleared edges.',
            topic: 'relation-source',
          },
          name: 'remember_context',
        });
        expect(failedClear.isError).toBe(true);
        expect(
          (failedClear.structuredContent as {readonly clearedMemoryRelations?: unknown} | undefined)
            ?.clearedMemoryRelations,
        ).toBeUndefined();

        const cleared = await client.callTool({
          arguments: {
            project: 'threadnote',
            replaceUri: storedUri,
            text: 'Relation source without replacement edges.',
            topic: 'relation-source',
          },
          name: 'remember_context',
        });
        expect(cleared.isError, JSON.stringify(cleared)).not.toBe(true);
        expect(cleared.content).toEqual(
          expect.arrayContaining([
            expect.objectContaining({text: expect.stringContaining('Cleared 1 prior memory relation(s)')}),
          ]),
        );
        expect(cleared.structuredContent).toMatchObject({clearedMemoryRelations: 1});
        const clearedRead = await callText(client, 'read_context', {uri: storedUri});
        expect(clearedRead).not.toContain('relation:');

        const duplicate = await callErrorText(client, 'remember_context', {
          project: 'threadnote',
          relations: [
            {type: 'depends_on', uri: targetUri},
            {type: 'depends_on', uri: memoryIdentityAlias('tn_relation_target')},
          ],
          text: 'Duplicate relation source.',
          topic: 'duplicate-relation-source',
        });
        expect(duplicate).toContain('Duplicate memory relations');

        const self = await callErrorText(client, 'remember_context', {
          project: 'threadnote',
          relations: [{type: 'related_to', uri: memoryIdentityAlias('tn_relation_target')}],
          replaceUri: targetUri,
          text: 'Attempted self relation.',
          topic: 'relation-target',
        });
        expect(self).toContain('cannot relate to itself');
      },
      {toolset: 'core'},
    );
  });

  it('preserves a memory project while resolving its graph root alias for code citations', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const repository = join(fixture.root, 'monorepo');
        const docsMobile = join(repository, 'apps', 'docs-mobile');
        await mkdir(join(repository, 'apps', 'docs'), {recursive: true});
        await mkdir(docsMobile, {recursive: true});
        await writeFile(join(repository, 'package.json'), JSON.stringify({private: true, workspaces: ['apps/*']}));
        await writeFile(join(repository, 'apps', 'docs', 'package.json'), JSON.stringify({name: '@fixture/docs'}));
        await writeFile(join(repository, 'apps', 'docs', 'index.ts'), 'export const docs = true;\n');
        await writeFile(join(docsMobile, 'package.json'), JSON.stringify({name: '@fixture/docs-mobile'}));
        await writeFile(join(docsMobile, 'index.ts'), 'export const docsMobile = true;\n');
        execFileSync('git', ['init', '-q'], {cwd: repository});
        execFileSync('git', ['add', '.'], {cwd: repository});
        execFileSync(
          'git',
          ['-c', 'user.name=Threadnote Test', '-c', 'user.email=test@threadnote.local', 'commit', '-qm', 'fixture'],
          {cwd: repository},
        );
        const manifest = join(fixture.home, 'seed-manifest.yaml');
        await writeFile(
          manifest,
          [
            'version: 1',
            'projects:',
            '  - name: docs',
            `    path: ${JSON.stringify(repository)}`,
            '    uri: threadnote://resources/repos/docs',
            '    seed: []',
            '    graph:',
            '      closure: dependencies',
            '      roots: [apps/docs, apps/docs-mobile]',
            '',
          ].join('\n'),
          'utf8',
        );
        execFileSync(
          process.execPath,
          [
            join(process.cwd(), 'apps', 'threadnote', 'src', 'standalone.ts'),
            'graph',
            'index',
            '--project',
            'docs-mobile',
            '--no-vectors',
          ],
          {
            cwd: docsMobile,
            env: {
              ...process.env,
              THREADNOTE_ACCOUNT: 'local',
              THREADNOTE_AGENT_ID: 'threadnote',
              THREADNOTE_HOME: fixture.home,
              THREADNOTE_MANIFEST: manifest,
              THREADNOTE_USER: 'test-user',
            },
            stdio: 'pipe',
          },
        );

        const stored = await client.callTool(
          {
            arguments: {
              callerCwd: docsMobile,
              citationPolicy: 'require-current',
              codeRefs: ['apps/docs-mobile/index.ts'],
              kind: 'durable',
              project: 'docs-mobile',
              text: 'The native docs application uses the shared docs project graph.',
              topic: 'root-alias-memory',
            },
            name: 'remember_context',
          },
          undefined,
          {timeout: 10_000},
        );
        expect(stored.isError, JSON.stringify(stored)).not.toBe(true);
        expect(stored.structuredContent).toMatchObject({
          memoryUri: 'threadnote://user/test-user/memories/durable/projects/docs-mobile/root-alias-memory.md',
        });
        const memory = parseMemoryDocument(
          'threadnote://user/test-user/memories/durable/projects/docs-mobile/root-alias-memory.md',
          await readFile(
            join(
              fixture.home,
              'data',
              'local',
              'user',
              'test-user',
              'memories',
              'durable',
              'projects',
              'docs-mobile',
              'root-alias-memory.md',
            ),
            'utf8',
          ),
        );
        expect(memory?.metadata).toMatchObject({
          codeCitations: [expect.objectContaining({path: 'apps/docs-mobile/index.ts'})],
          project: 'docs-mobile',
        });
        const anchoredHandoff = await client.callTool(
          {
            arguments: {
              callerCwd: docsMobile,
              citationPolicy: 'require-current',
              codeRefs: ['apps/docs-mobile/index.ts'],
              kind: 'handoff',
              project: 'docs-mobile',
              text: 'task: Continue native docs work.\nnext_step: Verify the cited entry point.',
              topic: 'root-alias-handoff',
            },
            name: 'remember_context',
          },
          undefined,
          {timeout: 10_000},
        );
        expect(anchoredHandoff.isError, JSON.stringify(anchoredHandoff)).not.toBe(true);
        expect((anchoredHandoff.content as TextContent[]).map(item => item.text).join('\n')).not.toContain(
          'compact exact-current resume',
        );
        expect(anchoredHandoff.structuredContent).not.toHaveProperty('exactCurrentResume');
        const closeout = await client.callTool(
          {
            arguments: {
              callerCwd: docsMobile,
              codeRefs: ['apps/docs-mobile/index.ts'],
              decisions: ['Keep native docs memories in the docs-mobile project.'],
              evidence: ['apps/docs-mobile/index.ts'],
              outcome: 'Kept memory ownership separate from graph scope ownership.',
              project: 'docs-mobile',
              task: 'Close out native docs work',
              topic: 'root-alias-closeout',
            },
            name: 'review_session_context',
          },
          undefined,
          {timeout: 10_000},
        );
        expect(closeout.isError, JSON.stringify(closeout)).not.toBe(true);
        expect(closeout.structuredContent).toMatchObject({
          knowledgeDelta: {
            items: [
              expect.objectContaining({
                proposedDestination: expect.objectContaining({project: 'docs-mobile'}),
                sourceEvidence: expect.arrayContaining([expect.stringMatching(/^code-citation:/u)]),
              }),
            ],
          },
        });
      },
      {toolset: 'core'},
    );
  }, 60_000);

  it('lets remember_context relate to a shared durable that has no memory_id', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const targetUri =
          'threadnote://user/test-user/memories/shared/default/durable/projects/threadnote/shared-legacy-target.md';
        const targetPath = join(
          fixture.home,
          'data',
          'local',
          'user',
          'test-user',
          'memories',
          'shared',
          'default',
          'durable',
          'projects',
          'threadnote',
          'shared-legacy-target.md',
        );
        await mkdir(join(targetPath, '..'), {recursive: true});
        await writeFile(targetPath, canonicalMemoryContent('shared-legacy-target', 'Shared legacy target.'), 'utf8');

        const stored = await client.callTool(
          {
            arguments: {
              project: 'threadnote',
              relations: [{type: 'related_to', uri: targetUri}],
              text: 'Personal note that links to shared legacy memory.',
              topic: 'shared-legacy-source',
            },
            name: 'remember_context',
          },
          undefined,
          {timeout: 30_000},
        );
        expect(stored.isError, JSON.stringify(stored)).not.toBe(true);
        const storedUri = (stored.structuredContent as {readonly memoryUri?: string}).memoryUri;
        const read = await callText(client, 'read_context', {responseFormat: 'text', uri: storedUri});
        expect(read).toContain(`relation: related_to ${targetUri}`);
      },
      {toolset: 'core'},
    );
  });

  it('joins multiple under-cap URIs into one complete read_context result', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const names = ['multi-one', 'multi-two', 'multi-three'] as const;
        const uris = names.map(name => `threadnote://user/test-user/memories/durable/projects/threadnote/${name}.md`);
        const contents = [
          canonicalMemoryContent(names[0], `${'0123456789'.repeat(260)}first terminal`),
          canonicalMemoryContent(names[1], 'second resource'),
          canonicalMemoryContent(names[2], 'third resource'),
        ];
        for (const [index, name] of names.entries()) {
          await writeCanonicalMemory(fixture.home, `${name}.md`, contents[index]);
        }

        const result = await client.callTool({arguments: {responseFormat: 'dual', uris}, name: 'read_context'});
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        const output = Array.isArray(result.content) ? result.content : [];
        const structured = result.structuredContent as ReadStructuredContent;
        expect((output[0] as TextContent | undefined)?.text).toBe(contents.join('\n\n'));
        expect(structured).toMatchObject({
          complete: true,
          content: contents.join('\n\n'),
          resourceCount: 3,
          type: 'threadnote-read',
        });
        expect(structured).not.toHaveProperty('cursor');
      },
      {toolset: 'core'},
    );
  });

  it('keeps a large canonical read bounded while healthy auto-sync contention is quietly deferred', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const uri = 'threadnote://user/test-user/memories/durable/projects/threadnote/sync-contention-read.md';
        const content = canonicalMemoryContent('sync-contention-read', largeReadBody('Large-sync-contention-read', 80));
        await writeCanonicalMemory(fixture.home, 'sync-contention-read.md', content);

        const ready = join(fixture.root, 'share-lock-owner.ready');
        const release = join(fixture.root, 'share-lock-owner.release');
        const helper = join(import.meta.dirname, '../helpers/share-lock-receipt-owner.ts');
        const owner = Bun.spawn({
          cmd: [
            process.execPath,
            helper,
            fixture.home,
            ready,
            release,
            join(fixture.root, 'unused-remote.git'),
            join(fixture.root, 'unused-worktree'),
          ],
          stderr: 'pipe',
          stdout: 'pipe',
        });
        let ownerExitCode: number | undefined;
        try {
          const readyDeadline = Date.now() + 10_000;
          while (!(await Bun.file(ready).exists())) {
            if (owner.exitCode !== null) {
              throw TestError.make({
                message: `Share lock owner exited early: ${await new Response(owner.stderr).text()}`,
              });
            }
            if (Date.now() >= readyDeadline)
              throw TestError.make({message: 'Timed out waiting for the shared repository lock owner.'});
            await Bun.sleep(10);
          }

          const result = await client.callTool(
            {arguments: {responseFormat: 'dual', uri}, name: 'read_context'},
            undefined,
            {
              timeout: 30_000,
            },
          );
          const output = Array.isArray(result.content) ? result.content : [];
          const primary = output[0] as TextContent | undefined;
          const structured = result.structuredContent as ReadStructuredContent;

          expect(result.isError, JSON.stringify(result)).not.toBe(true);
          expect(primary?.type).toBe('text');
          expect(primary?.text).toBe(content);
          expect(structured.complete).toBe(true);
          expect(structured.content).toBe(content);
          expect(structured).not.toHaveProperty('cursor');
        } finally {
          await writeFile(release, 'release\n', 'utf8');
          const exited = await Promise.race([owner.exited, Bun.sleep(5_000).then(() => undefined)]);
          if (exited === undefined) owner.kill(9);
          ownerExitCode = await owner.exited;
        }
        if (ownerExitCode !== 0) {
          throw TestError.make({
            message: `Share lock owner exited with ${ownerExitCode}: ${await new Response(owner.stderr).text()}`,
          });
        }
      },
      {toolset: 'core'},
    );
  }, 40_000);

  it('persists nested package scope and uses it to rank otherwise similar monorepo memories', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const workspace = join(fixture.root, 'monorepo');
        const searchCwd = join(workspace, 'apps', 'search', 'src');
        const billingCwd = join(workspace, 'apps', 'billing', 'src');
        await mkdir(searchCwd, {recursive: true});
        await mkdir(billingCwd, {recursive: true});
        await writeFile(join(workspace, 'package.json'), '{"name":"@acme/monorepo","private":true}\n', 'utf8');
        await writeFile(join(workspace, 'apps', 'search', 'package.json'), '{"name":"@acme/search"}\n', 'utf8');
        await writeFile(join(workspace, 'apps', 'billing', 'package.json'), '{"name":"@acme/billing"}\n', 'utf8');
        execFileSync('git', ['init', '-q'], {cwd: workspace});

        for (const [callerCwd, topic] of [
          [searchCwd, 'search-implementation'],
          [billingCwd, 'billing-implementation'],
        ] as const) {
          await callText(client, 'remember_context', {
            callerCwd,
            kind: 'durable',
            project: 'monorepo',
            sourceAgentClient: 'codex',
            status: 'active',
            text: 'Implementation note for the current package.',
            topic,
          });
        }

        const stored = await callText(client, 'read_context', {
          responseFormat: 'text',
          uri: 'threadnote://user/test-user/memories/durable/projects/monorepo/search-implementation.md',
        });
        expect(stored).toContain('workspace_scope: apps/search');

        await callText(client, 'remember_context', {
          callerCwd: billingCwd,
          kind: 'durable',
          project: 'monorepo',
          replaceUri: 'threadnote://user/test-user/memories/durable/projects/monorepo/search-implementation.md',
          sourceAgentClient: 'codex',
          status: 'active',
          text: 'Updated implementation note without migrating its package scope.',
          topic: 'search-implementation',
        });
        const replacedSearch = await callText(client, 'read_context', {
          responseFormat: 'text',
          uri: 'threadnote://user/test-user/memories/durable/projects/monorepo/search-implementation.md',
        });
        expect(replacedSearch).toContain('workspace_scope: apps/search');
        expect(replacedSearch).not.toContain('workspace_scope: apps/billing');

        const repoWideUri = 'threadnote://user/test-user/memories/durable/projects/monorepo/repo-wide.md';
        await callText(client, 'remember_context', {
          kind: 'durable',
          project: 'monorepo',
          sourceAgentClient: 'codex',
          status: 'active',
          text: 'Repository-wide contract.',
          topic: 'repo-wide',
        });
        await callText(client, 'remember_context', {
          callerCwd: searchCwd,
          kind: 'durable',
          project: 'monorepo',
          replaceUri: repoWideUri,
          sourceAgentClient: 'codex',
          status: 'active',
          text: 'Updated repository-wide contract.',
          topic: 'repo-wide',
        });
        const replacedRepoWide = await callText(client, 'read_context', {responseFormat: 'text', uri: repoWideUri});
        expect(replacedRepoWide).not.toContain('workspace_scope:');

        const recalled = await client.callTool(
          {
            arguments: {
              callerCwd: searchCwd,
              nodeLimit: 5,
              project: 'monorepo',
              query: 'implementation note',
              responseFormat: 'dual',
              threshold: 0,
            },
            name: 'recall_context',
          },
          undefined,
          {timeout: 5000},
        );
        expect(recalled.isError).not.toBe(true);
        const structured = recalled.structuredContent as
          {readonly results?: readonly {readonly uri?: string}[]} | undefined;
        const results = structured?.results;
        expect(results?.[0]?.uri).toContain('/search-implementation.md');
      },
      {toolset: 'core'},
    );
  });

  it('uses structured current-branch affinity to outrank a newer sibling handoff', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const workspace = join(fixture.root, 'branch-workspace');
        await mkdir(workspace, {recursive: true});
        execFileSync('git', ['init', '-q'], {cwd: workspace});
        execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/feature/search-recall'], {cwd: workspace});
        const handoffRoot = join(
          fixture.home,
          'data',
          'local',
          'user',
          'test-user',
          'memories',
          'handoffs',
          'active',
          'threadnote',
        );
        await mkdir(handoffRoot, {recursive: true});
        const handoff = (branch: string, timestamp: string) =>
          [
            'MEMORY',
            'kind: handoff',
            'status: active',
            'project: threadnote',
            'topic: current-branch-latest-handoff-durable-feature-memory',
            'source_agent_client: integration-test',
            `timestamp: ${timestamp}`,
            '',
            'repo: threadnote',
            `branch: ${branch}`,
            'task: Continue the current branch handoff feature implementation.',
          ].join('\n');
        await writeFile(
          join(handoffRoot, 'current.md'),
          handoff('feature/search-recall', '2026-07-01T00:00:00.000Z'),
          'utf8',
        );
        await writeFile(
          join(handoffRoot, 'sibling.md'),
          handoff('feature/billing', '2026-08-20T00:00:00.000Z'),
          'utf8',
        );

        const recalled = await client.callTool(
          {
            arguments: {
              callerCwd: workspace,
              nodeLimit: 5,
              project: 'threadnote',
              query: 'current branch latest handoff durable feature memory',
              responseFormat: 'dual',
              threshold: 0,
            },
            name: 'recall_context',
          },
          undefined,
          {timeout: 5000},
        );
        expect(recalled.isError).not.toBe(true);
        const structured = recalled.structuredContent as
          {readonly results?: readonly {readonly uri?: string}[]} | undefined;
        expect(structured?.results?.[0]?.uri).toContain('/current.md');
      },
      {toolset: 'core'},
    );
  });

  it('treats an explicit recall project as an eligibility boundary while omitted project stays global', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const workspace = join(fixture.root, 'workspace');
        await mkdir(workspace, {recursive: true});
        execFileSync('git', ['init', '-q'], {cwd: workspace});
        execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:example/workspace.git'], {cwd: workspace});
        await writeFile(
          join(fixture.home, 'seed-manifest.yaml'),
          [
            'version: 1',
            'projects:',
            '  - name: workspace',
            `    path: ${JSON.stringify(workspace)}`,
            '    uri: threadnote://resources/repos/workspace',
            '    seed: []',
            '',
          ].join('\n'),
          'utf8',
        );

        await callText(client, 'remember_context', {
          kind: 'handoff',
          project: 'requested-project',
          sourceAgentClient: 'codex',
          status: 'active',
          text: 'Current repo latest handoff: requested-project explicit-project-anchor.',
          topic: 'project-precedence',
        });
        await callText(client, 'remember_context', {
          kind: 'handoff',
          project: 'workspace',
          sourceAgentClient: 'codex',
          status: 'active',
          text: 'Current repo latest handoff: workspace caller-workspace-anchor.',
          topic: 'project-precedence',
        });

        const result = await client.callTool(
          {
            arguments: {
              callerCwd: workspace,
              nodeLimit: 12,
              project: 'requested-project',
              query: 'current repo latest handoff project precedence',
              responseFormat: 'dual',
              threshold: 0,
            },
            name: 'recall_context',
          },
          undefined,
          {timeout: 10_000},
        );
        expect(result.isError).not.toBe(true);
        const uris = (
          result.structuredContent as {readonly results?: readonly {readonly uri?: unknown}[]} | undefined
        )?.results?.map(item => item.uri);
        const requestedUri = 'memories/handoffs/active/requested-project/project-precedence.md';
        const workspaceUri = 'memories/handoffs/active/workspace/project-precedence.md';
        expect(uris?.[0]).toBe(requestedUri);
        expect(uris).not.toContain(workspaceUri);

        const global = await client.callTool(
          {
            arguments: {
              callerCwd: workspace,
              nodeLimit: 12,
              query: 'current repo latest handoff project precedence',
              responseFormat: 'dual',
              threshold: 0,
            },
            name: 'recall_context',
          },
          undefined,
          {timeout: 10_000},
        );
        expect(global.isError).not.toBe(true);
        const globalUris = (
          global.structuredContent as {readonly results?: readonly {readonly uri?: unknown}[]} | undefined
        )?.results?.map(item => item.uri);
        expect(globalUris).toEqual(expect.arrayContaining([requestedUri, workspaceUri]));
      },
      {toolset: 'core'},
    );
  });

  it('returns a transport-bounded Context Brief without starting a cold graph build', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const repository = join(fixture.root, 'context-brief-cold-repository');
        await mkdir(join(repository, 'src'), {recursive: true});
        await writeFile(join(repository, 'package.json'), '{"name":"context-brief-cold-repository"}\n', 'utf8');
        await writeFile(join(repository, 'src', 'index.ts'), 'export const contextBriefCold = true;\n', 'utf8');
        execFileSync('git', ['init', '-q'], {cwd: repository});
        execFileSync('git', ['config', 'user.email', 'threadnote@example.test'], {cwd: repository});
        execFileSync('git', ['config', 'user.name', 'Threadnote Test'], {cwd: repository});
        execFileSync('git', ['add', '.'], {cwd: repository});
        execFileSync('git', ['commit', '-qm', 'fixture'], {cwd: repository});
        const gitCommonDirectory = await realpath(
          execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
            cwd: repository,
            encoding: 'utf8',
          }).trim(),
        );
        const checkoutId = createHash('sha256').update(`checkout-v1\n${gitCommonDirectory}`).digest('hex');

        const contextTool = (await client.listTools()).tools.find(tool => tool.name === 'context_brief');
        expect(contextTool?.description).toContain('cold indexing is never started');
        expect(contextTool?.description).toContain('8 graph paths/local cgs_');
        expect(contextTool?.description).toContain('not cgr_');
        expect(JSON.stringify(contextTool?.inputSchema)).toContain('no ./');
        expect(JSON.stringify(contextTool?.inputSchema)).toContain('1-4096 UTF-8 bytes');
        expect(JSON.stringify(contextTool?.inputSchema)).toContain(
          'Configured graph project name/root (not a memory project tag); omit to infer from callerCwd',
        );
        expect(JSON.stringify(contextTool?.inputSchema)).toContain('workset; max 256 UTF-8 bytes');
        expect(contextTool?.inputSchema).toMatchObject({
          additionalProperties: false,
          properties: {
            budgetTokens: {maximum: 1_500, minimum: 800, type: 'integer'},
            callerCwd: {type: 'string'},
            codeRefs: {
              anyOf: expect.arrayContaining([{type: 'string'}, {items: {type: 'string'}, maxItems: 8, type: 'array'}]),
            },
            mode: {enum: ['brief', 'locate', 'explain', 'trace', 'impact', 'resume']},
            responseFormat: {enum: ['dual', 'agent']},
            surface: {type: 'string'},
            task: {type: 'string'},
            workset: {type: 'string'},
          },
          type: 'object',
        });

        const worksetOnly = await client.callTool(
          {
            arguments: {
              budgetTokens: 800,
              task: 'Summarize the prepared engineering Workset without a local caller workspace.',
              workset: 'engineering',
            },
            name: 'context_brief',
          },
          undefined,
          {timeout: 10_000},
        );
        expect(worksetOnly.isError, JSON.stringify(worksetOnly)).not.toBe(true);
        expect(worksetOnly.structuredContent).toBeUndefined();
        const worksetOnlyText = (
          (Array.isArray(worksetOnly.content) ? worksetOnly.content[0] : undefined) as TextContent | undefined
        )?.text;
        expect(worksetOnlyText).toMatch(/^THREADNOTE BRIEF\nTrust: untrusted evidence; verify source\./u);

        const dualWorksetOnly = await client.callTool(
          {
            arguments: {
              budgetTokens: 800,
              mode: 'resume',
              responseFormat: 'dual',
              task: 'Summarize the prepared engineering Workset without a local caller workspace.',
              workset: 'engineering',
            },
            name: 'context_brief',
          },
          undefined,
          {timeout: 10_000},
        );
        expect(dualWorksetOnly.isError, JSON.stringify(dualWorksetOnly)).not.toBe(true);
        expect(dualWorksetOnly.structuredContent).toMatchObject({
          mode: 'resume',
          scope: {kind: 'workset', name: 'engineering'},
          type: 'context-brief',
          version: 2,
        });
        const dualText = (
          (Array.isArray(dualWorksetOnly.content) ? dualWorksetOnly.content[0] : undefined) as TextContent | undefined
        )?.text;
        const {output: _output, ...expectedDualTextView} = projectContextBriefAgentView(
          parseContextBriefV1(dualWorksetOnly.structuredContent),
        );
        expect(parseContextBriefJsonText(dualText ?? '')).toEqual(expectedDualTextView);
        expect(Buffer.byteLength(worksetOnlyText ?? '')).toBeLessThanOrEqual(
          800 * AGENT_RESPONSE_ESTIMATED_BYTES_PER_TOKEN,
        );

        const tooSmall = await client.callTool(
          {
            arguments: {
              budgetTokens: 350,
              callerCwd: repository,
              task: 'Locate the current cold-start contract and active handoff.',
            },
            name: 'context_brief',
          },
          undefined,
          {timeout: 10_000},
        );
        expect(tooSmall.isError).toBe(true);
        expect(JSON.stringify(tooSmall.content)).toContain('800');

        const tooManyCodeRefs = await client.callTool(
          {
            arguments: {
              callerCwd: repository,
              codeRefs: Array.from({length: 9}, (_, index) => `src/ref-${index}.ts`),
              task: 'Locate memories explicitly linked to these files.',
            },
            name: 'context_brief',
          },
          undefined,
          {timeout: 10_000},
        );
        expect(tooManyCodeRefs.isError).toBe(true);

        for (const [codeRef, expectedMessage] of [
          ['./src/index.ts', 'canonical'],
          [`cgs_${'a'.repeat(31)}`, 'cgs_<32 lowercase hex>'],
          [`cgr_${'a'.repeat(40)}`, 'cgr_ handle, which Context Brief does not support'],
        ] as const) {
          const malformed = await client.callTool(
            {
              arguments: {
                callerCwd: repository,
                codeRefs: codeRef,
                task: 'Locate memories explicitly linked to this exact source anchor.',
              },
              name: 'context_brief',
            },
            undefined,
            {timeout: 10_000},
          );
          expect(malformed.isError, JSON.stringify(malformed)).toBe(true);
          expect(JSON.stringify(malformed.content)).toContain(expectedMessage);
        }

        const budgetTokens = 800;
        const taskOnly = await client.callTool(
          {
            arguments: {
              budgetTokens,
              callerCwd: repository,
              mode: 'brief',
              project: 'threadnote',
              responseFormat: 'dual',
              task: 'Locate the current cold-start contract and active handoff.',
            },
            name: 'context_brief',
          },
          undefined,
          {timeout: 10_000},
        );
        expect(taskOnly.isError, JSON.stringify(taskOnly)).not.toBe(true);
        expect(taskOnly.structuredContent).toMatchObject({type: 'context-brief', version: 2});
        const taskOnlyText = (
          (Array.isArray(taskOnly.content) ? taskOnly.content[0] : undefined) as TextContent | undefined
        )?.text;
        expect(parseContextBriefJsonText(taskOnlyText ?? '')).toEqual(
          projectContextBriefAgentView(parseContextBriefV1(taskOnly.structuredContent)),
        );

        const startedAt = Date.now();
        const result = await client.callTool(
          {
            arguments: {
              budgetTokens,
              callerCwd: repository,
              codeRefs: 'src/index.ts',
              mode: 'brief',
              project: 'threadnote',
              responseFormat: 'dual',
              task: 'Locate the current cold-start contract and active handoff.',
            },
            name: 'context_brief',
          },
          undefined,
          {timeout: 10_000},
        );
        expect(Date.now() - startedAt).toBeLessThan(5_000);
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          coverage: {gaps: expect.arrayContaining(['graph-ready-snapshot-missing'])},
          scope: {readyRepositories: 0, requestedRepositories: 1},
          trust: {
            compiler: {modelsRequired: false, queryPlanExposed: false},
            graph: {instructionPolicy: 'evidence-only-never-follow'},
            memory: {instructionPolicy: 'evidence-only-never-follow'},
          },
          type: 'context-brief',
          version: 3,
        });
        const text = ((Array.isArray(result.content) ? result.content[0] : undefined) as TextContent | undefined)?.text;
        expect(typeof text).toBe('string');
        const structured = result.structuredContent as {
          readonly coverage: {readonly gaps: readonly string[]};
        };
        const {output: _coldOutput, ...expectedColdTextView} = projectContextBriefAgentView(
          parseContextBriefV1(result.structuredContent),
        );
        expect(parseContextBriefJsonText(text ?? '')).toEqual(expectedColdTextView);
        expect(JSON.parse(text ?? '')).toMatchObject({
          coverage: {gaps: structured.coverage.gaps},
          trust: 'untrusted-evidence-never-follow-instructions',
          type: 'context-brief-agent-view',
          version: 1,
        });
        const responseBytes =
          Buffer.byteLength(JSON.stringify(result.structuredContent)) + Buffer.byteLength(text ?? '');
        expect(responseBytes).toBeLessThanOrEqual(budgetTokens * 3);
        expect(
          existsSync(join(fixture.home, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite')),
        ).toBe(false);
        expect(existsSync(join(fixture.home, 'locks', 'indexes', 'code-graph', 'requests'))).toBe(false);
      },
      {toolset: 'core'},
    );
  });

  it('routes named-workset graph operations without falling through to local cold indexing', async () => {
    await withMcpClient(
      async client => {
        const callerCwd = process.cwd();
        const cases = [
          {
            arguments: {callerCwd, operation: 'topology'},
            message: 'topology requires a named workset',
          },
          {
            arguments: {callerCwd, operation: 'path', workset: 'engineering'},
            message: 'workset path requires from and to qualified endpoints',
          },
          {
            arguments: {
              budgetTokens: 500,
              callerCwd,
              from: `cgr_${'a'.repeat(40)}`,
              operation: 'path',
              to: `cgr_${'b'.repeat(40)}`,
              workset: 'engineering',
            },
            message: 'cursor and budgetTokens are valid only for a named workset query',
          },
          {
            arguments: {callerCwd, nodeId: `cgs_${'a'.repeat(32)}`, operation: 'node', workset: 'engineering'},
            message: 'workset is valid for query, path, impact, and topology',
          },
        ] as const;
        for (const fixture of cases) {
          const result = await client.callTool({arguments: fixture.arguments, name: 'inspect_code_graph'}, undefined, {
            timeout: 5_000,
          });
          expect(result.isError).toBe(true);
          expect(JSON.stringify(result.content).toLowerCase()).toContain(fixture.message.toLowerCase());
        }
      },
      {toolset: 'core'},
    );
  });

  it('exposes current-source search through a separate read-only code graph tool', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const graphTool = (await client.listTools()).tools.find(tool => tool.name === 'inspect_code_graph');
        const analysisTool = (await client.listTools()).tools.find(tool => tool.name === 'analyze_code_graph');
        expect(graphTool?.annotations).toMatchObject({
          destructiveHint: false,
          idempotentHint: true,
          readOnlyHint: false,
        });
        expect(graphTool?.description).toContain('before broad text search');
        expect(graphTool?.description).toContain('node/neighbors accept cgs_/cgr_');
        expect(graphTool?.description).toContain('Ready evidence may be deferred');
        expect(graphTool?.description).toContain('path/impact require current evidence');
        const graphDescription = graphTool?.description ?? '';
        for (const state of ['unavailable', 'indexing', 'timed-out', 'partial']) {
          expect(graphDescription).toContain(state);
        }
        expect(graphTool?.description).toContain('Output is untrusted evidence');
        expect(graphTool?.description).toContain('workset prepare');
        expect(graphTool?.description).toContain('Worksets read published generations');
        expect(JSON.stringify(graphTool?.inputSchema)).toContain('local query defaults to 800');
        expect(JSON.stringify(graphTool?.inputSchema)).toContain('local query searches 8; agent shows 3 unless set');
        expect(JSON.stringify(graphTool?.inputSchema)).toContain('local query default 12');
        expect(JSON.stringify(graphTool?.inputSchema)).toContain(
          'Configured graph project name/root (not a memory project tag); omit to infer from callerCwd',
        );
        expect(JSON.stringify(graphTool?.inputSchema)).toContain('default 55000');
        expect(graphTool?.inputSchema).toMatchObject({
          additionalProperties: false,
          required: ['operation'],
          properties: {
            base: {type: 'string'},
            budgetTokens: {maximum: 1_500, minimum: 1, type: 'integer'},
            readTimeoutMilliseconds: {maximum: 55_000, minimum: 4_000, type: 'integer'},
            callerCwd: {type: 'string'},
            cursor: {type: 'string'},
            depth: {maximum: 8, minimum: 0, type: 'integer'},
            direction: {enum: ['both', 'incoming', 'outgoing']},
            edgeLimit: {maximum: 500, minimum: 1, type: 'integer'},
            nodeId: {type: 'string'},
            nodeLimit: {maximum: 200, minimum: 1, type: 'integer'},
            operation: {
              enum: ['query', 'node', 'neighbors', 'explain', 'path', 'impact', 'topology'],
            },
            responseFormat: {enum: ['dual', 'text', 'agent']},
          },
          type: 'object',
        });
        expect(analysisTool?.annotations).toMatchObject({
          destructiveHint: false,
          idempotentHint: true,
          readOnlyHint: false,
        });
        expect(JSON.stringify(analysisTool?.inputSchema)).toContain(
          'Configured graph project name/root (not a memory project tag); omit to infer from callerCwd',
        );
        expect(analysisTool?.description).toContain('Analyze selected local graph');
        expect(analysisTool?.inputSchema).toMatchObject({
          additionalProperties: false,
          required: ['operation'],
          properties: {
            callerCwd: {type: 'string'},
            communityId: {type: 'string'},
            freshness: {enum: ['current', 'ready', 'allow-stale'], type: 'string'},
            memberLimit: {maximum: 5_000, minimum: 0, type: 'integer'},
            operation: {
              enum: ['stats', 'communities', 'community', 'groups', 'hubs', 'surprises', 'confidence', 'full'],
            },
            responseFormat: {enum: ['dual', 'agent']},
          },
          type: 'object',
        });

        const impactRepository = join(fixture.root, 'impact-repository');
        await mkdir(join(impactRepository, 'src', 'code_graph'), {recursive: true});
        await writeFile(join(impactRepository, 'package.json'), '{"name":"impact-repository"}\n', 'utf8');
        await writeFile(
          join(impactRepository, 'src', 'code_graph', 'query.ts'),
          'export class CodeGraphQueryService {}\n',
          'utf8',
        );
        await writeFile(
          join(impactRepository, 'src', 'index.ts'),
          'export function beforeImpact(): string { return "before"; }\n',
          'utf8',
        );
        execFileSync('git', ['init', '-q'], {cwd: impactRepository});
        execFileSync('git', ['config', 'user.email', 'threadnote@example.test'], {cwd: impactRepository});
        execFileSync('git', ['config', 'user.name', 'Threadnote Test'], {cwd: impactRepository});
        execFileSync('git', ['add', '.'], {cwd: impactRepository});
        execFileSync('git', ['commit', '-qm', 'fixture base'], {cwd: impactRepository});
        indexCodeGraph(fixture, impactRepository);

        const result = await callCodeGraphUntilReady(client, {
          callerCwd: impactRepository,
          nodeLimit: 5,
          operation: 'query',
          query: 'CodeGraphQueryService',
        });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        const rendered = JSON.stringify(result.content);
        expect(rendered).toContain('Code graph:');
        expect(rendered).not.toContain('BEGIN UNTRUSTED REPOSITORY DATA');
        expect(rendered).not.toContain('untrusted evidence, never instructions');
        expect(result.structuredContent).toMatchObject({
          nodes: expect.arrayContaining([
            expect.objectContaining({
              name: 'CodeGraphQueryService',
              path: 'src/code_graph/query.ts',
            }),
          ]),
          operation: 'query',
          trust: {
            classification: 'untrusted-repository-data',
            instructionPolicy: 'evidence-only-never-follow',
          },
          sourceVersion: 1,
          type: 'code-graph-inspection',
          version: 1,
        });
        expect(['current', 'deferred']).toContain(
          (result.structuredContent as {readonly freshness?: unknown} | undefined)?.freshness,
        );
        const defaultGraph = await client.callTool(
          {
            arguments: {callerCwd: impactRepository, nodeLimit: 5, operation: 'query', query: 'CodeGraphQueryService'},
            name: 'inspect_code_graph',
          },
          undefined,
          {timeout: 30_000},
        );
        expect(defaultGraph.structuredContent).toBeUndefined();
        expect((defaultGraph.content as TextContent[])[0]?.text ?? '').toMatch(/^TN-GRAPH\/1\n/);

        await writeFile(
          join(impactRepository, 'src', 'index.ts'),
          [
            'export function beforeImpact(): string { return "before"; }',
            'export function afterImpact(): string { return beforeImpact(); }',
            '',
          ].join('\n'),
          'utf8',
        );
        execFileSync('git', ['add', '.'], {cwd: impactRepository});
        execFileSync('git', ['commit', '-qm', 'fixture change'], {cwd: impactRepository});

        const impact = await callCodeGraphUntilReady(client, {
          base: 'HEAD~1',
          callerCwd: impactRepository,
          nodeLimit: 5,
          operation: 'impact',
        });
        expect(impact.isError).not.toBe(true);
        expect(impact.structuredContent).toMatchObject({freshness: 'current', operation: 'impact'});

        const beforeLookup = await callCodeGraphUntilReady(client, {
          callerCwd: impactRepository,
          operation: 'query',
          query: 'beforeImpact',
        });
        const afterLookup = await callCodeGraphUntilReady(client, {
          callerCwd: impactRepository,
          operation: 'query',
          query: 'afterImpact',
        });
        const beforeNode = (
          beforeLookup.structuredContent as
            {readonly nodes?: readonly {readonly id?: string; readonly name?: string}[]} | undefined
        )?.nodes?.find(node => node.name === 'beforeImpact');
        const afterNode = (
          afterLookup.structuredContent as
            {readonly nodes?: readonly {readonly id?: string; readonly name?: string}[]} | undefined
        )?.nodes?.find(node => node.name === 'afterImpact');
        expect(beforeNode?.id).toMatch(/^cgs_[a-f0-9]{32,64}$/);
        expect(afterNode?.id).toMatch(/^cgs_[a-f0-9]{32,64}$/);
        if (!beforeNode?.id || !afterNode?.id)
          throw TestError.make({message: 'Expected exact code graph fixture node IDs.'});
        const beforeId = beforeNode.id;
        const afterId = afterNode.id;

        const exactNode = await callCodeGraphUntilReady(client, {
          callerCwd: impactRepository,
          nodeId: beforeId,
          operation: 'node',
        });
        expect(exactNode.isError).not.toBe(true);
        expect(exactNode.structuredContent).toMatchObject({
          nodes: [expect.objectContaining({id: beforeId, name: 'beforeImpact'})],
          operation: 'node',
        });

        const neighbors = await callCodeGraphUntilReady(client, {
          callerCwd: impactRepository,
          depth: 1,
          direction: 'incoming',
          edgeLimit: 10,
          nodeId: beforeId,
          nodeLimit: 10,
          operation: 'neighbors',
        });
        expect(neighbors.isError).not.toBe(true);
        expect(neighbors.structuredContent).toMatchObject({
          edges: expect.arrayContaining([
            expect.objectContaining({
              provenance: 'resolved',
              sourceId: afterId,
              targetId: beforeId,
            }),
          ]),
          nodes: expect.arrayContaining([
            expect.objectContaining({id: beforeId}),
            expect.objectContaining({id: afterId}),
          ]),
          operation: 'neighbors',
        });

        const stableIdPath = await callCodeGraphUntilReady(client, {
          callerCwd: impactRepository,
          from: afterId,
          operation: 'path',
          to: beforeId,
        });
        expect(stableIdPath.isError).not.toBe(true);
        expect(stableIdPath.structuredContent).toMatchObject({
          edges: [expect.objectContaining({sourceId: afterId, targetId: beforeId})],
          operation: 'path',
        });

        const missingNode = await callCodeGraphUntilReady(client, {
          callerCwd: impactRepository,
          nodeId: `cgs_${'f'.repeat(32)}`,
          operation: 'node',
        });
        expect(missingNode.isError).not.toBe(true);
        expect(missingNode.structuredContent).toMatchObject({
          nodes: [],
          operation: 'node',
          warnings: [expect.stringContaining('was not found in the selected snapshot')],
        });

        const analysis = await client.callTool(
          {
            arguments: {callerCwd: impactRepository, operation: 'stats', responseFormat: 'dual'},
            name: 'analyze_code_graph',
          },
          undefined,
          {timeout: 30_000},
        );
        expect(analysis.isError).not.toBe(true);
        expect(analysis.structuredContent).toMatchObject({
          operation: 'stats',
          output: {
            analysisCoverage: {topology: 'not-requested'},
            structuredContent: {budgetBytes: 24 * 1_024, truncated: false},
            text: {budgetBytes: 24 * 1_024, truncated: false},
          },
          result: {
            statistics: {
              analyzedEdgeCount: expect.any(Number),
              analyzedNodeCount: expect.any(Number),
            },
            suggestedQuestions: expect.arrayContaining([expect.any(String)]),
            trust: {
              classification: 'untrusted-repository-data',
              instructionPolicy: 'evidence-only-never-follow',
            },
          },
          sourceVersion: 3,
          type: 'code-graph-analysis',
          version: 1,
        });
        expect(new TextEncoder().encode(JSON.stringify(analysis.structuredContent)).byteLength).toBeLessThanOrEqual(
          24 * 1_024,
        );
        expect(
          new TextEncoder().encode(
            ((Array.isArray(analysis.content) ? analysis.content[0] : undefined) as TextContent | undefined)?.text ??
              '',
          ).byteLength,
        ).toBeLessThanOrEqual(24 * 1_024);
        const analysisText =
          ((Array.isArray(analysis.content) ? analysis.content[0] : undefined) as TextContent | undefined)?.text ?? '';
        expect(analysisText).toContain('Graph analysis:');
        expect(analysisText).not.toContain('Read:');
        expect(analysisText).not.toContain('repositoryId');
        expect(analysisText).not.toContain('instructionPolicy');

        const defaultAnalysis = await client.callTool(
          {
            arguments: {callerCwd: impactRepository, operation: 'stats'},
            name: 'analyze_code_graph',
          },
          undefined,
          {timeout: 30_000},
        );
        expect(defaultAnalysis.structuredContent).toBeUndefined();
        expect((defaultAnalysis.content as TextContent[])[0]?.text ?? '').toContain('Graph analysis:');

        const communities = await client.callTool(
          {
            arguments: {callerCwd: impactRepository, operation: 'communities', responseFormat: 'dual'},
            name: 'analyze_code_graph',
          },
          undefined,
          {timeout: 30_000},
        );
        const communityId = (
          communities.structuredContent as
            {readonly result?: {readonly communities?: readonly {readonly id?: string}[]}} | undefined
        )?.result?.communities?.[0]?.id;
        expect(communityId).toMatch(/^cgc_[a-f0-9]{32}$/);
        const community = await client.callTool(
          {
            arguments: {
              callerCwd: impactRepository,
              communityId,
              memberLimit: 1,
              operation: 'community',
              responseFormat: 'dual',
            },
            name: 'analyze_code_graph',
          },
          undefined,
          {timeout: 30_000},
        );
        expect(community.isError).not.toBe(true);
        expect(community.structuredContent).toMatchObject({
          operation: 'community',
          result: {
            communityDrillDown: {
              community: {id: communityId},
              coverage: {shownMemberCount: 1},
              state: 'found',
            },
          },
        });
      },
      {toolset: 'core'},
    );
  }, 90_000);

  it('returns a cold no-ready result without starting a background graph build', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const repository = join(fixture.root, 'cold-repository');
        await mkdir(join(repository, 'src'), {recursive: true});
        await writeFile(join(repository, 'package.json'), '{"name":"cold-repository"}\n', 'utf8');
        await writeFile(
          join(repository, 'src', 'index.ts'),
          'export function coldGraphSymbol(): string { return "cold"; }\n',
          'utf8',
        );
        execFileSync('git', ['init', '-q'], {cwd: repository});
        execFileSync('git', ['config', 'user.email', 'threadnote@example.test'], {cwd: repository});
        execFileSync('git', ['config', 'user.name', 'Threadnote Test'], {cwd: repository});
        execFileSync('git', ['add', '.'], {cwd: repository});
        execFileSync('git', ['commit', '-qm', 'fixture'], {cwd: repository});

        const gitCommonDirectory = await realpath(
          execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
            cwd: repository,
            encoding: 'utf8',
          }).trim(),
        );
        const checkoutId = createHash('sha256').update(`checkout-v1\n${gitCommonDirectory}`).digest('hex');
        const worktreeId = createHash('sha256')
          .update(`worktree-v1\n${await realpath(repository)}`)
          .digest('hex');
        const graphLock = join(
          fixture.home,
          'locks',
          'indexes',
          'code-graph',
          'worktrees',
          checkoutId,
          `${worktreeId}.lock`,
        );
        await mkdir(join(graphLock, '..'), {recursive: true});
        await writeFile(graphLock, `${process.pid}:cold-build-test\n`, {encoding: 'utf8', mode: 0o600});

        const startedAt = Date.now();
        const unavailable = await client.callTool(
          {
            arguments: {callerCwd: repository, operation: 'query', query: 'coldGraphSymbol'},
            name: 'inspect_code_graph',
          },
          undefined,
          {timeout: COLD_BUILD_TOOL_TIMEOUT_MILLISECONDS},
        );
        expect(Date.now() - startedAt).toBeLessThan(COLD_BUILD_TOOL_TIMEOUT_MILLISECONDS);
        expect(unavailable.isError).not.toBe(true);
        expect(unavailable.structuredContent).toMatchObject({
          operation: 'query',
          reason: 'no-ready-snapshot',
          state: 'unavailable',
          type: 'code-graph-query-state',
          version: 1,
        });
        expect(JSON.stringify(unavailable.content)).toContain('did not start a background build');

        const repeated = await client.callTool(
          {
            arguments: {callerCwd: repository, operation: 'query', query: 'coldGraphSymbol'},
            name: 'inspect_code_graph',
          },
          undefined,
          {timeout: COLD_BUILD_TOOL_TIMEOUT_MILLISECONDS},
        );
        expect(repeated.structuredContent).toMatchObject({
          reason: 'no-ready-snapshot',
          state: 'unavailable',
          version: 1,
        });
        await rm(graphLock, {force: true});
      },
      {toolset: 'core'},
    );
  }, 20_000);

  it('serves ready stale graphs and rejects cited replacements with typed recovery before mutation', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const repository = join(fixture.root, 'stale-ready-repository');
        await mkdir(join(repository, 'src'), {recursive: true});
        await writeFile(join(repository, 'package.json'), '{"name":"stale-ready-repository"}\n', 'utf8');
        await writeFile(
          join(repository, 'src', 'index.ts'),
          'export function indexedBeforePull(): string { return "before"; }\n',
          'utf8',
        );
        execFileSync('git', ['init', '-q'], {cwd: repository});
        execFileSync('git', ['config', 'user.email', 'threadnote@example.test'], {cwd: repository});
        execFileSync('git', ['config', 'user.name', 'Threadnote Test'], {cwd: repository});
        execFileSync('git', ['add', '.'], {cwd: repository});
        execFileSync('git', ['commit', '-qm', 'indexed commit'], {cwd: repository});
        const indexedCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: repository,
          encoding: 'utf8',
        }).trim();

        indexCodeGraph(fixture, repository);
        const first = await callCodeGraphUntilReady(client, {
          callerCwd: repository,
          operation: 'query',
          query: 'indexedBeforePull',
        });
        const firstSnapshotId = (first.structuredContent as {readonly snapshot?: {readonly id?: unknown}} | undefined)
          ?.snapshot?.id;
        expect(typeof firstSnapshotId).toBe('string');
        const citationTopic = 'deferred-citation-retry';
        const citationUri = `threadnote://user/test-user/memories/durable/projects/threadnote/${citationTopic}.md`;
        const citationPath = join(
          fixture.home,
          'data',
          'local',
          'user',
          'test-user',
          'memories',
          'durable',
          'projects',
          'threadnote',
          `${citationTopic}.md`,
        );
        const pendingRoot = join(
          fixture.home,
          'data',
          'local',
          'user',
          'test-user',
          'private',
          'deferred-code-anchors',
          'v1',
        );
        await callText(client, 'remember_context', {
          callerCwd: repository,
          kind: 'durable',
          project: 'threadnote',
          text: 'Original memory that must survive a rejected cited replacement.',
          topic: citationTopic,
        });
        const citationBefore = await readFile(citationPath, 'utf8');

        const gitCommonDirectory = await realpath(
          execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
            cwd: repository,
            encoding: 'utf8',
          }).trim(),
        );
        const checkoutId = createHash('sha256').update(`checkout-v1\n${gitCommonDirectory}`).digest('hex');
        const worktreeId = createHash('sha256')
          .update(`worktree-v1\n${await realpath(repository)}`)
          .digest('hex');
        const graphLock = join(
          fixture.home,
          'locks',
          'indexes',
          'code-graph',
          'worktrees',
          checkoutId,
          `${worktreeId}.lock`,
        );
        await mkdir(join(graphLock, '..'), {recursive: true});
        await writeFile(graphLock, `${process.pid}:stale-ready-test\n`, {encoding: 'utf8', mode: 0o600});

        try {
          await writeFile(
            join(repository, 'src', 'after-pull.ts'),
            'export function addedAfterPull(): string { return "after"; }\n',
            'utf8',
          );
          await Promise.all(
            Array.from({length: 7}, (_, index) =>
              writeFile(
                join(repository, 'src', `context-brief-recovery-${index}.ts`),
                `export function recoveryContextBrief${index}(): string { return "recovery-${index}"; }\n`,
                'utf8',
              ),
            ),
          );

          const dirtyStale = await client.callTool(
            {
              arguments: {
                callerCwd: repository,
                operation: 'query',
                query: 'indexedBeforePull',
                responseFormat: 'dual',
              },
              name: 'inspect_code_graph',
            },
            undefined,
            {timeout: 5_000},
          );
          expect(dirtyStale.isError).not.toBe(true);
          expect(dirtyStale.structuredContent).toMatchObject({
            freshness: 'deferred',
            nodes: expect.arrayContaining([expect.objectContaining({name: 'indexedBeforePull'})]),
            operation: 'query',
            snapshot: {commit: indexedCommit, id: firstSnapshotId},
          });
          expect((dirtyStale.structuredContent as {readonly state?: unknown} | undefined)?.state).toBeUndefined();

          const rejectedCitation = await client.callTool(
            {
              arguments: {
                callerCwd: repository,
                citationPolicy: 'require-current',
                codeRefs: ['src/index.ts'],
                kind: 'durable',
                project: 'threadnote',
                replaceUri: citationUri,
                text: 'This replacement must remain unapplied until exact-current graph evidence exists.',
                topic: citationTopic,
              },
              name: 'remember_context',
            },
            undefined,
            {timeout: 5_000},
          );
          expect(rejectedCitation.isError).toBe(true);
          expect(rejectedCitation.structuredContent).toMatchObject({
            code: 'exact-current-evidence-unavailable',
            graph: {readySnapshot: 'available', stale: true},
            indexingStarted: false,
            operation: 'remember_context',
            recovery: {
              action: 'index-current-graph',
              arguments: [],
              command: 'threadnote graph index --no-vectors',
              retry: 'same-request',
              runFrom: 'callerCwd',
              target: 'callerCwd',
            },
            retryCondition: 'after-current-graph-ready',
            retryable: true,
            state: 'blocked',
            type: 'memory-code-citation-write-recovery',
            version: 1,
            writeApplied: false,
          });
          expect(JSON.stringify(rejectedCitation.content)).toContain('No memory was written');
          expect(JSON.stringify(rejectedCitation.content)).toContain('threadnote graph index --no-vectors');
          expect(JSON.stringify(rejectedCitation)).not.toContain(repository);
          await expect(readFile(citationPath, 'utf8')).resolves.toBe(citationBefore);

          const deferredCitation = await client.callTool(
            {
              arguments: {
                callerCwd: repository,
                codeRefs: ['src/index.ts'],
                kind: 'durable',
                project: 'threadnote',
                replaceUri: citationUri,
                text: 'Deferred memory stored while the exact-current graph is unavailable.',
                topic: citationTopic,
              },
              name: 'remember_context',
            },
            undefined,
            {timeout: 5_000},
          );
          expect(deferredCitation.isError).not.toBe(true);
          expect(deferredCitation.structuredContent).toMatchObject({
            citationsFinalized: false,
            citationPolicy: 'defer',
            graph: {readySnapshot: 'available', stale: true},
            memoryStored: true,
            memoryUri: citationUri,
            pendingCodeRefs: 1,
            recovery: {
              action: 'index-current-graph',
              automaticRetry: ['after-graph-index', 'next-code-linked-context-brief'],
              command: 'threadnote graph index --no-vectors',
              cliCommand: 'threadnote finalize-code-refs',
              retry: 'replace-stored-memory',
            },
            type: 'memory-code-citation-write-receipt',
            version: 1,
          });
          expect(deferredCitation.content).not.toEqual(
            expect.arrayContaining([
              expect.objectContaining({text: expect.stringContaining('Cleared 1 prior code citation(s)')}),
            ]),
          );
          const deferredCitationContent = JSON.stringify(deferredCitation.content);
          expect(deferredCitationContent).toContain(
            'Threadnote retries automatically during graph indexing and the next code-linked Context Brief',
          );
          expect(deferredCitationContent).toContain('run threadnote finalize-code-refs');
          expect(JSON.stringify(deferredCitation)).toContain(String.raw`replaceUri: \"${citationUri}\"`);
          expect(JSON.stringify(deferredCitation)).not.toContain('retry the same remember request unchanged');
          expect(JSON.stringify(deferredCitation)).not.toContain(repository);
          const deferredMemory = parseMemoryDocument(citationUri, await readFile(citationPath, 'utf8'));
          expect(deferredMemory?.body).toBe('Deferred memory stored while the exact-current graph is unavailable.');
          expect(deferredMemory?.metadata.codeCitations).toBeUndefined();
          const pendingNames = await listDeferredCodeAnchorIntentRelativePaths(pendingRoot);
          expect(pendingNames).toHaveLength(1);
          expect(await readFile(join(pendingRoot, pendingNames[0]), 'utf8')).toContain('src/index.ts');
          const privateOutboxRecall = await client.callTool(
            {
              arguments: {
                callerCwd: repository,
                project: 'threadnote',
                query: 'src/index.ts',
                responseFormat: 'dual',
              },
              name: 'recall_context',
            },
            undefined,
            {timeout: 5_000},
          );
          const privateOutboxRecallUris = (
            privateOutboxRecall.structuredContent as
              {readonly results?: readonly {readonly uri?: unknown}[]} | undefined
          )?.results?.map(result => result.uri);
          expect(privateOutboxRecallUris).not.toContain(citationUri);

          const cancellationTopic = 'deferred-anchor-cancellation';
          const cancellationUri = `threadnote://user/test-user/memories/durable/projects/threadnote/${cancellationTopic}.md`;
          await callText(client, 'remember_context', {
            kind: 'durable',
            project: 'threadnote',
            text: 'Initial cancellation fixture.',
            topic: cancellationTopic,
          });
          await callText(client, 'remember_context', {
            callerCwd: repository,
            citationPolicy: 'defer',
            codeRefs: ['src/index.ts'],
            kind: 'durable',
            project: 'threadnote',
            replaceUri: cancellationUri,
            text: 'Pending cancellation fixture.',
            topic: cancellationTopic,
          });
          expect(await listDeferredCodeAnchorIntentRelativePaths(pendingRoot)).toHaveLength(2);
          await callText(client, 'remember_context', {
            kind: 'durable',
            project: 'threadnote',
            replaceUri: cancellationUri,
            text: 'Explicit uncited replacement cancels pending anchors.',
            topic: cancellationTopic,
          });
          expect(await listDeferredCodeAnchorIntentRelativePaths(pendingRoot)).toHaveLength(1);

          const archiveTopic = 'deferred-anchor-archive';
          const archiveUri = `threadnote://user/test-user/memories/durable/projects/threadnote/${archiveTopic}.md`;
          await callText(client, 'remember_context', {
            callerCwd: repository,
            citationPolicy: 'defer',
            codeRefs: ['src/index.ts'],
            kind: 'durable',
            project: 'threadnote',
            text: 'Pending anchor that will be archived.',
            topic: archiveTopic,
          });
          expect(await listDeferredCodeAnchorIntentRelativePaths(pendingRoot)).toHaveLength(2);
          await callText(client, 'archive_context', {uri: archiveUri});
          expect(await listDeferredCodeAnchorIntentRelativePaths(pendingRoot)).toHaveLength(1);

          const forgetTopic = 'deferred-anchor-forget';
          const forgetUri = `threadnote://user/test-user/memories/durable/projects/threadnote/${forgetTopic}.md`;
          await callText(client, 'remember_context', {
            callerCwd: repository,
            citationPolicy: 'defer',
            codeRefs: ['src/index.ts'],
            kind: 'durable',
            project: 'threadnote',
            text: 'Pending anchor that will be forgotten.',
            topic: forgetTopic,
          });
          expect(await listDeferredCodeAnchorIntentRelativePaths(pendingRoot)).toHaveLength(2);
          await callText(client, 'forget', {uri: forgetUri});
          expect(await listDeferredCodeAnchorIntentRelativePaths(pendingRoot)).toHaveLength(1);

          execFileSync('git', ['add', '.'], {cwd: repository});
          execFileSync('git', ['commit', '-qm', 'clean pulled commit'], {cwd: repository});

          const stale = await client.callTool(
            {
              arguments: {
                callerCwd: repository,
                operation: 'query',
                query: 'indexedBeforePull',
                responseFormat: 'dual',
              },
              name: 'inspect_code_graph',
            },
            undefined,
            {timeout: 5_000},
          );
          expect(stale.isError).not.toBe(true);
          expect(stale.structuredContent).toMatchObject({
            freshness: 'stale',
            nodes: expect.arrayContaining([expect.objectContaining({name: 'indexedBeforePull'})]),
            operation: 'query',
            snapshot: {commit: indexedCommit, id: firstSnapshotId},
          });
          expect((stale.structuredContent as {readonly state?: unknown} | undefined)?.state).toBeUndefined();
          const repeatedStale = await client.callTool(
            {
              arguments: {
                callerCwd: repository,
                operation: 'query',
                query: 'indexedBeforePull',
                responseFormat: 'dual',
              },
              name: 'inspect_code_graph',
            },
            undefined,
            {timeout: 5_000},
          );
          expect(repeatedStale.isError).not.toBe(true);
          expect(repeatedStale.structuredContent).toMatchObject({
            freshness: 'stale',
            nodes: expect.arrayContaining([expect.objectContaining({name: 'indexedBeforePull'})]),
            operation: 'query',
            snapshot: {commit: indexedCommit, id: firstSnapshotId},
          });
          expect((repeatedStale.structuredContent as {readonly state?: unknown} | undefined)?.state).toBeUndefined();
        } finally {
          await rm(graphLock, {force: true});
        }

        indexCodeGraph(fixture, repository);
        await callCodeGraphUntilReady(client, {
          callerCwd: repository,
          operation: 'query',
          query: 'addedAfterPull',
        });
        expect(await listDeferredCodeAnchorIntentRelativePaths(pendingRoot)).toEqual([]);
        const finalizedMemory = parseMemoryDocument(citationUri, await readFile(citationPath, 'utf8'));
        expect(finalizedMemory?.body).toBe('Deferred memory stored while the exact-current graph is unavailable.');
        expect(finalizedMemory?.metadata.codeCitations).toMatchObject([{path: 'src/index.ts'}]);
        const finalizedCitation = finalizedMemory?.metadata.codeCitations?.[0];
        if (!finalizedCitation)
          throw TestError.make({message: 'Automatic finalization did not attach the expected citation.'});
        const automaticBacklink = await client.callTool(
          {
            arguments: {
              callerCwd: repository,
              codeRefs: ['src/index.ts'],
              project: 'threadnote',
              responseFormat: 'dual',
              task: 'Recover the automatically finalized deferred memory backlink.',
            },
            name: 'context_brief',
          },
          undefined,
          {timeout: 10_000},
        );
        expect(automaticBacklink.isError).not.toBe(true);
        const automaticBrief = parseContextBriefV1(automaticBacklink.structuredContent);
        const automaticMemoryMatches = automaticBrief.durableDecisions.filter(memory =>
          memory.codeRelations?.some(relation => relation.citationId === finalizedCitation.id),
        );
        expect(automaticMemoryMatches).toHaveLength(1);
        expect(automaticMemoryMatches[0]).toMatchObject({
          codeRelations: [
            {
              anchorOrdinal: 0,
              citationId: finalizedCitation.id,
              kind: 'file',
              status: 'exact',
            },
          ],
          selectionBasis: 'code-citation',
          uri: expect.stringMatching(/^threadnote:\/\/memory\/tn_[a-z0-9_-]+$/u),
        });
        const recoveryCodeRefs = [
          'src/index.ts',
          ...Array.from({length: 7}, (_, index) => `src/context-brief-recovery-${index}.ts`),
        ];
        const boundedRecovery = await client.callTool(
          {
            arguments: {
              budgetTokens: 1_500,
              callerCwd: repository,
              codeRefs: recoveryCodeRefs,
              mode: 'locate',
              project: 'threadnote',
              responseFormat: 'dual',
              task: 'Locate every recoveryContextBrief implementation and its attached memory contract.',
            },
            name: 'context_brief',
          },
          undefined,
          {timeout: 10_000},
        );
        expect(boundedRecovery.isError, JSON.stringify(boundedRecovery)).not.toBe(true);
        const boundedRecoveryBrief = parseContextBriefV1(boundedRecovery.structuredContent);
        expect(boundedRecoveryBrief.version).toBe(3);
        expect(boundedRecoveryBrief.coverage.memory.codeAnchors).toMatchObject({
          complete: true,
          requested: 8,
          resolved: 8,
        });
        expect(boundedRecoveryBrief.output.truncated).toBe(true);
        expect(boundedRecoveryBrief.coverage.omissions.graphCards).toBeGreaterThan(0);
        expect(boundedRecoveryBrief.graph.continuation?.state).toBe('rerun-required');
        const structuredRecovery = boundedRecoveryBrief.recommendedFollowUps[0];
        const canProjectCallerCwd = Buffer.byteLength(repository) <= 128;
        expect(structuredRecovery).toMatchObject(
          canProjectCallerCwd
            ? {operation: 'inspect-node', rank: 0, ref: expect.stringMatching(/^cgs_/u)}
            : {
                operation: 'read-memory',
                rank: 0,
                uri: expect.stringMatching(/^threadnote:\/\/(?:memory\/tn_|user\/)/u),
              },
        );
        const boundedRecoveryText = (
          (Array.isArray(boundedRecovery.content) ? boundedRecovery.content[0] : undefined) as TextContent | undefined
        )?.text;
        const contentRecovery = parseContextBriefJsonText(boundedRecoveryText ?? '');
        expect(contentRecovery.recommendedFollowUps?.[0]).toEqual(structuredRecovery);
        expect(contentRecovery.graph?.continuation).toEqual(boundedRecoveryBrief.graph.continuation);
        expect(
          Buffer.byteLength(JSON.stringify(boundedRecovery.structuredContent)) +
            Buffer.byteLength(boundedRecoveryText ?? ''),
        ).toBeLessThanOrEqual(1_500 * 3);
        const compactFloor = await client.callTool(
          {
            arguments: {
              budgetTokens: 800,
              callerCwd: repository,
              codeRefs: recoveryCodeRefs,
              mode: 'locate',
              project: 'threadnote',
              responseFormat: 'agent',
              task: 'Locate every recoveryContextBrief implementation and its attached memory contract.',
            },
            name: 'context_brief',
          },
          undefined,
          {timeout: 10_000},
        );
        expect(compactFloor.isError, JSON.stringify(compactFloor)).not.toBe(true);
        expect(compactFloor.structuredContent).toBeUndefined();
        const compactFloorText = (
          (Array.isArray(compactFloor.content) ? compactFloor.content[0] : undefined) as TextContent | undefined
        )?.text;
        expect(compactFloorText).not.toContain('threadnote://user/test-user/');
        const compactFloorCards = contextBriefAgentTextCards(compactFloorText ?? '');
        const compactFloorCard = compactFloorCards[0];
        expect(compactFloorText).toContain('\nAnswer: ');
        expect(compactFloorCard?.ref).toMatch(/^cgs_/u);
        if (canProjectCallerCwd) {
          expect(compactFloorText).toContain('\nNext\n- inspect_code_graph/inspect-node — ');
          expect(compactFloorText).toContain(`nodeId=${compactFloorCard?.ref}`);
        } else {
          expect(compactFloorText).toMatch(
            /\nNext\n- read_context\/read-memory — .*uri=threadnote:\/\/(?:memory\/tn_|user\/)/u,
          );
        }
        expect(Buffer.byteLength(compactFloorText ?? '')).toBeLessThanOrEqual(800 * 3);
        const evaluationFloor = await client.callTool(
          {
            arguments: {
              budgetTokens: 800,
              callerCwd: repository,
              mode: 'locate',
              project: 'threadnote',
              responseFormat: 'agent',
              task: 'Locate the recoveryContextBrief MCP agent response projection and its budget enforcement.',
            },
            name: 'context_brief',
          },
          undefined,
          {timeout: 10_000},
        );
        expect(evaluationFloor.isError, JSON.stringify(evaluationFloor)).not.toBe(true);
        expect(evaluationFloor.structuredContent).toBeUndefined();
        const evaluationFloorText = (
          (Array.isArray(evaluationFloor.content) ? evaluationFloor.content[0] : undefined) as TextContent | undefined
        )?.text;
        const evaluationFloorCards = contextBriefAgentTextCards(evaluationFloorText ?? '');
        const evaluationFloorAnswer = contextBriefAgentTextAnswer(evaluationFloorText ?? '');
        expect(evaluationFloorAnswer).toMatch(/locations(?: \([^)]+ graph\))?: /iu);
        expect(evaluationFloorCards).toHaveLength(2);
        expect(evaluationFloorAnswer).toContain(evaluationFloorCards[0]?.path);
        expect(evaluationFloorAnswer).toContain(evaluationFloorCards[1]?.path);
        if (canProjectCallerCwd) {
          expect(evaluationFloorText).toContain('\nNext\n- inspect_code_graph/inspect-node — ');
          expect(evaluationFloorText).toContain(`nodeId=${evaluationFloorCards[0]?.ref}`);
        } else {
          expect(evaluationFloorText).not.toContain('\nNext\n');
        }
        expect(evaluationFloorText).not.toMatch(/^- cgs_[a-f0-9]{32} → /mu);
        expect(Buffer.byteLength(evaluationFloorText ?? '')).toBeLessThanOrEqual(800 * 3);
        const idempotent = await client.callTool(
          {arguments: {uri: citationUri}, name: 'finalize_code_refs'},
          undefined,
          {timeout: 5_000},
        );
        expect(idempotent.structuredContent).toMatchObject({
          conflictCount: 0,
          failedCount: 0,
          finalizedCount: 0,
          pendingCount: 0,
          scannedCount: 0,
        });
        expect(idempotent.structuredContent).not.toHaveProperty('derivedIndexes');
      },
      {toolset: 'full'},
    );
  }, 40_000);

  it('serves a divergent-HEAD new worktree from stale shared evidence while its builder is blocked', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const repository = join(fixture.root, 'divergent-worktree-repository');
        await mkdir(join(repository, 'src'), {recursive: true});
        await writeFile(join(repository, 'package.json'), '{"name":"divergent-worktree-repository"}\n', 'utf8');
        await writeFile(
          join(repository, 'src', 'index.ts'),
          'export function sharedBeforeDivergence(): string { return "shared"; }\n',
          'utf8',
        );
        execFileSync('git', ['init', '-q'], {cwd: repository});
        execFileSync('git', ['config', 'user.email', 'threadnote@example.test'], {cwd: repository});
        execFileSync('git', ['config', 'user.name', 'Threadnote Test'], {cwd: repository});
        execFileSync('git', ['add', '.'], {cwd: repository});
        execFileSync('git', ['commit', '-qm', 'shared graph base'], {cwd: repository});
        indexCodeGraph(fixture, repository);

        const first = await callCodeGraphUntilReady(client, {
          callerCwd: repository,
          operation: 'query',
          query: 'sharedBeforeDivergence',
        });
        const firstSnapshot = (
          first.structuredContent as
            {readonly snapshot?: {readonly commit?: unknown; readonly id?: unknown}} | undefined
        )?.snapshot;
        expect(typeof firstSnapshot?.id).toBe('string');
        expect(typeof firstSnapshot?.commit).toBe('string');

        const branch = 'divergent-linked';
        const worktree = join(fixture.root, 'divergent-linked-worktree');
        execFileSync('git', ['branch', branch], {cwd: repository});
        execFileSync('git', ['worktree', 'add', worktree, branch], {cwd: repository});
        await writeFile(
          join(worktree, 'src', 'divergent.ts'),
          'export function divergentHeadOnly(): string { return "divergent"; }\n',
          'utf8',
        );
        execFileSync('git', ['add', '.'], {cwd: worktree});
        execFileSync('git', ['commit', '-qm', 'divergent graph head'], {cwd: worktree});

        const gitCommonDirectory = await realpath(
          execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
            cwd: worktree,
            encoding: 'utf8',
          }).trim(),
        );
        const checkoutId = createHash('sha256').update(`checkout-v1\n${gitCommonDirectory}`).digest('hex');
        const worktreeId = createHash('sha256')
          .update(`worktree-v1\n${await realpath(worktree)}`)
          .digest('hex');
        const graphLock = join(
          fixture.home,
          'locks',
          'indexes',
          'code-graph',
          'worktrees',
          checkoutId,
          `${worktreeId}.lock`,
        );
        await mkdir(join(graphLock, '..'), {recursive: true});
        await writeFile(graphLock, `${process.pid}:divergent-worktree-test\n`, {encoding: 'utf8', mode: 0o600});

        try {
          const startedAt = Date.now();
          const borrowed = await client.callTool(
            {
              arguments: {
                callerCwd: worktree,
                operation: 'query',
                query: 'sharedBeforeDivergence',
                responseFormat: 'dual',
              },
              name: 'inspect_code_graph',
            },
            undefined,
            {timeout: 5_000},
          );
          expect(Date.now() - startedAt).toBeLessThan(5_000);
          expect(borrowed.isError).not.toBe(true);
          expect(borrowed.structuredContent).toMatchObject({
            freshness: 'stale',
            nodes: expect.arrayContaining([expect.objectContaining({name: 'sharedBeforeDivergence'})]),
            operation: 'query',
            snapshot: {commit: firstSnapshot?.commit, id: firstSnapshot?.id},
          });
          expect((borrowed.structuredContent as {readonly state?: unknown} | undefined)?.state).toBeUndefined();
          expect(JSON.stringify(borrowed.structuredContent)).not.toContain('divergentHeadOnly');
        } finally {
          await rm(graphLock, {force: true});
        }
      },
      {environment: {THREADNOTE_CODE_GRAPH_PREWARM: '0'}, toolset: 'core'},
    );
  }, 40_000);

  it('keeps graphs immediately available across new TypeScript, Python, and Rust worktrees and edits', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const repositories = [
          {
            after: 'typescriptAfterEdit',
            before: 'typescriptBeforeEdit',
            files: {
              'package.json': '{"name":"typescript-readiness"}\n',
              'src/index.ts': 'export function typescriptBeforeEdit(): string { return "before"; }\n',
            },
            name: 'typescript',
            sourcePath: 'src/index.ts',
          },
          {
            after: 'python_after_edit',
            before: 'python_before_edit',
            files: {
              'pyproject.toml': '[project]\nname = "python-readiness"\nversion = "0.0.0"\n',
              'src/readiness.py': 'def python_before_edit():\n    return "before"\n',
            },
            name: 'python',
            sourcePath: 'src/readiness.py',
          },
          {
            after: 'rust_after_edit',
            before: 'rust_before_edit',
            files: {
              'Cargo.toml': '[package]\nname = "rust-readiness"\nversion = "0.0.0"\nedition = "2021"\n',
              'src/lib.rs': 'pub fn rust_before_edit() -> &\'static str { "before" }\n',
            },
            name: 'rust',
            sourcePath: 'src/lib.rs',
          },
        ] as const;

        for (const repositoryFixture of repositories) {
          const repository = join(fixture.root, `${repositoryFixture.name}-repository`);
          for (const [relativePath, content] of Object.entries(repositoryFixture.files)) {
            const path = join(repository, relativePath);
            await mkdir(join(path, '..'), {recursive: true});
            await writeFile(path, content, 'utf8');
          }
          execFileSync('git', ['init', '-q'], {cwd: repository});
          execFileSync('git', ['config', 'user.email', 'threadnote@example.test'], {cwd: repository});
          execFileSync('git', ['config', 'user.name', 'Threadnote Test'], {cwd: repository});
          execFileSync('git', ['add', '.'], {cwd: repository});
          execFileSync('git', ['commit', '-qm', 'fixture'], {cwd: repository});
          indexCodeGraph(fixture, repository);

          const first = await callCodeGraphUntilReady(client, {
            callerCwd: repository,
            operation: 'query',
            query: repositoryFixture.before,
          });
          const firstStructured = first.structuredContent as
            | {
                readonly freshness?: unknown;
                readonly nodes?: readonly {readonly name?: unknown}[];
                readonly snapshot?: {readonly id?: unknown; readonly worktreeId?: unknown};
              }
            | undefined;
          expect(firstStructured).toMatchObject({
            freshness: 'deferred',
            nodes: expect.arrayContaining([expect.objectContaining({name: repositoryFixture.before})]),
          });
          expect(typeof firstStructured?.snapshot?.id).toBe('string');

          const branch = `${repositoryFixture.name}-linked`;
          const worktree = join(fixture.root, `${repositoryFixture.name}-worktree`);
          execFileSync('git', ['branch', branch], {cwd: repository});
          execFileSync('git', ['worktree', 'add', worktree, branch], {cwd: repository});

          const attachedStartedAt = Date.now();
          const attached = await client.callTool(
            {
              arguments: {
                callerCwd: worktree,
                operation: 'query',
                query: repositoryFixture.before,
                responseFormat: 'dual',
              },
              name: 'inspect_code_graph',
            },
            undefined,
            {timeout: 10_000},
          );
          expect(Date.now() - attachedStartedAt).toBeLessThan(5_000);
          expect(attached.isError).not.toBe(true);
          expect(attached.structuredContent).toMatchObject({
            freshness: 'deferred',
            nodes: expect.arrayContaining([expect.objectContaining({name: repositoryFixture.before})]),
            snapshot: {id: firstStructured?.snapshot?.id},
          });
          expect((attached.structuredContent as {readonly state?: unknown} | undefined)?.state).toBeUndefined();

          const source = join(worktree, repositoryFixture.sourcePath);
          await writeFile(
            source,
            (await readFile(source, 'utf8')).replace(repositoryFixture.before, repositoryFixture.after),
            'utf8',
          );
          const editedStartedAt = Date.now();
          const edited = await client.callTool(
            {
              arguments: {
                callerCwd: worktree,
                operation: 'query',
                query: repositoryFixture.before,
                responseFormat: 'dual',
              },
              name: 'inspect_code_graph',
            },
            undefined,
            {timeout: 10_000},
          );
          const editedStructured = edited.structuredContent as
            {readonly freshness?: unknown; readonly state?: unknown} | undefined;
          expect(Date.now() - editedStartedAt).toBeLessThan(5_000);
          expect(edited.isError).not.toBe(true);
          expect(editedStructured?.state).toBeUndefined();
          expect(editedStructured?.freshness).toBe('deferred');

          const refresh = await callCodeGraphUntilReady(client, {
            base: 'HEAD',
            callerCwd: worktree,
            operation: 'impact',
          });
          expect(refresh.structuredContent).toMatchObject({freshness: 'current', operation: 'impact'});

          const refreshed = await callCodeGraphUntilReady(client, {
            callerCwd: worktree,
            operation: 'query',
            query: repositoryFixture.after,
          });
          expect(refreshed.structuredContent).toMatchObject({
            freshness: 'deferred',
            nodes: expect.arrayContaining([expect.objectContaining({name: repositoryFixture.after})]),
          });
          expect(
            (refreshed.structuredContent as {readonly snapshot?: {readonly id?: unknown}} | undefined)?.snapshot?.id,
          ).not.toBe(firstStructured?.snapshot?.id);
        }
      },
      {environment: {THREADNOTE_CODE_GRAPH_PREWARM: '0'}, toolset: 'core'},
    );
  }, 120_000);

  it('keeps ordinary watched reads deferred until an explicit current inspection', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const repository = join(fixture.root, 'watched-repository');
        await mkdir(join(repository, 'src'), {recursive: true});
        await writeFile(join(repository, 'package.json'), '{"name":"watched-repository"}\n', 'utf8');
        await writeFile(
          join(repository, 'src', 'index.ts'),
          'export function beforeSessionWatch(): string { return "before"; }\n',
          'utf8',
        );
        execFileSync('git', ['init', '-q'], {cwd: repository});
        execFileSync('git', ['config', 'user.email', 'threadnote@example.test'], {cwd: repository});
        execFileSync('git', ['config', 'user.name', 'Threadnote Test'], {cwd: repository});
        execFileSync('git', ['add', '.'], {cwd: repository});
        execFileSync('git', ['commit', '-qm', 'fixture'], {cwd: repository});
        indexCodeGraph(fixture, repository);

        const first = await callCodeGraphUntilReady(client, {
          callerCwd: repository,
          operation: 'query',
          query: 'beforeSessionWatch',
        });
        expect(first.structuredContent).toMatchObject({
          nodes: expect.arrayContaining([expect.objectContaining({name: 'beforeSessionWatch'})]),
        });
        expect(['current', 'deferred']).toContain(
          (first.structuredContent as {readonly freshness?: unknown} | undefined)?.freshness,
        );
        const firstSnapshotId = (first.structuredContent as {readonly snapshot?: {readonly id?: unknown}} | undefined)
          ?.snapshot?.id;
        expect(typeof firstSnapshotId).toBe('string');
        const hot = await client.callTool(
          {
            arguments: {
              callerCwd: repository,
              operation: 'query',
              query: 'beforeSessionWatch',
              responseFormat: 'dual',
            },
            name: 'inspect_code_graph',
          },
          undefined,
          {timeout: 5_000},
        );
        expect(hot.structuredContent).toMatchObject({freshness: 'deferred', snapshot: {id: firstSnapshotId}});

        await writeFile(
          join(repository, 'src', 'index.ts'),
          'export function afterSessionWatch(): string { return "after"; }\n',
          'utf8',
        );
        await new Promise(resolve => setTimeout(resolve, 500));
        const deferred = await client.callTool(
          {
            arguments: {
              callerCwd: repository,
              operation: 'query',
              query: 'afterSessionWatch',
              responseFormat: 'dual',
            },
            name: 'inspect_code_graph',
          },
          undefined,
          {timeout: 5_000},
        );
        expect(deferred.structuredContent).toMatchObject({
          freshness: 'deferred',
          snapshot: {id: firstSnapshotId},
        });

        const refresh = await callCodeGraphUntilReady(client, {
          base: 'HEAD',
          callerCwd: repository,
          operation: 'impact',
        });
        expect(refresh.structuredContent).toMatchObject({freshness: 'current', operation: 'impact'});

        const refreshed = await callCodeGraphUntilReady(client, {
          callerCwd: repository,
          operation: 'query',
          query: 'afterSessionWatch',
        });
        expect(refreshed.structuredContent).toMatchObject({
          freshness: 'deferred',
          nodes: expect.arrayContaining([expect.objectContaining({name: 'afterSessionWatch'})]),
        });
        expect(
          (refreshed.structuredContent as {readonly snapshot?: {readonly id?: unknown}} | undefined)?.snapshot?.id,
        ).not.toBe(firstSnapshotId);

        const removed = await client.callTool(
          {
            arguments: {
              callerCwd: repository,
              operation: 'query',
              query: 'beforeSessionWatch',
              responseFormat: 'dual',
            },
            name: 'inspect_code_graph',
          },
          undefined,
          {timeout: 5_000},
        );
        const removedNodes = (
          removed.structuredContent as {readonly nodes?: readonly {readonly name?: unknown}[]} | undefined
        )?.nodes;
        expect(removedNodes?.some(node => node.name === 'beforeSessionWatch')).toBe(false);
      },
      {toolset: 'core'},
    );
  }, 60_000);

  it('reviews task-closeout candidates and records a deferred decision without writing memory', async () => {
    await withMcpClient(
      async client => {
        const review = await callText(client, 'review_session_context', {
          decisions: ['Keep candidate review inside the agent session.'],
          evidence: ['docs/recall-and-memory-formation-plan.md'],
          outcome: 'Added task-closeout candidate review.',
          project: 'threadnote',
          sourceAgentClient: 'codex',
          sourceSessionId: 'session-test',
          task: 'Implement candidate memory workflow',
          topic: 'candidate-memory',
        });
        const reviewId = /Review (review-[a-f0-9]+)/.exec(review)?.[1];
        const candidateId = /candidate: (review-[a-f0-9]+-1)/.exec(review)?.[1];
        expect(review).toContain('Do not write these additional candidates until the user decides');
        expect(reviewId).toBeDefined();
        expect(candidateId).toBeDefined();

        const deferred = await callText(client, 'apply_memory_candidates', {
          action: 'defer',
          candidateId,
          reviewId,
          revision: 1,
        });

        expect(deferred).toContain(`Deferred candidate ${candidateId}`);
      },
      {toolset: 'core'},
    );
  });

  it('includes the current bounded KnowledgeDeltaV1 in review and decision results', async () => {
    await withMcpClient(
      async client => {
        const review = await client.callTool(
          {
            arguments: {
              decisions: ['Keep the review projection compatible with candidate application.'],
              rationale: 'Capture why the reviewed projection is safe.',
              constraints: ['Keep writes private until explicit approval.'],
              verificationPerformed: ['Focused MCP test passed.'],
              knowledgeInvalidated: ['The prior unstructured draft.'],
              unresolvedRisks: ['A later review may refine this contract.'],
              evidence: ['apps/threadnote/test/integration/mcp.native-tools.test.ts'],
              outcome: 'Projected the reviewed closeout.',
              project: 'threadnote',
              sourceAgentClient: 'codex',
              sourceSessionId: 'knowledge-delta-session',
              task: 'Project a knowledge delta',
              topic: 'knowledge-delta-projection',
            },
            name: 'review_session_context',
          },
          undefined,
          {timeout: 5_000},
        );
        expect(review.isError, JSON.stringify(review)).not.toBe(true);
        const reviewStructured = review.structuredContent as {
          readonly knowledgeDelta?: {
            readonly items?: readonly {readonly candidateId?: string; readonly type?: string}[];
            readonly reviewId?: string;
            readonly revision?: number;
            readonly type?: string;
            readonly version?: number;
          };
        };
        expect(reviewStructured.knowledgeDelta).toMatchObject({
          items: [expect.objectContaining({type: 'decision-or-invariant'})],
          structuredCloseout: {
            type: 'structured-closeout',
            version: 1,
            rationale: 'Capture why the reviewed projection is safe.',
            constraints: ['Keep writes private until explicit approval.'],
            verificationPerformed: ['Focused MCP test passed.'],
            knowledgeInvalidated: ['The prior unstructured draft.'],
            unresolvedRisks: ['A later review may refine this contract.'],
          },
          revision: 1,
          type: 'knowledge-delta',
          version: 1,
        });
        const delta = reviewStructured.knowledgeDelta;
        const candidateId = delta?.items?.[0]?.candidateId;
        expect(candidateId).toBeDefined();

        const deferred = await client.callTool(
          {
            arguments: {
              action: 'defer',
              candidateId,
              reviewId: delta?.reviewId,
              revision: delta?.revision,
            },
            name: 'apply_memory_candidates',
          },
          undefined,
          {timeout: 5_000},
        );
        expect(deferred.isError, JSON.stringify(deferred)).not.toBe(true);
        expect(deferred.structuredContent).toMatchObject({
          knowledgeDelta: {
            items: [expect.objectContaining({candidateId, state: 'deferred'})],
            structuredCloseout: expect.objectContaining({
              rationale: 'Capture why the reviewed projection is safe.',
            }),
            revision: 2,
            type: 'knowledge-delta',
            version: 1,
          },
        });
      },
      {toolset: 'core'},
    );
  });

  it('does not form durable candidates from empty structured closeout fields', async () => {
    await withMcpClient(
      async client => {
        const result = await client.callTool(
          {
            arguments: {
              constraints: [],
              evidence: ['apps/threadnote/test/integration/mcp.native-tools.test.ts'],
              knowledgeInvalidated: [],
              outcome: 'No durable closeout material was found.',
              project: 'threadnote',
              rationale: '   ',
              task: 'Ignore empty structured closeout fields',
              unresolvedRisks: [],
              verificationPerformed: ['  '],
            },
            name: 'review_session_context',
          },
          undefined,
          {timeout: 5_000},
        );
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        expect(result.content).toEqual([
          expect.objectContaining({text: expect.stringContaining('No additional memory candidates found')}),
        ]);
        expect(result.structuredContent).toMatchObject({candidates: [], noAction: true});
      },
      {toolset: 'core'},
    );
  });

  it('keeps structured durable fields disabled by the handoff-only candidate policy', async () => {
    await withMcpClient(
      async client => {
        const result = await client.callTool(
          {
            arguments: {
              constraints: ['Would otherwise form a durable candidate.'],
              evidence: ['apps/threadnote/test/integration/mcp.native-tools.test.ts'],
              handoff: ['Continue the scoped implementation.'],
              outcome: 'Preserved handoff-only closeout policy.',
              project: 'threadnote',
              rationale: 'Would otherwise form a durable candidate.',
              task: 'Respect handoff-only structured closeout policy',
              unresolvedRisks: ['Would otherwise form a durable candidate.'],
              verificationPerformed: ['Would otherwise form a durable candidate.'],
            },
            name: 'review_session_context',
          },
          undefined,
          {timeout: 5_000},
        );
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        const structured = result.structuredContent as {
          readonly candidates?: readonly {readonly kind?: string}[];
          readonly knowledgeDelta?: {readonly structuredCloseout?: unknown};
        };
        expect(structured.candidates).toEqual([expect.objectContaining({kind: 'handoff'})]);
        expect(structured.knowledgeDelta?.structuredCloseout).toBeUndefined();
      },
      {environment: {THREADNOTE_CANDIDATE_POLICY: 'handoff-only'}, toolset: 'core'},
    );
  });

  it('writes an approved candidate only with explicit approval and the current revision', async () => {
    await withMcpClient(
      async client => {
        const review = await callText(client, 'review_session_context', {
          decisions: ['Use a stable candidate review identifier.'],
          evidence: ['apps/threadnote/test/integration/mcp.native-tools.test.ts'],
          outcome: 'Implemented candidate audit records.',
          project: 'threadnote',
          sourceAgentClient: 'codex',
          task: 'Implement approved memory candidates',
          topic: 'approved-candidates',
        });
        const reviewId = /Review (review-[a-f0-9]+)/.exec(review)?.[1];
        const candidateId = /candidate: (review-[a-f0-9]+-1)/.exec(review)?.[1];

        await expect(
          callErrorText(client, 'apply_memory_candidates', {
            action: 'approve',
            candidateId,
            reviewId,
            revision: 1,
          }),
        ).resolves.toContain('approved=true');

        const editedText =
          '## Decisions\n- Use a stable candidate review identifier as canonical approved candidates guidance.';
        const appliedResult = await client.callTool(
          {
            arguments: {
              action: 'approve',
              approved: true,
              candidateId,
              editedText,
              reviewId,
              revision: 1,
            },
            name: 'apply_memory_candidates',
          },
          undefined,
          {timeout: 5_000},
        );
        const applied = (appliedResult.content as TextContent[]).map(item => item.text).join('\n');

        expect(appliedResult.isError, applied).not.toBe(true);
        expect(applied).toContain(
          'Stored memory: threadnote://user/test-user/memories/durable/projects/threadnote/approved-candidates.md',
        );
        expect(appliedResult.structuredContent).toMatchObject({
          knowledgeDelta: {
            items: [
              expect.objectContaining({
                candidateId,
                mutationPreview: expect.objectContaining({bodyText: editedText}),
              }),
            ],
          },
        });

        const approvedUri = 'memories/durable/projects/threadnote/approved-candidates.md';
        const unreviewedUri = 'memories/durable/projects/threadnote/approved-candidates-shadow.md';
        await callText(client, 'remember_context', {
          kind: 'durable',
          project: 'threadnote',
          sourceAgentClient: 'codex',
          status: 'active',
          text: 'Unreviewed speculation about approved candidates. '.repeat(8),
          topic: 'approved-candidates-shadow',
        });

        const approvedRecall = await client.callTool({
          arguments: {
            nodeLimit: 12,
            project: 'threadnote',
            query: 'canonical approved candidates guidance',
            responseFormat: 'dual',
            threshold: 0,
          },
          name: 'recall_context',
        });
        const approvedUris = (
          approvedRecall.structuredContent as {readonly results?: readonly {readonly uri?: unknown}[]} | undefined
        )?.results?.map(result => result.uri);
        expect(approvedUris).toContain(approvedUri);
        expect(approvedUris).not.toContain(unreviewedUri);

        const ordinaryRecall = await client.callTool({
          arguments: {
            nodeLimit: 12,
            project: 'threadnote',
            query: 'approved candidates',
            responseFormat: 'dual',
            threshold: 0,
          },
          name: 'recall_context',
        });
        const ordinaryUris = (
          ordinaryRecall.structuredContent as {readonly results?: readonly {readonly uri?: unknown}[]} | undefined
        )?.results?.map(result => result.uri);
        expect(ordinaryUris).toContain(unreviewedUri);
      },
      {toolset: 'core'},
    );
  });

  it('records an applying-state content mismatch as a recoverable conflict', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const topic = 'candidate-recovery-conflict';
        const reviewText = await callText(client, 'review_session_context', {
          decisions: ['Persist the exact approved candidate payload hash.'],
          evidence: ['apps/threadnote/test/integration/mcp.native-tools.test.ts'],
          outcome: 'Prepared deterministic applying-state recovery.',
          project: 'threadnote',
          sourceAgentClient: 'codex',
          task: 'Recover interrupted candidate approval',
          topic,
        });
        const reviewId = /Review (review-[a-f0-9]+)/.exec(reviewText)?.[1];
        const candidateId = /candidate: (review-[a-f0-9]+-1)/.exec(reviewText)?.[1];
        expect(reviewId).toBeDefined();
        expect(candidateId).toBeDefined();
        const reviewPath = join(fixture.home, 'threadnote', 'candidates', 'v1', 'reviews', `${reviewId}.json`);
        const review = JSON.parse(await readFile(reviewPath, 'utf8')) as {
          candidates: Array<Record<string, unknown>>;
        };
        const destinationUri = `threadnote://user/test-user/memories/durable/projects/threadnote/${topic}.md`;
        review.candidates[0] = {
          ...review.candidates[0],
          applyApprovedAt: '2026-07-23T10:00:00.000Z',
          applyContentHash: '0'.repeat(64),
          applyOperation: 'create',
          applyStage: 'prepared',
          applyTargetUri: destinationUri,
          state: 'applying',
        };
        await writeFile(reviewPath, `${JSON.stringify(review, undefined, 2)}\n`, 'utf8');
        const destinationPath = join(
          fixture.home,
          'data',
          'local',
          'user',
          'test-user',
          'memories',
          'durable',
          'projects',
          'threadnote',
          `${topic}.md`,
        );
        await mkdir(join(destinationPath, '..'), {recursive: true});
        await writeFile(
          destinationPath,
          [
            'MEMORY',
            'kind: durable',
            'status: active',
            'project: threadnote',
            `topic: ${topic}`,
            'source_agent_client: codex',
            `candidate_id: ${candidateId}`,
            'timestamp: 2026-07-23T10:00:00.000Z',
            '',
            'Different content than the approved payload.',
          ].join('\n'),
          'utf8',
        );

        await expect(
          callErrorText(client, 'apply_memory_candidates', {
            action: 'approve',
            approved: true,
            candidateId,
            reviewId,
            revision: 1,
          }),
        ).resolves.toContain('mismatched content');
        const conflicted = JSON.parse(await readFile(reviewPath, 'utf8')) as {
          candidates: Array<{state?: string}>;
        };
        expect(conflicted.candidates[0]?.state).toBe('conflict');
      },
      {toolset: 'core'},
    );
  });

  it('requires explicit destructive approval before legacy cross-URI cleanup', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const topic = 'candidate-recovery-destructive';
        const replacementUri =
          'threadnote://user/test-user/memories/handoffs/active/threadnote/legacy-recovery-source.md';
        const replacementPath = join(
          fixture.home,
          'data',
          'local',
          'user',
          'test-user',
          'memories',
          'handoffs',
          'active',
          'threadnote',
          'legacy-recovery-source.md',
        );
        const detailedBody = Array.from(
          {length: 12},
          (_unused, index) => `- Continuity detail ${index} remains required for release recovery.`,
        ).join('\n');
        await mkdir(join(replacementPath, '..'), {recursive: true});
        await writeFile(
          replacementPath,
          formatMemoryDocument(
            'HANDOFF',
            {
              kind: 'handoff',
              project: 'threadnote',
              sourceAgentClient: 'codex',
              status: 'active',
              timestamp: '2026-07-22T10:00:00.000Z',
              topic,
            },
            `## Current state\n${detailedBody}`,
          ),
          'utf8',
        );

        const reviewText = await callText(client, 'review_session_context', {
          evidence: ['apps/threadnote/test/integration/mcp.native-tools.test.ts'],
          handoff: ['Continue after the remaining release check.'],
          outcome: 'Prepared the next release recovery step.',
          project: 'threadnote',
          sourceAgentClient: 'codex',
          task: 'Recover an interrupted cross-URI replacement',
          topic,
        });
        const reviewId = /Review (review-[a-f0-9]+)/.exec(reviewText)?.[1];
        const candidateId = /candidate: (review-[a-f0-9]+-1)/.exec(reviewText)?.[1];
        expect(reviewId).toBeDefined();
        expect(candidateId).toBeDefined();
        const reviewPath = join(fixture.home, 'threadnote', 'candidates', 'v1', 'reviews', `${reviewId}.json`);
        const review = JSON.parse(await readFile(reviewPath, 'utf8')) as {
          candidates: Array<Record<string, unknown>>;
        };
        const candidate = review.candidates[0];
        if (!candidate) {
          throw TestError.make({message: 'Expected the replacement candidate review fixture.'});
        }
        expect(candidate).toMatchObject({targetUri: replacementUri});
        const destinationUri = `threadnote://user/test-user/memories/handoffs/active/threadnote/${topic}.md`;
        const destinationPath = join(
          fixture.home,
          'data',
          'local',
          'user',
          'test-user',
          'memories',
          'handoffs',
          'active',
          'threadnote',
          `${topic}.md`,
        );
        const approvedAt = '2026-07-23T10:00:00.000Z';
        const approvedBody = String(candidate?.proposedText ?? '');
        const destinationContent = formatMemoryDocument(
          'HANDOFF',
          {
            candidateId,
            kind: 'handoff',
            project: 'threadnote',
            sourceAgentClient: 'codex',
            status: 'active',
            timestamp: approvedAt,
            topic,
          },
          approvedBody,
        );
        await writeFile(destinationPath, destinationContent, 'utf8');
        review.candidates[0] = {
          ...candidate,
          applyApprovedAt: approvedAt,
          applyBodyText: approvedBody,
          applyContentHash: createHash('sha256')
            .update(canonicalMemoryDocumentContent(destinationContent))
            .digest('hex'),
          applyOperation: 'replace',
          applyReplaceUri: replacementUri,
          applyStage: 'written',
          applyTargetUri: destinationUri,
          state: 'applying',
        };
        await writeFile(reviewPath, `${JSON.stringify(review, undefined, 2)}\n`, 'utf8');

        await expect(
          callErrorText(client, 'apply_memory_candidates', {
            action: 'approve',
            approved: true,
            candidateId,
            reviewId,
            revision: 1,
          }),
        ).resolves.toContain('allowDestructiveReplacement=true');
        expect(existsSync(replacementPath)).toBe(true);
        expect(existsSync(destinationPath)).toBe(true);

        const recovered = await client.callTool(
          {
            arguments: {
              action: 'approve',
              allowDestructiveReplacement: true,
              approved: true,
              candidateId,
              reviewId,
              revision: 1,
            },
            name: 'apply_memory_candidates',
          },
          undefined,
          {timeout: 5_000},
        );
        expect(recovered.isError, JSON.stringify(recovered)).not.toBe(true);
        expect(existsSync(replacementPath)).toBe(false);
        expect(existsSync(destinationPath)).toBe(true);
        const audit = await readFile(join(fixture.home, 'threadnote', 'candidates', 'v1', 'audit.jsonl'), 'utf8');
        expect(audit).toContain('"allowDestructiveReplacement":true');
      },
      {toolset: 'core'},
    );
  });

  it('allows a reviewed shared-memory conflict to create a personal candidate', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const topic = 'shared-candidate-personal-copy';
        const sharedPath = join(
          fixture.home,
          'data',
          'local',
          'user',
          'test-user',
          'memories',
          'shared',
          'team',
          'durable',
          'projects',
          'threadnote',
          `${topic}.md`,
        );
        await mkdir(join(sharedPath, '..'), {recursive: true});
        await writeFile(
          sharedPath,
          [
            'MEMORY',
            'kind: durable',
            'status: active',
            'project: threadnote',
            `topic: ${topic}`,
            'source_agent_client: teammate',
            'timestamp: 2026-07-22T00:00:00.000Z',
            '',
            'Use the old shared candidate policy.',
          ].join('\n'),
          'utf8',
        );
        const review = await callText(client, 'review_session_context', {
          decisions: ['Use the new reviewed candidate policy.'],
          evidence: ['apps/threadnote/test/integration/mcp.native-tools.test.ts'],
          outcome: 'Reviewed a changed shared memory.',
          project: 'threadnote',
          sourceAgentClient: 'codex',
          task: 'Create a personal candidate from shared conflict',
          topic,
        });
        const reviewId = /Review (review-[a-f0-9]+)/.exec(review)?.[1];
        const candidateId = /candidate: (review-[a-f0-9]+-1)/.exec(review)?.[1];
        expect(review).toContain('[replace]');
        expect(review).toContain('/memories/shared/team/');

        const applied = await callText(client, 'apply_memory_candidates', {
          action: 'approve',
          approved: true,
          candidateId,
          operation: 'create',
          reviewId,
          revision: 1,
        });

        expect(applied).toContain(
          `Stored memory: threadnote://user/test-user/memories/durable/projects/threadnote/${topic}.md`,
        );
      },
      {toolset: 'core'},
    );
  });

  it('requires evidence before proposing durable candidates', async () => {
    await withMcpClient(
      async client => {
        await expect(
          callErrorText(client, 'review_session_context', {
            decisions: ['This unsupported claim must not become durable memory.'],
            outcome: 'Attempted an unsupported closeout.',
            project: 'threadnote',
            sourceAgentClient: 'codex',
            task: 'Check evidence enforcement',
            topic: 'evidence-enforcement',
          }),
        ).resolves.toContain('requires at least one evidence pointer');
      },
      {toolset: 'core'},
    );
  });

  it('preserves v4 citations and rejects malformed or future schemas through archive_context', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const activeDirectory = join(
          fixture.home,
          'data',
          'local',
          'user',
          'test-user',
          'memories',
          'handoffs',
          'active',
          'threadnote',
        );
        const archivedDirectory = join(
          fixture.home,
          'data',
          'local',
          'user',
          'test-user',
          'memories',
          'handoffs',
          'archived',
          'threadnote',
        );
        await mkdir(activeDirectory, {recursive: true});
        const citation = createMemoryCodeCitation({
          extractorSet: 'native-code-graph-13',
          fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
          path: 'src/mcp_server_recall.ts',
          repositoryId: 'b'.repeat(64),
          repositoryIdentityKind: 'remote',
          sourceCommit: 'c'.repeat(40),
          sourceDirty: false,
          sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
          target: {kind: 'file'},
          version: 1,
        });
        const validTopic = 'public-archive-citation';
        const validUri = `threadnote://user/test-user/memories/handoffs/active/threadnote/${validTopic}.md`;
        const validPath = join(activeDirectory, `${validTopic}.md`);
        const validContent = formatMemoryDocument(
          'HANDOFF',
          {
            codeCitations: [citation],
            createdAt: '2026-08-25T20:00:00.000Z',
            evidence: ['threadnote://memory/tn_public_archive_evidence'],
            kind: 'handoff',
            memoryId: 'tn_public_archive_source',
            project: 'threadnote',
            references: ['threadnote://memory/tn_public_archive_reference'],
            relations: [{type: 'references', uri: 'threadnote://memory/tn_public_archive_target'}],
            schemaVersion: MEMORY_SCHEMA_VERSION,
            sourceAgentClient: 'codex',
            sourceCommit: citation.sourceCommit,
            sourceObservedAt: '2026-08-26T20:00:00.000Z',
            status: 'active',
            supersedes: 'threadnote://memory/tn_public_archive_history',
            timestamp: '2026-08-26T20:00:00.000Z',
            topic: validTopic,
          },
          'Public MCP archive must retain precise source evidence.',
        );
        await writeFile(validPath, validContent, 'utf8');

        await expect(
          callText(client, 'archive_context', {
            kind: 'handoff',
            project: 'threadnote',
            topic: validTopic,
            uri: validUri,
          }),
        ).resolves.toContain(`Archived original memory: ${validUri}`);
        expect(existsSync(validPath)).toBe(false);
        const archivedFiles = await readdir(archivedDirectory);
        expect(archivedFiles).toHaveLength(1);
        const archivedPath = join(archivedDirectory, archivedFiles[0]);
        const archivedContent = await readFile(archivedPath, 'utf8');
        const archived = parseMemoryDocument(
          `threadnote://user/test-user/memories/handoffs/archived/threadnote/${archivedFiles[0]}`,
          archivedContent,
        );
        expect(archived?.metadata).toMatchObject({
          archivedFrom: validUri,
          codeCitations: [citation],
          createdAt: '2026-08-25T20:00:00.000Z',
          evidence: ['threadnote://memory/tn_public_archive_evidence'],
          memoryId: 'tn_public_archive_source',
          references: ['threadnote://memory/tn_public_archive_reference'],
          relations: [{type: 'references', uri: 'threadnote://memory/tn_public_archive_target'}],
          schemaVersion: MEMORY_SCHEMA_VERSION,
          sourceCommit: citation.sourceCommit,
          sourceObservedAt: '2026-08-26T20:00:00.000Z',
          status: 'archived',
          supersedes: 'threadnote://memory/tn_public_archive_history',
          visibility: 'personal',
        });
        expect(archived?.metadata.citationErrors).toBeUndefined();
        expect(archived?.body).toBe(
          ['Archived original Threadnote memory.', '', 'Public MCP archive must retain precise source evidence.'].join(
            '\n',
          ),
        );
        expect(archived?.body).not.toContain(citation.id);
        expect(archived?.body).not.toContain(citation.fileContentHash.value);

        const blocked = [
          {
            message: 'newer than supported',
            topic: 'public-archive-future',
            versionLine: `schema_version: ${MEMORY_SCHEMA_VERSION + 1}`,
          },
          {
            message: 'newer than supported',
            topic: 'public-archive-indented-future',
            versionLine: `  schema_version: ${MEMORY_SCHEMA_VERSION + 1}`,
          },
          {
            message: 'newer than supported',
            newline: '\r',
            topic: 'public-archive-cr-future',
            versionLine: `schema_version: ${MEMORY_SCHEMA_VERSION + 1}`,
          },
          {
            extraLine: '  code_citation: {not-json}',
            message: 'malformed code citation metadata (invalid-json)',
            topic: 'public-archive-malformed',
            versionLine: `schema_version: ${MEMORY_SCHEMA_VERSION}`,
          },
        ];
        for (const candidate of blocked) {
          const uri = `threadnote://user/test-user/memories/handoffs/active/threadnote/${candidate.topic}.md`;
          const path = join(activeDirectory, `${candidate.topic}.md`);
          const content = [
            'HANDOFF',
            'kind: handoff',
            'status: active',
            'project: threadnote',
            `topic: ${candidate.topic}`,
            candidate.versionLine,
            ...(candidate.extraLine ? [candidate.extraLine] : []),
            '',
            'Blocked archive content must remain untouched.',
          ].join(candidate.newline ?? '\n');
          await writeFile(path, content, 'utf8');

          await expect(
            callErrorText(client, 'archive_context', {
              kind: 'handoff',
              project: 'threadnote',
              topic: candidate.topic,
              uri,
            }),
          ).resolves.toContain(candidate.message);
          await expect(readFile(path, 'utf8')).resolves.toBe(content);
        }
        await expect(readdir(archivedDirectory)).resolves.toEqual(archivedFiles);
      },
      {toolset: 'full'},
    );
  });

  it('names replaceUri on rejected writes and preserves the canonical memory before a full URI replacement', async () => {
    await withMcpClient(async (client, fixture) => {
      const compact = 'memories/handoffs/active/threadnote/uri-validation.md';
      const uri = `threadnote://user/test-user/${compact}`;
      const memoryPath = join(fixture.home, 'data', 'local', 'user', 'test-user', compact);
      const input = {kind: 'handoff', project: 'threadnote', topic: 'uri-validation'};
      await callText(client, 'remember_context', {...input, text: 'Original synthetic memory.'});
      const original = await readFile(memoryPath, 'utf8');
      const files = (await readdir(join(fixture.home, 'data'), {recursive: true})).sort();

      for (const replaceUri of [
        compact,
        'https://example.invalid/status.md',
        'threadnote://user/test-user/../status.md',
      ]) {
        await expect(
          callErrorText(client, 'remember_context', {...input, replaceUri, text: 'Rejected synthetic replacement.'}),
        ).resolves.toContain('optional "replaceUri" must be a threadnote:// URI');
        await expect(readFile(memoryPath, 'utf8')).resolves.toBe(original);
        expect((await readdir(join(fixture.home, 'data'), {recursive: true})).sort()).toEqual(files);
      }

      await callText(client, 'remember_context', {...input, replaceUri: uri, text: 'Accepted synthetic replacement.'});
      const replaced = await readFile(memoryPath, 'utf8');
      expect(replaced).toContain('Accepted synthetic replacement.');
      expect(replaced).not.toContain('Original synthetic memory.');
    });
  });

  it('requires remember_context replaceUri for same-topic schema rewrites and citation clearing', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const directory = join(
          fixture.home,
          'data',
          'local',
          'user',
          'test-user',
          'memories',
          'durable',
          'projects',
          'threadnote',
        );
        await mkdir(directory, {recursive: true});
        const futureTopic = 'remember-implicit-future';
        const futurePath = join(directory, `${futureTopic}.md`);
        const future = [
          'MEMORY',
          'kind: durable',
          'status: active',
          'project: threadnote',
          `topic: ${futureTopic}`,
          `schema_version: ${MEMORY_SCHEMA_VERSION + 1}`,
          'future_writer_field: preserve-me',
          '',
          'Future-owned content must remain unchanged.',
        ].join('\n');
        await writeFile(futurePath, future, 'utf8');

        await expect(
          callErrorText(client, 'remember_context', {
            project: 'threadnote',
            text: 'Implicit future overwrite.',
            topic: futureTopic,
          }),
        ).resolves.toContain('newer than supported');
        await expect(readFile(futurePath, 'utf8')).resolves.toBe(future);

        const citationTopic = 'remember-implicit-citation-clear';
        const citationUri = `threadnote://user/test-user/memories/durable/projects/threadnote/${citationTopic}.md`;
        const citationPath = join(directory, `${citationTopic}.md`);
        const citation = createMemoryCodeCitation({
          extractorSet: 'native-code-graph-13',
          fileContentHash: {algorithm: 'sha256', value: '1'.repeat(64)},
          path: 'src/mcp_server_memory.ts',
          repositoryId: '2'.repeat(64),
          repositoryIdentityKind: 'remote',
          sourceCommit: '3'.repeat(40),
          sourceDirty: false,
          sourceSnapshotId: `cgsn_${'4'.repeat(40)}`,
          target: {kind: 'file'},
          version: 1,
        });
        const cited = formatMemoryDocument(
          'MEMORY',
          {
            codeCitations: [citation],
            kind: 'durable',
            project: 'threadnote',
            schemaVersion: MEMORY_SCHEMA_VERSION,
            sourceAgentClient: 'codex',
            status: 'active',
            timestamp: '2026-08-26T20:00:00.000Z',
            topic: citationTopic,
          },
          'Citation-bearing MCP memory.',
        );
        await writeFile(citationPath, cited, 'utf8');

        await expect(
          callErrorText(client, 'remember_context', {
            project: 'threadnote',
            text: 'Implicit citation clear.',
            topic: citationTopic,
          }),
        ).resolves.toContain(`replaceUri: "${citationUri}"`);
        await expect(readFile(citationPath, 'utf8')).resolves.toBe(cited);

        const replaced = await callText(client, 'remember_context', {
          project: 'threadnote',
          replaceUri: citationUri,
          text: 'Explicit citation clear.',
          topic: citationTopic,
        });
        expect(replaced).toContain('Cleared 1 prior code citation(s)');
        const updated = parseMemoryDocument(citationUri, await readFile(citationPath, 'utf8'));
        expect(updated?.body).toBe('Explicit citation clear.');
        expect(updated?.metadata.codeCitations).toBeUndefined();
      },
      {toolset: 'core'},
    );
  });

  it('advertises the complete toolset when requested', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const tools = await client.listTools();
        const names = tools.tools.map(tool => tool.name);
        expect(names).toHaveLength(CORE_TOOL_NAMES.length + ADVANCED_TOOL_NAMES.length);
        expect([...names].sort()).toEqual([...CORE_TOOL_NAMES, ...ADVANCED_TOOL_NAMES].sort());
        const readContext = tools.tools.find(tool => tool.name === 'read_context');
        const readAlias = tools.tools.find(tool => tool.name === 'read');
        expect(readAlias?.inputSchema).toEqual(readContext?.inputSchema);
        expect(readAlias?.inputSchema.properties).toMatchObject({
          responseFormat: {enum: ['agent', 'dual', 'text']},
        });

        const uri = 'threadnote://user/test-user/memories/durable/projects/threadnote/read-alias.md';
        const citation = createMemoryCodeCitation({
          extractorSet: 'mcp-read-alias-projection',
          fileContentHash: {algorithm: 'sha256', value: '1'.repeat(64)},
          path: 'packages/memory/src/read/projection.ts',
          repositoryId: '2'.repeat(64),
          repositoryIdentityKind: 'remote',
          sourceCommit: '3'.repeat(40),
          sourceDirty: false,
          sourceSnapshotId: `cgsn_${'4'.repeat(40)}`,
          target: {kind: 'file'},
          version: 1,
        });
        const memory = formatMemoryDocument(
          'MEMORY',
          {
            codeCitations: [citation],
            kind: 'durable',
            project: 'threadnote',
            schemaVersion: MEMORY_SCHEMA_VERSION,
            sourceAgentClient: 'integration-test',
            status: 'active',
            timestamp: '2026-10-02T00:00:00.000Z',
            topic: 'read-alias',
          },
          'Alias projection evidence.',
        );
        await writeCanonicalMemory(fixture.home, 'read-alias.md', memory);
        const [primaryRead, aliasRead] = await Promise.all([
          client.callTool({arguments: {uri}, name: 'read_context'}),
          client.callTool({arguments: {uri}, name: 'read'}),
        ]);
        expect(aliasRead.content).toEqual(primaryRead.content);
        expect(aliasRead.structuredContent).toEqual(primaryRead.structuredContent);
        const aliasText = ((aliasRead.content as readonly TextContent[])[0]?.text ?? '').trim();
        expect(aliasText).toContain('TN-MEMORY/1');
        expect(aliasText).toContain(`Code evidence [remote:${citation.repositoryId.slice(0, 12)}`);
        expect(aliasText).not.toContain('code_citations:');
        expect(tools.tools.find(tool => tool.name === 'finalize_code_refs')?.inputSchema).toMatchObject({
          properties: {
            uri: {type: 'string'},
          },
        });
        for (const toolName of ['share_skill', 'list_shared_skills', 'install_shared_skill']) {
          expect(tools.tools.find(tool => tool.name === toolName)?.inputSchema).toMatchObject({
            properties: {
              agent: {enum: ['codex', 'claude', 'cursor']},
            },
          });
        }
        expect(tools.tools.find(tool => tool.name === 'share_propose')).toMatchObject({
          annotations: {destructiveHint: false, readOnlyHint: true},
          inputSchema: {
            properties: {
              approved: {type: 'boolean'},
              candidateIds: expect.any(Object),
              reviewId: {type: 'string'},
              revision: {type: 'integer'},
            },
          },
        });
        expect(tools.tools.find(tool => tool.name === 'procedure_publish_preview')).toMatchObject({
          annotations: {destructiveHint: false, readOnlyHint: true},
        });
        expect(tools.tools.find(tool => tool.name === 'procedure_publish_apply')).toMatchObject({
          annotations: {destructiveHint: true, readOnlyHint: false},
        });
        expect(tools.tools.find(tool => tool.name === 'context_metadata_preview')).toMatchObject({
          annotations: {destructiveHint: false, readOnlyHint: true},
          inputSchema: {
            properties: {
              memoryId: {type: 'string'},
              reviewAfter: {description: 'Optional ISO calendar date or canonical ISO instant', type: 'string'},
              uri: {type: 'string'},
            },
          },
        });
        expect(tools.tools.find(tool => tool.name === 'context_metadata_apply')).toMatchObject({
          annotations: {destructiveHint: true, idempotentHint: true, readOnlyHint: false},
          inputSchema: {properties: {approved: {type: 'boolean'}, expectedContentHash: {type: 'string'}}},
        });
      },
      {toolset: 'full'},
    );
  });

  it('preserves raw maintenance date input for validation while normalizing owner labels', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const uri = 'threadnote://user/test-user/memories/durable/projects/threadnote/metadata-input.md';
        await writeCanonicalMemory(
          fixture.home,
          'metadata-input.md',
          canonicalMemoryContent('metadata-input', 'Body.'),
        );
        const preview = await client.callTool({
          arguments: {owner: '  maintainer  ', uri},
          name: 'context_metadata_preview',
        });
        expect(preview.structuredContent).toMatchObject({
          proposal: {patch: {owner: 'maintainer'}},
          status: 'preview',
        });
        for (const arguments_ of [
          {reviewAfter: ' 2026-12-01 ', uri},
          {reviewAfter: '', uri},
          {validTo: '2026-12-01T00:00:00.000+00:00', uri},
        ]) {
          const result = await client.callTool({arguments: arguments_, name: 'context_metadata_preview'});
          expect(result.structuredContent).toMatchObject({code: 'invalid-date', status: 'conflict'});
        }
      },
      {toolset: 'full'},
    );
  });

  it('records applied recall feedback through the full MCP tool without persisting the raw query', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const query = 'private applied feedback query';
        const uri = 'threadnote://user/test-user/memories/durable/projects/threadnote/applied.md';
        const result = await client.callTool({
          arguments: {action: 'applied', project: 'threadnote', query, uri},
          name: 'recall_feedback',
        });

        expect(result.isError).not.toBe(true);
        expect(result.content).toEqual(
          expect.arrayContaining([
            expect.objectContaining({text: expect.stringContaining('Recorded applied feedback')}),
          ]),
        );
        const stored = await readFile(join(fixture.home, 'feedback', 'recall-events-v1.jsonl'), 'utf8');
        expect(stored).not.toContain(query);
        expect(JSON.parse(stored.trim())).toMatchObject({action: 'applied', project: 'threadnote', uri});
      },
      {toolset: 'full'},
    );
  });

  it('returns read-only structured context health from the full toolset', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const tools = await client.listTools();
        for (const name of ['context_health', 'context_health_repair_preview', 'context_health_repair_apply']) {
          const schema = tools.tools.find(tool => tool.name === name)?.inputSchema;
          expect(schema).toMatchObject({
            properties: {
              findingCategory: {enum: expect.arrayContaining(['validity-expired', 'citation-changed'])},
              kind: {enum: ['durable', 'handoff', 'incident', 'preference', 'smoke']},
            },
          });
        }
        const result = await client.callTool({
          arguments: {callerCwd: fixture.root, kind: 'durable', project: 'threadnote'},
          name: 'context_health',
        });

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          findings: [],
          project: 'threadnote',
          recordsScanned: 0,
          version: 1,
        });
        expect(result.content).toEqual(
          expect.arrayContaining([
            expect.objectContaining({text: expect.stringContaining('Context health for threadnote')}),
            expect.objectContaining({text: expect.stringContaining('Active selector: kind=durable.')}),
          ]),
        );
        for (const arguments_ of [
          {callerCwd: fixture.root, project: 'threadnote', topic: ''},
          {callerCwd: fixture.root, project: 'threadnote', topic: 'unsafe\nvalue'},
          {callerCwd: fixture.root, project: 'threadnote', topic: 'unsafe\u0085value'},
          {callerCwd: fixture.root, project: 'threadnote', topic: 'unsafe\u009bvalue'},
          {callerCwd: fixture.root, project: 'threadnote', topic: 'unsafe\u2028value'},
          {callerCwd: fixture.root, project: 'threadnote', topic: 'unsafe\u2029value'},
          {callerCwd: fixture.root, project: 'threadnote', topic: '🙂'.repeat(65)},
          {callerCwd: fixture.root, kind: 'unknown', project: 'threadnote'},
          {callerCwd: fixture.root, findingCategory: 'unknown', project: 'threadnote'},
        ]) {
          const invalid = await client.callTool({arguments: arguments_, name: 'context_health'});
          expect(invalid.isError).toBe(true);
        }
      },
      {toolset: 'full'},
    );
  });

  it('returns read-only aggregate health and a provider-neutral schedule plan from the full toolset', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const aggregate = await client.callTool({
          arguments: {callerCwd: fixture.root, project: 'threadnote'},
          name: 'context_health_aggregate',
        });
        expect(aggregate.isError).not.toBe(true);
        expect(aggregate.structuredContent).toMatchObject({
          completeSources: 1,
          exitCode: 0,
          project: 'threadnote',
          status: 'clean',
        });

        const shareDirectory = join(fixture.home, 'share');
        await mkdir(shareDirectory, {recursive: true});
        await writeFile(
          join(shareDirectory, 'teams.json'),
          `${JSON.stringify({teams: {platform: {remote: 'https://example.test/platform.git'}}, version: 1})}\n`,
          'utf8',
        );
        const emptyTeamSelection = await client.callTool({
          arguments: {callerCwd: fixture.root, project: 'threadnote', team: []},
          name: 'context_health_aggregate',
        });
        expect(emptyTeamSelection.isError).not.toBe(true);
        expect(emptyTeamSelection.structuredContent).toMatchObject({
          exitCode: 2,
          sources: expect.arrayContaining([
            expect.objectContaining({reason: 'snapshot-missing', sourceKey: 'team:platform', state: 'unknown'}),
          ]),
          status: 'unknown',
        });

        const schedule = await client.callTool({
          arguments: {cadenceMinutes: 60, project: 'threadnote', team: ['runtime', 'platform']},
          name: 'context_health_schedule',
        });
        expect(schedule.isError).not.toBe(true);
        expect(schedule.structuredContent).toMatchObject({
          argv: [
            'context',
            'health',
            'aggregate',
            '--project',
            'threadnote',
            '--json',
            '--team',
            'platform',
            '--team',
            'runtime',
          ],
          execution: {network: 'disabled', readOnly: true},
          teams: ['platform', 'runtime'],
        });
      },
      {toolset: 'full'},
    );
  });

  it('previews structured context-health repairs without writing state', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const result = await client.callTool({
          arguments: {callerCwd: fixture.root, kind: 'durable', project: 'threadnote'},
          name: 'context_health_repair_preview',
        });

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          knowledgeDelta: {
            items: [],
            noAction: true,
            reviewId: expect.stringMatching(/^review-[0-9a-f]{16}$/u),
            revision: 1,
            type: 'knowledge-delta',
            version: 1,
          },
          project: 'threadnote',
          proposals: [],
          version: 1,
        });
        expect(result.content).toEqual(
          expect.arrayContaining([
            expect.objectContaining({text: expect.stringContaining('Active selector: kind=durable.')}),
          ]),
        );
        await expect(readFile(join(fixture.home, 'threadnote', 'context-health-repairs'), 'utf8')).rejects.toThrow();
      },
      {toolset: 'full'},
    );
  });

  it('applies an MCP repair only with the exact normalized preview selector', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const paused = await client.callTool({
          arguments: {action: 'pause', callerCwd: fixture.root},
          name: 'context_maintain',
        });
        expect(paused.isError).not.toBe(true);
        await writeCanonicalMemory(
          fixture.home,
          'mcp-selector.md',
          canonicalMemoryContent('mcp-selector', 'Synthetic expired MCP selector fixture.').replace(
            'timestamp: 2026-08-01T00:00:00.000Z',
            'timestamp: 2026-08-01T00:00:00.000Z\nvalid_to: 2026-08-02T00:00:00.000Z',
          ),
        );
        const selector = {
          findingCategory: 'validity-expired',
          kind: 'durable',
          topic: '  mcp-selector  ',
        } as const;
        const preview = await client.callTool({
          arguments: {callerCwd: fixture.root, project: 'threadnote', ...selector},
          name: 'context_health_repair_preview',
        });
        expect(preview.isError).not.toBe(true);
        const proposal = (
          preview.structuredContent as {
            readonly proposals?: readonly {readonly proposalId: string; readonly revision: string}[];
          }
        ).proposals?.[0];
        expect(proposal).toBeDefined();
        if (proposal === undefined) throw new Error('expected MCP selector repair proposal');

        const missingSelector = await client.callTool({
          arguments: {
            approved: true,
            callerCwd: fixture.root,
            project: 'threadnote',
            proposalId: proposal.proposalId,
            revision: proposal.revision,
          },
          name: 'context_health_repair_apply',
        });
        expect(missingSelector.isError).toBe(true);
        const applied = await client.callTool({
          arguments: {
            approved: true,
            callerCwd: fixture.root,
            project: 'threadnote',
            proposalId: proposal.proposalId,
            revision: proposal.revision,
            ...selector,
          },
          name: 'context_health_repair_apply',
        });
        expect(applied.isError).not.toBe(true);
        expect(applied.structuredContent).toMatchObject({status: 'applied', version: 1});
        const repeated = await client.callTool({
          arguments: {
            approved: true,
            callerCwd: fixture.root,
            project: 'threadnote',
            proposalId: proposal.proposalId,
            revision: proposal.revision,
            ...selector,
          },
          name: 'context_health_repair_apply',
        });
        expect(repeated.structuredContent).toMatchObject({status: 'already-applied', version: 1});
      },
      {toolset: 'full'},
    );
  });

  it('refreshes shared audit provenance and leaves shared bytes unchanged while applying personal hygiene', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const topic = 'shared-compact-topic';
        const personalPath = join(
          fixture.home,
          'data',
          'local',
          'user',
          'test-user',
          'memories',
          'handoffs',
          'active',
          'threadnote',
          `${topic}.md`,
        );
        await mkdir(join(personalPath, '..'), {recursive: true});
        await writeFile(
          personalPath,
          [
            'HANDOFF',
            'kind: handoff',
            'status: active',
            'project: threadnote',
            `topic: ${topic}`,
            'source_agent_client: integration-test',
            'timestamp: 2026-07-01T00:00:00.000Z',
            '',
            'Old personal working notes.',
          ].join('\n'),
          'utf8',
        );
        const sharedPath = join(
          fixture.home,
          'data',
          'local',
          'user',
          'test-user',
          'memories',
          'shared',
          'platform',
          'durable',
          'projects',
          'threadnote',
          `${topic}.md`,
        );
        const sharedContent = canonicalMemoryContent(topic, 'Reviewed shared notes.');
        await mkdir(join(sharedPath, '..'), {recursive: true});
        await writeFile(sharedPath, sharedContent, 'utf8');

        const output = await callText(client, 'compact_context', {
          apply: true,
          project: 'threadnote',
          topic,
        });

        expect(output).toContain('Records scanned: 2');
        expect(output).toContain('same project/topic spans multiple memory scopes');
        expect(output).toContain('threadnote://user/test-user/memories/shared/platform/');
        expect(output).toContain('Shared audit source:');
        expect(output).toContain('bounded auto-sync attempted before scanning local canonical mirrors');
        expect(output).toContain('Archived original memory:');
        expect(output).toContain('Forget exact duplicates (0):\n- none');
        expect(await readFile(sharedPath, 'utf8')).toBe(sharedContent);
        expect(existsSync(personalPath)).toBe(false);
      },
      {toolset: 'full'},
    );
  });

  it('applies an exact-duplicate survivor update and retirement through compact_context', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const topic = 'atomic-duplicate';
        const content = canonicalMemoryContent(topic, 'One exact duplicate contract.');
        const memoryDirectory = join(
          fixture.home,
          'data',
          'local',
          'user',
          'test-user',
          'memories',
          'durable',
          'projects',
          'threadnote',
        );
        const survivorPath = join(memoryDirectory, `${topic}.md`);
        const duplicatePath = join(memoryDirectory, 'threadnote-copy.md');
        await mkdir(memoryDirectory, {recursive: true});
        await writeFile(survivorPath, content, 'utf8');
        await writeFile(duplicatePath, content, 'utf8');

        const output = await callText(client, 'compact_context', {
          apply: true,
          project: 'threadnote',
          topic,
        });

        expect(output).toContain('Updated kept memory:');
        expect(output).toContain('Forgot exact duplicate:');
        expect(existsSync(duplicatePath)).toBe(false);
        const survivor = await readFile(survivorPath, 'utf8');
        expect(survivor).toContain(
          'threadnote://user/test-user/memories/durable/projects/threadnote/atomic-duplicate.md',
        );
        expect(survivor).toContain(
          'threadnote://user/test-user/memories/durable/projects/threadnote/threadnote-copy.md',
        );
      },
      {toolset: 'full'},
    );
  });

  it('imports distinct portable filenames without collisions', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const importRoot = join(fixture.root, 'imports');
        await mkdir(importRoot, {recursive: true});
        await writeFile(join(importRoot, 'a b.txt'), 'alpha-42 immediate recall anchor', 'utf8');
        await writeFile(join(importRoot, 'a+b.txt'), 'beta-99 distinct portable filename', 'utf8');

        await client.callTool({arguments: {query: 'alpha-42'}, name: 'recall_context'}, undefined, {timeout: 5000});
        const imported = await client.callTool(
          {
            arguments: {path: importRoot, to: 'threadnote://resources/import-collision-test'},
            name: 'add_resource',
          },
          undefined,
          {timeout: 5000},
        );
        expect(imported.isError).not.toBe(true);
        expect(imported.structuredContent).toMatchObject({
          imported: expect.arrayContaining([
            'threadnote://resources/import-collision-test/a%20b.txt',
            'threadnote://resources/import-collision-test/a%2Bb.txt',
          ]),
        });

        await callText(client, 'recall_context', {
          pinnedUri: 'threadnote://resources/import-collision-test',
          query: 'alpha-42',
        });
      },
      {toolset: 'full'},
    );
  });

  it('rejects generic imports into managed memory namespaces', async () => {
    await withMcpClient(
      async (client, fixture) => {
        const source = join(fixture.root, 'attempted-memory-import.md');
        await writeFile(source, 'unlocked replacement attempt', 'utf8');
        const uri = 'threadnote://user/test-user/memories/durable/projects/threadnote/import-race.md';

        const error = await callErrorText(client, 'add_resource', {path: source, to: uri});

        expect(error).toContain('cannot write Threadnote memory namespaces');
        expect(error).toContain('remember_context');
        await expect(
          readFile(
            join(
              fixture.root,
              'data',
              'local',
              'user',
              'test-user',
              'memories',
              'durable',
              'projects',
              'threadnote',
              'import-race.md',
            ),
            'utf8',
          ),
        ).rejects.toThrow();
      },
      {toolset: 'full'},
    );
  });
});

function contextBriefAgentTextAnswer(text: string): string {
  return (
    text
      .split('\n')
      .find(line => line.startsWith('Answer: '))
      ?.slice('Answer: '.length) ?? ''
  );
}

function contextBriefAgentTextCards(text: string): readonly {readonly path: string; readonly ref: string}[] {
  return text.split('\n').flatMap(line => {
    const match = /^(?:\d+)\. (cgs_[a-f0-9]{32}) — .*? — (.+):\d+ — .* — /u.exec(line);
    return match?.[1] === undefined || match[2] === undefined ? [] : [{path: match[2], ref: match[1]}];
  });
}

async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({arguments: args, name}, undefined, {timeout: 5000});
  expect(Array.isArray(result.content)).toBe(true);
  const text = (result.content as TextContent[]).map(item => item.text).join('\n');
  expect(result.isError, text).not.toBe(true);
  return text;
}

async function callErrorText(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({arguments: args, name}, undefined, {timeout: 5000});
  expect(Array.isArray(result.content)).toBe(true);
  const text = (result.content as TextContent[]).map(item => item.text).join('\n');
  expect(result.isError, text).toBe(true);
  return text;
}
