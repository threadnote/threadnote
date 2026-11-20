import {Array as EffectArray, Record as EffectRecord, Schema, String as EffectString} from 'effect';
import {BUN_STANDALONE_TARGETS} from '../../../../../scripts/release-targets.js';
import scenarios from './scenario-contracts.json' with {type: 'json'};

export const Ledger = Schema.Struct({
  requiredPlatforms: Schema.Array(Schema.String),
  releaseLanguages: Schema.Array(Schema.String),
  selectedProviders: Schema.Record(Schema.String, Schema.String),
  providers: Schema.Array(
    Schema.Struct({id: Schema.String, version: Schema.String, languages: Schema.Array(Schema.String)}),
  ),
});
const families = [['typescript', 'javascript'], ['python'], ['go'], ['rust'], ['java']] as const;
export const activeSafetyObligations = [
  'MCP/CLI semantic parity',
  'editor-owned-buffer refusal',
  'writer authorization and ownership',
  'concurrent writer preservation',
  'recovery',
  'privacy',
  'security',
] as const;
const clients = ['cli-json-v1', 'mcp-stdio'] as const;
const editorOnly = ['S29', 'S30', 'S31', 'S32'];

/** Missing evidence remains missing. This inventory never consumes a caller qualification flag. */
export function qualificationInventory(input: unknown) {
  const ledger = Schema.decodeUnknownSync(Ledger)(input);
  const platforms = EffectArray.map(BUN_STANDALONE_TARGETS, target => EffectString.slice(4)(target));
  const sameSet = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && new Set(a).size === a.length && EffectArray.every(a, value => b.includes(value));
  if (
    platforms.length !== 8 ||
    !sameSet(ledger.requiredPlatforms, platforms) ||
    !sameSet(EffectRecord.keys(ledger.selectedProviders), ledger.releaseLanguages) ||
    !sameSet(
      ledger.releaseLanguages,
      EffectArray.flatMap(families, languages => [...languages]),
    )
  )
    throw new Error('Qualification inventory does not match the selected release matrix');
  const cells = EffectArray.flatMap(families, languages => {
    const providerId = ledger.selectedProviders[languages[0]];
    const candidates = EffectArray.filter(ledger.providers, provider => provider.id === providerId);
    if (
      candidates.length !== 1 ||
      EffectArray.some(
        languages,
        language => ledger.selectedProviders[language] !== providerId || !candidates[0].languages.includes(language),
      )
    )
      throw new Error('Qualification inventory requires one selected provider per family');
    return EffectArray.map(platforms, platform => ({
      languages: [...languages],
      provider: {id: providerId, version: candidates[0].version},
      platform,
      status: 'unqualified' as const,
      productionQualified: false,
      gates: {
        candidateReceipt: 'missing',
        artifactAndRuntime: 'missing',
        license: 'missing',
        coreCapabilities: 'missing',
        authority: 'missing',
        isolation: 'missing',
        recovery: 'missing',
      },
      clients: EffectArray.map(clients, client => ({client, outcome: 'missing' as const})),
    }));
  });
  return {
    status: 'blocked' as const,
    schemaVersion: 1,
    kind: 'final-combined-qualification-inventory',
    productionQualified: false,
    counts: {familyPlatformCells: cells.length, activeClientCells: cells.length * clients.length, qualifiedCells: 0},
    specification: scenarios.source,
    scenarios: EffectArray.map(scenarios.scenarios, scenario => ({
      ...scenario,
      selection: editorOnly.includes(scenario.id) ? 'deferred-P09-client-realization' : 'active-obligations-remain',
      activeSafetyObligations,
      fullScenarioQualified: false,
      outcome: editorOnly.includes(scenario.id) ? 'deferred' : 'missing',
      ...(scenario.id === 'S43'
        ? {deferredBranch: 'P09 LSP negotiation and first-party integration; active mutation refusal remains required'}
        : {}),
    })),
    activeSafetyObligations,
    deferred: {
      languages: ['kotlin'],
      clients: ['editor-lsp', 'first-party-editor-integration'],
      excluded: scenarios.excluded,
    },
    cells,
    note: 'Inventory only. Applicability and every complete Given/When/Then branch still need reviewed exact-candidate execution; a smoke branch does not qualify a scenario or cell.',
  };
}
