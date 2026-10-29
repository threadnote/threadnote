import {Array as EffectArray} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import {createHash} from '@threadnote/testing/node-crypto';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {Effect, Layer, Option} from 'effect';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '@threadnote/graph/languages/registry';
import {TreeSitterRuntime} from '@threadnote/graph/tree_sitter/runtime';
import type {CodeGraphFileFacts, CodeGraphInventoryFile} from '@threadnote/graph/types';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

interface LocalDeclarationFixture {
  readonly expectedQualifiedName: string;
  readonly language: string;
  readonly path: string;
  readonly render: (arities: readonly number[], revision: number, leadingComments: number) => string;
  readonly renderCalls: (arities: readonly number[]) => string;
}

const overloadAritiesArbitrary = FC.uniqueArray(FC.integer({max: 5, min: 0}), {
  maxLength: 6,
  minLength: 2,
}).map(values => values.sort((left, right) => left - right));

const fixtures: readonly LocalDeclarationFixture[] = [
  {
    expectedQualifiedName: 'acme.Host.run.Local',
    language: 'java',
    path: 'src/acme/Host.java',
    render: (arities, revision, leadingComments) =>
      EffectArray.join(
        [
          ...Array.from({length: leadingComments}, () => '// harmless leading layout'),
          'package acme;',
          'class Host {',
          ...EffectArray.flatMap(arities, arity => [
            `  void run(${javaParameters(arity)}) {`,
            `    int revision = ${revision};`,
            '    class Local {}',
            '  }',
          ]),
          '}',
          '',
        ],
        '\n',
      ),
    renderCalls: arities =>
      EffectArray.join(
        [
          'package acme;',
          'class Host {',
          ...EffectArray.map(arities, arity => `  void run(${javaParameters(arity)}) {}`),
          '  void caller() {',
          ...EffectArray.map(arities, arity => `    run(${callArguments(arity)});`),
          '  }',
          '}',
          '',
        ],
        '\n',
      ),
  },
  {
    expectedQualifiedName: 'acme.Host.run.Local',
    language: 'kotlin',
    path: 'src/acme/Host.kt',
    render: (arities, revision, leadingComments) =>
      EffectArray.join(
        [
          ...Array.from({length: leadingComments}, () => '// harmless leading layout'),
          'package acme',
          'class Host {',
          ...EffectArray.flatMap(arities, arity => [
            `  fun run(${kotlinParameters(arity)}) {`,
            `    val revision = ${revision}`,
            '    class Local {}',
            '  }',
          ]),
          '}',
          '',
        ],
        '\n',
      ),
    renderCalls: arities =>
      EffectArray.join(
        [
          'package acme',
          'class Host {',
          ...EffectArray.map(arities, arity => `  fun run(${kotlinParameters(arity)}) {}`),
          '  fun caller() {',
          ...EffectArray.map(arities, arity => `    run(${callArguments(arity)})`),
          '  }',
          '}',
          '',
        ],
        '\n',
      ),
  },
  {
    expectedQualifiedName: 'Host.run.Local',
    language: 'swift',
    path: 'Sources/Core/Host.swift',
    render: (arities, revision, leadingComments) =>
      EffectArray.join(
        [
          ...Array.from({length: leadingComments}, () => '// harmless leading layout'),
          'struct Host {',
          ...EffectArray.flatMap(arities, arity => [
            `  func run(${swiftParameters(arity)}) {`,
            `    let revision = ${revision}`,
            '    struct Local {}',
            '  }',
          ]),
          '}',
          '',
        ],
        '\n',
      ),
    renderCalls: arities =>
      EffectArray.join(
        [
          'struct Host {',
          ...EffectArray.map(arities, arity => `  func run(${swiftParameters(arity)}) {}`),
          '  func caller() {',
          ...EffectArray.map(arities, arity => `    run(${callArguments(arity)})`),
          '  }',
          '}',
          '',
        ],
        '\n',
      ),
  },
];

const ExtractorTestLayer = TreeSitterRuntime.layer.pipe(
  Layer.provide(TestSystemInfoLayer),
  Layer.provide(BunServices.layer),
);

