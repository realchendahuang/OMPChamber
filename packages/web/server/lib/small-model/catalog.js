import { getModelsMetadata } from '../ompchamber/models-metadata.js';

// The models.dev catalog is shared with the /api/ompchamber/models-metadata
// route through one in-process cache — no extra fetches, no cache files.
export async function getModelCatalog() {
  const { metadata } = await getModelsMetadata();
  return metadata;
}

export function getCatalogProvider(catalog, providerID) {
  const entry = catalog?.[providerID];
  return entry && typeof entry === 'object' ? entry : null;
}
