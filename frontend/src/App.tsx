import { DisclaimerBanner } from './components/layout/DisclaimerBanner';
import { Header } from './components/layout/Header';
import { Dashboard } from './pages/Dashboard';

/**
 * Application shell.
 *
 * A single view for now. Navigation arrives with the second destination (the patient list, in task 17) —
 * a nav bar with one entry is noise, and stub entries pointing at pages that do not exist would be worse.
 */
export default function App() {
  return (
    <div className="min-h-screen bg-slate-50">
      <DisclaimerBanner />
      <Header />
      <main>
        <Dashboard />
      </main>
    </div>
  );
}
