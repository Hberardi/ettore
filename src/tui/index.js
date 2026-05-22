import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';

const themes = {
  default: {
    primary: chalk.cyan,
    secondary: chalk.gray,
    success: chalk.green,
    warning: chalk.yellow,
    error: chalk.red,
    accent: chalk.bold,
    muted: chalk.dim,
    link: chalk.blue.underline,
    highlight: chalk.bgYellow.black,
    gradient: (s) => chalk.cyan(s.slice(0, s.length/2)) + chalk.magenta(s.slice(s.length/2))
  },
  dark: {
    primary: (s) => `\x1b[38;5;75m${s}\x1b[0m`,
    secondary: (s) => `\x1b[38;5;245m${s}\x1b[0m`,
    success: (s) => `\x1b[38;5;114m${s}\x1b[0m`,
    warning: (s) => `\x1b[38;5;227m${s}\x1b[0m`,
    error: (s) => `\x1b[38;5;203m${s}\x1b[0m`,
    accent: (s) => `\x1b[1m${s}\x1b[0m`,
    muted: (s) => `\x1b[2m${s}\x1b[0m`,
    link: (s) => `\x1b[38;5;75m\x1b[4m${s}\x1b[0m`,
    highlight: (s) => `\x1b[48;5;75m\x1b[30m${s}\x1b[0m`,
    gradient: (s) => `\x1b[38;5;75m${s.slice(0, s.length/2)}\x1b[38;5;213m${s.slice(s.length/2)}\x1b[0m`
  },
  matrix: {
    primary: (s) => `\x1b[38;5;46m${s}\x1b[0m`,
    secondary: (s) => `\x1b[38;5;244m${s}\x1b[0m`,
    success: (s) => `\x1b[38;5;46m${s}\x1b[0m`,
    warning: (s) => `\x1b[38;5;226m${s}\x1b[0m`,
    error: (s) => `\x1b[38;5;196m${s}\x1b[0m`,
    accent: (s) => `\x1b[1m\x1b[38;5;46m${s}\x1b[0m`,
    muted: (s) => `\x1b[2m${s}\x1b[0m`,
    link: (s) => `\x1b[38;5;46m${s}\x1b[0m`,
    highlight: (s) => `\x1b[48;5;46m\x1b[30m${s}\x1b[0m`,
    gradient: (s) => `\x1b[38;5;46m${s}\x1b[0m`
  },
  nord: {
    primary: (s) => `\x1b[38;5;109m${s}\x1b[0m`,
    secondary: (s) => `\x1b[38;5;145m${s}\x1b[0m`,
    success: (s) => `\x1b[38;5;114m${s}\x1b[0m`,
    warning: (s) => `\x1b[38;5;209m${s}\x1b[0m`,
    error: (s) => `\x1b[38;5;203m${s}\x1b[0m`,
    accent: (s) => `\x1b[1m\x1b[38;5;109m${s}\x1b[0m`,
    muted: (s) => `\x1b[2m${s}\x1b[0m`,
    link: (s) => `\x1b[38;5;109m\x1b[4m${s}\x1b[0m`,
    highlight: (s) => `\x1b[48;5;109m\x1b[30m${s}\x1b[0m`,
    gradient: (s) => `\x1b[38;5;109m${s.slice(0, s.length/2)}\x1b[38;5;147m${s.slice(s.length/2)}\x1b[0m`
  },
  dracula: {
    primary: (s) => `\x1b[38;5;141m${s}\x1b[0m`,
    secondary: (s) => `\x1b[38;5;139m${s}\x1b[0m`,
    success: (s) => `\x1b[38;5;114m${s}\x1b[0m`,
    warning: (s) => `\x1b[38;5;229m${s}\x1b[0m`,
    error: (s) => `\x1b[38;5;212m${s}\x1b[0m`,
    accent: (s) => `\x1b[1m\x1b[38;5;141m${s}\x1b[0m`,
    muted: (s) => `\x1b[2m${s}\x1b[0m`,
    link: (s) => `\x1b[38;5;141m\x1b[4m${s}\x1b[0m`,
    highlight: (s) => `\x1b[48;5;141m\x1b[30m${s}\x1b[0m`,
    gradient: (s) => `\x1b[38;5;141m${s.slice(0, s.length/2)}\x1b[38;5;212m${s.slice(s.length/2)}\x1b[0m`
  },
  monokai: {
    primary: (s) => `\x1b[38;5;81m${s}\x1b[0m`,
    secondary: (s) => `\x1b[38;5;250m${s}\x1b[0m`,
    success: (s) => `\x1b[38;5;114m${s}\x1b[0m`,
    warning: (s) => `\x1b[38;5;186m${s}\x1b[0m`,
    error: (s) => `\x1b[38;5;197m${s}\x1b[0m`,
    accent: (s) => `\x1b[1m\x1b[38;5;81m${s}\x1b[0m`,
    muted: (s) => `\x1b[2m${s}\x1b[0m`,
    link: (s) => `\x1b[38;5;81m\x1b[4m${s}\x1b[0m`,
    highlight: (s) => `\x1b[48;5;81m\x1b[30m${s}\x1b[0m`,
    gradient: (s) => `\x1b[38;5;81m${s.slice(0, s.length/2)}\x1b[38;5;186m${s.slice(s.length/2)}\x1b[0m`
  }
};

