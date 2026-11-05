import {Array as EffectArray, Effect, Schema, String as EffectString} from 'effect';
import fc from 'fast-check';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {readNativeTaskView} from '../../src/workflow_automation/task.js';
import {NativeAuthoringPlanDocumentSchema} from '@threadnote/workflow-automations/authoring';
import {it as effectIt} from '@effect/vitest';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {describe, expect} from 'vitest';
import {runCommandEffect} from '@threadnote/platform/command';
import {runNativeTaskAction} from '../../src/workflow_automation/task_actions.js';
import {nativeFixture} from './native-automation-fixture.js';
import {object, run} from './native-cycle-lifecycle-fixture.js';

const compactFixture = Effect.gen(function* () {
  const f = yield* nativeFixture();
  yield* runCommandEffect('git', ['-C', f.repo, 'add', 'source.ts']);
  yield* runCommandEffect('git', [
    '-C',
    f.repo,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Fixture source',
  ]);
  yield* f.init();
  const indexer = yield* CodeGraphIndexer;
  expect((yield* indexer.index({cwd: f.repo, threadnoteHome: f.home})).snapshot.state).toBe('ready');
  return f;
});

describe('native compact approval packet', () => {
  effectIt.effect('presents current and desired behavior in prose without requiring architecture components', () =>
    Effect.gen(function* () {
      const f = yield* compactFixture;
      const result = object(
        yield* runNativeTaskAction(f.config, {
          command: 'compact-start',
          runId: 'native-run',
          callerCwd: f.repo,
          intent: {
            title: 'Refresh expired fixture data',
            currentBehavior: 'Expired fixture data is returned without a freshness check.',
            desiredChange: 'Expired fixture data is refreshed before it is returned.',
            affectedPaths: ['source.ts'],
            acceptanceCriterion: 'Expired fixture data is refreshed before return.',
            verification: 'Exercise expired fixture data and observe the refresh.',
            eligibilityRationale: 'One behavior and one inspected file are explicit, with no unresolved decision.',
            eligibility: {status: 'eligible'},
            review: {required: false, reason: 'Routine bounded fix.'},
          },
        }),
      );
      expect(result.status).toBe('awaiting-user-confirmation');
      const packet = object(result.packet);
      expect(packet.document).toMatchObject({
        current: {summary: 'Expired fixture data is returned without a freshness check.'},
        target: {summary: 'Expired fixture data is refreshed before it is returned.'},
      });
      const views = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({id: Schema.String})))(packet.views);
      expect(EffectArray.map(views, view => view.id)).not.toContain('current');
      expect(EffectArray.map(views, view => view.id)).not.toContain('target');
      const document = yield* Schema.decodeUnknownEffect(NativeAuthoringPlanDocumentSchema)(packet.document);
      const rendered = object(
        object(yield* f.call({...f.base('authoring'), command: 'render', document, detail: 'document'})).authoring,
      );
      const documents = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({id: Schema.String, markdown: Schema.String})),
      )(rendered.documents);
      const plan = EffectArray.findFirst(documents, item => item.id === 'plan');
      if (plan._tag === 'None') throw new Error('Expected the actual rendered compact plan.');
      expect(plan.value.markdown).toContain(document.objective);
      expect(plan.value.markdown).toContain(document.current.summary);
      expect(plan.value.markdown).toContain(document.target.summary);
      // Expanded and standard authored plans retain real architecture views and their required components.
      const architecture = {
        ...document,
        current: {...document.current, components: ['source.ts exports the fixture value.']},
        target: {...document.target, components: ['source.ts refreshes the fixture value before returning it.']},
      };
      if (!document.compactOrigin) throw new Error('Expected the native compact origin.');
      const expanded = {...architecture, compactOrigin: {...document.compactOrigin, expanded: true}};
      const {compactOrigin: _origin, ...standard} = architecture;
      for (const authored of [expanded, standard]) {
        const response = object(
          object(yield* f.call({...f.base('authoring'), command: 'render', document: authored, detail: 'document'}))
            .authoring,
        );
        const views = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({id: Schema.String, markdown: Schema.String})),
        )(response.documents);
        const current = EffectArray.findFirst(views, item => item.id === 'current');
        const target = EffectArray.findFirst(views, item => item.id === 'target');
        if (current._tag === 'None' || target._tag === 'None')
          throw new Error('Authored architecture views must remain available.');
        expect(current.value.markdown).toContain(authored.current.components[0]);
        expect(target.value.markdown).toContain(authored.target.components[0]);
      }
    }).pipe(run),
  );

  effectIt.effect('retains independently visible long Unicode prose and exact full structured content', () =>
    Effect.gen(function* () {
      const f = yield* compactFixture;
      const current = 'CURRENT_SIGNAL ' + EffectString.repeat(900)('界🙂') + ' CURRENT_END';
      const desired = 'DESIRED_SIGNAL ' + EffectString.repeat(450)('é🙂') + ' DESIRED_END';
      const result = object(
        yield* runNativeTaskAction(f.config, {
          command: 'compact-start',
          runId: 'native-run',
          callerCwd: f.repo,
          intent: {
            title: 'Preserve long authored behavior',
            currentBehavior: current,
            desiredChange: desired,
            affectedPaths: ['source.ts'],
            acceptanceCriterion: 'The new fixture behavior is visible.',
            verification: 'Read the fixture result.',
            eligibilityRationale: 'One bounded fixture export changes.',
            eligibility: {status: 'eligible'},
            review: {required: false, reason: 'Bounded fixture correction.'},
          },
        }),
      );
      const packet = object(result.packet);
      const document = yield* Schema.decodeUnknownEffect(NativeAuthoringPlanDocumentSchema)(packet.document);
      const response = object(
        object(yield* f.call({...f.base('authoring'), command: 'render', document, detail: 'document'})).authoring,
      );
      const documents = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({id: Schema.String, markdown: Schema.String})),
      )(response.documents);
      const plan = EffectArray.findFirst(documents, item => item.id === 'plan');
      if (plan._tag === 'None') throw new Error('Expected the rendered plan.');
      expect(plan.value.markdown).toContain('Current behavior: CURRENT_SIGNAL 界🙂');
      expect(plan.value.markdown).toContain('Desired change: DESIRED_SIGNAL é🙂');
      expect(plan.value.markdown).toContain('Objective: Implement the bounded change: DESIRED_SIGNAL');
      expect(plan.value.markdown).not.toContain('�');
      const summary = /## Summary\n\n([\s\S]*?)\n\n## Phases/u.exec(plan.value.markdown)?.[1];
      expect(summary).toBeDefined();
      expect(new TextEncoder().encode(summary).byteLength).toBeLessThanOrEqual(2000);
      const loaded = object(
        object(
          yield* f.call({...f.base('authoring'), command: 'load', uri: object(result.root).uri, detail: 'document'}),
        ).authoring,
      );
      const persisted = yield* Schema.decodeUnknownEffect(NativeAuthoringPlanDocumentSchema)(loaded.document);
      expect(persisted.current.summary).toBe(current);
      expect(persisted.target.summary).toBe(desired);
      expect(persisted.objective).toBe('Implement the bounded change: ' + desired);
      expect(persisted).toEqual(document);
      const beforeRead = yield* f.fs.readFileString(f.statePath());
      const detail = object(
        yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo, detail: 'packet'}),
      );
      expect(object(object(detail.authoring).packet).document).toEqual(persisted);
      expect(object(detail.authoring).data).toEqual(loaded.data);
      expect(object(detail.authoring).root).toEqual(loaded.root);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeRead);
    }).pipe(run),
  );

  fcEffectProp(
    effectIt,
    'bounds actual Unicode summaries while preserving a portion of every authored field',
    {
      unit: fc.constantFrom('é', '界', '🙂', 'é'),
      currentLength: fc.integer({min: 1100, max: 1500}),
      desiredLength: fc.integer({min: 600, max: 800}),
    },
    ({unit, currentLength, desiredLength}) =>
      Effect.gen(function* () {
        const f = yield* compactFixture;
        const current = 'CURRENT_SIGNAL ' + EffectString.repeat(currentLength)(unit);
        const desired = 'DESIRED_SIGNAL ' + EffectString.repeat(desiredLength)(unit);
        const result = object(
          yield* runNativeTaskAction(f.config, {
            command: 'compact-start',
            runId: 'native-run',
            callerCwd: f.repo,
            intent: {
              title: 'Unicode excerpt property',
              currentBehavior: current,
              desiredChange: desired,
              affectedPaths: ['source.ts'],
              acceptanceCriterion: 'The fixture changes as requested.',
              verification: 'Read the fixture.',
              eligibilityRationale: 'One bounded behavior in one inspected file.',
              eligibility: {status: 'eligible'},
              review: {required: false, reason: 'Bounded fixture correction.'},
            },
          }),
        );
        const document = yield* Schema.decodeUnknownEffect(NativeAuthoringPlanDocumentSchema)(
          object(result.packet).document,
        );
        const rendered = object(
          object(yield* f.call({...f.base('authoring'), command: 'render', document, detail: 'document'})).authoring,
        );
        const documents = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({id: Schema.String, markdown: Schema.String})),
        )(rendered.documents);
        const plan = EffectArray.findFirst(documents, item => item.id === 'plan');
        if (plan._tag === 'None') throw new Error('Expected the actual rendered plan.');
        const summary = /## Summary\n\n([\s\S]*?)\n\n## Phases/u.exec(plan.value.markdown)?.[1] ?? '';
        expect(summary).toContain('Objective: Implement the bounded change: DESIRED_SIGNAL ' + unit);
        expect(summary).toContain('Current behavior: CURRENT_SIGNAL ' + unit);
        expect(summary).toContain('Desired change: DESIRED_SIGNAL ' + unit);
        expect(summary).not.toContain('�');
        expect(new TextEncoder().encode(summary).byteLength).toBeLessThanOrEqual(2000);
        expect(document.current.summary).toBe(current);
        expect(document.target.summary).toBe(desired);
      }).pipe(run),
    {fastCheck: {numRuns: 8}, timeout: 90_000},
  );
});
