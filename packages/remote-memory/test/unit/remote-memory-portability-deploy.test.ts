import {describe, expect, it} from 'vitest';

describe('remote memory reference deployment', () => {
  it('resolves Fly build files from the configuration directory', async () => {
    const directory = 'deploy/threadnote-org';
    const config = Bun.TOML.parse(await Bun.file(`${directory}/fly.toml`).text()) as {
      build: {dockerfile: string; ignorefile: string};
    };
    expect(await Bun.file(`${directory}/${config.build.dockerfile}`).exists()).toBe(true);
    expect(await Bun.file(`${directory}/${config.build.ignorefile}`).exists()).toBe(true);
  });
  // These are direct checkout file boundaries, so a Promise test is appropriate.
  it('separates bootstrap, migrator, and least-privileged runtime database identities', async () => {
    const [compose, initialization, grants] = await Promise.all([
      Bun.file('deploy/remote-memory/compose.yaml').text(),
      Bun.file('deploy/remote-memory/initdb/001-create-roles.sh').text(),
      Bun.file('deploy/remote-memory/grants/001-runtime.sql').text(),
    ]);

    expect(compose).toContain('POSTGRES_USER: postgres');
    expect(compose).toContain('THREADNOTE_REMOTE_MIGRATOR_DATABASE_URL');
    expect(compose).toContain('THREADNOTE_REMOTE_RUNTIME_DATABASE_URL');
    expect(compose).toContain("THREADNOTE_REMOTE_AUTO_MIGRATE: 'false'");
    expect(compose).toContain('THREADNOTE_REMOTE_ENABLED: ${THREADNOTE_REMOTE_ENABLED:-false}');
    expect(compose).toContain('THREADNOTE_REMOTE_CANONICAL_STORE: ${THREADNOTE_REMOTE_CANONICAL_STORE:-postgres}');
    expect(compose).toContain('remote-memory-git:/var/threadnote/memory-git');
    expect(compose).toContain('memory-git-prepare:');
    expect(compose).toContain('runtime-grants:');
    expect(initialization).toContain('LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS');
    expect(grants).toContain('REVOKE ALL ON ALL TABLES IN SCHEMA remote_memory');
    expect(grants).toContain('remote_memory.grant_policy_versions');
    expect(grants).toContain('remote_memory.share_policy_versions');
    expect(grants).toContain(
      'GRANT UPDATE (share_generation, indexed_generation, git_ingest_snapshot_commit, git_ingest_cursor, git_ingest_rejected_path) ON remote_memory.shares',
    );
    expect(grants).not.toMatch(/GRANT UPDATE ON remote_memory\.shares/u);
    expect(grants).toContain('remote_memory.worker_health');
    expect(grants).toContain('GRANT UPDATE (heartbeat_at, last_success_at, last_failure_at, failure_class');
    const selectGrant = /GRANT SELECT ON(?<tables>[\s\S]*?)TO threadnote_remote_runtime;/u.exec(grants)?.groups?.tables;
    expect(selectGrant).toBeDefined();
    expect(selectGrant).not.toContain('remote_memory.audit_events');
    const insertGrant = /GRANT INSERT ON(?<tables>[\s\S]*?)TO threadnote_remote_runtime;/u.exec(grants)?.groups?.tables;
    expect(insertGrant).toContain('remote_memory.projects');
    expect(grants).not.toMatch(/GRANT (?:INSERT|UPDATE|DELETE)[\s\S]*remote_memory\.schema_migrations/u);
    expect(grants).not.toMatch(/GRANT (?:INSERT|UPDATE|DELETE)[\s\S]*remote_memory\.git_beta_import_receipts/u);
  });

  it('installs the source entrypoint runtime dependencies in the production image', async () => {
    const [dockerfile, packageJson] = await Promise.all([
      Bun.file('deploy/remote-memory/Dockerfile').text(),
      Bun.file('package.json').json() as Promise<{readonly dependencies?: Readonly<Record<string, string>>}>,
    ]);

    expect(dockerfile).toContain('FROM oven/bun:1.4.2-alpine AS dependencies');
    expect(dockerfile).not.toContain('COPY patches ./patches');
    expect(dockerfile).toContain('bun install --frozen-lockfile --production --ignore-scripts');
    expect(dockerfile).toContain('apk add --no-cache git');
    expect(dockerfile).toContain('CMD ["bun", "apps/threadnote/src/standalone.ts", "remote-memory-service"]');
    expect(packageJson.dependencies).toMatchObject({
      '@effect/platform-bun': '4.0.0',
      effect: '4.0.0',
      'js-yaml': '^5.4.2',
    });
  });

  it('stages the immutable PostgreSQL migration beside the compiled operator', async () => {
    const build = await Bun.file('scripts/build.ts').text();
    const selfContained = await Bun.file('scripts/check-self-contained.ts').text();
    const migrations = await Bun.file('packages/remote-memory/src/migrations.ts').text();

    expect(build).toContain("const REMOTE_MEMORY_MIGRATION_DIRECTORY = 'remote-memory/migrations'");
    expect(build).toContain("path.join(root, 'packages', 'remote-memory', 'src', 'migrations')");
    expect(migrations).toContain("STANDALONE_REMOTE_MEMORY_MIGRATION_DIRECTORY = 'remote-memory/migrations'");
    expect(migrations).toContain('standaloneMigrationFilePath(executablePath, name)');
    expect(migrations).not.toMatch(/\bprocess\.execPath\b/);
    expect(migrations).not.toContain('new URL(`./remote-memory/migrations/${name}`, import.meta.url)');
    expect(migrations).toContain('new URL(`./migrations/${name}`, import.meta.url)');
    expect(migrations).toContain("name: '001_initial.sql'");
    expect(migrations).toContain("name: '002_git_canonical_pointers.sql'");
    expect(migrations).toContain("name: '003_git_ingest_observations.sql'");
    expect(migrations).toContain("name: '004_durable_memory_proposals.sql'");
    expect(selfContained).toContain("path.join(root, 'dist', 'manager', 'index.html')");
    expect(selfContained).toContain("path.join(root, 'dist', 'remote-memory', 'migrations', name)");
  });
});
