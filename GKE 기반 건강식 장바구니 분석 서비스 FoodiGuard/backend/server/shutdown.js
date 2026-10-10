// Stop accepting work, drain HTTP requests, then close SQL pools. Native proxy
// sidecars stay alive until this application container exits.
export function installGracefulShutdown({ server, pools, timeoutMs = 35000,
  signals = process, exit = (code) => process.exit(code) }) {
  let stopping = false;
  let pending;
  function shutdown() {
    if (pending) return pending;
    stopping = true;
    const deadline = setTimeout(() => {
      server.closeAllConnections?.();
      exit(1);
    }, timeoutMs);
    deadline.unref?.();
    pending = new Promise((resolve) => server.close(resolve))
      .then(() => Promise.all([...new Set(pools)].map((pool) => pool.end())))
      .then(() => { clearTimeout(deadline); exit(0); })
      .catch(() => { clearTimeout(deadline); exit(1); });
    return pending;
  }
  signals.on('SIGTERM', shutdown);
  signals.on('SIGINT', shutdown);
  return { shutdown, isStopping: () => stopping };
}
