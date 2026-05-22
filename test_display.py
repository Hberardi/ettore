#!/usr/bin/env python3
"""
ETTORE CLI — display layout test
Spawns the app in a PTY, reconstructs the rendered screen,
and reports every visual alignment/overflow issue.
"""

import os, pty, select, subprocess, sys, re, time, struct, fcntl, termios, signal, textwrap

TEST_CONFIG_DIR = '/tmp/ettore-display-test-config'

# ─── PTY helpers ──────────────────────────────────────────────────────────────

def set_win_size(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

def spawn(cols, rows, extra_wait=0.0):
    master, slave = pty.openpty()
    set_win_size(master, rows, cols)
    set_win_size(slave,  rows, cols)

    env = os.environ.copy()
    os.makedirs(TEST_CONFIG_DIR, exist_ok=True)
    env.update(TERM='xterm-256color', COLUMNS=str(cols), LINES=str(rows),
               FORCE_COLOR='1', NO_COLOR='', ETTORE_CONFIG_DIR=TEST_CONFIG_DIR,
               NODE_NO_WARNINGS='1')

    proc = subprocess.Popen(
        ['node', 'bin/cli.js'],
        stdin=slave, stdout=slave, stderr=slave,
        env=env,
        cwd='/home/re77/Scrivania/ettore_cli',
        preexec_fn=os.setsid,
        close_fds=True,
    )
    os.close(slave)

    buf = b''
    deadline = time.time() + 2.5 + extra_wait
    while time.time() < deadline:
        r, _, _ = select.select([master], [], [], 0.05)
        if r:
            try:
                buf += os.read(master, 8192)
            except OSError:
                break

    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except Exception:
        pass
    proc.wait()
    os.close(master)
    return buf.decode('utf-8', errors='replace')

# ─── ANSI screen reconstruction ───────────────────────────────────────────────

_ESC_RE = re.compile(
    r'\x1b(?:'
    r'[@-Z\\-_]'                     # Fe sequences (2-char)
    r'|\[[0-?]*[ -/]*[@-~]'          # CSI
    r'|\][^\x07\x1b]*(?:\x07|\x1b\\)'  # OSC
    r')'
)

def reconstruct(raw, cols, rows):
    """Play back ANSI escape codes and return a list of `rows` strings."""
    screen = [[' '] * cols for _ in range(rows)]
    cx, cy = 0, 0

    def put(ch):
        nonlocal cx, cy
        if 0 <= cy < rows and 0 <= cx < cols:
            screen[cy][cx] = ch
        cx += 1
        if cx >= cols:
            cx = 0
            cy = min(cy + 1, rows - 1)

    tokens = []
    last = 0
    for m in _ESC_RE.finditer(raw):
        if m.start() > last:
            tokens.append(('T', raw[last:m.start()]))
        tokens.append(('E', m.group()))
        last = m.end()
    if last < len(raw):
        tokens.append(('T', raw[last:]))

    for kind, val in tokens:
        if kind == 'T':
            for ch in val:
                if   ch == '\r': cx = 0
                elif ch == '\n': cy = min(cy + 1, rows - 1)
                elif ch == '\x08': cx = max(0, cx - 1)
                elif ch >= ' ':  put(ch)
        else:
            # CUP  ESC[row;colH  or  ESC[H
            m = re.match(r'\x1b\[(\d*);?(\d*)H$', val)
            if m:
                cy = max(0, min(int(m.group(1) or 1) - 1, rows - 1))
                cx = max(0, min(int(m.group(2) or 1) - 1, cols - 1))
                continue
            # ED erase display
            if re.match(r'\x1b\[(\d*)J', val):
                screen = [[' '] * cols for _ in range(rows)]
                continue
            # EL erase line
            m = re.match(r'\x1b\[(\d*)K', val)
            if m:
                mode = int(m.group(1) or 0)
                if mode == 0:
                    for x in range(cx, cols): screen[cy][x] = ' '
                elif mode == 1:
                    for x in range(0, cx+1): screen[cy][x] = ' '
                elif mode == 2:
                    screen[cy] = [' '] * cols
                continue
            # CUU/CUD/CUF/CUB
            m = re.match(r'\x1b\[(\d*)([ABCD])', val)
            if m:
                n = int(m.group(1) or 1)
                d = m.group(2)
                if d == 'A': cy = max(0, cy - n)
                elif d == 'B': cy = min(rows-1, cy + n)
                elif d == 'C': cx = min(cols-1, cx + n)
                elif d == 'D': cx = max(0, cx - n)
                continue

    return [''.join(row) for row in screen]

# ─── Strip ANSI from a single line (shouldn't be needed after reconstruction,
#     but useful when parsing raw lines) ────────────────────────────────────────

def strip_ansi(s):
    return _ESC_RE.sub('', s)

# ─── Analysis ─────────────────────────────────────────────────────────────────

BOX_CHARS = set('│┌└├┤┬┴┼─┐┘')

def visual_len(line):
    """Length of `line` ignoring ANSI codes (for safety)."""
    return len(strip_ansi(line))

def analyze(screen, cols, rows, sidebar_w):
    issues = []
    content_w = cols - sidebar_w

    sidebar_col = content_w   # 0-indexed column where sidebar should start

    for i, line in enumerate(screen):
        vlen = len(line.rstrip())   # screen is already stripped of ANSI

        # 1. Overflow
        if len(line.rstrip()) > cols:
            issues.append(f"Row {i+1:2d}: overflow — {len(line.rstrip())} chars > {cols} terminal cols")

        # 2. Sidebar misalignment: find first box-drawing char on right half
        right_half = line[content_w:] if len(line) > content_w else ''
        left_half  = line[:content_w]

        has_sidebar_char = any(c in BOX_CHARS for c in right_half)
        has_sidebar_bleed = any(c in BOX_CHARS for c in left_half)

        if has_sidebar_bleed and i > 0:
            col_of_bleed = next(j for j, c in enumerate(left_half) if c in BOX_CHARS)
            issues.append(
                f"Row {i+1:2d}: sidebar box-char bleeds into message area at col {col_of_bleed} "
                f"(should be ≥ col {sidebar_col})"
            )

    # 3. Total rendered lines
    nonempty = sum(1 for l in screen if l.strip())
    if nonempty > rows:
        issues.append(f"Rendered {nonempty} non-empty rows but terminal height is {rows}")

    # 4. Check header present (row 0 should contain ETTORE)
    if 'ETTORE' not in screen[0]:
        issues.append("Row 1 (header): 'ETTORE' not found — header missing or wrong row")

    # 5. Check input line visible (last rows should have prompt)
    prompt_found = any('❯' in screen[r] or '●' in screen[r]
                       for r in range(max(0, rows-3), rows))
    if not prompt_found:
        issues.append("Input prompt (❯ / ●) not found in last 3 rows — input area off-screen")

    # 6. Check sidebar right border for sidebar rows (rows 2..availableHeight+1)
    # Valid right-edge chars: box drawing borders and spaces
    VALID_EDGE = set(' │┘┐┤─')
    sidebar_rows = range(1, min(len(screen), sidebar_w + 2))   # approximate range
    for i in sidebar_rows:
        if i >= len(screen): break
        line = screen[i]
        if len(line) >= cols and line[cols-1] not in VALID_EDGE:
            issues.append(
                f"Row {i+1:2d}: rightmost char is '{line[cols-1]}' — sidebar right-border missing or corrupted"
            )

    return issues

# ─── Pretty printer ───────────────────────────────────────────────────────────

def print_screen(screen, cols, sidebar_w, highlight_issues):
    content_w = cols - sidebar_w
    ruler  = '─' * content_w + '│' + '─' * sidebar_w
    header = f"{'col →':>{content_w}}│{'':<{sidebar_w}}"
    print(f"\n     {ruler}")
    for i, line in enumerate(screen):
        rstrip = line.rstrip()
        overflow = len(rstrip) > cols
        flag = ' ← OVERFLOW' if overflow else ''
        # Truncate display to terminal cols
        display = rstrip[:cols].ljust(cols)
        # Mark sidebar boundary
        left  = display[:content_w]
        right = display[content_w:]
        rownum = f"{i+1:3d}"
        marker = '!' if any(issue.startswith(f"Row {i+1:2d}:") for issue in highlight_issues) else ' '
        print(f"{rownum}{marker}|{left}|{right}|{flag}")
    print(f"     {ruler}")

# ─── Test scenarios ───────────────────────────────────────────────────────────

SIDEBAR_W = 32   # matches tui-native.js sidebarWidth

def run_scenario(label, cols, rows):
    print(f"\n{'═'*70}")
    print(f"  SCENARIO: {label}  ({cols}×{rows})")
    print(f"{'═'*70}")
    raw = spawn(cols, rows)
    if not raw:
        print("  ✗ No output captured — app failed to start?")
        return []
    screen = reconstruct(raw, cols, rows)
    issues = analyze(screen, cols, rows, SIDEBAR_W)
    print_screen(screen, cols, SIDEBAR_W, issues)
    if issues:
        print(f"\n  Issues found ({len(issues)}):")
        for iss in issues:
            print(f"    ✗  {iss}")
    else:
        print(f"\n  ✓  No layout issues detected")
    return issues

def run_malformed_agent_text_regression():
    print(f"\n{'═'*70}")
    print("  REGRESSION: malformed agent text")
    print(f"{'═'*70}")

    script = r"""
import { TUI } from './src/app/tui-native.js';
const t = new TUI();
const sample = {
  role: 'assistant',
  text: [
    '#### Spese Yacht (38;5;150m/login definita in auth_router)',
    'POST /api/viaggi/{viaggio_id}/update è stata aggiunta a 38;5; /api/auth_router',
    'PATCH /api/viaggi/{viaggio_id}/status è stata aggiunta a 38;5;150 /api/viaggi_router',
    '',
    'Endpoint | Metodo | Descrizione',
    '38;5;150m/operativo/yacht/spese | GET | Lista spese',
    '38;5;150m/operativo/yacht/spese | POST | Crea spesa',
    '38;5;150m/operativo/yacht/spese/{id} | DELETE | Elimina spesa',
    '',
    '#### Reports (38;5;150m/operativo/reports/...)',
  ].join('\n'),
  tools: [
    { name: 'glob', status: 'done', args: { pattern: '**/*operativo*.py' }, durationMs: 300 },
    { name: 'grep', status: 'done', args: { pattern: '/operativo|operativo_router' }, durationMs: 300 },
    { name: 'read', status: 'done', args: { file_path: 'routers/operativo_router.py' }, durationMs: 0 },
  ],
};
const rendered = t._renderMessageFull(sample, 88).map(line => t._stripAnsi(line)).join('\n');
console.log(rendered);
"""
    result = subprocess.run(
        ['node', '--input-type=module', '-e', script],
        cwd='/home/re77/Scrivania/ettore_cli',
        env={**os.environ, 'ETTORE_CONFIG_DIR': TEST_CONFIG_DIR, 'NODE_NO_WARNINGS': '1'},
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=10,
    )
    output = result.stdout + result.stderr
    issues = []
    if result.returncode != 0:
        issues.append(f"node renderer check failed with exit code {result.returncode}")
    if '38;5;' in output or '48;5;' in output or '\x1b[38;5;' in output:
        issues.append("orphan ANSI fragment still visible")
    if 'Endpoint | Metodo | Descrizione' in output:
        issues.append("loose endpoint table header still visible")
    if '/operativo/yacht/spese | GET | Lista spese' in output:
        issues.append("loose endpoint row was not normalized")
    if '- GET /operativo/yacht/spese: Lista spese' not in output:
        issues.append("normalized GET endpoint row missing")
    if '┃' in output or '╭' in output or '╰' in output:
        issues.append("assistant report is still rendered inside a box")
    if 'tools' in output or '**/*operativo*.py' in output or 'routers/operativo_router.py' in output:
        issues.append("final assistant tool summary is still visible")

    print(output.strip())
    if issues:
        print(f"\n  Issues found ({len(issues)}):")
        for iss in issues:
            print(f"    ✗  {iss}")
    else:
        print("\n  ✓  Malformed agent text normalized")
    return issues

# ─── Main ─────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    print("ETTORE CLI — display layout test")
    print("Scenarios: standard, narrow, tall, resize simulation")

    all_issues = {}

    all_issues['120×30 (standard)']  = run_scenario('standard',  120, 30)
    all_issues['80×24 (small)']       = run_scenario('small',      80, 24)
    all_issues['200×50 (wide/tall)']  = run_scenario('wide/tall', 200, 50)
    all_issues['80×40 (narrow/tall)'] = run_scenario('narrow/tall', 80, 40)
    all_issues['malformed agent text'] = run_malformed_agent_text_regression()

    print(f"\n{'═'*70}")
    print("  SUMMARY")
    print(f"{'═'*70}")
    total = 0
    for scenario, issues in all_issues.items():
        status = f"✓ ok" if not issues else f"✗ {len(issues)} issue(s)"
        print(f"  {status:20s}  {scenario}")
        total += len(issues)
    print(f"\n  Total issues: {total}")
    sys.exit(0 if total == 0 else 1)
