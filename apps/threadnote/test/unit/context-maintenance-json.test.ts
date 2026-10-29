import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import * as EffectString from 'effect/String';
import {isMaintenanceState, isUndoJournal} from '../../src/memory/context/maintenance_json.js';
import type {ContextHealthRepairProposalV1} from '../../src/memory/context/health_repair.js';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';

const legacyCase = {
  caseId: 'case-legacy',
  project: 'threadnote',
  memoryId: 'memory-legacy',
  family: 'citation',
  slot: 'anchor',
  evidenceRevision: 'revision-1',
  disposition: 'queued',
  reason: 'legacy persisted case',
  firstSeen: '2026-01-01T00:00:00.000Z',
  lastSeen: '2026-01-01T00:00:00.000Z',
  lastChecked: '2026-01-01T00:00:00.000Z',
  attemptCount: 0,
  events: [],
};
const legacyState = {
  version: 2,
  paused: false,
  state: 'idle',
  generation: 'legacy-generation',
  projects: [],
  cases: [legacyCase],
  receipts: [],
  checkpoints: {},
  legacyExtension: {retained: true},
};
const currentState = {
  ...legacyState,
  state: 'running',
  preparation: {
    complete: false,
    admittedRecords: 1,
    incompleteReason: 'inventory-records-omitted',
    diagnostics: [],
  },
  semanticCoverage: [
    {
      project: 'threadnote',
      state: 'partial',
      eligibleRecords: 1,
      checkedBatches: 0,
      totalBatches: 1,
      extractedRecords: 0,
      totalRecords: 1,
      extractionComplete: false,
      comparisonComplete: false,
      comparedClaimPairs: 0,
      unsupportedRecords: 0,
      unsupportedClaims: 0,
      bodyLimitedRecords: 0,
      outputOmittedFindings: 0,
      churnCount: 0,
      dirtyRecordPairsRemaining: 0,
    },
  ],
  workSchedule: {
    nextPhase: 'requested',
    requestDiscovery: {
      namesHash: 'hash',
      scope: 'threadnote',
      scanned: 1,
      lastFile: 'page-1.json',
      scopedPending: false,
    },
  },
  futureExtension: ['kept', {nested: true}],
};
const undoJournal = {
  receiptId: 'receipt-1',
  project: 'threadnote',
  subjectUri: 'memory://threadnote/subject',
  postHash: 'hash-after',
  timestamp: '2026-01-01T00:00:00.000Z',
  state: 'applied',
  before: 'before-content',
  after: 'after-content',
  removed: [{type: 'references', uri: 'memory://threadnote/related'}],
  relationChanges: [
    {
      relation: {type: 'depends_on', uri: 'memory://threadnote/dependency'},
      targetHash: 'target-hash',
      lineageHashes: ['lineage-hash'],
    },
  ],
  futureJournalField: {preserved: true},
};

