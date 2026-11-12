import {
  redactCapabilities,
  protocolCapabilities,
  ProviderInputs,
  providerCatalog,
  providerEnvironment,
  assertProviderFixtureBranch,
  selectedFixture,
  fixtureSymbolPosition,
  readProviderInputs,
  authoredActionFixture,
  runProviderActionPreview,
  uniqueFixtureAction,
  type QualificationCli,
} from './provider-fixture.js';
import {expectedFixtureSources} from './writer-fixture.js';
import {SemanticAgentQuery} from '../../../src/semantic/agent_query_protocol.js';
import {SemanticAgentChangeRequest} from '../../../src/semantic/agent_change_protocol.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {observeCandidateTransport} from './transport-lifecycle.js';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {Array as EffectArray, Record as EffectRecord, Schema, String as EffectString} from 'effect';
/* oxlint-disable effecttsgo/node-builtin-import -- Qualification exercises private evidence files and refuses a mismatched executable before spawning it. */
import {readFileSync} from 'node:fs';
import {mkdtemp, mkdir, readFile, realpath, rm, writeFile, stat, lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {Ledger, qualificationInventory} from './inventory.js';
import {candidateTargetMatchesHost, runCandidateChecks} from './candidate.js';
import {checkMissingProfileTransportParity, checkProposalStatusTransportParity} from './transport-oracle.js';

const ledger = Schema.decodeUnknownSync(Ledger)(
  JSON.parse(
    readFileSync(new URL('../../../../../config/semantic-providers/qualification-lock.json', import.meta.url), 'utf8'),
  ),
);
const wrap = (value: unknown) => ({structuredContent: value, content: [{type: 'text', text: JSON.stringify(value)}]});
describe('final combined qualification preparation', () => {
  it('authors finite actions and refuses ambiguous or unsafe public listings', () => {
    const expected = {
      python: ['action_case.py', 'def selected() -> int:\n    return 1\n\n_ = selected()\n'],
      go: ['action_case.go', 'package demo\n\nfunc actionCase() {\n\tx := 1\n\t_ = x\n}\n'],
      rust: ['src/action_case.rs', 'pub fn invoke() { missing_one(); }\n\nfn missing_one() {\n    todo!()\n}\n'],
      java: ['src/main/java/demo/ActionCase.java', 'package demo;\nclass ActionCase {}\n'],
    } as const;
    for (const language of ['python', 'go', 'rust', 'java'] as const) {
      const action = authoredActionFixture(language);
      expect([action.file, action.after]).toEqual(expected[language]);
      expect(action.before).not.toBe(action.after);
    }
    const go = authoredActionFixture('go');
    expect(go).toMatchObject({id: 'declare-local-with-colon', line: 3});
    expect(go.before).toBe('package demo\n\nfunc actionCase() {\n\tx = 1\n\t_ = x\n}\n');
    expect(go.after).toBe(EffectString.replace('x = 1', 'x := 1')(go.before));
    const choice = {
      choiceHandle: EffectString.repeat(64)('a'),
      title: 'An engine title',
      kind: 'quickfix',
      qualified: true,
      command: false,
      disabled: null,
      blocker: null,
    };
    const listing = {
      status: 'choices',
      applicable: false,
      writerAuthorityRequired: true,
      observation: {uri: 'file:///fixture/a.py', content: EffectString.repeat(64)('b')},
      choices: [choice],
    };
    expect(uniqueFixtureAction(listing).choices[0].choiceHandle).toBe(choice.choiceHandle);
    for (const choices of [
      [],
      [choice, {...choice, choiceHandle: EffectString.repeat(64)('c')}],
      [{...choice, command: true}],
      [{...choice, disabled: 'disabled'}],
      [{...choice, qualified: false}],
      [{...choice, blocker: 'resource-operation'}],
      [{...choice, kind: 'source.organizeImports'}],
    ])
      expect(() => uniqueFixtureAction({...listing, choices})).toThrow();
    expect(protocolCapabilities(listing)).toEqual([choice.choiceHandle]);
    expect(JSON.stringify(redactCapabilities(listing))).not.toContain(choice.choiceHandle);
    expect(expectedFixtureSources({'a.py': 'UnsavedName'})).toEqual({'a.py': 'RenamedName'});
    expect(expectedFixtureSources({'a.py': 'before'}, {'a.py': 'after'})).toEqual({'a.py': 'after'});
    expect(() => expectedFixtureSources({'a.py': 'before'}, {})).toThrow('cover every authored source');
    expect(() => expectedFixtureSources({'a.py': 'before'}, {'foreign.py': 'after'})).toThrow();
  });

  it('keeps client choices separate and rejects engine bytes different from the authored V2 action', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'tn11-action-preview-')));
    const action = authoredActionFixture('python');
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    const sources = {[action.file]: action.before};
    const input = Schema.decodeSync(ProviderInputs)({
      version: 1,
      language: 'python',
      runtime: '/inert',
      runtimeDigest: EffectString.repeat(64)('a'),
      runtimeVersion: '24.19.0',
      serverDirectory: '/inert',
      serverTreeDigest: EffectString.repeat(64)('b'),
      notices: [{component: 'inert', file: '/inert', sha256: EffectString.repeat(64)('c')}],
    });
    try {
      await writeFile(join(directory, action.file), action.before);
      const info = await lstat(join(directory, action.file), {bigint: true});
      const uri = pathToFileURL(join(directory, action.file)).href;
      const observation = {uri, content: hash(action.before)};
      const range = {start: {line: 3, character: 0}, end: {line: 3, character: 10}};
      let selections = 0,
        wrongAfter = false;
      const respond = (channel: 'cli' | 'mcp', stage: string, request: Record<string, unknown>): unknown => {
        if (stage === 'query') Schema.decodeUnknownSync(SemanticAgentQuery, {onExcessProperty: 'error'})(request);
        else if (stage !== 'apply')
          Schema.decodeUnknownSync(SemanticAgentChangeRequest, {onExcessProperty: 'error'})({
            ...request,
            action: stage,
          });
        const ownChoice = EffectString.repeat(64)(channel === 'cli' ? '1' : '2');
        const ownProposal = EffectString.repeat(64)(channel === 'cli' ? '3' : '4');
        if (stage === 'query')
          return {
            status: 'ok',
            next: null,
            evidence: {observation},
            items: [{id: EffectString.repeat(64)('d'), range}],
          };
        if (stage === 'prepare' && !request.choiceHandle)
          return {
            status: 'choices',
            applicable: false,
            writerAuthorityRequired: true,
            observation,
            choices: [
              {
                choiceHandle: ownChoice,
                title: 'Discard call result',
                kind: 'quickfix',
                command: false,
                disabled: null,
                qualified: true,
                blocker: null,
              },
            ],
          };
        if (stage === 'prepare') {
          selections++;
          expect(request.choiceHandle).toBe(ownChoice);
          expect(request.diagnosticIds).toEqual([EffectString.repeat(64)('d')]);
          expect(request.only).toEqual(['quickfix']);
          const edits = [{range, newText: '_ = selected()'}];
          const manifest = {
            version: 2,
            operation: 'code-action',
            qualification: 'qualified-text-only',
            operations: [{kind: 'text', uri, target: 0, edits}],
            targets: [
              {
                observation,
                edits,
                precondition: {
                  rawDigest: hash(action.before),
                  sourceKind: 'disk',
                  physicalIdentity: JSON.stringify([String(info.dev), String(info.ino)]),
                },
              },
            ],
          };
          return {
            status: 'ok',
            applicable: false,
            writerAuthorityRequired: true,
            targetCount: 1,
            handle: {id: ownProposal, capability: ownProposal, digest: EffectString.repeat(64)('e')},
            page: {
              digest: EffectString.repeat(64)('e'),
              offset: 0,
              next: null,
              chunkCount: 3,
              chunks: [
                {kind: 'manifest', text: JSON.stringify(manifest)},
                {kind: 'before', target: 0, text: action.before},
                {
                  kind: 'after',
                  target: 0,
                  text: wrongAfter
                    ? 'unrelated engine bytes'
                    : 'def selected() -> int:\n    return 1\n\n_ = selected()\n',
                },
              ],
            },
          };
        }
        expect(request.handle).toMatchObject({id: ownProposal});
        return {status: stage === 'apply' ? 'invalid-request' : 'ok', applicable: false, writerAuthorityRequired: true};
      };
      const run: QualificationCli = async (args, request) => ({
        pid: 1,
        code: 0,
        stdout: '',
        stderr: '',
        value: respond('cli', args[1] === 'query' ? 'query' : args[2], {...request}),
      });
      const client = new Client({name: 'inert-action-boundary', version: '1'});
      client.callTool = async request => {
        const stage =
          request.name === 'semantic_query' ? 'query' : EffectString.slice('semantic_change_'.length)(request.name);
        const value = respond(
          'mcp',
          stage,
          Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(request.arguments?.request),
        );
        return {
          structuredContent: Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(value),
          content: [{type: 'text' as const, text: JSON.stringify(value)}],
        };
      };
      const results: unknown[] = [];
      const prepared = await runProviderActionPreview(
        input,
        directory,
        sources,
        action,
        run,
        client,
        promise => promise,
        Date.now() + 10000,
        results,
      );
      expect(prepared.handle.id).toBe(EffectString.repeat(64)('3'));
      expect(selections).toBe(2);
      expect(results).toMatchObject([{status: 'passed', fullScenarioQualified: false}]);
      expect(JSON.stringify(results)).not.toContain(EffectString.repeat(64)('1'));
      expect(await readFile(join(directory, action.file), 'utf8')).toBe(action.before);
      wrongAfter = true;
      await expect(
        runProviderActionPreview(
          input,
          directory,
          sources,
          action,
          run,
          client,
          promise => promise,
          Date.now() + 10000,
          [],
        ),
      ).rejects.toThrow('Complete exact authored bytes');
      expect(await readFile(join(directory, action.file), 'utf8')).toBe(action.before);
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });
  it('verifies independent Go provider, tool, complete SDK and notice bytes without launching them', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'tn11-go-inputs-')));
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    try {
      const sdkDirectory = join(directory, 'sdk');
      await mkdir(join(sdkDirectory, 'bin'), {recursive: true});
      const executable = join(directory, 'gopls');
      const providerNotice = join(directory, 'gopls-LICENSE');
      const sdkNotice = join(sdkDirectory, 'LICENSE');
      const version = 'go1.27.3\ntime fixed\n';
      await writeFile(executable, 'inert provider bytes');
      await writeFile(join(sdkDirectory, 'bin/go'), 'inert Go tool bytes');
      await writeFile(join(sdkDirectory, 'VERSION'), version);
      await writeFile(providerNotice, 'provider notice fixture');
      await writeFile(sdkNotice, 'SDK notice fixture');
      // Independent known four-entry image; no production traversal used to generate the expected digest.
      const sdkTreeDigest = hash(
        JSON.stringify([
          ['bin', 'directory'],
          ['bin/go', hash('inert Go tool bytes')],
          ['LICENSE', hash('SDK notice fixture')],
          ['VERSION', hash(version)],
        ]),
      );
      const input = {
        version: 1,
        language: 'go',
        providerVersion: 'v0.24.0',
        executable,
        executableDigest: hash('inert provider bytes'),
        goVersion: '1.27.3',
        goExecutableDigest: hash('inert Go tool bytes'),
        sdkDirectory,
        sdkTreeDigest,
        notices: [
          {component: 'gopls', file: providerNotice, sha256: hash('provider notice fixture')},
          {component: 'go-sdk', file: sdkNotice, sha256: hash('SDK notice fixture')},
        ],
      };
      const file = join(directory, 'inputs.json');
      await writeFile(file, JSON.stringify(input));
      const verified = await readProviderInputs(file);
      expect(verified.input).toEqual(input);
      expect(await providerCatalog(verified.input, directory)).toEqual({
        catalog: {go: {executable, executableDigest: input.executableDigest, sdkDirectory, sdkTreeDigest}},
        environment: undefined,
      });
      expect(verified.licenseDisposition).toContain('review remain required');
      expect(verified.sdkProofDisposition).toContain('remain unqualified');
      const fixture = selectedFixture(verified.input);
      expect(fixtureSymbolPosition(fixture.sources['a.go'])).toEqual({line: 1, character: 16});
      expect(fixtureSymbolPosition(fixture.sources['b.go'], 'UnsavedName', 'last')).toEqual({line: 1, character: 15});
      expect(fixture.projectFiles['go.mod']).toContain('go 1.27.0');
      expect(() =>
        Schema.decodeUnknownSync(ProviderInputs, {onExcessProperty: 'error'})({...input, runtime: '/node'}),
      ).toThrow();
      await writeFile(sdkNotice, 'changed SDK notice');
      await expect(readProviderInputs(file)).rejects.toThrow('Complete Go SDK tree');
      await writeFile(sdkNotice, 'SDK notice fixture');
      await writeFile(providerNotice, 'changed provider notice');
      await expect(readProviderInputs(file)).rejects.toThrow('Exact local notice bytes');
      await writeFile(providerNotice, 'provider notice fixture');
      await writeFile(join(sdkDirectory, 'bin/go'), 'changed Go tool');
      await expect(readProviderInputs(file)).rejects.toThrow('Pinned Go tool bytes');
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });

  it('verifies inert Rust inputs and authors the locked offline project without launching tools', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'tn11-rust-inputs-')));
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    try {
      const sdkDirectory = join(directory, 'sdk');
      await mkdir(join(sdkDirectory, 'bin'), {recursive: true});
      const executable = join(directory, 'rust-analyzer');
      await writeFile(executable, 'inert Rust provider');
      const sdkFiles = {
        'bin/cargo': 'inert cargo',
        'bin/rustc': 'inert rustc',
        'bin/rustdoc': 'inert rustdoc',
        'CARGO-LICENSE': 'Cargo notice fixture',
        COPYRIGHT: 'Rust SDK notice fixture',
      };
      for (const [name, text] of EffectRecord.toEntries(sdkFiles)) await writeFile(join(sdkDirectory, name), text);
      const mit = join(directory, 'ra-MIT'),
        apache = join(directory, 'ra-APACHE');
      await writeFile(mit, 'RA MIT source fixture');
      await writeFile(apache, 'RA Apache source fixture');
      // Independent known directory image, rather than computing the expectation with the production walker.
      const sdkTreeDigest = hash(
        JSON.stringify([
          ['bin', 'directory'],
          ['bin/cargo', hash(sdkFiles['bin/cargo'])],
          ['bin/rustc', hash(sdkFiles['bin/rustc'])],
          ['bin/rustdoc', hash(sdkFiles['bin/rustdoc'])],
          ['CARGO-LICENSE', hash(sdkFiles['CARGO-LICENSE'])],
          ['COPYRIGHT', hash(sdkFiles.COPYRIGHT)],
        ]),
      );
      const input = {
        version: 1,
        language: 'rust',
        providerVersion: '0.3.3097-standalone (0c4d74686b 2026-10-22)',
        executable,
        executableDigest: hash('inert Rust provider'),
        rustVersion: '1.99.1',
        rustcExecutableDigest: hash(sdkFiles['bin/rustc']),
        cargoExecutableDigest: hash(sdkFiles['bin/cargo']),
        rustdocExecutableDigest: hash(sdkFiles['bin/rustdoc']),
        sdkDirectory,
        sdkTreeDigest,
        notices: [
          {component: 'rust-analyzer-source-mit', file: mit, sha256: hash('RA MIT source fixture')},
          {component: 'rust-analyzer-source-apache', file: apache, sha256: hash('RA Apache source fixture')},
          {component: 'rust-sdk-copyright', file: join(sdkDirectory, 'COPYRIGHT'), sha256: hash(sdkFiles.COPYRIGHT)},
          {
            component: 'cargo-third-party',
            file: join(sdkDirectory, 'CARGO-LICENSE'),
            sha256: hash(sdkFiles['CARGO-LICENSE']),
          },
        ],
      };
      const file = join(directory, 'inputs.json');
      await writeFile(file, JSON.stringify(input));
      const verified = await readProviderInputs(file);
      expect(verified.input).toEqual(input);
      expect(await providerCatalog(verified.input, directory)).toEqual({
        catalog: {rust: {executable, executableDigest: input.executableDigest, sdkDirectory, sdkTreeDigest}},
        environment: undefined,
      });
      const fixture = selectedFixture(verified.input);
      expect(fixture.projectFiles['Cargo.lock']).toBe(
        'version = 4\n[[package]]\nname = "semantic-fixture"\nversion = "0.1.0"\n',
      );
      expect(fixture.sources['src/lib.rs']).toContain('UnsavedName');
      await writeFile(join(sdkDirectory, 'bin/rustdoc'), 'changed rustdoc');
      await expect(readProviderInputs(file)).rejects.toThrow('Pinned Rust rustdoc bytes');
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });

  it('seals an inert Java model from existing fixture bytes and verifies both SDKs without executing Java', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'tn11-java-inputs-')));
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    try {
      const homes = [join(directory, 'runtime-sdk'), join(directory, 'project-sdk')];
      const sdkDigests: string[] = [];
      for (const [index, home] of homes.entries()) {
        await mkdir(join(home, 'bin'), {recursive: true});
        await mkdir(join(home, 'lib'));
        const release = 'JAVA_RUNTIME_VERSION="' + (index === 0 ? '25.0.5+8' : '21.0.13+9') + '-LTS"\n';
        await writeFile(join(home, 'bin/java'), 'inert Java executable');
        await writeFile(join(home, 'lib/jrt-fs.jar'), 'inert JRT image');
        await writeFile(join(home, 'lib/src.zip'), 'inert source image');
        await writeFile(join(home, 'release'), release);
        await writeFile(join(home, 'NOTICE'), 'SDK notice fixture');
        // Complete known seven-entry image, independent of the production SDK walker.
        sdkDigests.push(
          hash(
            JSON.stringify([
              ['bin', 'directory'],
              ['bin/java', hash('inert Java executable')],
              ['lib', 'directory'],
              ['lib/jrt-fs.jar', hash('inert JRT image')],
              ['lib/src.zip', hash('inert source image')],
              ['NOTICE', hash('SDK notice fixture')],
              ['release', hash(release)],
            ]),
          ),
        );
      }
      const serverDirectory = join(directory, 'jdtls');
      await mkdir(join(serverDirectory, 'config_mac_arm'), {recursive: true});
      await writeFile(join(serverDirectory, 'config_mac_arm/config.ini'), 'inert JDT config');
      const sourceNotice = join(directory, 'jdt-LICENSE');
      await writeFile(sourceNotice, 'JDT source notice fixture');
      const input = Schema.decodeSync(ProviderInputs)({
        version: 1,
        language: 'java',
        providerVersion: '1.63.0-202610191322',
        serverDirectory,
        serverTreeDigest: hash(
          JSON.stringify([
            ['config_mac_arm', 'directory'],
            ['config_mac_arm/config.ini', hash('inert JDT config')],
          ]),
        ),
        configurationDigest: hash('inert JDT config'),
        runtimeVersion: '25.0.5+8',
        runtimeJavaHome: homes[0],
        runtimeSdkDigest: sdkDigests[0],
        runtimeExecutableDigest: hash('inert Java executable'),
        projectVersion: '21.0.13+9',
        projectJavaHome: homes[1],
        projectSdkDigest: sdkDigests[1],
        projectExecutableDigest: hash('inert Java executable'),
        notices: [
          {component: 'jdtls-source', file: sourceNotice, sha256: hash('JDT source notice fixture')},
          {component: 'java-runtime-sdk', file: join(homes[0], 'NOTICE'), sha256: hash('SDK notice fixture')},
          {component: 'java-project-sdk', file: join(homes[1], 'NOTICE'), sha256: hash('SDK notice fixture')},
        ],
      });
      expect(input.language).toBe('java');
      const file = join(directory, 'inputs.json');
      await writeFile(file, JSON.stringify(input));
      const verified = await readProviderInputs(file);
      expect(verified.input).toEqual(input);
      expect(verified.sdkProofDisposition).toContain('remain unqualified');
      expect(() => assertProviderFixtureBranch(input, false)).toThrow('Java read fixture prerequisite');
      expect(() => assertProviderFixtureBranch(input, true)).not.toThrow();
      expect(providerEnvironment(input)).toEqual({environment: 'p11-synthetic-java-environment'});
      const fixture = selectedFixture(input, true);
      expect(fixtureSymbolPosition(fixture.sources['src/main/java/demo/Subject.java'])).toEqual({
        line: 1,
        character: 17,
      });
      const project = join(directory, 'project');
      for (const [name, text] of EffectRecord.toEntries({...fixture.sources, ...fixture.projectFiles})) {
        await mkdir(dirname(join(project, name)), {recursive: true});
        await writeFile(join(project, name), text);
      }
      const selected = await providerCatalog(input, directory, fixture.sources);
      const environment = selected.environment;
      expect(environment?.id).toBe('p11-synthetic-java-environment');
      const metadataFile = join(directory, 'java-artifacts/model.json');
      const text = await readFile(metadataFile, 'utf8');
      expect(environment?.metadataDigest).toBe(hash(text));
      expect((await stat(metadataFile)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(metadataFile))).mode & 0o777).toBe(0o700);
      const model = JSON.parse(text);
      expect(model.project).toBe(project);
      expect(model.javaSdkDigest).toBe(sdkDigests[1]);
      expect(model.libraries).toEqual([]);
      expect(model.sourceEncoding.sourceCount).toBe(3);
      expect(await readFile(join(project, 'src/main/java/demo/ActionCase.java'), 'utf8')).toBe(
        'package demo;\nimport java.util.List;\nclass ActionCase {}\n',
      );
      const names = EffectRecord.keys(fixture.sources).sort();
      expect(model.sourceEncoding.sourceDigest).toBe(
        hash(
          'threadnote-java-source-encoding-v1\n' +
            EffectArray.join(
              EffectArray.map(names, name => name.length + ':' + name + hash(fixture.sources[name])),
              '',
            ),
        ),
      );
      expect(model.resolvedClasspath[1].path).toBe(join(homes[1], 'lib/jrt-fs.jar'));
      for (const [name, source] of EffectRecord.toEntries(fixture.sources))
        expect(await readFile(join(project, name), 'utf8')).toBe(source);
      await writeFile(join(homes[1], 'lib/jrt-fs.jar'), 'changed JRT image');
      await expect(readProviderInputs(file)).rejects.toThrow('Complete Java SDK tree');
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });

  it('locates authored symbols across CRLF lines using UTF-16 coordinates', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('x', ' ', '🧵', 'é'), {maxLength: 30}),
        fc.integer({min: 0, max: 12}),
        (prefixParts, line) => {
          const prefix = EffectArray.join(prefixParts, '');
          const text = EffectString.repeat(line)('comment\r\n') + prefix + 'UnsavedName suffix\r\n';
          const position = fixtureSymbolPosition(text);
          // JS string.length is the independent UTF-16 model, rather than code-point count.
          expect(position).toEqual({line, character: prefix.length + 2});
          expect(
            EffectString.slice(
              position.character - 2,
              position.character + 9,
            )(EffectString.split('\n')(text)[position.line]),
          ).toBe('UnsavedName');
        },
      ),
      {numRuns: 50},
    );
    expect(fixtureSymbolPosition('import UnsavedName\r\nuse UnsavedName()\r\n', 'UnsavedName', 'last')).toEqual({
      line: 1,
      character: 6,
    });
    expect(() => fixtureSymbolPosition('no authored symbol')).toThrow('Missing authored fixture symbol');
  });

  it('accepts only the exact canonical host release target, including Windows and libc/baseline boundaries', () => {
    const targets = [
      ['darwin-arm64', 'bun-darwin-arm64'],
      ['darwin-x64', 'bun-darwin-x64'],
      ['linux-arm64', 'bun-linux-arm64'],
      ['linux-arm64-musl', 'bun-linux-arm64-musl'],
      ['linux-x64-baseline', 'bun-linux-x64-baseline'],
      ['linux-x64-baseline-musl', 'bun-linux-x64-baseline-musl'],
      ['windows-arm64', 'bun-windows-arm64'],
      ['windows-x64-baseline', 'bun-windows-x64-baseline'],
    ] as const;
    for (const [host, accepted] of targets) {
      expect(candidateTargetMatchesHost(accepted, host)).toBe(true);
      for (const [, selected] of targets)
        if (selected !== accepted) expect(candidateTargetMatchesHost(selected, host)).toBe(false);
    }
    for (const host of [undefined, 'linux-x64', 'win32-arm64', 'windows-x64', 'linux-arm64-unknown'])
      for (const [, selected] of targets) expect(candidateTargetMatchesHost(selected, host)).toBe(false);
    expect(candidateTargetMatchesHost('bun-windows-x64', 'windows-x64-baseline')).toBe(false);
    expect(candidateTargetMatchesHost('bun-linux-x64-baseline-extra', 'linux-x64-baseline')).toBe(false);
  });

  it('preserves missing selected cells independently of historical qualification labels', () => {
    const inventory = qualificationInventory({
      ...ledger,
      providers: EffectArray.map(ledger.providers, provider => ({...provider, productionQualified: true})),
    });
    expect(inventory.counts).toEqual({familyPlatformCells: 40, activeClientCells: 80, qualifiedCells: 0});
    expect(inventory.productionQualified).toBe(false);
    expect(inventory.scenarios).toHaveLength(43);
    expect(new Set(EffectArray.map(inventory.scenarios, scenario => scenario.id)).size).toBe(43);
    expect(EffectArray.some(inventory.scenarios, scenario => scenario.id === 'S39')).toBe(false);
    expect(EffectArray.every(inventory.cells, cell => cell.status === 'unqualified' && !cell.productionQualified)).toBe(
      true,
    );
    expect(
      EffectArray.every(inventory.cells, cell =>
        EffectArray.every(cell.clients, client => client.outcome === 'missing'),
      ),
    ).toBe(true);
    expect(
      EffectArray.map(
        EffectArray.filter(inventory.scenarios, scenario => scenario.outcome === 'deferred'),
        scenario => scenario.id,
      ),
    ).toEqual(['S29', 'S30', 'S31', 'S32']);
    expect(EffectArray.findFirst(inventory.scenarios, scenario => scenario.id === 'S43')).toMatchObject({
      value: {outcome: 'missing'},
    });
  });
  it('rejects omitted or duplicate release matrix entries', () => {
    expect(() => qualificationInventory({...ledger, requiredPlatforms: ledger.requiredPlatforms.slice(1)})).toThrow();
    expect(() => qualificationInventory({...ledger, releaseLanguages: [...ledger.releaseLanguages, 'java']})).toThrow();
    expect(() =>
      qualificationInventory({
        ...ledger,
        selectedProviders: {...ledger.selectedProviders, python: ledger.selectedProviders.typescript},
      }),
    ).toThrow();
  });
  it('is deterministic under ledger order permutations and does not mutate source evidence', () => {
    const expected = qualificationInventory(ledger);
    fc.assert(
      fc.property(
        fc.shuffledSubarray([...ledger.requiredPlatforms], {minLength: 8, maxLength: 8}),
        fc.shuffledSubarray([...ledger.providers], {
          minLength: ledger.providers.length,
          maxLength: ledger.providers.length,
        }),
        (platforms, providers) => {
          const source = {...ledger, requiredPlatforms: platforms, providers};
          const before = JSON.stringify(source);
          expect(qualificationInventory(source)).toEqual(expected);
          expect(JSON.stringify(source)).toBe(before);
        },
      ),
      {numRuns: 50},
    );
  });
  it('retains the owned child and awaits the original SDK auto-close after invalid initialize', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('./invalid-initialize.cjs', import.meta.url))],
      stderr: 'pipe',
    });
    const owned: number[] = [];
    const lifecycle = observeCandidateTransport(transport, pid => owned.push(pid));
    const client = new Client({name: 'qualification-cleanup-regression', version: '1'});
    try {
      await expect(client.connect(transport)).rejects.toThrow();
      expect(transport.pid).toBeNull();
      expect(owned).toHaveLength(1);
      expect(lifecycle.pid).toBe(owned[0]);
      expect(() => process.kill(owned[0], 0)).not.toThrow();
      let closed = false;
      const closing = lifecycle.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      expect(lifecycle.closeObserved).toBe(false);
      await closing;
      await lifecycle.waitForCloseIfStarted(AbortSignal.timeout(1000));
      expect(lifecycle.closeObserved).toBe(true);
      expect(() => process.kill(owned[0], 0)).toThrow();
    } finally {
      await lifecycle.close();
      await lifecycle.waitForCloseIfStarted(AbortSignal.timeout(1000));
    }
  }, 10000);
  it('retains a failed receipt and refuses executable hash mismatch before launching any candidate', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tn11-receipt-test-'));
    try {
      const output = join(directory, 'receipt.json');
      const manifest = join(directory, 'candidate.json');
      await writeFile(join(directory, 'threadnote'), 'must never execute');
      await writeFile(join(directory, 'release.json'), '{}');
      await writeFile(
        manifest,
        JSON.stringify({
          binary: join(directory, 'threadnote'),
          binarySha256: EffectString.repeat(64)('0'),
          releaseSha256: EffectString.repeat(64)('0'),
          sourceCommit: EffectString.repeat(40)('0'),
          sourceTree: EffectString.repeat(40)('0'),
        }),
      );
      const report = await runCandidateChecks(manifest, output);
      expect(report).toMatchObject({
        status: 'failed',
        failure: 'Candidate hash mismatch',
        fullScenarioQualified: false,
        provider: {started: false},
        cleanup: {ownedProcesses: [], ownedProcessesGone: true},
      });
      expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(report);
      const previous = await readFile(output, 'utf8');
      await expect(runCandidateChecks(manifest, output)).rejects.toThrow();
      expect(await readFile(output, 'utf8')).toBe(previous);
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });
  it('rejects transport error wrappers and canonical status/evidence changes', () => {
    const value = {version: 1, status: 'unavailable', reason: 'missing-profile', evidence: null};
    expect(checkMissingProfileTransportParity(value, wrap(value))).toBe(true);
    expect(checkMissingProfileTransportParity(value, {...wrap(value), content: [{type: 'text', text: '{}'}]})).toBe(
      false,
    );
    expect(checkMissingProfileTransportParity(value, {...wrap(value), isError: true})).toBe(false);
    expect(checkMissingProfileTransportParity(value, wrap({...value, status: 'ok'}))).toBe(false);
    expect(checkMissingProfileTransportParity(value, wrap({...value, evidence: {}}))).toBe(false);
  });
  it('redacts protocol credentials at every nested object boundary without mutating source evidence', () => {
    const value = {
      writer: {operation: 'receipt-id', capability: 'writer-secret'},
      content: [{token: 'bootstrap-secret'}],
    };
    const before = JSON.stringify(value);
    expect(protocolCapabilities(value)).toEqual(['writer-secret', 'bootstrap-secret']);
    expect(redactCapabilities(value)).toEqual({
      writer: {operation: 'receipt-id', capability: '<redacted>'},
      content: [{token: '<redacted>'}],
    });
    expect(JSON.stringify(value)).toBe(before);
  });
  it('bounds sampled status timestamps while retaining every proposal field in parity', () => {
    const value = {version: 1, status: 'ok', checkedAt: 11, page: {digest: 'fixed', chunks: []}};
    expect(checkProposalStatusTransportParity(value, {...value, checkedAt: 12}, 10, 13)).toBe(true);
    expect(checkProposalStatusTransportParity(value, {...value, checkedAt: 9}, 10, 13)).toBe(false);
    expect(checkProposalStatusTransportParity(value, {...value, checkedAt: 14}, 10, 13)).toBe(false);
    expect(
      checkProposalStatusTransportParity(
        value,
        {...value, checkedAt: 12, page: {digest: 'changed', chunks: []}},
        10,
        13,
      ),
    ).toBe(false);
  });
  it('compares complete nested canonical fields without depending on object key order or mutating inputs', () => {
    fc.assert(
      fc.property(fc.jsonValue(), extra => {
        const canonical = {
          version: 1,
          status: 'unavailable',
          reason: 'missing-profile',
          evidence: null,
          // CLI and MCP compare decoded JSON; JSON canonicalizes JavaScript -0 to 0.
          detail: [JSON.parse(JSON.stringify(extra))],
        };
        const reordered = EffectRecord.fromEntries(EffectRecord.toEntries(canonical).reverse());
        const before = JSON.stringify(canonical);
        expect(checkMissingProfileTransportParity(canonical, wrap(reordered))).toBe(true);
        expect(checkMissingProfileTransportParity(canonical, wrap({...reordered, detail: {changed: extra}}))).toBe(
          false,
        );
        expect(JSON.stringify(canonical)).toBe(before);
      }),
      {numRuns: 50},
    );
  });
});
