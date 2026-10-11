import {describe, expect, it} from 'vitest';
import type {RemoteMemoryReceiptV1} from '@threadnote/memory/remote/receipts';
import type {AuthorizedRemotePrincipal} from '@threadnote/remote-memory/authorization';
import type {RemoteMemoryServiceConfig} from '@threadnote/remote-memory/config';
import {remoteMemoryError} from '@threadnote/remote-memory/errors';
import {orgCloudRepositorySetDigest} from '@threadnote/remote-memory/cloud_admission';
import {createRemoteMemoryHttpHandler} from '@threadnote/threadnote/remote_memory/http_transport';
import {createLocalIdp} from '@threadnote/threadnote/remote_memory/local_idp';
import type {LocalIdp} from '@threadnote/threadnote/remote_memory/local_idp';
import type {OAuthPrincipalClaims} from '@threadnote/remote-memory/oauth';
import type {RemoteMemoryRecallResult} from '@threadnote/remote-memory/postgres/repository';
import type {
  RemoteMemoryServiceDependencies,
  RemoteMemoryServiceRepository,
} from '@threadnote/remote-memory/service_types';
import {
  REMOTE_MEMORY_RESOURCE_READ_MAX_BYTES,
  REMOTE_MEMORY_TOOL_NAMES,
} from '@threadnote/threadnote/remote_memory/tools';

const PROTOCOL_VERSION = '2025-06-18';

interface Fixture {
  readonly calls: string[];
  readonly handler: (request: Request) => Promise<Response>;
  readonly readInputs: Array<{readonly revision?: string; readonly uri: string}>;
}

function fixture(
  options: {
    readonly allowedHosts?: readonly string[];
    readonly allowedOrigins?: readonly string[];
    readonly allowedProjects?: ReadonlySet<string> | 'all';
    readonly attestationRequiredForWrites?: boolean;
    readonly capabilities?: readonly string[];
    readonly cloudAdmissionRequired?: boolean;
    readonly repositoryBindings?: readonly string[];
    readonly gitBinding?: RemoteMemoryServiceConfig['gitBinding'];
    readonly localIdp?: LocalIdp;
    readonly rateLimitFailure?: boolean;
    readonly recallResults?: readonly RemoteMemoryRecallResult[];
    readonly readContent?: string;
    readonly readRevision?: string;
    readonly ready?: boolean;
    readonly receipt?: Partial<RemoteMemoryReceiptV1>;
    readonly repositoryFailure?: Error;
    readonly serviceEnabled?: boolean;
    readonly trackRateLimits?: boolean;
  } = {},
): Fixture {
  const calls: string[] = [];
  const readInputs: Array<{readonly revision?: string; readonly uri: string}> = [];
  const capabilities = options.capabilities ?? ['memory:read', 'memory:write:durable', 'memory:write:handoff'];
  const OAuth: OAuthPrincipalClaims = {
    issuer: 'https://auth.example.test',
    scopes: new Set(capabilities),
    subject: 'oauth-subject',
  };
  const principal: AuthorizedRemotePrincipal = {
    allowedProjects: options.allowedProjects ?? 'all',
    attestationRequiredForWrites: options.attestationRequiredForWrites ?? false,
    capabilities: new Set(capabilities) as AuthorizedRemotePrincipal['capabilities'],
    cloudAdmissionRequired: options.cloudAdmissionRequired ?? false,
    cursorOwnerIds: new Set(),
    cursorSubjects: new Set(),
    featureFlags: new Set([
      'remote_memory_read',
      'remote_memory_durable_write',
      'remote_memory_handoff_write',
      'remote_memory_ga',
    ]),
    OAuth,
    policyVersion: 'policy-v1',
    policyDigest: 'digest-v1',
    principalId: 'principal-1',
    repositoryBindings: new Set(options.repositoryBindings ?? []),
    repositoriesByProject: new Map(),
    shareId: 'share-1',
    sharePolicyDigest: 'share-digest-v1',
    sharePolicyVersion: 'share-policy-v1',
    tenantId: 'tenant-1',
  };
  const receipt = {...receiptFixture(), ...options.receipt};
  const repository: RemoteMemoryServiceRepository = {
    listProposals: async () => {
      calls.push('proposal:list');
      return {entries: []};
    },
    contextBrief: async (_principal, input, requestId) => {
      calls.push(`brief:${requestId}:${input.task}`);
      return {
        directSearchComplete: true,
        directSearchTruncated: false,
        matchedAnchorOrdinals: [],
        receipt: {...receipt, requestId},
        results: (options.recallResults ?? []).map(result => ({...result, evidence: 'lexical' as const})),
      };
    },
    list: async (_principal, _input, requestId) => {
      calls.push(`list:${requestId}`);
      return {entries: [], receipt: {...receipt, requestId}};
    },
    read: async (_principal, input, requestId) => {
      calls.push(`read:${requestId}`);
      readInputs.push({...(input.revision === undefined ? {} : {revision: input.revision}), uri: input.uri});
      if (options.repositoryFailure) throw options.repositoryFailure;
      const revision = input.revision ?? options.readRevision ?? 'revision-1';
      return {
        content: options.readContent ?? 'MEMORY\nkind: durable\n\nFixture body',
        kind: 'durable',
        project: 'threadnote',
        receipt: {...receipt, requestId, revision, uri: input.uri},
        status: 'active',
        topic: 'fixture',
        uri: input.uri,
      };
    },
    readProposal: async (_principal, proposalId) => {
      calls.push(`proposal:read:${proposalId}`);
      return {
        createdAt: '2026-09-16T00:00:00.000Z',
        expiresAt: '2026-10-16T00:00:00.000Z',
        payload: {project: 'threadnote', text: 'Proposed body.', topic: 'proposal', version: 1},
        project: 'threadnote',
        proposalId,
        proposerPrincipalId: 'principal-proposer',
        requestHash: 'a'.repeat(64),
        revision: 'proposal-revision-1',
        status: 'pending',
        topic: 'proposal',
        version: 1,
      };
    },
    recall: async (_principal, input, requestId) => {
      calls.push(`recall:${requestId}:${input.query}`);
      return {receipt: {...receipt, requestId}, results: options.recallResults ?? []};
    },
    remember: async (_principal, input, requestId) => {
      calls.push(`remember:${requestId}:${input.operationId}`);
      return {...receipt, requestId, revision: 'revision-2'};
    },
    proposeDurable: async (_principal, input) => {
      calls.push(`proposal:create:${input.operationId}`);
      return {
        expiresAt: '2026-10-16T00:00:00.000Z',
        proposalId: 'proposal-1',
        requestHash: 'a'.repeat(64),
        revision: 'proposal-revision-1',
        status: 'pending',
        version: 1,
      };
    },
    reviewProposal: async (_principal, input) => {
      calls.push(`proposal:review:${input.decision}:${input.operationId}`);
      return {
        createdAt: '2026-09-16T00:00:00.000Z',
        expiresAt: '2026-10-16T00:00:00.000Z',
        payload: {project: 'threadnote', text: 'Proposed body.', topic: 'proposal', version: 1},
        project: 'threadnote',
        proposalId: input.proposalId,
        proposerPrincipalId: 'principal-proposer',
        requestHash: 'a'.repeat(64),
        revision: input.revision,
        status: input.decision === 'approve' ? 'approved' : 'rejected',
        topic: 'proposal',
        version: 1,
      };
    },
    status: async (_principal, requestId) => {
      calls.push(`status:${requestId}`);
      return {
        receipt: {...receipt, requestId},
        reviewGated: {
          propose: capabilities.includes('memory:propose:durable'),
          review: capabilities.includes('memory:review:durable'),
        },
        writable: {durable: true, handoff: true},
      };
    },
    transitionHandoff: async (_principal, input, requestId) => {
      calls.push(`transition:${requestId}:${input.operation}`);
      return {...receipt, requestId, revision: 'revision-3', uri: input.uri};
    },
  };
  const dependencies: RemoteMemoryServiceDependencies = {
    attestations: {
      consumeChallenge: async () => undefined,
      createChallenge: async challenge => void calls.push(`challenge:${challenge.challengeId}`),
      claimChallengeAttempt: async () => undefined,
      getValidAttestation: async () => undefined,
      principalForChallenge: async () => undefined,
    },
    authorization: {
      authorize: async (_claims, shareId) => {
        calls.push(`authorize:${shareId ?? 'none'}`);
        return shareId === principal.shareId ? principal : undefined;
      },
    },
    cursorTokens: {verify: async () => Promise.reject(new Error('not used'))},
    oauthTokens: {
      verify: async token => {
        calls.push(`oauth:${token}`);
        return OAuth;
      },
    },
    readiness: async () => options.ready ?? true,
    rateLimits: {
      consume: async (_principal, operation) => {
        if (options.trackRateLimits) calls.push(`rate:${operation}`);
        if (options.rateLimitFailure) {
          throw remoteMemoryError('rate_limited', 'The remote memory operation rate limit was exceeded.', {
            retryAfterSeconds: 17,
          });
        }
      },
    },
    repository,
  };
  return {
    calls,
    handler: createRemoteMemoryHttpHandler({
      config: {
        ...configFixture(),
        globallyEnabled: options.serviceEnabled ?? true,
        ...(options.gitBinding ? {canonicalStore: 'git', gitBinding: options.gitBinding} : {}),
        ...(options.allowedHosts ? {allowedHosts: options.allowedHosts} : {}),
        ...(options.allowedOrigins ? {allowedOrigins: options.allowedOrigins} : {}),
      },
      dependencies,
      ...(options.localIdp ? {localIdp: options.localIdp} : {}),
    }),
    readInputs,
  };
}

