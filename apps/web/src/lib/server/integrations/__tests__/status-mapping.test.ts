import { describe, expect, it } from 'vitest'
import { resolveExternalStatuses } from '../status-mapping'

describe('resolveExternalStatuses', () => {
  it('returns every external status mapped to the local status', () => {
    expect(
      resolveExternalStatuses('status_closed', {
        Done: 'status_closed',
        Closed: 'status_closed',
        Open: 'status_open',
        Ignored: null,
      })
    ).toEqual(['Done', 'Closed'])
  })

  it('returns no statuses without a matching mapping', () => {
    expect(resolveExternalStatuses('status_closed', undefined)).toEqual([])
    expect(resolveExternalStatuses('status_closed', { Open: 'status_open' })).toEqual([])
  })
})
