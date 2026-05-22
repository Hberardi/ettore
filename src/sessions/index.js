import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';

const SESSIONS_DIR = join(homedir(), '.local', 'share', 'ettore', 'sessions');

async function ensureDir() {
  if (!existsSync(SESSIONS_DIR)) {
    await mkdir(SESSIONS_DIR, { recursive: true });
  }
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export async function createSession(provider, model) {
  const id = newId();
  const session = { id, provider, model, messages: [], created: Date.now(), updated: Date.now() };
  try {
    await ensureDir();
    await writeFile(join(SESSIONS_DIR, `${id}.json`), JSON.stringify(session, null, 2));
  } catch {
    session.transient = true;
  }
  return session;
}

export async function saveSession(session) {
  if (session?.transient) return false;
  session.updated = Date.now();
  try {
    await ensureDir();
    await writeFile(join(SESSIONS_DIR, `${session.id}.json`), JSON.stringify(session, null, 2));
    return true;
  } catch {
    session.transient = true;
    return false;
  }
}

export async function listSessions() {
  try {
    await ensureDir();
  } catch {
    return [];
  }
  const files = await readdir(SESSIONS_DIR).catch(() => []);
  const sessions = [];
  for (const f of files.filter(f => f.endsWith('.json'))) {
    try {
      const data = JSON.parse(await readFile(join(SESSIONS_DIR, f), 'utf-8'));
      sessions.push(data);
    } catch {}
  }
  return sessions.sort((a, b) => b.updated - a.updated);
}

export async function loadSession(id) {
  const data = await readFile(join(SESSIONS_DIR, `${id}.json`), 'utf-8');
  return JSON.parse(data);
}

export async function deleteSession(id) {
  const { unlink } = await import('fs/promises');
  await unlink(join(SESSIONS_DIR, `${id}.json`)).catch(() => {});
}
