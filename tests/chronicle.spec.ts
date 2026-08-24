import { afterEach, describe, expect, it, vi } from 'vitest'
import { postChronicle } from '../src/chronicle.ts'

const fetchMock = vi.fn()

afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

const stubFetch = (impl: (...args: unknown[]) => Promise<unknown>) => {
  vi.stubGlobal('fetch', fetchMock.mockImplementation(impl))
}

describe('chronicle ingest', () => {
  it('does nothing when the endpoint is empty', () => {
    stubFetch(async () => ({ ok: true }))
    postChronicle('', { source: 'lark-bridge', text: 'hi' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts source, text and chatId as JSON', async () => {
    stubFetch(async () => ({ ok: true, status: 200 }))
    postChronicle('http://127.0.0.1:8792/record', {
      source: 'lark-bridge',
      text: '你好',
      chatId: 'oc_test',
    })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:8792/record')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      source: 'lark-bridge',
      text: '你好',
      chatId: 'oc_test',
    })
  })

  it('logs but never throws when fetch rejects', () => {
    stubFetch(async () => {
      throw new Error('boom')
    })
    const log = vi.fn()
    expect(() => postChronicle('http://127.0.0.1:1/record', { source: 's', text: 't' }, log)).not.toThrow()
    expect(log).not.toHaveBeenCalled() // async failure lands later, still swallowed
  })

  it('logs non-2xx responses without throwing', async () => {
    stubFetch(async () => ({ ok: false, status: 503 }))
    const log = vi.fn()
    postChronicle('http://127.0.0.1:8792/record', { source: 's', text: 't' }, log)
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining('503')))
  })
})
