/**
 * The outbound messaging port.
 *
 * ## Why this is a port and not a class
 *
 * The default implementation is a local simulator that never opens a socket. A real provider — Twilio, Meta's
 * Cloud API, anything — would implement this same interface and be selected by configuration. Neither the
 * notification service nor the backfill engine knows or cares which one is installed.
 *
 * The consequence that matters for a hackathon: the project runs with no credentials, no network and no
 * external account, and it still demonstrates the whole flow. A real integration is a new file and an
 * environment variable, not a rewrite.
 *
 * The interface is deliberately narrower than any real API. It takes a recipient and a body and returns an id
 * or an error. Anything richer — templates, media, delivery receipts — would be shaping the port around a
 * vendor we have not chosen.
 */

export interface SendResult {
  /** Provider-assigned identifier, used to correlate a stored notification with the provider's record. */
  providerMessageId: string;
}

export interface WhatsAppProvider {
  /** Stable identifier for the installed provider, surfaced on the API so the UI can say which is in use. */
  readonly name: string;

  /**
   * True when messages leave the machine.
   *
   * Exposed so the interface can state plainly whether anything real is happening. A demo that *looked* like it
   * was messaging patients would be worse than one that says it is simulating.
   */
  readonly isSimulated: boolean;

  /**
   * Sends one message.
   *
   * Throws on failure rather than returning a result union: a send that did not happen is an exceptional
   * outcome the caller must handle, and the notification service records it as `FAILED` with the reason
   * attached. Returning a silent failure would let a dropped alert look like a delivered one.
   */
  sendMessage(recipient: string, message: string): Promise<SendResult>;
}
