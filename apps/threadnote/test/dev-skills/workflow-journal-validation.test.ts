import {gzipSync} from 'fflate';
import {gunzipSync} from 'node:zlib';
import {createHash} from '@threadnote/testing/node-crypto';
import {
  decodeBoundedWorkflowJson,
  decodeWorkflowJournal,
  encodeBoundedWorkflowJson,
  encodeWorkflowJournal,
  workflowJournalLimits,
} from '../../src/workflow_memory/journal_codec.js';
import {describe, expect, it, vi} from 'vitest';
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
import {assertWorkflowJournalCapacity, serializeWorkflowJournal} from '../../src/workflow_memory/journal.js';
import {workflowJournalStorageImagePair} from '../../src/workflow_memory/journal_storage.js';
import {
  workflowArtifactTopic,
  workflowArtifactUri,
  workflowArchiveUri,
  workflowStateTopic,
} from '../../src/workflow_memory/naming.js';
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
const envelopeFor = (plain: Uint8Array, compressed: Uint8Array, marker = format) =>
  JSON.stringify({
    format: marker,
    expandedBytes: plain.byteLength,
    sha256: digest(plain),
    payload: Buffer.from(compressed).toString('base64'),
  });
describe('workflow journal codec', async () => {
  it('keeps both pair images byte-equal when their independent capacity checks straddle the disk limit', async () => {
    const empty = {...state(), manifestCommitted: false, manifestContent: ''};
    const overhead = new TextEncoder().encode(workflowJournalStorageImagePair(empty).prepared()).byteLength;
    for (const targetBytes of [workflowJournalLimits.diskBytes, workflowJournalLimits.diskBytes + 1]) {
      const prepared = {...empty, manifestContent: 'x'.repeat(targetBytes - overhead)};
      const pair = workflowJournalStorageImagePair(prepared);
      expect(new TextEncoder().encode(pair.prepared()).byteLength).toBe(targetBytes);
      expect(new TextEncoder().encode(pair.committed()).byteLength).toBe(targetBytes - 1);
      for (const manifestCommitted of [false, true]) {
        const sibling = {...prepared, manifestCommitted};
        const content = manifestCommitted ? pair.committed() : pair.prepared();
        const encoded = encodeWorkflowJournal(content);
        expect(encoded).toBe(serializeWorkflowJournal(sibling, true));
        expect(() => assertWorkflowJournalCapacity(sibling, true)).not.toThrow();
        expect(await decodeWorkflowJournal(encoded)).toBe(content);
      }
    }
  });

  it('preserves ordinary serializer fallback for getters and toJSON', () => {
    let reads = 0;
    const accessor = Object.freeze({
      get text() {
        reads += 1;
        return '雪\ud800x\udfff';
      },
    });
    let conversions = 0;
    const withToJSON = Object.freeze({
      toJSON() {
        conversions += 1;
        return {converted: 'ordinary'};
      },
    });
    for (const extension of [accessor, withToJSON]) {
      const input = {...state(), extension};
      const expected = encodeWorkflowJournal(stableJson(input) + '\n');
      const expectedReads = reads;
      const expectedConversions = conversions;
      reads = 0;
      conversions = 0;
      expect(serializeWorkflowJournal(input)).toBe(expected);
      expect(reads).toBe(expectedReads);
      expect(conversions).toBe(expectedConversions);
      reads = 0;
      conversions = 0;
    }
  });

  it('emits deterministic native gzip readable by independent zlib and journal readers', async () => {
    const logical = `${JSON.stringify({payload: 'UTF-8 journal — 雪 and 🌊. '.repeat(90_000)})}\n`;
    const encoded = encodeWorkflowJournal(logical);
    expect(encodeWorkflowJournal(logical)).toBe(encoded);
    const envelope = JSON.parse(encoded) as {format: string; payload: string};
    expect(envelope.format).toBe(format);
    const compressed = Uint8Array.from(atob(envelope.payload), character => character.charCodeAt(0));
    expect(compressed.slice(4, 8)).toEqual(new Uint8Array(4));
    expect(compressed[9]).toBe(255);
    const fast = Bun.gzipSync(new TextEncoder().encode(logical), {level: 3});
    fast[9] = 255;
    expect(compressed).toEqual(fast);
    expect(new TextDecoder().decode(gunzipSync(compressed))).toBe(logical);
    expect(await decodeWorkflowJournal(encoded)).toBe(logical);
  });

  it.each(['native-6', 'fflate-6'] as const)(
    'retains %s capacity after valid oversized native output',
    async fallback => {
      const logical = `${JSON.stringify({payload: 'x'.repeat(workflowJournalLimits.diskBytes)})}\n`;
      const plain = new TextEncoder().encode(logical);
      const nativeGzip = Bun.gzipSync;
      const legacy = fallback === 'native-6' ? nativeGzip(plain, {level: 6}) : gzipSync(plain, {level: 6, mtime: 0});
      if (fallback === 'native-6') legacy[9] = 255;
      const expected = envelopeFor(plain, legacy);
      expect(Buffer.byteLength(expected)).toBeLessThanOrEqual(workflowJournalLimits.diskBytes);
      // Level3 fits this real input. Substitute valid level0 gzip for the same bytes
      // to exercise overflow, without pretending it is a natural level3 counterexample.
      const oversized = gzipSync(plain, {level: 0, mtime: 0});
      expect(Buffer.byteLength(envelopeFor(plain, oversized))).toBeGreaterThan(workflowJournalLimits.diskBytes);
      expect(new TextDecoder().decode(gunzipSync(oversized))).toBe(logical);
      const compressor = vi
        .spyOn(Bun, 'gzipSync')
        .mockImplementation((bytes, options) =>
          fallback === 'fflate-6' || options?.level === 3 ? oversized : nativeGzip(bytes, options),
        );
      let encoded: string;
      try {
        encoded = encodeWorkflowJournal(logical);
        expect(compressor.mock.calls.map(([, options]) => options?.level)).toEqual([3, 6]);
      } finally {
        compressor.mockRestore();
      }
      expect(encoded).toBe(expected);
      expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(workflowJournalLimits.diskBytes);
      expect(await decodeWorkflowJournal(encoded)).toBe(logical);
      expect(new TextDecoder().decode(gunzipSync(Buffer.from(JSON.parse(encoded).payload, 'base64')))).toBe(logical);
    },
  );

  it('preserves accepted native capacity and round trips both existing markers', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({minLength: 32, maxLength: 128}), async bytes => {
        const motif = Buffer.from(bytes).toString('base64');
        const logical = `${JSON.stringify({payload: motif.repeat(Math.ceil(workflowJournalLimits.diskBytes / motif.length))})}\n`;
        const plain = new TextEncoder().encode(logical);
        expect(plain.byteLength).toBeGreaterThan(workflowJournalLimits.diskBytes);
        const legacy = Bun.gzipSync(plain, {level: 6});
        legacy[9] = 255;
        for (const marker of [format, 'threadnote-native-workflow-state-gzip-v1']) {
          expect(Buffer.byteLength(envelopeFor(plain, legacy, marker))).toBeLessThanOrEqual(
            workflowJournalLimits.diskBytes,
          );
          const encoded = encodeBoundedWorkflowJson(logical, marker);
          expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(workflowJournalLimits.diskBytes);
          expect(encodeBoundedWorkflowJson(logical, marker)).toBe(encoded);
          expect(await decodeBoundedWorkflowJson(encoded, marker)).toBe(logical);
        }
      }),
      {numRuns: 3},
    );
  });

  it('keeps capacity admission equivalent at the disk edge and for compressible histories above it', async () => {
    const atPlainBytes = (targetBytes: number) => {
      const empty = state();
      const fixedBytes = new TextEncoder().encode(`${stableJson({...empty, manifestContent: ''})}\n`).byteLength;
      const value = {...empty, manifestContent: 'x'.repeat(targetBytes - fixedBytes)};
      const logical = `${stableJson(value)}\n`;
      expect(new TextEncoder().encode(logical).byteLength).toBe(targetBytes);
      return {value, logical};
    };

    const atDiskLimit = atPlainBytes(workflowJournalLimits.diskBytes);
    expect(() => assertWorkflowJournalCapacity(atDiskLimit.value)).not.toThrow();
    expect(await decodeWorkflowJournal(serializeWorkflowJournal(atDiskLimit.value))).toBe(atDiskLimit.logical);

    const justBeyondDisk = atPlainBytes(workflowJournalLimits.diskBytes + 1);
    expect(() => assertWorkflowJournalCapacity(justBeyondDisk.value)).not.toThrow();
    const encoded = serializeWorkflowJournal(justBeyondDisk.value);
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(workflowJournalLimits.diskBytes);
    expect(await decodeWorkflowJournal(encoded)).toBe(justBeyondDisk.logical);
  });

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
      {...good, payload: ` ${String(good.payload)}`},
      {...good, payload: `${String(good.payload)}\n`},
      {...good, payload: String(good.payload).slice(0, 4) + '!' + String(good.payload).slice(4)},
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

