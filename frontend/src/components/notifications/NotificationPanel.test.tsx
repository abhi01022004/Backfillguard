import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NOTIFICATION_REASON, NOTIFICATION_STATUS, RISK_LEVEL } from '@bg/shared';
import { makeNotification, makeNotificationStats } from '../../test/fixtures';
import type { NotificationsState } from '../../hooks/useNotifications';
import { NotificationPanel } from './NotificationPanel';
import { NotificationKpis } from './NotificationKpis';
import { MessageSimulator } from './MessageSimulator';

/**
 * The notification UI's honesty properties.
 *
 * These are rendering guarantees, so they can only be broken here — the backend cannot enforce them. Three are
 * worth a test each:
 *
 * 1. A simulated send must **say** it is simulated. A panel that looked identical to a real integration would
 *    be indistinguishable from a real one that was quietly broken.
 * 2. A cancelled alert must be presented as the guard **working**, not as a failure. It is the only positive
 *    evidence on screen that stale alerts are prevented rather than merely absent.
 * 3. The message body must be rendered **verbatim**. Rebuilding a prettier version here would make this a second
 *    formatter, free to drift from the one that produced what was actually sent.
 */

function makeState(overrides: Partial<NotificationsState> = {}): NotificationsState {
  return {
    notifications: [],
    stats: null,
    provider: { name: 'demo', simulated: true },
    loading: false,
    error: null,
    sending: false,
    sendError: null,
    sendTest: vi.fn(async () => {}),
    refetch: vi.fn(),
    ...overrides,
  };
}

