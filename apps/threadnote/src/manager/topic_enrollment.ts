import {Effect, Result} from 'effect';
import {consolidationSections} from '@threadnote/memory/consolidation';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  applyTopicEnrollment,
  inspectTopicEnrollment,
  previewTopicEnrollment,
} from '../memory/maintenance/topic_enrollment.js';

const HASH = /^[a-f0-9]{64}$/u;
const privateTopicUri = (value: string) =>
  /^threadnote:\/\/user\/[^/]+\/memories\/durable\/projects\//u.test(value) && !value.includes('/shared/');
const unavailable = () => ({
  status: 409,
  body: {error: 'This private note memory is unavailable for topic updates. Refresh the memory and source access.'},
});
const invalid = () => ({
  status: 400,
  body: {error: 'Review the exact memory and paragraph decisions before continuing.'},
});

/** Imported enrollment uses the common, revision-bound enrollment writer. */
export const handleManagerTopicEnrollment = Effect.fn('managerTopicEnrollment.handle')(function* (request: {
  readonly config: RuntimeConfig;
  readonly method: string;
  readonly url: URL;
  readonly body: Effect.Effect<Record<string, unknown>, unknown>;
}) {
  if (request.url.pathname !== '/api/attention/topic-enrollment') return undefined;
  if (request.method !== 'GET' && request.method !== 'POST') return undefined;
  const body = request.method === 'POST' ? yield* request.body : undefined;
  const uri = body?.uri ?? request.url.searchParams.get('uri');
  if (typeof uri !== 'string' || !privateTopicUri(uri) || uri.length > 4096) return invalid();
  if (request.method === 'GET' && [...request.url.searchParams.keys()].some(key => key !== 'uri')) return invalid();
  const inspected = yield* inspectTopicEnrollment(request.config, uri).pipe(Effect.result);
  if (
    Result.isFailure(inspected) ||
    inspected.success.status === 'conflict' ||
    !('sourceKind' in inspected.success) ||
    inspected.success.sourceKind !== 'obsidian'
  )
    return unavailable();
  const inspection = inspected.success;
  if (
    !privateTopicUri(inspection.targetUri) ||
    typeof inspection.project !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(inspection.project)
  )
    return unavailable();
  if (request.method === 'GET') {
    return {
      status: 200,
      body: {
        status: inspection.status,
        sourceKind: 'obsidian' as const,
        targetUri: inspection.targetUri,
        project: inspection.project,
        contentHash: inspection.contentHash,
        body: inspection.body,
        paragraphs: consolidationSections(inspection.body),
        citation: {id: inspection.originCitationId, relativePath: inspection.originEvidence.relativePath},
      },
    };
  }
  if (!body || body.project !== inspection.project || !['preview', 'apply'].includes(body.action as string))
    return invalid();
  const allowed = [
    'action',
    'uri',
    'project',
    'input',
    ...(body.action === 'apply' ? ['approved', 'expectedContentHash', 'revision'] : []),
  ];
  if (
    Object.keys(body).some(key => !allowed.includes(key)) ||
    new TextEncoder().encode(JSON.stringify(body)).byteLength > 36 * 1024
  )
    return invalid();
  if (
    body.action === 'apply' &&
    (body.approved !== true ||
      typeof body.expectedContentHash !== 'string' ||
      !HASH.test(body.expectedContentHash) ||
      typeof body.revision !== 'string' ||
      !HASH.test(body.revision))
  )
    return invalid();
  const options = {uri: inspection.targetUri, project: inspection.project, input: body.input};
  if (body.action === 'preview') {
    const result = yield* previewTopicEnrollment(request.config, options).pipe(Effect.result);
    if (Result.isFailure(result) || result.success.status !== 'preview') return unavailable();
    return {
      status: 200,
      body: {
        status: 'preview' as const,
        targetUri: result.success.proposal.targetUri,
        body: result.success.body,
        expectedContentHash: result.success.proposal.expectedContentHash,
        revision: result.success.proposal.revision,
      },
    };
  }
  const result = yield* applyTopicEnrollment(request.config, {
    ...options,
    approved: true,
    expectedContentHash: body.expectedContentHash as string,
    revision: body.revision as string,
  }).pipe(Effect.result);
  if (
    Result.isFailure(result) ||
    (result.success.status !== 'enrolled' && result.success.status !== 'already-enrolled')
  )
    return unavailable();
  return {status: 200, body: {status: result.success.status, targetUri: result.success.targetUri}};
});
