import {Array as EffectArray} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';

import {
  ProcedureContractError,
  canonicalProcedureManifest,
  createProcedureVerificationReceipt,
  parseProcedureManifest,
  procedureManifestSha256,
  procedureStatus,
} from '@threadnote/context/procedure/contract';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const manifest = {
  artifact: {
    id: 'team.example/review',
    semanticVersion: '1.2.3',
    sha256: Effect.pipe('a', EffectString.repeat(64)),
  },
  compatible: {
    capabilities: ['filesystem.read', 'git.read'],
    surfaceIds: ['terminal', 'workspace'],
  },
  dependencies: [
    {artifactId: 'team.example/lint', semanticVersion: '1.0.0'},
    {artifactId: 'team.example/test', semanticVersion: '2.0.0'},
  ],
  owner: 'owner-opaque-42',
  presentation: {summary: 'Run the reviewed repository verification workflow.', taskKeywords: ['review', 'verify']},
  relatedDurableMemoryIds: ['tn_abc123', 'tn_def456'],
  reviewedOn: '2026-09-17',
  rollout: {channel: 'stable', percentage: 100},
  schemaVersion: 2,
  verification: {
    commands: [
      {argv: ['bun', 'test', 'test/unit/procedure.contract.test.ts'], id: 'unit'},
      {argv: ['bun', 'run', 'typecheck'], id: 'types'},
    ],
    fixtures: [
      {id: 'minimal', sha256: Effect.pipe('b', EffectString.repeat(64))},
      {id: 'regression', sha256: Effect.pipe('c', EffectString.repeat(64))},
    ],
  },
} as const;

