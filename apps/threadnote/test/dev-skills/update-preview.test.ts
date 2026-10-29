import {Array as EffectArray} from 'effect';
import {execFile} from '@threadnote/testing/node-child-process';
import {createHash} from '@threadnote/testing/node-crypto';
import {mkdtemp, readFile, readdir, realpath, rm} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {promisify} from '@threadnote/testing/node-util';
import {inspectCliInvocation} from '@threadnote/threadnote/effect/cli';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import * as EffectRecord from 'effect/Record';

const exec = promisify(execFile);
const previewFlags = ['--check', '--dry-run'] as const;

describe('observational update admission', () => {
  it('recognizes true previews independently of home placement while keeping explicit false on the ordinary path', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...previewFlags),
        fc.boolean(),
        fc.constantFrom('bare', 'separate', 'inline'),
        fc.boolean(),
        (flag, enabled, syntax, homeFirst) => {
          const value = syntax === 'bare' ? true : enabled;
          const flags = syntax === 'bare' ? [flag] : syntax === 'inline' ? [`${flag}=${value}`] : [flag, String(value)];
          const home = ['--home', '/temporary/workflow-home'];
          const args = homeFirst ? [...home, 'update', ...flags] : ['update', ...flags, ...home];
          const inspected = inspectCliInvocation(args);
          expect(inspected.observationalUpdate === true).toBe(value);
          expect(inspected.homeOverride).toBe(home[1]);
          if (value) {
            expect(inspected.writeAnonymousTelemetry).toBe(false);
            expect(inspected.writeProductionLog).toBe(false);
          }
        },
      ),
      {numRuns: 48},
    );
  });

  it('does not turn malformed booleans, extra positionals or other commands into release previews', () => {
    for (const args of [
      ['update', '--check=garbage'],
      ['update', '--dry-run='],
      ['update', '--check', 'garbage'],
      ['update', 'unexpected', '--dry-run'],
      ['update', '--check=false', '--dry-run=false'],
      ['repair', '--dry-run'],
      ['update', '--yes'],
    ])
      expect(inspectCliInvocation(args).observationalUpdate).toBeUndefined();
  });

  it('keeps the complete standalone preview path free of home, cache, lock and registration writes', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-update-preview-')));
    const user = join(root, 'user');
    const home = join(root, 'data');
    const environment = {...process.env};
    for (const key of EffectRecord.keys(environment))
      if (/^(?:THREADNOTE_|CODEX_|CURSOR_|BUN_)/u.test(key) || /^(?:https?|all)_proxy$/iu.test(key))
        delete environment[key];
    Object.assign(environment, {
      HOME: user,
      USERPROFILE: user,
      THREADNOTE_HOME: home,
      THREADNOTE_USER: 'tester',
      THREADNOTE_AGENT_ID: 'test',
      THREADNOTE_INSTALL_ROOT: join(root, 'runtime'),
      THREADNOTE_BIN_DIR: join(root, 'bin'),
      XDG_CONFIG_HOME: join(user, '.config'),
      XDG_DATA_HOME: join(user, '.local/share'),
      XDG_STATE_HOME: join(user, '.local/state'),
      LOCALAPPDATA: join(user, 'AppData/Local'),
      APPDATA: join(user, 'AppData/Roaming'),
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
      NO_COLOR: '1',
    });
    let requests = 0;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: request => {
        requests += 1;
        const origin = new URL(request.url).origin;
        const assets = EffectArray.flatMap(['darwin', 'linux', 'windows'], platform =>
          EffectArray.flatMap(['arm64', 'x64'], arch =>
            EffectArray.map(['', '.sha256'], suffix => ({
              name: `threadnote-${platform}-${arch}.tar.gz${suffix}`,
              browser_download_url: `${origin}/unfetched-${platform}-${arch}${suffix}`,
            })),
          ),
        );
        return Response.json([{assets, draft: false, immutable: true, prerelease: false, tag_name: 'v99.0.0'}]);
      },
    });
    try {
      const before = await snapshot(root);
      for (const flag of previewFlags)
        for (const flags of [[flag], [flag, 'true'], [`${flag}=true`]])
          for (const homeFirst of [true, false]) {
            const homeArgs = ['--home', home];
            const args = [
              ...(homeFirst ? homeArgs : []),
              'update',
              ...flags,
              '--stable',
              '--source',
              `http://127.0.0.1:${server.port}/releases`,
              '--allow-untrusted-source',
              ...(!homeFirst ? homeArgs : []),
            ];
            const result = await exec(
              process.execPath,
              [join(process.cwd(), 'apps/threadnote/src/standalone.ts'), ...args],
              {
                cwd: root,
                env: environment,
                maxBuffer: 1_000_000,
              },
            );
            expect(result.stdout).toContain('99.0.0');
            expect(await snapshot(root)).toEqual(before);
          }
      expect(requests).toBeGreaterThanOrEqual(12);
    } finally {
      await server.stop(true);
      await rm(root, {recursive: true, force: true});
    }
  }, 90_000);
});

async function snapshot(root: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  async function visit(relative: string) {
    for (const entry of await readdir(join(root, relative), {withFileTypes: true})) {
      const child = join(relative, entry.name);
      if (entry.isDirectory()) {
        entries[child] = 'directory';
        await visit(child);
      } else
        entries[child] = createHash('sha256')
          .update(await readFile(join(root, child)))
          .digest('hex');
    }
  }
  await visit('');
  return entries;
}
