import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePressure, parseSchedstat } from './diagnosticCounters.js';

test('scheduler counters preserve nanoseconds and reject missing, unsafe and malformed values', () => {
  assert.deepEqual(parseSchedstat('1000000 2000000 3\n'), { runNs:1000000, waitNs:2000000, slices:3 });
  assert.deepEqual(parseSchedstat('0 0 0'), { runNs:0, waitNs:0, slices:0 });
  for(const x of [null,'','1 2','1 2 3 extra','-1 2 3','1.5 2 3','9007199254740992 0 0']) assert.equal(parseSchedstat(x),null);
});

test('pressure parser keeps only bounded cumulative totals, not raw content or rolling averages', () => {
  assert.deepEqual(parsePressure('some avg10=1.20 avg60=0 total=123\nfull avg10=0 total=45'), {someUs:123,fullUs:45});
  assert.deepEqual(parsePressure('some total=0\nunknown total=12\nfull total=-1'), {someUs:0});
  for(const x of [null,'','secret data','some avg10=30','some total=9007199254740992']) assert.equal(parsePressure(x),null);
});
