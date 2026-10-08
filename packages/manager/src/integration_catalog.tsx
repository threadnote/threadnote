import React from 'react';
import type {IntegrationProductId} from './integrations_contracts.js';

export interface IntegrationProduct {
  readonly id: IntegrationProductId;
  readonly name: string;
  readonly logo: string;
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly setupLabel: string;
}

export const integrationProducts: readonly IntegrationProduct[] = [
  {
    id: 'obsidian',
    name: 'Obsidian',
    logo: '/integrations/obsidian.svg',
    description: 'Bring vault notes into context and read Threadnote memories in your vault.',
    capabilities: ['Import notes', 'Export memories', 'Inbox reviews'],
    setupLabel: 'Connect Obsidian',
  },
  {
    id: 'superhuman',
    name: 'Superhuman Docs',
    logo: '/integrations/superhuman-docs.png',
    description: 'Read selected document and page canvas text into context.',
    capabilities: ['Import canvas text', 'Read only', 'No tables or attachments'],
    setupLabel: 'Connect Superhuman Docs',
  },
  {
    id: 'pocket',
    name: 'Pocket',
    logo: '/integrations/pocket.png',
    description: 'Bring every recording accessible to your API key into context automatically.',
    capabilities: ['Import recordings', 'Transcripts and summaries', 'Read only'],
    setupLabel: 'Connect Pocket',
  },
  {
    id: 'linear',
    name: 'Linear',
    logo: '/integrations/linear.svg',
    description: 'Bring selected issues, discussions, and project context into task recall.',
    capabilities: ['Selected scope', 'Issue discussions', 'Read only'],
    setupLabel: 'Connect Linear',
  },
  {
    id: 'github',
    name: 'GitHub',
    logo: '/integrations/github.svg',
    description: 'Bring selected repository discussions and reviews into context.',
    capabilities: ['Import issues and pull requests', 'Selected repositories', 'Read only'],
    setupLabel: 'Connect GitHub',
  },
];

export function integrationProduct(id: IntegrationProductId): IntegrationProduct {
  const product = integrationProducts.find(item => item.id === id);
  if (!product) throw new Error('Unknown integration product.');
  return product;
}

export function filteredIntegrationProducts(query: string): readonly IntegrationProduct[] {
  const normalized = query.trim().toLocaleLowerCase();
  return normalized
    ? integrationProducts.filter(product =>
        [product.name, product.description, ...product.capabilities].some(value =>
          value.toLocaleLowerCase().includes(normalized),
        ),
      )
    : integrationProducts;
}

export function IntegrationLogo({product, decorative = false}: {product: IntegrationProduct; decorative?: boolean}) {
  return (
    <span className="integration-logo">
      <img src={product.logo} alt={decorative ? '' : product.name} aria-hidden={decorative || undefined} />
    </span>
  );
}
