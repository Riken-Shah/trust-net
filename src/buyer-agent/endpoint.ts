import { type EndpointNormalizationResult } from './types.js'

const METHOD_PATH_PATTERN = /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+\//i

function looksHostLike(value: string): boolean {
  if (value.startsWith('localhost')) {
    return true
  }

  if (value.includes('://')) {
    return true
  }

  // host/path, host:port, domain.tld, or IPv4-ish
  if (value.includes('.') || value.includes(':')) {
    return true
  }

  return false
}

export function normalizeEndpointUrl(rawEndpointUrl: string): EndpointNormalizationResult {
  const trimmed = rawEndpointUrl.trim()
  if (!trimmed) {
    return { valid: false, normalizedUrl: null, reason: 'invalid_endpoint: empty endpoint_url' }
  }

  if (METHOD_PATH_PATTERN.test(trimmed)) {
    return { valid: false, normalizedUrl: null, reason: 'invalid_endpoint: method/path token is not a URL' }
  }

  if (!looksHostLike(trimmed)) {
    return { valid: false, normalizedUrl: null, reason: 'invalid_endpoint: endpoint_url is not URL-like' }
  }

  const withScheme = trimmed.includes('://') ? trimmed : `http://${trimmed}`

  try {
    const parsed = new URL(withScheme)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, normalizedUrl: null, reason: 'invalid_endpoint: unsupported URL protocol' }
    }

    // Reject localhost / private-network endpoints — not marketplace-ready
    const host = parsed.hostname.toLowerCase()
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '0.0.0.0' ||
      host.endsWith('.local') ||
      host === 'disabled.example.com' ||
      host === 'example.com'
    ) {
      return { valid: false, normalizedUrl: null, reason: 'invalid_endpoint: localhost/private endpoint' }
    }

    return {
      valid: true,
      normalizedUrl: parsed.toString().replace(/\/$/, parsed.pathname === '/' ? '/' : ''),
      reason: null,
    }
  } catch {
    return { valid: false, normalizedUrl: null, reason: 'invalid_endpoint: URL parse failed' }
  }
}

export function getOrigin(url: string): string {
  return new URL(url).origin
}
