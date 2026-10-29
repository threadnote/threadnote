import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {Schema} from 'effect';
import {describe, expect, it} from 'vitest';
import {
  RemoteMemoryProvisioningInputSchema,
  RemoteMemoryProvisioningRequestSchema,
} from '@threadnote/threadnote/remote_memory/operator/main';
import {
  decodeStoredSharePolicyDocument,
  requireNoImplicitSharePolicyChange,
  STORED_SHARE_POLICY_MAX_BYTES,
  validateRemoteMemoryProvisioningInput,
  type RemoteMemoryProvisioningInput,
} from '@threadnote/remote-memory/postgres/control_plane';
import * as EffectRecord from 'effect/Record';

const validProvisioning: RemoteMemoryProvisioningInput = {
  allowedProjects: ['threadnote'],
  capabilities: ['memory:read', 'memory:write:durable'],
  cursorAttestationRequired: true,
  cursorOwnerIds: ['12345'],
  cursorSubjects: ['user:12345'],
  cursorTeamId: '6789',
  displayName: 'Threadnote managed memory',
  featureFlags: ['remote_memory_read', 'remote_memory_durable_write', 'cursor_oidc_required', 'remote_memory_ga'],
  issuer: 'https://identity.example.test',
  policyVersion: 'grant-v1',
  principalId: 'principal-1',
  projects: ['threadnote'],
  region: 'eu-example-1',
  repositoryBindings: {threadnote: ['https://github.com/example/threadnote.git']},
  shareId: 'share-1',
  sharePolicyVersion: 'share-v1',
  subject: 'oauth-subject',
  tenantId: 'tenant-1',
};

