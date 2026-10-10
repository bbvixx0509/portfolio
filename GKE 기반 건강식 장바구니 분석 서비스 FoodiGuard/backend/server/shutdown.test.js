import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { installGracefulShutdown } from './shutdown.js';

test('drains an in-flight HTTP request before closing each pool exactly once', async () => {
  const events = [], signals = new EventEmitter();
  let finishRequest, requestStarted;
  const started = new Promise((r) => { requestStarted = r; });
  const server = http.createServer((_req,res) => {
    finishRequest = () => { events.push('response'); res.end('ok'); };
    requestStarted();
  });
  await new Promise((r) => server.listen(0,'127.0.0.1',r));
  const pool = { async end() { events.push('pool'); } };
  const lifecycle = installGracefulShutdown({ server, pools: [pool,pool], signals,
    exit: (code) => events.push('exit:'+code), timeoutMs: 3000 });
  const response = fetch(`http://127.0.0.1:${server.address().port}`, { headers: { Connection: 'close' } });
  await started;
  const stop = lifecycle.shutdown();
  assert.equal(lifecycle.isStopping(), true);
  assert.equal(lifecycle.shutdown(), stop);
  assert.deepEqual(events, []);
  finishRequest();
  assert.equal(await (await response).text(), 'ok');
  await stop;
  assert.deepEqual(events, ['response','pool','exit:0']);
});

test('deadline force-closes stuck HTTP requests and reports failure', async () => {
  const events = [];
  installGracefulShutdown({ server: { close() {}, closeAllConnections() { events.push('force'); } },
    pools: [], signals: new EventEmitter(), timeoutMs: 10, exit: (code) => events.push(code) }).shutdown();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(events, ['force',1]);
});
