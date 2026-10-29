import {Array as EffectArray} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {formatRemoteMemoryUri} from '@threadnote/memory/remote/address';
import {
  parseRemoteReadInputV1,
  parseRemoteRecallInputV1,
  parseRemoteRememberInputV1,
} from '@threadnote/memory/remote/contracts';
import {
  inspectRemoteMemoryContent,
  InvalidRemoteMemoryDocument,
  parseRemoteCanonicalMemoryDocument,
} from '@threadnote/memory/remote/content';
import {
  InvalidRemoteMemoryReceipt,
  parseRemoteMemoryReceiptV1,
  type RemoteMemoryReceiptV1,
} from '@threadnote/memory/remote/receipts';
import {validatePortableSegment} from '@threadnote/store/resource-id';
import {Option as EffectOption} from 'effect';

const portableSegment = FC.stringMatching(/^[a-z][a-z0-9]{0,8}$/u).filter(value => {
  try {
    return validatePortableSegment(value) === value;
  } catch {
    return false;
  }
});

const receipt: RemoteMemoryReceiptV1 = {
  actor: {cloudAgentId: 'agent-1', principalId: 'principal-1', provider: 'cursor', turnId: 'turn-1'},
  consistency: 'recent-write-overlay',
  indexedGeneration: 6,
  policyVersion: 'policy-7',
  sharePolicyVersion: 'share-policy-3',
  requestId: 'request-1',
  revision: 'revision-2',
  shareGeneration: 7,
  shareId: 'share-1',
  tenantId: 'tenant-1',
  uri: 'threadnote://share/share-1/memories/durable/threadnote/decision.md',
  version: 1,
};

