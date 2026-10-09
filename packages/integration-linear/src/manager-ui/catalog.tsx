import type {IntegrationProduct} from '@threadnote/manager/integration-catalog';

export const product: IntegrationProduct = {
  id: 'linear',
  name: 'Linear',
  logo: '/integrations/linear.svg',
  description: 'Bring selected issues, discussions, and project context into task recall.',
  capabilities: ['Selected scope', 'Issue discussions', 'Read only'],
  setupLabel: 'Connect Linear',
  badge: 'Beta',
};
