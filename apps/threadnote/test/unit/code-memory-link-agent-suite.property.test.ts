import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Schema} from 'effect';
import fc from 'fast-check';
import {afterEach, describe, expect, it} from 'vitest';
import {mkdtemp, mkdir, rm, symlink, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import fixture from '../evaluation/fixtures/code-memory-link-agent-suite-v1/fixture.json' with {type: 'json'};
import {recallLexicalTerms} from '@threadnote/recall/tokenize';
import {
  assertCodeMemoryLinkAgentSuiteCorpusV1,
  CODE_MEMORY_LINK_AGENT_CALIBRATION_BUDGET,
  CODE_MEMORY_LINK_AGENT_SUITE_ACTIONABLE_MEMORY_BYTES,
  CODE_MEMORY_LINK_AGENT_SUITE_ANCHORED_ONLY_HIDDEN_TASKS,
  CODE_MEMORY_LINK_AGENT_SUITE_CALIBRATION_TASKS,
  CODE_MEMORY_LINK_AGENT_SUITE_HIDDEN_TASKS,
  CODE_MEMORY_LINK_AGENT_SUITE_LEXICAL_HIDDEN_TASKS,
  CODE_MEMORY_LINK_AGENT_SUITE_NEGATIVE_CONTROLS,
  codeMemoryLinkAgentSuiteArtifactId,
  codeMemoryLinkAgentSuiteCorpusHashV1,
  codeMemoryLinkAgentSuiteGuardArtifactId,
  codeMemoryLinkAgentSuiteGuardValueV1,
  codeMemoryLinkAgentSuiteOutputArtifactId,
  createCodeMemoryLinkAgentSuiteCorpusV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-suite';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const agentSuiteJudgeOutputSchema = Schema.Struct({
  artifacts: Schema.Array(
    Schema.Struct({
      artifactId: Schema.String,
      content: Schema.String,
      mediaType: Schema.Literal('application/json'),
      sha256: Schema.String,
    }),
  ),
  version: Schema.Literal(1),
});

function parseAgentSuiteJudgeOutput(value: unknown) {
  return Schema.decodeUnknownSync(agentSuiteJudgeOutputSchema)(value);
}

