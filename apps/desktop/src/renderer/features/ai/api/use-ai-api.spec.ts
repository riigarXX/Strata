import { afterEach, describe, expect, it } from 'vitest'
import { ipcOk } from '../../../../shared/ipc-result'
import { createFakeDb, installFakeDb } from '../../connections/testing/fake-db'
import { QWEN } from '../testing/fake-ai'
import { useAiApi } from './use-ai-api'

afterEach(() => {
  Reflect.deleteProperty(window, 'db')
})

function setup() {
  const fake = createFakeDb()
  installFakeDb(fake.db)
  return fake
}

describe('useAiApi', () => {
  it('passes each request through and returns the validated answer', async () => {
    const fake = setup()
    fake.ai.status.mockResolvedValueOnce(
      ipcOk({
        providers: [
          {
            provider: 'ollama',
            baseUrl: 'http://127.0.0.1:11434',
            reachable: true,
            version: '0.12.3',
          },
        ],
      }),
    )
    fake.ai.listModels.mockResolvedValueOnce(ipcOk([QWEN]))
    fake.ai.pullModel.mockResolvedValueOnce(ipcOk({ requestId: 'r1', model: 'qwen3:14b' }))
    fake.ai.cancel.mockResolvedValueOnce(ipcOk({ requestId: 'r1', outcome: 'requested' }))
    fake.ai.generateSql.mockResolvedValueOnce(
      ipcOk({
        requestId: 'q1',
        sql: 'SELECT 1',
        risk: 'read',
        statementType: 'query',
        warnings: [],
      }),
    )
    const api = useAiApi()

    expect(await api.status()).toMatchObject({
      ok: true,
      data: { providers: [{ reachable: true }] },
    })
    expect(await api.listModels({ provider: 'ollama' })).toEqual({ ok: true, data: [QWEN] })
    expect(fake.ai.listModels).toHaveBeenCalledWith({ provider: 'ollama' })
    expect(await api.pullModel({ requestId: 'r1', model: 'qwen3:14b' })).toEqual({
      ok: true,
      data: { requestId: 'r1', model: 'qwen3:14b' },
    })
    expect(await api.cancel({ requestId: 'r1' })).toEqual({
      ok: true,
      data: { requestId: 'r1', outcome: 'requested' },
    })
    expect(
      await api.generateSql({ requestId: 'q1', sessionId: 's1', question: '¿Cuántos?' }),
    ).toMatchObject({ ok: true, data: { sql: 'SELECT 1', risk: 'read' } })
    expect(fake.ai.generateSql).toHaveBeenCalledWith({
      requestId: 'q1',
      sessionId: 's1',
      question: '¿Cuántos?',
    })
  })

  it('turns an exception, a missing bridge or a malformed answer into a normalised error', async () => {
    const fake = setup()
    fake.ai.status.mockRejectedValueOnce(new Error('sender rejected'))
    expect(await useAiApi().status()).toMatchObject({
      ok: false,
      error: { code: 'internal_error' },
    })

    fake.ai.listModels.mockResolvedValueOnce(
      ipcOk([{ name: 'bad name with spaces', sizeBytes: 1, embedding: false }]),
    )
    expect(await useAiApi().listModels({})).toMatchObject({ ok: false })
    fake.ai.listModels.mockResolvedValueOnce(ipcOk('nope' as never))
    expect(await useAiApi().listModels({})).toMatchObject({ ok: false })
    fake.ai.status.mockResolvedValueOnce(ipcOk({ providers: [{ provider: 'ollama' }] } as never))
    expect(await useAiApi().status()).toMatchObject({ ok: false })

    Reflect.deleteProperty(window, 'db')
    expect(await useAiApi().status()).toMatchObject({
      ok: false,
      error: { code: 'internal_error' },
    })
  })

  it('keeps the normalised error main sent', async () => {
    const fake = setup()
    fake.ai.pullModel.mockResolvedValueOnce({
      ok: false,
      error: { code: 'permission_denied', message: 'Disabled', retryable: false },
    })
    expect(await useAiApi().pullModel({ requestId: 'r1', model: 'qwen3:14b' })).toEqual({
      ok: false,
      error: { code: 'permission_denied', message: 'Disabled', retryable: false },
    })
  })
})

describe('useAiApi.onPullProgress', () => {
  it('delivers valid progress and drops what does not follow the contract', () => {
    const fake = setup()
    const seen: unknown[] = []
    useAiApi().onPullProgress((progress) => seen.push(progress))
    const valid = {
      requestId: 'r1',
      model: 'qwen3:14b',
      status: 'pulling abc',
      completed: 1,
      total: 2,
    }

    fake.emitPullProgress(valid)
    fake.emitPullProgress({ ...valid, total: -1 })
    fake.emitPullProgress({ ...valid, status: '' })
    fake.emitPullProgress({ ...valid, extra: true } as never)
    fake.emitPullProgress('progress' as never)

    expect(seen).toEqual([valid])
  })

  it('returns the unsubscribe function of the bridge', () => {
    const fake = setup()
    const seen: unknown[] = []
    const off = useAiApi().onPullProgress((progress) => seen.push(progress))
    expect(fake.pullListenerCount()).toBe(1)

    off()

    expect(fake.pullListenerCount()).toBe(0)
    fake.emitPullProgress({
      requestId: 'r1',
      model: 'm',
      status: 's',
      completed: null,
      total: null,
    })
    expect(seen).toEqual([])
  })
})
