import React from 'react';
import {ArrowDownToLine, ArrowUpFromLine} from 'lucide-react';
import type {IntegrationProduct} from '@threadnote/manager/integration-catalog';

export const product: IntegrationProduct = {
  id: 'obsidian',
  name: 'Obsidian',
  logo: '/integrations/obsidian.svg',
  description: 'Bring vault notes into context and read Threadnote memories in your vault.',
  capabilities: ['Import notes', 'Export memories', 'Inbox reviews'],
  setupLabel: 'Connect Obsidian',
  setupActions: [
    {id: 'source', label: 'Import notes', icon: <ArrowDownToLine />},
    {id: 'projection', label: 'Export memories', icon: <ArrowUpFromLine />},
  ],
};