describe('Tree-sitter symbol identity properties', () => {
  it.layer(ExtractorTestLayer)(layerIt => {
    layerIt.effect('keeps valid same-named local declarations distinct in Java, Kotlin, and Swift', () =>
      Effect.gen(function* () {
        for (const fixture of fixtures) {
          const facts = yield* extract(fixture, [0, 1], 0, 0);
          const repeated = yield* extract(fixture, [0, 1], 0, 0);
          expect(repeated, fixture.language).toEqual(facts);
          assertLocalIdentities(fixture, facts, 2);
        }
      }),
    );

    for (const fixture of fixtures) {
      fcEffectProp(
        layerIt,
        `${fixture.language} local declaration IDs remain unique and layout-stable`,
        {
          arities: overloadAritiesArbitrary,
          leadingComments: FC.integer({max: 12, min: 1}),
          revision: FC.integer({max: 100_000, min: 1}),
        },
        ({arities, leadingComments, revision}) =>
          Effect.gen(function* () {
            const baseline = yield* extract(fixture, arities, 0, 0);
            const shifted = yield* extract(fixture, arities, revision, leadingComments);

            assertLocalIdentities(fixture, baseline, arities.length);
            assertLocalIdentities(fixture, shifted, arities.length);
            expect(localIdentityProjection(fixture, shifted)).toEqual(localIdentityProjection(fixture, baseline));
          }),
        {
          fastCheck: {numRuns: 40},
          timeout: 60_000,
        },
      );

      fcEffectProp(
        layerIt,
        `${fixture.language} call references preserve arity and collision-free identities`,
        {arities: overloadAritiesArbitrary},
        ({arities}) =>
          Effect.gen(function* () {
            const facts = yield* BUILTIN_LANGUAGE_PACK_REGISTRY.extractFile(
              inventoryFile(fixture.path, fixture.renderCalls(arities)),
            );
            const references = EffectArray.filter(
              facts.references ?? [],
              reference =>
                reference.relation === 'calls' && reference.sourceName === 'caller' && reference.targetName === 'run',
            );
            const sortedReferenceArities = EffectArray.map(references, reference => reference.arity).sort(
              (left, right) => (left ?? -1) - (right ?? -1),
            );

            expect(sortedReferenceArities, fixture.language).toEqual(arities);
            expect(new Set(EffectArray.map(references, reference => reference.edgeId)).size, fixture.language).toBe(
              references.length,
            );
            expect(
              EffectArray.every(references, reference =>
                EffectArray.some(reference.lookupTiers.flat(), key =>
                  Effect2.pipe(key, EffectString.endsWith(`#${reference.arity}`)),
                ),
              ),
              fixture.language,
            ).toBe(true);
          }),
        {
          fastCheck: {numRuns: 30},
          timeout: 60_000,
        },
      );
    }
  });
});

function extract(
  fixture: LocalDeclarationFixture,
  arities: readonly number[],
  revision: number,
  leadingComments: number,
) {
  const content = fixture.render(arities, revision, leadingComments);
  return BUILTIN_LANGUAGE_PACK_REGISTRY.extractFile(inventoryFile(fixture.path, content));
}

function assertLocalIdentities(
  fixture: LocalDeclarationFixture,
  facts: CodeGraphFileFacts,
  expectedCount: number,
): void {
  const locals = EffectArray.filter(
    facts.symbols,
    symbol => symbol.name === 'Local' && symbol.qualifiedName === fixture.expectedQualifiedName,
  );
  expect(locals, fixture.language).toHaveLength(expectedCount);
  expect(new Set(EffectArray.map(locals, symbol => symbol.id)).size, fixture.language).toBe(expectedCount);
  expect(new Set(EffectArray.map(facts.symbols, symbol => symbol.id)).size, fixture.language).toBe(
    facts.symbols.length,
  );
}

function localIdentityProjection(fixture: LocalDeclarationFixture, facts: CodeGraphFileFacts) {
  return EffectArray.map(
    EffectArray.filter(
      facts.symbols,
      symbol => symbol.name === 'Local' && symbol.qualifiedName === fixture.expectedQualifiedName,
    ),
    symbol => ({id: symbol.id, kind: symbol.kind, name: symbol.name, qualifiedName: symbol.qualifiedName}),
  );
}

function javaParameters(arity: number): string {
  return EffectArray.join(
    Array.from({length: arity}, (_, index) => `int value${index}`),
    ', ',
  );
}

function kotlinParameters(arity: number): string {
  return EffectArray.join(
    Array.from({length: arity}, (_, index) => `value${index}: Int`),
    ', ',
  );
}

function swiftParameters(arity: number): string {
  return EffectArray.join(
    Array.from({length: arity}, (_, index) => `_ value${index}: Int`),
    ', ',
  );
}

function callArguments(arity: number): string {
  return EffectArray.join(
    EffectArray.map(
      Array.from({length: arity}, (_, index) => index),
      item => (item === null || item === undefined ? '' : String(item)),
    ),
    ', ',
  );
}

function inventoryFile(path: string, content: string): CodeGraphInventoryFile {
  const match = BUILTIN_LANGUAGE_PACK_REGISTRY.match(path);
  if (Option.isNone(match))
    throw TestError.make({message: `Fixture path is not accepted by a language pack: ${path}.`});
  return {
    blobId: `fixture-${path}`,
    content,
    contentHash: createHash('sha256').update(content).digest('hex'),
    language: match.value.language,
    mode: '100644',
    path,
    size: Buffer.byteLength(content),
    source: 'commit',
  };
}