const BANNER = `
\x1b[38;5;75m╔═══════════════════════════════════════════════════════════════════╗\x1b[0m
\x1b[38;5;75m║\x1b[0m                                                                   \x1b[38;5;75m║\x1b[0m
\x1b[38;5;75m║\x1b[0m   \x1b[38;5;213m██████\x1b[38;5;75m╗\x1b[38;5;213m ███████\x1b[38;5;75m╗\x1b[38;5;213m██╗\x1b[38;5;75m   \x1b[38;5;213m███\x1b[38;5;75m╗\x1b[38;5;213m███████\x1b[38;5;75m╗\x1b[38;5;213m██╗\x1b[38;5;75m      \x1b[38;5;213m██╗\x1b[38;5;75m   \x1b[38;5;213m██\x1b[38;5;75m╗\x1b[38;5;213m███████\x1b[38;5;75m╗\x1b[38;5;213m██╗\x1b[38;5;75m   \x1b[38;5;213m██\x1b[38;5;75m╗\x1b[38;5;75m║\x1b[0m
\x1b[38;5;75m║\x1b[0m   \x1b[38;5;213m██╔══██\x1b[38;5;75m╗\x1b[38;5;213m██╔════\x1b[38;5;75m╝\x1b[38;5;213m██║\x1b[38;5;75m   \x1b[38;5;213m██║\x1b[38;5;75m║\x1b[38;5;213m██╔════\x1b[38;5;75m╝\x1b[38;5;213m██║\x1b[38;5;75m      \x1b[38;5;213m██║\x1b[38;5;75m   \x1b[38;5;213m██║\x1b[38;5;75m║\x1b[38;5;213m██╔════\x1b[38;5;75m╝\x1b[38;5;213m██║\x1b[38;5;75m   \x1b[38;5;213m██║\x1b[38;5;75m║\x1b[0m
\x1b[38;5;75m║\x1b[0m   \x1b[38;5;213m██║\x1b[38;5;75m  \x1b[38;5;213m██║\x1b[38;5;75m\x1b[38;5;213m█████\x1b[38;5;75m╗\x1b[38;5;213m  \x1b[38;5;75m\x1b[38;5;213m██║\x1b[38;5;75m   \x1b[38;5;213m██║\x1b[38;5;75m║\x1b[38;5;213m█████\x1b[38;5;75m╗\x1b[38;5;213m  \x1b[38;5;75m\x1b[38;5;213m██║\x1b[38;5;75m      \x1b[38;5;213m██║\x1b[38;5;75m   \x1b[38;5;213m██║\x1b[38;5;75m║\x1b[38;5;213m█████\x1b[38;5;75m╗\x1b[38;5;213m  \x1b[38;5;75m\x1b[38;5;213m██║\x1b[38;5;75m   \x1b[38;5;213m██║\x1b[38;5;75m║\x1b[0m
\x1b[38;5;75m║\x1b[0m   \x1b[38;5;213m██║\x1b[38;5;75m  \x1b[38;5;213m██║\x1b[38;5;75m\x1b[38;5;213m██╔══╝\x1b[38;5;75m  \x1b[38;5;75m\x1b[38;5;213m╚██╗\x1b[38;5;75m \x1b[38;5;213m██╔╝\x1b[38;5;75m║\x1b[38;5;213m██╔══╝\x1b[38;5;75m  \x1b[38;5;213m██║\x1b[38;5;75m      \x1b[38;5;213m╚██╗\x1b[38;5;75m \x1b[38;5;213m██╔╝\x1b[38;5;75m║\x1b[38;5;213m██╔══╝\x1b[38;5;75m  \x1b[38;5;213m██║\x1b[38;5;75m   \x1b[38;5;213m██║\x1b[38;5;75m║\x1b[0m
\x1b[38;5;75m║\x1b[0m   \x1b[38;5;213m██████╔╝\x1b[38;5;75m\x1b[38;5;213m███████\x1b[38;5;75m╗\x1b[38;5;213m ╚████╔╝\x1b[38;5;75m \x1b[38;5;213m███████\x1b[38;5;75m╗\x1b[38;5;213m███████\x1b[38;5;75m╗\x1b[38;5;213m  ╚████╔╝\x1b[38;5;75m \x1b[38;5;213m███████\x1b[38;5;75m╗\x1b[38;5;213m██║\x1b[38;5;75m   \x1b[38;5;213m██║\x1b[38;5;75m║\x1b[0m
\x1b[38;5;75m║\x1b[0m   \x1b[38;5;213m╚═════╝\x1b[38;5;75m \x1b[38;5;213m╚══════╝\x1b[38;5;75m  \x1b[38;5;213m╚═══╝\x1b[38;5;75m  \x1b[38;5;213m╚══════╝\x1b[38;5;75m╚══════╝\x1b[38;5;75m   \x1b[38;5;213m╚═══╝\x1b[38;5;75m  \x1b[38;5;213m╚══════╝\x1b[38;5;75m╚═╝\x1b[38;5;75m   \x1b[38;5;213m╚═╝\x1b[38;5;75m║\x1b[0m
\x1b[38;5;75m║\x1b[0m                                                                   \x1b[38;5;75m║\x1b[0m
\x1b[38;5;75m║\x1b[0m                    \x1b[38;5;213mE\x1b[38;5;75m \x1b[38;5;213mT\x1b[38;5;75m \x1b[38;5;213mT\x1b[38;5;75m \x1b[38;5;213mO\x1b[38;5;75m \x1b[38;5;213mR\x1b[38;5;75m \x1b[38;5;213mE\x1b[38;5;75m                              \x1b[38;5;75m║\x1b[0m
\x1b[38;5;75m║\x1b[0m                                                                   \x1b[38;5;75m║\x1b[0m
\x1b[38;5;75m╚═══════════════════════════════════════════════════════════════════╝\x1b[0m
`;

