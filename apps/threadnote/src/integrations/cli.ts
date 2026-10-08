import {Flag} from 'effect/cli';
import {
  boolean,
  optionalString,
  repeatedString,
  requiredString,
  optional,
  integerFlag,
  defaultChoice,
} from '../effect/cli/flags.js';

export const sourceAddFlags = {
  apply: boolean('apply', 'Write the source configuration; without this, print a preview'),
  credentialEnv: optionalString('credential-env', 'Environment variable containing the source credential'),
  organizationId: optionalString('organization-id', 'Linear organization UUID binding'),
  principalId: optionalString('principal-id', 'Linear authenticated principal UUID binding'),
  teamIds: repeatedString('team-id', 'Linear allowed team UUID; repeat for multiple', 64),
  projectIds: repeatedString('linear-project-id', 'Explicit Linear project UUID; repeat for multiple', 64),
  issueIds: repeatedString('issue-id', 'Explicit Linear issue UUID; repeat for multiple', 256),
  documents: repeatedString('doc', 'Stable document ID allowlist; repeat for multiple documents', 64),
  exclude: repeatedString('exclude', 'Vault-relative exclusion glob; repeat for multiple'),
  id: requiredString('id', 'Stable source identifier'),
  includeHidden: boolean('include-hidden', 'Include hidden pages within selected documents'),
  inbox: optionalString('inbox', 'Vault-relative Threadnote Inbox folder'),
  include: repeatedString('include', 'Required vault-relative allowlist glob; repeat for multiple'),
  maxStaleHours: optional(
    integerFlag('max-stale-hours').pipe(Flag.withDescription('Maximum source staleness in hours')),
  ),
  pages: repeatedString('page', 'Stable page ID allowlist; only with one --doc', 256),
  project: optionalString('project', 'Local project slug for imported pages'),
  projectless: boolean('projectless', 'Import pages without a project'),
  refreshIntervalMinutes: optional(
    integerFlag('refresh-interval-minutes').pipe(Flag.withDescription('Minimum minutes between source refreshes')),
  ),
  type: defaultChoice('type', ['obsidian', 'superhuman', 'pocket', 'linear'], 'External source type', 'obsidian'),
  vault: optionalString('vault', 'Obsidian vault directory'),
};
