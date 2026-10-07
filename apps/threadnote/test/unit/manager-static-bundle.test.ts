import {testHttpFetch} from '@threadnote/testing/http-fetch';
import {mkdir, mkdtemp, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import * as installation from '@threadnote/workspace/installation';
import {Effect} from 'effect';
import {expect, it, vi} from 'vitest';
import {startManagerTestServer} from '../helpers/manager-test-server.js';

vi.mock('@threadnote/workspace/installation', async importOriginal => {
  const actual = await importOriginal<typeof import('@threadnote/workspace/installation')>();
  return {...actual, toolRoot: vi.fn(actual.toolRoot)};
});

it.each([
  {mode: 'source', directory: 'dist/manager', styleDirectory: 'node_modules/@mdxeditor/editor/dist', standalone: false},
  {mode: 'standalone', directory: 'manager', styleDirectory: 'manager', standalone: true},
])('serves the $mode Manager browser bundle from its build output', async ({directory, styleDirectory, standalone}) => {
  const root = await mkdtemp(join(tmpdir(), 'threadnote-manager-bundle-'));
  const script = 'globalThis.managerBundleLoaded = true;';
  const styles = '.mdxeditor { color: inherit; }';
  try {
    await mkdir(join(root, directory), {recursive: true});
    await writeFile(join(root, directory, 'app.js'), script);
    await mkdir(join(root, styleDirectory), {recursive: true});
    await writeFile(join(root, styleDirectory, 'style.css'), styles);
    vi.mocked(installation.toolRoot).mockImplementation(() => Effect.succeed(root));
    vi.stubGlobal('THREADNOTE_STANDALONE', standalone);
    const server = await startManagerTestServer(
      {
        account: 'local',
        agentContextHome: join(root, 'home'),
        agentId: 'threadnote',
        manifestPath: join(root, 'manifest.yaml'),
        user: 'test',
      },
      'secret',
    );
    try {
      const response = await testHttpFetch(`${server.url}/app.js`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/javascript');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toBe(script);
      const editorStyles = await testHttpFetch(`${server.url}/editor.css`);
      expect(editorStyles.status).toBe(200);
      expect(editorStyles.headers.get('content-type')).toContain('text/css');
      expect(await editorStyles.text()).toBe(styles);
    } finally {
      await server.close();
    }
  } finally {
    vi.unstubAllGlobals();
    vi.mocked(installation.toolRoot).mockReset();
    await rm(root, {force: true, recursive: true});
  }
});
