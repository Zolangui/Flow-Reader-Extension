const { createServer } = require('node:http')

const DEFAULT_PORT = 8181
const MOCK_MODEL_ID = 'lumen-mock-1'

function setCorsHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  response.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, X-Requested-With',
  )
}

function json(response, statusCode, body) {
  setCorsHeaders(response)
  response.writeHead(statusCode, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function readJson(request) {
  let raw = ''
  for await (const chunk of request) raw += chunk
  return raw ? JSON.parse(raw) : {}
}

function getMessageText(message) {
  if (typeof message?.content === 'string') return message.content
  if (!Array.isArray(message?.content)) return ''
  return message.content
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('')
}

function getLastUserMessage(messages) {
  const message = [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .find((item) => item?.role === 'user')
  return getMessageText(message).trim()
}

function completionText(userMessage) {
  const question = userMessage.match(/^Question:\s*(.+)$/m)?.[1]?.trim()
  if (question) return `Mock streaming is working. Received: ${question}`
  if (!userMessage)
    return 'Mock server connected. Send a message to test streaming.'
  return `Mock streaming is working. Received: ${userMessage.slice(0, 120)}`
}

function writeEvent(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function handleChatCompletion(request, response) {
  let body
  try {
    body = await readJson(request)
  } catch {
    json(response, 400, {
      error: { message: 'Mock server expected a JSON request body.' },
    })
    return
  }

  const userMessage = getLastUserMessage(body.messages)
  if (userMessage.includes('[mock:rate-limit]')) {
    json(response, 429, {
      error: { message: 'Mock rate limit. Retry after the local backoff.' },
    })
    return
  }
  if (userMessage.includes('[mock:server-error]')) {
    json(response, 500, {
      error: { message: 'Mock server error.' },
    })
    return
  }

  const answer = completionText(userMessage)
  const id = 'chatcmpl-lumen-mock'

  if (!body.stream) {
    json(response, 200, {
      id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model || MOCK_MODEL_ID,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: answer },
          finish_reason: 'stop',
        },
      ],
    })
    return
  }

  setCorsHeaders(response)
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  })

  const splitAt = Math.ceil(answer.length / 2)
  const chunks = [answer.slice(0, splitAt), answer.slice(splitAt)]
  for (const content of chunks.filter(Boolean)) {
    writeEvent(response, {
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: body.model || MOCK_MODEL_ID,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    })
    await delay(20)
  }
  writeEvent(response, {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: body.model || MOCK_MODEL_ID,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })
  response.end('data: [DONE]\n\n')
}

function startMockServer({ port = DEFAULT_PORT, host = '127.0.0.1' } = {}) {
  const server = createServer(async (request, response) => {
    setCorsHeaders(response)
    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }

    const url = new URL(request.url || '/', 'http://localhost')
    if (request.method === 'GET' && url.pathname === '/health') {
      json(response, 200, { status: 'ok', service: 'lumen-ai-mock' })
      return
    }
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      json(response, 200, {
        object: 'list',
        data: [
          {
            id: MOCK_MODEL_ID,
            object: 'model',
            owned_by: 'lumen-local-test',
          },
        ],
      })
      return
    }
    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
      await handleChatCompletion(request, response)
      return
    }

    json(response, 404, {
      error: {
        message: `Mock endpoint not found: ${request.method} ${url.pathname}`,
      },
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const address = server.address()
      const activePort =
        typeof address === 'object' && address ? address.port : port
      resolve({
        baseUrl: `http://127.0.0.1:${activePort}/v1`,
        close: () =>
          new Promise((closeResolve, closeReject) =>
            server.close((error) =>
              error ? closeReject(error) : closeResolve(),
            ),
          ),
      })
    })
  })
}

exports.startMockServer = startMockServer

if (require.main === module) {
  startMockServer()
    .then(({ baseUrl }) => {
      console.log(`Lumen AI mock server listening at ${baseUrl}`)
      console.log(
        'Use provider "Local", allow the loopback connection, and choose Refresh list.',
      )
      console.log(
        'Use [mock:rate-limit] or [mock:server-error] in a message to test error handling.',
      )
    })
    .catch((error) => {
      console.error('Unable to start Lumen AI mock server:', error)
      process.exitCode = 1
    })
}
