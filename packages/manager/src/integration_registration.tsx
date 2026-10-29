import React from 'react';
import type {IntegrationProduct} from './integration_catalog.js';

export interface IntegrationViewProps<Data> {
  readonly data: Data | undefined;
  readonly query: string;
  readonly visible: boolean;
  readonly setupAction: string | undefined;
  readonly onSetupClosed: () => void;
  readonly busy: boolean;
  readonly setBusy: (busy: boolean) => void;
  readonly setError: (message: string) => void;
  readonly setNotice: (message: string) => void;
  readonly onChanged: (message: string) => Promise<void>;
  readonly onSaved: (message: string) => Promise<void>;
  readonly onReviews: () => void;
}

export interface IntegrationRegistration {
  readonly product: IntegrationProduct;
  readonly count: (data: unknown, query: string) => number;
  readonly View: React.ComponentType<IntegrationViewProps<unknown>>;
}

export function defineIntegration<Data>(registration: {
  readonly isData: (value: unknown) => value is Data;
  readonly product: IntegrationProduct;
  readonly count: (data: Data | undefined, query: string) => number;
  readonly View: React.ComponentType<IntegrationViewProps<Data>>;
}): IntegrationRegistration {
  const ProviderView = registration.View;
  const readData = (data: unknown): Data | undefined => {
    if (data === undefined) return undefined;
    if (!registration.isData(data)) throw new Error('Could not read integration status. Reload the page.');
    return data;
  };
  return {
    product: registration.product,
    count: (data, query) => registration.count(readData(data), query),
    View: props => <ProviderView {...props} data={readData(props.data)} />,
  };
}
