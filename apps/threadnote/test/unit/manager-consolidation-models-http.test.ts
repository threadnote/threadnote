import {mkdtemp, mkdir, writeFile, readFile, rm} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {testHttpFetch} from '@threadnote/testing/http-fetch';
import {Effect} from 'effect';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {startManagerTestServer, type ManagerTestServer} from '../helpers/manager-test-server.js';
import * as utils from '../../src/utils.js';
import type {ConsolidationJobResponse, ConsolidationModelOption} from '@threadnote/manager/ui/contracts';

// Real HTTP and child-process boundaries deliberately use Promise tests.
let home: string;
let server: ManagerTestServer;
let generationMarker: string;
const token = 'consolidation-model-test-token';
const uris = [0, 1].map(i => `threadnote://user/tester/memories/durable/projects/threadnote/source-${i}.md`);
const body = {agent: 'codex', uris, kind: 'durable', status: 'active', project: 'threadnote', topic: 'result'};
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'threadnote-models-http-'));
  generationMarker = join(home, 'generation.txt');
  const executable = join(home, 'codex');
  await writeFile(
    executable,
    `#!/bin/sh
if [ "$1" = app-server ]; then
 while IFS= read -r line; do
  case "$line" in
  *'"method":"initialize"'*) printf '%s\\n' '{"id":1,"result":{}}';;
  *'"method":"model/list"'*) printf '%s\\n' '{"id":2,"result":{"data":[{"model":"current-choice","displayName":"Current choice","isDefault":true,"defaultReasoningEffort":"low"}]}}';;
  esac
 done
else
 model=; effort=; out=
 while [ "$#" -gt 0 ]; do
  case "$1" in
  --model) model="$2"; shift 2;;
  -c) effort="$2"; shift 2;;
  --output-last-message) out="$2"; shift 2;;
  *) shift;;
  esac
 done
 printf '%s\\n%s' "$model" "$effort" > '${generationMarker}'
 printf '%s' 'A generated consolidation draft.' > "$out"
fi
`,
    {mode: 0o700},
  );
  const originalFind = utils.findExecutable;
  vi.spyOn(utils, 'findExecutable').mockImplementation(commands =>
    commands[0] === 'codex' || commands[0] === 'claude' ? Effect.succeed(executable) : originalFind(commands),
  );
  const memoryRoot = join(home, 'data/local/user/tester/memories/durable/projects/threadnote');
  await mkdir(memoryRoot, {recursive: true});
  for (let i = 0; i < 2; i++)
    await writeFile(
      join(memoryRoot, `source-${i}.md`),
      [
        'MEMORY',
        'kind: durable',
        'status: active',
        'project: threadnote',
        `topic: source-${i}`,
        'source_agent_client: test',
        'timestamp: 2026-10-08T00:00:00.000Z',
        '',
        `Source decision ${i}.`,
      ].join('\n'),
    );
  server = await startManagerTestServer(
    {
      agentContextHome: home,
      account: 'local',
      agentId: 'threadnote',
      user: 'tester',
      manifestPath: join(home, 'manifest.yaml'),
    },
    token,
  );
});
afterEach(async () => {
  await server?.close();
  vi.restoreAllMocks();
  if (home) await rm(home, {recursive: true, force: true});
});
async function request(path: string, payload?: Record<string, unknown>, authorized = true) {
  const response = await testHttpFetch(server.url + path, {
    method: payload ? 'POST' : 'GET',
    headers: {'content-type': 'application/json', ...(authorized ? {authorization: `Bearer ${token}`} : {})},
    ...(payload ? {body: JSON.stringify(payload)} : {}),
  });
  return {
    status: response.status,
    body: (await response.json()) as {
      error?: string;
      models?: ConsolidationModelOption[];
      job?: ConsolidationJobResponse;
    },
  };
}

describe('Manager consolidation model HTTP boundary', () => {
  it('requires authentication, validates the agent, and exposes a public catalog without generation', async () => {
    expect((await request('/api/consolidation-models?agent=codex', undefined, false)).status).toBe(401);
    expect((await request('/api/consolidation-models?agent=effect-ai')).status).toBe(400);
    const catalog = await request('/api/consolidation-models?agent=codex');
    expect(catalog).toEqual({
      status: 200,
      body: {models: [{id: 'current-choice', label: 'Current choice', isDefault: true}]},
    });
    expect((await request('/api/consolidation-models?agent=claude')).body.models).toEqual([
      {id: 'sonnet', label: 'Sonnet', isDefault: true},
      {id: 'opus', label: 'Opus', isDefault: false},
      {id: 'haiku', label: 'Haiku', isDefault: false},
    ]);
    await expect(readFile(generationMarker, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  });
  it.each([undefined, '', ' ', 'stale-choice', 'x'.repeat(257)])(
    'rejects missing, invalid or stale model before generation: %s',
    async model => {
      const result = await request('/api/consolidations', {...body, ...(model === undefined ? {} : {model})});
      expect(result.status).toBe(400);
      expect(result.body.error).toMatch(/Choose a model|no longer available/);
      expect(result.body.job).toBeUndefined();
      await expect(readFile(generationMarker, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    },
  );
  it('records the effective choice and generates using exactly that model and provider default effort', async () => {
    const result = await request('/api/consolidations', {...body, model: 'current-choice'});
    expect(result.status).toBe(200);
    expect(result.body.job).toMatchObject({
      status: 'completed',
      model: 'current-choice',
      draft: 'A generated consolidation draft.',
    });
    expect(await readFile(generationMarker, 'utf8')).toBe('current-choice\nmodel_reasoning_effort="low"');
  });
});
