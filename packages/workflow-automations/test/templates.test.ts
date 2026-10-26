import {describe, expect, it} from 'vitest';
import {outlineNativeDocument, renderNativeDocument, type NativeDocumentKind} from '../src/documents.js';
import {
  createNativeDocument,
  nativeDocumentTemplateDefinitions,
  nativeDocumentTemplateVersion,
  type NativeDocumentTemplateDefinition,
} from '../src/templates.js';

const caught = (run: () => unknown): unknown => {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
};

const requiredBody = (kind: NativeDocumentKind, id: string) => `${kind} ${id} content — 日本語 🧭`;

describe('native authoring templates', () => {
  it('keeps the section IDs and Markdown headings stable for every template kind', () => {
    const expected: Record<NativeDocumentKind, readonly string[]> = {
      spec: [
        'summary:Summary',
        'problem:Problem',
        'requirements:Requirements',
        'acceptance:Acceptance Criteria',
        'domain:Domain',
        'contracts:Contracts',
        'questions:Open Questions',
      ],
      plan: [
        'summary:Summary',
        'phases:Phases',
        'validation:Validation',
        'decisions:Decisions',
        'references:References',
      ],
      'architecture-current': [
        'summary:Summary',
        'components:Components',
        'data-flow:Data Flow',
        'contracts:Contracts',
        'constraints:Constraints',
        'diagram:Diagram',
        'references:References',
      ],
      'architecture-target': [
        'summary:Summary',
        'components:Components',
        'data-flow:Data Flow',
        'contracts:Contracts',
        'constraints:Constraints',
        'diagram:Diagram',
      ],
      decisions: ['decision:Decision', 'alternatives:Alternatives', 'rationale:Rationale', 'consequences:Consequences'],
      alternatives: [
        'decision:Decision',
        'alternatives:Alternatives',
        'rationale:Rationale',
        'consequences:Consequences',
      ],
      phase: [
        'outcome:Outcome',
        'scope:Scope',
        'contracts:Contracts',
        'acceptance:Acceptance Criteria',
        'dependencies:Dependencies',
        'verification:Verification',
      ],
      handoff: [
        'task:Task',
        'decisions:Decisions',
        'verification:Verification',
        'blockers:Blockers',
        'next-step:Next Step',
      ],
      source: ['summary:Summary', 'snapshot:Source Snapshot', 'content:Source Content'],
      history: ['summary:Summary', 'entries:History Entries'],
      index: ['summary:Summary', 'entries:Index Entries'],
      experience: ['summary:Summary', 'evidence:Evidence', 'prevention:Prevention'],
    };
    const required: Record<NativeDocumentKind, readonly string[]> = {
      spec: ['summary', 'requirements', 'acceptance'],
      plan: ['summary', 'phases', 'validation', 'decisions'],
      'architecture-current': ['summary', 'components'],
      'architecture-target': ['summary', 'components'],
      decisions: ['decision', 'alternatives', 'rationale'],
      alternatives: ['decision', 'alternatives', 'rationale'],
      phase: ['outcome', 'acceptance'],
      handoff: ['task', 'next-step'],
      source: ['summary', 'content'],
      history: ['summary', 'entries'],
      index: ['summary', 'entries'],
      experience: ['summary', 'evidence'],
    };
    for (const kind of Object.keys(expected) as NativeDocumentKind[]) {
      const definition: NativeDocumentTemplateDefinition = nativeDocumentTemplateDefinitions[kind];
      expect(definition.sections.map(section => `${section.id}:${section.heading}`)).toEqual(expected[kind]);
      expect(definition.sections.filter(section => section.required === true).map(section => section.id)).toEqual(
        required[kind],
      );
    }
  });

  it('defines stable descriptive sections and builds every supported document kind', () => {
    expect(nativeDocumentTemplateVersion).toBe(1);
    for (const kind of Object.keys(nativeDocumentTemplateDefinitions) as NativeDocumentKind[]) {
      const definition: NativeDocumentTemplateDefinition = nativeDocumentTemplateDefinitions[kind];
      const supplied: Record<string, string> = {};
      for (const section of definition.sections) {
        supplied[section.id] = section.required ? requiredBody(kind, section.id) : '   ';
      }
      const document = createNativeDocument({kind, title: `Native ${kind}`, sections: supplied});
      expect(document).toMatchObject({schemaVersion: 1, templateVersion: 1, kind, title: `Native ${kind}`});
      expect(document.sections.map(section => section.id)).toEqual(
        definition.sections.filter(section => section.required).map(section => section.id),
      );
      expect(document.sections.map(section => section.heading)).toEqual(
        definition.sections.filter(section => section.required).map(section => section.heading),
      );
      expect(renderNativeDocument(document)).toContain(`# Native ${kind}\n`);
      expect(outlineNativeDocument(document).sections.map(section => section.id)).toEqual(
        document.sections.map(section => section.id),
      );
    }
  });

  it('preserves meaningful optional sections and omits only blank optional sections', () => {
    const document = createNativeDocument({
      kind: 'spec',
      title: 'Document spec',
      sections: {
        summary: 'A bounded summary.',
        requirements: 'R1: keep behavior explicit.',
        acceptance: 'Given a source, page it without splitting UTF-8.',
        problem: 'An actual problem statement.',
        domain: '   ',
      },
    });
    expect(document.sections.map(section => section.id)).toEqual(['summary', 'problem', 'requirements', 'acceptance']);
    expect(document.sections[1]?.body).toBe('An actual problem statement.');
  });

  it('rejects missing required content, unknown sections, malformed values, and invalid kinds', () => {
    for (const input of [
      {kind: 'spec', title: 'Spec', sections: {summary: 'Summary', acceptance: 'Acceptance'}},
      {
        kind: 'plan',
        title: 'Plan',
        sections: {summary: 'Summary', phases: 'Phases', validation: 'Validation', decisions: '   '},
      },
      {
        kind: 'handoff',
        title: 'Handoff',
        sections: {task: 'Task', 'next-step': 'Next', surprise: 'Unknown'},
      },
      {kind: 'prototype', title: 'Bad', sections: {summary: 'Summary'}},
      {kind: 'source', title: 'Source', sections: {summary: 'Summary', content: 4}},
      {kind: '__proto__', title: 'Unsafe', sections: {summary: 'Summary'}},
    ])
      expect(caught(() => createNativeDocument(input as never))).toMatchObject({code: 'invalid-document'});

    expect(
      caught(() =>
        createNativeDocument({kind: 'phase', title: 'Bad\nHeading', sections: {outcome: 'Done', acceptance: 'Pass'}}),
      ),
    ).toMatchObject({code: 'invalid-document'});
  });
});
