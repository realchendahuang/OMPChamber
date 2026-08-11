import { create } from 'zustand';

export type PendingOmpRestartScope =
  | 'agents'
  | 'providers'
  | 'commands'
  | 'mcp'
  | 'plugins'
  | 'skills'
  | 'behavior'
  | 'cli'
  | 'all';

export type PendingOmpRestartChange = {
  id: string;
  scope: PendingOmpRestartScope;
  label?: string;
  recordedAt: number;
};

type PendingOmpRestartState = {
  changes: PendingOmpRestartChange[];
  isApplying: boolean;
  recordChange: (input: {
    scope: PendingOmpRestartScope;
    id?: string;
    label?: string;
  }) => void;
  setApplying: (isApplying: boolean) => void;
  clear: () => void;
};

let changeSeq = 0;

const nextChangeId = (scope: PendingOmpRestartScope, id?: string): string => {
  changeSeq += 1;
  return id?.trim() ? `${scope}:${id.trim()}:${changeSeq}` : `${scope}:${changeSeq}`;
};

export const usePendingOmpRestartStore = create<PendingOmpRestartState>((set) => ({
  changes: [],
  isApplying: false,

  recordChange: ({ scope, id, label }) => {
    const entry: PendingOmpRestartChange = {
      id: nextChangeId(scope, id),
      scope,
      label,
      recordedAt: Date.now(),
    };
    set((state) => ({
      changes: [...state.changes, entry],
    }));
  },

  setApplying: (isApplying) => {
    set({ isApplying });
  },

  clear: () => {
    set({ changes: [], isApplying: false });
  },
}));

export const selectPendingOmpRestartCount = (state: PendingOmpRestartState): number =>
  state.changes.length;
