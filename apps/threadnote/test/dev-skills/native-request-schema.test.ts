import {Effect} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {nativeRequestSchema} from '../../src/workflow_automation/request_schema.js';
import {runWorkflowAutomation} from '../../src/workflow_automation/index.js';
import {provideNative} from './native-automation-fixture.js';

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
      {sourceDigest: 'a'.repeat(64)},
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
