import {Array as EffectArray} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {it as effectIt} from '@effect/vitest';
import * as FC from 'fast-check';
import {describe, expect, it} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  codeGraphNpmVersionsAreCompatible,
  resolveCodeGraphCrossRepositoryBridges,
  type CodeGraphBridgeRepositoryV1,
} from '@threadnote/graph/cross_repository/resolver';
import {codeGraphPackageMoniker, codeGraphProtobufMoniker} from '@threadnote/graph/cross_repository/monikers';
import type {CodeGraphMonikerV1, CodeGraphProtobufMonikerKind} from '@threadnote/graph/cross_repository/types';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const span = {column: 1, endColumn: 12, endLine: 1, line: 1} as const;

describe('cross-repository bridge resolver', () => {
  it('resolves one declared npm consumer to one exact compatible producer with dual snapshot evidence', () => {
    const consumer = repository(
      'consumer',
      'apps/orders',
      [packageMoniker('import', '@Acme/Shared', '^1.2.0', 'consumer-import')],
      'consumer-snapshot',
    );
    const producer = repository(
      'producer',
      'packages/shared',
      [packageMoniker('export', '@acme/shared', '1.4.3', 'producer-export')],
      'producer-snapshot',
    );

    const result = resolveCodeGraphCrossRepositoryBridges([consumer, producer]);

    expect(result.rejections).toEqual([]);
    expect(result.bridges).toHaveLength(1);
    expect(result.bridges[0]).toMatchObject({
      confidence: 1,
      identity: 'package:npm:@acme/shared',
      provenance: 'declared',
      relation: 'depends_on',
      resolutionDomain: 'package:npm',
      resolver: {
        name: 'threadnote-native-moniker',
        reason: 'declared-npm-package-compatible',
        version: 1,
      },
      source: {
        evidence: {path: 'consumer-import/package.json', span},
        reference: {kind: 'component'},
        repositoryId: consumer.repositoryId,
        repositoryKey: consumer.repositoryKey,
        role: 'import',
        snapshotId: consumer.snapshotId,
      },
      target: {
        evidence: {path: 'producer-export/package.json', span},
        reference: {kind: 'component'},
        repositoryId: producer.repositoryId,
        repositoryKey: producer.repositoryKey,
        role: 'export',
        snapshotId: producer.snapshotId,
      },
      version: 1,
    });
    expect(result.bridges[0].id).toMatch(/^cgb_[0-9a-f]{64}$/u);
  });

  it('resolves exact protobuf file, package, message, service, and RPC imports to repository-qualified exports', () => {
    const identities: ReadonlyArray<{
      readonly kind: CodeGraphProtobufMonikerKind;
      readonly packageName?: string;
      readonly qualifiedName?: string;
      readonly importPath?: string;
    }> = [
      {importPath: 'acme/orders/v1/orders.proto', kind: 'file'},
      {kind: 'package', packageName: 'acme.orders.v1'},
      {kind: 'message', packageName: 'acme.orders.v1', qualifiedName: 'acme.orders.v1.Order'},
      {kind: 'service', packageName: 'acme.orders.v1', qualifiedName: 'acme.orders.v1.Orders'},
      {kind: 'rpc', packageName: 'acme.orders.v1', qualifiedName: 'acme.orders.v1.Orders.GetOrder'},
    ];
    const consumer = repository(
      'protobuf-consumer',
      'services/gateway',
      EffectArray.map(identities, (identity, index) => protobufMoniker('import', identity, `consumer-${index}`)),
    );
    const producer = repository(
      'protobuf-producer',
      'services/orders-api',
      EffectArray.map(identities, (identity, index) => protobufMoniker('export', identity, `producer-${index}`)),
    );

    const result = resolveCodeGraphCrossRepositoryBridges([producer, consumer]);

    expect(result.rejections).toEqual([]);
    expect(EffectArray.map(result.bridges, bridge => bridge.kind)).toEqual([
      'file',
      'message',
      'package',
      'rpc',
      'service',
    ]);
    expect(EffectArray.every(result.bridges, bridge => bridge.relation === 'imports')).toBe(true);
    expect(EffectArray.every(result.bridges, bridge => bridge.resolver.reason === 'exact-protobuf-identity')).toBe(
      true,
    );
    expect(EffectArray.every(result.bridges, bridge => bridge.source.reference.kind === 'qualified-ref')).toBe(true);
    expect(EffectArray.every(result.bridges, bridge => bridge.target.reference.kind === 'qualified-ref')).toBe(true);
    expect(
      EffectArray.every(
        result.bridges,
        bridge =>
          Effect.pipe(bridge.source.evidence.path, EffectString.startsWith('proto/consumer-')) &&
          Effect.pipe(bridge.target.evidence.path, EffectString.startsWith('proto/producer-')),
      ),
    ).toBe(true);
  });

  it('does not create a name-only bridge without a declared import', () => {
    const first = repository('name-only-a', 'packages/shared-a', [
      packageMoniker('export', '@acme/shared', '1.0.0', 'shared-a'),
    ]);
    const second = repository('name-only-b', 'packages/shared-b', [
      packageMoniker('export', '@acme/shared', '1.0.0', 'shared-b'),
    ]);

    expect(resolveCodeGraphCrossRepositoryBridges([first, second])).toEqual({
      bridges: [],
      rejections: [],
      resolverVersion: 1,
    });
  });

  it('does not redirect an exact locally exported identity to another repository', () => {
    const consumer = repository('local-owner', 'apps/consumer', [
      protobufMoniker('import', {importPath: 'acme/common.proto', kind: 'file'}, 'local-import'),
      protobufMoniker('export', {importPath: 'acme/common.proto', kind: 'file'}, 'local-export'),
    ]);
    const external = repository('external-owner', 'packages/external', [
      protobufMoniker('export', {importPath: 'acme/common.proto', kind: 'file'}, 'external-export'),
    ]);

    expect(resolveCodeGraphCrossRepositoryBridges([external, consumer])).toEqual({
      bridges: [],
      rejections: [],
      resolverVersion: 1,
    });
  });

  it('rejects an ambiguous package producer rather than choosing by repository order', () => {
    const consumer = repository('ambiguous-consumer', 'apps/consumer', [
      packageMoniker('import', '@acme/shared', '^1.0.0', 'ambiguous-import'),
    ]);
    const first = repository('ambiguous-producer-a', 'packages/a', [
      packageMoniker('export', '@acme/shared', '1.2.0', 'ambiguous-export-a'),
    ]);
    const second = repository('ambiguous-producer-b', 'packages/b', [
      packageMoniker('export', '@acme/shared', '1.8.0', 'ambiguous-export-b'),
    ]);

    const result = resolveCodeGraphCrossRepositoryBridges([second, consumer, first]);

    expect(result.bridges).toEqual([]);
    expect(result.rejections).toEqual([
      expect.objectContaining({
        candidateCount: 2,
        identity: 'package:npm:@acme/shared',
        reason: 'ambiguous-producer',
      }),
    ]);
  });

  it('rejects incompatible and unrecognized producer versions conservatively', () => {
    const consumer = repository('version-consumer', 'apps/consumer', [
      packageMoniker('import', '@acme/shared', '^2.0.0', 'version-import'),
    ]);
    const incompatible = repository('version-producer', 'packages/shared', [
      packageMoniker('export', '@acme/shared', '1.9.9', 'version-export'),
    ]);

    const result = resolveCodeGraphCrossRepositoryBridges([consumer, incompatible]);

    expect(result.bridges).toEqual([]);
    expect(result.rejections).toEqual([
      expect.objectContaining({candidateCount: 1, reason: 'incompatible-package-version'}),
    ]);
    expect(codeGraphNpmVersionsAreCompatible('^2.0.0', 'nightly')).toBe(false);
    expect(codeGraphNpmVersionsAreCompatible('workspace:*', '2.1.0')).toBe(false);
  });

  it.each([
    ['^1.2.0', '1.9.9', true],
    ['^1.2.0', '2.0.0', false],
    ['~1.2.0', '1.2.9', true],
    ['~1.2.0', '1.3.0', false],
    ['>=1.2.0 <2.0.0', '1.8.0', true],
    ['1.2.x', '1.2.3', true],
    ['1.2.x', '1.3.0', false],
    ['1.2.3', '1.2.3', true],
    ['1.2.3', '1.2.4', false],
    ['^0', '0.5.0', true],
    ['^0.x', '0.9.9', true],
    ['^0.0', '0.0.8', true],
    ['^0.0.x', '0.0.9', true],
    ['^0.2.3-beta', '0.2.4', true],
    ['^0.2.3-beta', '0.9.0', false],
    ['^0.0.3', '0.0.4', false],
    ['^1.0.0 ||', '1.2.3', false],
  ] as const)('applies recognized npm range %s to %s', (constraint, version, compatible) => {
    expect(codeGraphNpmVersionsAreCompatible(constraint, version)).toBe(compatible);
  });

  fcProp(
    effectIt,
    'keeps omitted zero-major caret components compatible across their complete npm interval',
    {minor: FC.integer({max: 100, min: 0}), patch: FC.integer({max: 100, min: 0})},
    ({minor, patch}) => {
      expect(codeGraphNpmVersionsAreCompatible('^0', `0.${minor}.${patch}`)).toBe(true);
      expect(codeGraphNpmVersionsAreCompatible('^0.0', `0.0.${patch}`)).toBe(true);
      expect(codeGraphNpmVersionsAreCompatible('^0', `1.${minor}.${patch}`)).toBe(false);
      expect(codeGraphNpmVersionsAreCompatible('^0.0', `0.1.${patch}`)).toBe(false);
    },
    {fastCheck: {numRuns: 60}},
  );

  fcProp(
    effectIt,
    'is invariant under repository and moniker ordering',
    {
      reverseMonikers: FC.boolean(),
      rotation: FC.integer({max: 3, min: 0}),
    },
    ({reverseMonikers, rotation}) => {
      const repositories = orderingFixture();
      const baseline = resolveCodeGraphCrossRepositoryBridges(repositories);
      const rotated = EffectArray.map(
        [...repositories.slice(rotation), ...repositories.slice(0, rotation)],
        repository => ({
          ...repository,
          monikers: reverseMonikers ? [...repository.monikers].reverse() : [...repository.monikers],
        }),
      );

      expect(resolveCodeGraphCrossRepositoryBridges(rotated)).toEqual(baseline);
    },
    {fastCheck: {numRuns: 60}},
  );

  fcProp(
    effectIt,
    'binds bridge identity to either endpoint snapshot',
    {seed: FC.integer({max: 10_000, min: 1})},
    ({seed}) => {
      const source = repository(
        `invalidation-source-${seed}`,
        'apps/consumer',
        [packageMoniker('import', '@acme/shared', '^1.0.0', `invalidation-import-${seed}`)],
        `source-${seed}`,
      );
      const target = repository(
        `invalidation-target-${seed}`,
        'packages/shared',
        [packageMoniker('export', '@acme/shared', '1.3.0', `invalidation-export-${seed}`)],
        `target-${seed}`,
      );
      const original = onlyBridge([source, target]);
      const changedSource = onlyBridge([{...source, snapshotId: snapshotId(`source-${seed}-next`)}, target]);
      const changedTarget = onlyBridge([source, {...target, snapshotId: snapshotId(`target-${seed}-next`)}]);

      expect(new Set([original.id, changedSource.id, changedTarget.id]).size).toBe(3);
      expect(changedSource).toMatchObject({identity: original.identity, target: original.target});
      expect(changedTarget).toMatchObject({identity: original.identity, source: original.source});
    },
    {fastCheck: {numRuns: 60}},
  );

  fcProp(
    effectIt,
    'never bridges a same-name package when no compatible import/export pair exists',
    {
      consumerMajor: FC.integer({max: 20, min: 1}),
      producerDelta: FC.integer({max: 20, min: 1}),
    },
    ({consumerMajor, producerDelta}) => {
      const consumer = repository(`no-pair-consumer-${consumerMajor}`, 'apps/consumer', [
        packageMoniker('import', '@acme/shared', `^${consumerMajor}.0.0`, `no-pair-import-${consumerMajor}`),
      ]);
      const producerMajor = consumerMajor + producerDelta;
      const producer = repository(`no-pair-producer-${producerMajor}`, 'packages/shared', [
        packageMoniker('export', '@acme/shared', `${producerMajor}.0.0`, `no-pair-export-${producerMajor}`),
      ]);

      const result = resolveCodeGraphCrossRepositoryBridges([producer, consumer]);

      expect(result.bridges).toEqual([]);
      expect(EffectArray.map(result.rejections, rejection => rejection.reason)).toEqual([
        'incompatible-package-version',
      ]);
    },
    {fastCheck: {numRuns: 80}},
  );
});

