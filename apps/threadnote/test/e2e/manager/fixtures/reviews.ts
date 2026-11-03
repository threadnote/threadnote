import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {DEFAULT_INHERITED_ENV_VARS, StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createRepository, indexRepository} from './repositories.js';
import {canonicalMemoryDocumentContent} from '@threadnote/memory/document';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  type AutomaticMaintenanceDraftV2,
  validateAutomaticMaintenanceDraftBasis,
} from '@threadnote/memory/topic-maintenance-draft';
import {candidateBinary} from './environment.js';
import type {ManagerRuntime} from './runtime.js';
import {Array as EffectArray, Record as EffectRecord} from 'effect';
import {isJsonObject} from '@threadnote/platform/json';

/** Use the shipped MCP write boundary against only this test's disposable account. */
export async function fixtureTool(
  manager: Pick<ManagerRuntime, 'environment' | 'home' | 'root'>,
  name: string,
  args: Record<string, unknown>,
) {
  const env: Record<string, string> = EffectRecord.fromEntries(
    EffectArray.map(DEFAULT_INHERITED_ENV_VARS, key => [key, '']),
  );
  for (const [key, value] of EffectRecord.toEntries(manager.environment)) if (value !== undefined) env[key] = value;
  env.THREADNOTE_MCP_TOOLSET = 'full';
  const transport = new StdioClientTransport({
    command: candidateBinary,
    args: ['--home', manager.home, 'mcp-server'],
    cwd: manager.root,
    env,
    stderr: 'pipe',
  });
  const stderrLimit = 65_536;
  let stderrBytes = 0;
  // Drain before connecting: an unread SDK PassThrough can backpressure the child.
  // Retain only a capped byte count, never stderr contents or request arguments.
  transport.stderr?.on('data', (chunk: Uint8Array) => {
    stderrBytes = Math.min(stderrLimit, stderrBytes + chunk.byteLength);
  });
  const tool = EffectArray.contains(
    [
      'review_session_context',
      'context_topic_enrollment',
      'context_maintain',
      'context_maintenance_status',
      'context_maintenance_packet',
      'context_maintenance_draft',
      'context_maintenance_review',
    ],
    name,
  )
    ? name
    : 'other-fixture-tool';
  const action =
    typeof args.action === 'string' &&
    EffectArray.contains(['inspect', 'preview', 'enroll', 'resume', 'run', 'pause'], args.action)
      ? args.action
      : 'none';
  const client = new Client({name: 'manager-e2e', version: '1.0.0'});
  let phase: 'connect' | 'tools-call' = 'connect';
  const started = performance.now();
  try {
    await client.connect(transport);
    phase = 'tools-call';
    const result = await client.callTool({name, arguments: args});
    if (result.isError) throw new Error('Fixture MCP returned an error result.');
    return result;
  } catch (cause) {
    throw new Error(
      `Fixture MCP boundary failed: ${JSON.stringify({
        tool,
        action,
        phase,
        elapsedMs: Math.max(0, Math.round(performance.now() - started)),
        stderrBytesUpToLimit: stderrBytes,
        stderrLimit,
        stderrDiscarded: true,
      })}`,
      {cause},
    );
  } finally {
    await client.close();
    await transport.close();
  }
}

export async function proposeMemory(
  manager: ManagerRuntime,
  topic: string,
  decision = 'Keep the fixture approval explicit.',
) {
  const result = await fixtureTool(manager, 'review_session_context', {
    task: `Review ${topic}`,
    outcome: 'Synthetic E2E proposal, never automatically applied.',
    project: 'manager-e2e',
    topic,
    decisions: [decision],
    rationale: 'Preserve a reviewable approval boundary.',
    constraints: ['Disposable test state only.'],
    verificationPerformed: ['Synthetic fixture evidence checked.'],
    knowledgeInvalidated: ['No previous contract invalidated.'],
    unresolvedRisks: ['No live provider evidence.'],
    sourceSessionId: `manager-e2e-${topic}`,
  });
  const data = result.structuredContent;
  const candidate = isJsonObject(data) && EffectArray.isArray(data.candidates) ? data.candidates[0] : undefined;
  if (
    !isJsonObject(data) ||
    typeof data.reviewId !== 'string' ||
    typeof data.revision !== 'number' ||
    !isJsonObject(candidate) ||
    typeof candidate.candidateId !== 'string'
  )
    throw new Error('Fixture review did not return an exact candidate identity.');
  return {reviewId: data.reviewId, revision: data.revision, candidateId: candidate.candidateId};
}

