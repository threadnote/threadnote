import type {MemoryAuthority, MemoryTrust} from '@threadnote/memory/document';

export type RecallAuthorityEligibility = 'any' | 'approved-authoritative';

export type RecallProjectEligibility =
  | {readonly mode: 'unrestricted'}
  | {readonly mode: 'allow-projects-and-projectless'; readonly projects: readonly string[]}
  | {readonly mode: 'projectless-only'}
  | {readonly mode: 'deny-all'};

/**
 * Pinned reads already have a hard URI boundary. They deliberately bypass the
 * project and authority policy, while ordinary recall filters candidate
 * metadata through the candidate-policy branch.
 */
export type RecallEligibilityPolicy =
  | {readonly kind: 'pinned-hard-uri-bypass'}
  | {
      readonly authority: RecallAuthorityEligibility;
      readonly kind: 'candidate-policy';
      readonly projects: RecallProjectEligibility;
    };

export interface DeriveRecallEligibilityPolicyInput {
  /** The user-authored query before expansion or rewriting. */
  readonly originalQuery: string;
  /** Whether a separate hard URI boundary governs this recall. */
  readonly pinnedHardUri?: boolean;
  /** Caller-supplied project. */
  readonly explicitProject?: string;
  /** Project resolved from the caller workspace or manifest; unrelated projects stay ineligible. */
  readonly workspaceProject?: string;
  /** Undefined means no workset; an explicitly empty resolved workset fails closed. */
  readonly worksetProjectNames?: readonly string[];
}

export interface RecallEligibilityCandidateMetadata {
  readonly authority?: MemoryAuthority;
  readonly project?: string;
  readonly trust?: MemoryTrust;
}

export interface RecallEligibilityRankCandidate {
  readonly authority?: MemoryAuthority;
  readonly fields?: {readonly project?: string};
  readonly trust?: MemoryTrust;
}

const APPROVED_AUTHORITIES: ReadonlySet<MemoryAuthority> = new Set([
  'canonical_repo',
  'reviewed_shared',
  'user_approved',
]);
const AUTHORITY_INTENT_TERMS = new Set(['approved', 'canonical']);
const GUIDANCE_INTENT_TERMS = new Set([
  'contract',
  'contracts',
  'decision',
  'decisions',
  'guidance',
  'policies',
  'policy',
  'source',
  'sources',
]);
const NEGATIVE_INTENT_TERMS = new Set([
  'avoid',
  'avoiding',
  'exclude',
  'excluding',
  'ignore',
  'never',
  'no',
  'non',
  'nonapproved',
  'noncanonical',
  'not',
  'reject',
  'rejecting',
  'unapproved',
  'uncanonical',
  'without',
]);
const QUERY_CLAUSE_BOUNDARY = /[.!?;,]+|\b(?:and|but|then)\b/iu;
const QUERY_WORD = /[\p{L}\p{N}_]+/gu;
const MAX_INTENT_TERM_DISTANCE = 8;

export function normalizeRecallProject(value: string | undefined): string | undefined {
  const normalized = value?.normalize('NFC').trim().toLowerCase().normalize('NFC');
  return normalized ? normalized : undefined;
}

export function normalizeRecallProjectNames(values: readonly string[]): readonly string[] {
  const normalized = new Set<string>();
  for (const value of values) {
    const project = normalizeRecallProject(value);
    if (project !== undefined) normalized.add(project);
  }
  return [...normalized].sort(compareText);
}

/**
 * Detects an explicit request for approved/canonical guidance. Callers must
 * pass only the original user query, never an AI-generated rewrite.
 */
