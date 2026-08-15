import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OPENSHANNON_ROOT = path.resolve(os.homedir(), 'openshannon');

export const ALLOWED_TARGETS = Object.freeze({
  crapi: path.join(OPENSHANNON_ROOT, 'test-apps', 'crapi'),
  vulnerable: path.join(OPENSHANNON_ROOT, 'test-apps', 'vulnerable'),
});

const TARGETS_BY_PATH = new Map([
  [ALLOWED_TARGETS.crapi, { name: 'crapi', url: 'http://host.docker.internal:8888', healthUrl: 'http://127.0.0.1:8888', composeFile: 'deploy/docker/docker-compose.yml' }],
  [ALLOWED_TARGETS.vulnerable, { name: 'vulnerable', url: 'http://host.docker.internal:8787', healthUrl: 'http://127.0.0.1:8787' }],
]);

const EXPLICIT_DENIAL = /(?:https?:\/\/|file:\/\/|attentia\.at|46\.224\.100\.69|supabase|(?:^|[^\d])\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:$|[^\d]))/i;

export function resolveTarget(rawTarget) {
  if (typeof rawTarget !== 'string' || rawTarget.trim() === '') {
    throw new Error('REFUSING target: --target is required; unset or empty targets are denied.');
  }

  const requested = path.resolve(rawTarget);
  const configured = TARGETS_BY_PATH.get(requested);
  if (!configured) {
    const reason = EXPLICIT_DENIAL.test(rawTarget)
      ? 'remote, public, production-like, or non-local target detected'
      : 'path is not one of the exact allowlisted local fixtures';
    throw new Error(`DENIED target '${rawTarget}': ${reason}; no scan was started.`);
  }

  if (!fs.existsSync(requested)) {
    throw new Error(`REJECTED target '${requested}': allowlisted fixture is missing; no scan was started.`);
  }

  let canonical;
  try {
    canonical = fs.realpathSync(requested);
  } catch {
    throw new Error(`REJECTED target '${requested}': canonical path could not be resolved; no scan was started.`);
  }
  if (canonical !== requested) {
    throw new Error(`DENIED target '${rawTarget}': symlinked paths are not accepted; no scan was started.`);
  }

  return Object.freeze({ path: requested, ...configured });
}

export function allowedTargetList() {
  return Object.values(ALLOWED_TARGETS);
}
