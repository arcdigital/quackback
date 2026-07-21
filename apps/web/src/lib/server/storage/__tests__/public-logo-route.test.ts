import { describe, expect, it } from 'vitest'
import { isPublicLogoStorageRequest } from '../public-logo-route'

const request = (path: string, method = 'GET') =>
  new Request(`https://feedback.example.com${path}`, { method })

describe('isPublicLogoStorageRequest', () => {
  it('allows anonymous GETs for nested logo keys', () => {
    expect(
      isPublicLogoStorageRequest(request('/api/storage/logos/2026/07/workspace-logo.png'))
    ).toBe(true)
    expect(
      isPublicLogoStorageRequest(request('/api/storage/logos/2026/07/workspace-logo.png?email=1'))
    ).toBe(true)
  })

  it('does not expose other storage prefixes', () => {
    expect(isPublicLogoStorageRequest(request('/api/storage/chat-images/private.png'))).toBe(false)
    expect(isPublicLogoStorageRequest(request('/api/storage/logos-private/image.png'))).toBe(false)
  })

  it('does not allow writes or traversal attempts', () => {
    expect(isPublicLogoStorageRequest(request('/api/storage/logos/image.png', 'PUT'))).toBe(false)
    expect(isPublicLogoStorageRequest(request('/api/storage/logos/%2e%2e/private.png'))).toBe(false)
    expect(isPublicLogoStorageRequest(request('/api/storage/logos/%ZZ/private.png'))).toBe(false)
  })
})
