import {Array as EffectArray} from 'effect';
import {Option} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  explicitlyPreservedStandaloneProcessIds,
  preservedStandaloneProcessIds,
  type StandaloneProcessLease,
} from '@threadnote/threadnote/process/standalone_lease';

describe('standalone process retirement properties', () => {
  it('preserves exactly the processes rooted beneath preserve-session leases', () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), {minLength: 1, maxLength: 40}),
        fc.array(fc.nat(), {minLength: 1, maxLength: 40}),
        (preserveFlags, parentSeeds) => {
          const size = Math.min(preserveFlags.length, parentSeeds.length);
          const leases: Pick<StandaloneProcessLease, 'parentProcessId' | 'processId' | 'retirementPolicy'>[] = [];
          for (let index = 0; index < size; index += 1) {
            const processId = index + 1;
            const parentIndex = index === 0 ? undefined : parentSeeds[index] % (index + 1);
            leases.push({
              parentProcessId:
                parentIndex === undefined || parentIndex === index ? Option.none() : Option.some(parentIndex + 1),
              processId,
              retirementPolicy: preserveFlags[index] ? 'preserve-session' : 'terminate',
            });
          }

          const expected = new Set<number>();
          for (const lease of leases) {
            let cursor: (typeof leases)[number] | undefined = lease;
            while (cursor !== undefined) {
              if (cursor.retirementPolicy === 'preserve-session') {
                expected.add(lease.processId);
                break;
              }
              cursor = Option.isSome(cursor.parentProcessId) ? leases[cursor.parentProcessId.value - 1] : undefined;
            }
          }

          expect([...preservedStandaloneProcessIds(leases)].sort((left, right) => left - right)).toEqual(
            [...expected].sort((left, right) => left - right),
          );
        },
      ),
      {numRuns: 200},
    );
  });

  it('explicit retirement preserves exactly the leases that opt into session preservation', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), {minLength: 1, maxLength: 40}), preserveFlags => {
        const leases = EffectArray.map(preserveFlags, (preserve, index) => ({
          processId: index + 1,
          retirementPolicy: preserve ? ('preserve-session' as const) : ('terminate' as const),
        }));

        expect([...explicitlyPreservedStandaloneProcessIds(leases)]).toEqual(
          EffectArray.map(
            EffectArray.filter(leases, lease => lease.retirementPolicy === 'preserve-session'),
            lease => lease.processId,
          ),
        );
      }),
      {numRuns: 200},
    );
  });
});
