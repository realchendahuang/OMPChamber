import type { Part } from '@ompchamber/agent-protocol/domain-types';

export function getFullText(parts: Part[]): string {
    return parts
        .filter((p): p is Part & { type: 'text'; text: string } => p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('\n');
}

export function getMessagePreview(parts: Part[], maxLength = 80): string {
    const full = getFullText(parts);
    const singleLine = full.replace(/\n/g, ' ');
    return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength)}…` : singleLine;
}
