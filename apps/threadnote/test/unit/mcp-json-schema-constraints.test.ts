import {AjvJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/ajv';
import {Schema} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {flattenJsonSchemaConstraints} from '../../src/mcp/json_schema_constraints.js';

describe('MCP JSON Schema constraint projection', () => {
  it('intersects Effect safe-integer and application bounds without retaining redundant allOf', () => {
    const original = Schema.toJsonSchemaDocument(Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 100}))).schema;
    expect(flattenJsonSchemaConstraints(original)).toEqual({type: 'integer', minimum: 1, maximum: 100});
  });

  it('preserves nonmergeable constraints and boolean rejection', () => {
    for (const original of [
      {type: 'string', allOf: [{type: 'number'}]},
      {minimum: 5, allOf: [false]},
      {exclusiveMinimum: 5, allOf: [{exclusiveMinimum: 8}]},
    ])
      expect(flattenJsonSchemaConstraints(original)).toEqual(original);
  });

  it('preserves validator acceptance, idempotence and input bytes for bounded numeric intersections', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('integer', 'number'),
        fc.array(fc.tuple(fc.integer({min: -100, max: 100}), fc.integer({min: -100, max: 100})), {
          minLength: 1,
          maxLength: 4,
        }),
        fc.integer({min: -120, max: 120}),
        (type, bounds, candidate) => {
          const original = {
            type,
            minimum: Number.MIN_SAFE_INTEGER,
            maximum: Number.MAX_SAFE_INTEGER,
            allOf: bounds.map(([minimum, maximum]) => ({minimum, maximum})),
          };
          const before = JSON.stringify(original);
          const projected = flattenJsonSchemaConstraints(original) as Record<string, unknown>;
          const validator = new AjvJsonSchemaValidator();
          const acceptsOriginal = validator.getValidator(original);
          const acceptsProjected = validator.getValidator(projected);
          for (const input of [candidate, candidate + 0.5, ...bounds.flat()]) {
            expect(acceptsProjected(input).valid).toBe(acceptsOriginal(input).valid);
          }
          expect(flattenJsonSchemaConstraints(projected)).toEqual(projected);
          expect(JSON.stringify(original)).toBe(before);
        },
      ),
      {numRuns: 80},
    );
  });
});
