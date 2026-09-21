export const HISTORY_REFRESH_MS = 300_000;

// Re-entering a visible tab does not refetch data that was just requested.
export function createHistoryPoller(refresh, hidden, now = Date.now, getKey = () => '24h') {
  let lastAttempt = null;
  let lastKey;
  let busy = false;
  async function poll() {
    const time = now();
    const key = getKey();
    if (hidden() || busy || (key === lastKey && lastAttempt !== null && time >= lastAttempt &&
        time - lastAttempt < HISTORY_REFRESH_MS)) return;
    busy = true;
    lastAttempt = time;
    lastKey = key;
    try { await refresh(key); }
    finally { busy = false; }
    // Coalesce changes during a request into one fetch of the latest range.
    if (key !== getKey()) return poll();
  }
  return { refresh: poll };
}
