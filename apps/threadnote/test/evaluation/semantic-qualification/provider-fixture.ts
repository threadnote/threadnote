/* oxlint-disable effecttsgo/node-builtin-import -- Qualification verifies explicit local artifacts and disposable fixture bytes. */
import {createHash} from 'node:crypto';
import {readFile, mkdir, writeFile, lstat} from 'node:fs/promises';
import {join, relative, isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {strict as assert} from 'node:assert';
import {isDeepStrictEqual} from 'node:util';
import {Array as EffectArray, Effect, Layer, Record as EffectRecord, Schema, String as EffectString} from 'effect';
import * as BunServices from '@effect/platform-bun/BunServices';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {isJsonObject} from '@threadnote/platform/json';
import {semanticTreeDigest, semanticSdkDigest} from '../../../src/semantic/fingerprint.js';
import {
  javaPreparedModelJson,
  javaSourceEncodingImage,
  loadJavaPreparedModel,
  type JavaPreparedModel,
} from '../../../src/semantic/providers/java_preparation.js';
import {providerFixture} from '../../../../../tools/semantic/semantic_provider_fixture.js';
import {checkProbeDefinition, checkProbeReferences} from '../../../../../tools/semantic/semantic_probe_assertions.js';
import {checkProposalStatusTransportParity} from './transport-oracle.js';
import type {Client} from '@modelcontextprotocol/sdk/client/index.js';

const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const common = {
  version: Schema.Literal(1),
  notices: Schema.Array(Schema.Struct({component: Schema.String, file: Schema.String, sha256: digest})).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
  ),
};
const node = {
  ...common,
  runtime: Schema.String,
  runtimeDigest: digest,
  runtimeVersion: Schema.Literal('24.19.0'),
  serverDirectory: Schema.String,
  serverTreeDigest: digest,
};
export const ProviderInputs = Schema.Union([
  Schema.Struct({
    ...node,
    language: Schema.Literals(['typescript', 'javascript']),
    sdkDirectory: Schema.String,
    sdkTreeDigest: digest,
  }),
  Schema.Struct({...node, language: Schema.Literal('python')}),
  Schema.Struct({
    ...common,
    language: Schema.Literal('go'),
    providerVersion: Schema.Literal('v0.24.0'),
    executable: Schema.String,
    executableDigest: digest,
    goVersion: Schema.Literal('1.27.3'),
    goExecutableDigest: digest,
    sdkDirectory: Schema.String,
    sdkTreeDigest: digest,
  }),
  Schema.Struct({
    ...common,
    language: Schema.Literal('rust'),
    providerVersion: Schema.Literal('0.3.3097-standalone (0c4d74686b 2026-10-22)'),
    executable: Schema.String,
    executableDigest: digest,
    rustVersion: Schema.Literal('1.99.1'),
    rustcExecutableDigest: digest,
    cargoExecutableDigest: digest,
    rustdocExecutableDigest: digest,
    sdkDirectory: Schema.String,
    sdkTreeDigest: digest,
  }),
  Schema.Struct({
    ...common,
    language: Schema.Literal('java'),
    providerVersion: Schema.Literal('1.63.0-202610191322'),
    serverDirectory: Schema.String,
    serverTreeDigest: digest,
    configurationDigest: digest,
    runtimeVersion: Schema.Literal('25.0.5+8'),
    runtimeJavaHome: Schema.String,
    runtimeSdkDigest: digest,
    runtimeExecutableDigest: digest,
    projectVersion: Schema.Literal('21.0.13+9'),
    projectJavaHome: Schema.String,
    projectSdkDigest: digest,
    projectExecutableDigest: digest,
  }),
]);
export type ProviderInputs = typeof ProviderInputs.Type;
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const tree = (directory: string, sdk = false) =>
  Effect.runPromise(
    (sdk ? semanticSdkDigest(directory) : semanticTreeDigest(directory)).pipe(
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Standalone Promise boundary owns the complete byte-verification program and its narrow services.
      Effect.provide(Layer.merge(BunServices.layer, cryptoLayer)),
    ),
  );