function orderingFixture(): readonly CodeGraphBridgeRepositoryV1[] {
  const consumer = repository('ordering-consumer', 'apps/gateway', [
    packageMoniker('import', '@acme/shared', '^1.0.0', 'ordering-package-import'),
    protobufMoniker(
      'import',
      {kind: 'service', packageName: 'acme.orders.v1', qualifiedName: 'acme.orders.v1.Orders'},
      'ordering-service-import',
    ),
  ]);
  const packageProducer = repository('ordering-package-producer', 'packages/shared', [
    packageMoniker('export', '@acme/shared', '1.3.0', 'ordering-package-export'),
  ]);
  const protobufProducer = repository('ordering-protobuf-producer', 'services/orders', [
    protobufMoniker(
      'export',
      {kind: 'service', packageName: 'acme.orders.v1', qualifiedName: 'acme.orders.v1.Orders'},
      'ordering-service-export',
    ),
  ]);
  const unrelated = repository('ordering-unrelated', 'tools/unrelated', [
    packageMoniker('export', '@acme/unrelated', '1.0.0', 'ordering-unrelated-export'),
  ]);
  return [consumer, packageProducer, protobufProducer, unrelated];
}

function onlyBridge(repositories: readonly CodeGraphBridgeRepositoryV1[]) {
  const result = resolveCodeGraphCrossRepositoryBridges(repositories);
  expect(result.rejections).toEqual([]);
  expect(result.bridges).toHaveLength(1);
  return result.bridges[0];
}

