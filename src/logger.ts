import pino, { type Logger } from 'pino';

export type { Logger };

const redactPaths = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'headers["x-api-key"]',
  'apiKey',
  'serviceRoleKey',
  // Sportradar URLs may carry api_key query params in older formats
  'url',
  '*.url',
  'req.url',
];

export function createLogger(opts: { level?: string; pretty?: boolean } = {}): Logger {
  const level = opts.level ?? process.env.LOG_LEVEL ?? 'info';
  const pretty = opts.pretty ?? process.env.NODE_ENV !== 'production';
  return pino({
    level,
    redact: { paths: redactPaths, censor: '[redacted]' },
    base: { service: 'wehoop-api' },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l' },
          },
        }
      : {}),
  });
}