export async function readProviderInputs(file: string) {
  const bytes = await readFile(file);
  const input = Schema.decodeUnknownSync(ProviderInputs, {onExcessProperty: 'error'})(JSON.parse(bytes.toString()));
  if (input.language === 'go') {
    assert.equal(hash(await readFile(input.executable)), input.executableDigest, 'Pinned Go provider bytes');
    assert.equal(
      hash(await readFile(join(input.sdkDirectory, 'bin/go'))),
      input.goExecutableDigest,
      'Pinned Go tool bytes',
    );
    assert.equal(
      EffectString.split('\n')(await readFile(join(input.sdkDirectory, 'VERSION'), 'utf8'))[0],
      'go' + input.goVersion,
      'Pinned Go SDK version metadata; no runtime execution',
    );
    assert.equal(await tree(input.sdkDirectory, true), input.sdkTreeDigest, 'Complete Go SDK tree');
    assert.ok(
      EffectArray.some(input.notices, notice => notice.component === 'gopls') &&
        EffectArray.some(input.notices, notice => notice.component === 'go-sdk'),
      'Explicit Go provider and SDK notice objects',
    );
  } else if (input.language === 'rust') {
    assert.equal(hash(await readFile(input.executable)), input.executableDigest, 'Pinned Rust provider bytes');
    for (const [tool, expected] of [
      ['rustc', input.rustcExecutableDigest],
      ['cargo', input.cargoExecutableDigest],
      ['rustdoc', input.rustdocExecutableDigest],
    ])
      assert.equal(
        hash(await readFile(join(input.sdkDirectory, 'bin', tool))),
        expected,
        'Pinned Rust ' + tool + ' bytes',
      );
    assert.equal(await tree(input.sdkDirectory, true), input.sdkTreeDigest, 'Complete Rust SDK tree');
    assert.ok(
      EffectArray.every(
        ['rust-analyzer-source-mit', 'rust-analyzer-source-apache', 'rust-sdk-copyright', 'cargo-third-party'],
        component => EffectArray.some(input.notices, notice => notice.component === component),
      ),
      'Explicit Rust provider source and SDK notice objects',
    );
  } else if (input.language === 'java') {
    for (const [directory, expected, executable, version] of [
      [input.runtimeJavaHome, input.runtimeSdkDigest, input.runtimeExecutableDigest, input.runtimeVersion],
      [input.projectJavaHome, input.projectSdkDigest, input.projectExecutableDigest, input.projectVersion],
    ]) {
      assert.equal(hash(await readFile(join(directory, 'bin/java'))), executable, 'Pinned Java executable bytes');
      assert.ok(
        EffectString.includes('JAVA_RUNTIME_VERSION="' + version + '-LTS"')(
          await readFile(join(directory, 'release'), 'utf8'),
        ),
        'Pinned Java release metadata; no JVM execution',
      );
      assert.equal(await tree(directory, true), expected, 'Complete Java SDK tree');
    }
    assert.equal(await tree(input.serverDirectory, true), input.serverTreeDigest, 'Complete JDT provider tree');
    assert.equal(
      hash(await readFile(join(input.serverDirectory, 'config_mac_arm/config.ini'))),
      input.configurationDigest,
      'Pinned JDT Darwin arm64 configuration bytes',
    );
    assert.ok(
      EffectArray.every(['jdtls-source', 'java-runtime-sdk', 'java-project-sdk'], component =>
        EffectArray.some(input.notices, notice => notice.component === component),
      ),
      'Explicit JDT source and both Java SDK notice objects',
    );
  } else {
    assert.equal(hash(await readFile(input.runtime)), input.runtimeDigest, 'Pinned runtime bytes');
    assert.equal(await tree(input.serverDirectory), input.serverTreeDigest, 'Complete provider tree');
    if (input.language !== 'python')
      assert.equal(await tree(input.sdkDirectory), input.sdkTreeDigest, 'Complete SDK tree');
  }
  for (const notice of input.notices)
    assert.equal(hash(await readFile(notice.file)), notice.sha256, 'Exact local notice bytes');
  return {
    input,
    manifestSha256: hash(bytes),
    notices: input.notices,
    licenseDisposition: 'notice-bytes-recorded; selected-profile and redistribution review remain required',
    ...(input.language === 'go' || input.language === 'rust' || input.language === 'java'
      ? {
          sdkProofDisposition:
            'complete local bytes recorded; SDK provenance and component inventory remain unqualified',
        }
      : {}),
  };
}

