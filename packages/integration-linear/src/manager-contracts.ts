export interface LinearSource {
  readonly id: string;
  readonly enabled: boolean;
  readonly organizationId: string;
  readonly principalId: string;
  readonly teamIds: readonly string[];
  readonly projectIds: readonly string[];
  readonly issueIds: readonly string[];
  readonly project: string | null;
  readonly credentialEnv: string;
  readonly credentialStorage?: 'local';
  readonly credentialConfigured: boolean;
  readonly refreshIntervalMinutes: number;
  readonly maxStaleHours: number;
  readonly status: 'active' | 'needs-sync' | 'needs-attention';
  readonly issues: number;
  readonly documents: number;
  readonly updates: number;
  readonly chunks: number;
  readonly lastSyncedAt?: number;
  readonly nextAttemptAt?: number;
  readonly progress?: {readonly completed: number; readonly total: number};
  readonly coverage?: string;
}

export interface ResolvedLinearSelection {
  readonly organizationId: string;
  readonly principalId: string;
  readonly teams: readonly {readonly id: string; readonly name: string}[];
  readonly projects: readonly {readonly id: string; readonly name: string}[];
  readonly issues: readonly {
    readonly id: string;
    readonly identifier: string;
    readonly title: string;
    readonly url: string;
    readonly teamId: string;
    readonly projectId?: string;
  }[];
}
