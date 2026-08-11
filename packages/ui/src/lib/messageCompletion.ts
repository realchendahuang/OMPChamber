/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Part } from "@ompchamber/agent-protocol/domain-types";

interface MessageInfo {
    id: string;
    role: string;
    time?: {
        created?: number;
        completed?: number;
    };
    status?: string;
    streaming?: boolean;
    finish?: string;
}

export interface MessageRecord {
    info: MessageInfo & Record<string, any>;
    parts: Part[];
}
