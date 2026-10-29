import {Array as EffectArray} from 'effect';
import {createHash} from '@threadnote/testing/node-crypto';
import {link, mkdir, mkdtemp, realpath, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import fc from 'fast-check';
import {afterEach, describe, expect, it} from 'vitest';
import {
  loadCodeMemoryLinkCodexSuiteTask,
  parseCodeMemoryLinkCodexSuiteLayoutV1,
} from '../../../../scripts/code-memory-link-codex-suite.js';
import {
  CODE_MEMORY_LINK_CANONICAL_EMPTY_CONTEXT_BRIEF_V1,
  canonicalizeCodeMemoryLinkContextBriefResultV1,
  codeMemoryLinkFixtureHashV1,
  codeMemoryLinkGoldCitationDigest,
  codeMemoryLinkJudgeHashV1,
  codeMemoryLinkRubricHashV1,
  codeMemoryLinkSealedSuiteHashV1,
  codeMemoryLinkTaskPacketHashV1,
  type CodeMemoryLinkRubricV1,
  type CodeMemoryLinkTaskPacketV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-protocol';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('Code Memory Link Codex sealed-suite loader', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(EffectArray.map(roots.splice(0), root => rm(root, {force: true, recursive: true})));
  });

  it('loads one selected task only after verifying the complete content-addressed roster', async () => {
    const corpus = await writeCorpus(await temporaryRoot(roots));
    const loaded = await loadCodeMemoryLinkCodexSuiteTask({
      expectedLayoutArtifactId: corpus.layoutArtifactId,
      expectedSuiteHash: corpus.suiteHash,
      root: corpus.root,
      taskId: corpus.taskId,
    });

    expect(loaded.taskPacket.taskId).toBe(corpus.taskId);
    expect(loaded.fixture.repository).toHaveLength(1);
    expect(new TextDecoder().decode(loaded.fixture.repository[0].bytes)).toContain(corpus.taskId);
    expect(loaded.layout.tasks).toHaveLength(28);
    expect(loaded.judge.programArtifact.sha256).toBe(corpus.programSha256);
  });

  it('rejects a hardlinked sealed source even when its bytes and hash match', async () => {
    const corpus = await writeCorpus(await temporaryRoot(roots));
    const source = join(corpus.root, 'fixture/0000000000000001.ts');
    const alias = join(corpus.root, 'fixture/hardlink-alias.ts');
    await link(source, alias);

    await expect(
      loadCodeMemoryLinkCodexSuiteTask({
        expectedLayoutArtifactId: corpus.layoutArtifactId,
        expectedSuiteHash: corpus.suiteHash,
        root: corpus.root,
        taskId: corpus.taskId,
      }),
    ).rejects.toThrow('non-hardlinked');
  });

  it('rejects mutable layout or packet bytes before selecting a task', async () => {
    const corpus = await writeCorpus(await temporaryRoot(roots));
    await writeFile(join(corpus.root, 'adapter.json'), '{}\n');
    await expect(
      loadCodeMemoryLinkCodexSuiteTask({
        expectedLayoutArtifactId: corpus.layoutArtifactId,
        expectedSuiteHash: corpus.suiteHash,
        root: corpus.root,
        taskId: corpus.taskId,
      }),
    ).rejects.toThrow('hash differs');
  });

  it('rejects every generated traversal destination', () => {
    fc.assert(
      fc.property(fc.string({minLength: 1, maxLength: 32}), suffix => {
        const value = minimalLayout();
        value.fixtureFiles[0].destination = `../${suffix || 'escape'}`;
        expect(() => parseCodeMemoryLinkCodexSuiteLayoutV1(value)).toThrow();
      }),
      {numRuns: 40},
    );
  });

  it('requires an exact sorted selected-memory identity/content roster', () => {
    const value = minimalLayout();
    value.tasks[0].preflightExpectedSelectedMemories = [
      {
        contentSha256: Effect.pipe('2', EffectString.repeat(64)),
        memoryIdDigest: Effect.pipe('1', EffectString.repeat(64)),
      },
      {
        contentSha256: Effect.pipe('4', EffectString.repeat(64)),
        memoryIdDigest: Effect.pipe('3', EffectString.repeat(64)),
      },
    ];
    expect(parseCodeMemoryLinkCodexSuiteLayoutV1(value).tasks[0].preflightExpectedSelectedMemories).toHaveLength(2);

    value.tasks[0].preflightExpectedSelectedMemories = [
      {
        contentSha256: Effect.pipe('4', EffectString.repeat(64)),
        memoryIdDigest: Effect.pipe('3', EffectString.repeat(64)),
      },
      {
        contentSha256: Effect.pipe('2', EffectString.repeat(64)),
        memoryIdDigest: Effect.pipe('1', EffectString.repeat(64)),
      },
    ];
    expect(() => parseCodeMemoryLinkCodexSuiteLayoutV1(value)).toThrow('unique and sorted');
  });
});

