// Only bounded numeric kernel counters; never persist raw /proc file contents.
export function parseSchedstat(text) {
  const parts = String(text).trim().split(/\s+/);
  if (parts.length !== 3 || parts.some(v => !/^\d+$/.test(v) || !Number.isSafeInteger(Number(v)))) return null;
  const [runNs, waitNs, slices] = parts.map(Number);
  return { runNs, waitNs, slices };
}

export function parsePressure(text) {
  const result = {};
  for (const line of String(text).trim().split('\n')) {
    const [kind, ...fields] = line.trim().split(/\s+/);
    if (!['some', 'full'].includes(kind)) continue;
    const total = fields.find(f => /^total=\d+$/.test(f));
    if (!total) continue;
    const value = Number(total.slice(6));
    if (Number.isSafeInteger(value)) result[kind + 'Us'] = value;
  }
  return Object.keys(result).length ? result : null;
}
