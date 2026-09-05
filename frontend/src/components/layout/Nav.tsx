import { GitCompareArrows, LayoutDashboard, ScrollText, Users } from 'lucide-react';
import { ROUTES, type Route } from '../../routes';

/**
 * Primary navigation.
 *
 * Rendered as real anchors with `href="#/..."` rather than buttons calling a navigate function. That gives
 * middle-click, open-in-new-tab and copy-link for free, and means the current page is shareable — which
 * matters when someone wants to point a colleague at the verification report specifically.
 */

interface NavItem {
  route: Route;
  label: string;
  icon: typeof LayoutDashboard;
  description: string;
}

const ITEMS: readonly NavItem[] = [
  {
    route: ROUTES.dashboard,
    label: 'Dashboard',
    icon: LayoutDashboard,
    description: 'Live run, partitions, events and conflicts',
  },
  {
    route: ROUTES.patients,
    label: 'Patients',
    icon: Users,
    description: 'Records with version history',
  },
  {
    route: ROUTES.compare,
    label: 'Comparison',
    icon: GitCompareArrows,
    description: 'Naive backfill versus BackfillGuard',
  },
  {
    route: ROUTES.report,
    label: 'Verification',
    icon: ScrollText,
    description: 'Independent audit and export',
  },
];

export interface NavProps {
  current: Route;
}

export function Nav({ current }: NavProps) {
  return (
    <nav aria-label="Primary" className="border-b border-slate-200 bg-white">
      <ul className="mx-auto flex max-w-[1600px] gap-1 overflow-x-auto px-4 sm:px-6">
        {ITEMS.map((item) => {
          const Icon = item.icon;
          const active = item.route === current;

          return (
            <li key={item.route}>
              <a
                href={`#${item.route}`}
                title={item.description}
                // The accessible current-page signal. Colour and a border are the visual form of the same
                // fact, never the only form.
                aria-current={active ? 'page' : undefined}
                className={`flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${
                  active
                    ? 'border-brand-600 text-brand-800'
                    : 'border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900'
                }`}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {item.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
