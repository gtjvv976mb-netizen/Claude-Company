/** Pure authorization/filtering rules for the SSE floor stream. Keeping this outside
 * the HTTP handler makes the privacy boundary directly testable without opening a
 * socket, and prevents a missing query parameter from ever meaning "all floors". */
export function requestedEventFloor(url) {
  const requested = url.searchParams.has("floor")
    ? Number(url.searchParams.get("floor")) : 50;
  return Number.isInteger(requested) && requested >= 1 && requested <= 50
    ? requested : null;
}

export function mayReadEventStream({ floor, wallet, hqOwner, leaseWallet, hasPass = false }) {
  if (!wallet || floor == null) return false;
  if (floor === 50) return wallet === hqOwner;
  return Boolean(leaseWallet && (leaseWallet === wallet || hasPass));
}

export function eventVisibleOnFloor(floor, event) {
  return floor != null && (event?.floor == null || event.floor === floor);
}
