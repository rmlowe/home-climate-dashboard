export const HISTORY_REFRESH_MS = 300_000;

// Re-entering a visible tab does not refetch data that was just requested.
export function createHistoryPoller(refresh, hidden, now = Date.now) {
  let lastAttempt = null;
  let busy = false;
  return {
    async refresh() {
      const time = now();
      if (hidden() || busy || (lastAttempt !== null && time >= lastAttempt &&
          time - lastAttempt < HISTORY_REFRESH_MS)) return;
      busy = true;
      lastAttempt = time;
      try { await refresh(); }
      finally { busy = false; }
    },
  };
}
