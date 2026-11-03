import type {CliRuntimeRunner} from './cli_runtime_contract.js';
import {runSemanticAgentQuery} from '../semantic/agent_queries.js';
import {formatSemanticAgentQuery} from '../semantic/agent_query_protocol.js';
import {LspFault} from '../semantic/lsp_transport.js';
import {SemanticQuery} from '../semantic/provider.js';
import {Array as EffectArray, Console, Effect, Schema, Stdio, Stream} from 'effect';
import {Command} from 'effect/cli';
import {Identifier} from '@threadnote/semantic/contracts';
import {boolean, optionalString} from './cli/flags.js';

const CapabilityRequest = Schema.Struct({language: Schema.optionalKey(Identifier)});

// Small reviewed runtime projection. Tests bind these selections to the qualification ledger;
// research evidence, host paths and pilot-only platform claims are not runtime capabilities.
const candidates: readonly {
  readonly id: string;
  readonly candidateVersion: string;
  readonly languages: readonly string[];
}[] = [
  {id: 'typescript-language-server', candidateVersion: '6.0.2', languages: ['typescript', 'javascript']},
  {id: 'basedpyright', candidateVersion: '1.40.2', languages: ['python']},
  {id: 'gopls', candidateVersion: 'v0.24.0', languages: ['go']},
  {id: 'rust-analyzer', candidateVersion: '2026-10-26', languages: ['rust']},
  {id: 'jdtls', candidateVersion: '1.63.0-202610191322', languages: ['java']},
];

/** Distribution evidence only. Discovery neither probes nor launches a provider. */
export function semanticCapabilities(input: unknown = {}) {
  const {language} = Schema.decodeUnknownSync(CapabilityRequest, {onExcessProperty: 'error'})(input);
  const deferred = language === 'kotlin';
  const providers = EffectArray.flatMap(candidates, provider => {
    const languages = EffectArray.filter(provider.languages, value => language === undefined || language === value);
    return languages.length > 0
      ? [
          {
            ...provider,
            languages,
            productionQualified: false,
            qualification: 'pending' as const,
            license: {disposition: 'release-gated' as const},
          },
        ]
      : [];
  });
  return structuredClone({
    version: 1 as const,
    scope: 'distribution-catalog' as const,
    status: providers.length > 0 ? ('ok' as const) : deferred ? ('deferred' as const) : ('unsupported' as const),
    requestedLanguage: language ?? null,
    readiness: {
      installation: 'not-assessed' as const,
      project: 'not-assessed' as const,
      queries: 'requires-host-profile' as const,
    },
    readSurface: {
      scope: 'api-operations' as const,
      operations: [...SemanticQuery.literals],
      view: 'disk' as const,
      providerCapabilities: 'assessed-per-project' as const,
      pending: ['diagnostics', 'context', 'owned-overlays', 'changes'],
    },
    providers,
    reason: deferred
      ? 'Kotlin is deferred from the current semantic release scope'
      : providers.length === 0
        ? 'No selected provider for this language'
        : null,
    nextAction:
      'Saved-disk reads require an enabled private host profile and standalone runtime. Public diagnostics, owned overlays and context composition remain pending; graph and memory remain available.',
  });
}

export type SemanticCapabilities = ReturnType<typeof semanticCapabilities>;

export function formatSemanticCapabilities(result: SemanticCapabilities): string {
  return EffectArray.join(
    [
      `Semantic providers: ${result.status} (distribution catalog; installation and project not assessed)`,
      ...EffectArray.map(
        result.providers,
        provider =>
          `${EffectArray.join(provider.languages, '/')}: ${provider.id} ${provider.candidateVersion}; production qualification: ${provider.productionQualified ? 'qualified' : 'pending'}; license review: release-gated`,
      ),
      ...(result.reason ? [result.reason] : []),
      result.nextAction,
    ],
    '\n',
  );
}

export const readSemanticAgentQueryInput = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const decoder = new TextDecoder('utf-8', {fatal: true});
  const raw = yield* stdio.stdin.pipe(
    Stream.runFoldEffect(
      () => ({bytes: 0, text: ''}),
      (previous, chunk) =>
        Effect.try({
          try: () => {
            const bytes = previous.bytes + chunk.byteLength;
            if (bytes > 65536) throw LspFault.make({code: 'protocol'});
            return {bytes, text: previous.text + decoder.decode(chunk, {stream: true})};
          },
          catch: () => LspFault.make({code: 'protocol'}),
        }),
    ),
  );
  return yield* Effect.try({
    try: (): unknown => JSON.parse(raw.text + decoder.decode()),
    catch: () => LspFault.make({code: 'protocol'}),
  });
}).pipe(
  Effect.timeoutOption(5000),
  Effect.map(result => (result._tag === 'Some' ? result.value : null)),
  Effect.orElseSucceed(() => null),
);

export function makeSemanticCommand(withRuntime: CliRuntimeRunner) {
  const capabilities = Command.make(
    'capabilities',
    {
      language: optionalString('language', 'Filter selected providers by language; Kotlin remains deferred'),
      json: boolean('json', 'Print the canonical capability catalog as JSON'),
    },
    ({language, json}) => {
      const result = semanticCapabilities(language === undefined ? {} : {language});
      return Console.log(json ? JSON.stringify(result) : formatSemanticCapabilities(result));
    },
  );
  const query = Command.make('query', {json: boolean('json', 'Print versioned semantic evidence JSON')}, ({json}) =>
    withRuntime(config =>
      Effect.gen(function* () {
        const input = yield* readSemanticAgentQueryInput;
        const result = yield* runSemanticAgentQuery(config, input);
        return yield* Console.log(json ? JSON.stringify(result) : formatSemanticAgentQuery(result));
      }),
    ),
  ).pipe(
    Command.withDescription('Read saved-disk semantic evidence; provide a bounded request JSON document on stdin'),
  );
  return Command.make('semantic').pipe(Command.withSubcommands([capabilities, query]));
}