describe('verified procedure contract', () => {
  it('keeps schema v1 local verification readable while reserving publication metadata for v2', () => {
    const {presentation: _presentation, rollout: _rollout, ...legacyFields} = manifest;
    const legacy = parseProcedureManifest({...legacyFields, schemaVersion: 1});
    const receipt = createProcedureVerificationReceipt(legacy, {
      hostVersion: 'host',
      threadnoteVersion: '5.0.0',
      verifiedAt: '2026-09-17T12:00:00.000Z',
      verifier: 'verifier',
    });

    expect(canonicalProcedureManifest(legacy)).toBe(`${JSON.stringify({...legacyFields, schemaVersion: 1})}\n`);
    expect(JSON.parse(canonicalProcedureManifest(legacy))).not.toHaveProperty('rollout');
    expect(
      procedureStatus(legacy, {
        capabilities: ['filesystem.read', 'git.read'],
        localArtifactSha256: legacy.artifact.sha256,
        receipt,
        surfaceIds: ['terminal', 'workspace'],
      }),
    ).toBe('current');
  });

  it('canonicalizes unordered manifest collections while preserving verification command order', () => {
    const parsed = parseProcedureManifest({
      ...manifest,
      compatible: {capabilities: ['git.read', 'filesystem.read'], surfaceIds: ['workspace', 'terminal']},
      dependencies: [...manifest.dependencies].reverse(),
      relatedDurableMemoryIds: [...manifest.relatedDurableMemoryIds].reverse(),
      verification: {
        commands: [...manifest.verification.commands].reverse(),
        fixtures: [...manifest.verification.fixtures].reverse(),
      },
    });

    expect(parsed.compatible.capabilities).toEqual(['filesystem.read', 'git.read']);
    expect(parsed.compatible.surfaceIds).toEqual(['terminal', 'workspace']);
    expect(EffectArray.map(parsed.dependencies, value => value.artifactId)).toEqual([
      'team.example/lint',
      'team.example/test',
    ]);
    expect(EffectArray.map(parsed.verification.commands, value => value.id)).toEqual(['types', 'unit']);
    expect(canonicalProcedureManifest(parsed)).not.toBe(canonicalProcedureManifest(parseProcedureManifest(manifest)));
  });

  it('rejects unknown, duplicate, invalid, and unbounded metadata without executing commands', () => {
    expect(() => parseProcedureManifest({...manifest, extra: true})).toThrow(ProcedureContractError);
    expect(() =>
      parseProcedureManifest({...manifest, compatible: {capabilities: ['git.read', 'git.read'], surfaceIds: []}}),
    ).toThrow('duplicate');
    expect(() => parseProcedureManifest({...manifest, reviewedOn: '2026-02-30'})).toThrow('ISO calendar date');
    expect(() =>
      parseProcedureManifest({
        ...manifest,
        verification: {...manifest.verification, commands: [{argv: [], id: 'unit'}]},
      }),
    ).toThrow('argv');
    expect(() =>
      parseProcedureManifest({
        ...manifest,
        verification: {
          ...manifest.verification,
          commands: [manifest.verification.commands[0], manifest.verification.commands[0]],
        },
      }),
    ).toThrow('duplicate');
    expect(() => parseProcedureManifest({...manifest, relatedDurableMemoryIds: Array(65).fill('tn_unique')})).toThrow(
      'at most 64',
    );
  });

  it('only treats a matching, complete receipt as current', () => {
    const parsed = parseProcedureManifest(manifest);
    const receipt = createProcedureVerificationReceipt(parsed, {
      hostVersion: 'macOS 26.0',
      threadnoteVersion: '4.7.7',
      verifiedAt: '2026-09-17T12:00:00.000Z',
      verifier: 'verifier-opaque-42',
    });

    expect(procedureManifestSha256(parsed)).toHaveLength(64);
    expect(
      procedureStatus(parsed, {
        capabilities: ['filesystem.read', 'git.read'],
        localArtifactSha256: parsed.artifact.sha256,
        receipt,
        surfaceIds: ['terminal', 'workspace'],
      }),
    ).toBe('current');
    expect(procedureStatus(parsed, {capabilities: [], receipt, surfaceIds: ['terminal', 'workspace']})).toBe(
      'incompatible',
    );
    expect(
      procedureStatus(parsed, {
        capabilities: ['filesystem.read', 'git.read'],
        localArtifactSha256: Effect.pipe('d', EffectString.repeat(64)),
        receipt,
        surfaceIds: ['terminal', 'workspace'],
      }),
    ).toBe('locally-modified');
    expect(
      procedureStatus(parsed, {
        availableArtifact: {...parsed.artifact, semanticVersion: '1.3.0'},
        capabilities: ['filesystem.read', 'git.read'],
        receipt,
        surfaceIds: ['terminal', 'workspace'],
      }),
    ).toBe('update-available');
    expect(
      procedureStatus(parsed, {capabilities: ['filesystem.read', 'git.read'], surfaceIds: ['terminal', 'workspace']}),
    ).toBe('unverified');
  });

  fcProp(
    it,
    'canonical serialization is independent of collection order',
    {
      capabilities: FC.uniqueArray(FC.constantFrom('filesystem.read', 'git.read', 'mcp.read'), {minLength: 1}),
      surfaceIds: FC.uniqueArray(FC.constantFrom('terminal', 'workspace', 'chat'), {minLength: 1}),
    },
    ({capabilities, surfaceIds}) => {
      const first = parseProcedureManifest({...manifest, compatible: {capabilities, surfaceIds}});
      const second = parseProcedureManifest({
        ...manifest,
        compatible: {capabilities: [...capabilities].reverse(), surfaceIds: [...surfaceIds].reverse()},
      });
      expect(canonicalProcedureManifest(first)).toBe(canonicalProcedureManifest(second));
      expect(procedureManifestSha256(first)).toBe(procedureManifestSha256(second));
    },
    {fastCheck: {numRuns: 100}},
  );

  fcProp(
    it,
    'incompatibility and local modification never produce a current status',
    {capabilities: FC.uniqueArray(FC.constantFrom('filesystem.read', 'git.read'), {maxLength: 1})},
    ({capabilities}) => {
      const parsed = parseProcedureManifest(manifest);
      const receipt = createProcedureVerificationReceipt(parsed, {
        hostVersion: 'host',
        threadnoteVersion: '4.7.7',
        verifiedAt: '2026-09-17T12:00:00.000Z',
        verifier: 'verifier',
      });
      const status = procedureStatus(parsed, {
        capabilities,
        localArtifactSha256: Effect.pipe('d', EffectString.repeat(64)),
        receipt,
        surfaceIds: ['terminal', 'workspace'],
      });
      expect(status).not.toBe('current');
    },
    {fastCheck: {numRuns: 100}},
  );
});
