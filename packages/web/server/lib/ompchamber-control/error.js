export class OMPChamberControlError extends Error {
  constructor(message, statusCode = 500, details = {}) {
    super(message);
    this.name = 'OMPChamberControlError';
    this.statusCode = statusCode;
    Object.assign(this, details);
  }
}

export const asControlError = (error, fallbackMessage, fallbackStatus = 500) => {
  if (error instanceof OMPChamberControlError) return error;
  const message = error instanceof Error ? error.message : fallbackMessage;
  return new OMPChamberControlError(message || fallbackMessage, Number(error?.statusCode) || fallbackStatus, {
    ...(error?.goalConfigured === true ? { goalConfigured: true } : {}),
  });
};
