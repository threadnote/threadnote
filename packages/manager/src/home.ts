export type ManagerHomeAction = 'context' | 'context-health' | 'reviews';
export type ManagerHomeLaneStatus = 'attention' | 'clear' | 'unavailable';

export interface ManagerHomeLane {
  readonly action: ManagerHomeAction;
  readonly count?: number;
  readonly detail: string;
  readonly id: 'health' | 'reviews' | 'value';
  readonly status: ManagerHomeLaneStatus;
  readonly title: string;
}

export interface ManagerHomeLaneInput {
  readonly health?: {
    readonly findingCount: number;
    readonly status: 'clean' | 'findings' | 'unknown';
    readonly decisionMemories?: number;
    readonly automaticCount?: number;
    readonly coverage?: 'complete' | 'partial' | 'unavailable';
  };
  readonly reviews?: {readonly pendingCount: number};
  readonly value?: {readonly applied: number; readonly reviewed: number; readonly useful: number};
}

/**
 * Builds a small, content-free Manager landing model. The stable order lets the
 * UI preserve focus and makes each independently observed lane easy to test.
 */
export function managerHomeLanes(input: ManagerHomeLaneInput): readonly ManagerHomeLane[] {
  const reviews = input.reviews;
  const health = input.health;
  const value = input.value;
  const decisions = health?.decisionMemories ?? health?.findingCount;
  const modernHealth = health?.decisionMemories !== undefined;
  return [
    {
      action: 'reviews',
      ...(reviews === undefined ? {} : {count: reviews.pendingCount}),
      detail:
        reviews === undefined
          ? 'Review evidence is unavailable. Retry from the review inbox.'
          : reviews.pendingCount === 0
            ? 'No pending knowledge reviews.'
            : `${reviews.pendingCount} knowledge ${reviews.pendingCount === 1 ? 'review needs' : 'reviews need'} attention.`,
      id: 'reviews',
      status: reviews === undefined ? 'unavailable' : reviews.pendingCount > 0 ? 'attention' : 'clear',
      title: 'Review inbox',
    },
    {
      action: 'context-health',
      ...(health === undefined ? {} : {count: decisions}),
      detail: modernHealth
        ? `${decisions === 0 ? 'No decisions need you' : `${decisions} ${decisions === 1 ? 'memory needs' : 'memories need'} your decision`}; ${health?.coverage === 'complete' ? 'required evidence checks complete' : 'evidence checks incomplete'}. ${health?.automaticCount ?? 0} checks handled automatically.`
        : health === undefined || health.status === 'unknown'
          ? 'Health coverage is unavailable or incomplete.'
          : health.status === 'clean'
            ? 'Current project records have no actionable findings.'
            : `${health.findingCount} context ${health.findingCount === 1 ? 'finding' : 'findings'} need review.`,
      id: 'health',
      status: modernHealth
        ? (decisions ?? 0) > 0
          ? 'attention'
          : health?.coverage === 'complete'
            ? 'clear'
            : 'unavailable'
        : health === undefined || health.status === 'unknown'
          ? 'unavailable'
          : health.status === 'findings'
            ? 'attention'
            : 'clear',
      title: 'Context health',
    },
    {
      action: 'context',
      ...(value === undefined ? {} : {count: value.applied + value.reviewed + value.useful}),
      detail:
        value === undefined
          ? 'Recent value evidence is unavailable.'
          : value.applied + value.reviewed + value.useful === 0
            ? 'No applied, useful, or reviewed outcomes in the last 30 days.'
            : `${value.applied} applied, ${value.useful} useful, and ${value.reviewed} reviewed outcomes in the last 30 days.`,
      id: 'value',
      status: value === undefined ? 'unavailable' : 'clear',
      title: 'Recent value',
    },
  ];
}