function repository(
  seed: string,
  repositoryKey: string,
  monikers: readonly CodeGraphMonikerV1[],
  snapshotSeed = seed,
): CodeGraphBridgeRepositoryV1 {
  return {
    monikers,
    repositoryId: digest(`repository:${seed}`),
    repositoryKey,
    snapshotId: snapshotId(snapshotSeed),
  };
}

function packageMoniker(
  role: 'export' | 'import',
  packageName: string,
  packageVersion: string | undefined,
  seed: string,
) {
  return codeGraphPackageMoniker({
    componentId: `cgp_${Effect.pipe(digest(`component:${seed}`), EffectString.slice(0, 32))}`,
    ...(role === 'import' ? {dependencyKind: 'runtime' as const} : {}),
    evidence: {path: `${seed}/package.json`, span},
    packageName,
    ...(packageVersion === undefined ? {} : {packageVersion}),
    role,
  });
}

function protobufMoniker(
  role: 'export' | 'import',
  identity: {
    readonly importPath?: string;
    readonly kind: CodeGraphProtobufMonikerKind;
    readonly packageName?: string;
    readonly qualifiedName?: string;
  },
  seed: string,
) {
  return codeGraphProtobufMoniker({
    evidence: {path: `proto/${seed}.proto`, span},
    ...identity,
    role,
    symbolId: `cgs_${Effect.pipe(digest(`symbol:${seed}`), EffectString.slice(0, 32))}`,
  });
}

function snapshotId(seed: string): string {
  return `cgsn_${Effect.pipe(digest(`snapshot:${seed}`), EffectString.slice(0, 40))}`;
}

function digest(value: string): string {
  return sha256HexSync(value);
}