export function originalQueryRequestsApprovedGuidance(originalQuery: string): boolean {
  const clauses = originalQuery.normalize('NFC').toLowerCase().split(QUERY_CLAUSE_BOUNDARY);
  return clauses.some(clause => {
    const terms = clause.match(QUERY_WORD) ?? [];
    if (terms.some(term => NEGATIVE_INTENT_TERMS.has(term))) return false;
    const authorityIndexes = termIndexes(terms, AUTHORITY_INTENT_TERMS);
    const guidanceIndexes = termIndexes(terms, GUIDANCE_INTENT_TERMS);
    return authorityIndexes.some(authorityIndex =>
      guidanceIndexes.some(guidanceIndex => Math.abs(authorityIndex - guidanceIndex) <= MAX_INTENT_TERM_DISTANCE),
    );
  });
}

export function deriveRecallEligibilityPolicy(input: DeriveRecallEligibilityPolicyInput): RecallEligibilityPolicy {
  if (input.pinnedHardUri === true) return {kind: 'pinned-hard-uri-bypass'};

  const authority = originalQueryRequestsApprovedGuidance(input.originalQuery) ? 'approved-authoritative' : 'any';
  const resolvedWorksetProjects =
    input.worksetProjectNames === undefined ? undefined : normalizeRecallProjectNames(input.worksetProjectNames);
  const explicitProject = normalizeRecallProjectNames(
    input.explicitProject === undefined ? [] : [input.explicitProject],
  );
  const workspaceProject = normalizeRecallProjectNames(
    input.workspaceProject === undefined ? [] : [input.workspaceProject],
  );
  const projects =
    resolvedWorksetProjects === undefined
      ? explicitProject[0] === undefined
        ? workspaceProject
        : explicitProject
      : explicitProject[0] === undefined
        ? resolvedWorksetProjects
        : resolvedWorksetProjects.filter(project => project === explicitProject[0]);

  const projectEligibility: RecallProjectEligibility =
    resolvedWorksetProjects !== undefined && projects.length === 0
      ? {mode: 'deny-all'}
      : projects.length === 0
        ? {mode: 'unrestricted'}
        : {mode: 'allow-projects-and-projectless', projects};

  return {authority, kind: 'candidate-policy', projects: projectEligibility};
}

export function recallProjectIsEligible(policy: RecallProjectEligibility, project: string | undefined): boolean {
  if (policy.mode === 'deny-all') return false;
  if (policy.mode === 'unrestricted') return true;
  const normalizedProject = normalizeRecallProject(project);
  if (policy.mode === 'projectless-only') return normalizedProject === undefined;
  return normalizedProject === undefined || policy.projects.includes(normalizedProject);
}

export function recallAuthorityIsEligible(
  policy: RecallAuthorityEligibility,
  authority: MemoryAuthority | undefined,
  trust: MemoryTrust | undefined,
): boolean {
  return policy === 'any' || (trust === 'approved' && authority !== undefined && APPROVED_AUTHORITIES.has(authority));
}

/** The pinned branch assumes the independent hard URI check already passed. */
export function recallCandidateIsEligible(
  policy: RecallEligibilityPolicy,
  candidate: RecallEligibilityCandidateMetadata,
): boolean {
  return (
    policy.kind === 'pinned-hard-uri-bypass' ||
    (recallProjectIsEligible(policy.projects, candidate.project) &&
      recallAuthorityIsEligible(policy.authority, candidate.authority, candidate.trust))
  );
}

export function recallRankCandidateIsEligible(
  policy: RecallEligibilityPolicy,
  candidate: RecallEligibilityRankCandidate,
): boolean {
  return recallCandidateIsEligible(policy, {
    authority: candidate.authority,
    project: candidate.fields?.project,
    trust: candidate.trust,
  });
}

export function recallEligibilityPolicyRestrictsCandidates(policy: RecallEligibilityPolicy | undefined): boolean {
  return policy?.kind === 'candidate-policy' && (policy.authority !== 'any' || policy.projects.mode !== 'unrestricted');
}

function termIndexes(terms: readonly string[], accepted: ReadonlySet<string>): readonly number[] {
  const indexes: number[] = [];
  for (const [index, term] of terms.entries()) {
    if (accepted.has(term)) indexes.push(index);
  }
  return indexes;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
