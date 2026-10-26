/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- Disposable qualification harness owns explicit OS process and evidence-file boundaries. */
import {createHash} from 'node:crypto';
import {copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {startSemanticProbe} from '../tools/semantic/semantic_lsp_probe.js';
import {installProbeSignalCleanup} from '../tools/semantic/semantic_probe_process.js';
import {
  checkProbeDefinition,
  checkProbeReferences,
  checkProbeRename,
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
const config = JSON.parse(await readFile(values.config, 'utf8')) as {
  id: string;
  command: string;
  args: string[];
  language: 'python' | 'typescript' | 'java';
  version: string;
  settings?: unknown;
  configurationTemplate?: string;
};
if (
  !['python', 'typescript', 'java'].includes(config.language) ||
  !Array.isArray(config.args) ||
  !config.args.every(x => typeof x === 'string')
) {
  throw new Error(
    'This disposable harness supports Python, TypeScript and Java fixtures only; Go/Rust probes remain to be implemented and Kotlin is deferred',
  );
}
if (config.language === 'java' && typeof config.configurationTemplate !== 'string')
  throw new Error('Java requires an explicit JDT LS configurationTemplate directory containing config.ini');
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-semantic-provider-')));
const root = join(scratch, 'project');
const python = config.language === 'python';
const java = config.language === 'java';
const files: Record<string, string> = python
  ? {
      'a.py': 'class SavedName:\r\n    def value(self):\r\n        return "🧵"\r\n',
      'b.py': 'from a import SavedName\r\nresult = SavedName().value()\r\n',
    }
  : java
    ? {
        'src/main/java/demo/Subject.java':
          'package demo;\r\n/* 🧵 */ class SavedName { String value() { return "🧵"; } }\r\n',
        'src/main/java/demo/Usage.java': 'package demo;\r\nclass Usage { SavedName value = new SavedName(); }\r\n',
      }
    : {
        'a.ts': 'export /* 🧵 */ class SavedName { value() { return "🧵"; } }\r\n',
        'b.ts': 'import { SavedName } from "./a";\r\nconst result = new SavedName().value();\r\n',
      };
const unsaved = Object.fromEntries(
  Object.entries(files).map(([name, text]) => [name, text.replaceAll('SavedName', 'UnsavedName')]),
);
const hashes: Record<string, string> = {};
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const results: {name: string; status: string; detail?: unknown}[] = [];
let stop: Awaited<ReturnType<ReturnType<typeof startSemanticProbe>['stop']>> | undefined;
let initialized: unknown;
let events: string[] = [];
let signalCleanup: ReturnType<typeof installProbeSignalCleanup> | undefined;
try {
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), {recursive: true});
    await writeFile(join(root, name), text);
    hashes[name] = hash(text);
  }
  if (java) {
    await writeFile(
      join(root, 'pom.xml'),
      '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>example</groupId><artifactId>semantic-fixture</artifactId><version>1.0</version><properties><maven.compiler.source>21</maven.compiler.source><maven.compiler.target>21</maven.compiler.target></properties></project>',
    );
    await mkdir(join(scratch, 'configuration'));
    await mkdir(join(scratch, 'home'));
    // Copy authored configuration only; never reuse a previous provider's mutable cache.
    await copyFile(join(config.configurationTemplate!, 'config.ini'), join(scratch, 'configuration/config.ini'));
  } else if (!python)
    await writeFile(join(root, 'tsconfig.json'), JSON.stringify({compilerOptions: {strict: true}, include: ['*.ts']}));
  const args = config.args.map(arg => arg.replaceAll('{scratch}', scratch));
  const peer = startSemanticProbe(resolve(config.command), args, root, config.settings);
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
          workspace: {configuration: true, applyEdit: false, workspaceEdit: {documentChanges: true}},
          textDocument: {synchronization: {didSave: true}, rename: {prepareSupport: true}},
        },
        initializationOptions: java ? {settings: config.settings ?? {}} : config.settings,
      },
      java ? 120_000 : 20_000,
    );
    peer.notify('initialized', {});
    peer.notify('workspace/didChangeConfiguration', {settings: config.settings ?? {}});
    for (const [name, text] of Object.entries(files)) {
      peer.notify('textDocument/didOpen', {
        textDocument: {
          uri: pathToFileURL(join(root, name)).href,
          languageId: config.language,
          version: 1,
          text,
        },
      });
    }
    for (const [name, text] of Object.entries(unsaved)) {
      peer.notify('textDocument/didChange', {
        textDocument: {uri: pathToFileURL(join(root, name)).href, version: 2},
        contentChanges: [{text}],
      });
    }
    const [declaration, dependent] = Object.keys(files);
    const document = {uri: pathToFileURL(join(root, declaration)).href};
    const declarationLine = unsaved[declaration].split('\n').findIndex(line => line.includes('UnsavedName'));
    const position = {
      line: declarationLine,
      character: unsaved[declaration].split('\n')[declarationLine].indexOf('UnsavedName') + 2,
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
                ? {line: 1, character: unsaved[dependent].split('\n')[1].indexOf('UnsavedName') + 2}
                : position,
            ...extra,
          },
          java ? 60_000 : 20_000,
        );
        results.push({
          name,
          status: detail == null || (Array.isArray(detail) && detail.length === 0) ? 'empty' : 'observed',
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
        results.find(x => x.name === 'definition')?.detail,
        pathToFileURL(root).href,
      )
        ? 'passed'
        : 'failed',
    });
    results.push({
      name: 'exact-unsaved-references',
      status: checkProbeReferences(
        unsaved,
        results.find(x => x.name === 'references')?.detail,
        pathToFileURL(root).href,
      )
        ? 'passed'
        : 'failed',
    });
    results.push({
      name: 'complete-unsaved-rename',
      status: checkProbeRename(unsaved, results.find(x => x.name === 'rename')?.detail, pathToFileURL(root).href)
        ? 'passed'
        : 'failed',
    });
  } finally {
    stop = await peer.stop();
    results.push({
      name: 'clean-owned-process-shutdown',
      status:
        stop.code === 0 && !stop.forced && stop.cleanup.drained && stop.cleanup.scope === 'posix-process-group'
          ? 'passed'
          : 'failed',
    });
  }
  for (const name of Object.keys(hashes)) {
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
      declaredVersion: config.version,
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
    const text = JSON.stringify(report, null, 2).replaceAll(pathToFileURL(root).href, 'fixture://workspace');
    await writeFile(values.output, text + '\n');
    process.stdout.write(text + '\n');
    if (stop?.cleanup.drained !== false) await rm(scratch, {recursive: true, force: true});
    else process.stderr.write(`Owned provider group did not drain; retained disposable workspace: ${scratch}\n`);
    if (results.some(x => x.status === 'failed' || x.status === 'empty')) process.exitCode = 1;
    signalCleanup?.dispose();
  }
}
