const TRANSITIONS = {
  idle: new Set(['started']),
  started: new Set(['model', 'failed', 'cancelled']),
  model: new Set(['model', 'tool_call', 'completed', 'failed', 'cancelled']),
  tool_call: new Set(['tool_result', 'failed', 'cancelled']),
  tool_result: new Set(['model', 'completed', 'failed', 'cancelled']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export class TurnStateMachine {
  constructor() {
    this.state = 'idle';
    this.history = [{ state: 'idle', at: Date.now() }];
  }

  transition(next, metadata = {}) {
    const target = String(next || '');
    if (target === this.state) return { changed: false, state: this.state };
    const allowed = TRANSITIONS[this.state] || new Set();
    if (!allowed.has(target)) {
      return {
        changed: false,
        state: this.state,
        error: `Invalid turn-state transition: ${this.state} -> ${target}`,
      };
    }
    this.state = target;
    this.history.push({ state: target, at: Date.now(), ...metadata });
    return { changed: true, state: target };
  }

  snapshot() {
    return {
      state: this.state,
      history: this.history.map(entry => ({ ...entry })),
    };
  }
}
