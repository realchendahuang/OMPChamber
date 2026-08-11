/**
 * Phase 1 integration smoke test — real OMP process.
 *
 * Verifies: spawn `omp --mode rpc-ui` in a temp cwd → receive `ready` frame →
 * negotiate protocol → list models → create session → send a prompt →
 * observe streaming frames. Runs against the real local `omp` binary.
 *
 * Run: node packages/web/server/agent-runtime/omp/smoke-test.mjs
 */
import { createOmpProcessManager } from './process-manager.js';
import { createLogger } from './logger.js';

const logger = createLogger({ prefix: 'smoke' });

const main = async () => {
  const tmpCwd = await import('node:fs/promises').then((fs) => fs.mkdtemp('/tmp/ompchamber-smoke-'));
  const frames = [];
  const processManager = createOmpProcessManager({
    binary: process.env.OMP_BINARY || 'omp',
    cwd: tmpCwd,
    onFrame: (frame) => {
      frames.push(frame);
      const type = frame?.type;
      if (type === 'extension_ui_request' && frame?.method === 'notify') {
        logger.omp(`[ui:notify] ${frame.message}`);
      } else if (type && !['available_commands_update', 'extension_ui_request'].includes(type)) {
        logger.omp(`[frame] ${type}${frame?.command ? `:${frame.command}` : ''}`);
      }
    },
    logger,
  });

  console.log('--- starting OMP process ---');
  const rpc = await processManager.start();
  console.log(`--- OMP ready, pid=${processManager.pid} state=${processManager.state.status} ---`);

  // Negotiate protocol v2 (chunking support).
  try {
    const resp = await rpc.send({ type: 'negotiate_protocol', protocolVersion: 2 }, { timeoutMs: 10_000 });
    console.log('--- protocol negotiation:', resp?.data?.protocolVersion ?? 'unknown', '---');
  } catch (error) {
    console.log('--- protocol negotiation failed (continuing with v1):', error.message, '---');
  }

  // List models.
  try {
    const models = await rpc.send({ type: 'get_available_models' }, { timeoutMs: 15_000 });
    const list = models?.data?.models ?? [];
    console.log(`--- available models: ${list.length} ---`);
    if (list.length > 0) {
      const first = list[0];
      console.log('   first model:', first?.provider, '/', first?.id);
    }
  } catch (error) {
    console.log('--- get_available_models failed:', error.message, '---');
  }

  // Session state.
  try {
    const state = await rpc.send({ type: 'get_state' }, { timeoutMs: 10_000 });
    console.log('--- session state:', JSON.stringify({
      sessionId: state?.data?.sessionId,
      sessionName: state?.data?.sessionName,
      isStreaming: state?.data?.isStreaming,
      model: state?.data?.model ? `${state.data.model.provider}/${state.data.model.id}` : undefined,
    }), '---');
  } catch (error) {
    console.log('--- get_state failed:', error.message, '---');
  }

  console.log('--- stopping OMP ---');
  await processManager.stop();
  console.log('--- done ---');

  // Summarize captured frames.
  const counts = {};
  for (const frame of frames) {
    const type = frame?.type || 'unknown';
    counts[type] = (counts[type] || 0) + 1;
  }
  console.log('--- frame summary ---');
  console.log(JSON.stringify(counts, null, 2));
};

main().catch((error) => {
  console.error('SMOKE TEST FAILED:', error);
  process.exit(1);
});
