import { CircleDashed, Database, Radio, ServerCog } from 'lucide-react';
import { DisclaimerBanner } from './components/layout/DisclaimerBanner';
import { Header } from './components/layout/Header';

/**
 * Foundation shell (task 1).
 *
 * Deliberately shows only what is genuinely wired. No KPI cards, no progress bars and no sample
 * numbers appear until they are backed by real simulation state — a placeholder that looks like a
 * measurement is exactly the credibility problem R14.6 exists to prevent.
 */

interface FoundationItem {
  label: string;
  detail: string;
  ready: boolean;
  icon: typeof ServerCog;
}

const FOUNDATION: FoundationItem[] = [
  {
    label: 'API layer',
    detail: 'Express, zod validation, structured error envelope, correlated request logging',
    ready: true,
    icon: ServerCog,
  },
  {
    label: 'Shared contract',
    detail: 'Enums, DTOs and simulation bounds shared by backend and frontend',
    ready: true,
    icon: CircleDashed,
  },
  {
    label: 'Persistence',
    detail: 'SQLite schema, synthetic patient generator and seeding — task 2',
    ready: false,
    icon: Database,
  },
  {
    label: 'Live event stream',
    detail: 'Socket.IO transport for the dashboard timeline — task 13',
    ready: false,
    icon: Radio,
  },
];

export default function App() {
  return (
    <div className="min-h-screen bg-slate-50">
      <DisclaimerBanner />
      <Header />

      <main className="mx-auto max-w-[1600px] px-4 py-8 sm:px-6">
        <section
          aria-labelledby="foundation-heading"
          className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
        >
          <h2 id="foundation-heading" className="text-base font-semibold text-slate-900">
            Foundation
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Project scaffolding is in place and the frontend is talking to the backend. The
            simulation engine, dashboard and verification report are built in the tasks that follow.
          </p>

          <ul className="mt-5 grid gap-3 sm:grid-cols-2">
            {FOUNDATION.map((item) => {
              const Icon = item.icon;
              return (
                <li
                  key={item.label}
                  className="flex items-start gap-3 rounded-lg border border-slate-200 bg-slate-50/60 p-4"
                >
                  <Icon
                    className={
                      item.ready
                        ? 'mt-0.5 h-5 w-5 shrink-0 text-brand-600'
                        : 'mt-0.5 h-5 w-5 shrink-0 text-slate-400'
                    }
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium text-slate-900">
                      {item.label}
                      <span
                        className={
                          item.ready
                            ? 'rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700'
                            : 'rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600'
                        }
                      >
                        {item.ready ? 'Ready' : 'Pending'}
                      </span>
                    </p>
                    <p className="mt-0.5 text-xs text-slate-600">{item.detail}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      </main>
    </div>
  );
}
