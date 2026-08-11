import type { Session } from '@ompchamber/agent-protocol/domain-types';

export const resolveChatPromptReadOnly = (
    session: Session | null | undefined,
    allowPromptingSubagentSessions: boolean,
    readOnly: boolean,
): boolean => {
    if (session?.parentID) {
        return !allowPromptingSubagentSessions;
    }

    return readOnly;
};