export function selectedFixture(input: ProviderInputs) {
  const fixture = providerFixture({language: input.language});
  const sources = EffectRecord.fromEntries(
    EffectArray.map(EffectRecord.toEntries(fixture.sources), ([name, text]) => [
      name,
      EffectString.replaceAll('SavedName', 'UnsavedName')(text),
    ]),
  );
  const projectFiles = {...fixture.projectFiles};
  if (input.language === 'rust')
    projectFiles['Cargo.lock'] = 'version = 4\n[[package]]\nname = "semantic-fixture"\nversion = "0.1.0"\n';
  return {sources, projectFiles};
}

export function providerEnvironment(input: ProviderInputs) {
  return input.language === 'python'
    ? {environment: 'p11-static-environment'}
    : input.language === 'java'
      ? {environment: 'p11-synthetic-java-environment'}
      : {};
}

export function assertProviderFixtureBranch(input: ProviderInputs, writerFixture: boolean) {
  if (input.language === 'java' && !writerFixture)
    throw new Error(
      'Java read fixture prerequisite: context source mutations require a separately bound prepared model',
    );
}

export async function providerCatalog(input: ProviderInputs, scratch: string) {
  if (input.language === 'java') {
    const project = join(scratch, 'project');
    const artifacts = join(scratch, 'java-artifacts');
    const inside = (root: string, file: string) => {
      const name = relative(root, file);
      return !name || (!isAbsolute(name) && name !== '..' && !EffectString.startsWith('../')(name));
    };
    for (const directory of [
      project,
      input.serverDirectory,
      input.runtimeJavaHome,
      input.projectJavaHome,
      join(scratch, 'home'),
    ])
      assert.ok(
        !inside(directory, artifacts) && !inside(artifacts, directory),
        'Separate private Java model artifacts',
      );
    await mkdir(artifacts, {mode: 0o700});
    const common = {
      exported: false,
      combineAccessRules: false,
      inclusions: [],
      exclusions: [],
      attributes: [],
      accessRules: [],
    };
    const root = {
      ...common,
      kind: 3 as const,
      contentKind: 1 as const,
      path: 'src/main/java',
      exists: true,
      output: 'target/classes',
    };
    // Host-authored, no-dependency synthetic Maven-shaped facts, not an observed Maven/Gradle import.
    const model: JavaPreparedModel = {
      format: 'threadnote-prepared-java-project-v2',
      provider: 'jdtls-1.63.0-202610191322',
      build: 'maven',
      project,
      worktree: project,
      sourceDigest: await tree(project),
      javaHome: input.projectJavaHome,
      javaSdkDigest: input.projectSdkDigest,
      projectCharset: 'UTF-8',
      sourceInputEncoding: 'utf8-original-inputs-v1',
      sourceEncoding: javaSourceEncodingImage(
        await Promise.all(
          EffectArray.map(EffectRecord.keys(selectedFixture(input).sources), async name => ({
            name,
            digest: hash(await readFile(join(project, name))),
          })),
        ),
      ),
      compilerOptions: {
        'org.eclipse.jdt.core.compiler.compliance': '21',
        'org.eclipse.jdt.core.compiler.source': '21',
        'org.eclipse.jdt.core.compiler.codegen.targetPlatform': '21',
        'org.eclipse.jdt.core.compiler.release': 'enabled',
        'org.eclipse.jdt.core.compiler.processAnnotations': 'disabled',
      },
      resourceFilters: [],
      output: 'target/classes',
      rawClasspath: [
        root,
        {
          ...common,
          kind: 5,
          contentKind: 1,
          path: 'org.eclipse.m2e.MAVEN2_CLASSPATH_CONTAINER',
          combineAccessRules: true,
        },
        {
          ...common,
          kind: 5,
          contentKind: 1,
          path: 'org.eclipse.jdt.launching.JRE_CONTAINER/org.eclipse.jdt.internal.debug.ui.launcher.StandardVMType/JavaSE-21',
          combineAccessRules: true,
        },
      ],
      resolvedClasspath: [
        root,
        {
          ...common,
          kind: 1,
          contentKind: 2,
          path: join(input.projectJavaHome, 'lib/jrt-fs.jar'),
          sourceAttachmentPath: join(input.projectJavaHome, 'lib/src.zip'),
        },
      ],
      libraries: [],
    };
    const text = javaPreparedModelJson(model);
    const metadataFile = join(artifacts, 'model.json');
    await writeFile(metadataFile, text, {mode: 0o600, flag: 'wx'});
    const environment = {id: 'p11-synthetic-java-environment', metadataFile, metadataDigest: hash(text)};
    await Effect.runPromise(
      loadJavaPreparedModel({
        metadataFile,
        metadataDigest: environment.metadataDigest,
        project,
        worktree: project,
        javaHome: input.projectJavaHome,
      }).pipe(
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Standalone private-file Promise boundary validates its sealed model with narrow services.
        Effect.provide(Layer.merge(BunServices.layer, cryptoLayer)),
      ),
    );
    const runtimeCandidate = {
      serverDirectory: input.serverDirectory,
      serverTreeDigest: input.serverTreeDigest,
      runtimeJavaHome: input.runtimeJavaHome,
      runtimeSdkDigest: input.runtimeSdkDigest,
      projectJavaHome: input.projectJavaHome,
      projectSdkDigest: input.projectSdkDigest,
    };
    return {
      catalog: {java: {runtimeCandidate, environments: [environment]}},
      environment: {
        ...environment,
        metadata: model,
        provenance: 'host-authored synthetic no-dependency model; no Maven/Gradle import or real-project qualification',
      },
    };
  }
  if (input.language === 'go' || input.language === 'rust') {
    const candidate = {
      executable: input.executable,
      executableDigest: input.executableDigest,
      sdkDirectory: input.sdkDirectory,
      sdkTreeDigest: input.sdkTreeDigest,
    };
    return {catalog: input.language === 'go' ? {go: candidate} : {rust: candidate}, environment: undefined};
  }
  const base = {
    runtime: input.runtime,
    runtimeDigest: input.runtimeDigest,
    runtimeVersion: input.runtimeVersion,
    serverDirectory: input.serverDirectory,
    serverTreeDigest: input.serverTreeDigest,
  };
  if (input.language !== 'python')
    return {
      catalog: {candidate: {...base, sdkDirectory: input.sdkDirectory, sdkTreeDigest: input.sdkTreeDigest}},
      environment: undefined,
    };
  const prefix = join(scratch, 'python-environment');
  const library = join(prefix, 'static-library');
  await mkdir(library, {recursive: true, mode: 0o700});
  await writeFile(join(library, 'dependency.pyi'), 'def selected() -> str: ...\n');
  const metadata = {
    format: 'threadnote-static-python-environment-v1',
    version: [3, 12, 13],
    provenance: 'P11 synthetic static environment fixture; no interpreter execution',
    prefix,
    roots: [{directory: library, digest: await tree(library)}],
  };
  const metadataFile = join(prefix, 'environment.json');
  const text = JSON.stringify(metadata);
  await writeFile(metadataFile, text, {mode: 0o600});
  const environment = {id: 'p11-static-environment', metadataFile, metadataDigest: hash(text)};
  return {catalog: {python: {...base, environments: [environment]}}, environment: {...environment, metadata}};
}