interface WrittenCorpus {
  readonly layoutArtifactId: string;
  readonly programSha256: string;
  readonly root: string;
  readonly suiteHash: string;
  readonly taskId: string;
}

async function writeCorpus(root: string): Promise<WrittenCorpus> {
  await Promise.all([
    mkdir(join(root, 'fixture')),
    mkdir(join(root, 'judge')),
    mkdir(join(root, 'packets')),
    mkdir(join(root, 'rubrics')),
  ]);
  const taskIds = Array.from(
    {length: 28},
    (_, index) => `tsk_${Effect.pipe((index + 1).toString(16), EffectString.padStart(16, '0'))}`,
  );
  const fixtureArtifacts = EffectArray.map(taskIds, (taskId, index) => {
    const content = `export const task = '${taskId}';\n`;
    return {
      artifactId: `art_${Effect.pipe((index + 1).toString(16), EffectString.padStart(16, '0'))}`,
      content,
      sha256: sha256(content),
      source: `fixture/${Effect.pipe((index + 1).toString(16), EffectString.padStart(16, '0'))}.ts`,
      taskId,
    };
  });
  const fixtureWithoutHash = {
    artifacts: EffectArray.map(fixtureArtifacts, ({artifactId, sha256}) => ({artifactId, sha256})),
    version: 1 as const,
  };
  const fixture = {...fixtureWithoutHash, fixtureHash: codeMemoryLinkFixtureHashV1(fixtureWithoutHash)};
  const packets = EffectArray.map(taskIds, (taskId, index) => packet(taskId, index < 12, fixture.fixtureHash));
  const rubrics = EffectArray.map(packets, packet => rubric(packet, packet.taskKind === 'hidden-constraint'));
  for (const artifact of fixtureArtifacts) await writeFile(join(root, artifact.source), artifact.content);
  for (let index = 0; index < packets.length; index += 1) {
    await writeFile(
      join(root, `packets/${Effect.pipe(index.toString(), EffectString.padStart(2, '0'))}.json`),
      JSON.stringify(packets[index]),
    );
    await writeFile(
      join(root, `rubrics/${Effect.pipe(index.toString(), EffectString.padStart(2, '0'))}.json`),
      JSON.stringify(rubrics[index]),
    );
  }

  const layoutArtifactId = `art_${Effect.pipe('a', EffectString.repeat(16))}`;
  const commandArtifactId = `art_${Effect.pipe('b', EffectString.repeat(16))}`;
  const programArtifactId = `art_${Effect.pipe('c', EffectString.repeat(16))}`;
  const command = `${JSON.stringify({
    maxOutputBytes: 65_536,
    programArtifactId,
    runner: 'bun',
    timeoutMilliseconds: 10_000,
    version: 1,
  })}\n`;
  const program = 'process.stdout.write(JSON.stringify({version:1,artifacts:[]}));\n';
  await writeFile(join(root, 'judge/command.json'), command);
  await writeFile(join(root, 'judge/program.ts'), program);
  const layout = {
    fixtureFiles: EffectArray.map(fixtureArtifacts, artifact => ({
      artifactId: artifact.artifactId,
      destination: 'src/task.ts',
      scope: 'repository',
      source: artifact.source,
      taskId: artifact.taskId,
    })),
    judge: {
      commandArtifactId,
      files: [
        {artifactId: layoutArtifactId, destination: 'adapter.json', source: 'adapter.json'},
        {artifactId: commandArtifactId, destination: 'command.json', source: 'judge/command.json'},
        {artifactId: programArtifactId, destination: 'program.ts', source: 'judge/program.ts'},
      ],
    },
    layoutArtifactId,
    tasks: EffectArray.map(packets, (packet, index) => ({
      packetHash: packet.packetHash,
      packetSource: `packets/${Effect.pipe(index.toString(), EffectString.padStart(2, '0'))}.json`,
      preflightCodeRefs: ['src/task.ts'],
      preflightExpectedCitationDigests: rubrics[index].goldCitationDigests,
      preflightExpectedResponses: responseProjections(),
      preflightExpectedSelectedMemories: [],
      project: 'code-memory-link',
      rubricHash: rubrics[index].rubricHash,
      rubricSource: `rubrics/${Effect.pipe(index.toString(), EffectString.padStart(2, '0'))}.json`,
      taskId: packet.taskId,
      taskKind: packet.taskKind,
    })),
    version: 1,
  };
  const layoutBytes = `${JSON.stringify(layout)}\n`;
  await writeFile(join(root, 'adapter.json'), layoutBytes);
  const judgeWithoutHash = {
    artifacts: [
      {artifactId: layoutArtifactId, sha256: sha256(layoutBytes)},
      {artifactId: commandArtifactId, sha256: sha256(command)},
      {artifactId: programArtifactId, sha256: sha256(program)},
    ],
    judgeVersion: `ver_${Effect.pipe('1', EffectString.repeat(16))}`,
    version: 1 as const,
  };
  const judge = {...judgeWithoutHash, judgeHash: codeMemoryLinkJudgeHashV1(judgeWithoutHash)};
  const suiteWithoutHash = {
    fixture,
    judge,
    suiteId: `sui_${Effect.pipe('1', EffectString.repeat(16))}`,
    tasks: EffectArray.map(packets, (packet, index) => ({
      packetHash: packet.packetHash,
      rubricHash: rubrics[index].rubricHash,
      taskId: packet.taskId,
      taskKind: packet.taskKind,
    })),
    version: 1 as const,
  };
  const suite = {...suiteWithoutHash, suiteHash: codeMemoryLinkSealedSuiteHashV1(suiteWithoutHash)};
  await writeFile(join(root, 'suite.json'), `${JSON.stringify(suite)}\n`);
  return {
    layoutArtifactId,
    programSha256: sha256(program),
    root,
    suiteHash: suite.suiteHash,
    taskId: packets[0].taskId,
  };
}