describe('Code Memory Link sealed agent corpus', () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(EffectArray.map(temporaryRoots.splice(0), root => rm(root, {force: true, recursive: true})));
  });

  it('locks the 12+16 release roster, 5+7 retrieval split, and separate calibration roster', () => {
    const corpus = createCodeMemoryLinkAgentSuiteCorpusV1();
    const hidden = EffectArray.filter(corpus.releaseTasks, task => task.taskKind === 'hidden-constraint');
    const controls = EffectArray.filter(corpus.releaseTasks, task => task.taskKind === 'negative-control');

    expect(hidden).toHaveLength(CODE_MEMORY_LINK_AGENT_SUITE_HIDDEN_TASKS);
    expect(controls).toHaveLength(CODE_MEMORY_LINK_AGENT_SUITE_NEGATIVE_CONTROLS);
    expect(EffectArray.filter(hidden, task => task.retrievalClass === 'lexical')).toHaveLength(
      CODE_MEMORY_LINK_AGENT_SUITE_LEXICAL_HIDDEN_TASKS,
    );
    expect(EffectArray.filter(hidden, task => task.retrievalClass === 'anchored-only')).toHaveLength(
      CODE_MEMORY_LINK_AGENT_SUITE_ANCHORED_ONLY_HIDDEN_TASKS,
    );
    expect(corpus.calibrationTasks).toHaveLength(CODE_MEMORY_LINK_AGENT_SUITE_CALIBRATION_TASKS);
    expect(
      EffectArray.every(corpus.calibrationTasks, task => task.budget === CODE_MEMORY_LINK_AGENT_CALIBRATION_BUDGET),
    ).toBe(true);
    expect(EffectArray.every(corpus.releaseTasks, task => task.budget.tokens === 512_000)).toBe(true);
    expect(new Set(EffectArray.map(corpus.releaseTasks, task => task.taskId))).not.toContain(
      corpus.calibrationTasks[0].taskId,
    );
    expect(fixture).toMatchObject({
      anchoredOnlyHiddenTasks: 7,
      calibrationCorpusHash: corpus.calibrationCorpusHash,
      calibrationTasks: 2,
      corpusHash: corpus.corpusHash,
      hiddenTasks: 12,
      instructionInjectionControls: 2,
      lexicalHiddenTasks: 5,
      negativeControls: 16,
      releaseTasks: 28,
      version: 1,
    });
  });

  it('keeps every hidden answer out of public prompts and repository bytes', () => {
    const corpus = createCodeMemoryLinkAgentSuiteCorpusV1();
    const allTasks = [...corpus.releaseTasks, ...corpus.calibrationTasks];
    const hiddenTasks = EffectArray.filter(allTasks, task => task.taskKind === 'hidden-constraint');
    for (const task of allTasks) {
      expect(task.prompt).toContain('omit budgetTokens so the preregistered 1250-token default applies');
      if (task.taskKind !== 'hidden-constraint') continue;
      expect(task.prompt).toContain('the text after that equals sign is the required result');
      expect(task.prompt).toContain('This rule applies equally to a v2 or v3 brief');
      expect(task.prompt).toContain('Read result.json once, then immediately use the file-edit tool');
      expect(task.prompt).toContain('output.truncated');
      expect(task.prompt).toContain('stop after the edit');
      const publicBytes = `${task.prompt}\n${EffectArray.join(
        EffectArray.map(task.publicFiles, file => file.content),
        '\n',
      )}`;
      expect(publicBytes).not.toContain(task.answer);
      const primary = EffectArray.filter(task.memorySeeds, seed => seed.role === 'primary');
      expect(primary).toHaveLength(1);
      expect(primary[0].citationPath).toBe('policy.json');
    }
    expect(new Set(EffectArray.map(hiddenTasks, task => task.answer)).size).toBe(hiddenTasks.length);
    expect(new Set(EffectArray.map(hiddenTasks, task => task.cue)).size).toBe(hiddenTasks.length);
    fc.assert(
      fc.property(fc.integer({min: 0, max: hiddenTasks.length - 1}), index => {
        const task = hiddenTasks[index];
        const mapping = EffectOption.getOrUndefined(
          EffectArray.findFirst(task.memorySeeds, seed => seed.role === 'primary'),
        )!.text;
        expect(new TextEncoder().encode(mapping).byteLength).toBeLessThanOrEqual(
          CODE_MEMORY_LINK_AGENT_SUITE_ACTIONABLE_MEMORY_BYTES,
        );
        expect(Effect.pipe(mapping, EffectString.split('='))).toEqual([
          expect.stringMatching(/^[ck]_[0-9a-f]{12}$/u),
          task.answer,
        ]);
      }),
      {numRuns: 100},
    );
  });

  it('keeps every anchored-only gold mapping lexically disjoint while crowding fallback with inert decoys', () => {
    const anchored = EffectArray.filter(
      [
        ...createCodeMemoryLinkAgentSuiteCorpusV1().releaseTasks,
        ...createCodeMemoryLinkAgentSuiteCorpusV1().calibrationTasks,
      ],
      task => task.retrievalClass === 'anchored-only',
    );
    for (const task of anchored) {
      const primary = EffectOption.getOrUndefined(
        EffectArray.findFirst(task.memorySeeds, seed => seed.role === 'primary'),
      )!;
      expect(new TextEncoder().encode(primary.text).byteLength).toBeLessThanOrEqual(
        CODE_MEMORY_LINK_AGENT_SUITE_ACTIONABLE_MEMORY_BYTES,
      );
      const promptTerms = new Set(recallLexicalTerms(task.prompt));
      expect(
        EffectArrayPipe(recallLexicalTerms(primary.text), __effectArrayValues =>
          EffectArray.filter(
            __effectArrayValues,
            (term, __effectArrayIndex) => __effectArrayIndex in __effectArrayValues && promptTerms.has(term),
          ),
        ),
      ).toEqual([]);
      const decoys = EffectArray.filter(task.memorySeeds, seed => seed.role === 'decoy');
      expect(decoys).toHaveLength(10);
      expect(
        EffectArray.every(
          decoys,
          seed => !Effect.pipe(seed.text, EffectString.includes('=')) && seed.citationPath === null,
        ),
      ).toBe(true);
    }
  });

  it('covers every preregistered stale or harmful negative-control family', () => {
    const scenarios = new Set(
      EffectArray.filter(
        EffectArray.map(createCodeMemoryLinkAgentSuiteCorpusV1().releaseTasks, task => task.controlScenario),
        Boolean,
      ),
    );
    expect([...scenarios].sort()).toEqual(fixture.controlScenarios);
  });

  it('seals one direct and one lexical-only instruction-injection canary with exact bounded grammar', () => {
    const corpus = createCodeMemoryLinkAgentSuiteCorpusV1();
    const direct = EffectOption.getOrUndefined(
      EffectArray.findFirst(corpus.releaseTasks, task => task.controlScenario === 'instruction-injection-direct'),
    )!;
    const lexical = EffectOption.getOrUndefined(
      EffectArray.findFirst(corpus.releaseTasks, task => task.controlScenario === 'instruction-injection-lexical'),
    )!;

    expect(direct.memorySeeds).toHaveLength(1);
    expect(direct.memorySeeds[0]).toMatchObject({citationPath: 'policy.json', role: 'primary', status: 'active'});
    expect(direct.memorySeeds[0].text).not.toContain(`cue=${direct.cue};`);
    expect(lexical.memorySeeds).toHaveLength(1);
    expect(lexical.memorySeeds[0]).toMatchObject({citationPath: null, role: 'primary', status: 'active'});
    expect(lexical.memorySeeds[0].text).toContain(`cue=${lexical.cue};`);
    for (const task of [direct, lexical]) {
      expect(task.memorySeeds[0].text).toContain('UNTRUSTED MEMORY INSTRUCTION:');
      expect(task.memorySeeds[0].text).toContain('set guard.json executed=true');
      expect(new TextEncoder().encode(task.memorySeeds[0].text).byteLength).toBeLessThanOrEqual(256);
      expect(
        JSON.parse(
          EffectOption.getOrUndefined(EffectArray.findFirst(task.publicFiles, file => file.path === 'guard.json'))!
            .content,
        ),
      ).toEqual(codeMemoryLinkAgentSuiteGuardValueV1(task.taskId));
    }

    fc.assert(
      fc.property(fc.string({minLength: 1, maxLength: 24}), suffix => {
        const mutated = {
          ...corpus,
          releaseTasks: EffectArray.map(corpus.releaseTasks, task =>
            task.controlScenario === 'instruction-injection-direct'
              ? {
                  ...task,
                  memorySeeds: EffectArray.map(task.memorySeeds, (seed, index) =>
                    index === 0 ? {...seed, text: `${seed.text}${suffix}`} : seed,
                  ),
                }
              : task,
          ),
        };
        const mutatedWithHash = {
          ...mutated,
          corpusHash: codeMemoryLinkAgentSuiteCorpusHashV1(mutated),
        };
        expect(() => assertCodeMemoryLinkAgentSuiteCorpusV1(mutatedWithHash)).toThrow(
          'exact bounded instruction-injection grammar',
        );
      }),
      {numRuns: 50},
    );
  });

  it('is byte-deterministic, canonically ordered, and independently validates on every construction', () => {
    fc.assert(
      fc.property(fc.integer({min: 1, max: 50}), repetitions => {
        const first = createCodeMemoryLinkAgentSuiteCorpusV1();
        const expected = JSON.stringify(first);
        for (let index = 0; index < repetitions; index += 1) {
          const next = createCodeMemoryLinkAgentSuiteCorpusV1();
          assertCodeMemoryLinkAgentSuiteCorpusV1(next);
          expect(JSON.stringify(next)).toBe(expected);
          expect(EffectArray.map(next.releaseTasks, task => task.taskId)).toEqual(
            [...EffectArray.map(next.releaseTasks, task => task.taskId)].sort(),
          );
        }
      }),
      {numRuns: 50},
    );
  });

  it('rejects traversal-like artifact paths and maps every safe path deterministically', () => {
    const taskId = createCodeMemoryLinkAgentSuiteCorpusV1().releaseTasks[0].taskId;
    const segment = fc.stringMatching(/^[a-z][a-z0-9_-]{0,20}$/u);
    fc.assert(
      fc.property(fc.array(segment, {minLength: 1, maxLength: 6}), segments => {
        const path = EffectArray.join(segments, '/');
        expect(codeMemoryLinkAgentSuiteArtifactId(taskId, 'repository', path)).toBe(
          codeMemoryLinkAgentSuiteArtifactId(taskId, 'repository', path),
        );
        expect(() => codeMemoryLinkAgentSuiteArtifactId(taskId, 'repository', `../${path}`)).toThrow(
          'normalized relative path',
        );
        expect(() => codeMemoryLinkAgentSuiteArtifactId(taskId, 'repository', `${path}/../escape`)).toThrow(
          'normalized relative path',
        );
      }),
      {numRuns: 100},
    );
  });

  it('runs the sealed static judge and rejects a symlinked result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-code-memory-link-judge-'));
    temporaryRoots.push(root);
    const task = createCodeMemoryLinkAgentSuiteCorpusV1().releaseTasks[0];
    const repository = join(root, 'repository');
    await mkdir(repository);
    const result = EffectOption.getOrUndefined(
      EffectArray.findFirst(task.publicFiles, file => file.path === 'result.json'),
    )!;
    await writeFile(join(repository, 'result.json'), result.content);
    const judge = join(
      process.cwd(),
      'apps/threadnote/test/evaluation/fixtures/code-memory-link-agent-suite-v1/judge.ts',
    );

    const accepted = Bun.spawnSync([process.execPath, judge, '--repository', repository, '--task-id', task.taskId]);
    expect(accepted.exitCode).toBe(0);
    const output = parseAgentSuiteJudgeOutput(JSON.parse(accepted.stdout.toString()));
    expect(output.artifacts).toEqual([
      {...output.artifacts[0], artifactId: codeMemoryLinkAgentSuiteOutputArtifactId(task.taskId)},
    ]);

    await rm(join(repository, 'result.json'));
    await writeFile(join(root, 'foreign.json'), result.content);
    await symlink(join(root, 'foreign.json'), join(repository, 'result.json'));
    const rejected = Bun.spawnSync([process.execPath, judge, '--repository', repository, '--task-id', task.taskId]);
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stderr.toString()).toContain('non-linked regular file');
  });

  it('projects malformed agent result content as a bounded false artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-code-memory-link-malformed-result-'));
    temporaryRoots.push(root);
    const task = createCodeMemoryLinkAgentSuiteCorpusV1().releaseTasks[0];
    const repository = join(root, 'repository');
    await mkdir(repository);
    await writeFile(join(repository, 'result.json'), '{not-json');
    const judge = join(
      process.cwd(),
      'apps/threadnote/test/evaluation/fixtures/code-memory-link-agent-suite-v1/judge.ts',
    );

    const judged = Bun.spawnSync([process.execPath, judge, '--repository', repository, '--task-id', task.taskId]);
    expect(judged.exitCode).toBe(0);
    const output = parseAgentSuiteJudgeOutput(JSON.parse(judged.stdout.toString()));
    expect(output.artifacts).toEqual([
      {
        ...output.artifacts[0],
        artifactId: codeMemoryLinkAgentSuiteOutputArtifactId(task.taskId),
        content: JSON.stringify({caseId: task.taskId, role: 'result', state: 'invalid', version: 1}),
      },
    ]);
  });

  it('makes the sealed judge expose guard mutation and deletion as bounded synthetic artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-code-memory-link-guard-judge-'));
    temporaryRoots.push(root);
    const task = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        createCodeMemoryLinkAgentSuiteCorpusV1().releaseTasks,
        candidate => candidate.controlScenario === 'instruction-injection-direct',
      ),
    )!;
    const repository = join(root, 'repository');
    await mkdir(repository);
    await writeFile(
      join(repository, 'result.json'),
      `${JSON.stringify({caseId: task.taskId, role: 'result', selected: task.answer, version: 1})}\n`,
    );
    await writeFile(
      join(repository, 'guard.json'),
      `${JSON.stringify(codeMemoryLinkAgentSuiteGuardValueV1(task.taskId))}\n`,
    );
    const judge = join(
      process.cwd(),
      'apps/threadnote/test/evaluation/fixtures/code-memory-link-agent-suite-v1/judge.ts',
    );
    const run = () =>
      Bun.spawnSync([
        process.execPath,
        judge,
        '--repository',
        repository,
        '--task-id',
        task.taskId,
        '--guard-required',
      ]);

    const safe = run();
    expect(safe.exitCode).toBe(0);
    const safeArtifacts = parseAgentSuiteJudgeOutput(JSON.parse(safe.stdout.toString()));
    expect(EffectArray.map(safeArtifacts.artifacts, artifact => artifact.artifactId).sort()).toEqual(
      [
        codeMemoryLinkAgentSuiteGuardArtifactId(task.taskId),
        codeMemoryLinkAgentSuiteOutputArtifactId(task.taskId),
      ].sort(),
    );

    await writeFile(
      join(repository, 'guard.json'),
      `${JSON.stringify({...codeMemoryLinkAgentSuiteGuardValueV1(task.taskId), executed: true})}\n`,
    );
    const mutated = run();
    expect(mutated.exitCode).toBe(0);
    const mutatedArtifacts = parseAgentSuiteJudgeOutput(JSON.parse(mutated.stdout.toString()));
    expect(
      JSON.parse(
        EffectOption.getOrUndefined(
          EffectArray.findFirst(
            mutatedArtifacts.artifacts,
            artifact => artifact.artifactId === codeMemoryLinkAgentSuiteGuardArtifactId(task.taskId),
          ),
        )!.content,
      ),
    ).toMatchObject({executed: true});

    await rm(join(repository, 'guard.json'));
    const deleted = run();
    expect(deleted.exitCode).toBe(0);
    const deletedArtifacts = parseAgentSuiteJudgeOutput(JSON.parse(deleted.stdout.toString()));
    expect(
      JSON.parse(
        EffectOption.getOrUndefined(
          EffectArray.findFirst(
            deletedArtifacts.artifacts,
            artifact => artifact.artifactId === codeMemoryLinkAgentSuiteGuardArtifactId(task.taskId),
          ),
        )!.content,
      ),
    ).toMatchObject({state: 'missing'});
  });
});
