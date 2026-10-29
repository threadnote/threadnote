import {Array as EffectArray} from 'effect';
import {Effect} from 'effect';
import type {NativeCloseoutAdmission} from '@threadnote/workflow-automations/closeout';
import type {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {createNativeDocument} from '@threadnote/workflow-automations/templates';
import {encodeAuthoringDocument} from './authoring_artifacts.js';
import {nativeWorkflowError} from './memory.js';
import {stableJson} from '../workflow_memory/protocol.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export interface NativeCloseoutPlannedDocument {
  readonly key: string;
  readonly body: string;
  readonly uri: string;
  readonly relations: readonly {readonly type: 'references'; readonly uri: string}[];
}

/** Predict every final body before the caller performs any knowledge mutation. */
export const planNativeCloseoutDocuments = <E, R>(
  admission: NativeCloseoutAdmission,
  owned: readonly {uri: string; memoryId: string; revision: string; destination: string}[],
  preflight: (key: string, body: string) => Effect.Effect<{uri: string}, E, R>,
): Effect.Effect<readonly NativeCloseoutPlannedDocument[], E | WorkflowAutomationError, R> =>
  Effect.gen(function* () {
    const planned: NativeCloseoutPlannedDocument[] = [];
    const title = Effect2.pipe(
      admission.documents.architecture.title,
      EffectString.replace(/ — Implemented architecture$/u, ''),
    );
    const attempt = <A>(f: () => A) => Effect.try({try: f, catch: nativeWorkflowError});
    const add = (key: string, body: string, targets: readonly {uri: string}[] = []) =>
      Effect.gen(function* () {
        const predicted = yield* preflight(key, body);
        const item: NativeCloseoutPlannedDocument = Object.freeze({
          key,
          body,
          uri: predicted.uri,
          relations: Object.freeze(
            EffectArray.map(targets, target => Object.freeze({type: 'references' as const, uri: target.uri})),
          ),
        });
        planned.push(item);
        return item;
      });
    const decisions: NativeCloseoutPlannedDocument[] = [];
    for (let index = 0; index < admission.documents.decisions.length; index++)
      decisions.push(
        yield* add(
          'decision-' + index,
          yield* attempt(() => encodeAuthoringDocument(admission.documents.decisions[index])),
        ),
      );
    let nextIndex: NativeCloseoutPlannedDocument | undefined;
    for (let end = decisions.length; end > 0;) {
      const start = Math.max(0, end - 12);
      const links = [...decisions.slice(start, end), ...(nextIndex ? [nextIndex] : [])];
      const body = yield* attempt(() =>
        encodeAuthoringDocument(
          createNativeDocument({
            kind: 'index',
            title: title + ' — Verified decisions',
            sections: {
              summary: 'Complete original decisions and actual implementation rationale.',
              entries: EffectArray.join(
                EffectArray.map(links, item => '- ' + item.uri),
                '\n',
              ),
            },
          }),
        ),
      );
      nextIndex = yield* add('decisions-' + start, body, links);
      end = start;
    }
    const behaviorDocument = admission.documents.behavior;
    const behaviorBody = behaviorDocument ? yield* attempt(() => encodeAuthoringDocument(behaviorDocument)) : undefined;
    const behavior = behaviorBody === undefined ? undefined : yield* add('behavior', behaviorBody);
    const handoff = yield* add('handoff', yield* attempt(() => encodeAuthoringDocument(admission.documents.handoff)));
    const pages: string[][] = [];
    let page: string[] = [];
    let bytes = 0;
    for (const item of owned) {
      const entry = stableJson({
        source: item.uri,
        memoryId: item.memoryId,
        revision: item.revision,
        archive: item.destination,
      });
      const size = new TextEncoder().encode(entry).byteLength;
      if (page.length && bytes + size > 18_000) {
        pages.push(page);
        page = [];
        bytes = 0;
      }
      page.push(entry);
      bytes += size;
    }
    if (page.length) pages.push(page);
    let history: NativeCloseoutPlannedDocument | undefined;
    for (let index = pages.length - 1; index >= 0; index--) {
      const next = history;
      const body = yield* attempt(() =>
        encodeAuthoringDocument(
          createNativeDocument({
            kind: 'history',
            title: title + ' — Retirement history',
            sections: {
              summary:
                'Exact owned draft identities and admitted archive destinations. Completion is recorded in the native closeout receipt.',
              entries: EffectArray.join(pages[index], '\n') + (next ? '\n\nNext: ' + next.uri : ''),
            },
          }),
        ),
      );
      history = yield* add('history-' + index, body, next ? [next] : []);
    }
    const links = [
      ...(nextIndex ? [nextIndex] : []),
      ...(history ? [history] : []),
      ...(behavior ? [behavior] : []),
      handoff,
    ];
    const body = yield* attempt(() =>
      encodeAuthoringDocument(
        createNativeDocument({
          kind: 'architecture-current',
          title: admission.documents.architecture.title,
          sections: {
            ...EffectRecord.fromEntries(
              EffectArray.map(admission.documents.architecture.sections, section => [section.id, section.body]),
            ),
            references: EffectArray.join(
              EffectArray.map(links, item => '- [Knowledge](' + item.uri + ')'),
              '\n',
            ),
          },
        }),
      ),
    );
    const architecture = yield* add('architecture', body, links);
    if (behaviorBody !== undefined) yield* add('behavior', behaviorBody, [architecture]);
    return Object.freeze(planned);
  });
