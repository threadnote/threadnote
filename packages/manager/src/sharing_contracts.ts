export interface SharingConflict {
  readonly id: string;
  readonly team: string;
  readonly uri: string;
  readonly relativePath: string;
  readonly reason: string;
  readonly status: string;
  readonly hasLocalContent: boolean;
  readonly hasSharedContent: boolean;
  readonly identityConflict?: 'missing' | 'changed';
}

export interface SharingConflictDetail extends SharingConflict {
  readonly revision: string;
  readonly localContent?: string;
  readonly sharedContent?: string;
  readonly previousContent?: string;
  readonly diff: string;
  readonly canKeepLocal: boolean;
  readonly canUseShared: boolean;
  readonly canMerge: boolean;
  readonly readOnly: boolean;
}
