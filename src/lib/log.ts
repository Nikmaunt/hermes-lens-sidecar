/**
 * Structured JSON-lines logging to stdout (systemd journal picks it up).
 * Never log the bearer token, request bodies, or note contents — callers
 * pass only method/path/status/timing and short diagnostic fields.
 */

export type LogSink = (line: string) => void

export interface Logger {
  info(msg: string, fields?: Record<string, string | number | boolean>): void
  warn(msg: string, fields?: Record<string, string | number | boolean>): void
}

export function createLogger(sink?: LogSink): Logger {
  const write: LogSink = sink ?? ((line) => process.stdout.write(line + '\n'))
  const emit = (
    level: 'info' | 'warn',
    msg: string,
    fields?: Record<string, string | number | boolean>,
  ): void => {
    write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }))
  }
  return {
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
  }
}
