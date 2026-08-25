import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function parseSelectedPaths(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

async function runChooser(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd || process.cwd(),
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return { handled: true, paths: parseSelectedPaths(result.stdout) };
  } catch (error) {
    // File chooser processes normally return code 1 when the user presses
    // Cancel. That is a valid empty selection, not an application error.
    if (error?.code === 1) return { handled: true, paths: [] };
    if (error?.code === 'ENOENT') return { handled: false, paths: [] };
    throw error;
  }
}

export async function chooseFiles(options = {}) {
  const cwd = options.cwd || process.cwd();
  const multiple = options.multiple !== false;

  if (process.platform === 'darwin') {
    const script = [
      `set chosenFiles to choose file with prompt "Allega file"${multiple ? ' with multiple selections allowed' : ''}`,
      'set output to ""',
      'repeat with chosenFile in chosenFiles',
      'set output to output & POSIX path of chosenFile & linefeed',
      'end repeat',
      'return output',
    ].join('\n');
    const result = await runChooser('osascript', ['-e', script], { cwd });
    return result.paths;
  }

  if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
      `$dialog.InitialDirectory = [Environment]::CurrentDirectory`,
      `$dialog.Multiselect = $${multiple ? 'true' : 'false'}`,
      '$dialog.Title = "Allega file"',
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.FileNames }',
    ].join('; ');
    const result = await runChooser('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { cwd });
    return result.paths;
  }

  // Linux desktop environments commonly provide one of these native GTK/Qt
  // selectors. Try them in order without invoking a shell.
  const linuxChoosers = [
    ['zenity', ['--file-selection', '--multiple', '--separator=\n', '--title=Allega file']],
    ['kdialog', ['--getopenfilename', cwd, 'All files (*)', ...(multiple ? ['--multiple', '--separate-output'] : [])]],
    ['yad', ['--file-selection', '--multiple', '--separator=\n', '--title=Allega file']],
  ];
  for (const [command, args] of linuxChoosers) {
    const result = await runChooser(command, args, { cwd });
    if (result.handled) return result.paths;
  }

  throw new Error('Nessun selettore file disponibile. Installa zenity, kdialog o yad e riprova.');
}

export { parseSelectedPaths };
