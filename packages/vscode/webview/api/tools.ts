import type { ToolsAPI } from '@ompchamber/ui/lib/api/types';
import { agentClient } from '@ompchamber/ui/lib/agent/client';

export const createVSCodeToolsAPI = (): ToolsAPI => ({
  async getAvailableTools(): Promise<string[]> {
    const data = await agentClient.listToolIds();
    if (!Array.isArray(data)) {
      throw new Error('Tools API returned invalid data format');
    }

    return data
      .filter((tool: unknown): tool is string => typeof tool === 'string' && tool !== 'invalid')
      .sort();
  },
});
