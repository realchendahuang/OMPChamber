import { createConfiguredWebAPIs } from './runtimeConfig';
import type { RuntimeAPIs } from '@ompchamber/ui/lib/api/types';
import '@ompchamber/ui/index.css';
import '@ompchamber/ui/styles/fonts';

declare global {
  interface Window {
    __OMPCHAMBER_RUNTIME_APIS__?: RuntimeAPIs;
  }
}

window.__OMPCHAMBER_RUNTIME_APIS__ = createConfiguredWebAPIs();

void import('@ompchamber/ui/apps/renderMobileApp')
  .then(({ renderMobileApp }) => {
    renderMobileApp(window.__OMPCHAMBER_RUNTIME_APIS__ ?? createConfiguredWebAPIs());
  });
