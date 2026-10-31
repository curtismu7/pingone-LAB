import fs from 'node:fs';
import https from 'node:https';
import { createApp } from './app.js';
import { DEFAULT_PORT } from './settings.js';
import { selfTest } from './netguard.js';

// Demo tier: ports 5500-5549 only. Loopback only: this server never faces a network.
const port = Number(process.env.PORT || DEFAULT_PORT);
if (!Number.isInteger(port) || port < 5500 || port > 5549) {
  console.error('PORT must be between 5500 and 5549');
  process.exit(1);
}
// The network guard proves itself before the lab serves anything: mock mode must never reach the network.
if (!(await selfTest()).ok) {
  console.error('netguard self-test failed: refusing to start');
  process.exit(1);
}
let app;
try { app = createApp({ port }); } catch (error) {
  // A settings file that is a link or not JSON, or a bad LAB_ALLOWED_HOSTS, stops the lab rather than guessing.
  console.error(['file', 'env'].includes(error?.field) ? error.message : 'PingOne Lab could not start');
  process.exit(1);
}
for (const warning of app.locals.customerWarnings || []) console.warn(`customer.config: ${warning}`);
// LAB_BIND=0.0.0.0 only inside Docker, where compose publishes the port on the Mac's 127.0.0.1 alone.
const bind = process.env.LAB_BIND === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
// LAB_TLS_CERT and LAB_TLS_KEY (PEM files): serve https with that certificate instead of http.
const tls = process.env.LAB_TLS_CERT && process.env.LAB_TLS_KEY;
let server = app;
if (tls) {
  try {
    server = https.createServer({ cert: fs.readFileSync(process.env.LAB_TLS_CERT), key: fs.readFileSync(process.env.LAB_TLS_KEY) }, app);
  } catch {
    console.error('LAB_TLS_CERT or LAB_TLS_KEY could not be read');
    process.exit(1);
  }
}
server.listen(port, bind, () => {
  console.log(`PingOne Lab on ${tls ? 'https' : 'http'}://127.0.0.1:${port}`);
});
