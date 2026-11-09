'use strict';
// Runs in a worker thread: reading, indexing, sorting, searching and saving never block the extension host.
const { parentPort } = require('worker_threads');
const { createSession } = require('./core/session');
const { XlsxDoc } = require('./core/xlsxdoc');

const { replaceInFile } = require('./core/session');
const session = createSession({
  post: msg => parentPort.postMessage(msg),
  loadXlsx: (buf, opts) => XlsxDoc.load(buf, opts),
});

// Messages run one at a time, in order, so an edit never overlaps a save.
let chain = Promise.resolve();
parentPort.on('message', msg => {
  chain = chain.then(async () => {
    try {
      const value = msg.type === 'replaceInFile' ? replaceInFile(msg) : await session.handle(msg);
      if (msg.rpc) parentPort.postMessage({ type: 'rpc', rpc: msg.rpc, ok: true, value }, value && value.bytes ? [] : undefined);
    } catch (e) {
      const error = { message: e && e.message ? e.message : String(e), code: e && e.code };
      if (msg.rpc) parentPort.postMessage({ type: 'rpc', rpc: msg.rpc, ok: false, error });
      else parentPort.postMessage({ type: 'error', view: msg.view, message: error.message, transient: true });
    }
  });
});
