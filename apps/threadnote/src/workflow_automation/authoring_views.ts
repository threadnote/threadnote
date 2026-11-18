import {Array as EffectArray} from 'effect';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {isNativeMermaidDiagram, type NativeAuthoringDocument} from '@threadnote/workflow-automations/authoring';
import type {NativeDocumentEnvelope} from '@threadnote/workflow-automations/documents';
import {createNativeDocument} from '@threadnote/workflow-automations/templates';

const utf8 = new TextEncoder();
export const compact = (text: string, maximum = 400) => {
  const characters = [...text];
  return characters.length <= maximum
    ? text
    : EffectArray.join(characters.slice(0, maximum), '') + '… (complete content in linked structured data)';
};
const bullets = (items: readonly string[]) =>
  EffectArray.join(
    EffectArray.map(items, item => '- ' + item),
    '\n',
  );

/** Reuse the section's existing UTF-8-safe excerpt rule for independently visible prose. */
function boundedViewText(body: string, limit: number): string {
  const bytes = utf8.encode(body);
  if (bytes.byteLength <= limit) return body;
  let end = limit - 100;
  while ((bytes[end] & 0xc0) === 0x80) end--;
  return (
    new TextDecoder('utf-8', {fatal: true}).decode(bytes.slice(0, end)) +
    '\n\nComplete content is retained in the linked structured data.'
  );
}

/** Small semantic views link to the complete separately indexed structured data. */
function createViewDocument(input: Parameters<typeof createNativeDocument>[0]): NativeDocumentEnvelope {
  const sections = EffectRecord.fromEntries(
    EffectArray.map(EffectRecord.toEntries(input.sections), ([id, body]) => [
      id,
      boundedViewText(body, id === 'diagram' ? 10000 : 2000),
    ]),
  );
  return createNativeDocument({...input, sections});
}

export function documentViews(
  document: NativeAuthoringDocument,
): readonly {id: string; document: NativeDocumentEnvelope}[] {
  if (document.kind === 'spec')
    return [
      {
        id: 'spec',
        document: createViewDocument({
          kind: 'spec',
          title: document.title,
          sections: {
            summary: document.objective,
            problem: bullets(EffectArray.map(document.inScope, item => compact(item))),
            requirements: compact(
              bullets(EffectArray.map(document.requirements, item => item.id + ': ' + compact(item.behavior, 120))),
              3500,
            ),
            acceptance: compact(
              bullets(EffectArray.map(document.scenarios, item => item.id + ': ' + compact(item.then, 120))),
              3500,
            ),
            domain: compact(
              bullets(EffectArray.map(document.artifacts, item => item.title + ': ' + compact(item.summary))),
              1600,
            ),
            contracts: compact(bullets(document.constraints), 1600),
            questions: compact(
              bullets(EffectArray.map(document.questions, item => item.id + ': ' + item.question)),
              1600,
            ),
          },
        }),
      },
    ];
  const architecture = (kind: 'architecture-current' | 'architecture-target', value: typeof document.current) =>
    createViewDocument({
      kind,
      title:
        compact(document.title, 180) +
        ' — ' +
        (Effect2.pipe(kind, EffectString.endsWith('current')) ? 'Current architecture' : 'Target architecture'),
      sections: {
        summary: value.summary,
        components: compact(bullets(value.components), 3000),
        contracts: compact(bullets(value.contracts), 3000),
        diagram: isNativeMermaidDiagram(value.diagram) ? '```mermaid\n' + value.diagram + '\n```' : value.diagram,
      },
    });
  const compactDraft = document.compactOrigin !== undefined && !document.compactOrigin.expanded;
  return [
    {
      id: 'plan',
      document: createViewDocument({
        kind: 'plan',
        title: document.title,
        sections: {
          summary: compactDraft
            ? EffectArray.join(
                [
                  'Objective: ' + boundedViewText(document.objective, 600),
                  'Current behavior: ' + boundedViewText(document.current.summary, 600),
                  'Desired change: ' + boundedViewText(document.target.summary, 600),
                ],
                '\n\n',
              )
            : document.objective,
          phases: compact(
            bullets(EffectArray.map(document.phases, item => item.id + ': ' + compact(item.outcome, 120))),
            3500,
          ),
          validation: compact(
            bullets(
              EffectArray.flatMap(document.phases, item =>
                EffectArray.map(
                  item.acceptance,
                  acceptance => item.id + '/' + acceptance.id + ': ' + compact(acceptance.verification, 120),
                ),
              ),
            ),
            3500,
          ),
          decisions: document.decisions.length
            ? compact(
                bullets(EffectArray.map(document.decisions, item => item.id + ': ' + compact(item.selected, 120))),
                2000,
              )
            : document.compactOrigin
              ? 'Compact eligibility: ' + compact(document.compactOrigin.eligibilityRationale, 1800)
              : 'Design decision remains unresolved; this is a durable draft.',
        },
      }),
    },
    ...(compactDraft
      ? []
      : [
          {id: 'current', document: architecture('architecture-current', document.current)},
          {id: 'target', document: architecture('architecture-target', document.target)},
        ]),
    {
      id: 'decisions',
      document: createViewDocument({
        kind: 'decisions',
        title: compact(document.title, 180) + ' — Design decisions',
        sections: {
          decision: document.decisions.length
            ? compact(bullets(EffectArray.map(document.decisions, item => item.id + ': ' + item.selected)), 3000)
            : 'Pending orchestrator decision.',
          alternatives: document.decisions.length
            ? compact(
                bullets(
                  EffectArray.flatMap(document.decisions, item =>
                    item.alternatives.length
                      ? EffectArray.map(
                          item.alternatives,
                          alternative =>
                            item.id + '/' + alternative.id + ': ' + alternative.design + '; ' + alternative.tradeoffs,
                        )
                      : [item.id + ': No better alternative identified.'],
                  ),
                ),
                5000,
              )
            : 'Alternatives have not yet been judged.',
          rationale: document.decisions.length
            ? compact(bullets(EffectArray.map(document.decisions, item => item.id + ': ' + item.rationale)), 5000)
            : 'A ready plan requires the orchestrator’s justification.',
          consequences: compact(
            bullets(
              EffectArray.map(
                document.decisions,
                item => item.id + ': affects ' + EffectArray.join(item.affectedPhases, ', '),
              ),
            ),
            2000,
          ),
        },
      }),
    },
  ];
}

/** Project canonical authoring data into the same semantic view envelopes used by rendering and persistence. */
export function projectNativeAuthoringDocumentViews(
  document: NativeAuthoringDocument,
): readonly {id: string; document: NativeDocumentEnvelope}[] {
  return documentViews(document);
}