describe('remote memory provisioning boundary', () => {
  it('decodes the operator file with exact keys and bounded URL lists', () => {
    const decode = Schema.decodeUnknownSync(RemoteMemoryProvisioningInputSchema, {onExcessProperty: 'error'});
    expect(decode(JSON.parse(JSON.stringify(validProvisioning)))).toEqual(validProvisioning);
    expect(() => decode({...validProvisioning, unexpected: 'value'})).toThrow();
    expect(() => decode({...validProvisioning, repositoryBindings: {threadnote: ['not a URL']}})).toThrow();
    expect(() =>
      decode({...validProvisioning, repositoryBindings: {threadnote: Array(1_001).fill('https://example.test')}}),
    ).toThrow();
    expect(() => decode({...validProvisioning, capabilities: []})).toThrow();
  });

  it('lets the planner own compare-and-swap fields and the read-only default', () => {
    const decode = Schema.decodeUnknownSync(RemoteMemoryProvisioningRequestSchema, {onExcessProperty: 'error'});
    const {capabilities: _capabilities, ...request} = validProvisioning;
    expect(decode({...request, clientId: 'okta-client'})).not.toHaveProperty('capabilities');
    expect(() => decode(request)).toThrow();
    expect(() => decode({...request, expectedCurrentPolicyVersion: 'caller-controlled'})).toThrow();
    expect(() => decode({...request, expectedCurrentSharePolicyVersion: 'caller-controlled'})).toThrow();
  });

  it('accepts one end-to-end addressable Cursor share policy', () => {
    expect(() => validateRemoteMemoryProvisioningInput(validProvisioning)).not.toThrow();
    expect(() =>
      validateRemoteMemoryProvisioningInput({
        ...validProvisioning,
        clientId: 'cloud-client',
        cloudAdmissionRequired: true,
      }),
    ).not.toThrow();
    expect(() => validateRemoteMemoryProvisioningInput({...validProvisioning, cloudAdmissionRequired: true})).toThrow(
      'exact OAuth client id',
    );
  });

  it.each([
    ['share id', {shareId: 'share:unaddressable'}],
    ['project path', {allowedProjects: ['bad/project']}],
    [
      'noncanonical repository port',
      {repositoryBindings: {threadnote: ['https://github.com:8443/example/threadnote']}},
    ],
    ['scheme-free repository', {repositoryBindings: {threadnote: ['github.com/example/threadnote']}}],
    ['noncanonical issuer', {issuer: 'https://IDENTITY.example.test'}],
    ['issuer credentials', {issuer: 'https://user:credential@identity.example.test/'}],
    ['issuer query', {issuer: 'https://identity.example.test/?query=value'}],
    ['issuer fragment', {issuer: 'https://identity.example.test/#fragment'}],
    ['issuer whitespace', {issuer: ' https://identity.example.test/ '}],
    ['insecure issuer', {issuer: 'http://identity.example.test'}],
    ['blank subject', {subject: '  '}],
  ] as const)('rejects an unaddressable %s before storage', (_label, invalid) => {
    expect(() => validateRemoteMemoryProvisioningInput({...validProvisioning, ...invalid})).toThrow();
  });

  it('accepts a loopback HTTP issuer for the local composer IdP', () => {
    expect(() =>
      validateRemoteMemoryProvisioningInput({...validProvisioning, issuer: 'http://127.0.0.1:18788'}),
    ).not.toThrow();
    expect(() =>
      validateRemoteMemoryProvisioningInput({...validProvisioning, issuer: 'http://localhost:18788'}),
    ).not.toThrow();
  });

  it.each(['https://identity.example.test/', 'https://identity.example.test/tenant/'])(
    'accepts the exact provider issuer %s',
    issuer => {
      expect(() => validateRemoteMemoryProvisioningInput({...validProvisioning, issuer})).not.toThrow();
    },
  );

  it('decodes bounded JSONB text without relying on the PostgreSQL driver JSON representation', () => {
    const json = '{"displayName": "Threadnote managed memory", "projects": ["threadnote"]}';

    expect(decodeStoredSharePolicyDocument(json)).toEqual({
      displayName: 'Threadnote managed memory',
      projects: ['threadnote'],
    });
  });

  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
  it.each([undefined, null, {}, '', 'not-json', '[]', `{"value":"${'a'.repeat(STORED_SHARE_POLICY_MAX_BYTES)}"}`])(
    'rejects an unsafe stored share-policy representation %#',
    stored => {
      expect(() => decodeStoredSharePolicyDocument(stored)).toThrow('cannot be safely compared');
    },
  );

  it('compares nested share policy objects independent of JSONB key order', () => {
    const input: RemoteMemoryProvisioningInput = {
      ...validProvisioning,
      projects: ['threadnote', 'api'],
      repositoryBindings: {
        api: ['https://github.com/example/api.git'],
        threadnote: ['https://github.com/example/threadnote.git'],
      },
    };
    const stored = storedSharePolicy(input, {
      threadnote: ['https://github.com/example/threadnote.git'],
      api: ['https://github.com/example/api.git'],
    });

    expect(() => requireNoImplicitSharePolicyChange(input, stored)).not.toThrow();
  });

  it('preserves implicit share policies across arbitrary repository-binding insertion order', () => {
    const entry = fc.record({
      project: fc.stringMatching(/^[a-z][a-z0-9]{0,7}$/u),
      repositories: fc.uniqueArray(
        fc.constantFrom(
          'https://github.com/example/one.git',
          'https://github.com/example/two.git',
          'https://github.com/example/three.git',
        ),
        {maxLength: 3},
      ),
    });
    fc.assert(
      fc.property(fc.uniqueArray(entry, {maxLength: 8, selector: value => value.project}), entries => {
        const inputBindings = EffectRecord.fromEntries(
          EffectArray.map(entries, value => [value.project, value.repositories]),
        );
        const storedBindings = EffectRecord.fromEntries(
          EffectArray.map([...entries].reverse(), value => [value.project, [...value.repositories].sort()] as const),
        );
        const input: RemoteMemoryProvisioningInput = {
          ...validProvisioning,
          projects: EffectArray.map(entries, value => value.project),
          repositoryBindings: inputBindings,
        };

        expect(() => requireNoImplicitSharePolicyChange(input, storedSharePolicy(input, storedBindings))).not.toThrow();
      }),
      {numRuns: 100},
    );
  });
});

function storedSharePolicy(
  input: RemoteMemoryProvisioningInput,
  repositoryBindings: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, unknown>> {
  return {
    cursorTeamId: input.cursorTeamId ?? null,
    displayName: input.displayName,
    featureFlags: [...new Set(input.featureFlags ?? ['remote_memory_read'])].sort(),
    projects: [...new Set(input.projects ?? EffectRecord.keys(repositoryBindings))].sort(),
    repositoryBindings,
  };
}
