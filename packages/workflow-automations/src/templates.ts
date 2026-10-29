import {Array as EffectArray, Option as EffectOption} from 'effect';
import {decodeNativeDocument, type NativeDocumentEnvelope, type NativeDocumentKind} from './documents.js';
import {WorkflowAutomationError} from './contracts.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const nativeDocumentTemplateVersion = 1 as const;

export interface NativeDocumentSectionTemplate {
  readonly id: string;
  readonly heading: string;
  readonly required?: true;
}

export interface NativeDocumentTemplateDefinition {
  readonly version: typeof nativeDocumentTemplateVersion;
  readonly sections: readonly NativeDocumentSectionTemplate[];
}

type DocumentKinds = NativeDocumentKind;

export const nativeDocumentTemplateDefinitions = {
  spec: {
    version: nativeDocumentTemplateVersion,
    sections: [
      {id: 'summary', heading: 'Summary', required: true},
      {id: 'problem', heading: 'Problem'},
      {id: 'requirements', heading: 'Requirements', required: true},
      {id: 'acceptance', heading: 'Acceptance Criteria', required: true},
      {id: 'domain', heading: 'Domain'},
      {id: 'contracts', heading: 'Contracts'},
      {id: 'questions', heading: 'Open Questions'},
    ],
  },
  plan: {
    version: nativeDocumentTemplateVersion,
    sections: [
      {id: 'summary', heading: 'Summary', required: true},
      {id: 'phases', heading: 'Phases', required: true},
      {id: 'validation', heading: 'Validation', required: true},
      {id: 'decisions', heading: 'Decisions', required: true},
      {id: 'references', heading: 'References'},
    ],
  },
  'architecture-current': {
    version: nativeDocumentTemplateVersion,
    sections: [
      {id: 'summary', heading: 'Summary', required: true},
      {id: 'components', heading: 'Components', required: true},
      {id: 'data-flow', heading: 'Data Flow'},
      {id: 'contracts', heading: 'Contracts'},
      {id: 'constraints', heading: 'Constraints'},
      {id: 'diagram', heading: 'Diagram'},
      {id: 'references', heading: 'References'},
    ],
  },
  'architecture-target': {
    version: nativeDocumentTemplateVersion,
    sections: [
      {id: 'summary', heading: 'Summary', required: true},
      {id: 'components', heading: 'Components', required: true},
      {id: 'data-flow', heading: 'Data Flow'},
      {id: 'contracts', heading: 'Contracts'},
      {id: 'constraints', heading: 'Constraints'},
      {id: 'diagram', heading: 'Diagram'},
    ],
  },
  decisions: {
    version: nativeDocumentTemplateVersion,
    sections: [
      {id: 'decision', heading: 'Decision', required: true},
      {id: 'alternatives', heading: 'Alternatives', required: true},
      {id: 'rationale', heading: 'Rationale', required: true},
      {id: 'consequences', heading: 'Consequences'},
    ],
  },
  alternatives: {
    version: nativeDocumentTemplateVersion,
    sections: [
      {id: 'decision', heading: 'Decision', required: true},
      {id: 'alternatives', heading: 'Alternatives', required: true},
      {id: 'rationale', heading: 'Rationale', required: true},
      {id: 'consequences', heading: 'Consequences'},
    ],
  },
  phase: {
    version: nativeDocumentTemplateVersion,
    sections: [
      {id: 'outcome', heading: 'Outcome', required: true},
      {id: 'scope', heading: 'Scope'},
      {id: 'contracts', heading: 'Contracts'},
      {id: 'acceptance', heading: 'Acceptance Criteria', required: true},
      {id: 'dependencies', heading: 'Dependencies'},
      {id: 'verification', heading: 'Verification'},
    ],
  },
  handoff: {
    version: nativeDocumentTemplateVersion,
    sections: [
      {id: 'task', heading: 'Task', required: true},
      {id: 'decisions', heading: 'Decisions'},
      {id: 'verification', heading: 'Verification'},
      {id: 'blockers', heading: 'Blockers'},
      {id: 'next-step', heading: 'Next Step', required: true},
    ],
  },
  source: {
    version: nativeDocumentTemplateVersion,
    sections: [
      {id: 'summary', heading: 'Summary', required: true},
      {id: 'snapshot', heading: 'Source Snapshot'},
      {id: 'content', heading: 'Source Content', required: true},
    ],
  },
  history: {
    version: nativeDocumentTemplateVersion,
    sections: [
      {id: 'summary', heading: 'Summary', required: true},
      {id: 'entries', heading: 'History Entries', required: true},
    ],
  },
  index: {
    version: nativeDocumentTemplateVersion,
    sections: [
      {id: 'summary', heading: 'Summary', required: true},
      {id: 'entries', heading: 'Index Entries', required: true},
    ],
  },
  experience: {
    version: nativeDocumentTemplateVersion,
    sections: [
      {id: 'summary', heading: 'Summary', required: true},
      {id: 'evidence', heading: 'Evidence', required: true},
      {id: 'prevention', heading: 'Prevention'},
    ],
  },
} as const satisfies Record<DocumentKinds, NativeDocumentTemplateDefinition>;

export interface CreateNativeDocumentInput {
  readonly kind: NativeDocumentKind;
  readonly title: string;
  readonly sections: Readonly<Record<string, string>>;
}

/** Create a compact versioned document, omitting blank optional sections. */
export function createNativeDocument(input: CreateNativeDocumentInput): NativeDocumentEnvelope {
  if (
    typeof input !== 'object' ||
    input === null ||
    typeof input.sections !== 'object' ||
    input.sections === null ||
    EffectArray.isArray(input.sections)
  )
    throw invalidTemplate('A native document requires a kind, title, and section map.');
  const kind =
    typeof input.kind === 'string'
      ? EffectOption.getOrUndefined(
          EffectArray.findFirst(
            EffectRecord.keys(nativeDocumentTemplateDefinitions),
            (candidate): candidate is NativeDocumentKind => candidate === input.kind,
          ),
        )
      : undefined;
  if (!kind) throw invalidTemplate('The requested native document kind has no template.');
  const definition: NativeDocumentTemplateDefinition = nativeDocumentTemplateDefinitions[kind];

  const knownSections = new Map<string, NativeDocumentSectionTemplate>(
    EffectArray.map(definition.sections, section => [section.id, section]),
  );
  const suppliedIds = EffectRecord.keys(input.sections);
  for (const id of suppliedIds) {
    if (!knownSections.has(id)) throw invalidTemplate(`Unknown ${kind} template section: ${id}.`);
    if (typeof input.sections[id] !== 'string') throw invalidTemplate(`Section ${id} must be supplied as text.`);
  }
  const sections = EffectArray.flatMap(definition.sections, section => {
    const body = input.sections[section.id];
    if (body === undefined || Effect.pipe(body, EffectString.trim).length === 0) {
      if (section.required === true) throw invalidTemplate(`Required ${kind} section ${section.id} is blank.`);
      return [];
    }
    return [{id: section.id, heading: section.heading, body}];
  });
  return decodeNativeDocument({
    schemaVersion: 1,
    templateVersion: nativeDocumentTemplateVersion,
    kind,
    title: input.title,
    sections,
  });
}

const invalidTemplate = (message: string) => WorkflowAutomationError.make({code: 'invalid-document', message});
