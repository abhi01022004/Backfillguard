import { useEffect, useState } from 'react';

/**
 * Hash-based routing, with no router dependency.
 *
 * ## Why hash routing rather than the History API
 *
 * The app is served by Vite in development and as static files in any demo deployment. Path-based routing
 * needs the server to rewrite every unknown path to `index.html`; get that wrong and a judge who refreshes
 * on `/report` sees a 404 — a failure with nothing to do with the project, at the worst possible moment.
 * Hash routes need no server cooperation at all and are still deep-linkable and shareable.
 *
 * ## Why not a routing library
 *
 * Four flat routes, one optional query parameter, no nesting and no data loading. A router would add a
 * dependency and an abstraction layer to express something a `switch` already expresses.
 */

export const ROUTES = {
  dashboard: '/',
  patients: '/patients',
  compare: '/compare',
  report: '/report',
} as const;

export type Route = (typeof ROUTES)[keyof typeof ROUTES];

const ALL_ROUTES: readonly Route[] = Object.values(ROUTES);

export interface Location {
  route: Route;
  /**
   * Query parameters after the route, e.g. `#/patients?code=P0042`.
   *
   * Parsed here rather than left to each page so that a hash carrying a parameter still *matches* its route.
   * An earlier version compared the whole hash against the route list, so any link with a parameter silently
   * fell back to the dashboard — which would have broken every "open this patient" link from the conflict
   * list.
   */
  params: URLSearchParams;
}

function parseLocation(): Location {
  const raw = window.location.hash.replace(/^#/, '');
  const [path = '', query = ''] = raw.split('?');

  const normalised = path === '' ? ROUTES.dashboard : path;
  const route = (ALL_ROUTES as readonly string[]).includes(normalised)
    ? (normalised as Route)
    : ROUTES.dashboard;

  return { route, params: new URLSearchParams(query) };
}

export function useHashLocation(): Location {
  const [location, setLocation] = useState<Location>(parseLocation);

  useEffect(() => {
    const onHashChange = () => setLocation(parseLocation());
    window.addEventListener('hashchange', onHashChange);
    // Re-read on mount too: the hash may have changed between module load and this effect running.
    onHashChange();
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return location;
}

/** Builds a hash href, so links are constructed in one place rather than string-concatenated at call sites. */
export function hrefFor(route: Route, params: Record<string, string> = {}): string {
  const query = new URLSearchParams(params).toString();
  return `#${route}${query ? `?${query}` : ''}`;
}

export function navigate(route: Route, params: Record<string, string> = {}): void {
  window.location.hash = hrefFor(route, params).slice(1);
}
