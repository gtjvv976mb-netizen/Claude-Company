import { EventEmitter } from "node:events";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which floor is this work being done for? Carried in async context rather than threaded
 * through every emit() call in the pipeline, so the desk code stays unaware of tenancy
 * and one tenant's research can never be mislabelled as another's.
 */
export const runContext = new AsyncLocalStorage();
export const runFor = (floor, fn) => runContext.run({ floor }, fn);

// The desk narrates itself. The office view subscribes to this and turns each
// event into a person walking somewhere and doing something.
export const bus = new EventEmitter();
bus.setMaxListeners(50);

const RING = [];
const RING_MAX = 400;

export function emit(type, payload = {}) {
  const floor = runContext.getStore()?.floor ?? null;
  const ev = { type, ts: Date.now(), ...(floor != null ? { floor } : {}), ...payload };
  RING.push(ev);
  if (RING.length > RING_MAX) RING.shift();
  bus.emit("event", ev);
  return ev;
}

export function backlog(floor = null) {
  // A floor sees only its own work; the house view (floor null) sees everything.
  return floor == null ? RING.slice() : RING.filter((e) => e.floor === floor);
}
