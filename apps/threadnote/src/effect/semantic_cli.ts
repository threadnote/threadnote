import {Array as EffectArray, Console, Schema} from 'effect';
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
      queries: 'public-integration-pending' as const,
    },
    providers,
    reason: deferred
      ? 'Kotlin is deferred from the current semantic release scope'
      : providers.length === 0
        ? 'No selected provider for this language'
        : null,
    nextAction:
      'Provider setup and project qualification must be verified before semantic queries are available. Existing graph and memory tools remain available.',
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

export function makeSemanticCommand() {
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
  return Command.make('semantic').pipe(Command.withSubcommands([capabilities]));
}
