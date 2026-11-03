import {spawnSync} from '@threadnote/testing/node-child-process';
import {writeFile} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';
import {Array as EffectArray, String as EffectString} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {validateTopicMaintenanceDraftBasis} from '@threadnote/memory/topic-maintenance-draft';
import {isJsonObject} from '@threadnote/platform/json';
import {isManagerContextMaintenancePacketV2} from '@threadnote/manager/api/response-guards';
import {makeTopicDraftWireFixture} from '../../../helpers/topic-draft-wire.js';
import {modelReply} from './model.js';
import {findExecutable} from './environment.js';
import {createRepository, indexRepository} from './repositories.js';
import {fixtureTool} from './reviews.js';
import type {ManagerRuntime} from './runtime.js';

export async function createTopicReview(manager: ManagerRuntime) {
  const repository = await createRepository(manager);
  await indexRepository(manager, repository);
  const output = await manager.cli(
    [
      'remember',
      '--kind',
      'durable',
      '--project',
      'alpha',
      '--topic',
      'topic-greeting',
      '--code-ref',
      'src/entry.ts',
      '--require-current-code-refs',
      '--text',
      'The greeting returns a trimmed name.',
    ],
    undefined,
    30_000,
    repository.root,
  );
  const uri = /Stored memory: (threadnote:\/\/\S+)/u.exec(output)?.[1];
  if (!uri) throw new Error('Topic target receipt missing.');
  const inspected = (await fixtureTool(manager, 'context_topic_enrollment', {action: 'inspect', uri}))
    .structuredContent;
  const citation =
    isJsonObject(inspected) && EffectArray.isArray(inspected.citations) ? inspected.citations[0] : undefined;
  if (!isJsonObject(citation) || typeof citation.id !== 'string') throw new Error('Topic citation missing.');
  const input = {
    uri,
    callerCwd: repository.root,
    project: 'alpha',
    inputJson: JSON.stringify({paragraphs: [{role: 'descriptive', support: 'direct', citationIds: [citation.id]}]}),
  };
  const preview = (await fixtureTool(manager, 'context_topic_enrollment', {...input, action: 'preview'}))
    .structuredContent;
  if (!isJsonObject(preview) || !isJsonObject(preview.proposal)) throw new Error('Topic enrollment preview missing.');
  const enrolled = (
    await fixtureTool(manager, 'context_topic_enrollment', {
      ...input,
      action: 'enroll',
      approved: true,
      expectedContentHash: preview.proposal.expectedContentHash,
      revision: preview.proposal.revision,
    })
  ).structuredContent;
  if (!isJsonObject(enrolled) || enrolled.status !== 'enrolled') throw new Error('Topic enrollment failed.');
  const before = (await manager.api(`/api/memory?uri=${encodeURIComponent(uri)}`)).content;
  await writeFile(
    join(repository.root, 'src/entry.ts'),
    EffectString.replace('return normalize(name)', 'return normalize(name).toUpperCase()')(repository.source),
  );
  const commit = spawnSync(findExecutable('git'), ['-C', repository.root, 'commit', '-am', 'Changed fixture'], {
    env: manager.environment,
  });
  if (commit.status !== 0) throw new Error('Topic fixture commit failed.');
  await indexRepository(manager, repository);
  await fixtureTool(manager, 'context_maintain', {action: 'resume', callerCwd: repository.root, project: 'alpha'});
  for (let turn = 0; turn < 3; turn++)
    await fixtureTool(manager, 'context_maintain', {
      action: 'run',
      callerCwd: repository.root,
      project: 'alpha',
      maxRecords: 16,
    });
  const status = (await fixtureTool(manager, 'context_maintenance_status', {project: 'alpha'})).structuredContent;
  if (!isJsonObject(status) || !EffectArray.isArray(status.cases)) throw new Error('Topic case missing.');
  const selected = EffectArray.findFirst(
    status.cases,
    item => isJsonObject(item) && item.family === 'topic-maintenance',
  );
  if (selected._tag !== 'Some' || !isJsonObject(selected.value) || typeof selected.value.caseId !== 'string')
    throw new Error('Topic case identity missing.');
  const packet = (await fixtureTool(manager, 'context_maintenance_packet', {caseId: selected.value.caseId}))
    .structuredContent;
  if (!isManagerContextMaintenancePacketV2(packet)) throw new Error('Topic packet unavailable.');
  const topic = packet.topicEvidence;
  if (!topic || topic.version !== 1 || topic.outcome !== 'ready' || !topic.sources)
    throw new Error('Exact topic evidence is not ready.');
  const basis = validateTopicMaintenanceDraftBasis({
    version: 1,
    targetUri: topic.targetUri,
    targetHash: topic.targetHash,
    observationRevision: topic.observationRevision,
    packetDigest: sha256HexSync(JSON.stringify(topic)),
    body: topic.body,
    paragraphs: topic.paragraphs,
    additionalDependencies: topic.additionalDependencies ?? [],
    handles: EffectArray.flatMap(topic.sources, source => [
      {id: `historical:${source.citationId}`, citationId: source.citationId, variant: 'historical'},
      {id: `current:${source.citationId}`, citationId: source.citationId, variant: 'current'},
    ]),
  });
  const wire = makeTopicDraftWireFixture(basis, 'update');
  wire.facts.entries[0].currentBehavior = 'The greeting returns a trimmed uppercase name.';
  wire.facts.entries[0].text = 'The greeting returns a trimmed uppercase name.';
  await modelReply(manager, JSON.stringify(wire));
  const generated = (
    await fixtureTool(manager, 'context_maintenance_draft', {
      caseId: selected.value.caseId,
      backend: 'effect-ai',
      modelId: 'synthetic-model',
    })
  ).structuredContent;
  if (!isJsonObject(generated) || typeof generated.reviewId !== 'string')
    throw new Error('Topic draft receipt missing.');
  await manager.api('/api/attention/context-maintenance?view=controls', {action: 'pause'});
  return {repository, uri, before, reviewId: generated.reviewId};
}