describe('NotificationPanel', () => {
  it('says the provider is simulated', () => {
    render(<NotificationPanel notifications={makeState()} />);

    // Plural: the heading badge and the simulator's own badge both say it.
    expect(screen.getAllByText(/simulated/i).length).toBeGreaterThan(0);
  });

  it('explains that an empty list means no HIGH result has been committed', () => {
    render(<NotificationPanel notifications={makeState()} />);

    expect(screen.getByText('No risk alerts yet.')).toBeInTheDocument();
    expect(screen.getByText(/committed under/i)).toBeInTheDocument();
  });

  it('presents a cancelled alert as a prevented stale alert, not a failure', () => {
    const state = makeState({
      notifications: [
        makeNotification({
          id: 7,
          status: NOTIFICATION_STATUS.CANCELLED,
          reason: NOTIFICATION_REASON.STALE_NOTIFICATION_CANCELLED,
          providerMessageId: null,
          sentAt: null,
          cancelledAt: '2026-01-01T09:00:01.000Z',
        }),
      ],
    });

    render(<NotificationPanel notifications={state} />);

    expect(screen.getByText(/stale alert prevented/i)).toBeInTheDocument();
    // The wording must not imply something went wrong with delivery.
    expect(screen.queryByText(/delivery failed/i)).not.toBeInTheDocument();
  });

  it('filters by status and keeps the counts consistent with what it shows', async () => {
    const user = userEvent.setup();

    const state = makeState({
      notifications: [
        makeNotification({ id: 1, patientCode: 'P0001', status: NOTIFICATION_STATUS.SENT }),
        makeNotification({ id: 2, patientCode: 'P0002', status: NOTIFICATION_STATUS.SENT }),
        makeNotification({
          id: 3,
          patientCode: 'P0003',
          status: NOTIFICATION_STATUS.CANCELLED,
          providerMessageId: null,
        }),
      ],
    });

    render(<NotificationPanel notifications={state} />);

    // All three visible under "All". P0003 appears twice — once as a row, once in the simulator, because
    // the newest row is selected by default.
    expect(screen.getByText('P0001')).toBeInTheDocument();
    expect(screen.getAllByText('P0003').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('tab', { name: /Prevented/ }));

    expect(screen.queryByText('P0001')).not.toBeInTheDocument();
    expect(screen.getAllByText('P0003').length).toBeGreaterThan(0);
  });

  it('fires the manual test send and disables the button while it is in flight', async () => {
    const user = userEvent.setup();
    const sendTest = vi.fn(async () => {});

    const { rerender } = render(
      <NotificationPanel notifications={makeState({ sendTest })} />,
    );

    await user.click(screen.getByRole('button', { name: /Send test WhatsApp/i }));
    expect(sendTest).toHaveBeenCalledTimes(1);

    rerender(<NotificationPanel notifications={makeState({ sendTest, sending: true })} />);
    expect(screen.getByRole('button', { name: /Sending/i })).toBeDisabled();
  });

  it('surfaces a send failure instead of failing silently', () => {
    render(
      <NotificationPanel
        notifications={makeState({ sendError: 'Seed the dataset first.' })}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Seed the dataset first.');
  });
});

describe('MessageSimulator', () => {
  it('renders the stored message body verbatim', () => {
    const record = makeNotification({
      message: 'LINE ONE\nLINE TWO — exact text',
    });

    render(<MessageSimulator record={record} providerName="demo" simulated />);

    // Matched as a whole so a reformatted or reassembled body would fail.
    expect(screen.getByText(/LINE ONE\s+LINE TWO — exact text/)).toBeInTheDocument();
  });

  it('shows the idempotency key, because it is why recovery cannot alert twice', () => {
    render(
      <MessageSimulator
        record={makeNotification({ idempotencyKey: 'JOB-1:42:3:HIGH' })}
        providerName="demo"
        simulated
      />,
    );

    expect(screen.getByText('JOB-1:42:3:HIGH')).toBeInTheDocument();
  });

  it('reports no provider id for an alert that was never sent', () => {
    render(
      <MessageSimulator
        record={makeNotification({
          status: NOTIFICATION_STATUS.CANCELLED,
          providerMessageId: null,
        })}
        providerName="demo"
        simulated
      />,
    );

    expect(screen.getByText('not sent')).toBeInTheDocument();
  });
});

describe('NotificationKpis', () => {
  it('renders em dashes rather than zeros before anything is measured', () => {
    render(<NotificationKpis stats={null} loaded />);

    expect(screen.getAllByText('—')).toHaveLength(4);
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('withholds a success rate rather than claiming 100% for nothing attempted', () => {
    render(<NotificationKpis stats={makeNotificationStats({ successRate: null })} loaded />);

    expect(screen.getByText('nothing attempted yet')).toBeInTheDocument();
  });

  it('renders a measured zero as a real zero', () => {
    render(
      <NotificationKpis
        stats={makeNotificationStats({ total: 0, highRiskPatients: 0, sent: 0, cancelled: 0, successRate: null })}
        loaded
      />,
    );

    // Three measured zeros; the rate is the only withheld one.
    expect(screen.getAllByText('0')).toHaveLength(3);
  });

  it('describes a cancelled alert as the guard working', () => {
    render(<NotificationKpis stats={makeNotificationStats({ cancelled: 2 })} loaded />);

    expect(screen.getByText('Stale alerts prevented')).toBeInTheDocument();
    expect(screen.getByText('the record moved before sending')).toBeInTheDocument();
  });

  it('does not label a HIGH-risk count as an error state', () => {
    render(<NotificationKpis stats={makeNotificationStats({ highRiskPatients: 5 })} loaded />);

    expect(screen.getByText('High-risk patients')).toBeInTheDocument();
    expect(screen.getByText('distinct patients alerted on')).toBeInTheDocument();
  });
});

describe('risk level presentation', () => {
  it('shows the source version alongside the risk band on every row', () => {
    // The version is the whole argument: it is what makes the alert provably non-stale.
    render(
      <NotificationPanel
        notifications={makeState({
          notifications: [
            makeNotification({ patientVersion: 12, riskLevel: RISK_LEVEL.HIGH, riskScore: 91 }),
          ],
        })}
      />,
    );

    expect(screen.getAllByText('v12').length).toBeGreaterThan(0);
    expect(screen.getByText(/HIGH\s+91/)).toBeInTheDocument();
  });
});
