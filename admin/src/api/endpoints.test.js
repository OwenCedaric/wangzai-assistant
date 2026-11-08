import { describe, expect, it } from 'vitest'
import {
  apiPoolKeyRotate, apiPoolProviderEndpoint, apiPoolProviderKeys, apiPoolProviderModels,
  agentUsers, cardBatchCode, cardBatchCodes, cardBatchRevealedCodes,
  cardBatchRevealedCodesSearch, channelRotateToken, endpoints, orderQuery, orderRefund,
  planStopSales, resourceById,
  paidCapabilityRateCardDisable, paidCapabilityRateCardImagePrice,
  paidCapabilityRateCardMultipliers,
  paidCapabilityReconciliation,
} from './endpoints.js'

describe('card batch endpoints', () => {
  it('builds the batch status endpoint from the centralized resource', () => {
    expect(resourceById(endpoints.cardBatches, 18)).toBe('/api/admin/card-batches/18')
  })

  it('builds and safely encodes the activation code endpoint', () => {
    expect(cardBatchCodes(18)).toBe('/api/admin/card-batches/18/codes')
    expect(cardBatchRevealedCodes(18)).toBe('/api/admin/card-batches/18/codes/revealed')
    expect(cardBatchRevealedCodesSearch(18)).toBe('/api/admin/card-batches/18/codes/revealed/search')
    expect(cardBatchCode(18, 'code/7')).toBe('/api/admin/card-batches/18/codes/code%2F7')
  })
})

describe('commerce endpoints', () => {
  it('keeps channel token rotation and order actions centralized', () => {
    expect(channelRotateToken('channel/8')).toBe('/api/admin/channels/channel%2F8/rotate-token')
    expect(agentUsers(3)).toBe('/api/admin/agents/3/users')
    expect(orderQuery(9)).toBe('/api/admin/orders/9/query')
    expect(orderRefund(9)).toBe('/api/admin/orders/9/refund')
  })

  it('uses the read-only payment configuration health endpoint', () => {
    expect(endpoints.paymentConfigStatus).toBe('/api/admin/payment-config/status')
    expect(endpoints.commissionRules).toBe('/api/admin/commission-rules')
  })

  it('builds the dedicated safe plan delisting endpoint', () => {
    expect(planStopSales('plan/7')).toBe('/api/admin/plans/plan%2F7/stop-sales')
  })

  it('keeps paid capability price-version actions centralized', () => {
    expect(endpoints.paidCapabilityRateCards).toBe('/api/admin/paid-capabilities/rate-cards')
    expect(paidCapabilityRateCardDisable('rate/7')).toBe('/api/admin/paid-capabilities/rate-cards/rate%2F7/disable')
    expect(paidCapabilityRateCardImagePrice('rate/7')).toBe('/api/admin/paid-capabilities/rate-cards/rate%2F7/image-price')
    expect(paidCapabilityRateCardMultipliers('rate/7')).toBe('/api/admin/paid-capabilities/rate-cards/rate%2F7/multipliers')
    expect(endpoints.paidCapabilityReconciliations).toBe('/api/admin/paid-capabilities/reconciliations')
    expect(paidCapabilityReconciliation('job/7')).toBe('/api/admin/paid-capabilities/reconciliations/job%2F7')
  })
})

describe('API pool endpoints', () => {
  it('keeps provider, key rotation, and model paths centralized', () => {
    expect(endpoints.apiPoolProviders).toBe('/api/admin/api-pool/providers')
    expect(endpoints.apiPoolAutoConnect).toBe('/api/admin/api-pool/auto-connect')
    expect(apiPoolProviderKeys(7)).toBe('/api/admin/api-pool/providers/7/keys')
    expect(apiPoolProviderModels(7)).toBe('/api/admin/api-pool/providers/7/models')
    expect(apiPoolProviderEndpoint(7)).toBe('/api/admin/api-pool/providers/7/endpoint')
    expect(apiPoolKeyRotate(9)).toBe('/api/admin/api-pool/keys/9/rotate')
  })
})

describe('OSS management endpoints', () => {
  it('keeps OSS configuration and usage under one centralized admin resource', () => {
    expect(endpoints.ossManagement).toBe('/api/admin/oss')
  })
})
