// Quick environment check for the Windows desktop backend.
const { execFileSync } = require('node:child_process');
const os = require('node:os');

const lines = [];
lines.push(`platform: ${os.platform()} ${os.release()} arch=${os.arch()}`);

function probe(label, cmd, args) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    lines.push(`${label}: FOUND -> ${out.split(/\r?\n/)[0].trim()}`);
  } catch (e) {
    lines.push(`${label}: NOT FOUND (${e.code || e.message})`);
  }
}

probe('pwsh', 'where.exe', ['pwsh.exe']);
probe('powershell', 'where.exe', ['powershell.exe']);
probe('mspaint', 'where.exe', ['mspaint.exe']);
probe('notepad', 'where.exe', ['notepad.exe']);
probe('calc', 'where.exe', ['calc.exe']);
probe('node', 'where.exe', ['node.exe']);

console.log(lines.join('\n'));
