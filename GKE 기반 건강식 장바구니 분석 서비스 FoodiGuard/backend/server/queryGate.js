import { traceAsync } from './requestTrace.js';

function overloaded() {
  const error = new Error('검색 요청이 많습니다. 잠시 후 다시 시도해주세요.');
  error.code = 'SEARCH_BUSY';
  error.status = 503;
  return error;
}

// Bounded admission queue: reject excess work before it occupies a DB connection.
export function createQueryGate({ concurrency = 2, maxQueue = 20, timeoutMs = 1500,
  onChange = () => {} } = {}) {
  if (![concurrency, maxQueue, timeoutMs].every(Number.isInteger) || concurrency < 1 || maxQueue < 0 || timeoutMs < 1) {
    throw new Error('Invalid search concurrency/queue configuration');
  }
  let active = 0;
  const queue = [];
  const publish = () => onChange({ active, queued: queue.length });
  publish();
  function release() {
    active -= 1;
    const next = queue.shift();
    if (next) {
      clearTimeout(next.timer);
      active += 1;
      next.resolve();
    }
    publish();
  }
  return async function run(task) {
    if (active < concurrency) active += 1;
    else {
      if (queue.length >= maxQueue) throw overloaded();
      await traceAsync('search_queue', () => new Promise((resolve, reject) => {
        const entry = { resolve };
        entry.timer = setTimeout(() => {
          const index = queue.indexOf(entry);
          if (index >= 0) queue.splice(index, 1);
          publish();
          reject(overloaded());
        }, timeoutMs);
        queue.push(entry);
        publish();
      }));
    }
    publish();
    try { return await task(); } finally { release(); }
  };
}
