'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const scope = new AsyncLocalStorage();
const normalize = lane => lane === 'ship' ? 'ship' : 'hang';
const current = () => scope.getStore() || 'hang';
const run = (lane, fn) => scope.run(normalize(lane), fn);
module.exports = { current, run, normalize };
