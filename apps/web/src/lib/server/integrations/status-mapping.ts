/**
 * Status mapping resolution.
 *
 * Maps external platform status names to Quackback StatusIds
 * using the statusMappings stored in integrations.config.
 */

import type { StatusId } from '@quackback/ids'

/**
 * Status mappings stored in integrations.config.statusMappings.
 * Key = external status name (case-sensitive as received from platform).
 * Value = Quackback StatusId or null (ignore this status).
 */
export type StatusMappings = Record<string, string | null>

/**
 * Resolve an external status name to a Quackback StatusId.
 * Returns null if no mapping exists or the mapping explicitly says to ignore.
 */
export function resolveStatusMapping(
  externalStatus: string,
  mappings: StatusMappings | undefined
): StatusId | null {
  if (!mappings) return null

  const mapped = mappings[externalStatus]
  if (mapped === undefined || mapped === null) return null

  return mapped as StatusId
}

/**
 * Resolve a Quackback status ID to all mapped external status names.
 * Multiple names are possible when separate external workflows share a
 * Quackback status; the outbound handler selects one available transition.
 */
export function resolveExternalStatuses(
  statusId: string,
  mappings: StatusMappings | undefined
): string[] {
  if (!mappings) return []

  return Object.entries(mappings)
    .filter(([, mappedStatusId]) => mappedStatusId === statusId)
    .map(([externalStatus]) => externalStatus)
}
