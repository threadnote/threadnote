import {Array as EffectArray} from 'effect';
import React from 'react';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export interface IntegrationProduct {
  readonly id: string;
  readonly name: string;
  readonly logo: string;
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly setupLabel: string;
  readonly badge?: string;
  readonly setupActions?: readonly {
    readonly id: string;
    readonly label: string;
    readonly icon?: React.ReactNode;
  }[];
}

export function filteredIntegrationProducts(
  products: readonly IntegrationProduct[],
  query: string,
): readonly IntegrationProduct[] {
  const normalized = Effect.pipe(query, EffectString.trim, EffectString.toLocaleLowerCase());
  return normalized
    ? EffectArray.filter(
        products,
        (product, index) =>
          index in products &&
          EffectArray.some([product.name, product.description, ...product.capabilities], value =>
            Effect.pipe(value, EffectString.toLocaleLowerCase(), EffectString.includes(normalized)),
          ),
      )
    : products;
}

export function matchesIntegrationQuery(product: IntegrationProduct, query: string, ...values: string[]): boolean {
  const normalized = Effect.pipe(query, EffectString.trim, EffectString.toLocaleLowerCase());
  return (
    !normalized ||
    EffectArray.some([product.name, ...values], value =>
      Effect.pipe(value, EffectString.toLocaleLowerCase(), EffectString.includes(normalized)),
    )
  );
}

export function IntegrationLogo({product, decorative = false}: {product: IntegrationProduct; decorative?: boolean}) {
  return (
    <span className="integration-logo">
      <img src={product.logo} alt={decorative ? '' : product.name} aria-hidden={decorative || undefined} />
    </span>
  );
}
