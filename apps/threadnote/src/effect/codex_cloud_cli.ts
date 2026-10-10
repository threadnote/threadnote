import {Command} from 'effect/cli';
import type {CliRuntimeRunner} from './cli.js';
import {
  boolean,
  optionalString,
  requiredString,
  repeatedString,
  optionalChoice,
  defaultChoice,
  defaultString,
} from './cli/flags.js';
import {
  codexCloudRuntimeConfig,
  runCodexCloudBootstrap,
  runCodexCloudStart,
  runCodexCloudVerify,
} from '../codex/cloud.js';
import {runCodexCloudMemory} from '../codex/memory.js';
import {runCodexCloudBrief} from '../codex/brief.js';

export function makeCodexCloudCommand(withRuntime: CliRuntimeRunner) {
  const json = () => boolean('json', 'Print machine-readable output; diagnostics use stderr');
  const team = () =>
    optionalString('team', 'Configured memory share; required for new durable writes with multiple shares');
  const cwd = () =>
    optionalString('cwd', 'Absolute source checkout path for structural graph preparation or verification');
  const bootstrap = Command.make(
    'bootstrap',
    {
      agentId: optionalString('agent-id', 'Stable agent identity; defaults to codex-cloud'),
      cwd: cwd(),
      dryRun: boolean('dry-run', 'Preview without changing local or remote state'),
      remote: requiredString('remote', 'Credential-free private Git memory repository URL'),
      team: team(),
      user: optionalString('user', 'Stable memory owner; defaults to codex-cloud'),
    },
    options => withRuntime(config => runCodexCloudBootstrap(codexCloudRuntimeConfig(config, options), options)),
  );
  const start = Command.make('start', {cwd: cwd(), json: json()}, options =>
    withRuntime(config => runCodexCloudStart(config, options.json, options.cwd)),
  );
  const verify = Command.make('verify', {cwd: cwd(), json: json()}, options =>
    withRuntime(config => runCodexCloudVerify(config, options.json, options.cwd)),
  );
  const recall = Command.make(
    'recall',
    {
      callerCwd: requiredString('cwd', 'Absolute current checkout path'),
      json: json(),
      memoryRefs: repeatedString('reference', 'Explicit memory URI seed; repeat to navigate several'),
      project: optionalString('project', 'Project namespace'),
      query: optionalString('query', 'Task query'),
      team: team(),
      uri: optionalString('uri', 'Scope subtree inside a configured share'),
    },
    ({json, ...options}) => withRuntime(config => runCodexCloudMemory(config, 'recall', options, json)),
  );
  const brief = Command.make(
    'brief',
    {
      budgetTokens: optionalString('budget-tokens', 'Context Brief budget from 800 to 1500 tokens'),
      codeRefs: repeatedString('code-ref', 'Repository-relative graph path or local cgs_ handle; max 8'),
      cwd: requiredString('cwd', 'Absolute current checkout path'),
      detail: optionalChoice('detail', ['compact', 'source'], 'Compact cards or exact-current source excerpts'),
      json: json(),
      mode: optionalChoice('mode', ['brief', 'locate', 'explain', 'trace', 'impact', 'resume'], 'Context Brief mode'),
      project: optionalString('project', 'Configured graph project; omit to infer from cwd'),
      task: requiredString('task', 'Current task or question'),
      team: team(),
    },
    ({budgetTokens, ...options}) =>
      withRuntime(config =>
        runCodexCloudBrief(config, {
          ...options,
          budgetTokens: budgetTokens === undefined ? undefined : Number(budgetTokens),
        }),
      ),
  );
  const read = Command.make(
    'read',
    {
      json: json(),
      mode: optionalChoice('mode', ['content', 'outline'], 'Read content or outline'),
      offsetBytes: optionalString('offset-bytes', 'UTF-8 page offset; start with 0'),
      section: optionalString('section', 'Section heading'),
      sourceHash: optionalString('source-hash', 'SHA-256 from the first page'),
      team: team(),
      uri: requiredString('uri', 'Memory URI returned by recall'),
    },
    ({json, offsetBytes, ...options}) =>
      withRuntime(config =>
        runCodexCloudMemory(
          config,
          'read',
          {...options, offsetBytes: offsetBytes === undefined ? undefined : Number(offsetBytes)},
          json,
        ),
      ),
  );
  const list = Command.make(
    'list',
    {
      json: json(),
      recursive: boolean('recursive', 'List recursively'),
      team: team(),
      uri: optionalString('uri', 'Directory URI inside the configured shares or current identity handoffs'),
    },
    ({json, ...options}) => withRuntime(config => runCodexCloudMemory(config, 'list', options, json)),
  );
  const remember = Command.make(
    'remember',
    {
      callerCwd: optionalString('cwd', 'Absolute current checkout path'),
      codeRefs: repeatedString('code-ref', 'Current source path or graph handle; repeat for up to 8 citations'),
      json: json(),
      kind: defaultChoice('kind', ['durable', 'handoff'], 'Memory kind', 'durable'),
      project: optionalString('project', 'Project namespace'),
      references: repeatedString('reference', 'Reference within the selected share; repeat for several'),
      relations: repeatedString('relation', 'Typed relation as JSON {"type":"supersedes","uri":"threadnote://..."}'),
      replaceUri: optionalString('replace-uri', 'Existing memory to replace in its established share'),
      team: team(),
      text: requiredString('text', 'Memory content; never include credentials or raw logs'),
      topic: defaultString('topic', 'Stable memory topic', 'context'),
    },
    ({json, relations, ...options}) =>
      withRuntime(config =>
        runCodexCloudMemory(
          config,
          'remember',
          {...options, relations: relations.map(value => JSON.parse(value) as unknown)},
          json,
        ),
      ),
  );
  return Command.make('codex').pipe(
    Command.withDescription('Personal Git memory and local code graphs for published Codex Cloud environments'),
    Command.withSubcommands([bootstrap, start, verify, brief, recall, read, list, remember]),
  );
}
