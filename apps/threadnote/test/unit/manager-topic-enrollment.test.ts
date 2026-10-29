import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {beforeEach, expect, vi} from 'vitest';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {handleManagerAttentionAction} from '../../src/manager/attention_actions.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const mocks = vi.hoisted(() => ({inspect: vi.fn(), preview: vi.fn(), apply: vi.fn()}));
vi.mock('../../src/memory/maintenance/topic_enrollment.js', () => ({
  inspectTopicEnrollment: mocks.inspect,
  previewTopicEnrollment: mocks.preview,
  applyTopicEnrollment: mocks.apply,
}));
const hash = Effect2.pipe('a', EffectString.repeat(64));
const uri = 'threadnote://user/tester/memories/durable/projects/notes/decision.md';
const config = {
  agentContextHome: '/private',
  manifestPath: '/manifest',
  user: 'tester',
  account: 'local',
  agentId: 'threadnote',
} as RuntimeConfig;
const input = {paragraphs: [{role: 'descriptive', support: 'direct', citationIds: ['tnob_test']}]};
const inspection = {
  status: 'not-enrolled',
  sourceKind: 'obsidian',
  targetUri: uri,
  project: 'notes',
  contentHash: hash,
  body: 'First claim.\n\nSecond claim.',
  originCitationId: 'tnob_test',
  originEvidence: {relativePath: 'Decision.md', pinId: 'PRIVATE_PIN'},
  citations: [],
};
const call = (method: string, body: Record<string, unknown> = {}) =>
  handleManagerAttentionAction({
    config,
    method,
    url: new URL(
      `http://manager.test/api/attention/topic-enrollment${method === 'GET' ? `?uri=${encodeURIComponent(uri)}` : ''}`,
    ),
    body: Effect.succeed(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.inspect.mockReturnValue(Effect.succeed(inspection));
  mocks.preview.mockReturnValue(
    Effect.succeed({
      status: 'preview',
      proposal: {targetUri: uri, expectedContentHash: hash, revision: hash, manifest: {private: 'INTERNAL'}},
      body: 'First claim.\n\nSecond claim.',
    }),
  );
  mocks.apply.mockReturnValue(Effect.succeed({status: 'enrolled', targetUri: uri}));
});
effectIt.effect('retains spaced project identity through imported enrollment inspection and preview', () =>
  Effect.gen(function* () {
    const project = 'Example Project';
    mocks.inspect.mockReturnValue(Effect.succeed({...inspection, project}));
    expect(yield* call('GET')).toMatchObject({status: 200, body: {project}});
    expect((yield* call('POST', {action: 'preview', uri, project, input}))?.status).toBe(200);
    expect(mocks.preview).toHaveBeenCalledWith(config, {uri, project, input});
    expect((yield* call('POST', {action: 'preview', uri, project: 'Example-Project', input}))?.status).toBe(400);
  }).pipe(provideTestLayer(ApplicationLayer)),
);

effectIt.effect('projects checked imported enrollment annotations and sends exact approval to the common writer', () =>
  Effect.gen(function* () {
    const inspected = yield* call('GET');
    expect(inspected?.status).toBe(200);
    expect(inspected?.body).toMatchObject({
      sourceKind: 'obsidian',
      paragraphs: ['First claim.', 'Second claim.'],
      citation: {id: 'tnob_test', relativePath: 'Decision.md'},
    });
    expect(JSON.stringify(inspected?.body)).not.toContain('PRIVATE_PIN');
    const preview = yield* call('POST', {action: 'preview', uri, project: 'notes', input});
    expect(preview?.status).toBe(200);
    expect(mocks.preview).toHaveBeenCalledWith(config, {uri, project: 'notes', input});
    expect(JSON.stringify(preview?.body)).not.toContain('INTERNAL');
    expect(
      (yield* call('POST', {
        action: 'apply',
        uri,
        project: 'notes',
        input,
        expectedContentHash: hash,
        revision: hash,
        approved: true,
      }))?.status,
    ).toBe(200);
    expect(mocks.apply).toHaveBeenCalledWith(config, {
      uri,
      project: 'notes',
      input,
      expectedContentHash: hash,
      revision: hash,
      approved: true,
    });
  }).pipe(provideTestLayer(ApplicationLayer)),
);
effectIt.effect('withholds enrollment text on revoked access and rejects checkout injection or unapproved writes', () =>
  Effect.gen(function* () {
    expect(
      (yield* call('POST', {
        action: 'apply',
        uri,
        project: 'notes',
        input,
        expectedContentHash: hash,
        revision: hash,
        approved: false,
      }))?.status,
    ).toBe(400);
    expect(
      (yield* call('POST', {action: 'preview', uri, project: 'notes', input, callerCwd: '/foreign'}))?.status,
    ).toBe(400);
    mocks.inspect.mockReturnValue(
      Effect.succeed({status: 'conflict', code: 'source-revoked', message: 'PRIVATE_SOURCE'}),
    );
    const unavailable = yield* call('GET');
    expect(unavailable?.status).toBe(409);
    expect(JSON.stringify(unavailable?.body)).not.toMatch(/PRIVATE_|First claim|Second claim/u);
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  }).pipe(provideTestLayer(ApplicationLayer)),
);
