import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  applyContextHealthRepairProposalV1,
  contextHealthReportRevisionV1,
  contextHealthRepairProposalRevisionV1,
  memoryContentWithCitationReplacementsV1,
  previewContextHealthRepairPlanV1,
  type ContextHealthRepairProposalV1,
} from '@threadnote/threadnote/memory/context/health_repair';
import {contextHealthRepairLockScopeV1} from '@threadnote/threadnote/memory/context/health_repair_commands';
import {
  formatMemoryDocument,
  parseMemoryDocument,
  type MemoryMetadata,
  type MemoryRecord,
} from '@threadnote/memory/document';
import type {ContextHealthFindingV1, ContextHealthReportV1} from '@threadnote/context/health';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';

const PROJECT = 'threadnote';
const NOW = '2026-09-17T12:00:00.000Z';

describe('context health repair proposals', () => {
  it('projects exact bounded mutations and leaves evidence inputs unchanged', () => {
    const missingUri = 'threadnote://user/me/memories/durable/projects/threadnote/missing.md';
    const expired = record('expired', 'Expired memory.', {
      memoryId: 'tn_expired',
      relations: [{type: 'references', uri: 'threadnote://memory/tn_keep'}],
      validTo: '2026-09-16T00:00:00.000Z',
    });
    const duplicate = record('duplicate', 'Duplicate memory.', {memoryId: 'tn_duplicate'});
    const survivor = record('survivor', 'Duplicate memory.', {memoryId: 'tn_survivor'});
    const related = record('related', 'Related memory.', {
      memoryId: 'tn_related',
      relations: [
        {type: 'depends_on', uri: missingUri},
        {type: 'references', uri: 'threadnote://memory/tn_keep'},
      ],
    });
    const report = healthReport([
      finding('validity-expired', 'archive-memory', expired.uri),
      finding('exact-duplicate', 'deduplicate-memory', duplicate.uri, survivor.uri),
      finding('relation-target-missing', 'repair-relation', related.uri, missingUri),
      finding('citation-changed', 'repair-citation', related.uri, `${related.uri}#tncc_changed`),
    ]);
    const records = [expired, duplicate, survivor, related];
    const originalReport = structuredClone(report);
    const originalRecords = structuredClone(records);

    const preview = previewWithStorageAbsence(report, records);
    const boundedPreview = previewWithStorageAbsence(report, records, 3);

    expect(preview.proposals).toHaveLength(4);
    expect(preview.omittedProposals).toBe(0);
    expect(boundedPreview.proposals).toHaveLength(3);
    expect(boundedPreview.omittedProposals).toBe(1);
    expect(preview.sourceOmittedFindings).toBe(0);
    expect(preview.proposals.every(proposal => /^[a-f0-9]{64}$/u.test(proposal.revision))).toBe(true);
    expect(preview.proposals.flatMap(proposal => proposal.preconditions)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({expectedProject: PROJECT, uri: expired.uri}),
        expect.objectContaining({expectedProject: PROJECT, uri: duplicate.uri}),
        expect.objectContaining({expectedProject: PROJECT, uri: survivor.uri}),
      ]),
    );
    expect(preview.proposals.map(proposal => proposal.mutation.kind)).toEqual(
      expect.arrayContaining(['archive-memory', 'remove-relations', 'review-only']),
    );
    expect(report).toEqual(originalReport);
    expect(records).toEqual(originalRecords);
  });

  it('applies a relation repair immutably and recognizes its exact postcondition', () => {
    const missingUri = 'threadnote://user/me/memories/durable/projects/threadnote/missing.md';
    const source = record('source', 'Body is preserved.', {
      memoryId: 'tn_source',
      relations: [
        {type: 'depends_on', uri: missingUri},
        {type: 'references', uri: 'threadnote://memory/tn_keep'},
      ],
    });
    const otherProject = record('other', 'Other project.', {project: 'other'});
    const proposal = onlyProposal(
      healthReport([finding('relation-target-missing', 'repair-relation', source.uri, missingUri)]),
      [source, otherProject],
    );
    const original = structuredClone([source, otherProject]);

    const applied = applyContextHealthRepairProposalV1({
      absentTargetUris: [missingUri],
      expectedRevision: proposal.revision,
      proposal,
      records: [source, otherProject],
    });

    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') throw new Error('expected relation repair to apply');
    const updated = applied.records.find(item => item.uri === source.uri);
    expect(updated).toMatchObject({
      body: source.body,
      metadata: {
        memoryId: 'tn_source',
        relations: [{type: 'references', uri: 'threadnote://memory/tn_keep'}],
      },
    });
    expect(updated?.content).toContain('unknown_header: preserved');
    expect(applied.records.find(item => item.uri === otherProject.uri)).toBe(otherProject);
    expect([source, otherProject]).toEqual(original);

    const repeated = applyContextHealthRepairProposalV1({
      absentTargetUris: [missingUri],
      expectedRevision: proposal.revision,
      proposal,
      records: applied.records,
    });
    expect(repeated).toMatchObject({status: 'already-applied'});
  });

  it('binds direct relation repairs to exact absent or inactive target state', () => {
    const missingUri = 'threadnote://user/me/memories/durable/projects/threadnote/missing.md';
    const missingSource = record('missing-source', 'Missing target.', {
      relations: [{type: 'depends_on', uri: missingUri}],
    });
    expect(
      previewContextHealthRepairPlanV1(
        healthReport([finding('relation-target-missing', 'repair-relation', missingSource.uri, missingUri)]),
        [missingSource],
      ).proposals[0]?.mutation,
    ).toMatchObject({kind: 'review-only'});
    const missingProposal = onlyProposal(
      healthReport([finding('relation-target-missing', 'repair-relation', missingSource.uri, missingUri)]),
      [missingSource],
    );
    expect(missingProposal.mutation).toMatchObject({
      kind: 'remove-relations',
      targetPrecondition: {state: 'absent'},
    });
    const appeared = record('missing', 'Now active.');
    expect(appeared.uri).toBe(missingUri);
    expect(
      applyContextHealthRepairProposalV1({
        expectedRevision: missingProposal.revision,
        proposal: missingProposal,
        records: [missingSource, appeared],
      }),
    ).toMatchObject({conflict: {code: 'precondition-failed'}, status: 'conflict'});

    const inactiveUri = 'threadnote://user/me/memories/durable/archived/threadnote/inactive.md';
    const inactiveSource = record('inactive-source', 'Inactive target.', {
      relations: [{type: 'references', uri: inactiveUri}],
    });
    const inactive = record('inactive', 'Retired.', {status: 'archived'}, inactiveUri);
    const inactiveProposal = onlyProposal(
      healthReport([finding('relation-target-inactive', 'repair-relation', inactiveSource.uri, inactiveUri)]),
      [inactiveSource, inactive],
    );
    expect(inactiveProposal.mutation).toMatchObject({
      kind: 'remove-relations',
      targetPrecondition: {state: 'inactive'},
    });
    const reactivated = record('inactive', 'Retired.', {status: 'active'}, inactiveUri);
    expect(
      applyContextHealthRepairProposalV1({
        expectedRevision: inactiveProposal.revision,
        proposal: inactiveProposal,
        records: [inactiveSource, reactivated],
      }),
    ).toMatchObject({conflict: {code: 'precondition-failed'}, status: 'conflict'});
  });

  it('keeps selector-scoped relation proposals bound to inactive targets outside the selected subjects', () => {
    const inactiveUri = 'threadnote://user/me/memories/durable/archived/threadnote/outside.md';
    const source = record('selected-source', 'Selected subject.', {
      relations: [{type: 'references', uri: inactiveUri}],
      topic: 'selected-topic',
    });
    const inactive = record('outside', 'Inactive target.', {status: 'archived', topic: 'outside-topic'}, inactiveUri);
    const report = healthReport([finding('relation-target-inactive', 'repair-relation', source.uri, inactiveUri)]);
    const selector = {findingCategory: 'relation-target-inactive' as const, topic: 'selected-topic'};
    const proposal = previewContextHealthRepairPlanV1(report, [source, inactive], {selector}).proposals[0];
    expect(proposal).toMatchObject({
      mutation: {kind: 'remove-relations', targetPrecondition: {state: 'inactive'}},
      selector,
    });
    if (proposal === undefined) throw new Error('expected selector-scoped relation proposal');

    const changedTarget = record('outside', 'Changed inactive target.', inactive.metadata, inactiveUri);
    expect(
      applyContextHealthRepairProposalV1({
        expectedRevision: proposal.revision,
        proposal,
        records: [source, changedTarget],
      }),
    ).toMatchObject({conflict: {code: 'precondition-failed'}, status: 'conflict'});

    const duplicate = record('selected-duplicate', 'Duplicate body.', {topic: 'selected-topic'});
    const survivor = record('outside-survivor', 'Duplicate body.', {topic: 'outside-topic'});
    const duplicateProposal = previewContextHealthRepairPlanV1(
      healthReport([finding('exact-duplicate', 'deduplicate-memory', duplicate.uri, survivor.uri)]),
      [duplicate, survivor],
      {selector: {findingCategory: 'exact-duplicate', topic: 'selected-topic'}},
    ).proposals[0];
    expect(duplicateProposal?.preconditions.map(precondition => precondition.uri)).toEqual(
      [duplicate.uri, survivor.uri].sort(),
    );
  });

  it('removes a proven-missing stable identity relation and blocks it when that identity exists', () => {
    const alias = 'threadnote://memory/tn_missing';
    const source = record('alias-source', 'Alias target.', {
      relations: [{type: 'depends_on', uri: alias}],
    });
    const proposal = onlyProposal(
      healthReport([finding('relation-target-missing', 'repair-relation', source.uri, alias)]),
      [source],
    );
    expect(proposal.mutation).toMatchObject({kind: 'remove-relations', targetUri: alias});
    expect(contextHealthRepairLockScopeV1(proposal)).toEqual({
      lockKeys: [source.uri, 'threadnote-memory-identity:tn_missing'],
      recordUris: [source.uri],
    });
    expect(proposal.preconditions).toEqual([expect.objectContaining({uri: source.uri})]);
    expect(
      applyContextHealthRepairProposalV1({
        absentTargetUris: [alias],
        expectedRevision: proposal.revision,
        proposal,
        records: [source],
      }),
    ).toMatchObject({status: 'applied'});

    const appeared = record('alias-target', 'Target exists.', {memoryId: 'tn_missing'});
    expect(
      applyContextHealthRepairProposalV1({
        absentTargetUris: [alias],
        expectedRevision: proposal.revision,
        proposal,
        records: [source, appeared],
      }),
    ).toMatchObject({conflict: {code: 'precondition-failed'}, status: 'conflict'});
    expect(
      previewContextHealthRepairPlanV1(
        healthReport([finding('relation-target-missing', 'repair-relation', source.uri, alias)]),
        [source, appeared],
        {absentTargetUris: [alias]},
      ).proposals[0]?.mutation,
    ).toMatchObject({kind: 'review-only'});
  });

  it('removes an inactive stable identity relation using the canonical target record as its precondition', () => {
    const alias = 'threadnote://memory/tn_inactive';
    const source = record('inactive-alias-source', 'Alias target.', {
      relations: [{type: 'depends_on', uri: alias}],
    });
    const target = record(
      'inactive-alias-target',
      'Inactive target.',
      {memoryId: 'tn_inactive', status: 'archived'},
      'threadnote://user/me/memories/durable/archived/threadnote/inactive-alias-target.md',
    );
    const proposal = onlyProposal(
      healthReport([finding('relation-target-inactive', 'repair-relation', source.uri, alias)]),
      [source, target],
    );

    expect(proposal.mutation).toMatchObject({
      kind: 'remove-relations',
      targetPrecondition: {state: 'inactive'},
      targetUri: alias,
    });
    const recordUris = [source.uri, target.uri].sort();
    expect(proposal.preconditions.map(precondition => precondition.uri)).toEqual(recordUris);
    expect(contextHealthRepairLockScopeV1(proposal)).toEqual({
      lockKeys: [...recordUris, 'threadnote-memory-identity:tn_inactive'],
      recordUris,
    });
    expect(
      applyContextHealthRepairProposalV1({
        expectedRevision: proposal.revision,
        proposal,
        records: [source, target],
      }),
    ).toMatchObject({status: 'applied'});
  });

  it('previews and applies an exact citation recapture while preserving unknown headers', () => {
    const previous = fileCitation('apps/threadnote/src/manager/server.ts', 'a', 'b', 'c');
    const replacement = fileCitation('apps/threadnote/src/manager/server.ts', 'd', 'e', 'f');
    const source = record('cited-source', 'Cited decision.', {
      codeCitations: [previous],
      memoryId: 'tn_cited_source',
      schemaVersion: 5,
    });
    const citationFinding = finding('citation-changed', 'repair-citation', source.uri, `${source.uri}#${previous.id}`);
    const proposal = previewContextHealthRepairPlanV1(healthReport([citationFinding]), [source], {
      citationReplacements: new Map([[citationFinding.id, replacement]]),
    }).proposals[0];
    expect(proposal?.mutation).toMatchObject({
      citationId: previous.id,
      kind: 'replace-citation',
      replacement: {id: replacement.id},
    });
    if (proposal === undefined) throw new Error('expected citation repair proposal');

    const applied = applyContextHealthRepairProposalV1({
      expectedRevision: proposal.revision,
      proposal,
      records: [source],
    });
    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') throw new Error('expected citation repair to apply');
    expect(applied.records[0]?.metadata.codeCitations).toEqual([{...replacement, anchorId: previous.id}]);
    expect(applied.records[0]?.content).toContain('unknown_header: preserved');
    expect(
      applyContextHealthRepairProposalV1({
        expectedRevision: proposal.revision,
        proposal,
        records: applied.records,
      }),
    ).toMatchObject({status: 'already-applied'});
  });

  it('rewrites every reviewed citation in one memory independently of replacement order', () => {
    const previous = [
      fileCitation('src/first.ts', '1', '1', '1'),
      fileCitation('src/second.ts', '2', '2', '2'),
      fileCitation('src/third.ts', '3', '3', '3'),
    ];
    const replacements = [
      fileCitation('src/first.ts', '4', '4', '4'),
      fileCitation('src/second.ts', '5', '5', '5'),
      fileCitation('src/third.ts', '6', '6', '6'),
    ];
    const source = record('batch-citations', 'All cited decisions remain readable.', {
      codeCitations: previous,
      schemaVersion: 5,
    });
    const expected = memoryContentWithCitationReplacementsV1(
      source,
      previous.map((citation, index) => ({citationId: citation.id, replacement: replacements[index]})),
    );
    expect(expected).toBeDefined();
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({min: 0, max: 2}), {minLength: 3, maxLength: 3}), order => {
        const content = memoryContentWithCitationReplacementsV1(
          source,
          order.map(index => ({citationId: previous[index].id, replacement: replacements[index]})),
        );
        expect(content).toBe(expected);
        expect(parseMemoryDocument(source.uri, content ?? '')?.metadata.codeCitations).toEqual(
          replacements.map((replacement, index) => ({...replacement, anchorId: previous[index].id})),
        );
      }),
      {numRuns: 20},
    );
  });

  it('keeps citation recapture review-only when graph evidence belongs to another repository', () => {
    const previous = fileCitation('src/shared.ts', 'a', 'b', 'c', '1');
    const foreign = fileCitation('src/shared.ts', 'd', 'e', 'f', '2');
    const source = record('foreign-citation', 'Repository-bound decision.', {
      codeCitations: [previous],
      memoryId: 'tn_foreign_citation',
      schemaVersion: 5,
    });
    const citationFinding = finding('citation-unknown', 'repair-citation', source.uri, `${source.uri}#${previous.id}`);

    const proposal = previewContextHealthRepairPlanV1(healthReport([citationFinding]), [source], {
      citationReplacements: new Map([[citationFinding.id, foreign]]),
    }).proposals[0];

    expect(proposal?.mutation).toMatchObject({kind: 'review-only', repairKind: 'repair-citation'});
  });

  it('makes archive replay receipt-idempotent and stale snapshots stable conflicts', () => {
    const source = record('source', 'Archive me.', {
      memoryId: 'tn_source',
      relations: [{type: 'references', uri: 'threadnote://memory/tn_keep'}],
      validTo: '2026-09-16T00:00:00.000Z',
    });
    const proposal = onlyProposal(healthReport([finding('validity-expired', 'archive-memory', source.uri)]), [source]);
    const applied = applyContextHealthRepairProposalV1({
      expectedRevision: proposal.revision,
      proposal,
      records: [source],
    });
    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') throw new Error('expected archive to apply');
    expect(applied.records).toEqual([]);

    expect(
      applyContextHealthRepairProposalV1({
        expectedRevision: proposal.revision,
        proposal,
        receipt: applied.receipt,
        records: applied.records,
      }),
    ).toMatchObject({status: 'already-applied'});

    const missingWithoutReceipt = applyContextHealthRepairProposalV1({
      expectedRevision: proposal.revision,
      proposal,
      records: applied.records,
    });
    const repeatedConflict = applyContextHealthRepairProposalV1({
      expectedRevision: proposal.revision,
      proposal,
      records: applied.records,
    });
    expect(missingWithoutReceipt).toMatchObject({
      conflict: {code: 'subject-missing'},
      status: 'conflict',
    });
    expect(repeatedConflict).toEqual(missingWithoutReceipt);
  });

  it('fails closed across projects, revisions, changed content, and forged receipts', () => {
    const source = record('source', 'Archive me.', {validTo: '2026-09-16T00:00:00.000Z'});
    const proposal = onlyProposal(healthReport([finding('validity-expired', 'archive-memory', source.uri)]), [source]);
    const crossProject = record(
      'source',
      'Archive me.',
      {project: 'other', validTo: '2026-09-16T00:00:00.000Z'},
      source.uri,
    );
    expect(
      applyContextHealthRepairProposalV1({
        expectedRevision: proposal.revision,
        proposal,
        records: [crossProject],
      }),
    ).toMatchObject({conflict: {code: 'project-mismatch'}, status: 'conflict'});
    expect(
      applyContextHealthRepairProposalV1({
        expectedRevision: '0'.repeat(64),
        proposal,
        records: [source],
      }),
    ).toMatchObject({conflict: {code: 'revision-mismatch'}, status: 'conflict'});
    const changed = record('source', 'Changed after preview.', {validTo: '2026-09-16T00:00:00.000Z'});
    const staleInput = {expectedRevision: proposal.revision, proposal, records: [changed]};
    const stale = applyContextHealthRepairProposalV1(staleInput);
    expect(stale).toMatchObject({conflict: {code: 'precondition-failed'}, status: 'conflict'});
    expect(applyContextHealthRepairProposalV1(staleInput)).toEqual(stale);
    expect(stale.records[0]).toBe(changed);
    expect(
      applyContextHealthRepairProposalV1({
        expectedRevision: proposal.revision,
        proposal,
        receipt: {
          proposalId: proposal.proposalId,
          resultHash: 'f'.repeat(64),
          revision: proposal.revision,
          version: 1,
        },
        records: [],
      }),
    ).toMatchObject({conflict: {code: 'receipt-mismatch'}, status: 'conflict'});
  });

  it('keeps every shared-memory repair review-only', () => {
    const sharedUri = 'threadnote://user/me/memories/shared/default/durable/projects/threadnote/shared.md';
    const shared = record(
      'shared',
      'Shared memory.',
      {
        relations: [{type: 'depends_on', uri: 'threadnote://memory/tn_missing'}],
        validTo: '2026-09-16T00:00:00.000Z',
      },
      sharedUri,
    );
    const survivor = record('survivor', 'Shared memory.');
    const cases = [
      finding('validity-expired', 'archive-memory', sharedUri),
      finding('exact-duplicate', 'deduplicate-memory', sharedUri, survivor.uri),
      finding('relation-target-missing', 'repair-relation', sharedUri, 'threadnote://memory/tn_missing'),
    ];

    for (const item of cases) {
      const proposal = onlyProposal(healthReport([item]), [shared, survivor]);
      expect(proposal.mutation).toMatchObject({kind: 'review-only', subjectUri: sharedUri});
      expect(proposal.preconditions).toEqual([]);
      expect(
        applyContextHealthRepairProposalV1({
          expectedRevision: proposal.revision,
          proposal,
          records: [shared, survivor],
        }),
      ).toMatchObject({status: 'review-required'});
    }

    const personalDuplicate = record('personal-duplicate', 'Shared memory.');
    const sharedSurvivorProposal = onlyProposal(
      healthReport([finding('exact-duplicate', 'deduplicate-memory', personalDuplicate.uri, sharedUri)]),
      [personalDuplicate, shared],
    );
    expect(sharedSurvivorProposal.mutation).toMatchObject({kind: 'review-only'});
    expect(sharedSurvivorProposal.preconditions).toEqual([]);
  });

  it('requires manual lifecycle review before archiving preference or smoke memories', () => {
    for (const kind of ['preference', 'smoke'] as const) {
      const source = record(kind, `${kind} memory.`, {
        kind,
        validTo: '2026-09-16T00:00:00.000Z',
      });
      const survivor = record(`${kind}-survivor`, `${kind} memory.`, {kind});
      for (const item of [
        finding('validity-expired', 'archive-memory', source.uri),
        finding('exact-duplicate', 'deduplicate-memory', source.uri, survivor.uri),
      ]) {
        const proposal = onlyProposal(healthReport([item]), [source, survivor]);
        expect(proposal.mutation).toMatchObject({kind: 'review-only', repairKind: item.repair.kind});
        expect(proposal.preconditions).toEqual([]);
      }
    }
  });

  it('keeps unsupported schemas and malformed citation metadata review-only before archival', () => {
    const base = record('unsafe-archive', 'Do not rewrite blindly.', {validTo: '2026-09-16T00:00:00.000Z'});
    const unsupported = parseMemoryDocument(
      base.uri,
      base.content.replace('unknown_header: preserved', 'schema_version: 999\nunknown_header: preserved'),
    );
    const malformedCitation = parseMemoryDocument(
      base.uri,
      base.content.replace('unknown_header: preserved', 'code_citation: {not-json}\nunknown_header: preserved'),
    );
    if (!unsupported || !malformedCitation) throw new Error('Expected unsafe memories to remain readable.');

    for (const unsafe of [unsupported, malformedCitation]) {
      const proposal = onlyProposal(healthReport([finding('validity-expired', 'archive-memory', unsafe.uri)]), [
        unsafe,
      ]);
      expect(proposal.mutation).toMatchObject({kind: 'review-only'});
      expect(proposal.preconditions).toEqual([]);
    }
    expect(unsupported.metadata.schemaVersion).toBe(999);
    expect(malformedCitation.metadata.citationErrors?.length).toBeGreaterThan(0);
  });

  it('projects an explicitly directed semantic supersede review through Knowledge Delta without mutating history', () => {
    const stale = record('stale-policy', 'Agents must never reuse verified context.', {memoryId: 'tn_stale_policy'});
    const current = record('current-policy', 'Agents must reuse verified context.', {memoryId: 'tn_current_policy'});
    const report = healthReport([semanticFinding(stale.uri, current.uri)]);
    const semanticDirection = directionFor(report, stale.uri, current.uri);

    const plan = previewContextHealthRepairPlanV1(report, [stale, current], {semanticDirection});
    const proposal = plan.proposals[0];
    expect(proposal).toBeDefined();
    if (!proposal) throw new Error('expected semantic supersede proposal');
    expect(proposal.mutation).toMatchObject({
      kind: 'review-only',
      suggestedMutation: {
        archivedFrom: stale.uri,
        designation: semanticDirection,
        kind: 'supersede-memory',
        preservedMemoryId: 'tn_stale_policy',
        status: 'superseded',
        subjectUri: stale.uri,
        supersededByMemoryId: 'tn_current_policy',
        supersededByUri: current.uri,
      },
    });
    expect(proposal.preconditions.map(precondition => precondition.uri)).toEqual([current.uri, stale.uri].sort());
    expect(plan.knowledgeDelta).toMatchObject({
      noAction: false,
      type: 'knowledge-delta',
      version: 1,
    });
    expect(plan.knowledgeDelta.reviewId).toMatch(/^review-[0-9a-f]{16}$/u);
    expect(Number.isSafeInteger(plan.knowledgeDelta.revision) && plan.knowledgeDelta.revision > 0).toBe(true);
    expect(plan.knowledgeDelta.items).toHaveLength(1);
    const item = plan.knowledgeDelta.items[0];
    expect(item).toMatchObject({
      candidateId: `${plan.knowledgeDelta.reviewId}-1`,
      comparison: 'contradiction',
      mutationPreview: {
        operation: 'requires_explicit_operation',
        replaceUri: stale.uri,
      },
      recommendation: 'manual_review',
      type: 'context-repair-or-retirement',
    });
    expect(item?.mutationPreview.expectedTargetContentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(item?.sourceEvidence.some(evidence => evidence.includes(proposal.proposalId))).toBe(true);
    expect(item?.sourceEvidence.some(evidence => evidence.includes(proposal.revision))).toBe(true);
    expect(
      applyContextHealthRepairProposalV1({
        expectedRevision: proposal.revision,
        proposal,
        records: [stale, current],
      }),
    ).toEqual({records: [stale, current], status: 'review-required'});

    const changedCurrent = record('current-policy', 'Agents should reuse verified context.', current.metadata);
    const changedPlan = previewContextHealthRepairPlanV1(report, [stale, changedCurrent], {semanticDirection});
    const changed = changedPlan.proposals[0];
    if (!changed) throw new Error('expected changed semantic supersede proposal');
    expect(changed.proposalId).toBe(proposal.proposalId);
    expect(changed.revision).not.toBe(proposal.revision);
    expect([changedPlan.knowledgeDelta.reviewId, changedPlan.knowledgeDelta.revision]).not.toEqual([
      plan.knowledgeDelta.reviewId,
      plan.knowledgeDelta.revision,
    ]);
    expect(changedPlan.knowledgeDelta.items[0]?.candidateId).not.toBe(plan.knowledgeDelta.items[0]?.candidateId);
  });

  it.each([
    ['missing subject identity', undefined, 'tn_current_policy'],
    ['invalid subject identity', 'invalid', 'tn_current_policy'],
    ['missing target identity', 'tn_stale_policy', undefined],
    ['invalid target identity', 'tn_stale_policy', 'invalid'],
  ])('keeps an explicit semantic direction generic when it has a %s', (_label, subjectId, targetId) => {
    const stale = record('stale-policy', 'Agents must never reuse verified context.', {
      ...(subjectId === undefined ? {} : {memoryId: subjectId}),
    });
    const current = record('current-policy', 'Agents must reuse verified context.', {
      ...(targetId === undefined ? {} : {memoryId: targetId}),
    });
    const report = healthReport([semanticFinding(stale.uri, current.uri)]);
    const proposal = previewContextHealthRepairPlanV1(report, [stale, current], {
      semanticDirection: directionFor(report, stale.uri, current.uri),
    }).proposals[0];
    if (!proposal) throw new Error('expected semantic review proposal');

    expect(proposal.mutation).toMatchObject({kind: 'review-only'});
    if (proposal.mutation.kind !== 'review-only') throw new Error('expected review-only mutation');
    expect(proposal.mutation.suggestedMutation).toBeUndefined();
    expect(proposal.preconditions).toEqual([]);
  });

  it('requires explicit report-bound analyzer direction before suggesting supersession', () => {
    const stale = record('stale-policy', 'Agents must never reuse verified context.', {memoryId: 'tn_stale_policy'});
    const current = record('current-policy', 'Agents must reuse verified context.', {memoryId: 'tn_current_policy'});
    const report = healthReport([semanticFinding(stale.uri, current.uri)]);

    const neutral = onlyProposal(report, [stale, current]);
    expect(neutral.mutation).toMatchObject({kind: 'review-only'});
    if (neutral.mutation.kind !== 'review-only') throw new Error('expected review-only mutation');
    expect(neutral.mutation.suggestedMutation).toBeUndefined();
    expect(neutral.preconditions).toEqual([]);

    const direction = directionFor(report, stale.uri, current.uri);
    expect(() =>
      previewContextHealthRepairPlanV1(report, [stale, current], {
        semanticDirection: {...direction, reportRevision: '0'.repeat(64)},
      }),
    ).toThrow(/another context-health report revision/u);
    expect(() =>
      previewContextHealthRepairPlanV1(report, [stale, current], {
        semanticDirection: {...direction, contradictionId: 'f'.repeat(64)},
      }),
    ).toThrow(/exactly one analyzer contradiction/u);
    expect(() =>
      previewContextHealthRepairPlanV1(report, [stale, current], {
        semanticDirection: {...direction, currentUri: current.uri.replace('/user/me/', '/user/other/')},
      }),
    ).toThrow(/same personal scope/u);
  });

  it('changes the Knowledge Delta approval tuple when the selected proposal set changes', () => {
    const first = record('first-expired', 'First.', {
      memoryId: 'tn_first_expired',
      validTo: '2026-09-16T00:00:00.000Z',
    });
    const second = record('second-expired', 'Second.', {
      memoryId: 'tn_second_expired',
      validTo: '2026-09-16T00:00:00.000Z',
    });
    const oneFinding = healthReport([finding('validity-expired', 'archive-memory', first.uri)]);
    const twoFindings = healthReport([
      finding('validity-expired', 'archive-memory', first.uri),
      finding('validity-expired', 'archive-memory', second.uri),
    ]);

    const one = previewContextHealthRepairPlanV1(oneFinding, [first]);
    const two = previewContextHealthRepairPlanV1(twoFindings, [first, second]);

    expect([two.knowledgeDelta.reviewId, two.knowledgeDelta.revision]).not.toEqual([
      one.knowledgeDelta.reviewId,
      one.knowledgeDelta.revision,
    ]);
  });

  it('does not offer local supersede mutations for shared semantic evidence', () => {
    const shared = record(
      'shared-policy',
      'Agents must reuse shared context.',
      {memoryId: 'tn_shared_policy'},
      'threadnote://user/me/memories/shared/default/durable/projects/threadnote/shared-policy.md',
    );
    const personal = record('personal-policy', 'Agents must not reuse shared context.');
    const proposal = onlyProposal(
      healthReport([finding('semantic-contradiction', 'review-memory', shared.uri, personal.uri)]),
      [shared, personal],
    );

    expect(proposal.mutation).toMatchObject({kind: 'review-only'});
    if (proposal.mutation.kind !== 'review-only') throw new Error('expected review-only mutation');
    expect(proposal.mutation.suggestedMutation).toBeUndefined();
    expect(proposal.preconditions).toEqual([]);
  });

  it('keeps proposal identity order-independent and revisions content-sensitive', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.stringMatching(/^[a-z]{1,12}$/u), {maxLength: 30}), values => {
        const records = values.map((value, index) =>
          record(`memory-${index}`, value, {validTo: '2026-09-16T00:00:00.000Z'}),
        );
        const findings = records.map(item => finding('validity-expired', 'archive-memory', item.uri));
        const report = healthReport(findings);
        const forward = previewContextHealthRepairPlanV1(report, records);
        const reverse = previewContextHealthRepairPlanV1(
          {...report, findings: [...findings].reverse()},
          [...records].reverse(),
        );
        expect(reverse).toEqual(forward);
        expect(records.every((item, index) => item.body === values[index])).toBe(true);
      }),
      {numRuns: 50},
    );

    const source = record('source', 'Initial.', {validTo: '2026-09-16T00:00:00.000Z'});
    const findingInput = finding('validity-expired', 'archive-memory', source.uri);
    const first = onlyProposal(healthReport([findingInput]), [source]);
    const changed = onlyProposal(healthReport([findingInput]), [record('source', 'Changed.', source.metadata)]);
    expect(changed.proposalId).toBe(first.proposalId);
    expect(changed.revision).not.toBe(first.revision);
    expect(contextHealthRepairProposalRevisionV1(first)).toBe(first.revision);
  });

  it('binds report revisions to semantic completeness and status', () => {
    const complete = healthReport([]);
    const unknown: ContextHealthReportV1 = {
      ...complete,
      semanticCompleteness: {
        ...complete.semanticCompleteness,
        analyzedRecords: 0,
        state: 'unavailable',
        unknownReasons: [{count: 1, reason: 'no-claims'}],
        unknownRecords: 1,
      },
      status: 'unknown',
    };

    expect(contextHealthReportRevisionV1(unknown)).not.toBe(contextHealthReportRevisionV1(complete));
  });
});

