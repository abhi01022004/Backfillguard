import { useState } from 'react';
import { DISCLAIMER } from '@bg/shared';
import { useComparison, type ComparisonScenario } from '../hooks/useComparison';
import { ComparisonView } from '../components/compare/ComparisonView';

/**
 * The comparison page (R12).
 *
 * Deliberately does not subscribe to the live stream. The comparison runs entirely in memory on its own
 * generated datasets and has nothing to do with the live job, so binding it to run state would imply a
 * relationship that does not exist — and would make the page look broken when no backfill is running.
 */
export function Comparison() {
  const [scenario, setScenario] = useState<ComparisonScenario>('contended');
  const state = useComparison();

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 px-4 py-6 sm:px-6">
      <ComparisonView state={state} scenario={scenario} onScenarioChange={setScenario} />
      <p className="pb-2 text-center text-xs text-slate-400">{DISCLAIMER.LONG}</p>
    </div>
  );
}
