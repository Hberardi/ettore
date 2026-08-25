import { access, realpath } from 'fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'path';
import { uiBridge } from './bridge.js';

const VALID_PROFILES = new Set(['safe', 'balanced', 'autonomous']);
let activePolicy = null;
const sessionApprovals = new Set();

function normalizeProfile(profile) {
  const value = String(profile || 'balanced').toLowerCase();
  return VALID_PROFILES.has(value) ? value : 'balanced';
}

function normalizePolicy(policy) {
  if (!policy) return null;
  return {
    root: resolve(policy.root || process.cwd()),
    profile: normalizeProfile(policy.profile),
  };
}

export function setWorkspacePolicy(policy) {
  activePolicy = normalizePolicy(policy);
}

export function getWorkspacePolicy() {
  return activePolicy ? { ...activePolicy } : null;
}

async function nearestExistingPath(target) {
  let current = target;
  while (true) {
    try {
      await access(current);
      return realpath(current);
    } catch {}
    const parent = dirname(current);
    if (parent === current) return resolve(target);
    current = parent;
  }
}

function isInside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function confirmExternalPath({ operation, path, root }) {
  const key = `${operation}:${path}`;
  if (sessionApprovals.has(key)) return true;
  if (uiBridge.listenerCount('askUser') === 0) return false;

  const answer = await new Promise(resolveAnswer => {
    uiBridge.emit('askUser', {
      question: `Accesso esterno alla workspace richiesto.\nOperazione: ${operation}\nPath: ${path}\nWorkspace: ${root}`,
      options: ['Sì, consenti', 'No, blocca'],
      resolve: resolveAnswer,
    });
  });
  const allowed = /^Sì/i.test(String(answer));
  if (allowed) sessionApprovals.add(key);
  return allowed;
}

export async function authorizePath(pathValue, operation = 'read', policyOverride = null) {
  const policy = normalizePolicy(policyOverride) || activePolicy;
  if (!policy || !pathValue) return { allowed: true };

  const requested = isAbsolute(String(pathValue))
    ? resolve(String(pathValue))
    : resolve(policy.root, String(pathValue));
  const rootReal = await nearestExistingPath(policy.root);
  const targetReal = await nearestExistingPath(requested);
  if (isInside(rootReal, targetReal)) return { allowed: true, path: requested };

  const profile = policy.profile;
  if (profile === 'autonomous' && operation === 'read') {
    return { allowed: true, path: requested, external: true };
  }
  if (profile === 'safe') {
    return {
      allowed: false,
      error: `Blocked by safe workspace policy: ${operation} outside ${policy.root}: ${requested}`,
    };
  }

  const allowed = await confirmExternalPath({
    operation,
    path: requested,
    root: policy.root,
  });
  return allowed
    ? { allowed: true, path: requested, external: true }
    : {
        allowed: false,
        error: `Blocked: ${operation} outside the workspace requires interactive approval: ${requested}`,
      };
}

const ACCESS_RULES = {
  read: [['file_path', 'read']],
  read_pdf: [['file_path', 'read']],
  read_doc: [['file_path', 'read']],
  read_server_console: [['file_path', 'read'], ['workdir', 'read']],
  write: [['file_path', 'write']],
  edit: [['file_path', 'write']],
  apply_patch_structured: [['file_path', 'write']],
  repo_map: [['path', 'read']],
  repo_find_symbol: [['path', 'read']],
  glob: [['path', 'read']],
  grep: [['path', 'read']],
  list_dir: [['path', 'read']],
  file_info: [['path', 'read']],
  git_status: [['workdir', 'read']],
  git_diff: [['workdir', 'read'], ['file_path', 'read']],
  dep_inspect: [['workdir', 'read']],
  run_checks: [['workdir', 'read']],
  run_tests: [['workdir', 'read']],
  dev_server: [['workdir', 'read']],
  browser_app: [['file_path', 'write']],
  desktop_app: [['workdir', 'read'], ['file_path', 'write']],
  bash: [['workdir', 'read']],
  bash_session: [['workdir', 'read']],
  memory_write: [['workdir', 'write']],
};

export function normalizeToolArgsForWorkspace(name, args = {}, policyOverride = null) {
  const policy = normalizePolicy(policyOverride) || activePolicy;
  if (!policy) return { ...args };

  const normalized = { ...args };
  const rules = ACCESS_RULES[name] || [];
  for (const [key] of rules) {
    if (!normalized[key]) {
      if (key === 'path' || key === 'workdir') normalized[key] = policy.root;
      continue;
    }
    normalized[key] = isAbsolute(String(normalized[key]))
      ? resolve(String(normalized[key]))
      : resolve(policy.root, String(normalized[key]));
  }
  return normalized;
}

export async function authorizeToolAccess(name, args = {}, policyOverride = null) {
  const policy = normalizePolicy(policyOverride) || activePolicy;
  if (
    policy?.profile === 'safe' &&
    (
      name === 'bash' ||
      name === 'bash_session' ||
      (name === 'dev_server' && String(args.action || '').toLowerCase() === 'start') ||
      // desktop_app open runs its command through a shell, exactly like
      // dev_server start.
      (name === 'desktop_app' && String(args.action || '').toLowerCase() === 'open')
    )
  ) {
    return {
      allowed: false,
      error: `Blocked by safe workspace policy: arbitrary shell execution via ${name}`,
    };
  }
  const rules = ACCESS_RULES[name] || [];
  for (const [key, operation] of rules) {
    if (!args[key]) continue;
    const result = await authorizePath(args[key], operation, policy);
    if (!result.allowed) return result;
  }
  return { allowed: true };
}

export function clearWorkspaceApprovals() {
  sessionApprovals.clear();
}