function onlyProposal(report: ContextHealthReportV1, records: readonly MemoryRecord[]): ContextHealthRepairProposalV1 {
  const proposals = previewWithStorageAbsence(report, records).proposals;
  expect(proposals).toHaveLength(1);
  return proposals[0];
}

function previewWithStorageAbsence(report: ContextHealthReportV1, records: readonly MemoryRecord[], limit?: number) {
  const existingUris = new Set(records.map(record => record.uri));
  const absentTargetUris = report.findings.flatMap(finding =>
    finding.category === 'relation-target-missing' &&
    finding.repair.targetUri !== undefined &&
    !existingUris.has(finding.repair.targetUri)
      ? [finding.repair.targetUri]
      : [],
  );
  return previewContextHealthRepairPlanV1(report, records, {
    absentTargetUris,
    ...(limit === undefined ? {} : {limit}),
  });
}

function record(
  topic: string,
  body: string,
  metadata: Partial<MemoryMetadata> = {},
  uri = `threadnote://user/me/memories/durable/projects/${metadata.project ?? PROJECT}/${topic}.md`,
): MemoryRecord {
  const complete: MemoryMetadata = {
    kind: 'durable',
    project: PROJECT,
    sourceAgentClient: 'codex',
    status: 'active',
    timestamp: NOW,
    topic,
    ...metadata,
  };
  const content = formatMemoryDocument(complete.kind === 'handoff' ? 'HANDOFF' : 'MEMORY', complete, body).replace(
    '\n\n',
    '\nunknown_header: preserved\n\n',
  );
  const parsed = parseMemoryDocument(uri, content);
  if (parsed === undefined) throw new Error('invalid test memory');
  return parsed;
}

