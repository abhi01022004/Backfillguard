import { useState } from 'react';
import { DISCLAIMER } from '@bg/shared';
import { useLiveStream } from '../hooks/useLiveStream';
import { usePatients, EMPTY_FILTERS, type PatientFilters } from '../hooks/usePatients';
import { usePatientDetail } from '../hooks/usePatientDetail';
import { PatientTable } from '../components/patients/PatientTable';
import { PatientDetailDrawer } from '../components/patients/PatientDetailDrawer';
import { ConnectionNotice } from '../components/layout/ConnectionNotice';
import { useHashLocation } from '../routes';

/**
 * The patient browser (R16).
 *
 * Subscribes to the live stream for two reasons: the run's partition count drives the partition filter, and
 * the stream tells both hooks when their data has become stale. Neither needs polling as a result.
 */
export function Patients() {
  const { status, job, events, resync } = useLiveStream();
  const { params } = useHashLocation();

  const [filters, setFilters] = useState<PatientFilters>(EMPTY_FILTERS);

  /**
   * A `?code=` parameter opens that record immediately.
   *
   * This is what makes the conflict list's patient links useful: click a code on the dashboard and land here
   * with that record's history already open, rather than on a list you then have to search.
   */
  const [selectedCode, setSelectedCode] = useState<string | null>(() => params.get('code'));

  const patients = usePatients(filters, events);
  const detail = usePatientDetail(selectedCode, events);

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 px-4 py-6 sm:px-6">
      <ConnectionNotice status={status} onRetry={resync} />

      <div>
        <h1 className="text-lg font-semibold text-slate-900">Patient records</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-600">
          Every record is synthetic. The <span className="font-medium">Version / scored</span> column is the
          one to watch: the first number is the source data's version, the second is the version the stored
          risk score was derived from. When they differ, that score is older than the data — open a record to
          see exactly which update moved it and what the backfill did about it.
        </p>
      </div>

      <PatientTable
        state={patients}
        filters={filters}
        onFiltersChange={setFilters}
        partitionCount={job?.settings.partitionCount ?? undefined}
        onSelect={setSelectedCode}
        selectedCode={selectedCode}
      />

      <PatientDetailDrawer
        code={selectedCode}
        detail={detail.detail}
        loading={detail.loading}
        error={detail.error}
        onClose={() => setSelectedCode(null)}
        onRefresh={detail.refetch}
      />

      <p className="pb-2 text-center text-xs text-slate-400">{DISCLAIMER.LONG}</p>
    </div>
  );
}
