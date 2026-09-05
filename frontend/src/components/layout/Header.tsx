import { ShieldCheck } from 'lucide-react';
import { HealthIndicator } from './HealthIndicator';

/**
 * Application header (R14.1). Title, subtitle and subtext are fixed by the requirements — a judge
 * should be able to read what this project is in one glance.
 */
export function Header() {
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-[1600px] flex-col gap-4 px-4 py-5 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-600">
            <ShieldCheck className="h-6 w-6 text-white" aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">
              BackfillGuard
            </h1>
            <p className="text-sm font-medium text-brand-700">
              Safe Concurrent Healthcare Data Backfill
            </p>
            <p className="mt-0.5 text-sm text-slate-500">
              Protecting newer patient data during large-scale background migrations.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <HealthIndicator />
        </div>
      </div>
    </header>
  );
}
