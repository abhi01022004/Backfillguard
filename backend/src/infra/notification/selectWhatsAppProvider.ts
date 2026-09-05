import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import type { WhatsAppProvider } from '../../domain/ports/WhatsAppProvider';
import { DemoWhatsAppProvider } from './DemoWhatsAppProvider';

/**
 * Chooses the installed messaging provider.
 *
 * ## Why this exists as a function rather than a conditional at the call site
 *
 * It is the seam a real integration would slot into. Adding one means writing a class that implements
 * `WhatsAppProvider` and a branch here — nothing in the notification service, the engines or the dashboard
 * changes, because none of them know which provider is installed.
 *
 * ## Why the default is not configurable to something unsafe
 *
 * `WHATSAPP_PROVIDER` defaults to `demo`, and an unrecognised value falls back to `demo` with a warning rather
 * than throwing or silently doing nothing. The bias is deliberate: a typo in configuration should degrade to the
 * provider that cannot contact anyone, not to a broken app and certainly not to an accidental real send.
 *
 * There are no credentials here, and there is no code path that reads any. A real provider would need them, which
 * is why the placeholders in `.env.example` are commented out — the project must run with no secrets at all.
 */
export function selectWhatsAppProvider(): WhatsAppProvider {
  const configured = env.WHATSAPP_PROVIDER;

  if (configured !== 'demo') {
    logger.warn(
      `unknown WHATSAPP_PROVIDER "${configured}"; falling back to the demo provider. ` +
        `No real provider is implemented — messages are simulated locally.`,
      { configured },
    );
  }

  const provider = new DemoWhatsAppProvider();

  logger.info('messaging provider selected', {
    provider: provider.name,
    simulated: provider.isSimulated,
  });

  return provider;
}