function packet(taskId: string, hidden: boolean, fixtureHash: string): CodeMemoryLinkTaskPacketV1 {
  const withoutHash = {
    budget: {steps: 8, tokens: 4_000},
    fixtureHash,
    prompt: `Implement ${taskId}.`,
    taskId,
    taskKind: hidden ? ('hidden-constraint' as const) : ('negative-control' as const),
    version: 1 as const,
  };
  return {...withoutHash, packetHash: codeMemoryLinkTaskPacketHashV1(withoutHash)};
}

function rubric(packet: CodeMemoryLinkTaskPacketV1, hidden: boolean): CodeMemoryLinkRubricV1 {
  const textArtifact = `art_${Effect.pipe('d', EffectString.repeat(16))}`;
  const jsonArtifact = `art_${Effect.pipe('e', EffectString.repeat(16))}`;
  const withoutHash = {
    fixtureHash: packet.fixtureHash,
    goldCitationDigests: hidden
      ? [codeMemoryLinkGoldCitationDigest(`tncc_${Effect.pipe(packet.taskId, EffectString.slice(4))}`)]
      : [],
    predicates: hidden
      ? [
          {
            assertion: {artifactId: textArtifact, expected: 'required=true', kind: 'utf8-contains' as const},
            expected: true,
            predicateId: `prd_${Effect.pipe('1', EffectString.repeat(16))}`,
            roles: ['constraint', 'task-pass'] as const,
          },
          {
            assertion: {artifactId: textArtifact, expected: 'harmful=true', kind: 'utf8-not-contains' as const},
            expected: true,
            predicateId: `prd_${Effect.pipe('2', EffectString.repeat(16))}`,
            roles: ['harmful-acceptance'] as const,
          },
          {
            assertion: {artifactId: jsonArtifact, expected: {memoryExclusive: true}, kind: 'json-equals' as const},
            expected: true,
            predicateId: `prd_${Effect.pipe('3', EffectString.repeat(16))}`,
            roles: ['constraint', 'memory-exclusive', 'task-pass'] as const,
          },
          {
            assertion: {artifactId: textArtifact, expected: 'action=true', kind: 'utf8-contains' as const},
            expected: true,
            predicateId: `prd_${Effect.pipe('4', EffectString.repeat(16))}`,
            roles: ['qualifying-action'] as const,
          },
        ]
      : [
          {
            assertion: {artifactId: textArtifact, expected: 'control=true', kind: 'utf8-contains' as const},
            expected: true,
            predicateId: `prd_${Effect.pipe('1', EffectString.repeat(16))}`,
            roles: ['task-pass'] as const,
          },
        ],
    qualifyingActionItemTypes: hidden ? (['fileChange'] as const) : [],
    taskId: packet.taskId,
    taskKind: packet.taskKind,
    version: 1 as const,
  };
  return {...withoutHash, rubricHash: codeMemoryLinkRubricHashV1(withoutHash)};
}

