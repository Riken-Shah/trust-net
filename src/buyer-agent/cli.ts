import { parseArgs } from 'node:util'

export interface BuyerAgentCliOptions {
  includeVerifiedSellers: boolean
  help: boolean
}

export function parseBuyerAgentCliArgs(argv: string[]): BuyerAgentCliOptions {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      'include-verified': {
        type: 'boolean',
      },
      help: {
        type: 'boolean',
        short: 'h',
      },
    },
  })

  return {
    includeVerifiedSellers: values['include-verified'] ?? false,
    help: values.help ?? false,
  }
}

export function getBuyerAgentUsage(): string {
  return [
    'Usage: tsx src/buyer-agent/runOnce.ts [options]',
    '',
    'Options:',
    '  --include-verified  Include agents where is_verified = TRUE',
    '  -h, --help          Show this help message',
  ].join('\n')
}
