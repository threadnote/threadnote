import {Schema} from 'effect';
import {Flag} from 'effect/cli';
import {
  CODE_GRAPH_STATUS_DEFAULT_BUILD_LIMIT,
  CODE_GRAPH_STATUS_DEFAULT_LANGUAGE_PACK_LIMIT,
  CODE_GRAPH_STATUS_MAXIMUM_BUILD_LIMIT,
  CODE_GRAPH_STATUS_MAXIMUM_LANGUAGE_PACK_LIMIT,
  CODE_GRAPH_STATUS_MINIMUM_BUILD_LIMIT,
  CODE_GRAPH_STATUS_MINIMUM_LANGUAGE_PACK_LIMIT,
} from '@threadnote/graph/status/projection';
import {
  boolean,
  defaultChoice,
  describeFlag,
  integerFlag,
  optional,
  optionalString,
  withValueAlias,
} from './cli/flags.js';

export const codeGraphCliBounds = {
  cwd: optionalString('cwd', 'Repository or worktree directory; defaults to the current directory'),
  depth: optional(
    describeFlag(
      integerFlag('depth').pipe(Flag.withSchema(Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 8})))),
      'Maximum relationship traversal depth',
    ),
  ),
  edgeLimit: optional(
    describeFlag(
      integerFlag('edge-limit').pipe(Flag.withSchema(Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 500})))),
      'Maximum returned relationships',
    ),
  ),
  includeHeuristic: boolean('include-heuristic', 'Include lower-confidence heuristic relationships'),
  includeModelAssociations: boolean('include-model-associations', 'Include model-derived semantic associations'),
  json: boolean('json', 'Emit versioned machine-readable JSON'),
  nodeLimit: withValueAlias(
    optional(
      describeFlag(
        integerFlag('node-limit').pipe(Flag.withSchema(Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 200})))),
        'Maximum returned nodes',
      ),
    ),
    'limit',
    'other',
  ),
  project: optionalString(
    'project',
    'Configured project graph to use; selects a scoped graph or preserves a named full-repository project',
  ),
  readTimeoutMilliseconds: optional(
    describeFlag(
      integerFlag('read-timeout-ms').pipe(
        Flag.withSchema(Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 600_000}))),
      ),
      'Foreground read/refresh budget in milliseconds; defaults to 25000',
    ),
  ),
} as const;

export const codeGraphFreshnessFlag = (value: 'current' | 'ready') =>
  defaultChoice(
    'freshness',
    ['ready', 'current', 'allow-stale'],
    'Ready uses an existing snapshot, current performs a bounded refresh, and allow-stale never starts indexing',
    value,
  );

export const codeGraphStatusBuildLimitFlag = optional(
  describeFlag(
    integerFlag('build-limit').pipe(
      Flag.withSchema(
        Schema.Int.check(
          Schema.isBetween({
            minimum: CODE_GRAPH_STATUS_MINIMUM_BUILD_LIMIT,
            maximum: CODE_GRAPH_STATUS_MAXIMUM_BUILD_LIMIT,
          }),
        ),
      ),
    ),
    `Maximum compact build, waiter, and queued-worktree records in JSON; defaults to ${CODE_GRAPH_STATUS_DEFAULT_BUILD_LIMIT}`,
  ),
);

export const codeGraphStatusLanguagePackLimitFlag = optional(
  describeFlag(
    integerFlag('language-pack-limit').pipe(
      Flag.withSchema(
        Schema.Int.check(
          Schema.isBetween({
            minimum: CODE_GRAPH_STATUS_MINIMUM_LANGUAGE_PACK_LIMIT,
            maximum: CODE_GRAPH_STATUS_MAXIMUM_LANGUAGE_PACK_LIMIT,
          }),
        ),
      ),
    ),
    `Maximum rich language-pack records in JSON; defaults to ${CODE_GRAPH_STATUS_DEFAULT_LANGUAGE_PACK_LIMIT}`,
  ),
);

export const codeGraphStatusFlags = {
  buildLimit: codeGraphStatusBuildLimitFlag,
  cwd: codeGraphCliBounds.cwd,
  json: codeGraphCliBounds.json,
  languagePackLimit: codeGraphStatusLanguagePackLimitFlag,
  project: codeGraphCliBounds.project,
} as const;
