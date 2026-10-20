import {Effect, FileSystem, Path} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {captureMemoryCodeCitations} from '@threadnote/context/citation/capture';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {proposeTopicMaintenanceEnrollment} from '@threadnote/memory/topic-maintenance';
import {
  inspectTopicDependencyExpansion,
  previewTopicDependencyExpansion,
} from '../../src/memory/maintenance/topic_expansion.js';

/** Real Git/graph/capsule fixture shared by application and Manager boundary tests. */
export const makeTopicExpansionFixture = Effect.fn('test.topicExpansionFixture')(function* (
  options: {readonly scoped?: boolean; readonly project?: string} = {},
) {
  const project = options.project ?? 'fixture';
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'topic-expansion-'});
  const repository = path.join(home, 'repository');
  yield* fs.makeDirectory(path.join(repository, 'src'), {recursive: true});
  yield* fs.writeFileString(
    path.join(repository, 'src/main.ts'),
    "import { dependency } from './dependency.js';\nexport const limit = dependency;\n",
  );
  yield* fs.writeFileString(path.join(repository, 'src/dependency.ts'), 'export const dependency = 32;\n');
  yield* fs.writeFileString(path.join(repository, 'settings.json'), '{"limit":32}\n');
  if (options.scoped) {
    yield* fs.writeFileString(
      path.join(repository, 'package.json'),
      JSON.stringify({name: 'fixture-workspace', private: true, workspaces: ['src']}),
    );
    yield* fs.writeFileString(
      path.join(repository, 'src/package.json'),
      JSON.stringify({name: 'fixture-code', private: true, type: 'module'}),
    );
  }
  const git = (args: readonly string[]) => runCommandEffect('git', ['-C', repository, ...args]);
  const commit = (message: string) =>
    Effect.gen(function* () {
      yield* git(['add', '.']);
      yield* git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', message]);
    });
  yield* git(['init', '--quiet']);
  yield* commit('initial');
  const config = {
    account: 'local',
    agentContextHome: home,
    agentId: 'test',
    manifestPath: path.join(home, 'manifest.yaml'),
    user: 'tester',
  };
  yield* fs.writeFileString(
    config.manifestPath,
    `version: 1\nprojects:\n  - name: ${project}\n    path: ${JSON.stringify(repository)}\n    uri: threadnote://resources/repos/fixture\n    seed: []\n${options.scoped ? '    graph:\n      roots: [src]\n      closure: dependencies\n' : ''}`,
  );
  const index = () =>
    CodeGraphIndexer.pipe(
      Effect.flatMap(indexer =>
        indexer.index({
          cwd: repository,
          threadnoteHome: home,
          ensureVectors: false,
          ...(options.scoped
            ? {
                project: {
                  uri: 'threadnote://resources/repos/fixture',
                  graph: {roots: ['src'], closure: 'dependencies' as const},
                },
              }
            : {}),
        }),
      ),
    );
  yield* index();
  const [origin] = yield* captureMemoryCodeCitations(config, {
    callerCwd: repository,
    project,
    refs: ['src/main.ts'],
  });
  const uri = 'threadnote://user/tester/memories/durable/projects/fixture/limit.md';
  const body =
    'The implementation has a limit.\n\nChanging the limit requires approval.\n\nHistorically the limit was smaller.';
  const base = parseMemoryDocument(
    uri,
    formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        status: 'active',
        schemaVersion: 10,
        project,
        topic: 'limit',
        sourceAgentClient: 'test',
        timestamp: '2026-10-18T00:00:00.000Z',
        memoryId: 'tn_expansion_runtime_fixture',
        codeCitations: [origin],
      },
      body,
    ),
  )!;
  const enrolled = proposeTopicMaintenanceEnrollment(base, {
    paragraphs: (['descriptive', 'normative', 'historical'] as const).map(role => ({
      role,
      support: 'direct',
      citationIds: [origin.id],
    })),
  });
  const memoryPath = path.join(home, 'data/local/user/tester/memories/durable/projects/fixture/limit.md');
  yield* fs.makeDirectory(path.dirname(memoryPath), {recursive: true});
  yield* fs.writeFileString(memoryPath, enrolled.content);
  const record = parseMemoryDocument(uri, enrolled.content)!;
  const inspected = yield* inspectTopicDependencyExpansion(config, {uri, callerCwd: repository, project});
  if (!inspected.seeds.length) throw new Error('Fixture requires a declared file seed.');
  const input = {
    version: 1,
    depth: 1,
    project,
    root: inspected.root,
    configDigest: inspected.configDigest,
    seeds: [inspected.seeds[0].id],
    direction: 'outgoing',
    kinds: ['imports', 'references', 'depends_on', 'calls', 'reads_or_writes'],
    provenances: ['declared', 'resolved'],
    minConfidence: 0,
    nodeLimit: 32,
    edgeLimit: 64,
    selectedNodeIds: [],
    configurationPaths: [],
  };
  const choices = yield* inspectTopicDependencyExpansion(config, {
    uri,
    callerCwd: repository,
    project,
    input,
  });
  const endpoint = choices.choices?.eligible.find(node => node.path === 'src/dependency.ts');
  if (!endpoint) throw new Error('Fixture requires a resolved one-hop dependency.');
  const selectedInput = {...input, selectedNodeIds: [endpoint.id]};
  const preview = yield* previewTopicDependencyExpansion(config, {uri, callerCwd: repository, input: selectedInput});
  return {
    home,
    repository,
    config,
    uri,
    body,
    origin,
    memoryPath,
    record,
    inspected,
    input,
    choices,
    selectedInput,
    preview: preview.preview,
    git,
    commit,
    index,
  };
});
