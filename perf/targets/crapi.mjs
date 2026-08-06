/*
 * Perf target: cRAPi (deliberately-vulnerable API app, docker-compose).
 *
 * PLANNED (option 2 of 4). Not wired yet. Implements `expectations` (the
 * per-class indicators cRAPi's report surfaces — see sample-reports/
 * shannon-report-crapi.md) and a `docker compose` boot/teardown to activate.
 * Until then the runner refuses loudly rather than giving a false result.
 */
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default {
  name: 'crapi',
  kind: 'compose',
  // Not-implemented marker: runner throws when expectations is absent.
  description:
    'PLANNED: cRAPi (docker-compose) — realistic vulnerable API. Indicators, compose boot, and teardown still to be added; see sample-reports/shannon-report-crapi.md.',
  expect: null,
};