describe('maintenance persistence guards', () => {
  it('accepts and preserves legacy v2 state and current optional state fields', () => {
    for (const fixture of [legacyState, currentState]) {
      const before = JSON.stringify(fixture);
      const parsed: unknown = JSON.parse(before);
      expect(isMaintenanceState(parsed)).toBe(true);
      expect(JSON.stringify(parsed)).toBe(before);
    }
  });

  it('rejects singleton arrays that coerce to valid state names', () => {
    fc.assert(
      fc.property(fc.constantFrom('idle', 'running', 'waiting-evidence', 'needs-decision', 'failed'), state => {
        expect(isMaintenanceState({...legacyState, state: [state]})).toBe(false);
      }),
      {numRuns: 24},
    );
  });

  it('accepts and preserves undo journal JSON without mutation', () => {
    const before = JSON.stringify(undoJournal);
    const parsed: unknown = JSON.parse(before);
    expect(isUndoJournal(parsed)).toBe(true);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it.each([
    ['top-level state', {...legacyState, state: ['idle']}],
    ['case disposition', {...legacyState, cases: [{...legacyCase, disposition: ['queued']}]}],
    [
      'receipt state',
      {
        ...legacyState,
        receipts: [{receiptId: 'r', project: 'p', subjectUri: 'u', postHash: 'h', timestamp: 't', state: ['applied']}],
      },
    ],
    ['work phase', {...currentState, workSchedule: {nextPhase: ['requested']}}],
    [
      'semantic coverage state',
      {...currentState, semanticCoverage: [{...currentState.semanticCoverage[0], state: ['partial']}]},
    ],
    [
      'preparation reason',
      {...currentState, preparation: {...currentState.preparation, incompleteReason: ['inventory-records-omitted']}},
    ],
  ])('rejects non-string enum values for %s', (_label, value) => {
    expect(isMaintenanceState(value)).toBe(false);
  });

  it('accepts valid repair variants, including optional review-only subject and supersede direction', () => {
    const base = {
      version: 1,
      category: 'citation-changed',
      findingId: 'finding',
      project: 'threadnote',
      proposalId: 'proposal',
      revision: 'revision',
      summary: 'review only',
      preconditions: [],
    } satisfies Omit<ContextHealthRepairProposalV1, 'mutation'>;
    const reviewOnly = {
      ...base,
      mutation: {kind: 'review-only', reason: 'review', repairKind: 'repair-guidance'},
    } satisfies ContextHealthRepairProposalV1;
    const archiveMemory = {
      ...base,
      mutation: {kind: 'archive-memory', subjectUri: 'memory://subject'},
    } satisfies ContextHealthRepairProposalV1;
    const removeRelations = {
      ...base,
      mutation: {
        kind: 'remove-relations',
        subjectUri: 'memory://subject',
        targetUri: 'memory://target',
        expectedResultContentHash: 'hash',
        targetPrecondition: {state: 'absent'},
      },
    } satisfies ContextHealthRepairProposalV1;
    const replaceCitation = {
      ...base,
      mutation: {
        kind: 'replace-citation',
        subjectUri: 'memory://subject',
        citationId: 'citation',
        expectedResultContentHash: 'hash',
        replacement: createMemoryCodeCitation({
          extractorSet: 'extractor-v1',
          fileContentHash: {algorithm: 'sha256', value: EffectString.repeat(64)('a')},
          path: 'src/file.ts',
          repositoryId: EffectString.repeat(64)('c'),
          repositoryIdentityKind: 'local',
          sourceCommit: EffectString.repeat(40)('b'),
          sourceDirty: false,
          sourceSnapshotId: `cgsn_${EffectString.repeat(40)('d')}`,
          target: {kind: 'file'},
          version: 1,
        }),
      },
    } satisfies ContextHealthRepairProposalV1;
    const supersedeReview = {
      ...reviewOnly,
      mutation: {
        ...reviewOnly.mutation,
        suggestedMutation: {
          archivedFrom: 'memory://stale',
          designation: {
            contradictionId: 'contradiction',
            currentUri: 'memory://current',
            reportRevision: 'report-revision',
            staleUri: 'memory://stale',
            type: 'context-health-semantic-direction',
            version: 1,
          },
          kind: 'supersede-memory',
          preservedMemoryId: 'preserved',
          status: 'superseded',
          subjectUri: 'memory://stale',
          supersededByMemoryId: 'replacement',
          supersededByUri: 'memory://replacement',
        },
      },
    } satisfies ContextHealthRepairProposalV1;
    for (const proposal of [reviewOnly, archiveMemory, removeRelations, replaceCitation, supersedeReview]) {
      expect(isUndoJournal({...undoJournal, archiveProposal: proposal})).toBe(true);
    }
  });

  it('rejects malformed nested relation and repair enums in undo journals', () => {
    expect(isUndoJournal({...undoJournal, removed: [{type: ['references'], uri: 'memory://related'}]})).toBe(false);
    const validProposal = {
      version: 1,
      category: 'citation-changed',
      findingId: 'finding',
      project: 'threadnote',
      proposalId: 'proposal',
      revision: 'revision',
      summary: 'review only',
      preconditions: [],
      mutation: {kind: 'review-only', reason: 'review', repairKind: 'repair-guidance'},
    } satisfies ContextHealthRepairProposalV1;
    const invalidRepairKind: unknown = {
      ...validProposal,
      mutation: {...validProposal.mutation, repairKind: ['repair-guidance']},
    };
    expect(isUndoJournal({...undoJournal, archiveProposal: invalidRepairKind})).toBe(false);
  });
});
