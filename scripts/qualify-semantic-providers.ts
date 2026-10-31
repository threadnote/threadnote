import {isJsonObject} from '@threadnote/platform/json';
import * as EffectArray from 'effect/Array';
import * as EffectOption from 'effect/Option';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- Disposable qualification harness owns explicit OS process and evidence-file boundaries. */
import {createHash} from 'node:crypto';
import {copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {Schema} from 'effect';
import {ProbeConfig, expandProbeScratch, providerFixture} from '../tools/semantic/semantic_provider_fixture.js';
import {observeProbeReadiness, startSemanticProbe} from '../tools/semantic/semantic_lsp_probe.js';
import {installProbeSignalCleanup} from '../tools/semantic/semantic_probe_process.js';
import {
  checkProbeDefinition,
  checkProbeReferences,
  checkProbeRename,
  checkProbeShutdown,
} from '../tools/semantic/semantic_probe_assertions.js';
const {values} = parseArgs({
  options: {
    probe: {type: 'boolean'},
    config: {type: 'string'},
    output: {type: 'string'},
  },
  strict: true,
});
if (!values.probe || !values.config || !values.output)
  throw new Error('Use --probe --config <local-probe.json> --output <report.json>');
const configText = await readFile(values.config, 'utf8');
const input: unknown = JSON.parse(configText);
const config = Schema.decodeUnknownSync(ProbeConfig, {onExcessProperty: 'error'})(input);
const sourceHashes = EffectRecord.fromEntries(
  await Promise.all(
    EffectArray.map(
      [
        ['harness', new URL(import.meta.url)],
        ['fixtures', new URL('../tools/semantic/semantic_provider_fixture.ts', import.meta.url)],
        ['transport', new URL('../tools/semantic/semantic_lsp_probe.ts', import.meta.url)],
        ['assertions', new URL('../tools/semantic/semantic_probe_assertions.ts', import.meta.url)],
        ['process', new URL('../tools/semantic/semantic_probe_process.ts', import.meta.url)],
      ],
      async ([name, url]) => [
        String(name),
        createHash('sha256')
          .update(await readFile(url))
          .digest('hex'),
      ],
    ),
  ),
);
const RustStatus = Schema.Struct({health: Schema.Literals(['ok', 'warning', 'error']), quiescent: Schema.Boolean});
let rustStatus: typeof RustStatus.Type | undefined;
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-semantic-provider-')));
const root = join(scratch, 'project');
const java = config.language === 'java';
const fixture = providerFixture(config);
const files = fixture.sources;
const settings = config.settings === undefined ? undefined : expandProbeScratch(config.settings, scratch);
const unsaved = EffectRecord.fromEntries(
  EffectArray.map(EffectRecord.toEntries(files), ([name, text]) => [
    name,
    EffectString.replaceAll('SavedName', 'UnsavedName')(text),
  ]),
);
const hashes: Record<string, string> = {};
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const results: {
  name: string;
  status: string;
  detail?: unknown;
}[] = [];
let stop: Awaited<ReturnType<ReturnType<typeof startSemanticProbe>['stop']>> | undefined;
let initialized: unknown;
let events: string[] = [];
let signalCleanup: ReturnType<typeof installProbeSignalCleanup> | undefined;
try {
  for (const [name, text] of EffectRecord.toEntries(files)) {
    await mkdir(dirname(join(root, name)), {recursive: true});
    await writeFile(join(root, name), text);
    hashes[name] = hash(text);
  }
  for (const [base, entries] of [
    [root, fixture.projectFiles],
    [scratch, fixture.runtimeFiles],
  ] as const) {
    for (const [name, text] of EffectRecord.toEntries(entries)) {
      await mkdir(dirname(join(base, name)), {recursive: true});
      await writeFile(join(base, name), text);
    }
  }
  if (java) {
    await mkdir(join(scratch, 'configuration'));
    await mkdir(join(scratch, 'home'));
    // Copy authored configuration only; never reuse a previous provider's mutable cache.
    await copyFile(join(config.configurationTemplate!, 'config.ini'), join(scratch, 'configuration/config.ini'));
  }
  const args = EffectArray.map(config.args, arg => EffectString.replaceAll('{scratch}', scratch)(arg));
  const peer = startSemanticProbe(resolve(config.command), args, root, settings, (method, params) => {
    if (method === 'experimental/serverStatus' && Schema.is(RustStatus)(params)) rustStatus = params;
  });
  signalCleanup = installProbeSignalCleanup(async signal => {
    const stopped = await peer.stop();
    await writeFile(
      values.output,
      JSON.stringify(
        {
          schemaVersion: 1,
          kind: 'provider-feasibility',
          status: 'interrupted',
          signal,
          stop: stopped,
          scratchRetained: !stopped.cleanup.drained,
        },
        null,
        2,
      ) + '\n',
    );
    if (stopped.cleanup.drained) await rm(scratch, {recursive: true, force: true});
    else process.stderr.write(`Owned provider group did not drain; retained disposable workspace: ${scratch}\n`);
  });
  events = peer.events;
  try {
    initialized = await peer.request(
      'initialize',
      {
        processId: process.pid,
        rootUri: pathToFileURL(root).href,
        clientInfo: {name: 'threadnote-disposable-feasibility', version: '0.0.0'},
        workspaceFolders: [{uri: pathToFileURL(root).href, name: 'disposable'}],
        capabilities: {
          general: {positionEncodings: ['utf-16']},
          ...(config.language === 'rust' ? {experimental: {serverStatusNotification: true}} : {}),
          workspace: {configuration: true, applyEdit: false, workspaceEdit: {documentChanges: true}},
          textDocument: {synchronization: {didSave: true}, rename: {prepareSupport: true}},
        },
        initializationOptions: java ? {settings: settings ?? {}} : settings,
      },
      java ? 120000 : 20000,
    );
    peer.notify('initialized', {});
    peer.notify('workspace/didChangeConfiguration', {settings: settings ?? {}});
    for (const [name, text] of EffectRecord.toEntries(files)) {
      peer.notify('textDocument/didOpen', {
        textDocument: {
          uri: pathToFileURL(join(root, name)).href,
          languageId: config.language,
          version: 1,
          text,
        },
      });
    }
    for (const [name, text] of EffectRecord.toEntries(unsaved)) {
      peer.notify('textDocument/didChange', {
        textDocument: {uri: pathToFileURL(join(root, name)).href, version: 2},
        contentChanges: [{text}],
      });
    }
    const [declaration, dependent] = EffectRecord.keys(files);
    if (config.language === 'rust') {
      const readiness = await observeProbeReadiness(
        timeoutMs =>
          peer.request(
            'textDocument/definition',
            {
              textDocument: {uri: pathToFileURL(join(root, dependent)).href},
              position: {
                line: 1,
                character:
                  EffectOption.getOrElse(
                    EffectString.indexOf('UnsavedName')(EffectString.split('\n')(unsaved[dependent])[1]),
                    () => -1,
                  ) + 2,
              },
            },
            timeoutMs,
          ),
        detail => checkProbeDefinition(unsaved, detail, pathToFileURL(root).href),
      );
      results.push({
        name: 'bounded-project-readiness',
        status: readiness.ready ? 'passed' : 'failed',
        detail: readiness,
      });
    }
    const document = {uri: pathToFileURL(join(root, declaration)).href};
    const declarationLine = EffectOption.getOrElse(
      EffectArray.findFirstIndex(EffectString.split('\n')(unsaved[declaration]), line =>
        EffectString.includes('UnsavedName')(line),
      ),
      () => -1,
    );
    const position = {
      line: declarationLine,
      character:
        EffectOption.getOrElse(
          EffectString.indexOf('UnsavedName')(EffectString.split('\n')(unsaved[declaration])[declarationLine]),
          () => -1,
        ) + 2,
    };
    for (const [name, method, extra] of [
      ['definition', 'textDocument/definition', {}],
      ['references', 'textDocument/references', {context: {includeDeclaration: true}}],
      ['rename', 'textDocument/rename', {newName: 'RenamedName'}],
    ] as const) {
      try {
        const detail = await peer.request(
          method,
          {
            textDocument: name === 'definition' ? {uri: pathToFileURL(join(root, dependent)).href} : document,
            position:
              name === 'definition'
                ? {
                    line: 1,
                    character:
                      EffectOption.getOrElse(
                        EffectString.indexOf('UnsavedName')(EffectString.split('\n')(unsaved[dependent])[1]),
                        () => -1,
                      ) + 2,
                  }
                : position,
            ...extra,
          },
          java ? 60000 : 20000,
        );
        results.push({
          name,
          status: detail == null || (EffectArray.isArray(detail) && detail.length === 0) ? 'empty' : 'observed',
          detail,
        });
      } catch (error) {
        results.push({name, status: 'failed', detail: String(error)});
      }
    }
    results.push({
      name: 'exact-unsaved-definition',
      status: checkProbeDefinition(
        unsaved,
        EffectOption.getOrUndefined(EffectArray.findFirst(results, x => x.name === 'definition'))?.detail,
        pathToFileURL(root).href,
      )
        ? 'passed'
        : 'failed',
    });
    results.push({
      name: 'exact-unsaved-references',
      status: checkProbeReferences(
        unsaved,
        EffectOption.getOrUndefined(EffectArray.findFirst(results, x => x.name === 'references'))?.detail,
        pathToFileURL(root).href,
      )
        ? 'passed'
        : 'failed',
    });
    results.push({
      name: 'complete-unsaved-rename',
      status: checkProbeRename(
        unsaved,
        EffectOption.getOrUndefined(EffectArray.findFirst(results, x => x.name === 'rename'))?.detail,
        pathToFileURL(root).href,
      )
        ? 'passed'
        : 'failed',
    });
    if (fixture.executionMarker) {
      const deadline = performance.now() + 10000;
      while (performance.now() < deadline) {
        try {
          await readFile(join(root, fixture.executionMarker));
          break;
        } catch (error) {
          if (!isJsonObject(error) || error.code !== 'ENOENT') throw error;
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - performance.now()))));
      }
    }
    if (config.language === 'rust') {
      const quiescence = await observeProbeReadiness(
        async () => rustStatus,
        detail => Schema.is(RustStatus)(detail) && detail.quiescent && detail.health !== 'error',
        30000,
      );
      results.push({
        name: 'provider-quiescent-before-stop',
        status: quiescence.ready ? 'passed' : 'failed',
        detail: quiescence,
      });
    }
  } finally {
    stop = await peer.stop();
    results.push({
      name: 'clean-owned-process-shutdown',
      status: checkProbeShutdown(stop) ? 'passed' : 'failed',
    });
  }
  if (fixture.executionMarker) {
    let observation: 'absent' | 'executed' | 'unexpected' = 'absent';
    try {
      observation =
        (await readFile(join(root, fixture.executionMarker), 'utf8')) === 'executed' ? 'executed' : 'unexpected';
    } catch (error) {
      if (!isJsonObject(error) || error.code !== 'ENOENT') throw error;
    }
    results.push({
      name: 'build-execution-marker',
      status: observation === (config.expectedBuildExecution ? 'executed' : 'absent') ? 'passed' : 'failed',
      detail: {
        fixture: config.fixture,
        expected: config.expectedBuildExecution,
        observation,
        phase: 'after-provider-stop',
        settleLimitMilliseconds: 10000,
      },
    });
  }
  for (const name of EffectRecord.keys(hashes)) {
    results.push({
      name: `disk-unchanged:${name}`,
      status: hash(await readFile(join(root, name))) === hashes[name] ? 'passed' : 'failed',
    });
  }
} catch (error) {
  results.push({name: 'startup', status: 'failed', detail: String(error)});
} finally {
  if (!signalCleanup?.interrupted) {
    const report = {
      schemaVersion: 1,
      kind: 'provider-feasibility',
      provider: config.id,
      configSha256: hash(configText),
      sourceHashes,
      declaredVersion: config.version,
      language: config.language,
      fixture: config.fixture ?? 'standard',
      executableSha256: hash(await readFile(resolve(config.command))),
      platform: process.platform,
      architecture: process.arch,
      initialized,
      results,
      stop,
      scratchRetained: stop?.cleanup.drained === false,
      events,
      note: 'Disposable fixture assertions only; this is not a production support receipt.',
    };
    // Replace disposable paths to make the evidence portable and avoid incidental path disclosure.
    const text = EffectString.replaceAll(
      pathToFileURL(root).href,
      'fixture://workspace',
    )(JSON.stringify(report, null, 2));
    await writeFile(values.output, text + '\n');
    process.stdout.write(text + '\n');
    if (stop?.cleanup.drained !== false) await rm(scratch, {recursive: true, force: true});
    else process.stderr.write(`Owned provider group did not drain; retained disposable workspace: ${scratch}\n`);
    if (EffectArray.some(results, x => x.status === 'failed' || x.status === 'empty')) process.exitCode = 1;
    signalCleanup?.dispose();
  }
}
