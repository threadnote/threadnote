import type {IntegrationProduct} from '@threadnote/manager/integration-catalog';

export const product: IntegrationProduct = {
  id: 'superhuman',
  name: 'Superhuman Docs',
  logo: '/integrations/superhuman-docs.png',
  description: 'Read selected document and page canvas text into context.',
  capabilities: ['Import canvas text', 'Read only', 'No tables or attachments'],
  setupLabel: 'Connect Superhuman Docs',
};
