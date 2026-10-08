import {mkdtemp, mkdir, writeFile, readFile, rm} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {testHttpFetch} from '@threadnote/testing/http-fetch';
import {Effect} from 'effect';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {startManagerTestServer, type ManagerTestServer} from '../helpers/manager-test-server.js';
import * as utils from '../../src/utils.js';
import * as consolidator from '../../src/effect/ai/consolidator.js';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import type {ConsolidationJobResponse, ConsolidationModelOption} from '@threadnote/manager/ui/contracts';

// Real HTTP and child-process boundaries deliberately use Promise tests.
let home: string;
let server: ManagerTestServer;
let generationMarker: string;
const token = 'consolidation-model-test-token';
const uris = [0, 1].map(i => `threadnote://user/tester/memories/durable/projects/threadnote/source-${i}.md`);
const body = {agent: 'codex', uris, kind: 'durable', status: 'active', project: 'threadnote', topic: 'result'};
beforeEach(async () => {
  vi.stubEnv('THREADNOTE_EFFECT_AI', '');
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
  vi.unstubAllEnvs();
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
  it('exposes installed generation choices without a global selection and never leaks paths or receipts', async () => {
    const model = BUILTIN_MODEL_MANIFESTS.find(model => model.role === 'generation')!;
    const directory = join(home, 'models', 'generation', model.id);
    await mkdir(directory, {recursive: true});
    await writeFile(join(directory, `${model.sha256}.gguf`), 'disposable installation fixture');
    const embedding = BUILTIN_MODEL_MANIFESTS.find(model => model.role === 'embedding')!;
    const embeddingDirectory = join(home, 'models', 'embedding', embedding.id);
    await mkdir(embeddingDirectory, {recursive: true});
    await writeFile(join(embeddingDirectory, `${embedding.sha256}.gguf`), 'disposable embedding fixture');
    expect((await request('/api/consolidation-models?agent=local-ai', undefined, false)).status).toBe(401);
    expect(await request('/api/consolidation-models?agent=local-ai')).toEqual({
      status: 200,
      body: {models: [{id: model.id, label: model.id, isDefault: false}]},
    });
    await writeFile(join(home, 'models/selection.json'), JSON.stringify({version: 1, roles: {generation: model.id}}));
    expect((await request('/api/consolidation-models?agent=local-ai')).body.models).toEqual([
      {id: model.id, label: model.id, isDefault: true},
    ]);
    await expect(readFile(generationMarker, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  });
  it('rejects missing and removed local models before creating a job with installation guidance', async () => {
    const native = vi
      .spyOn(consolidator, 'runNativeAiConsolidation')
      .mockImplementation(() => Effect.succeed('Unexpected draft.'));
    const model = BUILTIN_MODEL_MANIFESTS.find(model => model.role === 'generation')!;
    const directory = join(home, 'models', 'generation', model.id);
    const file = join(directory, `${model.sha256}.gguf`);
    await mkdir(directory, {recursive: true});
    await writeFile(file, 'disposable installation fixture');
    const missing = await request('/api/consolidations', {...body, agent: 'local-ai'});
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain('Choose a model');
    const stale = await request('/api/consolidations', {...body, agent: 'local-ai', model: 'no-longer-installed'});
    expect(stale.status).toBe(400);
    expect(stale.body.error).toContain('no longer available');
    await rm(file);
    const removed = await request('/api/consolidations', {...body, agent: 'local-ai', model: model.id});
    expect(removed.status).toBe(400);
    expect(removed.body.error).toContain('threadnote models');
    expect(removed.body.job).toBeUndefined();
    expect(await request('/api/consolidation-models?agent=local-ai')).toEqual({status: 200, body: {models: []}});
    expect(native).not.toHaveBeenCalled();
  });
  it('records and dispatches the explicit local model even with a configured remote provider', async () => {
    vi.stubEnv('THREADNOTE_EFFECT_AI', 'true');
    vi.stubEnv('THREADNOTE_EFFECT_AI_MODEL', 'explicit-remote');
    const native = vi
      .spyOn(consolidator, 'runNativeAiConsolidation')
      .mockImplementation(() => Effect.succeed('Local draft.'));
    const remote = vi
      .spyOn(consolidator, 'runEffectAiConsolidation')
      .mockImplementation(() => Effect.succeed('Remote draft.'));
    const model = BUILTIN_MODEL_MANIFESTS.find(model => model.role === 'generation')!;
    const directory = join(home, 'models', 'generation', model.id);
    await mkdir(directory, {recursive: true});
    await writeFile(join(directory, `${model.sha256}.gguf`), 'disposable installation fixture');
    const local = await request('/api/consolidations', {...body, agent: 'local-ai', model: model.id});
    expect(local.body.job).toMatchObject({status: 'completed', model: model.id, draft: 'Local draft.'});
    expect(native).toHaveBeenCalledWith(
      expect.objectContaining({agentContextHome: home}),
      expect.any(String),
      model.id,
    );
    expect(remote).not.toHaveBeenCalled();
    await expect(readFile(join(home, 'models/selection.json'), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    expect(await request('/api/consolidation-models?agent=effect-ai')).toEqual({
      status: 200,
      body: {models: [{id: 'explicit-remote', label: 'explicit-remote', isDefault: true}]},
    });
    const stale = await request('/api/consolidations', {...body, agent: 'effect-ai', model: model.id});
    expect(stale.status).toBe(400);
    expect(stale.body.job).toBeUndefined();
    const configured = await request('/api/consolidations', {...body, agent: 'effect-ai', model: 'explicit-remote'});
    expect(configured.body.job).toMatchObject({status: 'completed', model: 'explicit-remote', draft: 'Remote draft.'});
    expect(remote).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({model: 'explicit-remote'}));
    expect(native).toHaveBeenCalledTimes(1);
  });
  it('does not fall back from unavailable local AI to the configured remote provider', async () => {
    vi.stubEnv('THREADNOTE_EFFECT_AI', 'true');
    vi.stubEnv('THREADNOTE_EFFECT_AI_MODEL', 'explicit-remote');
    const remote = vi
      .spyOn(consolidator, 'runEffectAiConsolidation')
      .mockImplementation(() => Effect.succeed('Unexpected remote draft.'));
    const result = await request('/api/consolidations', {...body, agent: 'local-ai', model: 'explicit-remote'});
    expect(result.status).toBe(400);
    expect(result.body.error).toContain('threadnote models');
    expect(result.body.job).toBeUndefined();
    expect(remote).not.toHaveBeenCalled();
  });
});