export function redactCapabilities(value: unknown): unknown {
  if (EffectArray.isArray(value)) return EffectArray.map(value, redactCapabilities);
  if (isJsonObject(value))
    return EffectRecord.fromEntries(
      EffectArray.map(EffectRecord.toEntries(value), ([key, item]) => [
        key,
        key === 'capability' || key === 'token' ? '<redacted>' : redactCapabilities(item),
      ]),
    );
  return value;
}

export function protocolCapabilities(value: unknown): string[] {
  if (EffectArray.isArray(value)) return EffectArray.flatMap(value, protocolCapabilities);
  if (isJsonObject(value))
    return EffectArray.flatMap(EffectRecord.toEntries(value), ([key, item]) =>
      (key === 'capability' || key === 'token') && typeof item === 'string' ? [item] : protocolCapabilities(item),
    );
  return [];
}

interface CliResult {
  pid: number;
  code: number;
  stdout: string;
  stderr: string;
  value: unknown;
}
export type QualificationCli = (args: readonly string[], request: object) => Promise<CliResult>;

/** LSP characters count UTF-16 code units, including any non-BMP prefix in the authored line. */
export function fixtureSymbolPosition(
  text: string,
  symbol: 'UnsavedName' | 'BufferName' = 'UnsavedName',
  occurrence: 'first' | 'last' = 'first',
) {
  const lines = EffectString.split('\n')(text);
  for (let index = 0; index < lines.length; index++) {
    const line = occurrence === 'first' ? index : lines.length - 1 - index;
    const character =
      occurrence === 'first'
        ? EffectString.indexOf(symbol)(lines[line])
        : EffectString.lastIndexOf(symbol)(lines[line]);
    if (character._tag === 'Some') return {line, character: character.value + 2};
  }
  throw new Error('Missing authored fixture symbol');
}