const WELCOME = `
\x1b[38;5;75m┌─────────────────────────────────────────────────────────────────────┐\x1b[0m
\x1b[38;5;75m│\x1b[0m  \x1b[38;5;114m◆\x1b[0m  \x1b[1m\x1b[38;5;213mWelcome to ETTORE!\x1b[0m                                          \x1b[38;5;75m│\x1b[0m
\x1b[38;5;75m└─────────────────────────────────────────────────────────────────────┘\x1b[0m

\x1b[38;5;145m  Connect to an LLM provider to get started:\x1b[0m

  \x1b[38;5;75m▸\x1b[0m \x1b[1m/connect\x1b[0m \x1b[38;5;145m<provider>\x1b[0m \x1b[38;5;145m<api-key>\x1b[0m    Connect to a provider
  \x1b[38;5;75m▸\x1b[0m \x1b[1m/providers\x1b[0m                       View available providers  
  \x1b[38;5;75m▸\x1b[0m \x1b[1m/help\x1b[0m                              Show all commands

\x1b[38;5;145m  Quick examples:\x1b[0m
  \x1b[38;5;75m$ /connect openai sk-...\x1b[0m
  \x1b[38;5;75m$ /connect anthropic sk-...\x1b[0m

\x1b[38;5;229m  💡 Tip:\x1b[0m \x1b[38;5;145mUse /connect without arguments to see available providers\x1b[0m
`;

