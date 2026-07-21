const PUBLIC_LOGO_PATH_PREFIX = '/api/storage/logos/'

export function isPublicLogoStorageRequest(request: Request): boolean {
  if (request.method !== 'GET') return false

  const pathname = new URL(request.url).pathname
  if (!pathname.startsWith(PUBLIC_LOGO_PATH_PREFIX)) return false

  const encodedKey = pathname.slice('/api/storage/'.length)
  try {
    const key = decodeURIComponent(encodedKey)
    return key.startsWith('logos/') && !key.includes('..')
  } catch {
    return false
  }
}
