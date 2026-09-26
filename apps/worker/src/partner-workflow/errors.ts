// Lives apart from service.ts so handoffs/service.ts can throw it without a
// runtime import cycle (service.ts imports the handoff helpers).
export class PartnerWorkflowError extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = 'PartnerWorkflowError';
  }
}
