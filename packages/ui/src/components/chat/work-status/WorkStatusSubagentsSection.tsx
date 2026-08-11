import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useAllLiveSessions, useAllSessionStatuses, useDirectorySync } from '@/sync/sync-context';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isEmbeddedSessionChat } from '@/components/layout/contextPanelEmbeddedChat';
import { WorkStatusCollapsibleSection, WorkStatusRow, WorkStatusValue } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';
import type { State } from '@/sync/types';
import type { SubagentSnapshot } from '@ompchamber/agent-protocol/domain-types';

type Props = {
  sessionId: string | null;
  directory: string | null;
};

const SECTION_ID = 'subagents';

type SubagentEntry = {
  id: string;
  label: string;
  status: 'running' | 'completed' | 'failed' | 'waiting';
};

/**
 * Running subagents and, more importantly, their blockers: a permission request
 * raised by a child session has no representation in the transcript, so this
 * panel is the only place it becomes visible.
 */
export const WorkStatusSubagentsSection: React.FC<Props> = ({ sessionId, directory }) => {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);

  const liveSessions = useAllLiveSessions();
  const statuses = useAllSessionStatuses();
  const childSessions = React.useMemo(
    () => (sessionId ? liveSessions.filter((candidate) => candidate.parentID === sessionId) : []),
    [liveSessions, sessionId],
  );

  // OMP never lists child sessions in the session list, so live subagent
  // state arrives through `ompchamber:subagent` events instead. The store
  // snapshot is the authoritative source there; the live-session path stays
  // for OpenCode-shaped runtimes that materialize subagents as sessions.
  const subagentSnapshots = useDirectorySync(
    React.useCallback(
      (state: State) => (sessionId ? state.subagent[sessionId] ?? [] : []),
      [sessionId],
    ),
  );

  const children = React.useMemo<SubagentEntry[]>(() => {
    const fromSnapshots: SubagentEntry[] = subagentSnapshots.map((snapshot: SubagentSnapshot) => ({
      id: snapshot.id,
      label: snapshot.description?.trim() || snapshot.agent?.trim() || t('chat.workStatus.subagent.untitled'),
      status: snapshot.status,
    }));
    const fromSessions: SubagentEntry[] = childSessions.map((child) => ({
      id: child.id,
      label: child.title?.trim() || t('chat.workStatus.subagent.untitled'),
      status: statuses[child.id]?.type === 'busy' ? 'running' : 'completed',
    }));
    const seen = new Set<string>();
    return [...fromSnapshots, ...fromSessions].filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    });
  }, [subagentSnapshots, childSessions, statuses, t]);

  // One subscription covers every child: per-session hooks would multiply
  // store subscriptions by the number of subagents.
  const permissions = useDirectorySync(React.useCallback((state: State) => state.permission, []));
  const questions = useDirectorySync(React.useCallback((state: State) => state.question, []));

  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const setSectionExpanded = useUIStore((state) => state.setWorkStatusSectionExpanded);

  // Subagents appearing where there were none is the one moment this section
  // has something urgent to say, so it opens itself. Only on the empty→present
  // edge: re-expanding on every count change would fight a user who just
  // collapsed it.
  const hadChildren = React.useRef(children.length > 0);
  React.useEffect(() => {
    const present = children.length > 0;
    if (present && !hadChildren.current) setSectionExpanded(SECTION_ID, true);
    hadChildren.current = present;
  }, [children.length, setSectionExpanded]);

  // Same branch the transcript's Task tool takes: surfaces that cannot host an
  // embedded panel navigate to the child session instead of opening a tab.
  const openChildSession = React.useCallback((childId: string, label: string) => {
    if (!directory) return;
    if (isEmbeddedSessionChat() || isMobile || isVSCodeRuntime()) {
      setCurrentSession(childId, directory);
      return;
    }
    openContextPanelTab(directory, {
      mode: 'chat',
      dedupeKey: `session:${childId}`,
      label,
      readOnly: true,
    });
  }, [directory, isMobile, openContextPanelTab, setCurrentSession]);

  useReportWorkStatusPresence('subagents', children.length > 0);

  if (children.length === 0) return null;

  const busyChildren = children.filter((child) => child.status === 'running').length;

  return (
    <WorkStatusCollapsibleSection
      id={SECTION_ID}
      title={t('chat.workStatus.section.subagents')}
      icon="ai-agent"
      defaultExpanded
      summary={busyChildren > 0 ? `${busyChildren}/${children.length}` : children.length}
    >
      {children.map((child) => {
        const blocked = (permissions[child.id]?.length ?? 0) > 0;
        const asked = (questions[child.id]?.length ?? 0) > 0;
        const busy = child.status === 'running';
        return (
          <WorkStatusRow
            key={child.id}
            onClick={directory ? () => openChildSession(child.id, child.label) : undefined}
            ariaLabel={t('chat.workStatus.action.openSubagent', { name: child.label })}
            label={child.label}
            value={blocked ? (
              <WorkStatusValue tone="warning">{t('chat.workStatus.subagent.needsPermission')}</WorkStatusValue>
            ) : asked ? (
              <WorkStatusValue tone="warning">{t('chat.workStatus.subagent.askedQuestion')}</WorkStatusValue>
            ) : busy ? (
              <WorkStatusValue tone="info">{t('chat.workStatus.subagent.working')}</WorkStatusValue>
            ) : (
              <WorkStatusValue tone="muted">{t('chat.workStatus.subagent.done')}</WorkStatusValue>
            )}
          />
        );
      })}
    </WorkStatusCollapsibleSection>
  );
};
