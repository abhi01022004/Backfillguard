import type { SendResult, WhatsAppProvider } from '../../domain/ports/WhatsAppProvider';

/**
 * The default provider: a local simulator.
 *
 * ## What it deliberately does not do
 *
 * It opens no socket, reads no credential and imports no HTTP client. That is not a limitation to be apologised
 * for — it is the reason the project runs on a judge's laptop with no account, no API key and no network, and
 * still demonstrates the entire flow end to end.
 *
 * It also does not pretend. `isSimulated` is true, the ids it mints are prefixed `DEMO-WA-`, and the message
 * body it is handed already says nothing was transmitted. A simulator that produced realistic-looking provider
 * ids and claimed delivery would be indistinguishable from a real integration that was quietly broken.
 *
 * ## Why there is no artificial latency
 *
 * A `sleep` here would make the simulation feel more realistic and would be the wrong trade. Domain code in
 * this project may not use timers — a guard test enforces it — because ordering that depends on elapsed time is
 * exactly the non-determinism the whole backfill design removes. Notifications are dispatched from inside the
 * tick loop, so a delay here would slow the run and buy nothing but theatre.
 */
export class DemoWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'demo';
  readonly isSimulated = true;

  /** Monotonic, so ids are stable and readable across a run rather than random. */
  private counter = 0;

  async sendMessage(recipient: string, message: string): Promise<SendResult> {
    /**
     * Minimal validation, so the port's contract is actually exercised.
     *
     * A provider that accepted anything would let a bug — an empty recipient from a bad derivation, an empty
     * body from a formatter change — pass silently and be recorded as a successful send. Rejecting here means
     * the notification is stored as FAILED with a reason, which is the honest outcome.
     */
    if (!recipient.trim()) {
      throw new Error('Cannot send a notification with no recipient.');
    }
    if (!message.trim()) {
      throw new Error('Cannot send an empty notification.');
    }

    this.counter += 1;

    return { providerMessageId: `DEMO-WA-${String(this.counter).padStart(6, '0')}` };
  }

  /** Returns the id sequence to its start, so a reset produces a clean run rather than continuing to climb. */
  reset(): void {
    this.counter = 0;
  }
}
