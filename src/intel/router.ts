import express, { type Request, type Response, type Router } from 'express'

import { asIntelServiceError, type IntelService } from './service.js'

function parseCompareIds(raw: string | undefined): string[] {
  if (!raw) {
    return []
  }

  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
}

function parseSearchQuery(raw: string | undefined): string {
  return (raw ?? '').trim()
}

function sendError(response: Response, error: unknown): void {
  const intelError = asIntelServiceError(error)
  response.status(intelError.status).json({
    error: {
      code: intelError.code,
      message: intelError.message,
    },
  })
}

export function createIntelRouter(service: IntelService): Router {
  const router = express.Router()

  router.use((_request: Request, response: Response, next) => {
    response.setHeader('Cache-Control', 'no-store')
    next()
  })

  router.get('/agent/:agentId', async (request: Request, response: Response) => {
    try {
      const data = await service.getAgentProfile(request.params.agentId ?? '')
      response.status(200).json(data)
    } catch (error) {
      sendError(response, error)
    }
  })

  router.get('/search', async (request: Request, response: Response) => {
    try {
      const q = parseSearchQuery(typeof request.query.q === 'string' ? request.query.q : undefined)
      const data = await service.search(q)
      response.status(200).json(data)
    } catch (error) {
      sendError(response, error)
    }
  })

  router.get('/trending', async (_request: Request, response: Response) => {
    try {
      const data = await service.getTrending()
      response.status(200).json(data)
    } catch (error) {
      sendError(response, error)
    }
  })

  router.get('/avoid', async (_request: Request, response: Response) => {
    try {
      const data = await service.getAvoidList()
      response.status(200).json(data)
    } catch (error) {
      sendError(response, error)
    }
  })

  router.get('/compare', async (request: Request, response: Response) => {
    try {
      const ids = parseCompareIds(typeof request.query.ids === 'string' ? request.query.ids : undefined)
      const data = await service.compare(ids)
      response.status(200).json(data)
    } catch (error) {
      sendError(response, error)
    }
  })

  return router
}

export { parseCompareIds, parseSearchQuery }
