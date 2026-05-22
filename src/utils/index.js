import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
export { maskSecret, redactSecrets } from './secrets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function createLogger(options = {}) {
  const logFile = options.logFile || join(__dirname, '../../ettore.log');
  const level = options.level || 'info';
  
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  const currentLevel = levels[level] ?? 1;
  
  function formatMessage(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] ${level.toUpperCase()}: ${message}${metaStr}`;
  }
  
  async function writeLog(message) {
    try {
      const { appendFile } = await import('fs/promises');
      await appendFile(logFile, message + '\n');
    } catch (e) {
      console.error('Failed to write log:', e.message);
    }
  }
  
  return {
    debug(message, meta) {
      if (currentLevel <= levels.debug) {
        const msg = formatMessage('debug', message, meta);
        if (options.console) console.log(msg);
        writeLog(msg);
      }
    },
    
    info(message, meta) {
      if (currentLevel <= levels.info) {
        const msg = formatMessage('info', message, meta);
        if (options.console) console.log(msg);
        writeLog(msg);
      }
    },
    
    warn(message, meta) {
      if (currentLevel <= levels.warn) {
        const msg = formatMessage('warn', message, meta);
        if (options.console) console.warn(msg);
        writeLog(msg);
      }
    },
    
    error(message, meta) {
      if (currentLevel <= levels.error) {
        const msg = formatMessage('error', message, meta);
        if (options.console) console.error(msg);
        writeLog(msg);
      }
    }
  };
}

export class RetryableError extends Error {
  constructor(message, retries = 3) {
    super(message);
    this.name = 'RetryableError';
    this.retries = retries;
  }
}

export async function retry(fn, options = {}) {
  const maxRetries = options.maxRetries || 3;
  const delay = options.delay || 1000;
  const backoff = options.backoff || 2;
  
  let lastError;
  let currentDelay = delay;
  
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      if (i < maxRetries) {
        await new Promise(r => { setTimeout(r, currentDelay); });
        currentDelay *= backoff;
      }
    }
  }
  
  throw lastError;
}

export function validateFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Invalid file path');
  }
  
  const dangerous = ['..', '~', '$', '`', ';', '|', '&'];
  for (const d of dangerous) {
    if (filePath.includes(d)) {
      throw new Error(`Dangerous character in path: ${d}`);
    }
  }
  
  return true;
}

export function sanitizeInput(input) {
  if (typeof input !== 'string') return '';
  
  return input
    .replace(/[\x00-\x1F\x7F]/g, '')
    .slice(0, 100000);
}

export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export function parseModelString(modelString) {
  const parts = modelString.split(':');
  return {
    provider: parts[0] || 'openai',
    model: parts[1] || modelString,
    version: parts[2]
  };
}

export const constants = {
  MAX_FILE_SIZE: 10 * 1024 * 1024,
  MAX_CONTEXT_LENGTH: 128000,
  DEFAULT_TIMEOUT: 30000,
  MAX_TOOL_CALLS: 10,
  SUPPORTED_LANGUAGES: ['javascript', 'typescript', 'python', 'go', 'rust', 'java', 'c', 'cpp']
};
