import type { Session } from '@ompchamber/agent-protocol/domain-types';

export type SessionMetadataRecord = Record<string, unknown>;

type OMPChamberMetadata = {
  kind?: 'review';
  originalSessionID?: string;
  reviewSessionID?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

export const getSessionMetadata = (session: Session | null | undefined): SessionMetadataRecord => {
  const metadata = (session as (Session & { metadata?: unknown }) | null | undefined)?.metadata;
  return isRecord(metadata) ? metadata : {};
};

const getOMPChamberMetadata = (metadata: SessionMetadataRecord): OMPChamberMetadata => {
  const value = metadata.ompchamber;
  return isRecord(value) ? value as OMPChamberMetadata : {};
};

export const getReviewSessionID = (session: Session | null | undefined): string | null => {
  const value = getOMPChamberMetadata(getSessionMetadata(session)).reviewSessionID;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
};

export const getOriginalSessionID = (session: Session | null | undefined): string | null => {
  const value = getOMPChamberMetadata(getSessionMetadata(session)).originalSessionID;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
};

export const isReviewSession = (session: Session | null | undefined): boolean =>
  getOMPChamberMetadata(getSessionMetadata(session)).kind === 'review' && Boolean(getOriginalSessionID(session));

export const withReviewSessionLink = (
  metadata: SessionMetadataRecord,
  reviewSessionID: string,
): SessionMetadataRecord => {
  const current = getOMPChamberMetadata(metadata);
  return {
    ...metadata,
    ompchamber: {
      ...current,
      reviewSessionID,
    },
  };
};

export const withReviewSessionMarker = (
  metadata: SessionMetadataRecord,
  originalSessionID: string,
): SessionMetadataRecord => {
  const current = getOMPChamberMetadata(metadata);
  return {
    ...metadata,
    ompchamber: {
      ...current,
      kind: 'review' as const,
      originalSessionID,
    },
  };
};

export const withoutReviewSessionLink = (
  metadata: SessionMetadataRecord,
  reviewSessionID: string,
): SessionMetadataRecord => {
  const current = getOMPChamberMetadata(metadata);
  if (current.reviewSessionID !== reviewSessionID) return metadata;

  const restOMPChamber = { ...current };
  delete restOMPChamber.reviewSessionID;
  const next: SessionMetadataRecord = { ...metadata };
  if (Object.keys(restOMPChamber).length > 0) {
    next.ompchamber = restOMPChamber;
  } else {
    delete next.ompchamber;
  }
  return next;
};
