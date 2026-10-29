import {Array as EffectArray} from 'effect';
import {selectRemoteCanonicalCitations} from '@threadnote/remote-memory/citation_sources';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import {requestFingerprint} from '@threadnote/remote-memory/remember/fingerprint';
import type {AuthorizedRemotePrincipal} from '@threadnote/remote-memory/authorization';
import {describe, expect, it} from 'vitest';
import * as FC from 'fast-check';
import {normalizeRemoteCitationSources} from '@threadnote/memory/remote/citation_sources';
import {parseRemoteRememberInputV1} from '@threadnote/memory/remote/contracts';
import {
  durableProposalPayload,
  durableProposalRememberInput,
  remoteDurableProposalRequestHash,
} from '@threadnote/remote-memory/proposals';
import {makeRemoteDocument} from '@threadnote/remote-memory/remote_document';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {richRemoteMemoryMetadata} from '@threadnote/memory/test/helpers/remote-memory-document';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const uri = 'threadnote://share/share-1/memories/durable/project/donor.md';
const citationId = `tncc_${Effect.pipe('a', EffectString.repeat(40))}`;
const input = {
  kind: 'durable' as const,
  operationId: 'operation',
  project: 'project',
  text: 'Body.',
  topic: 'target',
  version: 1 as const,
};

describe('remote citation selectors', () => {
  it('normalizes permutations and duplicates without changing input or proposal identity', () => {
    FC.assert(
      FC.property(FC.array(FC.integer({min: 0, max: 99}), {maxLength: 4}), values => {
        const sources = EffectArray.map(values, value => ({
          uri,
          citationId: `tncc_${Effect.pipe(value.toString(16), EffectString.padStart(40, '0'))}`,
        }));
        const before = structuredClone(sources);
        const reversed = [...sources, ...sources].reverse();
        expect(normalizeRemoteCitationSources(reversed)).toEqual(normalizeRemoteCitationSources(sources));
        expect(sources).toEqual(before);
        const hash = (citationSources: typeof sources) =>
          remoteDurableProposalRequestHash({
            operationId: 'operation',
            payload: {...input, citationSources},
            principalId: 'principal',
            tenantId: 'tenant',
            shareId: 'share-1',
          });
        expect(hash(reversed)).toBe(hash(sources));
        const principal: AuthorizedRemotePrincipal = {
          allowedProjects: 'all',
          attestationRequiredForWrites: false,
          capabilities: new Set(),
          cloudAdmissionRequired: false,
          OAuth: {issuer: 'issuer', scopes: new Set(), subject: 'subject'},
          cursorOwnerIds: new Set(),
          cursorSubjects: new Set(),
          featureFlags: new Set(),
          policyVersion: 'policy-v1',
          policyDigest: 'policy-digest',
          principalId: 'principal',
          repositoryBindings: new Set(),
          repositoriesByProject: new Map(),
          shareId: 'share-1',
          sharePolicyDigest: 'share-policy-digest',
          sharePolicyVersion: 'share-policy-v1',
          tenantId: 'tenant',
        };
        expect(requestFingerprint(principal, {...input, citationSources: reversed})).toBe(
          requestFingerprint(principal, {...input, citationSources: sources}),
        );
      }),
      {numRuns: 100},
    );
  });

  it('rejects aliases, malformed selectors, excess properties, and unbounded lists', () => {
    for (const citationSources of [
      [{uri, citationId, sourceDirty: false}],
      [{uri, citationId: 'invented'}],
      [{uri: 'threadnote://memory/tn_alias', citationId}],
      Array.from({length: 9}, () => ({uri, citationId})),
    ])
      expect(() => parseRemoteRememberInputV1({...input, citationSources})).toThrow();
    expect(() => parseRemoteRememberInputV1({...input, codeCitations: []})).toThrow();
  });

  it('fails closed for missing IDs, inactive bodies, malformed and unsafe donor evidence', () => {
    const metadata = {...richRemoteMemoryMetadata(), project: 'project', topic: 'donor'};
    const citation = metadata.codeCitations![0];
    const {id: _id, ...citationInput} = citation;
    const sources = [{uri, citationId: citation.id}];
    const body = formatMemoryDocument('MEMORY', metadata, 'Donor.');
    expect(selectRemoteCanonicalCitations(uri, body, sources)).toEqual([citation]);
    expect(() => selectRemoteCanonicalCitations(uri, body, [{uri, citationId}])).toThrow('does not exist');
    for (const content of [
      Effect.pipe(body, EffectString.replace('status: active', 'status: archived')),
      Effect.pipe(body, EffectString.replace('code_citation: {', 'code_citation: invalid{')),
      Effect.pipe(body, EffectString.replace(`schema_version: ${metadata.schemaVersion}`, 'schema_version: 999')),
      formatMemoryDocument(
        'MEMORY',
        {...metadata, codeCitations: [createMemoryCodeCitation({...citationInput, sourceDirty: true})]},
        'Dirty.',
      ),
      formatMemoryDocument(
        'MEMORY',
        {...metadata, codeCitations: [createMemoryCodeCitation({...citationInput, repositoryIdentityKind: 'local'})]},
        'Local.',
      ),
    ])
      expect(() => selectRemoteCanonicalCitations(uri, content, sources)).toThrow();
  });

  it('preserves selector omission and explicit clear through proposal storage and approval', () => {
    const omitted = durableProposalPayload(input);
    expect(omitted).not.toHaveProperty('citationSources');
    expect(durableProposalRememberInput(omitted, 'approval')).not.toHaveProperty('citationSources');
    const clear = durableProposalPayload({...input, citationSources: []});
    expect(durableProposalRememberInput(clear, 'approval').citationSources).toEqual([]);
  });

  it('preserves, clears, or replaces immutable citations independently from body edits', () => {
    const metadata = richRemoteMemoryMetadata();
    const prior = formatMemoryDocument('MEMORY', metadata, 'Before');
    const render = (hasCurrent: boolean, citations?: typeof metadata.codeCitations) =>
      parseMemoryDocument(
        uri,
        makeRemoteDocument(
          input,
          hasCurrent,
          uri,
          'remote',
          new Date('2026-09-16T00:00:00Z'),
          hasCurrent ? prior : undefined,
          'tn_test',
          citations,
        ).content,
      )?.metadata.codeCitations;
    expect(render(false)).toBeUndefined();
    expect(render(true)).toEqual(metadata.codeCitations);
    expect(render(true, [])).toBeUndefined();
    expect(render(false, metadata.codeCitations)).toEqual(metadata.codeCitations);
  });
});
