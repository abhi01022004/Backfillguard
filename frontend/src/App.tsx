import { DisclaimerBanner } from './components/layout/DisclaimerBanner';
import { Header } from './components/layout/Header';
import { Nav } from './components/layout/Nav';
import { Dashboard } from './pages/Dashboard';
import { Patients } from './pages/Patients';
import { Comparison } from './pages/Comparison';
import { Report } from './pages/Report';
import { ROUTES, useHashLocation } from './routes';

/**
 * Application shell.
 *
 * Four routes, dispatched by a switch over the hash. Each page owns its own data subscriptions rather than
 * receiving them from here: the comparison page deliberately has none, and threading a live stream through a
 * shell that does not use it would imply a coupling that is not there.
 *
 * Every page is mounted fresh on navigation, which drops its subscriptions. That is intentional — a background
 * page holding an open socket and refetching on every event would do work nobody can see.
 */
export default function App() {
  const { route } = useHashLocation();

  return (
    <div className="min-h-screen bg-slate-50">
      {/**
       * Skip link (R24.6).
       *
       * The banner, header and nav sit ahead of the content, so a keyboard user would otherwise tab through
       * roughly a dozen controls on every page change before reaching anything they came for. Hidden until
       * focused, so it costs nothing visually and appears exactly when it is useful.
       */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-brand-700 focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-white"
      >
        Skip to page content
      </a>

      <DisclaimerBanner />
      <Header />
      <Nav current={route} />

      {/* Named landmark so keyboard and screen-reader users can jump straight to page content. */}
      <main id="main" aria-label="Page content">
        {route === ROUTES.patients ? (
          <Patients />
        ) : route === ROUTES.compare ? (
          <Comparison />
        ) : route === ROUTES.report ? (
          <Report />
        ) : (
          <Dashboard />
        )}
      </main>
    </div>
  );
}
