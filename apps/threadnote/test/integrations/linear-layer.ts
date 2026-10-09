import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {provideTestLayer} from '../helpers/effect-layer.js';

export const provideLayer = provideTestLayer(ApplicationLayer);
