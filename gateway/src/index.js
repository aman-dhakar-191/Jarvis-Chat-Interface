'use strict';

const config = require('./config');
const logger = require('./logger');
const { createServer } = require('./server');

for (const warning of config.warnings) logger.warn(warning);

const { server, close } = createServer(config);

server.listen(config.port, () => {
  logger.info('gateway listening', {
    url: `http://localhost:${config.port}`,
    ws: `ws://localhost:${config.port}`,
    responseMode: config.n8n.responseMode,
  });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down', { signal });
  const force = setTimeout(() => process.exit(1), 5000);
  force.unref();
  await close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
