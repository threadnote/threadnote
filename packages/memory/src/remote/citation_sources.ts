import {Array as EffectArray} from 'effect';
import {Schema} from 'effect';
import {MAX_MEMORY_CODE_CITATIONS} from '../code/citation.js';
import {parseRemoteShareAddress} from './address.js';

export const RemoteCitationSourcesSchema = Schema.Array(
  Schema.Struct({
    uri: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    citationId: Schema.String.check(Schema.isPattern(/^tncc_[a-f0-9]{40}$/u)),
  }),
).check(Schema.isMaxLength(MAX_MEMORY_CODE_CITATIONS));

export type RemoteCitationSource = (typeof RemoteCitationSourcesSchema.Type)[number];

export function normalizeRemoteCitationSources(
  value: readonly RemoteCitationSource[] | undefined,
): readonly RemoteCitationSource[] | undefined {
  if (value === undefined) return undefined;
  const parsed = Schema.decodeSync(RemoteCitationSourcesSchema, {onExcessProperty: 'error'})(value);
  const sources = new Map<string, RemoteCitationSource>();
  for (const source of parsed) {
    if (parseRemoteShareAddress(source.uri).canonicalUri !== source.uri) {
      throw new TypeError('Citation sources must use canonical remote memory URIs.');
    }
    sources.set(`${source.uri}\n${source.citationId}`, {uri: source.uri, citationId: source.citationId});
  }
  return EffectArray.map(
    [...sources.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ([, source]) => source,
  );
}