export class TUI {
  constructor(options = {}) {
    this.theme = themes[options.theme] || themes.default;
    this.verbose = options.verbose || false;
    this.spinner = null;
    this.colors = {
      cyan: '\x1b[36m',
      green: '\x1b[32m',
      yellow: '\x1b[33m',
      red: '\x1b[31m',
      blue: '\x1b[34m',
      magenta: '\x1b[35m',
      reset: '\x1b[0m'
    };
  }

  setTheme(themeName) {
    this.theme = themes[themeName] || themes.default;
  }

  getAvailableThemes() {
    return Object.keys(themes);
  }

  startSpinner(text) {
    this.spinner = ora({
      text,
      color: 'cyan',
      spinner: {
        interval: 80,
        frames: ['▐⠋', '▐⠙', '▐⠹', '▐⠸', '▐⠼', '▐⠴', '▐⠦', '▐⠧', '▐⠇', '▐⠏']
      }
    }).start();
    return this.spinner;
  }

  stopSpinner(success = true, text) {
    if (!this.spinner) return;
    if (success) {
      this.spinner.succeed(text || 'Done');
    } else {
      this.spinner.fail(text || 'Failed');
    }
    this.spinner = null;
  }

  clear() {
    process.stdout.write('\x1b[2J\x1b[H');
  }

  banner() {
    console.log(BANNER);
  }

  welcome() {
    this.clear();
    this.banner();
    console.log(WELCOME);
  }

  log(message, type = 'info') {
    const symbols = {
      info: this.theme.primary('ℹ'),
      success: this.theme.success('✓'),
      warning: this.theme.warning('⚠'),
      error: this.theme.error('✗'),
      debug: this.theme.muted('›')
    };
    console.log(`${symbols[type] || '›'} ${message}`);
  }

  print(msg) {
    console.log(msg);
  }

  printColored(msg, color = 'primary') {
    console.log(this.theme[color](msg));
  }

  header(text) {
    const box = boxen(text, {
      padding: { top: 0, bottom: 0, left: 1, right: 1 },
      borderStyle: 'round',
      borderColor: 'cyan'
    });
    console.log(this.theme.primary(box));
  }

  section(title, content) {
    console.log();
    console.log(this.theme.accent(title));
    console.log(this.theme.secondary('─'.repeat(Math.min(title.length + 20, 60))));
    console.log(content);
    console.log();
  }

  error(message) {
    console.log(this.theme.error(` ✗ ${message}`));
  }

  success(message) {
    console.log(this.theme.success(` ✓ ${message}`));
  }

  warning(message) {
    console.log(this.theme.warning(` ⚠ ${message}`));
  }

  info(message) {
    console.log(this.theme.primary(` ℹ ${message}`));
  }

  code(code, language = '') {
    console.log();
    console.log(this.theme.muted(` ┌─${language ? ' ' + language : ''} `));
    console.log(this.theme.muted(' │ '));
    code.split('\n').forEach(line => {
      console.log(this.theme.muted(' │ ') + line);
    });
    console.log(this.theme.muted(' └' + '─'.repeat(Math.min(language.length + 20, 40))));
    console.log();
  }

