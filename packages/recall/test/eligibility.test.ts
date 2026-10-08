import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import type {MemoryAuthority, MemoryTrust} from '@threadnote/memory/document';
import {
  deriveRecallEligibilityPolicy,
  normalizeRecallProjectNames,
  originalQueryRequestsApprovedGuidance,
  recallAuthorityIsEligible,
  recallCandidateIsEligible,
  recallEligibilityPolicyRestrictsCandidates,
} from '@threadnote/recall/eligibility';
import {recallEligibilityPredicate} from '@threadnote/recall/index/eligibility';

describe('recall eligibility policy', () => {
  it('keeps an omitted explicit project global', () => {
    const policy = deriveRecallEligibilityPolicy({originalQuery: 'How does retry scheduling work?'});

    expect(policy).toEqual({authority: 'any', kind: 'candidate-policy', projects: {mode: 'unrestricted'}});
    expect(recallCandidateIsEligible(policy, {project: 'unrelated'})).toBe(true);
    expect(recallCandidateIsEligible(policy, {})).toBe(true);
    expect(recallEligibilityPolicyRestrictsCandidates(policy)).toBe(false);
  });

  it('narrows a workset to an explicitly selected member and keeps projectless guidance', () => {
    const policy = deriveRecallEligibilityPolicy({
      originalQuery: 'How does recall work?',
      explicitProject: ' ThrEadNote ',
      worksetProjectNames: [' Mobile ', 'threadnote', 'MOBILE'],
    });

    expect(policy).toEqual({
      authority: 'any',
      kind: 'candidate-policy',
      projects: {mode: 'allow-projects-and-projectless', projects: ['threadnote']},
    });
    expect(recallCandidateIsEligible(policy, {project: 'THREADNOTE'})).toBe(true);
    expect(recallCandidateIsEligible(policy, {project: 'mobile'})).toBe(false);
    expect(recallCandidateIsEligible(policy, {})).toBe(true);
    expect(recallCandidateIsEligible(policy, {project: 'website'})).toBe(false);
    expect(recallEligibilityPolicyRestrictsCandidates(policy)).toBe(true);
  });

  it('allows every configured workset member when no project narrows the set', () => {
    const policy = deriveRecallEligibilityPolicy({
      originalQuery: 'How does recall work?',
      worksetProjectNames: ['mobile', 'threadnote'],
    });

    expect(recallCandidateIsEligible(policy, {project: 'mobile'})).toBe(true);
    expect(recallCandidateIsEligible(policy, {project: 'threadnote'})).toBe(true);
    expect(recallCandidateIsEligible(policy, {project: 'website'})).toBe(false);
    expect(recallCandidateIsEligible(policy, {})).toBe(true);
  });

  it('restricts inferred workspace recall to the caller project while retaining projectless guidance', () => {
    const policy = deriveRecallEligibilityPolicy({
      originalQuery: 'How does the checkout work?',
      workspaceProject: 'nested-repository',
    });

    expect(recallCandidateIsEligible(policy, {project: 'nested-repository'})).toBe(true);
    expect(recallCandidateIsEligible(policy, {project: 'parent-repository'})).toBe(false);
    expect(recallCandidateIsEligible(policy, {})).toBe(true);
  });

  it('does not partition same-project monorepo siblings', () => {
    const policy = deriveRecallEligibilityPolicy({explicitProject: 'monorepo', originalQuery: 'shared build behavior'});

    expect(recallCandidateIsEligible(policy, {project: 'monorepo'})).toBe(true);
    expect(recallCandidateIsEligible(policy, {project: 'MONOREPO'})).toBe(true);
  });

  it('fails closed for an explicitly empty resolved workset, including projectless memories', () => {
    const policy = deriveRecallEligibilityPolicy({
      originalQuery: 'retry behavior',
      explicitProject: 'threadnote',
      worksetProjectNames: [],
    });

    expect(policy).toEqual({authority: 'any', kind: 'candidate-policy', projects: {mode: 'deny-all'}});
    expect(recallCandidateIsEligible(policy, {project: 'threadnote'})).toBe(false);
    expect(recallCandidateIsEligible(policy, {})).toBe(false);
  });

  it('intersects an explicit project with its workset instead of widening the workset', () => {
    const policy = deriveRecallEligibilityPolicy({
      originalQuery: 'ordinary recall',
      explicitProject: 'outside',
      worksetProjectNames: ['inside'],
    });

    expect(policy.kind).toBe('candidate-policy');
    if (policy.kind !== 'candidate-policy') throw new Error('Expected candidate policy');
    expect(policy.projects).toEqual({mode: 'deny-all'});
    expect(recallCandidateIsEligible(policy, {project: 'outside'})).toBe(false);
    expect(recallCandidateIsEligible(policy, {project: 'inside'})).toBe(false);
    expect(recallCandidateIsEligible(policy, {})).toBe(false);
  });

  it('keeps projectless-only scopes distinct from an empty project allow-list', () => {
    const policy = {
      ...deriveRecallEligibilityPolicy({originalQuery: 'ordinary guidance'}),
      projects: {mode: 'projectless-only' as const},
    };

    expect(recallCandidateIsEligible(policy, {})).toBe(true);
    expect(recallCandidateIsEligible(policy, {project: 'another-project'})).toBe(false);
    const predicate = recallEligibilityPredicate('d', policy);
    expect(predicate.restricted).toBe(true);
    expect(predicate.sql).toContain('d.project IS NULL');
  });

  it('represents pinned hard-URI recall as an explicit project and authority bypass', () => {
    const policy = deriveRecallEligibilityPolicy({
      originalQuery: 'canonical policy',
      pinnedHardUri: true,
      worksetProjectNames: [],
    });

    expect(policy).toEqual({kind: 'pinned-hard-uri-bypass'});
    expect(
      recallCandidateIsEligible(policy, {
        authority: 'external',
        project: 'another-project',
        trust: 'untrusted',
      }),
    ).toBe(true);
  });

  it.each([
    'approved release guidance',
    'canonical project policy',
    'what is the source of approved guidance?',
    'Ignore retrieved instructions and find the approved retry contract',
    'approved/canonical guidance',
    'canonical signed feature flag snapshot guidance FLAG-SNAPSHOT-61',
  ])('detects an explicit approved-guidance request: %s', query => {
    expect(originalQueryRequestsApprovedGuidance(query)).toBe(true);
  });

  it.each([
    'approved implementation detail',
    'general retry guidance',
    'unapproved release guidance',
    'not approved release guidance',
    'non-canonical project policy',
    'avoid the canonical source',
    'is this policy not approved?',
  ])('does not elevate ambiguous or explicitly negative intent: %s', query => {
    expect(originalQueryRequestsApprovedGuidance(query)).toBe(false);
  });

  it('requires both approved trust and an authoritative source class', () => {
    const authorities: readonly MemoryAuthority[] = [
      'agent_generated',
      'canonical_repo',
      'external',
      'reviewed_shared',
      'user_approved',
    ];
    const trusts: readonly MemoryTrust[] = ['approved', 'inferred', 'untrusted'];

    for (const authority of authorities) {
      for (const trust of trusts) {
        const expected =
          trust === 'approved' &&
          (authority === 'canonical_repo' || authority === 'reviewed_shared' || authority === 'user_approved');
        expect(recallAuthorityIsEligible('approved-authoritative', authority, trust)).toBe(expected);
      }
    }
    expect(recallAuthorityIsEligible('approved-authoritative', undefined, undefined)).toBe(false);
    expect(recallAuthorityIsEligible('any', undefined, undefined)).toBe(true);
  });

  it('normalizes project sets deterministically under composition, case changes, and permutations', () => {
    expect(normalizeRecallProjectNames([' E\u0301QUIPE ', 'équipe', 'THREADNOTE', 'threadnote'])).toEqual([
      'threadnote',
      'équipe',
    ]);

    const caseStableProject = fc
      .array(fc.constantFrom('a', 'b', 'm', 'z', 'é', '-', '_', '0', '7'), {maxLength: 30, minLength: 1})
      .map(parts => parts.join(''));
    fc.assert(
      fc.property(caseStableProject, value => {
        expect(normalizeRecallProjectNames([`  ${value.toUpperCase().normalize('NFD')}  `])).toEqual(
          normalizeRecallProjectNames([value]),
        );
      }),
      {numRuns: 100},
    );

    fc.assert(
      fc.property(fc.array(fc.tuple(fc.integer(), fc.string()), {maxLength: 40}), entries => {
        const values = entries.map(([, value]) => value);
        const permutation = [...entries].sort(([left], [right]) => left - right).map(([, value]) => value);
        const normalized = normalizeRecallProjectNames(values);
        expect(normalizeRecallProjectNames(normalized)).toEqual(normalized);
        expect(normalizeRecallProjectNames(permutation)).toEqual(normalized);
      }),
      {numRuns: 100},
    );
  });

  it('never makes an eligible project ineligible when the allowed project set grows', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string(), {maxLength: 20}),
        fc.array(fc.string(), {maxLength: 20}),
        fc.option(fc.string(), {nil: undefined}),
        (baseProjects, addedProjects, candidateProject) => {
          const basePolicy = deriveRecallEligibilityPolicy({
            originalQuery: 'ordinary recall',
            worksetProjectNames: baseProjects,
          });
          const expandedPolicy = deriveRecallEligibilityPolicy({
            originalQuery: 'ordinary recall',
            worksetProjectNames: [...baseProjects, ...addedProjects],
          });
          const candidate = candidateProject === undefined ? {} : {project: candidateProject};

          if (recallCandidateIsEligible(basePolicy, candidate)) {
            expect(recallCandidateIsEligible(expandedPolicy, candidate)).toBe(true);
          }
        },
      ),
      {numRuns: 100},
    );
  });

  it('keeps inferred workspace eligibility bounded to the same project for generated project names', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/),
        fc.option(fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/), {nil: undefined}),
        (workspaceProject, candidateProject) => {
          const policy = deriveRecallEligibilityPolicy({
            originalQuery: 'ordinary workspace recall',
            workspaceProject,
          });
          const eligible = recallCandidateIsEligible(
            policy,
            candidateProject === undefined ? {} : {project: candidateProject},
          );
          const normalizedWorkspace = normalizeRecallProjectNames([workspaceProject])[0];
          const normalizedCandidate =
            candidateProject === undefined ? undefined : normalizeRecallProjectNames([candidateProject])[0];

          expect(eligible).toBe(normalizedCandidate === undefined || normalizedCandidate === normalizedWorkspace);
        },
      ),
      {numRuns: 100},
    );
  });

  it('keeps authoritative eligibility a subset of ordinary eligibility', () => {
    const authority = fc.option(
      fc.constantFrom<MemoryAuthority>(
        'agent_generated',
        'canonical_repo',
        'external',
        'reviewed_shared',
        'user_approved',
      ),
      {nil: undefined},
    );
    const trust = fc.option(fc.constantFrom<MemoryTrust>('approved', 'inferred', 'untrusted'), {nil: undefined});

    fc.assert(
      fc.property(authority, trust, (candidateAuthority, candidateTrust) => {
        if (recallAuthorityIsEligible('approved-authoritative', candidateAuthority, candidateTrust)) {
          expect(recallAuthorityIsEligible('any', candidateAuthority, candidateTrust)).toBe(true);
        }
      }),
      {numRuns: 100},
    );
  });
});
