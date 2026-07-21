import { describe, expect, it } from 'vitest'
import { buildAccountLinkingOptions } from '../account-linking'

describe('account linking policy', () => {
  it('lets trusted providers link users pre-created with an unverified email', () => {
    const trustedProviders = ['sso', 'google']

    expect(buildAccountLinkingOptions(trustedProviders)).toEqual({
      enabled: true,
      trustedProviders,
      requireLocalEmailVerified: false,
    })
  })
})
