import { pino, type Logger } from 'pino';
import type { Config } from './config.js';

/**
 * PRD 2: structured logs with a request id on every line. Fastify's per-request child
 * logger carries the id, so route handlers must log through `request.log` rather than
 * this root logger — that is the whole mechanism.
 */
export function createLogger(config: Config): Logger {
  return pino({
    level: config.logLevel,
    // Cloud Run reads stdout as structured JSON when the keys match, which is what
    // makes a request id filterable in Logs Explorer without extra wiring.
    messageKey: 'message',
    formatters: {
      level: (label) => ({ severity: label.toUpperCase() }),
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-goog-iap-jwt-assertion"]',
      ],
      remove: true,
    },
    ...(config.isProduction ? {} : { transport: { target: 'pino-pretty', options: { colorize: true } } }),
  });
}
