import type {IntegrationProduct} from '@threadnote/manager/integration-catalog';

export const product: IntegrationProduct = {
  id: 'github',
  name: 'GitHub',
  logo: '/integrations/github.svg',
  description: 'Bring selected repository discussions and reviews into context.',
  capabilities: ['Import issues and pull requests', 'Selected repositories', 'Read only'],
  setupLabel: 'Connect GitHub',
};
