const SEVERITIES = ['critical', 'high', 'medium', 'low', 'informational'];

export function summarizeReport(reportText) {
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
  const fieldPattern = /\*\*severity:\*\*\s*(critical|high|medium|low|informational)\b/gi;
  const headingPattern = /^#{1,6}\s*(critical|high|medium|low|informational)\b/gim;
  const fields = [...reportText.matchAll(fieldPattern)];
  const matches = fields.length > 0 ? fields : [...reportText.matchAll(headingPattern)];
  for (const match of matches) counts[match[1].toLowerCase()] += 1;

  const message = `Findings summary: critical=${counts.critical}, high=${counts.high}, medium=${counts.medium}, low=${counts.low}, informational=${counts.informational}`;
  return { counts, message };
}
