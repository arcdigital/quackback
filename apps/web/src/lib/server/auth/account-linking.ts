/**
 * Account-linking policy for identities pre-created by feedback ingestion.
 *
 * External sources may create a user before they sign in. Historical Slack
 * rows and placeholders from sources that are not trusted can have
 * emailVerified=false. A trusted OAuth/OIDC provider is the authority that
 * claims the matching email during sign-in, so requiring the local placeholder
 * to already be verified would make it impossible to attach the provider
 * account.
 */
export function buildAccountLinkingOptions(trustedProviders: string[]) {
  return {
    enabled: true,
    trustedProviders,
    requireLocalEmailVerified: false,
  }
}
