import { FlaskConical } from 'lucide-react';
import { DISCLAIMER } from '@bg/shared';

/**
 * Persistent synthetic-data banner (R14.5, R22.2).
 *
 * Rendered on every page. The text comes from `@bg/shared` so no surface can drift from the agreed
 * wording or quietly omit it.
 */
export function DisclaimerBanner() {
  return (
    <div className="border-b border-amber-200 bg-amber-50">
      <div className="mx-auto flex max-w-[1600px] items-center gap-2 px-4 py-1.5 sm:px-6">
        <FlaskConical className="h-3.5 w-3.5 shrink-0 text-amber-700" aria-hidden="true" />
        <p className="text-xs font-medium text-amber-900">
          {DISCLAIMER.DATA}
          <span className="ml-2 hidden font-normal text-amber-800 sm:inline">
            All records are randomly generated. Nothing here has clinical meaning.
          </span>
        </p>
      </div>
    </div>
  );
}
