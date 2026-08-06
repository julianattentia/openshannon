/*
 * Perf target: OWASP Juice Shop (docker-compose).
 *
 * PLANNED (option 3 of 4). Not wired yet. Implements `expectations` (per-class
 * indicators from sample-reports/shannon-report-juice-shop.md) and a compose
 * boot/teardown to activate. Until then the runner refuses loudly.
 */
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default {
  name: 'juice-shop',
  kind: 'compose',
  description:
    'PLANNED: OWASP Juice Shop (docker-compose) — realistic storefront. Indicators, compose boot, and teardown still to be added; see sample-reports/shannon-report-juice-shop.md.',
  expect: null,
};