import { EventEmitter } from "node:events";

// The desk narrates itself. The office view subscribes to this and turns each
// event into a person walking somewhere and doing something.
export const bus = new EventEmitter();
bus.setMaxListeners(50);

const RING = [];
const RING_MAX = 400;

export function emit(type, payload = {}) {
  const ev = { type, ts: Date.now(), ...payload };
  RING.push(ev);
  if (RING.length > RING_MAX) RING.shift();
  bus.emit("event", ev);
  return ev;
}

export function backlog() {
  return RING.slice();
}
