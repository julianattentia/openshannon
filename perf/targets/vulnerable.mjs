/*
 * Perf target: the hermetic, purpose-built `test-apps/vulnerable` app.
 *
 * Option 1 of the planned target set. Each planted vuln maps to the Shannon
 * agent that should surface it; `expectations.indicators` are the tolerant
 * (endpoint + keyword) markers that prove the class was found.
 */
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default {
  name: 'vulnerable',
  kind: 'hermetic-app', // booted from a local Node source tree, zero deps
  appSrc: path.resolve(__dirname, '../../test-apps/vulnerable'),
  entry: 'app.js',
  healthPath: '/api/health',
  defaultPort: 8787,
  // Extra env for boot (BASE_URL is derived from the chosen port by the runner).
  env: {},
  // Description rendered into the report.
  description:
    'Purpose-built hermetic fixture. Planted vulns: SQLi /api/search, reflected XSS /api/echo, stored XSS /api/item, alg:none auth bypass + user enumeration on /api/login /api/admin, IDOR /api/profile/:id, SSRF /api/fetch. Control: /api/control/secure',
  // Deterministic acceptance criteria for each Shannon vuln class.
  // Indicators are deliberately endpoint/finding-specific — NOT bare class
  // words ("SQL", "XSS", "Authorisation") which appear verbatim in every
  // section heading and would make the gate pass trivially.
  expectations: {
    injection: {
      indicators: [/\/api\/search/i, /sql injection/i],
      planted: 'SQLi on /api/search (string-concat WHERE)',
    },
    xss: {
      indicators: [/\/api\/echo/i, /\/api\/item/i, /cross-?site scripting/i, /\bxss\b/i],
      planted: 'reflected XSS /api/echo + stored XSS /api/item',
    },
    auth: {
      indicators: [/\/api\/admin/i, /\/api\/login/i, /\bjwt\b/i, /unsigned/i, /algorithm confusion/i, /user enum/i],
      planted: 'alg:none JWT admin bypass + login user enumeration',
    },
    authz: {
      indicators: [/\/api\/profile/i, /\bidor\b/i, /horizontal privilege/i],
      planted: 'IDOR on /api/profile/:id (no ownership check)',
    },
    ssrf: {
      indicators: [/\/api\/fetch/i, /server-?side request/i, /\bssrf\b/i],
      planted: 'SSRF on /api/fetch (arbitrary server-side fetch)',
    },
  },
};