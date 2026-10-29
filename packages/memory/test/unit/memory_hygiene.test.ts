import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import type {MemoryMetadata, MemoryRecord} from '@threadnote/memory/hygiene';
import {
  buildCompactPlan,
  DEFAULT_HANDOFF_NEXT_STEP,
  existingReferencedUris,
  formatCompactPlan,
  handoffTopicForBranch,
  memoryContentWithHygieneSources,
  parseMemoryDocument,
  recallHygieneNudges,
  formatReferencedContextPointers,
  referencedUrisFromRecords,
} from '@threadnote/memory/hygiene';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

function record(
  overrides: Omit<Partial<MemoryRecord>, 'metadata'> & {
    readonly metadata?: Partial<MemoryMetadata>;
  } & Pick<MemoryRecord, 'uri'>,
): MemoryRecord {
  const metadata = {
    kind: 'handoff' as const,
    project: 'mobile-native',
    sourceAgentClient: 'codex',
    status: 'active' as const,
    timestamp: '2026-05-20T00:00:00.000Z',
    topic: 'mobile-auth',
    ...overrides.metadata,
  };
  const body = overrides.body ?? 'task: keep going';
  return {
    body,
    content:
      overrides.content ??
      EffectArray.join(
        EffectArray.filter(
          [
            metadata.kind === 'handoff' ? 'HANDOFF' : 'MEMORY',
            `kind: ${metadata.kind}`,
            `status: ${metadata.status}`,
            `project: ${metadata.project}`,
            metadata.topic ? `topic: ${metadata.topic}` : undefined,
            `source_agent_client: ${metadata.sourceAgentClient}`,
            `timestamp: ${metadata.timestamp}`,
            '',
            body,
          ],
          (line): line is string => line !== undefined,
        ),
        '\n',
      ),
    headerTitle: overrides.headerTitle ?? (metadata.kind === 'handoff' ? 'HANDOFF' : 'MEMORY'),
    metadata,
    uri: overrides.uri,
  };
}