describe('remote memory versioned schemas', () => {
  it('parses the transport-neutral recall, read, and remember v1 contracts', () => {
    expect(
      parseRemoteRecallInputV1({kinds: ['durable'], limit: 8, project: 'threadnote', query: 'transport', version: 1}),
    ).toEqual({kinds: ['durable'], limit: 8, project: 'threadnote', query: 'transport', version: 1});
    expect(parseRemoteReadInputV1({revision: 'revision-1', uri: receipt.uri, version: 1})).toEqual({
      revision: 'revision-1',
      uri: receipt.uri,
      version: 1,
    });
    expect(
      parseRemoteRememberInputV1({
        attestationId: 'attestation-1',
        baseRevision: 'revision-1',
        kind: 'handoff',
        lifecycle: {expiresAt: '2026-08-14T12:00:00.000Z', retentionClass: 'standard'},
        operationId: 'operation-1',
        project: 'threadnote',
        text: 'Current status',
        topic: 'cursor-cloud',
        version: 1,
      }),
    ).toMatchObject({kind: 'handoff', operationId: 'operation-1', version: 1});
  });

  it('rejects lifecycle controls for durable memory until durable retention is implemented', () => {
    expect(() =>
      parseRemoteRememberInputV1({
        kind: 'durable',
        lifecycle: {expiresAt: '2026-08-14T12:00:00.000Z', retentionClass: 'standard'},
        operationId: 'operation-1',
        project: 'threadnote',
        text: 'Durable context.',
        topic: 'durable-expiry',
        version: 1,
      }),
    ).toThrow('only supported for handoffs');
  });

  it('accepts an explicit CAS replacement URI only with the matching identity and base revision', () => {
    const input = {
      baseRevision: 'revision-1',
      kind: 'durable' as const,
      operationId: 'operation-2',
      project: 'threadnote',
      replaceUri: receipt.uri,
      text: 'Updated decision.',
      topic: 'decision',
      version: 1 as const,
    };
    expect(parseRemoteRememberInputV1(input)).toEqual(input);
    expect(() => parseRemoteRememberInputV1({...input, baseRevision: undefined})).toThrow('baseRevision');
    expect(() => parseRemoteRememberInputV1({...input, topic: 'other'})).toThrow('replaceUri');
    expect(() => parseRemoteRememberInputV1({...input, kind: 'handoff'})).toThrow('replaceUri');
    expect(() =>
      parseRemoteRememberInputV1({
        ...input,
        replaceUri: 'threadnote://share/share-1/memories/durable/threadnote/decision.md#anchor',
      }),
    ).toThrow();
  });

  it('accepts only canonical typed remote-memory relations and rejects duplicate declarations', () => {
    const dependency = formatRemoteMemoryUri({
      kind: 'durable',
      project: 'threadnote',
      shareId: 'share-1',
      topic: 'dependency',
    });
    const handoff = formatRemoteMemoryUri({
      kind: 'handoff',
      project: 'threadnote',
      shareId: 'share-1',
      topic: 'release',
    });
    const input = {
      kind: 'durable' as const,
      operationId: 'operation-relations',
      project: 'threadnote',
      relations: [
        {type: 'references' as const, uri: handoff},
        {type: 'depends_on' as const, uri: dependency},
      ],
      text: 'Typed remote relations.',
      topic: 'source',
      version: 1 as const,
    };

    expect(parseRemoteRememberInputV1(input).relations).toEqual([
      {type: 'depends_on', uri: dependency},
      {type: 'references', uri: handoff},
    ]);
    expect(() => parseRemoteRememberInputV1({...input, relations: [input.relations[0], input.relations[0]]})).toThrow(
      'Duplicate remote memory relations',
    );
    for (const uri of [
      `${dependency}#anchor`,
      'threadnote://memory/tn_relation_alias',
      'threadnote://share/share-1/memories',
      'threadnote://share/share-1/memories/durable/threadnote/%73ource.md',
    ]) {
      expect(() => parseRemoteRememberInputV1({...input, relations: [{type: 'references' as const, uri}]})).toThrow(
        'canonical remote memory',
      );
    }
  });

  it('rejects Windows-reserved remote-memory project segments', () => {
    expect(() => formatRemoteMemoryUri({kind: 'durable', project: 'prn', shareId: 'share-1', topic: 'topic'})).toThrow(
      /Windows reserved name/u,
    );
  });

  fcProp(
    it,
    'canonical relation ordering preserves declaration identity across input permutations',
    {
      relations: FC.uniqueArray(
        FC.record({
          project: portableSegment,
          topic: portableSegment,
          type: FC.constantFrom(
            'depends_on' as const,
            'evidence_for' as const,
            'references' as const,
            'related_to' as const,
            'supersedes' as const,
          ),
        }),
        {maxLength: 16, selector: relation => `${relation.type}\n${relation.project}\n${relation.topic}`},
      ),
    },
    ({relations}) => {
      const authored = EffectArray.map(relations, relation => ({
        type: relation.type,
        uri: formatRemoteMemoryUri({
          kind: 'durable',
          project: relation.project,
          shareId: 'share-1',
          topic: relation.topic,
        }),
      }));
      const parse = (items: typeof authored) =>
        parseRemoteRememberInputV1({
          kind: 'durable',
          operationId: 'operation-relations-property',
          project: 'threadnote',
          relations: items,
          text: 'Property relation set.',
          topic: 'source',
          version: 1,
        }).relations;

      expect(parse(authored)).toEqual(parse([...authored].reverse()));
      expect(
        new Set(
          EffectOption.getOrUndefined(
            EffectOption.map(EffectOption.fromNullishOr(parse(authored)), __effectArrayReceiver =>
              EffectArray.map(__effectArrayReceiver, relation => `${relation.type}\n${relation.uri}`),
            ),
          ),
        ),
      ).toEqual(new Set(EffectArray.map(authored, relation => `${relation.type}\n${relation.uri}`)));
    },
    {fastCheck: {numRuns: 100}},
  );

  fcProp(
    it,
    'an explicit remote replacement URI identifies exactly one generated memory topic',
    {
      kind: FC.constantFrom('durable' as const, 'handoff' as const),
      project: portableSegment,
      topic: portableSegment,
    },
    ({kind, project, topic}) => {
      const replaceUri = formatRemoteMemoryUri({kind, project, shareId: 'share-1', topic});
      const input = {
        baseRevision: 'revision-1',
        kind,
        operationId: 'operation-2',
        project,
        replaceUri,
        text: 'Updated.',
        topic,
        version: 1 as const,
      };
      expect(parseRemoteRememberInputV1(input).replaceUri).toBe(replaceUri);
      expect(() => parseRemoteRememberInputV1({...input, topic: `${topic}x`})).toThrow();
    },
    {fastCheck: {numRuns: 40}},
  );

  it.each([
    {callerCwd: '/private/vm', project: 'threadnote', query: 'x', version: 1},
    {project: 'threadnote', query: 'x', version: 2},
    {limit: 0, project: 'threadnote', query: 'x', version: 1},
    {kinds: ['incident'], project: 'threadnote', query: 'x', version: 1},
  ])('rejects out-of-contract recall input %#', input => {
    expect(() => parseRemoteRecallInputV1(input)).toThrow();
  });

  it('parses bounded receipts and enforces committed/indexed generation order', () => {
    expect(parseRemoteMemoryReceiptV1(receipt)).toEqual(receipt);
    expect(() => parseRemoteMemoryReceiptV1({...receipt, indexedGeneration: 8})).toThrow(InvalidRemoteMemoryReceipt);
    expect(() => parseRemoteMemoryReceiptV1({...receipt, actor: {principalId: 'sk-abcdefghijklmnop'}})).toThrow(
      InvalidRemoteMemoryReceipt,
    );
  });

  fcProp(
    it,
    'never accepts model-visible content or identity fields added to a receipt',
    {
      field: FC.constantFrom('email', 'jwt', 'memoryText', 'query', 'refreshToken', 'source', 'absolutePath'),
      secret: FC.string({maxLength: 64, minLength: 1}),
    },
    ({field, secret}) => {
      expect(() => parseRemoteMemoryReceiptV1({...receipt, [field]: secret})).toThrow();
    },
    {fastCheck: {numRuns: 100}},
  );

  it('validates canonical Markdown identity without returning blocked content in the decision', () => {
    const uri = 'threadnote://share/share-1/memories/durable/threadnote/decision.md';
    const content = EffectArray.join(
      [
        'MEMORY',
        'kind: durable',
        'status: active',
        'project: threadnote',
        'topic: decision',
        'source_agent_client: cursor',
        'timestamp: 2026-08-13T08:00:00.000Z',
        '',
        'Use immutable revisions.',
      ],
      '\n',
    );

    expect(
      parseRemoteCanonicalMemoryDocument({content, kind: 'durable', project: 'threadnote', topic: 'decision', uri}),
    ).toMatchObject({content, kind: 'durable', project: 'threadnote', topic: 'decision', uri, version: 1});
    expect(() =>
      parseRemoteCanonicalMemoryDocument({content, kind: 'durable', project: 'other', topic: 'decision', uri}),
    ).toThrow(InvalidRemoteMemoryDocument);

    const secret = 'sk-abcdefghijklmnop';
    const blocked = inspectRemoteMemoryContent(`Do not store ${secret}`);
    expect(blocked).toEqual({allowed: false, category: 'credential', reason: 'API key (sk-...)', version: 1});
    expect(JSON.stringify(blocked)).not.toContain(secret);

    const localPath = '/workspace/private-repository/src/main.ts';
    const blockedPath = inspectRemoteMemoryContent(`Do not store ${localPath}`);
    expect(blockedPath).toEqual({
      allowed: false,
      category: 'machine_local_path',
      reason: 'Cursor workspace path',
      version: 1,
    });
    expect(JSON.stringify(blockedPath)).not.toContain(localPath);

    const customerMarker = 'CUST-123456';
    const policyBlocked = inspectRemoteMemoryContent(`Do not store ${customerMarker}`, {
      additionalPatterns: [{name: 'customer marker', regex: /\bCUST-\d{6}\b/u}],
    });
    expect(policyBlocked).toEqual({allowed: false, category: 'credential', reason: 'customer marker', version: 1});
    expect(JSON.stringify(policyBlocked)).not.toContain(customerMarker);
  });
});
