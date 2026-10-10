export type RuntimeIdentitySource =
  | 'codex-cloud-command'
  | 'codex-cloud-profile'
  | 'cursor-cloud-command'
  | 'cursor-cloud-profile'
  | 'environment'
  | 'system';

export type RuntimeManifestSource = 'bundled-example' | 'configured' | 'user';

export interface RuntimeConfig {
  readonly account: string;
  readonly agentContextHome: string;
  readonly agentId: string;
  readonly agentIdSource?: RuntimeIdentitySource;
  readonly manifestPath: string;
  readonly manifestSource?: RuntimeManifestSource;
  readonly user: string;
  readonly userSource?: RuntimeIdentitySource;
}

export interface ProjectManifest {
  readonly graph?: ProjectGraphManifest;
  readonly name: string;
  readonly path: string;
  readonly seed: readonly string[];
  readonly uri: string;
}

export interface ProjectGraphManifest {
  readonly closure: 'dependencies';
  readonly include?: readonly string[];
  readonly roots: readonly string[];
}

export interface WorksetManifest {
  readonly description?: string;
  readonly name: string;
  readonly projects: readonly string[];
}

export interface ResolvedWorkset {
  readonly name: string;
  readonly projects: readonly ProjectManifest[];
  /** Manifest member names that do not resolve to a configured project. */
  readonly unresolvedProjects: readonly string[];
}

export interface SeedManifest {
  readonly futureMonorepo?: {
    readonly pathCandidates: readonly string[];
    readonly uri: string;
  };
  readonly projects: readonly ProjectManifest[];
  readonly version: number;
  readonly worksets?: readonly WorksetManifest[];
}