function healthReport(findings: readonly ContextHealthFindingV1[]): ContextHealthReportV1 {
  return {
    findings,
    limit: 100,
    omittedFindings: 0,
    project: PROJECT,
    recordsScanned: findings.length,
    semanticCompleteness: {
      analyzedRecords: findings.length,
      claimsAnalyzed: findings.length,
      contradictionCount: 0,
      eligibleRecords: findings.length,
      omittedContradictions: 0,
      pairsCompared: 0,
      state: 'complete',
      unknownReasons: [],
      unknownRecords: 0,
      version: 1,
    },
    status: findings.length > 0 ? 'findings' : 'clean',
    version: 1,
  };
}

function semanticFinding(staleUri: string, currentUri: string): ContextHealthFindingV1 {
  const base = finding('semantic-contradiction', 'review-memory', staleUri, currentUri);
  return {
    ...base,
    repair: {
      kind: 'review-memory',
      summary: 'Review both durable claims and explicitly designate stale and current memories.',
    },
    semanticEvidence: {
      basisFingerprint: 'b'.repeat(64),
      contradictionId: 'c'.repeat(64),
      left: {
        claimFingerprint: 'd'.repeat(64),
        claimId: `tnclaim_${'e'.repeat(32)}`,
        recordUri: staleUri,
      },
      right: {
        claimFingerprint: 'f'.repeat(64),
        claimId: `tnclaim_${'a'.repeat(32)}`,
        recordUri: currentUri,
      },
      similarityMilli: 900,
    },
  };
}