function minimalLayout(): {
  fixtureFiles: Array<Record<string, unknown>>;
  judge: Record<string, unknown>;
  layoutArtifactId: string;
  tasks: Array<Record<string, unknown>>;
  version: number;
} {
  return {
    fixtureFiles: [
      {
        artifactId: `art_${Effect.pipe('1', EffectString.repeat(16))}`,
        destination: 'src/task.ts',
        scope: 'repository',
        source: 'fixture/task.ts',
        taskId: `tsk_${Effect.pipe('1', EffectString.repeat(16))}`,
      },
    ],
    judge: {commandArtifactId: `art_${Effect.pipe('2', EffectString.repeat(16))}`, files: []},
    layoutArtifactId: `art_${Effect.pipe('3', EffectString.repeat(16))}`,
    tasks: [
      {
        packetHash: Effect.pipe('4', EffectString.repeat(64)),
        packetSource: 'packets/task.json',
        preflightCodeRefs: ['src/task.ts'],
        preflightExpectedCitationDigests: [],
        preflightExpectedResponses: responseProjections(),
        preflightExpectedSelectedMemories: [],
        project: 'code-memory-link',
        rubricHash: Effect.pipe('5', EffectString.repeat(64)),
        rubricSource: 'rubrics/task.json',
        taskId: `tsk_${Effect.pipe('1', EffectString.repeat(16))}`,
        taskKind: 'hidden-constraint',
      },
    ],
    version: 1,
  };
}

function responseProjections() {
  const receipt = (version: 2 | 3) =>
    canonicalizeCodeMemoryLinkContextBriefResultV1({
      activeHandoffs: [],
      durableDecisions: [],
      type: 'context-brief',
      version,
    }).receipt;
  return {
    anchored: receipt(3),
    noMemory: canonicalizeCodeMemoryLinkContextBriefResultV1(
      CODE_MEMORY_LINK_CANONICAL_EMPTY_CONTEXT_BRIEF_V1.structuredContent,
    ).receipt,
    taskOnly: receipt(2),
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function temporaryRoot(roots: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'threadnote-codex-suite-test-'));
  const canonical = await realpath(root);
  roots.push(canonical);
  return canonical;
}