describe('manifest transition witness support', () => {
  const verified = (operation: WorkflowOperation): WorkflowOperation => ({...operation, status: 'verified'});
  const equal = (left: unknown, right: unknown) => stableJson(left) === stableJson(right);
  const apply = (previous: WorkflowJournal['artifacts'], operation: WorkflowOperation) => {
    const next = {...previous, ...map(operation.artifact)};
    if (operation.request.action === 'archive') delete next[operation.sourceUri!];
    return next;
  };
  // Independent normal-mutation oracle: apply complete records, never consult a changed-key set.
  const normalWitness = (
    previous: WorkflowJournal['artifacts'],
    current: WorkflowJournal['artifacts'],
    receipts: readonly WorkflowOperation[],
  ) =>
    receipts.some(operation => {
      if (operation.status !== 'verified' || !equal(current[operation.artifact.canonicalUri], operation.artifact))
        return false;
      if (operation.request.action === 'create') {
        if (previous[operation.artifact.canonicalUri] !== undefined) return false;
      } else if (previous[operation.sourceUri!]?.state !== 'active') return false;
      return equal(apply(previous, operation), current);
    });
  const transition = (
    previous: WorkflowJournal['artifacts'],
    current: WorkflowJournal['artifacts'],
    receipts: readonly WorkflowOperation[],
  ): WorkflowJournal => ({
    ...state(current, operations(...receipts)),
    manifestCommitted: false,
    previousManifestContent: manifest(previous),
  });
  const replacement = (source: WorkflowOperation): WorkflowOperation => {
    const body = 'Complete replacement result.\n';
    const request: WorkflowRequest = {
      ...source.request,
      action: 'replace',
      operationId: 'replace-candidate',
      uri: source.artifact.canonicalUri,
      expectedRevision: source.artifact.revision,
      body,
      bodySha256: sha256HexSync(body),
    };
    const record = parseMemoryDocument(source.artifact.canonicalUri, source.desired)!;
    const desired = formatMemoryDocument(record.headerTitle, record.metadata, body);
    return {
      ...source,
      request,
      desired,
      before: source.desired,
      sourceUri: source.artifact.canonicalUri,
      intentDigest: sha256HexSync(stableJson(request)),
      artifact: {...source.artifact, revision: sha256HexSync(desired), bodySha256: sha256HexSync(body)},
      status: 'verified',
    };
  };

  it('matches full-map mutation witnesses under irrelevant history and receipt permutations', () => {
    fc.assert(
      fc.property(
        fc.integer({min: 1, max: 12}),
        fc.constantFrom('create', 'replace', 'archive', 'archive-source-only', 'archive-destination-only'),
        fc.constantFrom('none', 'extra-change', 'missing-witness'),
        fc.array(fc.integer({min: 0, max: 31}), {maxLength: 32}),
        (count, action, alteration, order) => {
          const history = Array.from({length: count}, (_, index) => verified(create(`history-${index}`)));
          const source = action === 'create' ? undefined : verified(create('source-v2'));
          const relevant =
            action === 'create'
              ? verified(create('new-v2'))
              : action === 'replace'
                ? replacement(source!)
                : verified(archive(source!));
          let previous: WorkflowJournal['artifacts'] = Object.fromEntries(
            history.map(item => [item.artifact.canonicalUri, item.artifact]),
          );
          if (source) previous = {...previous, ...map(source.artifact)};
          if (action === 'archive-source-only') previous = {...previous, ...map(relevant.artifact)};
          let current =
            action === 'archive-destination-only'
              ? {...previous, ...map(relevant.artifact)}
              : apply(previous, relevant);
          if (alteration === 'extra-change') current = {...current, ...map(create('unwitnessed').artifact)};
          const receipts = [
            ...history,
            ...(source ? [source] : []),
            ...(alteration === 'missing-witness' ? [] : [relevant]),
          ]
            .map((operation, index) => ({operation, index, order: order[index] ?? index}))
            .sort((left, right) => left.order - right.order || left.index - right.index)
            .map(item => item.operation);
          const expected = normalWitness(previous, current, receipts);
          const next = transition(previous, current, receipts);
          if (expected) expect(() => assertWorkflowJournalIntegrity(next, next.previousManifestContent)).not.toThrow();
          else expect(() => assertWorkflowJournalIntegrity(next, next.previousManifestContent)).toThrow();
        },
      ),
      {numRuns: 40},
    );
  });

  it('does not hide relevant or irrelevant corrupted receipts before witness selection', () => {
    const old = verified(create('old'));
    const relevant = verified(create('new'));
    const previous = map(old.artifact);
    const current = {...previous, ...map(relevant.artifact)};
    const mutations: readonly ((operation: WorkflowOperation) => WorkflowOperation)[] = [
      operation => ({...operation, intentDigest: 'a'.repeat(64)}),
      operation => ({...operation, desired: operation.desired + 'edited'}),
      operation => ({...operation, artifact: {...operation.artifact, revision: 'b'.repeat(64)}}),
      operation => ({...operation, artifact: {...operation.artifact, memoryId: 'tn_00000000000000000000'}}),
      operation => ({
        ...operation,
        artifact: {...operation.artifact, canonicalUri: `threadnote://memory/${operation.artifact.memoryId}`},
      }),
      operation => {
        const request = {...operation.request, bindingId: 'c'.repeat(64)};
        return {...operation, request, intentDigest: sha256HexSync(stableJson(request))};
      },
    ];
    for (const mutate of mutations)
      for (const target of ['old', 'new']) {
        const receipts = [target === 'old' ? mutate(old) : old, target === 'new' ? mutate(relevant) : relevant];
        const next = transition(previous, current, receipts);
        expect(() => assertWorkflowJournalIntegrity(next, next.previousManifestContent)).toThrow();
      }
    for (const changedBinding of [
      {...binding, home: '/different/home'},
      {...binding, account: 'other'},
      {...binding, user: 'other'},
    ]) {
      const next = {...transition(previous, current, [old, relevant]), binding: changedBinding};
      expect(() => assertWorkflowJournalIntegrity(next, next.previousManifestContent)).toThrow();
    }
  });

  it('retains relevant relation scope checks and earlier prepared-receipt checks', () => {
    const old = verified(create('old'));
    const relevant = verified(create('new'));
    const foreign = verified(create('foreign'));
    const badRelations = [
      {
        uri: foreign.artifact.canonicalUri,
        content: foreign.desired,
        memoryId: foreign.artifact.memoryId,
        allowedUriScopes: ['threadnote://user/tester/memories'],
      },
    ];
    const previous = map(old.artifact);
    const current = {...previous, ...map(relevant.artifact)};
    const relevantTamper = transition(previous, current, [old, {...relevant, relations: badRelations}]);
    expect(() => assertWorkflowJournalIntegrity(relevantTamper, relevantTamper.previousManifestContent)).toThrow();
    const prepared = {...create('unrelated-prepared'), relations: badRelations};
    const preparedTamper = transition(previous, current, [old, prepared, relevant]);
    expect(() => assertWorkflowJournalIntegrity(preparedTamper, preparedTamper.previousManifestContent)).toThrow();
  });

  it('keeps exact named archive versions and the source-only removal witness', () => {
    const namedIdentity = {...identity, naming: {policyVersion: 1 as const, slug: 'witness', ordinal: 2}};
    const namedBinding: WorkflowBinding = {...namedIdentity, bindingId: sha256HexSync(stableJson(namedIdentity))};
    const original = verified(create('versioned'));
    const naming = {role: 'root', version: 2};
    const request = {...original.request, bindingId: namedBinding.bindingId, nameHint: naming.role};
    const memoryId = `tn_${sha256HexSync(`${namedBinding.bindingId}\nwriter\nversioned`).slice(0, 20)}`;
    const record = parseMemoryDocument(original.artifact.canonicalUri, original.desired)!;
    const desired = formatMemoryDocument(
      record.headerTitle,
      {
        ...record.metadata,
        memoryId,
        topic: workflowArtifactTopic(namedBinding, 'versioned', naming),
      },
      record.body,
    );
    const source: WorkflowOperation = {
      ...original,
      request,
      desired,
      intentDigest: sha256HexSync(stableJson(request)),
      artifact: {
        ...original.artifact,
        naming,
        memoryId,
        revision: sha256HexSync(desired),
        canonicalUri: workflowArtifactUri(namedBinding, {...original.artifact, naming}),
      },
    };
    const baseArchive = verified(archive(source));
    const archivedNaming = {...naming, archiveOrdinal: 3};
    const archiveRequest = {...baseArchive.request, bindingId: namedBinding.bindingId};
    const retired: WorkflowOperation = {
      ...baseArchive,
      request: archiveRequest,
      intentDigest: sha256HexSync(stableJson(archiveRequest)),
      artifact: {
        ...baseArchive.artifact,
        naming: archivedNaming,
        canonicalUri: workflowArchiveUri(namedBinding, {...baseArchive.artifact, naming: archivedNaming}, 'retire'),
      },
    };
    const namedState = (artifacts: WorkflowJournal['artifacts'], receipts: readonly WorkflowOperation[]) => {
      const topic = workflowStateTopic(namedBinding);
      return {
        ...state(artifacts, operations(...receipts)),
        binding: namedBinding,
        manifestUri: `${activeRoot}/${topic}.md`,
        manifestContent: formatMemoryDocument(
          'MEMORY',
          {
            kind: 'handoff',
            status: 'active',
            project: namedBinding.project,
            topic,
            memoryId: `tn_${namedBinding.bindingId.slice(0, 20)}`,
            timestamp,
            sourceAgentClient: 'threadnote',
            sourceSessionId: namedBinding.workflowRunId,
          },
          stableJson({protocolVersion: 1, binding: namedBinding, artifacts}),
        ),
      };
    };
    const previous = namedState({...map(source.artifact), ...map(retired.artifact)}, [source, retired]);
    const current = {
      ...namedState(map(retired.artifact), [source, retired]),
      manifestCommitted: false,
      previousManifestContent: previous.manifestContent,
    };
    expect(() => assertWorkflowJournalIntegrity(current, previous.manifestContent)).not.toThrow();
    const wrongOrdinal = {...retired, artifact: {...retired.artifact, naming: {...archivedNaming, archiveOrdinal: 4}}};
    const invalid = {...current, operations: operations(source, wrongOrdinal)};
    expect(() => assertWorkflowJournalIntegrity(invalid, previous.manifestContent)).toThrow();
  });
});
