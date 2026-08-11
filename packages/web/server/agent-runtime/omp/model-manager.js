/**
 * OMP model manager — exposes provider/model/thinking from OMP.
 *
 * OMPChamber never maintains its own provider registry; it reads everything
 * from OMP (OMP_MIGRATION_MAP §4.5).
 */

import { OMP_COMMANDS } from './rpc-types.js';

const normalizeModel = (model) => {
  if (!model || typeof model !== 'object') return null;
  return {
    provider: String(model.provider ?? model.providerId ?? ''),
    modelId: String(model.id ?? model.modelId ?? ''),
    label: typeof model.name === 'string' ? model.name : undefined,
  };
};

/**
 * @param {object} opts
 * @param {() => Promise<object|null>} opts.rpc
 */
export const createOmpModelManager = ({ rpc }) => {
  const ensureRpc = async () => {
    const client = await rpc();
    if (!client) throw new Error('OMP runtime is not connected');
    return client;
  };

  return {
    async listModels() {
      const client = await ensureRpc();
      const resp = await client.send({ type: OMP_COMMANDS.GET_AVAILABLE_MODELS }, { timeoutMs: 20_000 });
      const list = resp?.data?.models ?? [];
      return list.map(normalizeModel).filter(Boolean);
    },

    async setModel(provider, modelId) {
      const client = await ensureRpc();
      await client.send({ type: OMP_COMMANDS.SET_MODEL, provider, modelId }, { timeoutMs: 20_000 });
    },

    async cycleModel() {
      const client = await ensureRpc();
      const resp = await client.send({ type: OMP_COMMANDS.CYCLE_MODEL }, { timeoutMs: 20_000 });
      const data = resp?.data;
      return data?.model ? normalizeModel(data.model) : null;
    },

    async setThinkingLevel(level) {
      const client = await ensureRpc();
      await client.send({ type: OMP_COMMANDS.SET_THINKING_LEVEL, level }, { timeoutMs: 10_000 });
    },
  };
};