/** Fixed authored fixture operations, never caller-supplied results or assertions. */
export async function runProviderNavigation(
  input: ProviderInputs,
  project: string,
  sources: Record<string, string>,
  run: QualificationCli,
  client: Client,
  within: <A>(promise: Promise<A>, milliseconds: number) => Promise<A>,
  deadline: number,
  results: unknown[],
) {
  const names = EffectRecord.keys(sources);
  const declaration = names[0],
    dependent = names[1];
  const request = {
    callerCwd: project,
    language: input.language,
    ...providerEnvironment(input),
    milliseconds: 10000,
    maxBytes: 8192,
    maxItems: 32,
  };
  for (const operation of ['definition', 'references'] as const) {
    const selected = {
      ...request,
      file: join(project, operation === 'definition' ? dependent : declaration),
      operation,
      position: fixtureSymbolPosition(
        sources[operation === 'definition' ? dependent : declaration],
        'UnsavedName',
        operation === 'definition' ? 'last' : 'first',
      ),
    };
    const cli = await run(['semantic', 'query', '--json'], selected);
    const mcp = await within(
      client.callTool({name: 'semantic_query', arguments: {request: selected, responseFormat: 'dual'}}, undefined, {
        timeout: Math.max(1, Math.min(15000, deadline - Date.now())),
      }),
      deadline - Date.now(),
    );
    const canonical = cli.value;
    results.push({
      operation,
      request: selected,
      status: 'observed',
      fullScenarioQualified: false,
      cli: {pid: cli.pid, code: cli.code, stderr: cli.stderr},
      canonical: redactCapabilities(canonical),
      mcp: {isError: mcp.isError ?? false, canonical: redactCapabilities(mcp.structuredContent)},
    });
    assert.ok(
      isJsonObject(canonical) &&
        canonical.version === 1 &&
        canonical.status === 'ok' &&
        isJsonObject(canonical.evidence),
    );
    assert.ok(isDeepStrictEqual(canonical, mcp.structuredContent), 'Complete CLI/MCP evidence parity');
    assert.ok(
      !mcp.isError &&
        EffectArray.isArray(mcp.content) &&
        mcp.content.length === 1 &&
        isJsonObject(mcp.content[0]) &&
        mcp.content[0].type === 'text' &&
        typeof mcp.content[0].text === 'string',
    );
    assert.deepEqual(JSON.parse(mcp.content[0].text), canonical, 'Compact MCP canonical parity');
    assert.ok(
      operation === 'definition'
        ? checkProbeDefinition(sources, canonical.items, pathToFileURL(project).href)
        : checkProbeReferences(sources, canonical.items, pathToFileURL(project).href),
      `Exact fixture ${operation}`,
    );
  }
  return {status: 'passed', branches: results, fullScenarioQualified: false};
}