function directionFor(report: ContextHealthReportV1, staleUri: string, currentUri: string) {
  const contradictionId = report.findings[0]?.semanticEvidence?.contradictionId;
  if (!contradictionId) throw new Error('expected semantic contradiction evidence');
  return {
    contradictionId,
    currentUri,
    reportRevision: contextHealthReportRevisionV1(report),
    staleUri,
    type: 'context-health-semantic-direction' as const,
    version: 1 as const,
  };
}

function finding(
  category: ContextHealthFindingV1['category'],
  kind: ContextHealthFindingV1['repair']['kind'],
  subjectUri: string,
  targetUri?: string,
): ContextHealthFindingV1 {
  const uris = [subjectUri, ...(targetUri === undefined || targetUri.includes('#') ? [] : [targetUri])].sort();
  return {
    category,
    confidence: category === 'citation-changed' ? 'medium' : 'high',
    id: [category, ...uris].join('\0'),
    repair: {
      kind,
      subjectUri,
      summary: `Review ${category}.`,
      ...(targetUri === undefined ? {} : {targetUri}),
    },
    repairability: category === 'citation-changed' ? 'reviewable' : 'reviewable',
    severity: category === 'validity-expired' ? 'critical' : 'high',
    summary: category,
    uris,
  };
}

function fileCitation(path: string, hashSeed: string, commitSeed: string, snapshotSeed: string, repositorySeed = '1') {
  return createMemoryCodeCitation({
    extractorSet: 'typescript-v1',
    fileContentHash: {algorithm: 'sha256', value: hashSeed.repeat(64)},
    path,
    repositoryId: repositorySeed.repeat(64),
    repositoryIdentityKind: 'local',
    sourceCommit: commitSeed.repeat(40),
    sourceDirty: false,
    sourceSnapshotId: `cgsn_${snapshotSeed.repeat(40)}`,
    target: {kind: 'file'},
    version: 1,
  });
}
