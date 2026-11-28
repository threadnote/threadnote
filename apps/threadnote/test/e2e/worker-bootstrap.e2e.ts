import {Array as EffectArray} from 'effect';
import {TestError} from '@threadnote/testing/test-error';
import {createHash} from '@threadnote/testing/node-crypto';
import {mkdtemp, rm} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {spawn} from '@threadnote/testing/node-child-process';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {CODE_GRAPH_PARSER_WORKER_ARGUMENT, LOCAL_MODEL_WORKER_ARGUMENT} from '@threadnote/threadnote/worker_protocol';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const root = process.cwd();
const compiled = join(root, 'dist', process.platform === 'win32' ? 'threadnote.exe' : 'threadnote');
let temporaryRoot: string;

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'threadnote-worker-bootstrap-e2e-'));
});

afterAll(async () => {
  await rm(temporaryRoot, {force: true, recursive: true});
});

describe('standalone worker bootstrap', () => {
  it('preserves parser protocol facts and digest in source and one-file compiled executions', async () => {
    // A Tree-sitter language proves that both executions boot the worker and its grammar assets alike.
    const request = parserRequest(
      'worker-bootstrap-e2e',
      'src/worker_bootstrap_e2e.py',
      'python',
      'def parse_through_worker(value):\n    return parse_through_worker(value - 1) if value > 0 else value\n',
    );
    const [source, packaged] = await runParserWorkers(request);

    expect(source).toMatchObject({id: request.id, ok: true, protocol: 1});
    expect(packaged).toMatchObject({id: request.id, ok: true, protocol: 1});
    expect(packaged.facts).toEqual(source.facts);
    expect(factsDigest(packaged.facts)).toBe(factsDigest(source.facts));
  });

  it('refuses TypeScript in a bare worker without a parent-owned compiler', async () => {
    const request = parserRequest(
      'worker-bootstrap-typescript-e2e',
      'src/worker-bootstrap-e2e.ts',
      'typescript',
      EffectArray.join(
        [
          "import {Effect} from 'effect';",
          'export function parseThroughWorker(value: number): number {',
          '  return value > 0 ? parseThroughWorker(value - 1) : value;',
          '}',
        ],
        '\n',
      ),
    );
    const [source, packaged] = await runParserWorkers(request);

    expect(source).toMatchObject({id: request.id, ok: false, protocol: 1});
    expect(packaged).toMatchObject({id: request.id, ok: false, protocol: 1});
    expect(packaged).toEqual(source);
  });

  it('preserves the local-model failure protocol without loading a model', async () => {
    const request = {id: 'worker-bootstrap-model-e2e', operation: 'embedMany', payload: {}, protocol: 1};
    const [source, packaged] = await Promise.all([
      runWorker(
        'source-model',
        process.execPath,
        [join(root, 'apps', 'threadnote', 'src', 'standalone.ts'), LOCAL_MODEL_WORKER_ARGUMENT],
        request,
      ),
      runWorker('compiled-model', compiled, [LOCAL_MODEL_WORKER_ARGUMENT], request),
    ]);

    expect(source).toEqual({error: {tag: 'WorkerProtocolInvalid'}, id: request.id, ok: false, protocol: 1});
    expect(packaged).toEqual(source);
  });
});

function parserRequest(id: string, path: string, language: string, content: string) {
  return {
    file: {
      blobId: 'worker-bootstrap-e2e',
      content,
      contentHash: createHash('sha256').update(content).digest('hex'),
      language,
      mode: '100644',
      path,
      size: Buffer.byteLength(content),
      source: 'commit',
    },
    id,
    protocol: 1,
  };
}

function runParserWorkers(request: ReturnType<typeof parserRequest>) {
  return Promise.all([
    runWorker(
      `source-parser-${request.id}`,
      process.execPath,
      [join(root, 'apps', 'threadnote', 'src', 'standalone.ts'), CODE_GRAPH_PARSER_WORKER_ARGUMENT],
      request,
    ),
    runWorker(`compiled-parser-${request.id}`, compiled, [CODE_GRAPH_PARSER_WORKER_ARGUMENT], request),
  ]);
}

interface WorkerResponse {
  readonly error?: {readonly tag?: string};
  readonly facts?: unknown;
  readonly id?: string;
  readonly ok?: boolean;
  readonly protocol?: number;
}

async function runWorker(
  homeName: string,
  executable: string,
  arguments_: readonly string[],
  request: unknown,
): Promise<WorkerResponse> {
  const child = spawn(executable, arguments_, {
    cwd: root,
    env: {
      ...process.env,
      THREADNOTE_HOME: join(temporaryRoot, homeName),
      THREADNOTE_USER: 'worker-bootstrap-e2e',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdout += String(chunk);
  });
  child.stderr.on('data', chunk => {
    stderr += String(chunk);
  });
  child.stdin.end(`${JSON.stringify(request)}\n`);
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code ?? -1));
  });
  if (exitCode !== 0)
    throw TestError.make({message: `Worker exited ${exitCode}: ${Effect.pipe(stderr, EffectString.slice(0, 1_000))}`});
  const lines = Effect.pipe(stdout, EffectString.trim, EffectString.split(/\r?\n/));
  if (lines.length !== 1 || !lines[0])
    throw TestError.make({message: `Expected one worker response line, got: ${stdout}`});
  const response: unknown = JSON.parse(lines[0]);
  if (!isWorkerResponse(response)) throw TestError.make({message: 'Worker returned an invalid response.'});
  return response;
}

function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (typeof value !== 'object' || value === null || EffectArray.isArray(value)) return false;
  if ('error' in value && value.error !== undefined) {
    if (typeof value.error !== 'object' || value.error === null || EffectArray.isArray(value.error)) return false;
    if ('tag' in value.error && value.error.tag !== undefined && typeof value.error.tag !== 'string') return false;
  }
  return (
    (!('id' in value) || value.id === undefined || typeof value.id === 'string') &&
    (!('ok' in value) || value.ok === undefined || typeof value.ok === 'boolean') &&
    (!('protocol' in value) ||
      value.protocol === undefined ||
      (typeof value.protocol === 'number' && Number.isFinite(value.protocol)))
  );
}

function factsDigest(facts: unknown): string {
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex');
}
