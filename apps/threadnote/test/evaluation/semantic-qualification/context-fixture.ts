/* oxlint-disable effecttsgo/node-builtin-import -- Qualification owns only an authored private source fixture and exact byte checks. */
import {strict as assert} from 'node:assert';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Array as EffectArray, Record as EffectRecord, String as EffectString} from 'effect';
import {isJsonObject} from '@threadnote/platform/json';
import type {ProviderInputs, QualificationCli} from './provider-fixture.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const graphHash = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  return hash(`git-object-v1\nsha1\n${blob}`);
};
const currentConstraint = 'P11_CURRENT_CONSTRAINT: preserve UnsavedName.';
const staleDecision = 'P11_STALE_DECISION: preserve original bytes.';
const unrelated = 'P11_UNRELATED_CONSTRAINT: dependent only.';

/** S08/S09 partial: real private memory, source-only graph and semantic source binding; no inferred keywords/models. */
export async function runContextFixture(
  input: ProviderInputs,
  project: string,
  sources: Record<string, string>,
  run: QualificationCli,
  within: <A>(promise: Promise<A>, milliseconds: number) => Promise<A>,
  deadline: number,
  results: unknown[],
  initializeRepository: () => Promise<void>,
) {
  const [declaration, dependent] = EffectRecord.keys(sources);
  const original = sources[declaration];
  const lines = EffectString.split('\r\n')(original);
  const line = EffectArray.findFirstIndex(lines, text => EffectString.includes('UnsavedName')(text));
  assert.equal(line._tag, 'Some');
  if (line._tag !== 'Some') throw new Error('Missing fixed symbol');
  const character = EffectString.indexOf('UnsavedName')(lines[line.value]);
  assert.equal(character._tag, 'Some');
  if (character._tag !== 'Some') throw new Error('Missing fixed symbol position');
  const request = {
    callerCwd: project,
    file: join(project, declaration),
    language: input.language,
    ...(input.language === 'python' ? {environment: 'p11-static-environment'} : {}),
    operation: 'context',
    task: 'Explain UnsavedName and its applicable current constraint.',
    position: {line: line.value, character: character.value + 2},
    milliseconds: 10000,
    maxBytes: 32768,
    maxItems: 32,
    budgetTokens: 1500,
  };
  const record = {
    operation: 'semantic-context-graph-memory-join',
    status: 'observing',
    fullScenarioQualified: false,
    checks: [] as unknown[],
  };
  results.push(record);
  await within(initializeRepository(), deadline - Date.now());
  const index = () => run(['graph', 'index', '--cwd', project, '--no-vectors', '--json'], {});
  const remember = async (topic: string, file: string, text: string) => {
    const stored = await run(
      [
        'remember',
        '--project',
        'project',
        '--topic',
        topic,
        '--keyword',
        'UnsavedName',
        '--code-ref',
        file,
        '--require-current-code-refs',
        '--text',
        `Applies to: ${file}\nInvariant: ${text}\nVerify: the fixed P11 source fixture.`,
      ],
      {},
    );
    assert.ok(
      isJsonObject(stored.value) &&
        typeof stored.value.text === 'string' &&
        EffectString.includes('Stored memory: threadnote://')(stored.value.text),
      'Own isolated memory actually stored',
    );
  };
  const context = async (label: string, text: string, bound: boolean) => {
    const response = await run(['semantic', 'query', '--json'], request);
    let canonical = response.value;
    if (isJsonObject(canonical) && canonical.status === 'stale') {
      record.checks.push({label: label + '-prerequisite-invalidation', canonical});
      assert.equal(canonical.evidence, null, 'Changed analysis prerequisites refuse evidence');
      canonical = (await run(['semantic', 'query', '--json'], request)).value;
    }
    record.checks.push({label, file: declaration, sha256: hash(text), canonical});
    assert.ok(
      isJsonObject(canonical) &&
        canonical.status === 'ok' &&
        isJsonObject(canonical.evidence) &&
        isJsonObject(canonical.evidence.observation) &&
        EffectArray.isArray(canonical.items) &&
        isJsonObject(canonical.items[0]) &&
        isJsonObject(canonical.items[0].knowledge),
    );
    const observation = canonical.evidence.observation;
    const knowledge = canonical.items[0].knowledge;
    assert.equal(observation.content, hash(text), 'Actual semantic document hash');
    assert.equal(observation.uri, pathToFileURL(join(project, declaration)).href, 'Exact source URI');
    assert.equal(observation.worktree, pathToFileURL(project).href, 'Exact worktree');
    if (bound) {
      assert.ok(isJsonObject(knowledge.binding) && isJsonObject(knowledge.binding.graph));
      assert.equal(knowledge.binding.semanticContent, observation.content);
      assert.equal(
        knowledge.binding.graph.contentHash,
        graphHash(text),
        'Exact SHA-1 Git-blob envelope joins raw semantic bytes',
      );
      assert.equal(knowledge.binding.graph.path, declaration);
      assert.ok(
        typeof knowledge.binding.observation === 'string' && typeof knowledge.binding.graph.snapshotId === 'string',
        'Producer observation and graph snapshot provenance',
      );
    } else {
      assert.equal(knowledge.binding, null, 'Stale graph cannot authorize source linkage');
      assert.ok(
        EffectArray.isArray(knowledge.gaps) && EffectArray.contains(knowledge.gaps, 'semantic-graph-source-unbound'),
      );
    }
    return knowledge;
  };
  try {
    await index();
    const empty = await context('no-applicable-memory', original, true);
    assert.ok(
      !EffectString.includes(currentConstraint)(JSON.stringify(empty)) &&
        !EffectString.includes(staleDecision)(JSON.stringify(empty)),
      'No fabricated constraint',
    );
    await remember('p11-stale-decision', declaration, staleDecision);
    const changed = original + (input.language === 'python' ? '# P11 graph revision\r\n' : '// P11 graph revision\r\n');
    await writeFile(join(project, declaration), changed);
    await index();
    await remember('p11-current-constraint', declaration, currentConstraint);
    await remember('p11-unrelated', dependent, unrelated);
    const current = await context('current-and-stale-citations', changed, true);
    const serialized = JSON.stringify(current);
    assert.ok(EffectString.includes(currentConstraint)(serialized), 'Applicable current constraint included');
    assert.ok(!EffectString.includes(unrelated)(serialized), 'Unrelated document constraint omitted');
    assert.ok(isJsonObject(current.brief) && EffectArray.isArray(current.brief.durableDecisions));
    assert.ok(
      EffectArray.some(
        current.brief.durableDecisions,
        decision =>
          isJsonObject(decision) &&
          decision.freshness === 'stale' &&
          decision.preciseStatus === 'changed' &&
          EffectString.includes('P11_STALE_DECISION')(JSON.stringify(decision)),
      ),
      'Stale cited decision explicitly labeled',
    );
    assert.ok(
      isJsonObject(current.brief.output) &&
        current.brief.output.truncated === true &&
        isJsonObject(current.brief.output.omissions),
      'Budget omissions visible',
    );
    record.checks.push({
      label: 'stale-decision-disposition',
      explicitlyLabeled: true,
      omissions: current.brief.output,
      gaps: current.gaps,
      fullScenarioQualified: false,
    });
    await writeFile(join(project, declaration), original);
    await context('graph-source-drift-refusal', original, false);
    record.status = 'passed';
  } finally {
    await writeFile(join(project, declaration), original);
    assert.equal(await readFile(join(project, declaration), 'utf8'), original, 'Authored source restored');
  }
}
