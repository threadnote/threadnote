import {Effect} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {nativeRequestSchema} from '../../src/workflow_automation/request_schema.js';
import {runWorkflowAutomation} from '../../src/workflow_automation/index.js';
import {provideNative} from './native-automation-fixture.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const base = {protocolVersion: 1, executorVersion: 1, action: 'request-schema'};
const topics = [
  'core',
  'init',
  'read',
  'authoring',
  'cycle',
  'watch',
  'closeout',
  'authoring-document',
  'cycle-plan',
  'cycle-validation',
  'cycle-review',
  'closeout-proposal',
] as const;

describe('native request schema discovery', () => {
  it.each(topics)('reassembles %s with bounded deterministic UTF-8 pages', topic => {
    fc.assert(
      fc.property(fc.integer({min: 4096, max: 16384}), maxBytes => {
        let offsetBytes = 0;
        let sourceDigest: string | undefined;
        let text = '';
        do {
          const response = nativeRequestSchema({
            ...base,
            topic,
            maxBytes,
            offsetBytes,
            ...(sourceDigest ? {sourceDigest} : {}),
          });
          expect(new TextEncoder().encode(JSON.stringify(response)).byteLength).toBeLessThanOrEqual(maxBytes);
          expect(response.runtimeValidationRequired).toBe(true);
          if (sourceDigest) expect(response.schemaPage.sourceDigest).toBe(sourceDigest);
          sourceDigest = response.schemaPage.sourceDigest;
          text += response.schemaPage.text;
          if (response.schemaPage.nextOffsetBytes === null) break;
          expect(response.schemaPage.nextOffsetBytes).toBeGreaterThan(offsetBytes);
          offsetBytes = response.schemaPage.nextOffsetBytes;
        } while (offsetBytes > 0);
        expect(JSON.parse(text)).toMatchObject({dialect: 'draft-2020-12', schema: expect.any(Object)});
        expect(text).toBe(JSON.stringify(JSON.parse(text)));
      }),
      {numRuns: 5},
    );
  });

  it('rejects malformed envelopes, excess fields and invalid continuations', () => {
    for (const extra of [
      {runId: 'unused'},
      {generation: 'unused'},
      {topic: 'unknown'},
      {executorVersion: 2},
      {offsetBytes: 1},
      {maxBytes: 16385},
      {command: 'invented'},
      {sourceDigest: Effect2.pipe('a', EffectString.repeat(64))},
    ])
      expect(() => nativeRequestSchema({...base, topic: 'init', ...extra})).toThrow();
    expect(() => nativeRequestSchema({...base, topic: 'cycle', command: 'invented'})).toThrow();
    expect(() => nativeRequestSchema({...base, topic: 'cycle-plan', kind: 'plan'})).toThrow();
    expect(() => nativeRequestSchema({...base, topic: 'authoring-document', command: 'schema'})).toThrow();
  });

  it.each(['spec', 'plan'] as const)('selects the actual %s document schema', kind => {
    const response = nativeRequestSchema({...base, topic: 'authoring-document', kind});
    expect(response.kind).toBe(kind);
    expect(response.schemaPage.totalBytes).toBeGreaterThan(0);
    let page = response.schemaPage;
    let text = page.text;
    while (page.nextOffsetBytes !== null) {
      page = nativeRequestSchema({
        ...base,
        topic: 'authoring-document',
        kind,
        offsetBytes: page.nextOffsetBytes,
        sourceDigest: page.sourceDigest,
      }).schemaPage;
      text += page.text;
    }
    expect(JSON.parse(text).schema.properties.kind.enum).toEqual([kind]);
    expect(JSON.parse(text).schema.anyOf).toBeUndefined();
    const schema = JSON.parse(text).schema;
    const rule = 'Canonical relative path';
    const pathRule = (field: Record<string, unknown>) =>
      Effect2.pipe(JSON.stringify(field), EffectString.includes(rule));
    expect(pathRule(schema.properties.context.properties.codeRefs.items)).toBe(true);
    expect(pathRule(schema.properties.source.anyOf[0].properties.files.items.properties.path)).toBe(true);
    if (kind === 'plan') {
      const phase = schema.properties.phases.items;
      expect(pathRule(phase.properties.affectedPaths.items)).toBe(true);
      expect(pathRule(phase.properties.newPaths.items)).toBe(true);
    }
  });

  it('narrows supported commands using their production literal decoder', () => {
    const response = nativeRequestSchema({...base, topic: 'watch', command: 'start'});
    expect(JSON.parse(response.schemaPage.text)).toMatchObject({
      schema: {
        properties: {command: {enum: ['start']}},
        additionalProperties: false,
      },
    });
  });

  it.each([
    ['init', {expectedRevision: expect.any(String)}],
    [
      'snapshot',
      {
        expectedRevision: expect.any(String),
        phaseId: expect.any(String),
        rebase: expect.any(String),
        snapshotId: expect.stringContaining('fresh immutable'),
        supersedeUnreviewed: expect.stringContaining('Only for a changed source tree'),
        baseRequalification: expect.stringContaining('Requires reason and explicit userAuthority.'),
        ordinaryMergeQualificationV1: expect.stringContaining(
          'Produces manifest version2; legacy readers must reject it.',
        ),
        sameLabelRebasedBaseIntegrationV1: expect.any(String),
        recoverUnreviewedRebase: expect.any(String),
      },
    ],
    [
      'validate-review',
      {
        expectedRevision: expect.any(String),
        snapshotId: expect.any(String),
        attemptId: expect.any(String),
        report: expect.any(String),
      },
    ],
    ['detail', {minimumMaxBytes: 8192}],
    ['inspect', {}],
    ['validate-plan', {}],
    ['schema', {minimumMaxBytes: 8192}],
  ])('reports bounded semantic prerequisites separately for cycle %s', (command, prerequisites) => {
    const response = nativeRequestSchema({...base, topic: 'cycle', command});
    expect(response).toMatchObject({schemaKind: 'decoding-envelope', runtimeValidationRequired: true});
    expect(response).toHaveProperty('semanticPrerequisites', prerequisites);
    const schema = JSON.parse(response.schemaPage.text).schema;
    expect(schema.required).toEqual(['protocolVersion', 'executorVersion', 'action', 'command', 'runId', 'generation']);
    if (command === 'snapshot') {
      expect(schema.properties.recoverUnreviewedRebase).toEqual({type: 'boolean'});
      expect(schema.properties.supersedeUnreviewed).toEqual({type: 'boolean'});
    }
  });

  it('discovers optional closed witnesses for initial rebases and later qualifications', () => {
    let page = nativeRequestSchema({...base, topic: 'cycle', command: 'snapshot'}).schemaPage;
    let text = page.text;
    while (page.nextOffsetBytes !== null) {
      page = nativeRequestSchema({
        ...base,
        topic: 'cycle',
        command: 'snapshot',
        offsetBytes: page.nextOffsetBytes,
        sourceDigest: page.sourceDigest,
      }).schemaPage;
      text += page.text;
    }
    const schema = JSON.parse(text).schema;
    expect(schema.properties.protocolVersion.enum).toEqual([1, 2, 3]);
    for (const [name, required] of [
      ['rebase', ['preRebaseHead', 'ontoHead', 'rebasedHead']],
      ['baseRequalification', ['preRebaseHead', 'ontoHead', 'rebasedHead', 'fromBaseBranch']],
      [
        'ordinaryMergeQualificationV1',
        ['priorHead', 'currentBaseHead', 'currentHead', 'fromBaseBranch', 'planDocumentHash', 'phaseOwnedPaths'],
      ],
      [
        'sameLabelRebasedBaseIntegrationV1',
        [
          'priorSnapshotId',
          'expectedPriorEntryDigest',
          'expectedPriorReviewDigest',
          'currentBaseHead',
          'currentHead',
          'sameBaseBranch',
          'authorityKind',
          'planDocumentHash',
          'phaseOwnedPaths',
        ],
      ],
    ] as const) {
      expect(schema.required).not.toContain(name);
      expect(schema.properties[name]).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: expect.arrayContaining([...required]),
      });
      expect(schema.properties[name].required).toHaveLength(required.length);
      if (name === 'sameLabelRebasedBaseIntegrationV1') {
        expect(Effect2.Record.keys(schema.properties[name].properties).sort()).toEqual([...required].sort());
        expect(schema.properties[name].properties.authorityKind.enum).toEqual([
          'same-label-upstream-rebase-integration',
        ]);
      }
    }
  });

  it('discovers mandatory review lanes and specialist guidance', () => {
    const response = nativeRequestSchema({...base, topic: 'cycle-review'});
    expect(response).toMatchObject({
      semanticPrerequisites: {
        requiredSelectedLanes: ['correctness', 'simplicity'],
        requiredCompletedLanes: ['correctness', 'simplicity'],
        specialistLanes: expect.any(String),
      },
    });
  });

  effectIt.effect('dispatches discovery without initialized run state', () =>
    Effect.gen(function* () {
      const response = yield* runWorkflowAutomation(
        {
          account: 'local',
          user: 'tester',
          agentId: 'test',
          agentContextHome: '/absent/discovery-home',
          manifestPath: '/absent/discovery-home/manifest.json',
        },
        {...base, topic: 'init'},
      );
      expect(response).toMatchObject({status: 'ok', action: 'request-schema', topic: 'init'});
    }).pipe(provideNative),
  );
});
