import { traceAsync, traceCoalescing } from './requestTrace.js';

// Only share currently executing work. Never retain completed product/allergen
// results: a later request must observe fresh database data.
export function createSingleFlight({ maxKeys = 32, maxWaiters = 64, observe = () => {} } = {}) {
  if (![maxKeys, maxWaiters].every((n) => Number.isInteger(n) && n > 0)) {
    throw new Error('Invalid single-flight limits');
  }
  const flights = new Map();
  return async function run(key, task) {
    const existing = flights.get(key);
    if (existing && existing.waiters < maxWaiters) {
      existing.waiters++;
      observe('joined');
      traceCoalescing('joined');
      try { return await traceAsync('search_shared_wait', () => existing.promise); } finally { existing.waiters--; }
    }
    if (existing || flights.size >= maxKeys) {
      observe('rejected');
      traceCoalescing('rejected');
      const error = new Error('Search admission limit reached');
      error.code = 'SEARCH_BUSY';
      throw error;
    }
    observe('started');
    traceCoalescing('started');
    const entry = { waiters: 1 };
    entry.promise = Promise.resolve().then(task).finally(() => flights.delete(key));
    flights.set(key, entry);
    return entry.promise;
  };
}
