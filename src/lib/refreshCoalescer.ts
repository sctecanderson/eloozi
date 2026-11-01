/** Serializes refresh requests and collapses any burst during a request into one trailing refresh. */
export function createRefreshCoalescer(
  task: () => Promise<void>,
  trailingDelayMs = 100,
) {
  let active: Promise<void> | null = null;
  let queued = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function finish(current: Promise<void>) {
    if (active !== current) return;
    active = null;
    if (disposed || !queued) return;

    queued = false;
    timer = setTimeout(() => {
      timer = null;
      void request();
    }, trailingDelayMs);
  }

  function request(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (timer) clearTimeout(timer);
    timer = null;
    if (active) {
      queued = true;
      return active;
    }

    const current = Promise.resolve().then(task);
    active = current;
    void current.then(
      () => finish(current),
      () => finish(current),
    );
    return current;
  }

  function dispose() {
    disposed = true;
    queued = false;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return { request, dispose };
}
