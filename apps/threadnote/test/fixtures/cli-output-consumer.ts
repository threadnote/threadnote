import {Array as EffectArray} from 'effect';
import {TestError} from '@threadnote/testing/test-error';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const mode = process.argv[2];
const startMarker = process.argv[3] ?? 'generic-output-start';
const endMarker = process.argv[4] ?? 'generic-output-end';
const text = await new Response(Bun.stdin.stream()).text();

const result = (() => {
  if (mode === 'json') {
    const value: unknown = JSON.parse(text);
    if (!isOutputWithNodes(value)) throw TestError.make({message: 'Invalid graph query JSON output.'});
    const nodes = value.nodes ?? [];
    return {
      allNamesMatched: EffectArray.every(
        nodes,
        node => node.name !== undefined && EffectString.startsWith('pipedOutputSymbol')(node.name),
      ),
      bytes: new TextEncoder().encode(text).byteLength,
      nodeCount: nodes.length,
    };
  }
  if (mode === 'text') {
    return {
      bytes: new TextEncoder().encode(text).byteLength,
      hasEnd: Effect.pipe(text, EffectString.includes(endMarker)),
      hasStart: Effect.pipe(text, EffectString.includes(startMarker)),
    };
  }
  throw TestError.make({message: `Unsupported CLI output consumer mode: ${mode ?? '<missing>'}`});
})();

await Bun.write(Bun.stdout, `${JSON.stringify(result)}\n`);

function isOutputWithNodes(value: unknown): value is {readonly nodes?: readonly {readonly name?: string}[]} {
  return (
    typeof value === 'object' &&
    value !== null &&
    (!('nodes' in value) ||
      value.nodes === undefined ||
      (EffectArray.isArray(value.nodes) && EffectArray.every(value.nodes, isOutputNode)))
  );
}

function isOutputNode(value: unknown): value is {readonly name?: string} {
  return typeof value === 'object' && value !== null && (!('name' in value) || typeof value.name === 'string');
}
