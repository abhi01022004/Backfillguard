import { DISCLAIMER, type RiskLevel } from '@bg/shared';

/**
 * Renders the message body.
 *
 * ## The constraints this has to respect
 *
 * The message is the one artefact of this feature that looks like it came from a healthcare system, so the
 * wording carries the most risk of overclaiming. Three rules, all deliberate:
 *
 * **It states an observation, never a conclusion.** "A high synthetic risk score was calculated" is a fact about
 * a computation. "This patient is at high risk" would be a clinical claim, and "requires treatment" would be
 * advice. Neither appears, and no wording implying diagnosis, disease or required action is used anywhere.
 *
 * **The disclaimer is not optional and not editable here.** It comes from `DISCLAIMER.RISK_SCORE` in the shared
 * config, the same constant every other surface uses, so no message can drift from the agreed wording or omit
 * it. A formatter that composed its own disclaimer string would be one refactor away from losing it.
 *
 * **It carries the minimum identifying detail.** Patient code, score, band, version. Not the name, not the
 * clinical values, not the diagnosis. A real alert would go to a clinician who can look the record up; shipping
 * the record inside the message is both unnecessary and the wrong habit to demonstrate.
 *
 * The version is included because it is the whole point of the feature: it says which state of the record this
 * alert describes, so an alert can be checked against the data rather than trusted.
 */

export interface MessageInput {
  patientCode: string;
  riskScore: number;
  riskLevel: RiskLevel;
  patientVersion: number;
}

export function formatRiskAlert({
  patientCode,
  riskScore,
  riskLevel,
  patientVersion,
}: MessageInput): string {
  return [
    '⚠️ BackfillGuard Risk Alert',
    '',
    `Patient: ${patientCode}`,
    `Risk Score: ${riskScore}`,
    `Risk Level: ${riskLevel}`,
    `Record Version: v${patientVersion}`,
    '',
    'A high synthetic risk score was calculated for this record during the BackfillGuard simulation, from the',
    'clinical values the record held at the version above.',
    '',
    'Please review the record.',
    '',
    DISCLAIMER.RISK_SCORE,
    'Demo notification only — no message was actually transmitted.',
  ].join('\n');
}

/**
 * A one-line summary for the event stream.
 *
 * The timeline shows dozens of events, so a fourteen-line message body would drown it. The full text is stored
 * on the notification and rendered in the simulator panel; this is what appears in the feed.
 */
export function formatEventSummary({
  patientCode,
  riskScore,
  riskLevel,
  patientVersion,
}: MessageInput): string {
  return `${patientCode}: ${riskLevel} risk (score ${riskScore}) at v${patientVersion}`;
}
