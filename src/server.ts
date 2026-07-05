import { loadConfig } from './config.js'
import { createApp } from './app.js'

/**
 * hermes-lens-sidecar entry point. Binds 127.0.0.1 only — TLS and tailnet
 * exposure are `tailscale serve`'s job. Config comes from the sidecar's own
 * .env / environment (see .env.example); the token is never logged.
 */
const cfg = loadConfig()
const { server, log } = createApp({ cfg })

server.listen(cfg.port, cfg.bind, () => {
  log.info('listening', { bind: cfg.bind, port: cfg.port, vault: cfg.vaultDir })
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info('shutting down', { signal })
    server.close(() => process.exit(0))
    // hard exit if a connection lingers past the systemd stop timeout window
    setTimeout(() => process.exit(0), 3_000).unref()
  })
}
