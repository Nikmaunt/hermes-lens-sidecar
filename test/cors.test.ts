import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildEnv, TEST_TOKEN, type TestEnv } from './helpers/env'

/**
 * CORS behavior as seen by the Hermes Lens app (Capacitor WebView, origin
 * https://localhost). The contract tests run in Node where CORS does not
 * exist, so these assert the headers directly: preflight answered before
 * auth, and Access-Control-Allow-Origin present on every response — 401s
 * included, so the app can read auth failures instead of seeing them as
 * network errors.
 */

const ORIGIN = 'https://localhost'

let env: TestEnv

beforeAll(async () => {
  env = await buildEnv()
})
afterAll(async () => {
  await env.close()
})

describe('CORS', () => {
  it('OPTIONS preflight: 204 + all CORS headers, no auth required', async () => {
    const res = await fetch(`${env.baseUrl}/api/status`, {
      method: 'OPTIONS',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS')
    expect(res.headers.get('access-control-allow-headers')).toBe('Authorization, Content-Type')
    expect(res.headers.get('access-control-max-age')).toBe('600')
  })

  it('GET with Origin and valid token: 200 with allow-origin header', async () => {
    const res = await fetch(`${env.baseUrl}/api/status`, {
      headers: { origin: ORIGIN, authorization: `Bearer ${TEST_TOKEN}` },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('GET with Origin and no token: 401 still carries allow-origin header', async () => {
    const res = await fetch(`${env.baseUrl}/api/status`, {
      headers: { origin: ORIGIN },
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  it('error envelopes carry allow-origin too (404 route)', async () => {
    const res = await fetch(`${env.baseUrl}/api/nope`, {
      headers: { origin: ORIGIN, authorization: `Bearer ${TEST_TOKEN}` },
    })
    expect(res.status).toBe(404)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })
})
