const MAX_TOOLS = 120;
const MAX_FILES = 120;
const MAX_HISTORY = 8;

function now() {
  return new Date().toISOString();
}

function shortId(prefix = 'mission') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function text(value, fallback = '') {
  const result = String(value ?? '').trim();
  return result || fallback;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class MissionControl {
  constructor() {
    this.history = [];
    this._resetCurrent();
  }

  _resetCurrent() {
    this.id = null;
    this.status = 'idle';
    this.goal = '';
    this.startedAt = null;
    this.endedAt = null;
    this.turns = 0;
    this.plan = null;
    this.todos = [];
    this.tools = [];
    this.waves = [];
    this.files = [];
    this.decisions = [];
    this.usage = { inputTokens: 0, outputTokens: 0 };
    this.tokenCount = 0;
    this.lastEvent = null;
    this.currentTurn = null;
    this.currentWave = null;
  }

  _archiveCurrent() {
    if (!this.id) return;
    this.history.unshift(this.snapshot({ includeHistory: false }));
    if (this.history.length > MAX_HISTORY) this.history.length = MAX_HISTORY;
  }

  _event(type, detail = '') {
    this.lastEvent = { type, detail: text(detail), at: now() };
  }

  startTurn(prompt, { continuation = false } = {}) {
    if (!this.id || (!continuation && this.status !== 'running')) {
      if (this.id) this._archiveCurrent();
      this._resetCurrent();
      this.id = shortId();
      this.goal = text(prompt, 'Untitled mission').slice(0, 500);
      this.startedAt = now();
    } else if (this.status !== 'running') {
      this.status = 'running';
      this.endedAt = null;
    }

    this.status = 'running';
    this.turns += 1;
    this.currentTurn = {
      number: this.turns,
      prompt: text(prompt).slice(0, 500),
      startedAt: now(),
      status: 'running',
    };
    this.currentWave = null;
    this._event('turn', `turn ${this.turns} started`);
  }

  setPlan(plan) {
    if (!plan) return;
    this.plan = {
      goal: text(plan.goal, this.goal).slice(0, 500),
      rationale: text(plan.rationale).slice(0, 500),
      steps: Array.isArray(plan.steps)
        ? plan.steps.slice(0, 30).map((step, index) => ({
          title: text(step?.title, `Step ${index + 1}`).slice(0, 160),
          status: 'pending',
        }))
        : [],
    };
    this._event('plan', `${this.plan.steps.length} steps planned`);
  }

  setTodos(items) {
    this.todos = (Array.isArray(items) ? items : []).slice(0, 30).map(item => ({
      text: text(item?.text ?? item).slice(0, 240),
      status: item?.status === 'done' ? 'done' : 'pending',
    }));
    this._event('todo', `${this.todos.length} todo items`);
  }

  completeTodo(index) {
    const end = Math.min(Number(index) || 0, this.todos.length - 1);
    for (let i = 0; i <= end; i++) {
      if (this.todos[i]) this.todos[i].status = 'done';
      if (this.plan?.steps[i]) this.plan.steps[i].status = 'done';
    }
    this._event('todo', `completed through ${end + 1}`);
  }

  startWave({ index = 0, total = 1, tools = [] } = {}) {
    this.currentWave = {
      index: Number(index) + 1,
      total: Number(total) || 1,
      tools: tools.map(tool => text(tool?.name ?? tool)).filter(Boolean),
      startedAt: now(),
      status: 'running',
    };
    this.waves.push(this.currentWave);
    if (this.waves.length > 30) this.waves.shift();
    this._event('wave', `wave ${this.currentWave.index}/${this.currentWave.total}`);
  }

  endWave({ index = 0, total = 1 } = {}) {
    if (this.currentWave) {
      this.currentWave.status = 'done';
      this.currentWave.endedAt = now();
    }
    this._event('wave', `wave ${Number(index) + 1}/${Number(total) || 1} complete`);
    this.currentWave = null;
  }

  toolStart({ id, name, args = {} } = {}) {
    const entry = {
      id: text(id, shortId('tool')),
      name: text(name, 'tool'),
      args: args && typeof args === 'object' ? clone(args) : {},
      status: 'running',
      startedAt: now(),
    };
    this.tools.push(entry);
    if (this.tools.length > MAX_TOOLS) this.tools.shift();
    this._event('tool', `${entry.name} started`);
  }

  toolEnd({ id, name, output = '' } = {}) {
    const entry = [...this.tools].reverse().find(tool => tool.id === id)
      || [...this.tools].reverse().find(tool => tool.name === name && tool.status === 'running');
    if (entry) {
      entry.status = String(output).startsWith('Error:') ? 'failed' : 'done';
      entry.endedAt = now();
      entry.output = text(output).slice(0, 240);
      entry.durationMs = Math.max(0, Date.parse(entry.endedAt) - Date.parse(entry.startedAt));
    }
    this._event('tool', `${text(name, entry?.name || 'tool')} ${entry?.status || 'done'}`);
  }

  fileChanged({ type, path } = {}) {
    const filePath = text(path);
    if (!filePath) return;
    const existing = this.files.find(file => file.path === filePath);
    if (existing) {
      existing.changes += 1;
      existing.type = text(type, existing.type);
    } else {
      this.files.push({ path: filePath, type: text(type, 'changed'), changes: 1 });
      if (this.files.length > MAX_FILES) this.files.shift();
    }
    this._event('file', `${text(type, 'changed')} ${filePath}`);
  }

  decision(entry) {
    if (!entry) return;
    this.decisions.push({ text: text(entry.text).slice(0, 300), at: entry.at || now() });
    if (this.decisions.length > 20) this.decisions.shift();
    this._event('decision', text(entry.text).slice(0, 100));
  }

  addUsage({ inputTokens = 0, outputTokens = 0 } = {}) {
    this.usage.inputTokens += Number(inputTokens) || 0;
    this.usage.outputTokens += Number(outputTokens) || 0;
    this._event('usage', `${this.usage.inputTokens + this.usage.outputTokens} tokens`);
  }

  setTokenCount(value) {
    this.tokenCount = Number(value) || 0;
  }

  endTurn() {
    if (this.currentTurn) {
      this.currentTurn.status = 'done';
      this.currentTurn.endedAt = now();
    }
    this.currentTurn = null;
    this.currentWave = null;
    this.status = 'completed';
    this.endedAt = now();
    this._event('complete', 'turn complete');
  }

  fail(reason) {
    if (this.currentTurn) {
      this.currentTurn.status = 'failed';
      this.currentTurn.endedAt = now();
    }
    this.currentTurn = null;
    this.currentWave = null;
    this.status = 'failed';
    this.endedAt = now();
    this._event('error', text(reason, 'mission failed').slice(0, 240));
  }

  clear() {
    this._archiveCurrent();
    this._resetCurrent();
  }

  snapshot({ includeHistory = true } = {}) {
    const completedTodos = this.todos.filter(todo => todo.status === 'done').length;
    const completedPlan = this.plan?.steps?.filter(step => step.status === 'done').length || 0;
    const completedTools = this.tools.filter(tool => tool.status === 'done').length;
    const failedTools = this.tools.filter(tool => tool.status === 'failed').length;
    return {
      id: this.id,
      status: this.status,
      goal: this.goal,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      turns: this.turns,
      plan: this.plan ? { ...this.plan, steps: clone(this.plan.steps) } : null,
      todos: clone(this.todos),
      tools: {
        total: this.tools.length,
        completed: completedTools,
        failed: failedTools,
        running: this.tools.filter(tool => tool.status === 'running').length,
        recent: clone(this.tools.slice(-8)),
      },
      waves: clone(this.waves.slice(-8)),
      files: clone(this.files),
      decisions: clone(this.decisions.slice(-5)),
      usage: { ...this.usage },
      tokenCount: this.tokenCount,
      lastEvent: this.lastEvent ? { ...this.lastEvent } : null,
      history: includeHistory ? clone(this.history) : undefined,
      progress: {
        todos: this.todos.length ? `${completedTodos}/${this.todos.length}` : null,
        plan: this.plan?.steps?.length ? `${completedPlan}/${this.plan.steps.length}` : null,
      },
    };
  }

  format() {
    const state = this.snapshot();
    if (!state.id) return 'No active mission. Start a prompt to create one.';
    const lines = [
      `Mission ${state.id}`,
      `Status: ${state.status}`,
      `Goal: ${state.goal || '(not specified)'}`,
      `Turns: ${state.turns}`,
      `Tools: ${state.tools.completed}/${state.tools.total} completed${state.tools.failed ? `, ${state.tools.failed} failed` : ''}`,
      `Waves: ${state.waves.length}`,
      `Files changed: ${state.files.length}`,
      `Tokens: ${state.usage.inputTokens + state.usage.outputTokens || state.tokenCount}`,
    ];
    if (state.progress.plan) lines.push(`Plan: ${state.progress.plan}`);
    if (state.progress.todos) lines.push(`Todos: ${state.progress.todos}`);
    if (state.files.length) {
      lines.push('', 'Files:');
      state.files.slice(-12).forEach(file => lines.push(`  ${file.type}: ${file.path}`));
    }
    if (state.decisions.length) {
      lines.push('', 'Recent decisions:');
      state.decisions.forEach(decision => lines.push(`  - ${decision.text}`));
    }
    if (state.lastEvent) lines.push('', `Last event: ${state.lastEvent.detail}`);
    return lines.join('\n');
  }
}
