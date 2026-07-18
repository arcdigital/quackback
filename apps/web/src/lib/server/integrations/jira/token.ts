import { db, eq, integrations } from '@/lib/server/db'
import { decryptSecrets, encryptSecrets } from '../encryption'
import { refreshJiraToken } from './oauth'
import { getPlatformCredentials } from '@/lib/server/domains/platform-credentials/platform-credential.service'
import { cacheDel, CACHE_KEYS } from '@/lib/server/redis'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'jira' })

interface JiraTokenConfig {
  tokenExpiresAt?: string
  [key: string]: unknown
}

interface JiraTokenIntegration {
  secrets: unknown
  config: unknown
}

/**
 * Return a valid Jira access token, refreshing and persisting it when needed.
 * Event hooks and settings functions share this path so cached hook targets
 * cannot keep using a token that the settings page has already refreshed.
 */
export async function getJiraAccessToken(integration: JiraTokenIntegration): Promise<string> {
  const secrets = decryptSecrets<{ accessToken: string; refreshToken?: string }>(
    integration.secrets as string
  )
  const config = (integration.config ?? {}) as JiraTokenConfig

  if (!secrets.refreshToken || !config.tokenExpiresAt) {
    return secrets.accessToken
  }

  const expiresAt = new Date(config.tokenExpiresAt).getTime()
  const bufferMs = 5 * 60 * 1000
  if (Date.now() < expiresAt - bufferMs) {
    return secrets.accessToken
  }

  log.info('access token expired, refreshing')
  const credentials = await getPlatformCredentials('jira')
  const refreshed = await refreshJiraToken(secrets.refreshToken, credentials ?? undefined)
  const newExpiry = new Date(Date.now() + refreshed.expiresIn * 1000).toISOString()

  await db
    .update(integrations)
    .set({
      secrets: encryptSecrets({
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
      }),
      config: { ...config, tokenExpiresAt: newExpiry },
      updatedAt: new Date(),
    })
    .where(eq(integrations.integrationType, 'jira'))

  // Integration target rows cache encrypted secrets for five minutes.
  await cacheDel(CACHE_KEYS.INTEGRATION_MAPPINGS)

  return refreshed.accessToken
}
