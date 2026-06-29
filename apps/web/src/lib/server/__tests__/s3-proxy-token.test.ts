import { describe, it, expect, vi } from 'vitest'
import { createHmac } from 'node:crypto'

// Proxy upload tokens are signed with a key derived from the app SECRET_KEY via
// HKDF (not the S3 secret) — so a pod-identity deployment with no static S3
// keys can still issue and verify them. We mock the derivation to a fixed key.
const DERIVED_KEY = Buffer.from('derived-proxy-upload-key-32-bytes!!', 'utf8')
vi.mock('@/lib/server/config', () => ({ config: {} }))
vi.mock('@/lib/server/encryption', () => ({ deriveKey: vi.fn(() => DERIVED_KEY) }))

const { verifyProxyUploadToken } = await import('@/lib/server/storage/s3')

const KEY = 'avatars/2024/01/abc123-photo.png'
const CT = 'image/png'

function makeToken(secret: Buffer | string, key: string, ct: string, exp: number) {
  const sig = createHmac('sha256', secret).update(`${key}|${ct}|${exp}`).digest('hex').slice(0, 32)
  return { exp: String(exp), sig }
}

function validToken() {
  return makeToken(DERIVED_KEY, KEY, CT, Date.now() + 60_000)
}

describe('verifyProxyUploadToken', () => {
  it('returns true for a valid token', () => {
    const { exp, sig } = validToken()
    expect(verifyProxyUploadToken(KEY, CT, exp, sig)).toBe(true)
  })

  it('returns false when exp is null', () => {
    const { sig } = validToken()
    expect(verifyProxyUploadToken(KEY, CT, null, sig)).toBe(false)
  })

  it('returns false when sig is null', () => {
    const { exp } = validToken()
    expect(verifyProxyUploadToken(KEY, CT, exp, null)).toBe(false)
  })

  it('returns false for an expired token', () => {
    const exp = Date.now() - 1
    const { sig } = makeToken(DERIVED_KEY, KEY, CT, exp)
    expect(verifyProxyUploadToken(KEY, CT, String(exp), sig)).toBe(false)
  })

  it('returns false for a tampered signature', () => {
    const { exp } = validToken()
    expect(verifyProxyUploadToken(KEY, CT, exp, 'a'.repeat(32))).toBe(false)
  })

  it('returns false when key does not match the signed key', () => {
    const { exp, sig } = validToken()
    expect(verifyProxyUploadToken('logos/other.png', CT, exp, sig)).toBe(false)
  })

  it('returns false when content-type does not match the signed content-type', () => {
    const { exp, sig } = validToken()
    expect(verifyProxyUploadToken(KEY, 'image/jpeg', exp, sig)).toBe(false)
  })

  it('returns false when signed with a different secret', () => {
    const { exp, sig } = makeToken('different-secret', KEY, CT, Date.now() + 60_000)
    expect(verifyProxyUploadToken(KEY, CT, exp, sig)).toBe(false)
  })

  it('returns false for non-numeric exp', () => {
    const { sig } = validToken()
    expect(verifyProxyUploadToken(KEY, CT, 'not-a-number', sig)).toBe(false)
  })

  it('returns false for a sig of wrong length without throwing', () => {
    const { exp } = validToken()
    expect(verifyProxyUploadToken(KEY, CT, exp, 'short')).toBe(false)
    expect(verifyProxyUploadToken(KEY, CT, exp, 'a'.repeat(64))).toBe(false)
  })
})