function configFixture(): RemoteMemoryServiceConfig {
  return {
    accessTokenAudience: 'https://memory.example.test/mcp',
    accessTokenIssuer: 'https://auth.example.test',
    accessTokenJwksUrl: new URL('https://auth.example.test/jwks'),
    autoMigrate: false,
    allowedHosts: ['memory.example.test'],
    allowedOrigins: ['https://cursor.com'],
    attestationAudience: 'https://memory.example.test/attest/cursor',
    canonicalStore: 'postgres',
    cursorIssuer: 'https://api.cursor.com',
    cursorJwksUrl: new URL('https://api.cursor.com/jwks'),
    databaseUrl: 'redacted-fixture',
    gitBranch: 'main',
    gitPush: true,
    gitRemote: 'origin',
    globallyEnabled: true,
    host: '127.0.0.1',
    maxBodyBytes: 4096,
    port: 8787,
    publicBaseUrl: new URL('https://memory.example.test'),
    readRequestsPerMinute: 300,
    requestTimeoutMilliseconds: 1000,
    writeRequestsPerMinute: 60,
  };
}

function receiptFixture(): RemoteMemoryReceiptV1 {
  return {
    consistency: 'current',
    indexedGeneration: 1,
    policyVersion: 'policy-v1',
    sharePolicyVersion: 'share-policy-v1',
    requestId: 'fixture-request',
    shareGeneration: 1,
    shareId: 'share-1',
    tenantId: 'tenant-1',
    version: 1,
  };
}