export async function prepareAutomaticReview(manager: ManagerRuntime) {
  const repository = await createRepository(manager);
  await indexRepository(manager, repository);
  const source = await manager.remember('The timeout is 60 seconds.', 'z-source', 'alpha', 'durable');
  const output = await manager.cli([
    'remember',
    '--kind',
    'durable',
    '--project',
    'alpha',
    '--topic',
    'a-target',
    '--relation',
    `references=${source}`,
    '--text',
    'The timeout is 30 seconds.',
  ]);
  const uri = /Stored memory: (threadnote:\/\/\S+)/u.exec(output)?.[1];
  if (!uri) throw new Error('Automatic target receipt missing.');
  const content = (await manager.api(`/api/memory?uri=${encodeURIComponent(uri)}`)).content;
  if (typeof content !== 'string') throw new Error('Canonical target content missing.');
  const expectedContentHash = sha256HexSync(canonicalMemoryDocumentContent(content));
  await fixtureTool(manager, 'context_maintain', {action: 'resume', callerCwd: repository.root, project: 'alpha'});
  for (let turn = 0; turn < 2; turn++)
    await fixtureTool(manager, 'context_maintain', {
      action: 'run',
      callerCwd: repository.root,
      project: 'alpha',
      maxRecords: 16,
    });
  const request = {action: 'automatic-preview', uri, expectedContentHash, sourceCwd: repository.root};
  const result = (await fixtureTool(manager, 'context_maintenance_review', request)).structuredContent;
  if (!isJsonObject(result) || !EffectArray.isArray(result.reviewEvidence))
    throw new Error('Automatic evidence packet missing.');
  const basis = validateAutomaticMaintenanceDraftBasis(result.basis);
  const evidence = result.reviewEvidence[0];
  if (
    !isJsonObject(evidence) ||
    !isJsonObject(evidence.descriptor) ||
    typeof evidence.descriptor.id !== 'string' ||
    typeof evidence.handleId !== 'string' ||
    evidence.content !== 'The timeout is 60 seconds.'
  )
    throw new Error('Exact related-memory evidence missing.');
  const draft: AutomaticMaintenanceDraftV2 = {
    version: 2,
    kind: 'automatic',
    purpose: 'automatic',
    targetHash: basis.targetHash,
    observationRevision: basis.observationRevision,
    packetDigest: basis.packetDigest,
    outcome: 'propose-update',
    paragraphDecisions: [
      {
        ordinal: 0,
        beforeHash: basis.paragraphs[0].hash,
        role: 'descriptive',
        support: 'direct',
        evidenceIds: [evidence.descriptor.id],
      },
    ],
    operations: [
      {
        ordinal: 0,
        beforeHash: basis.paragraphs[0].hash,
        supportHandles: [evidence.handleId],
        rationale: 'Use the exact current related paragraph.',
        text: evidence.content,
      },
    ],
    reviewedHandles: EffectArray.map(result.reviewEvidence, item => {
      if (!isJsonObject(item) || typeof item.handleId !== 'string') throw new Error('Invalid evidence handle.');
      return item.handleId;
    }),
    rationale: 'Synthetic source-bound review.',
    unresolvedQuestions: [],
    removedClaims: [],
  };
  return {uri, source, repository, basis, draft, request, before: content};
}

export async function createAutomaticReview(manager: ManagerRuntime) {
  const prepared = await prepareAutomaticReview(manager);
  const reviewed = (
    await fixtureTool(manager, 'context_maintenance_review', {
      ...prepared.request,
      draftJson: JSON.stringify(prepared.draft),
    })
  ).structuredContent;
  if (!isJsonObject(reviewed) || typeof reviewed.reviewId !== 'string')
    throw new Error('Automatic review receipt missing.');
  await manager.api('/api/attention/context-maintenance?view=controls', {action: 'pause'});
  return {...prepared, reviewId: reviewed.reviewId};
}
