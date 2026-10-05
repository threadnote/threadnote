import {readFile} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';
import {describe, expect, it} from 'vitest';
import {BUILTIN_MODEL_MANIFESTS, CORE_EMBEDDING_MODEL_ID} from '@threadnote/inference/models/builtin';

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly engines?: Readonly<Record<string, string>>;
  readonly overrides?: Readonly<Record<string, string>>;
  readonly packageManager?: string;
  readonly scripts?: Readonly<Record<string, string>>;
}

describe('Bun distribution contract', () => {
  it('uses Bun as the only application runtime and build toolchain', async () => {
    const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as PackageManifest;
    const allDependencies = {...manifest.dependencies, ...manifest.devDependencies};
    const effectVersion = '4.0.0';

    expect(manifest.packageManager).toMatch(/^bun@/);
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
    expect(manifest.devDependencies?.['@effect/tsgo']).toBe('0.48.0');
    expect(manifest.devDependencies?.oxlint).toBe('1.86.0');
    expect(manifest.devDependencies?.['oxlint-tsgolint']).toBe('7.0.2003');
    expect(allDependencies['@effect/platform-node']).toBeUndefined();
    expect(allDependencies['@effect/sql-sqlite-node']).toBeUndefined();
    expect(manifest.engines?.node).toBeUndefined();
    expect(manifest.scripts?.build).toMatch(/^bun /);
    expect(manifest.scripts?.test).toMatch(/^bun /);
    expect(Object.values(manifest.scripts ?? {}).join('\n')).not.toMatch(/\b(?:node|npm|npx)\b/);
  });

  it('patches only the vulnerable PostCSS Nano ID edge', async () => {
    const [manifestText, lockfile] = await Promise.all([
      readFile(join(process.cwd(), 'package.json'), 'utf8'),
      readFile(join(process.cwd(), 'bun.lock'), 'utf8'),
    ]);
    const manifest = JSON.parse(manifestText) as PackageManifest;

    expect(manifest.dependencies?.nanoid).toBeUndefined();
    expect(manifest.devDependencies?.nanoid).toBeUndefined();
    expect(manifest.overrides?.nanoid).toBeUndefined();
    expect(lockfile).toContain('"nanoid": ["nanoid@5.1.16"');
    expect(lockfile).toContain('"postcss/nanoid": ["nanoid@3.3.18"');
    expect(lockfile).not.toContain('"postcss/nanoid": ["nanoid@3.3.16"');
  });

  it('pins the MCP SDK Ajv fast-uri edge to a patched release', async () => {
    const [manifestText, lockfile] = await Promise.all([
      readFile(join(process.cwd(), 'package.json'), 'utf8'),
      readFile(join(process.cwd(), 'bun.lock'), 'utf8'),
    ]);
    const manifest = JSON.parse(manifestText) as PackageManifest;

    expect(manifest.overrides?.['fast-uri']).toBe('3.1.8');
    expect(lockfile).toContain('"fast-uri": ["fast-uri@3.1.8"');
    expect(lockfile).toMatch(
      /^\s+"@modelcontextprotocol\/sdk": \["@modelcontextprotocol\/sdk@1\.30\.0"[^\r\n]*"ajv": "\^8\.17\.1"/mu,
    );
    expect(lockfile).toMatch(/^\s+"ajv": \["ajv@8\.20\.0"[^\r\n]*"fast-uri": "\^3\.0\.1"/mu);
  });

  it('keeps Vitest and Istanbul coverage on one exact release', async () => {
    const [manifestText, lockfile] = await Promise.all([
      readFile(join(process.cwd(), 'package.json'), 'utf8'),
      readFile(join(process.cwd(), 'bun.lock'), 'utf8'),
    ]);
    const manifest = JSON.parse(manifestText) as PackageManifest;
    const vitestVersion = manifest.devDependencies?.vitest;
    const coverageVersion = manifest.devDependencies?.['@vitest/coverage-istanbul'];
    const vitestLockEntry = lockfile.match(/^\s+"vitest": \["vitest@([^"\r\n]+)"[^\r\n]*$/mu);
    const coverageLockEntry = lockfile.match(
      /^\s+"@vitest\/coverage-istanbul": \["@vitest\/coverage-istanbul@([^"\r\n]+)"[^\r\n]*$/mu,
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
    const manifest = JSON.parse(manifestText) as PackageManifest;
    const noticeVersion = thirdPartyNotice.match(/^- `jose` ([^\s]+) \(MIT\),/mu)?.[1];

    expect(manifest.dependencies?.jose).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(noticeVersion).toBe(manifest.dependencies?.jose);
  });

  it('keeps the direct pxpipe-proxy attribution aligned with the runtime dependency', async () => {
    const [manifestText, thirdPartyNotice] = await Promise.all([
      readFile(join(process.cwd(), 'package.json'), 'utf8'),
      readFile(join(process.cwd(), 'THIRD_PARTY.md'), 'utf8'),
    ]);
    const manifest = JSON.parse(manifestText) as PackageManifest;
    const noticeVersion = thirdPartyNotice.match(/^- `pxpipe-proxy` ([^\s]+) \(MIT\),/mu)?.[1];

    expect(manifest.dependencies?.['pxpipe-proxy']).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(noticeVersion).toBe(manifest.dependencies?.['pxpipe-proxy']);
  });

  it('keeps release-coupled native and type packages exact in the manifest and lockfile', async () => {
    const [manifestText, lockfile, thirdPartyNotices] = await Promise.all([
      readFile(join(process.cwd(), 'package.json'), 'utf8'),
      readFile(join(process.cwd(), 'bun.lock'), 'utf8'),
      readFile(join(process.cwd(), 'THIRD_PARTY.md'), 'utf8'),
    ]);
    const manifest = JSON.parse(manifestText) as PackageManifest;
    const nodeLlamaCppVersion = manifest.dependencies?.['node-llama-cpp'];
    const postgresVersion = manifest.dependencies?.postgres;
    const bunTypesVersion = manifest.devDependencies?.['@types/bun'];
    const bunRuntimeVersion = manifest.packageManager?.match(/^bun@(.+)$/u)?.[1];
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
      BUILTIN_MODEL_MANIFESTS.find(manifest => manifest.id === CORE_EMBEDDING_MODEL_ID)?.runtime.nodeLlamaCpp,
    ).toBe(nodeLlamaCppVersion);
  });
});
