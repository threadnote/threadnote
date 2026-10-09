import type {IntegrationProduct} from '@threadnote/manager/integration-catalog';

export const product: IntegrationProduct = {
  id: 'pocket',
  name: 'Pocket',
  logo: '/integrations/pocket.png',
  description: 'Bring every recording accessible to your API key into context automatically.',
  capabilities: ['Import recordings', 'Transcripts and summaries', 'Read only'],
  setupLabel: 'Connect Pocket',
};
