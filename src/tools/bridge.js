import { EventEmitter } from 'events';

// Shared bridge between tool handlers and the interactive UI.
// Tools emit events here; the Ink app subscribes and drives them.
export const uiBridge = new EventEmitter();
// Some events can have many listeners during the session lifetime.
uiBridge.setMaxListeners(50);
