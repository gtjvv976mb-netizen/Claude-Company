/** Pure authorization/filtering rules for the SSE floor stream. Keeping this outside
 * the HTTP handler makes the privacy boundary directly testable without opening a
 * socket, and prevents a missing query parameter from ever meaning "all floors". */
export function requestedEventFloor(url) {
  const requested = url.searchParams.has("floor")
    ? Number(url.searchParams.get("floor")) : 50;
  return Number.isInteger(requested) && requested >= 1 && requested <= 50
    ? requested : null;
}

/* THE HQ IS THE SHOP WINDOW. Floor 50 — the house's own desk — streams live to
   everyone, signed in or not: the visitor sees the real sixteen at real work,
   not a demo shift. A leased floor still opens only to its tenant or to a
   holder of a paid guest pass; the tenant's edge stays theirs. */
export function mayReadEventStream({ floor, wallet, hqOwner, leaseWallet, hasPass = false }) {
  if (floor == null) return false;
  if (floor === 50) return true;
  if (!wallet) return false;
  return Boolean(leaseWallet && (leaseWallet === wallet || hasPass));
}

export function eventVisibleOnFloor(floor, event) {
  return floor != null && (event?.floor == null || event.floor === floor);
}