const Handle = Schema.Struct({id: digest, capability: digest, digest});
const Page = Schema.Struct({
  digest,
  offset: Schema.Finite,
  next: Schema.NullOr(Schema.Finite),
  chunkCount: Schema.Finite,
  chunks: Schema.Array(
    Schema.Struct({kind: Schema.String, text: Schema.String, target: Schema.optionalKey(Schema.NullOr(Schema.Finite))}),
  ),
});
const Prepared = Schema.Struct({
  status: Schema.Literal('ok'),
  applicable: Schema.Literal(false),
  writerAuthorityRequired: Schema.Literal(true),
  targetCount: Schema.Finite,
  handle: Handle,
  page: Page,
});
const Target = Schema.Struct({
  observation: Schema.Struct({uri: Schema.String, content: digest}),
  precondition: Schema.Struct({rawDigest: digest, sourceKind: Schema.String, physicalIdentity: Schema.String}),
});

/** The independent expected before/after bytes cover every provider-returned target and operation. */
export async function runProviderPreview(
  input: ProviderInputs,
  project: string,
  sources: Record<string, string>,
  run: QualificationCli,
  client: Client,
  within: <A>(promise: Promise<A>, milliseconds: number) => Promise<A>,
  deadline: number,
  results: unknown[],
) {
  const declaration = EffectRecord.keys(sources)[0];
  const position = fixtureSymbolPosition(sources[declaration]);
  const common = {version: 1, callerCwd: project, milliseconds: 10000, maxBytes: 8192};
  const mcpChange = async (action: 'status' | 'preflight' | 'apply', request: object) => {
    const response = await within(
      client.callTool({name: 'semantic_change_' + action, arguments: {request: {...common, ...request}}}, undefined, {
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
      'One canonical change page',
    );
    const value: unknown = JSON.parse(response.content[0].text);
    assert.ok(isDeepStrictEqual(value, response.structuredContent), 'Complete MCP change canonical parity');
    return value;
  };
  const selected = {
    ...common,
    operation: 'rename',
    language: input.language,
    file: join(project, declaration),
    position,
    newName: 'RenamedName',
    ...providerEnvironment(input),
  };
  const cli = await run(['semantic', 'change', 'prepare', '--json'], selected);
  const record = {
    operation: 'complete-rename-preview',
    status: 'observed',
    fullScenarioQualified: false,
    prepared: redactCapabilities(cli.value),
    pages: 0,
  };
  results.push(record);
  const prepared = Schema.decodeUnknownSync(Prepared)(cli.value);
  assert.equal(prepared.targetCount, EffectRecord.keys(sources).length, 'Every fixture file in complete proposal');
  const chunks: (typeof Page.Type.chunks)[number][] = [];
  let page = prepared.page;
  for (;;) {
    assert.ok(
      page.digest === prepared.handle.digest && page.offset === chunks.length,
      'Stable proposal digest and contiguous pages',
    );
    chunks.push(...page.chunks);
    record.pages++;
    assert.ok(
      record.pages <= 128 && Buffer.byteLength(JSON.stringify(chunks)) <= 1024 * 1024,
      'Bounded complete preview',
    );
    if (page.next === null) break;
    assert.ok(page.next === chunks.length && page.next > page.offset, 'Monotonic proposal continuation');
    const next = await mcpChange('status', {handle: prepared.handle, offset: page.next});
    assert.ok(isJsonObject(next));
    page = Schema.decodeUnknownSync(Page)(next.page);
  }
  assert.equal(chunks.length, page.chunkCount, 'All proposal chunks retrieved');
  const chunkText = (selected: readonly (typeof chunks)[number][]) =>
    EffectArray.join(
      EffectArray.map(selected, chunk => chunk.text),
      '',
    );
  const manifest = Schema.decodeUnknownSync(Schema.Struct({targets: Schema.Array(Target)}))(
    JSON.parse(chunkText(EffectArray.filter(chunks, chunk => chunk.kind === 'manifest'))),
  );
  const expectedUris = EffectArray.map(
    EffectRecord.keys(sources),
    name => pathToFileURL(join(project, name)).href,
  ).sort();
  assert.ok(
    isDeepStrictEqual(EffectArray.map(manifest.targets, target => target.observation.uri).sort(), expectedUris),
    'Exact complete target identity set',
  );
  for (let index = 0; index < manifest.targets.length; index++) {
    const target = manifest.targets[index];
    const found = EffectArray.findFirst(
      EffectRecord.keys(sources),
      name => pathToFileURL(join(project, name)).href === target.observation.uri,
    );
    assert.ok(found._tag === 'Some', 'No foreign proposal target');
    const name = found.value;
    const before = chunkText(EffectArray.filter(chunks, chunk => chunk.target === index && chunk.kind === 'before'));
    const after = chunkText(EffectArray.filter(chunks, chunk => chunk.target === index && chunk.kind === 'after'));
    assert.equal(before, sources[name], 'Complete original proposal bytes');
    assert.equal(
      after,
      EffectString.replaceAll('UnsavedName', 'RenamedName')(sources[name]),
      'Complete exact rename bytes',
    );
    const identity = await lstat(join(project, name), {bigint: true});
    assert.ok(
      target.precondition.rawDigest === hash(before) &&
        target.observation.content === hash(before) &&
        target.precondition.sourceKind === 'disk' &&
        target.precondition.physicalIdentity === JSON.stringify([identity.dev.toString(), identity.ino.toString()]),
      'Exact raw-byte physical source preconditions',
    );
  }
  const statusStarted = Date.now();
  const cliStatus = await run(['semantic', 'change', 'status', '--json'], {
    ...common,
    handle: prepared.handle,
    offset: 0,
  });
  const mcpStatus = await mcpChange('status', {handle: prepared.handle, offset: 0});
  results.push({
    operation: 'proposal-status-parity',
    status: 'observed',
    fullScenarioQualified: false,
    cli: redactCapabilities(cliStatus.value),
    mcp: redactCapabilities(mcpStatus),
  });
  assert.ok(
    checkProposalStatusTransportParity(cliStatus.value, mcpStatus, statusStarted, Date.now()),
    'Same retained proposal across actual CLI/MCP with bounded ordered check timestamps',
  );
  const preflight = await mcpChange('preflight', {handle: prepared.handle});
  results.push({
    operation: 'unapplied-preflight',
    status: 'observed',
    fullScenarioQualified: false,
    result: redactCapabilities(preflight),
  });
  assert.ok(
    isJsonObject(preflight) &&
      preflight.status === 'ok' &&
      preflight.applicable === false &&
      preflight.writerAuthorityRequired === true,
    'Preflight does not grant writer authority',
  );
  const unauthorized = await mcpChange('apply', {
    handle: prepared.handle,
  });
  results.push({
    operation: 'read-capability-cannot-authorize-write',
    status: 'observed',
    fullScenarioQualified: false,
    result: redactCapabilities(unauthorized),
  });
  assert.ok(
    isJsonObject(unauthorized) && unauthorized.status === 'invalid-request' && unauthorized.applicable === false,
    'Read capability cannot authorize source writes',
  );
  record.status = 'passed';
  return prepared;
}

/** Volatile owned buffers must preserve disk and reject stale document versions without an editor integration. */
export async function runOwnedBufferFixture(
  input: ProviderInputs,
  project: string,
  sources: Record<string, string>,
  run: QualificationCli,
  client: Client,
  within: <A>(promise: Promise<A>, milliseconds: number) => Promise<A>,
  deadline: number,
  results: unknown[],
) {
  const declaration = EffectRecord.keys(sources)[0];
  const text = EffectString.replaceAll('UnsavedName', 'BufferName')(sources[declaration]);
  const common = {callerCwd: project, milliseconds: 10000};
  const opened = await run(['semantic', 'view', '--json'], {
    ...common,
    action: 'open',
    file: join(project, declaration),
    language: input.language,
    text,
    ...providerEnvironment(input),
  });
  results.push({
    operation: 'owned-buffer-open',
    fullScenarioQualified: false,
    result: redactCapabilities(opened.value),
  });
  assert.ok(isJsonObject(opened.value) && opened.value.status === 'ok', 'Explicit owned buffer opens');
  const handle = Schema.decodeUnknownSync(Schema.Struct({id: digest, capability: digest}))(opened.value.handle);
  const query = {
    callerCwd: project,
    language: input.language,
    file: join(project, declaration),
    operation: 'symbols',
    view: {kind: 'buffer', handle, documentVersion: 1},
    milliseconds: 10000,
    maxBytes: 8192,
    maxItems: 32,
    ...providerEnvironment(input),
  };
  try {
    const cli = await run(['semantic', 'query', '--json'], query);
    const response = await within(
      client.callTool({name: 'semantic_query', arguments: {request: query, responseFormat: 'dual'}}, undefined, {
        timeout: Math.max(1, Math.min(15000, deadline - Date.now())),
      }),
      deadline - Date.now(),
    );
    results.push({
      operation: 'owned-buffer-symbols',
      fullScenarioQualified: false,
      canonical: redactCapabilities(cli.value),
      mcp: redactCapabilities(response.structuredContent),
    });
    assert.ok(
      isJsonObject(cli.value) &&
        cli.value.status === 'ok' &&
        isJsonObject(cli.value.evidence) &&
        isJsonObject(cli.value.evidence.observation),
      'Owned buffer query has current evidence',
    );
    assert.ok(
      cli.value.evidence.observation.content === hash(text) && cli.value.evidence.observation.documentVersion === 1,
      'Exact unsaved byte/version evidence',
    );
    assert.ok(
      EffectArray.isArray(cli.value.items) &&
        EffectArray.some(cli.value.items, item => isJsonObject(item) && item.name === 'BufferName'),
      'Compiler sees exact unsaved symbol',
    );
    assert.ok(isDeepStrictEqual(cli.value, response.structuredContent), 'Owned buffer CLI/MCP evidence parity');
    const position = fixtureSymbolPosition(text, 'BufferName');
    const preview = await run(['semantic', 'change', 'prepare', '--json'], {
      version: 1,
      ...common,
      file: join(project, declaration),
      language: input.language,
      operation: 'rename',
      position,
      newName: 'BufferRenamed',
      view: query.view,
      ...providerEnvironment(input),
    });
    results.push({
      operation: input.language === 'java' ? 'owned-buffer-mutation-refusal' : 'owned-buffer-unapplied-preview',
      fullScenarioQualified: false,
      result: redactCapabilities(preview.value),
    });
    assert.ok(
      isJsonObject(preview.value) &&
        preview.value.applicable === false &&
        preview.value.writerAuthorityRequired === true,
      'Buffer preview cannot become an immediate disk mutation',
    );
    if (input.language === 'java') {
      assert.ok(
        isJsonObject(preview.value) &&
          ['unsupported', 'unavailable', 'stale', 'conflict'].includes(String(preview.value.status)) &&
          preview.value.handle === undefined &&
          preview.value.writer === undefined &&
          protocolCapabilities(preview.value).length === 0,
        'Java owned overlay mutation must refuse without a proposal or writer capability',
      );
    }
    for (const [name, bytes] of EffectRecord.toEntries(sources))
      assert.equal(await readFile(join(project, name), 'utf8'), bytes, 'Unsaved owner never rewrites disk');
    const updated = await run(['semantic', 'view', '--json'], {
      ...common,
      action: 'update',
      handle,
      expectedVersion: 1,
      text: text + '// owned-version-2\r\n',
    });
    results.push({
      operation: 'owned-buffer-version-update',
      fullScenarioQualified: false,
      result: redactCapabilities(updated.value),
    });
    assert.ok(
      isJsonObject(updated.value) &&
        updated.value.status === 'ok' &&
        isJsonObject(updated.value.observation) &&
        updated.value.observation.documentVersion === 2,
      'Version update acknowledged',
    );
    const stale = await run(['semantic', 'query', '--json'], query);
    results.push({
      operation: 'stale-buffer-version-refusal',
      fullScenarioQualified: false,
      result: redactCapabilities(stale.value),
    });
    assert.ok(
      isJsonObject(stale.value) && ['stale', 'conflict'].includes(String(stale.value.status)),
      'Earlier buffer version must not be silently rebound',
    );
  } finally {
    const closed = await run(['semantic', 'view', '--json'], {...common, action: 'close', handle});
    results.push({
      operation: 'owned-buffer-close',
      fullScenarioQualified: false,
      result: redactCapabilities(closed.value),
    });
    assert.ok(isJsonObject(closed.value) && closed.value.status === 'ok', 'Only our buffer handle closed');
  }
}
