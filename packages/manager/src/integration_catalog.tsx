import React from 'react';

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
  const normalized = query.trim().toLocaleLowerCase();
  return normalized
    ? products.filter(product =>
        [product.name, product.description, ...product.capabilities].some(value =>
          value.toLocaleLowerCase().includes(normalized),
        ),
      )
    : products;
}

export function matchesIntegrationQuery(product: IntegrationProduct, query: string, ...values: string[]): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  return !normalized || [product.name, ...values].some(value => value.toLocaleLowerCase().includes(normalized));
}

export function IntegrationLogo({product, decorative = false}: {product: IntegrationProduct; decorative?: boolean}) {
  return (
    <span className="integration-logo">
      <img src={product.logo} alt={decorative ? '' : product.name} aria-hidden={decorative || undefined} />
    </span>
  );
}
