/*
 * Perf target: OWASP crAPI (docker-compose).
 *
 * Realistic, deliberately-vulnerable API application (OWASP/crAPI), booted via
 * the bundled `deploy/docker/docker-compose.yml`. The nginx gateway publishes
 * the whole (identity/workshop/community) API on one port (default 8888).
 *
 * Expected findings are sourced from sample-reports/shannon-report-crapi.md
 * (a real Shannon scan of crAPI). NOTE: crAPI has NO XSS class in that report
 * — every other planted class is present, so `xss` is deliberately excluded
 * from expectations (the runner only asserts keys present here).
 *
 * Targets are registered in perf/targets/. Boot is orchestrated by the runner
 * via the `compose` kind: `docker compose -f <composeFile> up -d`, wait for
 * `/health`, then `docker compose down`.
 */
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// test-apps/crapi is the cloned OWASP/crAPI repo (gitignored; fetched ad-hoc).
const crapiRoot = path.resolve(__dirname, '../../test-apps/crapi');

export default {
  name: 'crapi',
  kind: 'compose',
  // Source tree Shannon analyses (whitebox). For compose targets this is the
  // cloned app repo rather than a hermetic app entry.
  sourceDir: crapiRoot,
  // Compose project + boot plumbing:
  composeDir: path.join(crapiRoot, 'deploy/docker'),
  composeFile: 'docker-compose.yml',
  // The nginx gateway port (web service maps ${LISTEN_IP}:8888:80).
  port: 8888,
  healthPath: '/health',
  // Env overrides passed to `docker compose`. Boot HTTP (no TLS) and bind all
  // interfaces so the Shannon worker container can reach host.docker.internal.
  env: {
    LISTEN_IP: '0.0.0.0',
    TLS_ENABLED: 'false',
    LOG_LEVEL: 'INFO',
    ENABLE_SHELL_INJECTION: 'true',
    ENABLE_LOG4J: 'true',
  },
  description:
    'OWASP crAPI (docker-compose). Planted classes (per sample report): SQLi + NoSQLi coupon/injection, JWT alg:none + confusion auth bypass, IDOR/BOLA on orders+posts+mechanic, SSRF via contact_mechanic. No XSS class (correctly absent).',
  expectations: {
    injection: {
      // SQLi in /workshop/api/shop/apply_coupon (coupon_code); NoSQLi in
      // /community/api/v2/coupon/validate-coupon.
      indicators: [
        /workshop\/api\/shop\/apply_coupon/i,
        /community\/api\/v2\/coupon\/validate-coupon/i,
        /sql injection/i,
        /nosql/i,
        /\$ne/i,
      ],
      planted: 'SQLi (/workshop/api/shop/apply_coupon) + NoSQLi (/community/api/v2/coupon/validate-coupon)',
    },
    auth: {
      // JWT alg:none / HS256 confusion / KID injection; login + enumeration.
      indicators: [
        /identity\/api\/auth\/login/i,
        /identity\/api\/v2\/user\/dashboard/i,
        /alg/i,
        /\bjwt\b/i,
        /algorithm confusion/i,
        /unsigned/i,
        /user enumer/i,
      ],
      planted: 'JWT alg:none + algorithm-confusion auth bypass; login/user enumeration',
    },
    authz: {
      // BOLA/IDOR: orders unauthenticated, community posts ownership, mechanic.
      indicators: [
        /workshop\/api\/shop\/orders/i,
        /community\/api\/v2\/community\/posts/i,
        /workshop\/api\/mechanic/i,
        /\bidor\b/i,
        /horizontal privilege/i,
        /bola/i,
      ],
      planted: 'BOLA/IDOR: /workshop/api/shop/orders (unauthenticated), community posts, mechanic endpoints',
    },
    ssrf: {
      indicators: [
        /workshop\/api\/merchant\/contact_mechanic/i,
        /mechanic_api/i,
        /server-?side request/i,
        /\bssrf\b/i,
      ],
      planted: 'SSRF via /workshop/api/merchant/contact_mechanic (mechanic_api param)',
    },
  },
};