describe('buildCompactPlan', () => {
  it('keeps one exact duplicate and forgets redundant copies', () => {
    const stable = record({
      uri: 'threadnote://user/me/memories/durable/projects/mobile-native/mobile-auth.md',
      headerTitle: 'MEMORY',
      metadata: {kind: 'durable', topic: 'mobile-auth', timestamp: '2026-05-20T00:00:00.000Z'},
      body: 'Shared auth contract.',
    });
    const duplicate = record({
      uri: 'threadnote://user/me/memories/durable/projects/mobile-native/threadnote-2026.md',
      headerTitle: 'MEMORY',
      metadata: {kind: 'durable', topic: 'mobile-auth', timestamp: '2026-05-20T00:00:00.000Z'},
      body: 'Shared auth contract.',
    });

    const plan = buildCompactPlan([duplicate, stable], {project: 'mobile-native'});

    expect(EffectArray.map(plan.keepUpdates, action => action.uri)).toEqual([stable.uri]);
    expect(EffectArray.map(plan.forgets, action => action.uri)).toEqual([duplicate.uri]);
    expect(plan.archives).toEqual([]);
    expect(plan.keepUpdates[0]?.content).toContain(stable.uri);
    expect(plan.keepUpdates[0]?.content).toContain(duplicate.uri);
  });

  it('preserves hygiene provenance that exists only on a forgotten duplicate', () => {
    const priorSource = 'threadnote://user/me/memories/handoffs/archived/mobile-native/prior.md';
    const stable = record({
      uri: 'threadnote://user/me/memories/durable/projects/mobile-native/mobile-auth.md',
      headerTitle: 'MEMORY',
      metadata: {kind: 'durable', topic: 'mobile-auth'},
      body: 'Shared auth contract.',
    });
    const duplicate = record({
      uri: 'threadnote://user/me/memories/durable/projects/mobile-native/threadnote-copy.md',
      headerTitle: 'MEMORY',
      metadata: {kind: 'durable', topic: 'mobile-auth'},
      body: EffectArray.join(
        ['Shared auth contract.', '', '## Threadnote Hygiene Sources', '', `- ${priorSource}`],
        '\n',
      ),
    });

    const plan = buildCompactPlan([stable, duplicate], {project: 'mobile-native'});

    expect(EffectArray.map(plan.forgets, action => action.uri)).toEqual([duplicate.uri]);
    expect(plan.keepUpdates[0]?.content).toContain(`- ${priorSource}`);
  });

  it('requires review rather than retiring duplicate bodies with distinct provenance metadata', () => {
    const stable = record({
      uri: 'threadnote://user/me/memories/durable/projects/mobile-native/mobile-auth.md',
      headerTitle: 'MEMORY',
      metadata: {
        authority: 'user_approved',
        kind: 'durable',
        memoryId: 'tn_mobile_auth',
        topic: 'mobile-auth',
        trust: 'approved',
        workspaceScope: 'apps/mobile',
      },
      body: 'Shared auth contract.',
    });
    const distinctProvenance = record({
      uri: 'threadnote://user/me/memories/durable/projects/mobile-native/threadnote-2026.md',
      headerTitle: 'MEMORY',
      metadata: {
        authority: 'agent_generated',
        evidence: ['threadnote://user/me/memories/incidents/active/mobile-native/auth.md'],
        kind: 'durable',
        memoryId: 'tn_other_identity',
        references: ['threadnote://user/me/memories/durable/projects/mobile-native/design.md'],
        topic: 'mobile-auth',
        trust: 'inferred',
        validTo: '2027-01-01T00:00:00.000Z',
        workspaceScope: 'apps/mobile',
      },
      body: 'Shared auth contract.',
    });

    const plan = buildCompactPlan([distinctProvenance, stable], {project: 'mobile-native'});

    expect(plan.forgets).toEqual([]);
    expect(plan.archives).toEqual([]);
    expect(plan.keepUpdates).toEqual([]);
    expect(plan.manualReview).toEqual(
      EffectArray.map([stable.uri, distinctProvenance.uri].sort(), uri => ({
        reason: 'same body has distinct metadata or provenance; no automatic retirement',
        uri,
      })),
    );
  });

  it('does not treat Markdown or code whitespace changes as exact duplicates', () => {
    const stable = record({
      uri: 'threadnote://user/me/memories/durable/projects/mobile-native/mobile-auth.md',
      headerTitle: 'MEMORY',
      metadata: {kind: 'durable', topic: 'mobile-auth'},
      body: '```ts\nif (ready) {\n  ship();\n}\n```',
    });
    const whitespaceChanged = record({
      uri: 'threadnote://user/me/memories/durable/projects/mobile-native/threadnote-2026.md',
      headerTitle: 'MEMORY',
      metadata: {kind: 'durable', topic: 'mobile-auth'},
      body: '```ts\nif (ready) { ship(); }\n```',
    });

    const plan = buildCompactPlan([stable, whitespaceChanged], {project: 'mobile-native'});

    expect(plan.forgets).toEqual([]);
    expect(plan.archives).toEqual([]);
    expect(EffectArray.map(plan.manualReview, item => item.uri)).toEqual([stable.uri, whitespaceChanged.uri].sort());
  });

  it('never strips user-authored content under a hygiene-sources heading', () => {
    const stable = record({
      uri: 'threadnote://user/me/memories/durable/projects/mobile-native/mobile-auth.md',
      headerTitle: 'MEMORY',
      metadata: {kind: 'durable', topic: 'mobile-auth'},
      body: EffectArray.join(
        ['Shared auth contract.', '', '## Threadnote Hygiene Sources', '', 'This is a user-authored explanation.'],
        '\n',
      ),
    });
    const distinctTail = record({
      uri: 'threadnote://user/me/memories/durable/projects/mobile-native/threadnote-2026.md',
      headerTitle: 'MEMORY',
      metadata: {kind: 'durable', topic: 'mobile-auth'},
      body: EffectArray.join(
        ['Shared auth contract.', '', '## Threadnote Hygiene Sources', '', 'Different legitimate Markdown content.'],
        '\n',
      ),
    });

    const plan = buildCompactPlan([stable, distinctTail], {project: 'mobile-native'});

    expect(plan.forgets).toEqual([]);
    expect(plan.keepUpdates).toEqual([]);
    expect(plan.archives).toEqual([]);
    expect(EffectArray.map(plan.manualReview, item => item.uri)).toEqual([stable.uri, distinctTail.uri].sort());
  });

  it('archives older non-exact handoffs for the same group', () => {
    const oldHandoff = record({
      uri: 'threadnote://user/me/memories/handoffs/active/mobile-native/threadnote-old.md',
      metadata: {timestamp: '2026-05-19T00:00:00.000Z'},
      body: 'task: first pass',
    });
    const newHandoff = record({
      uri: 'threadnote://user/me/memories/handoffs/active/mobile-native/mobile-auth.md',
      metadata: {timestamp: '2026-05-21T00:00:00.000Z'},
      body: 'task: latest status',
    });

    const plan = buildCompactPlan([oldHandoff, newHandoff], {
      now: new Date('2026-05-22T00:00:00.000Z'),
      project: 'mobile-native',
    });

    expect(EffectArray.map(plan.keepUpdates, action => action.uri)).toEqual([newHandoff.uri]);
    expect(EffectArray.map(plan.archives, action => action.uri)).toEqual([oldHandoff.uri]);
    expect(plan.forgets).toEqual([]);
    expect(plan.keepUpdates[0]?.content).toContain(oldHandoff.uri);
    expect(plan.keepUpdates[0]?.content).toContain(newHandoff.uri);
  });

  it('never consolidates same-topic handoffs from different monorepo package scopes', () => {
    const search = record({
      uri: 'threadnote://user/me/memories/handoffs/active/mobile-native/search.md',
      metadata: {timestamp: '2026-05-19T00:00:00.000Z', workspaceScope: 'apps/search'},
      body: 'task: search package status',
    });
    const billing = record({
      uri: 'threadnote://user/me/memories/handoffs/active/mobile-native/billing.md',
      metadata: {timestamp: '2026-05-21T00:00:00.000Z', workspaceScope: 'apps/billing'},
      body: 'task: billing package status',
    });

    const plan = buildCompactPlan([search, billing], {
      now: new Date('2026-05-22T00:00:00.000Z'),
      project: 'mobile-native',
    });

    expect([...plan.keepUpdates, ...plan.archives, ...plan.forgets]).toEqual([]);
    expect(plan.mergeReviewProposals).toEqual([
      expect.objectContaining({
        reason: 'same project/topic spans multiple workspace scopes',
        sourceUris: [billing.uri, search.uri].sort(),
      }),
    ]);
  });

  it('handles handoff groups with both duplicates and newer different content', () => {
    const duplicateA = record({
      uri: 'threadnote://user/me/memories/handoffs/active/mobile-native/threadnote-a.md',
      metadata: {timestamp: '2026-05-19T00:00:00.000Z'},
      body: 'task: old',
    });
    const duplicateB = record({
      uri: 'threadnote://user/me/memories/handoffs/active/mobile-native/threadnote-b.md',
      metadata: {timestamp: '2026-05-19T00:00:00.000Z'},
      body: 'task: old',
    });
    const latest = record({
      uri: 'threadnote://user/me/memories/handoffs/active/mobile-native/mobile-auth.md',
      metadata: {timestamp: '2026-05-21T00:00:00.000Z'},
      body: 'task: latest status',
    });

    const plan = buildCompactPlan([duplicateA, duplicateB, latest], {
      now: new Date('2026-05-22T00:00:00.000Z'),
      project: 'mobile-native',
    });

    expect(EffectArray.map(plan.keepUpdates, action => action.uri)).toEqual([latest.uri]);
    expect(EffectArray.map(plan.forgets, action => action.uri)).toEqual([duplicateB.uri]);
    expect(EffectArray.map(plan.archives, action => action.uri)).toEqual([duplicateA.uri]);
    expect(plan.keepUpdates[0]?.content).toContain(duplicateA.uri);
    expect(plan.keepUpdates[0]?.content).toContain(duplicateB.uri);
    expect(plan.keepUpdates[0]?.content).toContain(latest.uri);
  });

  it('leaves non-exact durable memories for manual review', () => {
    const left = record({
      uri: 'threadnote://user/me/memories/durable/projects/mobile-native/mobile-auth.md',
      headerTitle: 'MEMORY',
      metadata: {kind: 'durable', topic: 'mobile-auth'},
      body: 'Contract A.',
    });
    const right = record({
      uri: 'threadnote://user/me/memories/durable/projects/mobile-native/threadnote-new.md',
      headerTitle: 'MEMORY',
      metadata: {kind: 'durable', topic: 'mobile-auth', timestamp: '2026-05-21T00:00:00.000Z'},
      body: 'Contract B.',
    });

    const plan = buildCompactPlan([left, right], {project: 'mobile-native'});

    expect(plan.keepUpdates).toEqual([]);
    expect(plan.archives).toEqual([]);
    expect(plan.forgets).toEqual([]);
    expect(EffectArray.map(plan.manualReview, item => item.uri).sort()).toEqual([left.uri, right.uri].sort());
  });

  it('keeps the newest handoff content even when an older record owns the stable URI', () => {
    const oldStable = record({
      uri: 'threadnote://user/me/memories/handoffs/active/mobile-native/mobile-auth.md',
      metadata: {timestamp: '2026-05-19T00:00:00.000Z'},
      body: 'task: stale stable status',
    });
    const newestTimestamped = record({
      uri: 'threadnote://user/me/memories/handoffs/active/mobile-native/threadnote-new.md',
      metadata: {timestamp: '2026-05-21T00:00:00.000Z'},
      body: 'task: current status',
    });

    const plan = buildCompactPlan([oldStable, newestTimestamped], {
      now: new Date('2026-05-22T00:00:00.000Z'),
      project: 'mobile-native',
    });

    expect(EffectArray.map(plan.keepUpdates, action => action.uri)).toEqual([newestTimestamped.uri]);
    expect(EffectArray.map(plan.archives, action => action.uri)).toEqual([oldStable.uri]);
  });

  it('defers old handoffs with explicit pending language to manual review', () => {
    const stale = record({
      uri: 'threadnote://user/me/memories/handoffs/active/mobile-native/mobile-auth.md',
      metadata: {timestamp: '2026-05-01T00:00:00.000Z'},
      body: 'status: PR OPEN. Awaiting review.',
    });

    const plan = buildCompactPlan([stale], {now: new Date('2026-06-01T00:00:00.000Z'), project: 'mobile-native'});

    expect(plan.keepUpdates).toEqual([]);
    expect(plan.archives).toEqual([]);
    expect(plan.forgets).toEqual([]);
    expect(plan.manualReview).toEqual([
      {reason: '30-day handoff retention deferred by explicit pending/open/blocker language', uri: stale.uri},
    ]);
  });

  it('archives old generated handoffs with the default continuation while protecting authored next steps', () => {
    const generated = record({
      uri: 'threadnote://user/me/memories/handoffs/active/mobile-native/generated-default.md',
      metadata: {timestamp: '2026-07-01T00:00:00.000Z', topic: 'generated-default'},
      body: EffectArray.join(
        [
          'repo: mobile-native',
          'repo_path: /workspace/mobile-native',
          'branch: feature/mobile-auth',
          'commit: abc123',
          'task: unspecified',
          '',
          'files_touched:',
          '- none',
          '',
          'git_status:',
          '- clean',
          '',
          'diff_stat:',
          '- none',
          '',
          'tests:',
          '- not recorded',
          '',
          'blockers:',
          '- none recorded',
          '',
          'next_step:',
          `- ${DEFAULT_HANDOFF_NEXT_STEP}`,
        ],
        '\n',
      ),
    });
    const authored = record({
      uri: 'threadnote://user/me/memories/handoffs/active/mobile-native/authored-next-step.md',
      metadata: {timestamp: '2026-07-01T00:00:00.000Z', topic: 'authored-next-step'},
      body: 'blockers:\n- none recorded\n\nnext_step:\n- finish the signed migration and rerun CI',
    });

    const plan = buildCompactPlan([authored, generated], {
      now: new Date('2026-08-20T00:00:00.000Z'),
      project: 'mobile-native',
    });

    expect(EffectArray.map(plan.archives, action => action.uri)).toEqual([generated.uri]);
    expect(plan.manualReview).toEqual([
      {
        reason: '30-day handoff retention deferred by explicit pending/open/blocker language',
        uri: authored.uri,
      },
    ]);
  });

  it('archives active personal memories whose valid_to is expired', () => {
    const durable = record({
      uri: 'threadnote://user/me/memories/durable/projects/mobile-native/expired-contract.md',
      headerTitle: 'MEMORY',
      metadata: {
        kind: 'durable',
        topic: 'expired-contract',
        validTo: '2026-08-19T23:59:59.000Z',
      },
    });
    const incident = record({
      uri: 'threadnote://user/me/memories/incidents/active/mobile-native/expired-incident.md',
      headerTitle: 'MEMORY',
      metadata: {
        kind: 'incident',
        topic: 'expired-incident',
        validTo: '2026-08-20T00:00:00.000Z',
      },
    });

    const plan = buildCompactPlan([incident, durable], {
      now: new Date('2026-08-20T00:00:00.000Z'),
      project: 'mobile-native',
    });

    expect(EffectArray.map(plan.archives, action => action.uri)).toEqual([durable.uri, incident.uri]);
    expect(EffectArray.map(plan.archives, action => action.sourceUris)).toEqual([[durable.uri], [incident.uri]]);
    expect(plan.keepUpdates).toEqual([]);
    expect(plan.forgets).toEqual([]);
  });

  it('applies recoverable handoff retention and protects pending work', () => {
    const old = record({
      uri: 'threadnote://user/me/memories/handoffs/active/mobile-native/old.md',
      metadata: {timestamp: '2026-07-21T00:00:00.000Z', topic: 'old'},
    });
    const oldPending = record({
      uri: 'threadnote://user/me/memories/handoffs/active/mobile-native/old-pending.md',
      metadata: {timestamp: '2026-07-01T00:00:00.000Z', topic: 'old-pending'},
      body: 'Status: pending',
    });
    const terminalStatus = record({
      uri: 'threadnote://user/me/memories/handoffs/active/mobile-native/terminal-status.md',
      metadata: {timestamp: '2026-08-10T00:00:00.000Z', topic: 'terminal-status'},
      body: 'Status: completed\nBlockers: none',
    });
    const terminalNextStep = record({
      uri: 'threadnote://user/me/memories/handoffs/active/mobile-native/terminal-next-step.md',
      metadata: {timestamp: '2026-08-12T00:00:00.000Z', topic: 'terminal-next-step'},
      body: 'next_step:\nNone.',
    });
    const terminalButOpen = record({
      uri: 'threadnote://user/me/memories/handoffs/active/mobile-native/terminal-open.md',
      metadata: {timestamp: '2026-07-31T00:00:00.000Z', topic: 'terminal-open'},
      body: 'Status: completed\nThe pull request is open.',
    });
    const nonterminal = record({
      uri: 'threadnote://user/me/memories/handoffs/active/mobile-native/nonterminal.md',
      metadata: {timestamp: '2026-08-05T00:00:00.000Z', topic: 'nonterminal'},
    });
    const recentlyUpdated = record({
      uri: 'threadnote://user/me/memories/handoffs/active/mobile-native/recently-updated.md',
      metadata: {
        timestamp: '2026-06-01T00:00:00.000Z',
        topic: 'recently-updated',
        updatedAt: '2026-08-10T00:00:00.000Z',
      },
    });
    const recentlyReviewed = record({
      uri: 'threadnote://user/me/memories/handoffs/active/mobile-native/recently-reviewed.md',
      metadata: {
        lastReviewed: '2026-08-19T00:00:00.000Z',
        timestamp: '2026-06-01T00:00:00.000Z',
        topic: 'recently-reviewed',
      },
    });

    const plan = buildCompactPlan(
      [
        oldPending,
        terminalButOpen,
        recentlyUpdated,
        recentlyReviewed,
        terminalNextStep,
        nonterminal,
        old,
        terminalStatus,
      ],
      {now: new Date('2026-08-20T00:00:00.000Z'), project: 'mobile-native'},
    );

    expect(EffectArray.map(plan.archives, action => action.uri)).toEqual([
      old.uri,
      terminalNextStep.uri,
      terminalStatus.uri,
    ]);
    expect(plan.manualReview).toEqual([
      {reason: 'nonterminal active handoff is between 14 and 30 days old', uri: nonterminal.uri},
      {
        reason: '30-day handoff retention deferred by explicit pending/open/blocker language',
        uri: oldPending.uri,
      },
      {
        reason: 'nonterminal active handoff is between 14 and 30 days old',
        uri: terminalButOpen.uri,
      },
    ]);
    expect(
      EffectArray.some(
        [...plan.keepUpdates, ...plan.archives, ...plan.forgets, ...plan.manualReview],
        action => action.uri === recentlyUpdated.uri || action.uri === recentlyReviewed.uri,
      ),
    ).toBe(false);
  });

  it('never mutates shared records and proposes review across memory kinds and teams', () => {
    const personal = record({
      uri: 'threadnote://user/me/memories/durable/projects/mobile-native/auth.md',
      headerTitle: 'MEMORY',
      metadata: {kind: 'durable', topic: 'auth'},
      body: 'Personal contract.',
    });
    const sharedHandoff = record({
      uri: 'threadnote://user/me/memories/shared/team-a/handoffs/active/mobile-native/auth.md',
      metadata: {
        timestamp: '2026-06-01T00:00:00.000Z',
        topic: 'auth',
        validTo: '2026-07-01T00:00:00.000Z',
        visibility: 'shared',
      },
      body: 'Status: completed',
    });
    const otherTeam = record({
      uri: 'threadnote://user/me/memories/shared/team-b/durable/projects/mobile-native/auth.md',
      headerTitle: 'MEMORY',
      metadata: {kind: 'durable', topic: 'auth', visibility: 'shared'},
      body: 'Team contract.',
    });

    const plan = buildCompactPlan([otherTeam, personal, sharedHandoff], {
      now: new Date('2026-08-20T00:00:00.000Z'),
      project: 'mobile-native',
    });

    const mutationUris = EffectArray.map(
      [...plan.keepUpdates, ...plan.archives, ...plan.forgets],
      action => action.uri,
    );
    expect(mutationUris).not.toContain(sharedHandoff.uri);
    expect(mutationUris).not.toContain(otherTeam.uri);
    expect(plan.mergeReviewProposals).toEqual([
      {
        project: 'mobile-native',
        reason:
          'divergent active durable memories; same project/topic spans multiple memory kinds; same project/topic spans multiple memory scopes',
        sourceUris: [personal.uri, otherTeam.uri, sharedHandoff.uri].sort(),
        topic: 'auth',
      },
    ]);
  });

  it('proposes non-mutating review for divergent durable and incident memories', () => {
    const records = [
      record({
        uri: 'threadnote://user/me/memories/durable/projects/mobile-native/contract-a.md',
        headerTitle: 'MEMORY',
        metadata: {kind: 'durable', topic: 'contract'},
        body: 'Contract A.',
      }),
      record({
        uri: 'threadnote://user/me/memories/durable/projects/mobile-native/contract-b.md',
        headerTitle: 'MEMORY',
        metadata: {kind: 'durable', topic: 'contract'},
        body: 'Contract B.',
      }),
      record({
        uri: 'threadnote://user/me/memories/incidents/active/mobile-native/outage-a.md',
        headerTitle: 'MEMORY',
        metadata: {kind: 'incident', topic: 'outage'},
        body: 'Cause A.',
      }),
      record({
        uri: 'threadnote://user/me/memories/incidents/active/mobile-native/outage-b.md',
        headerTitle: 'MEMORY',
        metadata: {kind: 'incident', topic: 'outage'},
        body: 'Cause B.',
      }),
    ];

    const plan = buildCompactPlan(records, {project: 'mobile-native'});

    expect(plan.mergeReviewProposals).toEqual([
      {
        project: 'mobile-native',
        reason: 'divergent active durable memories',
        sourceUris: EffectArray.map(records.slice(0, 2), item => item.uri).sort(),
        topic: 'contract',
      },
      {
        project: 'mobile-native',
        reason: 'divergent active incident memories',
        sourceUris: EffectArray.map(records.slice(2), item => item.uri).sort(),
        topic: 'outage',
      },
    ]);
    expect([...plan.keepUpdates, ...plan.archives, ...plan.forgets]).toEqual([]);
  });

  it('is deterministic under input permutation and never schedules one URI twice', () => {
    const records = [
      record({
        uri: 'threadnote://user/me/memories/durable/projects/mobile-native/auth.md',
        headerTitle: 'MEMORY',
        metadata: {kind: 'durable', topic: 'auth'},
        body: 'Contract A.',
      }),
      record({
        uri: 'threadnote://user/me/memories/durable/projects/mobile-native/threadnote-copy.md',
        headerTitle: 'MEMORY',
        metadata: {kind: 'durable', topic: 'auth', timestamp: '2026-05-19T00:00:00.000Z'},
        body: 'Contract A.',
      }),
      record({
        uri: 'threadnote://user/me/memories/durable/projects/mobile-native/threadnote-divergent.md',
        headerTitle: 'MEMORY',
        metadata: {kind: 'durable', topic: 'auth', timestamp: '2026-05-21T00:00:00.000Z'},
        body: 'Contract B.',
      }),
      record({
        uri: 'threadnote://user/me/memories/shared/team-a/durable/projects/mobile-native/auth.md',
        headerTitle: 'MEMORY',
        metadata: {kind: 'durable', topic: 'auth', visibility: 'shared'},
        body: 'Team contract.',
      }),
      record({
        uri: 'threadnote://user/me/memories/handoffs/active/mobile-native/expired.md',
        metadata: {topic: 'expired', validTo: '2026-08-01T00:00:00.000Z'},
      }),
    ];
    const options = {now: new Date('2026-08-20T00:00:00.000Z'), project: 'mobile-native'} as const;
    const expected = buildCompactPlan(records, options);

    fc.assert(
      fc.property(fc.shuffledSubarray(records, {maxLength: records.length, minLength: records.length}), permutation => {
        const plan = buildCompactPlan(permutation, options);
        expect(plan).toEqual(expected);
        const mutationUris = EffectArray.map(
          [...plan.keepUpdates, ...plan.archives, ...plan.forgets],
          action => action.uri,
        );
        expect(new Set(mutationUris).size).toBe(mutationUris.length);
      }),
      {numRuns: 50},
    );
  });
});

