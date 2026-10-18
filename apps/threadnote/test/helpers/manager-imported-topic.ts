import {Effect, FileSystem, Path} from 'effect';
import {expect} from 'vitest';
import {ResourceStore} from '@threadnote/store/resource-store';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {topicMaintenanceObsidianCitationId} from '@threadnote/memory/topic-maintenance';
import {
  captureObsidianEvidence,
  inspectObsidianNote,
  obsidianSourceWork,
  runObsidianSourceAdd,
} from '@threadnote/integration-obsidian/source';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {handleManagerAttentionAction} from '../../src/manager/attention_actions.js';
import {readContextMaintenancePacket, runContextMaintenance} from '../../src/memory/context/maintenance.js';
import {topicMaintenanceCaseId} from '../../src/memory/context/maintenance_topic.js';

/** Real provider + Manager adapters, with no repository or model requirement. */
export const managerImportedTopicFixture = Effect.fn('test.managerImportedTopicFixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-manager-imported-topic-'});
  const vault = path.join(home, 'vault');
  const notePath = path.join(vault, 'Decision.md');
  const config: RuntimeConfig = {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: path.join(home, 'manifest.yaml'),
    user: 'tester',
  };
  yield* fs.makeDirectory(vault, {recursive: true});
  yield* fs.writeFileString(notePath, 'Original note fact.');
  yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
  yield* runObsidianSourceAdd(config, {apply: true, id: 'notes', include: ['**/*.md'], vault});
  yield* obsidianSourceWork.run(config, 'notes', {
    mode: 'automatic',
    requestId: 'manager-fixture-initial',
    credentialEnvironment: {},
  });
  const inspected = yield* inspectObsidianNote(config, 'notes', 'Decision.md');
  const origin = yield* captureObsidianEvidence(config, {
    sourceId: 'notes',
    relativePath: 'Decision.md',
    fragment: 'Original note fact.',
    expectedSourceInstanceId: inspected.sourceInstanceId,
    expectedNoteId: inspected.noteId,
    expectedRevisionHash: inspected.revisionHash,
    expectedSanitizerVersion: inspected.sanitizerVersion,
  });
  const uri = 'threadnote://user/tester/memories/durable/projects/notes/imported-topic.md';
  const body = 'Old descriptive claim.\n\nHistorical constraint.';
  const content = formatMemoryDocument(
    'MEMORY',
    {
      kind: 'durable',
      status: 'active',
      memoryId: 'tn_manager_imported_topic',
      project: 'notes',
      topic: 'imported-topic',
      sourceAgentClient: 'synthetic',
      timestamp: '2026-10-18T00:00:00.000Z',
      schemaVersion: 10,
      visibility: 'personal',
      obsidianEvidence: origin,
    },
    body,
  );
  const store = yield* ResourceStore;
  const location = {account: config.account, home, user: config.user};
  yield* store.write(location, uri, content, {mode: 'create'});
  const request = (method: string, route: string, input: Record<string, unknown> = {}) =>
    handleManagerAttentionAction({
      config,
      method,
      url: new URL(`http://manager.test${route}`),
      body: Effect.succeed(input),
    });
  const input = {
    paragraphs: [
      {role: 'descriptive', support: 'direct', citationIds: [topicMaintenanceObsidianCitationId(origin)]},
      {role: 'historical', support: 'direct', citationIds: [topicMaintenanceObsidianCitationId(origin)]},
    ],
  };
  const inspection = yield* request('GET', `/api/attention/topic-enrollment?uri=${encodeURIComponent(uri)}`);
  expect(inspection?.status).toBe(200);
  expect(inspection?.body).toMatchObject({sourceKind: 'obsidian', project: 'notes', body});
  const preview = yield* request('POST', '/api/attention/topic-enrollment', {
    action: 'preview',
    uri,
    project: 'notes',
    input,
  });
  expect(preview?.status).toBe(200);
  const approval = preview?.body as {readonly expectedContentHash: string; readonly revision: string};
  const applied = yield* request('POST', '/api/attention/topic-enrollment', {
    action: 'apply',
    uri,
    project: 'notes',
    input,
    expectedContentHash: approval.expectedContentHash,
    revision: approval.revision,
    approved: true,
  });
  expect(applied?.status).toBe(200);
  const record = parseMemoryDocument(uri, yield* store.read(location, uri))!;
  expect(record.metadata.topicMaintenance).toMatchObject({version: 3, sourceKind: 'obsidian'});
  const currentText = 'Current note fact.\n\nKeep historical constraints.';
  yield* fs.writeFileString(notePath, currentText);
  yield* obsidianSourceWork.run(config, 'notes', {
    mode: 'automatic',
    requestId: 'manager-fixture-current',
    credentialEnvironment: {},
  });
  const caseId = topicMaintenanceCaseId(record);
  for (let tick = 0; tick < 12; tick += 1) {
    const status = yield* runContextMaintenance(config, {cwd: home, project: 'notes', maxRecords: 4});
    if (status.cases.some(item => item.caseId === caseId)) break;
  }
  const packet = yield* readContextMaintenancePacket(config, caseId);
  if (
    !('topicEvidence' in packet) ||
    packet.topicEvidence.version !== 2 ||
    packet.topicEvidence.outcome !== 'ready' ||
    !packet.topicEvidence.obsidian.current
  )
    throw new Error('Expected ready imported topic evidence.');
  const captureInput = {
    action: 'capture',
    project: 'notes',
    caseId,
    expectedContentHash: packet.expectedContentHash,
    observationRevision: packet.topicEvidence.observationRevision,
    inspectionDigest: packet.topicEvidence.obsidian.current.inspectionDigest,
    fragmentStart: 0,
    fragmentEnd: currentText.length,
    retentionDays: 30,
    approved: true,
  };
  return {
    fs,
    path,
    home,
    vault,
    notePath,
    config,
    uri,
    body,
    origin,
    store,
    location,
    request,
    record,
    input,
    currentText,
    caseId,
    packet,
    captureInput,
  };
});
