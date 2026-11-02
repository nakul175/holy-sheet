import { Server, ServerResponse } from 'node:http';

const pipeEvents = ['error', 'close', 'finish', 'unpipe'];
const marker = Symbol.for('hs.acceptanceSocketGuard');

// Next's dev server pipes each keep-alive response onto the same Socket.
// Node warns at 11 listeners and later resets that socket. Retire it once the
// pipe listeners stack, and stop the warning on a fresh acceptance connection.
export function installAcceptanceSocketGuard() {
  if (Server.prototype[marker]) return;
  Server.prototype[marker] = true;
  const emit = Server.prototype.emit;
  Server.prototype.emit = function (event, ...args) {
    if (event === 'connection' && args[0] && typeof args[0].setMaxListeners === 'function') args[0].setMaxListeners(0);
    return emit.call(this, event, ...args);
  };
  const end = ServerResponse.prototype.end;
  ServerResponse.prototype.end = function (...args) {
    const socket = this.socket;
    if (socket && !socket.destroyed && pipeEvents.some(event => socket.listenerCount(event) > 20)) {
      this.once('finish', () => { if (!socket.destroyed) socket.destroy(); });
    }
    return end.apply(this, args);
  };
}

installAcceptanceSocketGuard();