describe('memoryContentWithHygieneSources', () => {
  it('strips self-supersedes while preserving source URIs', () => {
    const uri = 'threadnote://user/me/memories/handoffs/active/mobile-native/mobile-auth.md';
    const input = record({
      content: EffectArray.join(
        [
          'HANDOFF',
          'kind: handoff',
          'status: active',
          'project: mobile-native',
          'topic: mobile-auth',
          'source_agent_client: codex',
          'timestamp: 2026-05-20T00:00:00.000Z',
          `supersedes: ${uri}`,
          '',
          'task: latest status',
        ],
        '\n',
      ),
      uri,
    });

    const output = memoryContentWithHygieneSources(input, [uri]);

    expect(output).not.toContain('supersedes:');
    expect(output).toContain('<!-- threadnote:hygiene-sources:v1 -->');
    expect(output).toContain('## Threadnote Hygiene Sources');
    expect(output).toContain(`- ${uri}`);
  });

  it('cumulatively preserves prior hygiene source URIs', () => {
    const uri = 'threadnote://user/me/memories/handoffs/active/mobile-native/mobile-auth.md';
    const firstSource = 'threadnote://user/me/memories/handoffs/active/mobile-native/first.md';
    const secondSource = 'threadnote://user/me/memories/handoffs/active/mobile-native/second.md';
    const initial = record({uri, body: 'task: latest status'});
    const firstContent = memoryContentWithHygieneSources(initial, [uri, firstSource]);
    const firstRecord = parseMemoryDocument(uri, firstContent);
    expect(firstRecord).toBeDefined();

    const secondContent = memoryContentWithHygieneSources(firstRecord!, [uri, secondSource]);

    expect(secondContent).toContain(`- ${firstSource}`);
    expect(secondContent).toContain(`- ${secondSource}`);
    expect(
      Effect.pipe(
        secondContent,
        EffectString.match(/## Threadnote Hygiene Sources/g),
        Effect.Option.getOrElse(() => null),
      ),
    ).toHaveLength(1);
  });
});

describe('recallHygieneNudges', () => {
  it('returns no hint below thresholds', () => {
    const text = EffectArray.join(
      [
        'threadnote://user/me/memories/handoffs/active/mobile-native/a.md',
        'threadnote://user/me/memories/handoffs/active/mobile-native/b.md',
      ],
      '\n',
    );

    expect(recallHygieneNudges(text, {user: 'me'})).toEqual([]);
  });

  it('nudges for overlapping active memories', () => {
    const records = EffectArray.map([1, 2, 3], index =>
      record({
        uri: `threadnote://user/me/memories/handoffs/active/mobile-native/threadnote-${index}.md`,
      }),
    );

    expect(
      recallHygieneNudges(
        EffectArray.join(
          EffectArray.map(records, item => item.uri),
          '\n',
        ),
        {records, user: 'me'},
      ),
    ).toEqual([
      '3 active handoffs look overlapping for mobile-native/mobile-auth; run compact_context({"project":"mobile-native","topic":"mobile-auth","dryRun":true}).',
    ]);
  });

  it('nudges for many active project handoffs but ignores archived/shared/resources', () => {
    const active = Array.from(
      {length: 10},
      (_, index) => `threadnote://user/me/memories/handoffs/active/mobile-native/topic-${index}.md`,
    );
    const ignored = [
      'threadnote://user/me/memories/handoffs/archived/mobile-native/topic.md',
      'threadnote://user/me/memories/shared/default/durable/projects/mobile-native/topic.md',
      'threadnote://resources/repos/mobile-native/README.md',
    ];

    expect(recallHygieneNudges(EffectArray.join([...active, ...ignored], '\n'), {user: 'me'})).toEqual([
      'Many active handoffs surfaced for mobile-native; run compact_context({"project":"mobile-native","dryRun":true}).',
    ]);
  });
});

describe('handoffTopicForBranch', () => {
  it('defaults bare handoffs to the current branch topic', () => {
    expect(handoffTopicForBranch('mobile-auth', {})).toBe('mobile-auth');
  });

  it('keeps timestamped handoffs opt-in', () => {
    expect(handoffTopicForBranch('mobile-auth', {timestamped: true})).toBeUndefined();
  });

  it('rejects timestamped handoffs with explicit topic', () => {
    expect(() => handoffTopicForBranch('mobile-auth', {timestamped: true, topic: 'feature'})).toThrow(
      'Cannot combine --timestamped with --topic.',
    );
  });
});

describe('formatCompactPlan', () => {
  it('prints the scoped dry-run plan', () => {
    const plan = buildCompactPlan(
      [
        record({
          uri: 'threadnote://user/me/memories/handoffs/active/mobile-native/old.md',
          metadata: {timestamp: '2026-05-19T00:00:00.000Z'},
          body: 'task: old',
        }),
        record({
          uri: 'threadnote://user/me/memories/handoffs/active/mobile-native/mobile-auth.md',
          metadata: {timestamp: '2026-05-20T00:00:00.000Z'},
          body: 'task: new',
        }),
      ],
      {now: new Date('2026-05-22T00:00:00.000Z'), project: 'mobile-native'},
    );

    expect(formatCompactPlan(plan, {apply: false})).toContain('Dry-run memory hygiene plan for project mobile-native');
    expect(formatCompactPlan(plan, {apply: false})).toContain('Archive expired/stale active memories');
    expect(formatCompactPlan(plan, {apply: false})).toContain(
      'sources: threadnote://user/me/memories/handoffs/active/mobile-native/old.md',
    );
    expect(formatCompactPlan(plan, {apply: false})).toContain('Merge/review proposals');
  });

  it('bounds large plan sections while retaining exact counts', () => {
    const records = Array.from({length: 40}, (_, index) =>
      record({
        uri: `threadnote://user/me/memories/handoffs/active/mobile-native/stale-${index}.md`,
        metadata: {timestamp: '2026-06-01T00:00:00.000Z', topic: `stale-${index}`},
      }),
    );
    const plan = buildCompactPlan(records, {
      now: new Date('2026-08-20T00:00:00.000Z'),
      project: 'mobile-native',
    });

    const output = formatCompactPlan(plan, {apply: false});

    expect(output).toContain('Archive expired/stale active memories (40):');
    expect(output).toContain('… 15 more omitted; narrow the plan with kind or topic');
    expect(output).not.toContain('stale-39.md');
  });
});

describe('references relation', () => {
  it('parses multiple references: header lines into metadata.references', () => {
    const content = EffectArray.join(
      [
        'HANDOFF',
        'kind: handoff',
        'status: active',
        'project: threadnote',
        'topic: my-branch',
        'source_agent_client: codex',
        'timestamp: 2026-07-02T00:00:00.000Z',
        'references: threadnote://user/me/memories/durable/projects/threadnote/design.md',
        'references: threadnote://user/me/memories/handoffs/active/threadnote/prior.md',
        '',
        'task: keep going',
      ],
      '\n',
    );
    const parsed = parseMemoryDocument(
      'threadnote://user/me/memories/handoffs/active/threadnote/my-branch.md',
      content,
    );
    expect(parsed?.metadata.references).toEqual([
      'threadnote://user/me/memories/durable/projects/threadnote/design.md',
      'threadnote://user/me/memories/handoffs/active/threadnote/prior.md',
    ]);
  });

  it('leaves references undefined when absent', () => {
    const content = EffectArray.join(['MEMORY', 'kind: durable', 'status: active', 'project: x', '', 'body'], '\n');
    const parsed = parseMemoryDocument('threadnote://user/me/memories/durable/projects/x/a.md', content);
    expect(parsed?.metadata.references).toBeUndefined();
  });

  it('collects referenced uris off records, skipping ones already surfaced', () => {
    const withRefs = record({
      uri: 'threadnote://user/me/memories/handoffs/active/threadnote/branch.md',
      metadata: {
        references: [
          'threadnote://user/me/memories/durable/projects/threadnote/design.md',
          'threadnote://user/me/memories/durable/projects/threadnote/shown.md',
        ],
      },
    });
    const recallOutput = 'surfaced: threadnote://user/me/memories/durable/projects/threadnote/shown.md';
    expect(referencedUrisFromRecords([withRefs], recallOutput)).toEqual([
      'threadnote://user/me/memories/durable/projects/threadnote/design.md',
    ]);
  });

  it('keeps only reference candidates that still resolve to memory records', () => {
    const first = 'threadnote://user/me/memories/durable/projects/threadnote/first.md';
    const missing = 'threadnote://user/me/memories/durable/projects/threadnote/missing.md';
    const second = 'threadnote://user/me/memories/durable/projects/threadnote/second.md';

    expect(
      existingReferencedUris(
        [first, missing, second],
        [record({uri: second, metadata: {kind: 'durable'}}), record({uri: first, metadata: {kind: 'durable'}})],
      ),
    ).toEqual([first, second]);
  });

  it('renders bounded URI-only pointers without referenced memory bodies', () => {
    expect(
      formatReferencedContextPointers(
        [
          'threadnote://user/me/memories/durable/projects/threadnote/first.md',
          'threadnote://user/me/memories/durable/projects/threadnote/second.md',
        ],
        1,
      ),
    ).toBe(
      EffectArray.join(
        [
          'Referenced read-only context (one-way pointers from surfaced memories):',
          '- threadnote://user/me/memories/durable/projects/threadnote/first.md',
          '- … 1 more referenced memory omitted',
        ],
        '\n',
      ),
    );
  });
});
