import { beforeEach, describe, expect, it, vi } from 'vitest'

const updateWhere = vi.fn()
const updateSet = vi.fn(() => ({ where: updateWhere }))
const dbUpdate = vi.fn(() => ({ set: updateSet }))
const decryptSecrets = vi.fn()
const encryptSecrets = vi.fn((value: unknown) => ({ encrypted: value }))
const refreshJiraToken = vi.fn()
const getPlatformCredentials = vi.fn()
const cacheDel = vi.fn()

vi.mock('@/lib/server/db', () => ({
  db: { update: dbUpdate },
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  integrations: { integrationType: 'integration_type' },
}))

vi.mock('../../encryption', () => ({
  decryptSecrets,
  encryptSecrets,
}))

vi.mock('../oauth', () => ({
  refreshJiraToken,
}))

vi.mock('@/lib/server/domains/platform-credentials/platform-credential.service', () => ({
  getPlatformCredentials,
}))

vi.mock('@/lib/server/redis', () => ({
  cacheDel,
  CACHE_KEYS: { INTEGRATION_MAPPINGS: 'hooks:integration-mappings' },
}))

const { getJiraAccessToken } = await import('../token')

beforeEach(() => {
  vi.clearAllMocks()
  updateWhere.mockResolvedValue(undefined)
  getPlatformCredentials.mockResolvedValue({ clientId: 'id', clientSecret: 'secret' })
})

describe('getJiraAccessToken', () => {
  it('returns the stored token while it is valid', async () => {
    decryptSecrets.mockReturnValue({
      accessToken: 'current-token',
      refreshToken: 'refresh-token',
    })

    const token = await getJiraAccessToken({
      secrets: 'encrypted',
      config: { tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
    })

    expect(token).toBe('current-token')
    expect(refreshJiraToken).not.toHaveBeenCalled()
  })

  it('refreshes an expired token and invalidates cached hook targets', async () => {
    decryptSecrets.mockReturnValue({
      accessToken: 'expired-token',
      refreshToken: 'refresh-token',
    })
    refreshJiraToken.mockResolvedValue({
      accessToken: 'fresh-token',
      refreshToken: 'rotated-refresh-token',
      expiresIn: 3600,
    })

    const token = await getJiraAccessToken({
      secrets: 'encrypted',
      config: { tokenExpiresAt: new Date(Date.now() - 1000).toISOString() },
    })

    expect(token).toBe('fresh-token')
    expect(refreshJiraToken).toHaveBeenCalledWith('refresh-token', {
      clientId: 'id',
      clientSecret: 'secret',
    })
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        secrets: {
          encrypted: {
            accessToken: 'fresh-token',
            refreshToken: 'rotated-refresh-token',
          },
        },
      })
    )
    expect(cacheDel).toHaveBeenCalledWith('hooks:integration-mappings')
  })
})
