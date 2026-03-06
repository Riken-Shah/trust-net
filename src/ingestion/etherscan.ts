/**
 * Etherscan V2 API client — fetches ERC-20 (USDC) token transfers on Base Sepolia.
 * Uses native fetch (Node 18+), no extra dependencies.
 *
 * Docs: https://docs.etherscan.io/api-reference/endpoint/tokentx
 */

const ETHERSCAN_API_URL = 'https://api.etherscan.io/v2/api'
const CHAIN_ID = '84532' // Base Sepolia
const USDC_CONTRACT = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const USDC_DECIMALS = 6

export interface TokenTransfer {
  hash: string
  blockNumber: string
  timeStamp: string
  from: string
  to: string
  value: string
  contractAddress: string
  tokenSymbol: string
  methodId: string
  functionName: string
}

export interface FetchTokenTransfersOptions {
  walletAddress: string
  apiKey: string
  startBlock?: number
  endBlock?: number
  page?: number
  offset?: number
}

interface EtherscanResponse {
  status: string
  message: string
  result: TokenTransfer[] | string
}

export function usdcToHuman(rawValue: string): number {
  return Number(BigInt(rawValue)) / 10 ** USDC_DECIMALS
}

export async function fetchTokenTransfers(
  options: FetchTokenTransfersOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenTransfer[]> {
  const params = new URLSearchParams({
    chainid: CHAIN_ID,
    module: 'account',
    action: 'tokentx',
    contractaddress: USDC_CONTRACT,
    address: options.walletAddress,
    startblock: String(options.startBlock ?? 0),
    endblock: String(options.endBlock ?? 99999999),
    page: String(options.page ?? 1),
    offset: String(options.offset ?? 1000),
    sort: 'asc',
    apikey: options.apiKey,
  })

  const url = `${ETHERSCAN_API_URL}?${params.toString()}`

  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })

  if (!response.ok) {
    throw new Error(`Etherscan request failed: HTTP ${response.status}`)
  }

  const data = (await response.json()) as EtherscanResponse

  if (data.status === '1' && Array.isArray(data.result)) {
    return data.result
  }

  if (data.message === 'No transactions found') {
    return []
  }

  // Rate-limit or error
  const errorDetail = typeof data.result === 'string' ? data.result : JSON.stringify(data.result)
  console.warn(`Etherscan warning for ${options.walletAddress}: ${data.message} — ${errorDetail}`)
  return []
}

export { USDC_CONTRACT, USDC_DECIMALS, CHAIN_ID }
