/* oxlint-disable effecttsgo/node-builtin-import -- Authorized fixed fixture uses native private credential staging and actual CLI/MCP boundaries. */
import {createHash, randomBytes} from 'node:crypto';
import {readFile, lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {strict as assert} from 'node:assert';
import {isDeepStrictEqual} from 'node:util';
import {Array as EffectArray, Record as EffectRecord, Schema, String as EffectString} from 'effect';
import {isJsonObject} from '@threadnote/platform/json';
import * as Native from '@threadnote/platform/system';
import {redactCapabilities, type QualificationCli} from './provider-fixture.js';
import type {Client} from '@modelcontextprotocol/sdk/client/index.js';

const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Writer = Schema.Struct({operation: digest, capability: digest});
export interface WriterFixtureRecord {
  operation: string | null;
  status: string;
  retired: boolean;
  recoveryFile?: string;
  result?: unknown;
}
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/** Opt-in task authorization covers only this authored temporary project, never the caller's repository. */
export async function runProviderApplication(
  home: string,
  project: string,
  sources: Record<string, string>,
  proposal: {handle: {id: string; capability: string; digest: string}},
  run: QualificationCli,
  client: Client,
  within: <A>(promise: Promise<A>, milliseconds: number) => Promise<A>,
  deadline: number,
  results: unknown[],
  records: WriterFixtureRecord[],
) {
  const common = {version: 1, callerCwd: project, milliseconds: 10000, maxBytes: 8192};
  const taskAuthorization = 'p11-owned-disposable-' + EffectString.slice(0, 32)(hash(project));
  const directory = Native.runtimeOpenPrivateWriterDirectory(home);
  try {
    const record: WriterFixtureRecord = {operation: null, status: 'admitting', retired: false};
    records.push(record);
    const admitted = await run(['semantic', 'change', 'admit', '--json'], {
      ...common,
      handle: proposal.handle,
      taskAuthorization,
      diskOwnership: 'closed-disk',
    });
    results.push({
      operation: 'explicit-local-writer-admission',
      fullScenarioQualified: false,
      result: redactCapabilities(admitted.value),
    });
    assert.ok(
      isJsonObject(admitted.value) && admitted.value.status === 'admitted',
      'Exact task and closed-disk authority must be admitted',
    );
    const writer = Schema.decodeUnknownSync(Writer, {onExcessProperty: 'error'})(admitted.value.writer);
    record.operation = writer.operation;
    record.status = 'admitted';
    const recoveryName = 'p11-' + writer.operation + '.json';
    let recovery: ReturnType<typeof Native.runtimeReadPrivateWriterFile> | undefined;
    let applyStarted = false;
    const expected = EffectRecord.fromEntries(
      EffectArray.map(EffectRecord.toEntries(sources), ([name, text]) => [
        name,
        EffectString.replaceAll('UnsavedName', 'RenamedName')(text),
      ]),
    );
    const snapshot = async () =>
      EffectRecord.fromEntries(
        await Promise.all(
          EffectArray.map(EffectRecord.keys(sources), async name => {
            const file = join(project, name),
              bytes = await readFile(file),
              info = await lstat(file, {bigint: true});
            return [name, {sha256: hash(bytes), ino: String(info.ino), mtime: String(info.mtimeNs)}] as const;
          }),
        ),
      );
    const mcp = async (action: 'apply' | 'recover') => {
      const response = await within(
        client.callTool({name: 'semantic_change_' + action, arguments: {request: {...common, writer}}}, undefined, {
          timeout: Math.max(1, Math.min(15000, deadline - Date.now())),
        }),
        deadline - Date.now(),
      );
      assert.ok(
        !response.isError &&
          EffectArray.isArray(response.content) &&
          response.content.length === 1 &&
          isJsonObject(response.content[0]) &&
          typeof response.content[0].text === 'string',
        'Canonical writer response',
      );
      const value: unknown = JSON.parse(response.content[0].text);
      assert.ok(isDeepStrictEqual(value, response.structuredContent), 'Writer compact/canonical parity');
      results.push({
        operation: 'authorized-' + action,
        fullScenarioQualified: false,
        result: redactCapabilities(value),
      });
      return value;
    };
    try {
      // Credential survives only in this verified private fixture if an outcome becomes unknown.
      const bytes = new TextEncoder().encode(JSON.stringify({...common, writer, taskAuthorization}));
      Native.runtimePublishPrivateWriterFile(directory, recoveryName, bytes, {
        mode: 'exclusive',
        nonce: randomBytes(16).toString('hex'),
        assertCurrentSync: () => {},
      });
      recovery = Native.runtimeReadPrivateWriterFile(directory, recoveryName, 8192);
      assert.ok(recovery && hash(recovery.bytes) === hash(bytes), 'Private recovery credential exact round trip');
      record.recoveryFile = join(home, recoveryName);
      applyStarted = true;
      const applied = await mcp('apply');
      record.result = redactCapabilities(applied);
      record.status = 'observed-application';
      assert.ok(isJsonObject(applied) && applied.status === 'applied', 'Exact admitted operation applies');
      for (const [name, text] of EffectRecord.toEntries(expected))
        assert.equal(await readFile(join(project, name), 'utf8'), text, 'Only expected rename bytes');
      const first = await snapshot();
      const retry = await mcp('apply');
      assert.ok(isJsonObject(retry) && retry.status === 'applied', 'Retry reconciles the same operation');
      assert.ok(isDeepStrictEqual(await snapshot(), first), 'Retry does not rewrite source bytes or physical versions');
      const recovered = await mcp('recover');
      assert.ok(
        isJsonObject(recovered) && recovered.status === 'applied',
        'Observational recovery reports complete application',
      );
      assert.ok(isDeepStrictEqual(await snapshot(), first), 'Recovery never replays source');
      const retired = await run(['semantic', 'change', 'retire', '--json'], {
        ...common,
        writer,
        taskAuthorization,
        disposition: 'terminal',
      });
      results.push({
        operation: 'own-terminal-retirement',
        fullScenarioQualified: false,
        result: redactCapabilities(retired.value),
      });
      assert.ok(
        isJsonObject(retired.value) &&
          retired.value.status === 'retired' &&
          retired.value.operation === writer.operation,
        'Only our terminal operation retired',
      );
      record.retired = true;
      record.status = 'retired-terminal';
      return expected;
    } finally {
      if (!applyStarted && !record.retired) {
        const retired = await run(['semantic', 'change', 'retire', '--json'], {
          ...common,
          writer,
          taskAuthorization,
          disposition: 'discarded',
        });
        if (
          isJsonObject(retired.value) &&
          retired.value.status === 'retired' &&
          retired.value.operation === writer.operation
        ) {
          record.retired = true;
          record.status = 'retired-unapplied';
        }
      }
      if (record.retired && recovery) {
        Native.runtimeRemovePrivateWriterFile(directory, recoveryName, recovery.identity, () => {});
        delete record.recoveryFile;
      }
    }
  } finally {
    Native.runtimeClosePrivateWriterDirectory(directory);
  }
}