function mcpRequest(
  message: Readonly<Record<string, unknown>>,
  options: {readonly host?: string; readonly origin?: string; readonly token?: string} = {},
): Request {
  return new Request('https://memory.example.test/mcp', {
    body: JSON.stringify({jsonrpc: '2.0', ...message}),
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${options.token ?? 'fixture-token'}`,
      'content-type': 'application/json',
      host: options.host ?? 'memory.example.test',
      'mcp-protocol-version': PROTOCOL_VERSION,
      origin: options.origin ?? 'https://cursor.com',
      'threadnote-share-id': 'share-1',
      'x-request-id': 'request-123',
    },
    method: 'POST',
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('remote memory HTTP transport', () => {
  it('admits only current Git share/repository Cloud bindings before MCP dispatch', async () => {
    const repositories = ['github.com/example/repo'];
    for (const headers of [
      {'threadnote-cloud-access': 'read-only'},
      {'threadnote-repository-set': orgCloudRepositorySetDigest('share-1', repositories)},
      {
        'threadnote-cloud-access': 'read-only',
        'threadnote-repository-set': orgCloudRepositorySetDigest('wrong', repositories),
      },
      {
        'threadnote-cloud-access': 'read-only',
        'threadnote-repository-set': orgCloudRepositorySetDigest('share-1', ['github.com/example/stale']),
      },
    ]) {
      const test = fixture({gitBinding: {tenantId: 'tenant-1', shareId: 'share-1'}, repositoryBindings: repositories});
      const request = mcpRequest({id: 1, method: 'tools/list', params: {}});
      for (const [name, value] of Object.entries(headers)) request.headers.set(name, value);
      expect((await test.handler(request)).status).toBe(403);
      expect(test.calls).toEqual(['oauth:fixture-token', 'authorize:share-1']);
    }
    const test = fixture({gitBinding: {tenantId: 'tenant-1', shareId: 'share-1'}, repositoryBindings: repositories});
    for (const access of ['read-only', 'contribute']) {
      const request = mcpRequest({
        id: 1,
        method: 'tools/call',
        params: {
          name: 'remember_context',
          arguments: {
            kind: 'durable',
            project: 'threadnote',
            topic: 'test',
            text: 'Synthetic body',
            operationId: 'operation-1',
            version: 1,
          },
        },
      });
      request.headers.set('threadnote-cloud-access', access);
      request.headers.set('threadnote-repository-set', orgCloudRepositorySetDigest('share-1', repositories));
      const response = await test.handler(request);
      const body = await json(response);
      expect(JSON.stringify(body)).toContain(access === 'read-only' ? 'forbidden' : 'attestation_required');
      expect(test.calls.some(call => call.startsWith('remember:'))).toBe(false);
    }
  });

  it('does not let a server-classified Cloud principal bypass admission by dropping both Cloud headers', async () => {
    const test = fixture({
      attestationRequiredForWrites: true,
      capabilities: ['memory:read', 'memory:write:durable'],
      cloudAdmissionRequired: true,
      gitBinding: {tenantId: 'tenant-1', shareId: 'share-1'},
      repositoryBindings: ['github.com/example/repo'],
    });
    const response = await test.handler(
      mcpRequest({
        id: 1,
        method: 'tools/call',
        params: {
          name: 'remember_context',
          arguments: {
            kind: 'durable',
            project: 'threadnote',
            topic: 'test',
            text: 'Synthetic body',
            operationId: 'operation-1',
            version: 1,
          },
        },
      }),
    );
    expect(response.status).toBe(403);
    expect(test.calls).toEqual(['oauth:fixture-token', 'authorize:share-1']);
  });

  it('keeps attestation-enabled desktop principals on the explicit headerless compatibility path', async () => {
    const test = fixture({
      attestationRequiredForWrites: true,
      gitBinding: {tenantId: 'tenant-1', shareId: 'share-1'},
      repositoryBindings: ['github.com/example/repo'],
    });
    expect((await test.handler(mcpRequest({id: 1, method: 'tools/list', params: {}}))).status).toBe(200);
    expect(test.calls.slice(0, 2)).toEqual(['oauth:fixture-token', 'authorize:share-1']);
  });

  it('rejects an authorized share outside the deployment before MCP dispatch', async () => {
    for (const gitBinding of [
      {tenantId: 'tenant-2', shareId: 'share-1'},
      {tenantId: 'tenant-1', shareId: 'share-2'},
    ]) {
      const test = fixture({gitBinding});
      const response = await test.handler(mcpRequest({id: 1, method: 'tools/list', params: {}}));
      expect(response.status).toBe(403);
      expect(test.calls).toEqual(['oauth:fixture-token', 'authorize:share-1']);
    }
    const bound = fixture({gitBinding: {tenantId: 'tenant-1', shareId: 'share-1'}});
    expect((await bound.handler(mcpRequest({id: 1, method: 'tools/list', params: {}}))).status).toBe(200);
  });

  // These examples exercise the Web Request/Response and official SDK Promise boundary.
  it('serves protected-resource metadata and bounded health/readiness endpoints without authentication', async () => {
    const test = fixture({ready: false});
    const headers = {host: 'memory.example.test'};

    const metadata = await test.handler(
      new Request('https://memory.example.test/.well-known/oauth-protected-resource', {headers}),
    );
    expect(metadata.status).toBe(200);
    const metadataBody = await json(metadata);
    expect(metadataBody).toMatchObject({
      authorization_servers: ['https://auth.example.test'],
      resource: 'https://memory.example.test/mcp',
    });
    expect(metadataBody).not.toHaveProperty('resource_documentation');
    expect((await test.handler(new Request('https://memory.example.test/healthz', {headers}))).status).toBe(200);
    expect((await test.handler(new Request('https://memory.example.test/readyz', {headers}))).status).toBe(503);
    expect(test.calls).toEqual([]);
  });

  it('rejects Host and Origin before OAuth verification or body dispatch', async () => {
    const test = fixture();
    const badHost = await test.handler(mcpRequest({id: 1, method: 'tools/list', params: {}}, {host: 'evil.test'}));
    const badOrigin = await test.handler(
      mcpRequest({id: 2, method: 'tools/list', params: {}}, {origin: 'https://evil.test'}),
    );

    expect(badHost.status).toBe(403);
    expect(badOrigin.status).toBe(403);
    expect(test.calls).toEqual([]);
  });

  it('keeps health endpoints available while the environment-wide kill switch rejects MCP traffic', async () => {
    const test = fixture({serviceEnabled: false});
    const health = await test.handler(
      new Request('https://memory.example.test/healthz', {headers: {host: 'memory.example.test'}}),
    );
    const mcp = await test.handler(mcpRequest({id: 23, method: 'tools/list', params: {}}));

    expect(health.status).toBe(200);
    expect(mcp.status).toBe(503);
    expect(test.calls).toEqual([]);
  });

  it.each(['https://cursor.com/path', 'https://user:password@cursor.com'])(
    'requires an exact credential-free Origin header: %s',
    async origin => {
      const test = fixture();
      const response = await test.handler(mcpRequest({id: 21, method: 'tools/list', params: {}}, {origin}));

      expect(response.status).toBe(403);
      expect(test.calls).toEqual([]);
    },
  );

  it('requires OAuth and returns protected-resource discovery on 401', async () => {
    const test = fixture();
    const request = mcpRequest({id: 1, method: 'initialize', params: {}}, {token: ''});
    request.headers.delete('authorization');
    const response = await test.handler(request);

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource');
    expect(test.calls).toEqual([]);
  });

  it('negotiates stateless Streamable HTTP and publishes exactly the remote tool surface', async () => {
    const test = fixture();
    const initialized = await test.handler(
      mcpRequest({
        id: 1,
        method: 'initialize',
        params: {
          capabilities: {},
          clientInfo: {name: 'remote-fixture', version: '1.0.0'},
          protocolVersion: PROTOCOL_VERSION,
        },
      }),
    );
    expect(initialized.status).toBe(200);
    expect(initialized.headers.get('mcp-session-id')).toBeNull();
    expect(await json(initialized)).toMatchObject({
      id: 1,
      result: {protocolVersion: PROTOCOL_VERSION, serverInfo: {name: 'threadnote-memory'}},
    });

    const listed = await test.handler(mcpRequest({id: 2, method: 'tools/list', params: {}}));
    const payload = await json(listed);
    const result = payload.result as {readonly tools: readonly {readonly name: string}[]};
    expect(result.tools.map(tool => tool.name)).toEqual(REMOTE_MEMORY_TOOL_NAMES);
    expect(test.calls).toEqual([
      'oauth:fixture-token',
      'authorize:share-1',
      'oauth:fixture-token',
      'authorize:share-1',
    ]);
  });

  it('advertises Effect input schemas that match valid and rejected MCP tool calls', async () => {
    const test = fixture({trackRateLimits: true});
    const listed = await json(await test.handler(mcpRequest({id: 20, method: 'tools/list', params: {}})));
    const tools = (
      listed.result as {
        readonly tools: readonly {readonly inputSchema: Record<string, unknown>; readonly name: string}[];
      }
    ).tools;
    const readSchema = tools.find(tool => tool.name === 'read_context')?.inputSchema;
    expect(readSchema).toMatchObject({
      additionalProperties: false,
      properties: {mode: {type: 'string'}, uri: {type: 'string'}, version: {enum: [1]}},
      required: ['uri', 'version'],
      type: 'object',
    });
    expect(tools.find(tool => tool.name === 'remember_context')?.inputSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        lifecycle: {additionalProperties: false},
        relations: {maxItems: 16, type: 'array'},
        replaceUri: {type: 'string'},
      },
    });
    const uri = 'threadnote://share/share-1/memories/durable/threadnote/fixture.md';
    const valid = await json(
      await test.handler(
        mcpRequest({
          id: 21,
          method: 'tools/call',
          params: {arguments: {uri, version: 1}, name: 'read_context'},
        }),
      ),
    );
    expect(valid).toMatchObject({id: 21, result: {structuredContent: {uri}}});
    const readsBeforeInvalid = test.calls.filter(call => call === 'rate:read_context').length;
    for (const [id, arguments_] of [
      [22, {version: 1}],
      [23, {uri, unexpected: 'private-value', version: 1}],
    ] as const) {
      const response = await json(
        await test.handler(
          mcpRequest({
            id,
            method: 'tools/call',
            params: {arguments: arguments_, name: 'read_context'},
          }),
        ),
      );
      expect(response).toMatchObject({id, result: {isError: true}});
      expect(JSON.stringify(response)).not.toContain('private-value');
    }
    expect(test.calls.filter(call => call === 'rate:read_context')).toHaveLength(readsBeforeInvalid);
  });

  it('routes only an authorized matching explicit CAS replacement URI to storage', async () => {
    const test = fixture({trackRateLimits: true});
    const input = {
      baseRevision: 'revision-1',
      kind: 'durable',
      operationId: 'operation-30',
      project: 'threadnote',
      replaceUri: 'threadnote://share/share-1/memories/durable/threadnote/remote.md',
      text: 'Updated fixture.',
      topic: 'remote',
      version: 1,
    };
    const call = (id: number, arguments_: Record<string, unknown>) =>
      test.handler(mcpRequest({id, method: 'tools/call', params: {arguments: arguments_, name: 'remember_context'}}));
    const valid = await json(await call(30, input));
    expect(valid).toMatchObject({id: 30, result: {structuredContent: {revision: 'revision-2'}}});
    expect(test.calls).toContain('remember:request-123:operation-30');
    const writes = test.calls.filter(entry => entry.startsWith('remember:')).length;
    for (const [id, overrides, code] of [
      [31, {replaceUri: 'threadnote://share/share-2/memories/durable/threadnote/remote.md'}, 'forbidden'],
      [32, {replaceUri: 'threadnote://share/share-1/memories/durable/threadnote/other.md'}, 'invalid_request'],
      [33, {baseRevision: undefined}, 'invalid_request'],
    ] as const) {
      const result = await json(await call(id, {...input, ...overrides, operationId: `operation-${id}`}));
      expect(result).toMatchObject({id, result: {isError: true, structuredContent: {code}}});
    }
    expect(test.calls.filter(entry => entry.startsWith('remember:'))).toHaveLength(writes);
  });

  it('keeps proposal-only principals outside direct durable writes', async () => {
    const test = fixture({capabilities: ['memory:read', 'memory:propose:durable'], trackRateLimits: true});
    const proposal = {
      operationId: 'proposal-operation-1',
      project: 'threadnote',
      text: 'A reviewed durable memory candidate.',
      topic: 'reviewed-candidate',
      version: 1,
    };
    const proposed = await json(
      await test.handler(
        mcpRequest({
          id: 35,
          method: 'tools/call',
          params: {arguments: proposal, name: 'propose_durable_memory'},
        }),
      ),
    );
    expect(proposed).toMatchObject({
      id: 35,
      result: {structuredContent: {proposalId: 'proposal-1', status: 'pending'}},
    });
    expect(test.calls).toContain('proposal:create:proposal-operation-1');

    const direct = await json(
      await test.handler(
        mcpRequest({
          id: 36,
          method: 'tools/call',
          params: {arguments: {...proposal, kind: 'durable'}, name: 'remember_context'},
        }),
      ),
    );
    expect(direct).toMatchObject({id: 36, result: {isError: true, structuredContent: {code: 'forbidden'}}});
    expect(test.calls.some(call => call.startsWith('remember:'))).toBe(false);
  });

  it('requires review plus durable-write capability for approval while allowing reviewer rejection', async () => {
    const reviewer = fixture({capabilities: ['memory:read', 'memory:review:durable'], trackRateLimits: true});
    expect(
      await json(
        await reviewer.handler(
          mcpRequest({
            id: 37,
            method: 'tools/call',
            params: {
              arguments: {
                decision: 'approve',
                operationId: 'review-operation-approve',
                proposalId: 'proposal-1',
                revision: 'proposal-revision-1',
                version: 1,
              },
              name: 'review_memory_proposal',
            },
          }),
        ),
      ),
    ).toMatchObject({id: 37, result: {isError: true, structuredContent: {code: 'forbidden'}}});
    expect(reviewer.calls.some(call => call.startsWith('proposal:review:'))).toBe(false);

    const rejected = await json(
      await reviewer.handler(
        mcpRequest({
          id: 38,
          method: 'tools/call',
          params: {
            arguments: {
              decision: 'reject',
              operationId: 'review-operation-reject',
              proposalId: 'proposal-1',
              reason: 'The evidence is incomplete.',
              revision: 'proposal-revision-1',
              version: 1,
            },
            name: 'review_memory_proposal',
          },
        }),
      ),
    );
    expect(rejected).toMatchObject({id: 38, result: {structuredContent: {status: 'rejected'}}});
    expect(reviewer.calls).toContain('proposal:review:reject:review-operation-reject');

    const approver = fixture({
      capabilities: ['memory:read', 'memory:review:durable', 'memory:write:durable'],
      trackRateLimits: true,
    });
    const approved = await json(
      await approver.handler(
        mcpRequest({
          id: 39,
          method: 'tools/call',
          params: {
            arguments: {
              decision: 'approve',
              operationId: 'review-operation-approved',
              proposalId: 'proposal-1',
              revision: 'proposal-revision-1',
              version: 1,
            },
            name: 'review_memory_proposal',
          },
        }),
      ),
    );
    expect(approved).toMatchObject({id: 39, result: {structuredContent: {status: 'approved'}}});
    expect(approver.calls).toContain('proposal:review:approve:review-operation-approved');
  });

  it('bounds proposal discovery and review schemas', async () => {
    const test = fixture({capabilities: ['memory:read', 'memory:review:durable'], trackRateLimits: true});
    const listed = await json(await test.handler(mcpRequest({id: 40, method: 'tools/list', params: {}})));
    const tools = (listed.result as {readonly tools: readonly {inputSchema: unknown; name: string}[]}).tools;
    expect(tools.find(tool => tool.name === 'propose_durable_memory')?.inputSchema).toMatchObject({
      additionalProperties: false,
      properties: {relations: {maxItems: 16}, text: {maxLength: 1_000_000}, version: {enum: [1]}},
      required: ['operationId', 'project', 'text', 'topic', 'version'],
    });
    expect(tools.find(tool => tool.name === 'list_memory_proposals')?.inputSchema).toMatchObject({
      additionalProperties: false,
      properties: {limit: {type: 'integer', minimum: 1, maximum: 100}, status: {type: 'string'}},
    });
    for (const [index, limit] of [0, 101, 1.5].entries()) {
      const invalidLimit = await json(
        await test.handler(
          mcpRequest({
            id: 43 + index,
            method: 'tools/call',
            params: {arguments: {limit, version: 1}, name: 'list_memory_proposals'},
          }),
        ),
      );
      expect(invalidLimit).toMatchObject({id: 43 + index, result: {isError: true}});
    }
    expect(test.calls).not.toContain('proposal:list');
    const invalidRejection = await json(
      await test.handler(
        mcpRequest({
          id: 41,
          method: 'tools/call',
          params: {
            arguments: {
              decision: 'reject',
              operationId: 'review-invalid',
              proposalId: 'proposal-1',
              revision: 'proposal-revision-1',
              version: 1,
            },
            name: 'review_memory_proposal',
          },
        }),
      ),
    );
    expect(invalidRejection).toMatchObject({id: 41, result: {isError: true}});
    const whitespaceRejection = await json(
      await test.handler(
        mcpRequest({
          id: 42,
          method: 'tools/call',
          params: {
            arguments: {
              decision: 'reject',
              operationId: 'review-whitespace',
              proposalId: 'proposal-1',
              reason: '   ',
              revision: 'proposal-revision-1',
              version: 1,
            },
            name: 'review_memory_proposal',
          },
        }),
      ),
    );
    expect(whitespaceRejection).toMatchObject({id: 42, result: {isError: true}});
    expect(test.calls.some(call => call.startsWith('proposal:review:'))).toBe(false);
  });

  it('charges each proposal tool to its stable rate-limit operation key', async () => {
    const test = fixture({
      capabilities: ['memory:read', 'memory:propose:durable', 'memory:review:durable', 'memory:write:durable'],
      trackRateLimits: true,
    });
    const calls = [
      {
        arguments: {operationId: 'proposal-rate', project: 'threadnote', text: 'Candidate.', topic: 'rate', version: 1},
        name: 'propose_durable_memory',
      },
      {arguments: {limit: 5, version: 1}, name: 'list_memory_proposals'},
      {arguments: {proposalId: 'proposal-1', version: 1}, name: 'read_memory_proposal'},
      {
        arguments: {
          decision: 'reject',
          operationId: 'review-rate',
          proposalId: 'proposal-1',
          reason: 'Insufficient evidence.',
          revision: 'proposal-revision-1',
          version: 1,
        },
        name: 'review_memory_proposal',
      },
    ] as const;
    for (const [index, call] of calls.entries()) {
      const response = await json(
        await test.handler(mcpRequest({id: 410 + index, method: 'tools/call', params: call})),
      );
      expect(response).toMatchObject({id: 410 + index});
      expect(response).not.toMatchObject({result: {isError: true}});
    }
    expect(test.calls.filter(call => call.startsWith('rate:'))).toEqual([
      'rate:propose_durable_memory',
      'rate:list_memory_proposals',
      'rate:read_memory_proposal',
      'rate:review_memory_proposal',
    ]);
  });

  it('rejects unauthorized, malformed, duplicate, and self relations before storage dispatch', async () => {
    const test = fixture({allowedProjects: new Set(['threadnote']), trackRateLimits: true});
    const source = 'threadnote://share/share-1/memories/durable/threadnote/source.md';
    const input = {
      kind: 'durable',
      operationId: 'operation-relations-valid',
      project: 'threadnote',
      relations: [
        {
          type: 'depends_on',
          uri: 'threadnote://share/share-1/memories/durable/threadnote/dependency.md',
        },
      ],
      text: 'Authorized relation source.',
      topic: 'source',
      version: 1,
    };
    const call = (id: number, arguments_: Record<string, unknown>) =>
      test.handler(mcpRequest({id, method: 'tools/call', params: {arguments: arguments_, name: 'remember_context'}}));

    expect(await json(await call(40, input))).toMatchObject({
      id: 40,
      result: {structuredContent: {revision: 'revision-2'}},
    });
    const writes = test.calls.filter(entry => entry.startsWith('remember:')).length;
    const invalid = [
      [{relations: [{type: 'depends_on', uri: source}]}, 'invalid_request'],
      [
        {
          relations: [
            {
              type: 'depends_on',
              uri: 'threadnote://share/share-2/memories/durable/threadnote/dependency.md',
            },
          ],
        },
        'forbidden',
      ],
      [
        {
          relations: [{type: 'depends_on', uri: 'threadnote://share/share-1/memories/durable/other/dependency.md'}],
        },
        'forbidden',
      ],
      [{relations: [{type: 'depends_on', uri: `${source}#anchor`}]}, 'invalid_request'],
      [
        {
          relations: [
            {type: 'depends_on', uri: input.relations[0].uri},
            {type: 'depends_on', uri: input.relations[0].uri},
          ],
        },
        'invalid_request',
      ],
    ] as const;
    for (const [index, [overrides, code]] of invalid.entries()) {
      const operationId = `operation-relations-invalid-${index}`;
      const result = await json(await call(41 + index, {...input, ...overrides, operationId}));
      expect(result).toMatchObject({result: {isError: true, structuredContent: {code}}});
      expect(JSON.stringify(result)).not.toContain((overrides.relations as readonly {readonly uri: string}[])[0]?.uri);
    }
    expect(test.calls.filter(entry => entry.startsWith('remember:'))).toHaveLength(writes);
  });

  it('preserves minute-precision UTC expiry validation at the MCP boundary', async () => {
    const test = fixture({trackRateLimits: true});
    const call = (id: number, expiresAt: string) =>
      test.handler(
        mcpRequest({
          id,
          method: 'tools/call',
          params: {
            arguments: {
              kind: 'handoff',
              lifecycle: {expiresAt},
              operationId: `operation-${id}`,
              project: 'threadnote',
              text: 'bounded fixture',
              topic: 'remote',
              version: 1,
            },
            name: 'remember_context',
          },
        }),
      );
    const valid = await json(await call(24, '2099-09-14T12:34Z'));
    expect(valid).toMatchObject({id: 24, result: {structuredContent: {revision: 'revision-2'}}});
    expect(test.calls).toContain('remember:request-123:operation-24');
    const invalid = await json(await call(25, '2099-02-30T12:34Z'));
    expect(invalid).toMatchObject({id: 25, result: {isError: true}});
    expect(test.calls).not.toContain('remember:request-123:operation-25');
  });

  it('passes request-scoped principal and correlation to tools without a process-global identity', async () => {
    const test = fixture({trackRateLimits: true});
    const response = await test.handler(
      mcpRequest({id: 3, method: 'tools/call', params: {arguments: {version: 1}, name: 'memory_status'}}),
    );
    const payload = await json(response);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      id: 3,
      result: {
        structuredContent: {
          reviewGated: {propose: false, review: false},
          receipt: {
            policyVersion: 'policy-v1',
            requestId: 'request-123',
            shareId: 'share-1',
            sharePolicyVersion: 'share-policy-v1',
            tenantId: 'tenant-1',
          },
        },
      },
    });
    expect(test.calls).toContain('status:request-123');
    expect(test.calls).toContain('rate:memory_status');
  });

  it.each([
    {capabilities: ['memory:read', 'memory:propose:durable'], expected: {propose: true, review: false}},
    {capabilities: ['memory:read', 'memory:review:durable'], expected: {propose: false, review: true}},
    {
      capabilities: ['memory:read', 'memory:propose:durable', 'memory:review:durable'],
      expected: {propose: true, review: true},
    },
    {capabilities: ['memory:read'], expected: {propose: false, review: false}},
  ])('reports review-gated capabilities for $capabilities', async ({capabilities, expected}) => {
    const test = fixture({capabilities});
    const response = await json(
      await test.handler(
        mcpRequest({id: 303, method: 'tools/call', params: {arguments: {version: 1}, name: 'memory_status'}}),
      ),
    );
    expect(response).toMatchObject({result: {structuredContent: {reviewGated: expected}}});
  });

  it('projects 100 worst-case remote recall hits as a compact unread prefix with bounded explain details', async () => {
    const recallResults: RemoteMemoryRecallResult[] = Array.from({length: 100}, (_, index) => ({
      excerpt: `REMOTE_EXCERPT_${index.toString().padStart(3, '0')}_${'e'.repeat(600)}`,
      kind: index % 2 === 0 ? 'durable' : 'handoff',
      project: 'threadnote',
      revision: `revision-${index}`,
      score: Number((1 - index / 200).toFixed(3)),
      status: 'active',
      topic: `topic-${index.toString().padStart(3, '0')}`,
      uri: `threadnote://share/share-1/memories/durable/threadnote/topic-${index.toString().padStart(3, '0')}.md`,
    }));
    const test = fixture({recallResults, trackRateLimits: true});
    const callRecall = async (id: number, explain: boolean) => {
      const response = await test.handler(
        mcpRequest({
          id,
          method: 'tools/call',
          params: {
            arguments: {
              budgetTokens: 1_500,
              explain,
              limit: 100,
              project: 'threadnote',
              query: 'worst case recall',
              version: 1,
            },
            name: 'recall_context',
          },
        }),
      );
      const payload = await json(response);
      const result = payload.result as {
        readonly content?: readonly {readonly text?: string; readonly type?: string}[];
        readonly isError?: boolean;
        readonly structuredContent?: Readonly<Record<string, unknown>>;
      };
      expect(result.isError, JSON.stringify(payload)).not.toBe(true);
      const blocks = result.content ?? [];
      const structured = result.structuredContent ?? {};
      const responseBytes =
        blocks.reduce(
          (total, block) => total + (block.type === 'text' ? Buffer.byteLength(block.text ?? '', 'utf8') : 0),
          0,
        ) + Buffer.byteLength(JSON.stringify(structured), 'utf8');
      expect(responseBytes).toBeLessThanOrEqual(1_500 * 3);
      expect(structured.estimatedTokens).toBe(Math.ceil(responseBytes / 3));
      return {blocks, structured};
    };

    const compact = await callRecall(3_100, false);
    const compactResults = compact.structured.results as readonly Readonly<Record<string, unknown>>[];
    expect(compactResults.length).toBeGreaterThan(0);
    expect(compactResults.length).toBeLessThan(100);
    expect(compactResults.map(result => result.uri)).toEqual(
      recallResults.slice(0, compactResults.length).map(result => result.uri),
    );
    expect(compactResults.every(result => result.readState === 'unread' && typeof result.reason === 'string')).toBe(
      true,
    );
    expect(compactResults.every(result => !('excerpt' in result))).toBe(true);
    expect(JSON.stringify({content: compact.blocks, structured: compact.structured})).not.toContain('REMOTE_EXCERPT_');
    expect(compact.structured).toMatchObject({
      confidence: {level: 'high', topScore: 1},
      explain: false,
      nextAction: {tool: 'read_context', uris: recallResults.slice(0, 3).map(result => result.uri)},
      omittedResults: 100 - compactResults.length,
      rankerVersion: 'remote-postgres-tsvector-v1',
      totalResults: 100,
      type: 'threadnote-remote-recall',
    });
    expect(compact.blocks[0]?.text).toContain(recallResults[0].uri);

    const explained = await callRecall(3_101, true);
    const explainedResults = explained.structured.results as readonly Readonly<Record<string, unknown>>[];
    expect(explainedResults.length).toBeGreaterThan(0);
    expect(explainedResults.length).toBeLessThan(compactResults.length);
    expect(explainedResults[0]?.excerpt).toEqual(expect.stringContaining('REMOTE_EXCERPT_000_'));
    expect(explained.structured.explain).toBe(true);
    expect(explained.blocks[0]?.text).toContain('REMOTE_EXCERPT_000_');
    expect(
      JSON.stringify({content: explained.blocks, structured: explained.structured}).match(/REMOTE_EXCERPT_000_/gu),
    ).toHaveLength(2);
    expect(test.calls.filter(call => call === 'rate:recall_context')).toHaveLength(2);
  });

  it('exposes a read-only remote Context Brief with bounded task input and no checkout claim', async () => {
    const test = fixture({
      recallResults: [
        {
          excerpt: 'fixture evidence',
          kind: 'durable',
          project: 'threadnote',
          revision: 'revision-1',
          score: 1,
          status: 'active',
          topic: 'brief',
          uri: 'threadnote://share/share-1/memories/durable/threadnote/brief.md',
        },
      ],
      trackRateLimits: true,
    });
    const response = await json(
      await test.handler(
        mcpRequest({
          id: 3_150,
          method: 'tools/call',
          params: {
            arguments: {
              anchors: [{path: 'apps/threadnote/src/remote_memory/tools.ts', repositoryId: 'a'.repeat(64)}],
              budgetTokens: 800,
              project: 'threadnote',
              task: 'Explain the remote brief boundary.',
              version: 1,
            },
            name: 'context_brief',
          },
        }),
      ),
    );
    const result = response.result as {content: readonly {text: string}[]; structuredContent: Record<string, unknown>};
    expect(result.structuredContent.type).toBe('threadnote-remote-context-brief');
    expect(result.content[0]?.text).toContain('capture-time provenance');
    expect(result.content[0]?.text).toContain('threadnote-local');
    expect(test.calls).toContain('brief:request-123:Explain the remote brief boundary.');
    expect(test.calls).toContain('rate:context_brief');

    const denied = fixture({allowedProjects: new Set(['other']), trackRateLimits: true});
    const deniedResponse = await json(
      await denied.handler(
        mcpRequest({
          id: 3_151,
          method: 'tools/call',
          params: {arguments: {project: 'threadnote', task: 'Denied.', version: 1}, name: 'context_brief'},
        }),
      ),
    );
    expect(deniedResponse).toMatchObject({result: {isError: true, structuredContent: {code: 'forbidden'}}});
    expect(denied.calls.some(call => call.startsWith('brief:'))).toBe(false);
  });

  it.each([{policyVersion: 'wrong-grant-policy'}, {sharePolicyVersion: 'wrong-share-policy'}])(
    'rejects a repository receipt whose grant/share policy attestation differs: %#',
    async receipt => {
      const test = fixture({receipt});
      const response = await test.handler(
        mcpRequest({id: 301, method: 'tools/call', params: {arguments: {version: 1}, name: 'memory_status'}}),
      );

      expect(await json(response)).toMatchObject({
        id: 301,
        result: {isError: true, structuredContent: {code: 'service_unavailable'}},
      });
    },
  );

  it('rejects extra tool fields before rate limiting or storage dispatch', async () => {
    const test = fixture({trackRateLimits: true});
    const response = await test.handler(
      mcpRequest({
        id: 31,
        method: 'tools/call',
        params: {arguments: {unexpected: 'must-not-be-ignored', version: 1}, name: 'memory_status'},
      }),
    );
    const payload = await json(response);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({id: 31, result: {isError: true}});
    expect(JSON.stringify(payload)).toContain('unexpected');
    expect(JSON.stringify(payload)).not.toContain('must-not-be-ignored');
    expect(test.calls.some(call => call.startsWith('rate:') || call.startsWith('status:'))).toBe(false);
  });

  it('reads canonical resources through the same share, scope, rate, and correlation boundary', async () => {
    const test = fixture({trackRateLimits: true});
    const uri = 'threadnote://share/share-1/memories/durable/threadnote/fixture.md';
    const response = await test.handler(mcpRequest({id: 32, method: 'resources/read', params: {uri}}));
    const payload = await json(response);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      id: 32,
      result: {
        contents: [
          {
            mimeType: 'text/markdown',
            text: expect.stringContaining('Fixture body'),
            uri,
          },
        ],
      },
    });
    expect(test.calls).toContain('rate:read_context');
    expect(test.calls).toContain('read:request-123');
  });

  it('exposes read revision and source receipts to clients that consume only text blocks', async () => {
    const test = fixture();
    const uri = 'threadnote://share/share-1/memories/durable/threadnote/fixture.md';
    const response = await test.handler(
      mcpRequest({id: 3_200, method: 'tools/call', params: {arguments: {uri, version: 1}, name: 'read_context'}}),
    );
    const payload = await json(response);
    const result = payload.result as {
      content: readonly {text: string}[];
      structuredContent: {revision: string; receipt: unknown};
    };
    expect(result.content[0].text).toContain('Fixture body');
    const sourceText = result.content.at(-1)!.text;
    const source = JSON.parse(sourceText.slice(sourceText.indexOf('\n') + 1));
    expect(source).toMatchObject({
      uri,
      revision: result.structuredContent.revision,
      receipt: result.structuredContent.receipt,
      trust: 'untrusted',
    });
    expect(sourceText).not.toContain('Fixture body');
  });

  it('refuses a 1 MB remote memory with an outline instead of paged reconstruction', async () => {
    const prefix = 'MEMORY\nkind: durable\n\n# Ledger\n## Open\nREMOTE_PRIVATE_SENTINEL\n';
    const content = `${prefix}${'x'.repeat(1_000_000 - prefix.length)}`;
    const test = fixture({readContent: content, trackRateLimits: true});
    const uri = 'threadnote://share/share-1/memories/durable/threadnote/fixture.md';
    const response = await test.handler(
      mcpRequest({
        id: 4_000,
        method: 'tools/call',
        params: {arguments: {uri, version: 1}, name: 'read_context'},
      }),
    );
    const payload = await json(response);
    const result = payload.result as {
      readonly content?: readonly {readonly text?: string; readonly type?: string}[];
      readonly isError?: boolean;
      readonly structuredContent?: Readonly<Record<string, unknown>>;
    };
    expect(result.isError, JSON.stringify(payload)).toBe(true);
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain(`${REMOTE_MEMORY_RESOURCE_READ_MAX_BYTES} bytes`);
    expect(text).toContain('mode=outline');
    expect(text).toContain('## Open');
    expect(text).not.toContain('REMOTE_PRIVATE_SENTINEL');
    expect(text).not.toContain('x'.repeat(80));
    expect(JSON.stringify(payload)).not.toContain('REMOTE_PRIVATE_SENTINEL');
    expect(test.readInputs).toEqual([{uri}]);
    expect(test.calls.filter(call => call === 'rate:read_context')).toEqual(['rate:read_context']);
  });

  it('explicitly pages an oversized heading-less remote memory with a stable source hash', async () => {
    const content = `MEMORY\nkind: durable\n\n${'🙂'.repeat(28_000)}`;
    const test = fixture({readContent: content});
    const uri = 'threadnote://share/share-1/memories/durable/threadnote/fixture.md';
    let offsetBytes = 0;
    let sourceHash: string | undefined;
    const parts: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      const response = await test.handler(
        mcpRequest({
          id: 5_000 + index,
          method: 'tools/call',
          params: {arguments: {uri, version: 1, offsetBytes, sourceHash}, name: 'read_context'},
        }),
      );
      const payload = await json(response);
      const result = payload.result as {
        readonly content: readonly {readonly text: string}[];
        readonly isError?: boolean;
        readonly structuredContent: {
          readonly complete: boolean;
          readonly content: string;
          readonly nextOffsetBytes?: number;
          readonly sourceHash: string;
          readonly totalBytes: number;
        };
      };
      expect(result.isError, JSON.stringify(payload)).not.toBe(true);
      const page = result.structuredContent;
      expect(result.content[0]?.text).toBe(page.content);
      if (!page.complete) expect(result.content[1]?.text).toContain('Incomplete memory page');
      expect(page.totalBytes).toBe(Buffer.byteLength(content, 'utf8'));
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
  });

  it('refuses to expose an oversized remote memory through resources/read', async () => {
    const privateBody = `REMOTE_RESOURCE_PRIVATE_SENTINEL\n${'x'.repeat(70_000)}`;
    const test = fixture({readContent: privateBody});
    const uri = 'threadnote://share/share-1/memories/durable/threadnote/fixture.md';
    const response = await test.handler(mcpRequest({id: 321, method: 'resources/read', params: {uri}}));
    const serialized = JSON.stringify(await json(response));

    expect(serialized).toContain('resources/read cap');
    expect(serialized).toContain('mode=outline or section');
    expect(serialized).not.toContain('REMOTE_RESOURCE_PRIVATE_SENTINEL');
  });

  it('rejects resource traversal to a different share without reading storage', async () => {
    const test = fixture({trackRateLimits: true});
    const response = await test.handler(
      mcpRequest({
        id: 33,
        method: 'resources/read',
        params: {uri: 'threadnote://share/share-2/memories/durable/threadnote/fixture.md'},
      }),
    );
    const payload = await json(response);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({error: {code: -32_603}, id: 33});
    expect(JSON.stringify(payload)).not.toContain('Fixture body');
    expect(test.calls.some(call => call.startsWith('rate:') || call.startsWith('read:'))).toBe(false);
  });

  it('confines read tools and resources to authorized URI projects before storage dispatch', async () => {
    const test = fixture({allowedProjects: new Set(['threadnote']), trackRateLimits: true});
    const crossProjectUri = 'threadnote://share/share-1/memories/durable/private-project/fixture.md';
    const toolResponse = await test.handler(
      mcpRequest({
        id: 331,
        method: 'tools/call',
        params: {arguments: {uri: crossProjectUri, version: 1}, name: 'read_context'},
      }),
    );
    const resourceResponse = await test.handler(
      mcpRequest({id: 332, method: 'resources/read', params: {uri: crossProjectUri}}),
    );

    expect(await json(toolResponse)).toMatchObject({
      id: 331,
      result: {isError: true, structuredContent: {code: 'forbidden'}},
    });
    expect(await json(resourceResponse)).toMatchObject({error: {code: -32_603}, id: 332});
    expect(test.calls.some(call => call.startsWith('read:'))).toBe(false);
  });

  it('returns a bounded rate-limit tool error without invoking storage', async () => {
    const test = fixture({rateLimitFailure: true, trackRateLimits: true});
    const response = await test.handler(
      mcpRequest({id: 34, method: 'tools/call', params: {arguments: {version: 1}, name: 'memory_status'}}),
    );
    const payload = await json(response);
    const serialized = JSON.stringify(payload);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      id: 34,
      result: {
        isError: true,
        structuredContent: {
          code: 'rate_limited',
          details: {retryAfterSeconds: 17},
          requestId: 'request-123',
        },
      },
    });
    expect(serialized.length).toBeLessThan(600);
    expect(test.calls).toContain('rate:memory_status');
    expect(test.calls.some(call => call.startsWith('status:'))).toBe(false);
  });

  it('maps unexpected storage failures to a generic error without leaking memory or bearer tokens', async () => {
    const secretToken = 'bearer-token-that-must-not-leak';
    const privateMemory = 'private memory body that must not leak';
    const test = fixture({repositoryFailure: new Error(`${secretToken}: ${privateMemory}`)});
    const uri = 'threadnote://share/share-1/memories/durable/threadnote/fixture.md';
    const response = await test.handler(
      mcpRequest(
        {id: 35, method: 'tools/call', params: {arguments: {uri, version: 1}, name: 'read_context'}},
        {token: secretToken},
      ),
    );
    const payload = await json(response);
    const result = payload.result as {content: readonly {text: string}[]};
    const errorText = result.content.at(-1)!.text;
    expect(JSON.parse(errorText.slice(errorText.indexOf('\n') + 1))).toEqual({
      code: 'service_unavailable',
      details: {},
      requestId: 'request-123',
    });
    const serialized = JSON.stringify(payload);

    expect(serialized).toContain('service_unavailable');
    expect(serialized).not.toContain(secretToken);
    expect(serialized).not.toContain(privateMemory);
    expect(serialized.length).toBeLessThan(600);
  });

  it('returns a bounded tool error when a write scope is missing and never reaches storage', async () => {
    const test = fixture({capabilities: ['memory:read']});
    const response = await test.handler(
      mcpRequest({
        id: 4,
        method: 'tools/call',
        params: {
          arguments: {
            kind: 'durable',
            operationId: 'operation-1',
            project: 'threadnote',
            text: 'bounded fixture',
            topic: 'remote',
            version: 1,
          },
          name: 'remember_context',
        },
      }),
    );
    const payload = await json(response);

    expect(payload).toMatchObject({
      result: {isError: true, structuredContent: {code: 'forbidden', requestId: 'request-123'}},
    });
    expect(test.calls.some(call => call.startsWith('remember:'))).toBe(false);
  });

  it('is POST-only and rejects declared oversized bodies before OAuth', async () => {
    const test = fixture();
    const get = await test.handler(
      new Request('https://memory.example.test/mcp', {headers: {host: 'memory.example.test'}, method: 'GET'}),
    );
    const oversized = mcpRequest({id: 5, method: 'tools/list', params: {}});
    oversized.headers.set('content-length', '999999');
    const rejected = await test.handler(oversized);

    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect(rejected.status).toBe(400);
    expect(test.calls).toEqual([]);
  });

  it('rejects extra attestation-completion fields without reflecting the workload token', async () => {
    const test = fixture();
    const token = 'cursor-workload-token-that-must-not-leak';
    const response = await test.handler(
      new Request('https://memory.example.test/attest/cursor/complete', {
        body: JSON.stringify({challengeId: 'challenge-1', token, unexpected: true}),
        headers: {
          'content-type': 'application/json',
          host: 'memory.example.test',
          origin: 'https://cursor.com',
        },
        method: 'POST',
      }),
    );
    const serialized = JSON.stringify(await json(response));

    expect(response.status).toBe(400);
    expect(serialized).toContain('unsupported fields');
    expect(serialized).not.toContain(token);
    expect(test.calls).toEqual([]);
  });

  it('serves the in-process OAuth issuer next to protected-resource metadata', async () => {
    const idp = await createLocalIdp({
      audience: 'https://memory.example.test/mcp',
      issuer: 'https://memory.example.test',
      subject: 'local:tester',
    });
    const test = fixture({localIdp: idp});
    const headers = {host: 'memory.example.test'};
    const metadata = await test.handler(
      new Request('https://memory.example.test/.well-known/oauth-authorization-server', {headers}),
    );
    const jwks = await test.handler(new Request('https://memory.example.test/.well-known/jwks.json', {headers}));
    const protectedResource = await test.handler(
      new Request('https://memory.example.test/.well-known/oauth-protected-resource', {headers}),
    );

    expect(metadata.status).toBe(200);
    expect(await json(metadata)).toMatchObject({
      authorization_endpoint: 'https://memory.example.test/authorize',
      issuer: 'https://memory.example.test',
      jwks_uri: 'https://memory.example.test/.well-known/jwks.json',
      token_endpoint: 'https://memory.example.test/token',
    });
    expect((await json(jwks)).keys).toEqual([expect.objectContaining({alg: 'RS256', kid: expect.any(String)})]);
    expect(await json(protectedResource)).toMatchObject({
      authorization_servers: ['https://auth.example.test'],
      resource: 'https://memory.example.test/mcp',
    });
  });

  it('accepts the Cursor OAuth callback Origin on loopback when listed', async () => {
    const test = fixture({allowedOrigins: ['https://cursor.com', 'http://127.0.0.1:8787']});
    const response = await test.handler(
      mcpRequest({id: 31, method: 'tools/list', params: {}}, {origin: 'http://127.0.0.1:8787'}),
    );

    expect(response.status).toBe(200);
    expect(test.calls).toContain('oauth:fixture-token');
  });
});