  filePath(path) {
    return chalk.blue(path);
  }

  lineNumber(line) {
    return chalk.gray(`${line}:`);
  }

  toolCall(tool, args) {
    console.log();
    console.log(this.theme.warning(` 🔧 ${tool}`));
    if (this.verbose && args) {
      console.log(this.theme.muted(` ${JSON.stringify(args)}`));
    }
  }

  toolResult(result, maxLen = 300) {
    const truncated = result.length > maxLen
      ? result.slice(0, maxLen) + '\n ... [truncated]'
      : result;
    console.log(this.theme.muted(` └─ `) + truncated.replace(/\n/g, '\n │ '));
  }

  progress(current, total, message = '') {
    const percent = Math.round((current / total) * 100);
    const filled = '█'.repeat(Math.floor(percent / 5));
    const empty = '░'.repeat(20 - Math.floor(percent / 5));
    process.stdout.write(`\r [${this.theme.success(filled)}${this.theme.muted(empty)}] ${percent}% ${message}`);
    if (current >= total) process.stdout.write('\n');
  }

  table(headers, rows) {
    console.log();
    const colWidths = headers.map((h, i) =>
      Math.max(h.length, ...rows.map(r => (r[i] || '').toString().length)) + 2
    );

    const headerRow = headers.map((h, i) => h.padEnd(colWidths[i])).join(this.theme.muted('│'));
    console.log(this.theme.accent(' ┌' + colWidths.map(w => '─'.repeat(w)).join(this.theme.muted('┬')) + '┐'));
    console.log(this.theme.accent(' │') + headerRow + this.theme.accent('│'));
    console.log(this.theme.accent(' ├' + colWidths.map(w => '─'.repeat(w)).join(this.theme.muted('┼')) + '┤'));

    for (const row of rows) {
      const cells = row.map((c, i) => (c || '').toString().padEnd(colWidths[i])).join(this.theme.muted('│'));
      console.log(this.theme.accent(' │') + cells + this.theme.accent('│'));
    }
    console.log(this.theme.accent(' └' + colWidths.map(w => '─'.repeat(w)).join(this.theme.muted('┴')) + '┘'));
    console.log();
  }

  list(items, numbered = false) {
    items.forEach((item, i) => {
      const num = numbered ? `${i + 1}. ` : ' • ';
      console.log(this.theme.primary(num) + item);
    });
  }

  promptInput(label, defaultValue = '') {
    return `${this.theme.warning('➜')} ${label}${defaultValue ? ` [${this.theme.muted(defaultValue)}]` : ''}: `;
  }

  separator() {
    console.log(this.theme.muted('─'.repeat(60)));
  }

  spacer(count = 1) {
    console.log('\n'.repeat(count));
  }

  // Nuovi metodi per UX migliorata
  animatedText(text, delay = 30) {
    let i = 0;
    const interval = setInterval(() => {
      process.stdout.write(text[i]);
      i++;
      if (i >= text.length) {
        clearInterval(interval);
        console.log();
      }
    }, delay);
  }

  statusBadge(text, type = 'info') {
    const colors = {
      info: '\x1b[38;5;75m',
      success: '\x1b[38;5;114m',
      warning: '\x1b[38;5;227m',
      error: '\x1b[38;5;203m'
    };
    console.log(`${colors[type] || colors.info}[${text}]\x1b[0m`);
  }

  keyValue(key, value) {
    console.log(`  ${this.theme.primary('▸')} ${this.theme.accent(key)}: ${value}`);
  }

  divider(text = '') {
    if (text) {
      console.log();
      console.log(this.theme.muted(`═══ ${text} ═══`));
      console.log();
    } else {
      console.log(this.theme.muted('─'.repeat(60)));
    }
  }
}

export const tui = new TUI();