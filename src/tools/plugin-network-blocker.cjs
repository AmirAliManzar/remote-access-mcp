const blocked = () => {
  const error = new Error('Plugin network access is disabled by Remote Access MCP sandbox.');
  error.code = 'ERR_PLUGIN_NETWORK_DENIED';
  throw error;
};

try {
  const net = require('node:net');
  net.connect = blocked;
  net.createConnection = blocked;
  if (net.Socket?.prototype?.connect) net.Socket.prototype.connect = blocked;
} catch {}
try {
  const tls = require('node:tls');
  tls.connect = blocked;
} catch {}
try {
  const http = require('node:http');
  http.request = blocked;
  http.get = blocked;
} catch {}
try {
  const https = require('node:https');
  https.request = blocked;
  https.get = blocked;
} catch {}
try {
  const dgram = require('node:dgram');
  dgram.createSocket = blocked;
} catch {}
try {
  const dns = require('node:dns');
  dns.lookup = blocked;
  dns.resolve = blocked;
  dns.resolve4 = blocked;
  dns.resolve6 = blocked;
} catch {}
if (typeof globalThis.fetch === 'function') globalThis.fetch = blocked;
if (typeof globalThis.WebSocket === 'function') globalThis.WebSocket = class { constructor() { blocked(); } };
