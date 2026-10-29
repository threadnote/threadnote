import {Array as EffectArray, Option as EffectOption} from 'effect';
import {readFile} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';
import {describe, expect, it} from 'vitest';
import {Schema} from 'effect';
import {BUILTIN_MODEL_MANIFESTS, CORE_EMBEDDING_MODEL_ID} from '@threadnote/inference/models/builtin';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly engines?: Readonly<Record<string, string>>;
  readonly overrides?: Readonly<Record<string, string>>;
  readonly packageManager?: string;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly trustedDependencies?: readonly string[];
}

const JsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const PackageManifestSchema = Schema.StructWithRest(
  Schema.Struct({
    dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    devDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    engines: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    overrides: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    packageManager: Schema.optionalKey(Schema.String),
    scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    trustedDependencies: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  [JsonRecordSchema],
);

function parsePackageManifest(value: unknown): PackageManifest {
  return Schema.decodeUnknownSync(PackageManifestSchema)(value);
}

describe('Bun distribution contract', () => {
  it('uses Bun as the only application runtime and build toolchain', async () => {
    const manifest = parsePackageManifest(JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')));
    const allDependencies = {...manifest.dependencies, ...manifest.devDependencies};
    const effectVersion = '4.0.7';

    expect(manifest.packageManager).toMatch(/^bun@/);
    expect(manifest.trustedDependencies).toEqual([]);
    for (const packageName of [
      '@effect/ai-openai-compat',
      '@effect/platform-bun',
      '@effect/sql-sqlite-bun',
      '@effect/vitest',
      'effect',
    ]) {
      expect(allDependencies[packageName]).toBe(effectVersion);
    }
    expect(manifest.overrides?.['@effect/platform-node-shared']).toBe(effectVersion);
    expect(manifest.devDependencies?.['@effect/tsgo']).toBe('0.63.0');
    expect(manifest.devDependencies?.oxlint).toBe('1.90.0');
    expect(manifest.devDependencies?.['oxlint-tsgolint']).toBe('7.0.2005');
    expect(allDependencies['@effect/platform-node']).toBeUndefined();
    expect(allDependencies['@effect/sql-sqlite-node']).toBeUndefined();
    expect(manifest.engines?.node).toBeUndefined();
    expect(manifest.scripts?.build).toMatch(/^bun /);
    expect(manifest.scripts?.test).toMatch(/^bun /);
    expect(EffectArray.join(EffectRecord.values(manifest.scripts ?? {}), '\n')).not.toMatch(/\b(?:node|npm|npx)\b/);
  });

  it('patches only the vulnerable PostCSS Nano ID edge', async () => {
    const [manifestText, lockfile] = await Promise.all([
      readFile(join(process.cwd(), 'package.json'), 'utf8'),
      readFile(join(process.cwd(), 'bun.lock'), 'utf8'),
    ]);
    const manifest = parsePackageManifest(JSON.parse(manifestText));

    expect(manifest.dependencies?.nanoid).toBeUndefined();
    expect(manifest.devDependencies?.nanoid).toBeUndefined();
    expect(manifest.overrides?.nanoid).toBeUndefined();
    expect(lockfile).toContain('"nanoid": ["nanoid@5.1.16"');
    expect(lockfile).toContain('"postcss/nanoid": ["nanoid@3.3.20"');
    expect(lockfile).not.toContain('"postcss/nanoid": ["nanoid@3.3.16"');
  });

  it('pins the MCP SDK Ajv fast-uri edge to a patched release', async () => {
    const [manifestText, lockfile] = await Promise.all([
      readFile(join(process.cwd(), 'package.json'), 'utf8'),
      readFile(join(process.cwd(), 'bun.lock'), 'utf8'),
    ]);
    const manifest = parsePackageManifest(JSON.parse(manifestText));

    expect(manifest.overrides?.['fast-uri']).toBe('3.1.9');
    expect(lockfile).toContain('"fast-uri": ["fast-uri@3.1.9"');
    expect(lockfile).toMatch(
      /^\s+"@modelcontextprotocol\/sdk": \["@modelcontextprotocol\/sdk@1\.32\.2"[^\r\n]*"ajv": "\^8\.17\.1"/mu,
    );
    expect(lockfile).toMatch(/^\s+"ajv": \["ajv@8\.20\.0"[^\r\n]*"fast-uri": "\^3\.0\.1"/mu);
  });

  it('keeps audited HTTP and schema dependencies on patched releases', async () => {
    const lockfile = await readFile(join(process.cwd(), 'bun.lock'), 'utf8');
    for (const [name, version] of [
      ['body-parser', '2.4.0'],
      ['ip-address', '10.7.5'],
      ['qs', '6.17.0'],
      ['zod', '4.6.7'],
    ]) {
      expect(lockfile).toContain(`"${name}": ["${name}@${version}"`);
    }
  });

  it('keeps Vitest and Istanbul coverage on one exact release', async () => {
    const [manifestText, lockfile] = await Promise.all([
      readFile(join(process.cwd(), 'package.json'), 'utf8'),
      readFile(join(process.cwd(), 'bun.lock'), 'utf8'),
    ]);
    const manifest = parsePackageManifest(JSON.parse(manifestText));
    const vitestVersion = manifest.devDependencies?.vitest;
    const coverageVersion = manifest.devDependencies?.['@vitest/coverage-istanbul'];
    const vitestLockEntry = Effect.pipe(
      lockfile,
      EffectString.match(/^\s+"vitest": \["vitest@([^"\r\n]+)"[^\r\n]*$/mu),
      Effect.Option.getOrElse(() => null),
    );
    const coverageLockEntry = Effect.pipe(
      lockfile,
      EffectString.match(/^\s+"@vitest\/coverage-istanbul": \["@vitest\/coverage-istanbul@([^"\r\n]+)"[^\r\n]*$/mu),
      Effect.Option.getOrElse(() => null),
    );

    expect(vitestVersion).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
    expect(coverageVersion).toBe(vitestVersion);
    expect(vitestLockEntry?.[1]).toBe(vitestVersion);
    expect(coverageLockEntry?.[1]).toBe(vitestVersion);
    expect(coverageLockEntry?.[0]).toContain(`"peerDependencies": { "vitest": "${vitestVersion}" }`);
  });

  it('keeps the direct jose attribution aligned with the runtime dependency', async () => {
    const [manifestText, thirdPartyNotice] = await Promise.all([
      readFile(join(process.cwd(), 'package.json'), 'utf8'),
      readFile(join(process.cwd(), 'THIRD_PARTY.md'), 'utf8'),
    ]);
    const manifest = parsePackageManifest(JSON.parse(manifestText));
    const noticeVersion = Effect.pipe(
      thirdPartyNotice,
      EffectString.match(/^- `jose` ([^\s]+) \(MIT\),/mu),
      Effect.Option.getOrElse(() => null),
    )?.[1];

    expect(manifest.dependencies?.jose).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(noticeVersion).toBe(manifest.dependencies?.jose);
  });

  it('keeps the direct pxpipe-proxy attribution aligned with the runtime dependency', async () => {
    const [manifestText, thirdPartyNotice] = await Promise.all([
      readFile(join(process.cwd(), 'package.json'), 'utf8'),
      readFile(join(process.cwd(), 'THIRD_PARTY.md'), 'utf8'),
    ]);
    const manifest = parsePackageManifest(JSON.parse(manifestText));
    const noticeVersion = Effect.pipe(
      thirdPartyNotice,
      EffectString.match(/^- `pxpipe-proxy` ([^\s]+) \(MIT\),/mu),
      Effect.Option.getOrElse(() => null),
    )?.[1];

    expect(manifest.dependencies?.['pxpipe-proxy']).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(noticeVersion).toBe(manifest.dependencies?.['pxpipe-proxy']);
  });

  it('keeps release-coupled native and type packages exact in the manifest and lockfile', async () => {
    const [manifestText, lockfile, thirdPartyNotices] = await Promise.all([
      readFile(join(process.cwd(), 'package.json'), 'utf8'),
      readFile(join(process.cwd(), 'bun.lock'), 'utf8'),
      readFile(join(process.cwd(), 'THIRD_PARTY.md'), 'utf8'),
    ]);
    const manifest = parsePackageManifest(JSON.parse(manifestText));
    const nodeLlamaCppVersion = manifest.dependencies?.['node-llama-cpp'];
    const postgresVersion = manifest.dependencies?.postgres;
    const bunTypesVersion = manifest.devDependencies?.['@types/bun'];
    const bunRuntimeVersion = Effect.pipe(manifest.packageManager, effectOptionalString =>
      effectOptionalString == null
        ? undefined
        : Effect.pipe(
            effectOptionalString,
            EffectString.match(/^bun@(.+)$/u),
            Effect.Option.getOrElse(() => null),
          ),
    )?.[1];
    const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

    for (const version of [nodeLlamaCppVersion, postgresVersion, bunTypesVersion]) {
      expect(version).toMatch(exactVersion);
    }
    expect(lockfile).toContain(`"node-llama-cpp": ["node-llama-cpp@${nodeLlamaCppVersion}"`);
    expect(lockfile).toContain(`"postgres": ["postgres@${postgresVersion}"`);
    expect(thirdPartyNotices).toContain(`\`postgres\` ${postgresVersion} (MIT)`);
    expect(lockfile).toContain(`"@types/bun": ["@types/bun@${bunTypesVersion}"`);
    expect(lockfile).toContain(`"bun-types": ["bun-types@${bunTypesVersion}"`);
    expect(bunTypesVersion).toBe(bunRuntimeVersion);

    for (const packageName of [
      '@node-llama-cpp/linux-arm64',
      '@node-llama-cpp/linux-x64',
      '@node-llama-cpp/mac-arm64-metal',
      '@node-llama-cpp/mac-x64',
      '@node-llama-cpp/win-arm64',
      '@node-llama-cpp/win-x64',
    ]) {
      expect(lockfile).toContain(`"${packageName}": ["${packageName}@${nodeLlamaCppVersion}"`);
    }
    expect(
      EffectOption.getOrUndefined(
        EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, manifest => manifest.id === CORE_EMBEDDING_MODEL_ID),
      )?.runtime.nodeLlamaCpp,
    ).toBe(nodeLlamaCppVersion);
  });
});
