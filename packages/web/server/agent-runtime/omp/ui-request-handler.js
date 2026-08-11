/**
 * OMP UI request handler — routes OMP `extension_ui_request` frames
 * (select / confirm / input / editor) to the UI as domain AgentAsk events,
 * and forwards the user's answers back to OMP.
 */

import { OMP_UI_REQUEST_METHODS } from './rpc-types.js';

/**
 * @param {object} opts
 * @param {(ask: object) => void} opts.onAsk — forward a domain AgentAsk to the UI
 * @param {(id: string, response: object) => void} opts.onResponse — answer to OMP
 * @param {() => Promise<object|null>} opts.rpc
 */
export const createOmpUiRequestHandler = ({ onAsk, onResponse, rpc }) => {
  const ensureRpc = async () => {
    const client = await rpc();
    if (!client) throw new Error('OMP runtime is not connected');
    return client;
  };

  const isAskMethod = (method) =>
    method === OMP_UI_REQUEST_METHODS.SELECT
    || method === OMP_UI_REQUEST_METHODS.CONFIRM
    || method === OMP_UI_REQUEST_METHODS.INPUT
    || method === OMP_UI_REQUEST_METHODS.EDITOR;

  /** Dispatch an extension_ui_request frame. Returns true if it was an ask. */
  const handleFrame = (frame) => {
    if (!frame || frame.type !== 'extension_ui_request') return false;
    if (frame.method === OMP_UI_REQUEST_METHODS.CANCEL) {
      onResponse?.(frame.targetId, { id: frame.targetId, cancelled: true });
      return true;
    }
    if (!isAskMethod(frame.method)) return false;

    const method = frame.method === OMP_UI_REQUEST_METHODS.SELECT ? 'select'
      : frame.method === OMP_UI_REQUEST_METHODS.CONFIRM ? 'confirm'
      : 'input';
    onAsk?.({
      id: frame.id,
      method,
      title: frame.title || 'Agent request',
      message: frame.message,
      options: frame.options,
      placeholder: frame.placeholder,
      timeout: frame.timeout,
    });
    return true;
  };

  /** Answer a pending ask back to OMP. */
  const respond = async (id, { cancelled = false, value, confirmed } = {}) => {
    const client = await ensureRpc();
    const frame = { type: 'extension_ui_response', id };
    if (cancelled) {
      frame.cancelled = true;
    } else if (typeof confirmed === 'boolean') {
      frame.confirmed = confirmed;
    } else {
      frame.value = value;
    }
    await client.notify(frame);
  };

  return { handleFrame, respond };
};
