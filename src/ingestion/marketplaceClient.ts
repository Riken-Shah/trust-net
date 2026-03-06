import { type DiscoverSnapshot } from './types.js'

export interface DiscoverClientConfig {
  discoverApiUrl: string
  nvmApiKey: string
  timeoutMs: number
  retryCount: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseSnapshot(payload: unknown): DiscoverSnapshot {
  if (!isRecord(payload)) {
    throw new Error('Discover response is not an object.')
  }

  const sellers = payload.sellers
  const buyers = payload.buyers

  if (!Array.isArray(sellers)) {
    throw new Error('Discover response missing sellers array.')
  }
  if (!Array.isArray(buyers)) {
    throw new Error('Discover response missing buyers array.')
  }

  return {
    sellers,
    buyers,
  }
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export async function fetchDiscoverSnapshot(
  config: DiscoverClientConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoverSnapshot> {
  const maxAttempts = config.retryCount + 1
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort()
    }, config.timeoutMs)

    try {
      const response = await fetchImpl(config.discoverApiUrl, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-nvm-api-key': config.nvmApiKey,
        },
        signal: controller.signal,
      })

      if (!response.ok) {
        const body = await response.text()
        const message = `Discover request failed with status ${response.status}. Body: ${body.slice(0, 500)}`
        if (attempt < maxAttempts && isRetryableStatus(response.status)) {
          await sleep(200 * attempt)
          continue
        }
        throw new Error(message)
      }

      const payload = await response.json()
      return parseSnapshot(payload)
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error('Unknown discover request failure.')
      lastError = wrapped

      if (attempt < maxAttempts) {
        await sleep(200 * attempt)
        continue
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  throw new Error(`Discover fetch failed after ${maxAttempts} attempts: ${lastError?.message ?? 'unknown error'}`)
}
