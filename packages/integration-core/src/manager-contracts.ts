export interface IntegrationResult {
  readonly output: string;
  readonly entries: readonly {readonly action: string; readonly relativePath: string; readonly detail?: string}[];
  readonly reviewCount?: number;
  readonly applied: boolean;
  readonly warnings?: readonly string[];
}

export type IntegrationProductId = string;
export type ManagerIntegrations = Readonly<Record<IntegrationProductId, unknown>>;
