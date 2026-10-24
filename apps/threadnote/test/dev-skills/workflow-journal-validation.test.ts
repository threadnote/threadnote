import {gzipSync} from 'fflate';
import {createHash} from '@threadnote/testing/node-crypto';
import {
  decodeWorkflowJournal,
  encodeWorkflowJournal,
  workflowJournalLimits,
} from '../../src/workflow_memory/journal_codec.js';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {
  formatMemoryDocument,
  memoryArchiveBody,
  memoryArchiveMetadata,
  parseMemoryDocument,
} from '@threadnote/memory/document';
import {createMemoryCodeCitation, MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {assertWorkflowJournalIntegrity, workflowOwnedArtifacts} from '../../src/workflow_memory/journal_validation.js';
import {serializeWorkflowJournal} from '../../src/workflow_memory/journal.js';
import {
  stableJson,
  type WorkflowArtifact,
  type WorkflowBinding,
  type WorkflowJournal,
  type WorkflowOperation,
  type WorkflowRequest,
} from '../../src/workflow_memory/protocol.js';

const timestamp = '2026-10-20T12:00:00.000Z';
const identity = {
  workflowRunId: 'run-1',
  profile: 'desktop' as const,
  project: 'fixture',
  featureId: 'feature',
  generation: 'v1',
  home: '/fixture/home',
  repo: '/fixture/repo',
  account: 'local',
  user: 'tester',
  agentId: 'test',
  sharedRoots: [],
  artifactLifetime: 'local-home' as const,
};
const binding: WorkflowBinding = {...identity, bindingId: sha256HexSync(stableJson(identity))};
const prefix = `workflow-${binding.bindingId}-`;
const activeRoot = 'threadnote://user/tester/memories/handoffs/active/fixture';
const manifestUri = `${activeRoot}/${prefix}manifest.md`;
function manifest(artifacts: WorkflowJournal['artifacts'], stamp = timestamp): string {
  return formatMemoryDocument(
    'MEMORY',
    {
      kind: 'handoff',
      status: 'active',
      project: binding.project,
      topic: `${prefix}manifest`,
      memoryId: `tn_${binding.bindingId.slice(0, 20)}`,
      timestamp: stamp,
      sourceAgentClient: 'threadnote',
      sourceSessionId: binding.workflowRunId,
    },
    stableJson({protocolVersion: 1, binding, artifacts}),
  );
}
function state(
  artifacts: WorkflowJournal['artifacts'] = {},
  operations: WorkflowJournal['operations'] = {},
): WorkflowJournal {
  return {
    protocolVersion: 1,
    binding,
    artifacts,
    operations,
    manifestUri,
    manifestContent: manifest(artifacts),
    manifestCommitted: true,
  };
}
function create(key = 'draft'): WorkflowOperation {
  const body = 'Private workflow state.\n';
  const request: WorkflowRequest = {
    protocolVersion: 1,
    action: 'create',
    bindingId: binding.bindingId,
    operationId: `create-${key}`,
    sourceRunId: 'writer',
    artifactKey: key,
    role: 'root',
    body,
    bodySha256: sha256HexSync(body),
    expectedRevision: null,
  };
  const memoryId = `tn_${sha256HexSync(`${binding.bindingId}\nwriter\n${key}`).slice(0, 20)}`;
  const canonicalUri = `${activeRoot}/${prefix}${key}.md`;
  const desired = formatMemoryDocument(
    'MEMORY',
    {
      kind: 'handoff',
      status: 'active',
      project: binding.project,
      topic: `${prefix}${key}`,
      memoryId,
      schemaVersion: MEMORY_SCHEMA_VERSION,
      timestamp,
      sourceAgentClient: 'threadnote',
      sourceSessionId: binding.workflowRunId,
    },
    body,
  );
  return {
    request,
    intentDigest: sha256HexSync(stableJson(request)),
    desired,
    relations: [],
    status: 'prepared',
    artifact: {
      artifactKey: key,
      sourceRunId: 'writer',
      role: 'root',
      canonicalUri,
      memoryId,
      revision: sha256HexSync(desired),
      bodySha256: sha256HexSync(body),
      storageKind: 'handoff',
      state: 'active',
    },
  };
}
function archive(source: WorkflowOperation): WorkflowOperation {
  const original = parseMemoryDocument(source.artifact.canonicalUri, source.desired)!;
  const request: WorkflowRequest = {
    protocolVersion: 1,
    action: 'archive',
    bindingId: binding.bindingId,
    operationId: 'retire',
    artifactKey: source.artifact.artifactKey,
    sourceRunId: source.artifact.sourceRunId,
    role: source.artifact.role,
    uri: source.artifact.canonicalUri,
    expectedRevision: source.artifact.revision,
  };
  const canonicalUri = `threadnote://user/tester/memories/handoffs/archived/fixture/${prefix}archive-retire.md`;
  const desired = formatMemoryDocument(
    'MEMORY',
    memoryArchiveMetadata(original.metadata, {
      archivedFrom: source.artifact.canonicalUri,
      timestamp,
      sourceAgentClient: 'threadnote',
    }),
    memoryArchiveBody(original.body),
  );
  return {
    request,
    intentDigest: sha256HexSync(stableJson(request)),
    desired,
    before: source.desired,
    sourceUri: source.artifact.canonicalUri,
    relations: [],
    status: 'prepared',
    artifact: {
      ...source.artifact,
      canonicalUri,
      state: 'archived',
      revision: sha256HexSync(desired),
    },
  };
}
const map = (artifact: WorkflowArtifact) => ({[artifact.canonicalUri]: artifact});
const operations = (...values: WorkflowOperation[]) =>
  Object.fromEntries(values.map(value => [value.request.operationId!, value]));

describe('workflow journal ownership validation', () => {
  it('rejects map edits while the saved native manifest still agrees with the original bytes', () => {
    const original = state();
    const foreign = create('foreign').artifact;
    expect(() =>
      assertWorkflowJournalIntegrity({...original, artifacts: map(foreign)}, original.manifestContent),
    ).toThrow();
    const rebound = {...binding, featureId: 'other'};
    expect(() => assertWorkflowJournalIntegrity({...original, binding: rebound}, original.manifestContent)).toThrow();
    const changedUri = {...original, manifestUri: `${activeRoot}/some-other-manifest.md`};
    expect(() => assertWorkflowJournalIntegrity(changedUri, changedUri.manifestContent)).toThrow();
  });

  it('accepts deterministic prepared destinations and rejects forged destinations, identities and request bytes', () => {
    const created = create();
    const prepared = {...created, request: {...created.request, mutation: undefined}};
    const original = state({}, operations(prepared));
    expect(() => assertWorkflowJournalIntegrity(original, original.manifestContent)).not.toThrow();
    for (const change of [
      {...prepared, artifact: {...prepared.artifact, canonicalUri: `${activeRoot}/private.md`}},
      {...prepared, artifact: {...prepared.artifact, memoryId: 'tn_00000000000000000000'}},
      {...prepared, request: {...prepared.request, artifactKey: 'different'}},
      {...prepared, desired: prepared.desired.replace('Private workflow', 'Changed workflow')},
    ]) {
      const edited = state({}, operations(change));
      expect(() => assertWorkflowJournalIntegrity(edited, edited.manifestContent)).toThrow();
    }
  });

  it('requires current ownership and a self-consistent CAS preimage while allowing refreshed native bytes', () => {
    const created = {...create(), status: 'verified' as const};
    const retired = archive(created);
    const valid = state(map(created.artifact), operations(created, retired));
    expect(() => assertWorkflowJournalIntegrity(valid, valid.manifestContent)).not.toThrow();
    const missing = state({}, operations(created, retired));
    expect(() => assertWorkflowJournalIntegrity(missing, missing.manifestContent)).toThrow();
    const altered = state(map({...created.artifact, revision: 'a'.repeat(64)}), operations(created, retired));
    expect(() => assertWorkflowJournalIntegrity(altered, altered.manifestContent)).not.toThrow();
    const badRevision = {...retired, request: {...retired.request, expectedRevision: 'b'.repeat(64)}};
    const inconsistent = {...badRevision, intentDigest: sha256HexSync(stableJson(badRevision.request))};
    const badState = state(map(created.artifact), operations(created, inconsistent));
    expect(() => assertWorkflowJournalIntegrity(badState, badState.manifestContent)).toThrow();
    const foreignTarget = {
      ...retired,
      relations: [{uri: `${activeRoot}/private.md`, content: created.desired, memoryId: created.artifact.memoryId}],
    };
    const relationState = state(map(created.artifact), operations(created, foreignTarget));
    expect(() => assertWorkflowJournalIntegrity(relationState, relationState.manifestContent)).toThrow();
  });

  it('recovers only operation-backed manifest deltas, including creation and retirement', () => {
    const empty = state();
    const created = {...create(), status: 'verified' as const};
    const next = {
      ...state(map(created.artifact), operations(created)),
      manifestCommitted: false,
      previousManifestContent: empty.manifestContent,
    };
    expect(() => assertWorkflowJournalIntegrity(next, empty.manifestContent)).not.toThrow();
    const invented = {...next, artifacts: {...next.artifacts, ...map(create('invented').artifact)}};
    expect(() =>
      assertWorkflowJournalIntegrity(
        {...invented, manifestContent: manifest(invented.artifacts)},
        empty.manifestContent,
      ),
    ).toThrow();
    const retired = {...archive(created), status: 'verified' as const};
    const final = {
      ...state(map(retired.artifact), operations(created, retired)),
      manifestCommitted: false,
      previousManifestContent: next.manifestContent,
    };
    expect(() => assertWorkflowJournalIntegrity(final, next.manifestContent)).not.toThrow();
    expect(() => assertWorkflowJournalIntegrity({...next, previousManifestContent: undefined}, undefined)).toThrow();
    const initial = {...empty, manifestCommitted: false};
    expect(() => assertWorkflowJournalIntegrity(initial, undefined)).not.toThrow();
  });

  it('requires prepared relation receipts to match the authored edge without broadening their read scope', () => {
    const target = {...create('target'), status: 'verified' as const};
    const original = create();
    const alias = `threadnote://memory/${target.artifact.memoryId}`;
    const request = {...original.request, relations: [{type: 'references' as const, uri: alias}]};
    const record = parseMemoryDocument(original.artifact.canonicalUri, original.desired)!;
    const desired = formatMemoryDocument(
      record.headerTitle,
      {...record.metadata, relations: request.relations},
      record.body,
    );
    const linked: WorkflowOperation = {
      ...original,
      request,
      desired,
      intentDigest: sha256HexSync(stableJson(request)),
      artifact: {...original.artifact, revision: sha256HexSync(desired)},
      relations: [
        {
          uri: target.artifact.canonicalUri,
          content: target.desired,
          memoryId: target.artifact.memoryId,
          allowedUriScopes: [target.artifact.canonicalUri],
        },
      ],
    };
    const linkedState = (operation: WorkflowOperation) => state(map(target.artifact), operations(target, operation));
    const valid = linkedState(linked);
    expect(() => assertWorkflowJournalIntegrity(valid, valid.manifestContent)).not.toThrow();
    for (const modified of [
      {...linked, relations: []},
      {...linked, relations: [{...linked.relations[0], allowedUriScopes: ['threadnote://user/tester/memories']}]},
      {...linked, relations: [{...linked.relations[0], allowedUriScopes: undefined}]},
    ]) {
      const invalid = linkedState(modified);
      expect(() => assertWorkflowJournalIntegrity(invalid, invalid.manifestContent)).toThrow();
    }
  });

  it('never expands ownership from verified historical receipts, across any bounded archive history', () => {
    fc.assert(
      fc.property(fc.integer({min: 1, max: 12}), count => {
        const history = Array.from({length: count}, (_, index) => ({
          ...create(`draft-${index}`),
          status: 'verified' as const,
        }));
        const final = {...archive(history.at(-1)!), status: 'verified' as const};
        const closed = state(map(final.artifact), operations(...history, final));
        assertWorkflowJournalIntegrity(closed, closed.manifestContent);
        expect(workflowOwnedArtifacts(closed)).toEqual([final.artifact]);
        for (const old of history)
          expect(workflowOwnedArtifacts(closed).some(item => item.canonicalUri === old.artifact.canonicalUri)).toBe(
            false,
          );
      }),
      {numRuns: 20},
    );
  });

  it('accepts only the exact citation-only postimage when recovering native enrichment', () => {
    const original = {...create(), status: 'verified' as const};
    const originalState = state(map(original.artifact), operations(original));
    const record = parseMemoryDocument(original.artifact.canonicalUri, original.desired)!;
    const citation = createMemoryCodeCitation({
      extractorSet: 'test',
      fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
      path: 'src/value.ts',
      repositoryId: 'b'.repeat(64),
      repositoryIdentityKind: 'remote',
      sourceCommit: 'c'.repeat(40),
      sourceDirty: false,
      sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
      target: {kind: 'file'},
      version: 1,
    });
    const desired = formatMemoryDocument(
      'MEMORY',
      {...record.metadata, codeCitations: [citation], sourceCommit: citation.sourceCommit, sourceObservedAt: timestamp},
      record.body,
    );
    const enriched: WorkflowOperation = {
      ...original,
      desired,
      artifact: {...original.artifact, revision: sha256HexSync(desired)},
      deferredCodeAnchor: {
        callerCwd: binding.repo,
        project: binding.project,
        codeRefs: [],
        recovery: {
          code: 'ready-graph-unavailable',
          indexingStarted: false,
          observedGraph: {freshness: 'stale', readySnapshot: 'absent', stale: true},
          preparation: {
            action: 'index-current-graph',
            arguments: [],
            command: 'threadnote graph index --no-vectors',
            target: 'callerCwd',
          },
          recovery: 'prepare-current-graph',
          retryCondition: 'after-current-graph-ready',
          retryable: true,
          type: 'memory-code-citation-capture-recovery',
          version: 1,
        },
      },
    };
    const transition = (operation: WorkflowOperation) => ({
      ...state(map(operation.artifact), operations(operation)),
      manifestCommitted: false,
      previousManifestContent: originalState.manifestContent,
    });
    expect(() => assertWorkflowJournalIntegrity(transition(enriched), originalState.manifestContent)).not.toThrow();
    const changed = desired.replace(timestamp, '2026-10-19T12:00:00.000Z');
    const forged = {...enriched, desired: changed, artifact: {...enriched.artifact, revision: sha256HexSync(changed)}};
    expect(() => assertWorkflowJournalIntegrity(transition(forged), originalState.manifestContent)).toThrow();
  });

  it('keeps plain journals compatible and rejects logical journals beyond the expanded limit', () => {
    const original = state();
    expect(serializeWorkflowJournal(original)).toContain('"protocolVersion":1');
    expect(() => serializeWorkflowJournal({...original, manifestContent: 'x'.repeat(64 * 1024 * 1024)})).toThrow(
      expect.objectContaining({code: 'journal-capacity'}),
    );
  });
});

const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const format = 'threadnote-workflow-journal-gzip-v1';
describe('workflow journal codec', async () => {
  it('keeps legacy plaintext capacity when compressed encoding would be larger', async () => {
    const data = new Uint8Array(2 * 1024 * 1024);
    let seed = 0x12345678;
    for (let index = 0; index < data.length; index++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      data[index] = seed & 255;
    }
    const logical = `${JSON.stringify({payload: Buffer.from(data).toString('base64')})}\n`;
    const encoded = encodeWorkflowJournal(logical);
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(Buffer.byteLength(logical));
    expect(await decodeWorkflowJournal(encoded)).toBe(logical);
  });

  it('round trips unicode JSON losslessly and emits deterministic bytes', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.string(), {minLength: 64, maxLength: 128}), async values => {
        const varied = `🧭雪é${values.join(' | ')}`;
        const logical = `${JSON.stringify({values: Array.from({length: Math.ceil(1_100_000 / varied.length)}, () => varied), sentinel: '🧭'})}\n`;
        const encoded = encodeWorkflowJournal(logical);
        expect(encoded).not.toBe(logical);
        expect(encodeWorkflowJournal(logical)).toBe(encoded);
        expect(JSON.parse(await decodeWorkflowJournal(encoded))).toEqual(JSON.parse(logical));
      }),
      {numRuns: 8},
    );
  });

  it('compresses a large legitimate shaped history while preserving every receipt byte', async () => {
    const operations = Object.fromEntries(
      Array.from({length: 91}, (_, index) => {
        const content = `relation-document-${index}\n${'shared relation content '.repeat(3_000)}`;
        return [
          `operation-${index}`,
          {
            request: {operationId: `operation-${index}`, body: `body-${index}`},
            before: content,
            desired: content,
            relations: [{uri: `threadnote://fixture/${index}`, content}],
            status: 'verified',
          },
        ];
      }),
    );
    const logical = `${JSON.stringify({protocolVersion: 1, binding: {}, artifacts: {}, operations, manifestCommitted: true, manifestUri: 'threadnote://fixture/manifest', manifestContent: 'manifest'})}\n`;
    expect(new TextEncoder().encode(logical).byteLength).toBeGreaterThan(16 * 1024 * 1024);
    const encoded = encodeWorkflowJournal(logical);
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThan(16 * 1024 * 1024);
    expect(JSON.parse(await decodeWorkflowJournal(encoded))).toEqual(JSON.parse(logical));
  });

  it('reads existing plain JSON and rejects malformed envelopes, gzip integrity failures and expansion limits', async () => {
    expect(await decodeWorkflowJournal('{"protocolVersion":1}\n')).toBe('{"protocolVersion":1}\n');
    const plain = new TextEncoder().encode('{"ok":true}\n');
    const good = JSON.parse(
      JSON.stringify({
        format,
        expandedBytes: plain.byteLength,
        sha256: digest(plain),
        payload: btoa(String.fromCharCode(...gzipSync(plain, {mtime: 0}))),
      }),
    ) as Record<string, unknown>;
    expect(await decodeWorkflowJournal(JSON.stringify(good))).toBe('{"ok":true}\n');
    // Readers must not depend on the writer's compressor version or options.
    expect(
      await decodeWorkflowJournal(
        JSON.stringify({
          ...good,
          payload: btoa(String.fromCharCode(...gzipSync(plain, {level: 0, mtime: 42}))),
        }),
      ),
    ).toBe('{"ok":true}\n');
    for (const bad of [
      {...good, payload: `${String(good.payload).slice(0, -4)}!!!!`},
      {...good, expandedBytes: workflowJournalLimits.logicalBytes + 1},
      {...good, extra: true},
      {...good, sha256: '0'.repeat(64)},
    ])
      await expect(decodeWorkflowJournal(JSON.stringify(bad))).rejects.toThrow();
    const truncated = {
      ...good,
      payload: btoa(String.fromCharCode(...gzipSync(plain).subarray(0, 10))),
      expandedBytes: 1,
    };
    await expect(decodeWorkflowJournal(JSON.stringify(truncated))).rejects.toThrow();
    const corrupt = gzipSync(plain, {mtime: 0});
    corrupt[corrupt.length - 8] ^= 1;
    await expect(
      decodeWorkflowJournal(JSON.stringify({...good, payload: btoa(String.fromCharCode(...corrupt))})),
    ).rejects.toThrow();
    const concatenated = new Uint8Array([...gzipSync(plain), ...gzipSync(plain)]);
    await expect(
      decodeWorkflowJournal(JSON.stringify({...good, payload: btoa(String.fromCharCode(...concatenated))})),
    ).rejects.toThrow();
    const trailing = new Uint8Array([...gzipSync(plain), 0]);
    await expect(
      decodeWorkflowJournal(JSON.stringify({...good, payload: btoa(String.fromCharCode(...trailing))})),
    ).rejects.toThrow();
    const emptyMember = new Uint8Array([...gzipSync(plain), ...gzipSync(new Uint8Array())]);
    expect(
      await decodeWorkflowJournal(JSON.stringify({...good, payload: Buffer.from(emptyMember).toString('base64')})),
    ).toBe('{"ok":true}\n');
    const tooSmall = {...good, expandedBytes: plain.byteLength - 1};
    await expect(decodeWorkflowJournal(JSON.stringify(tooSmall))).rejects.toThrow();
    const unknownFormat = {...good, format: 'threadnote-workflow-journal-gzip-v99'};
    await expect(decodeWorkflowJournal(JSON.stringify(unknownFormat))).rejects.toThrow();
    expect(await decodeWorkflowJournal(` ${JSON.stringify(good)}`)).toBe('{"ok":true}\n');
    const filenameHeader = new Uint8Array(1024 * 1024);
    filenameHeader.set(gzipSync(plain).subarray(0, 10));
    filenameHeader[3] = 8;
    filenameHeader.fill(65, 10);
    // A second malformed optional header used to bypass the first-header guard
    // and make the JS decoder repeatedly scan/copy the entire pending header.
    for (const payload of [filenameHeader, new Uint8Array([...gzipSync(plain), ...filenameHeader])]) {
      await expect(
        decodeWorkflowJournal(JSON.stringify({...good, payload: Buffer.from(payload).toString('base64')})),
      ).rejects.toThrow();
    }
    const aborted = new AbortController();
    aborted.abort();
    await expect(decodeWorkflowJournal(JSON.stringify(good), aborted.signal)).rejects.toThrow();
  });
});
