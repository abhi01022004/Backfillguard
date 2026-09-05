import { JOB_ACTION, whyNotAllowed } from '@bg/shared';
import { useLiveStream } from '../hooks/useLiveStream';
import { useVerificationReport } from '../hooks/useVerificationReport';
import { useSimulationControls } from '../hooks/useSimulationControls';
import { VerificationReportView } from '../components/report/VerificationReportView';

/**
 * The verification report page (R20).
 *
 * Subscribes to the live stream for two things: to know whether the audit may be run right now, and to be told
 * when the report has been superseded — a new run makes the previous audit a description of history, and
 * `useVerificationReport` refetches on exactly those events.
 */
export function Report() {
  const { job, events } = useLiveStream();
  const { report, loading, loaded, error } = useVerificationReport(events);
  const controls = useSimulationControls();

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-6 sm:px-6">
      <VerificationReportView
        report={report}
        loading={loading}
        loaded={loaded}
        error={error ?? controls.error?.message ?? null}
        onVerify={() => void controls.verify()}
        verifyDisabledReason={whyNotAllowed(JOB_ACTION.VERIFY, job?.status ?? null)}
        verifyBusy={controls.pending === 'verify'}
      />
    </div>
  );
}
