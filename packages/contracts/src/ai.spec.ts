import { describe, expect, it } from 'vitest'
import {
  AI_DEFAULT_BASE_URLS,
  AI_QUESTION_MAX_LENGTH,
  AiBaseUrlSchema,
  AiGenerateSqlRequestSchema,
  AiGenerateSqlResultSchema,
  AiListModelsRequestSchema,
  AiModelInfoSchema,
  AiModelNameSchema,
  AiPullModelRequestSchema,
  AiPullProgressSchema,
  AiStatusSchema,
  normalizeAiBaseUrl,
} from './ai'

describe('normalizeAiBaseUrl', () => {
  it.each([
    ['http://127.0.0.1:11434', 'http://127.0.0.1:11434'],
    ['http://127.0.0.1:11434/', 'http://127.0.0.1:11434'],
    ['HTTP://LOCALHOST:1234', 'http://localhost:1234'],
    ['http://localhost:1234/v1', 'http://localhost:1234/v1'],
    ['http://localhost:1234/v1/', 'http://localhost:1234/v1'],
    ['https://127.0.0.1:8443', 'https://127.0.0.1:8443'],
    ['http://[::1]:11434', 'http://[::1]:11434'],
    ['http://[::1]:65535', 'http://[::1]:65535'],
    ['http://127.0.0.1:1024', 'http://127.0.0.1:1024'],
  ])('accepts %s', (value, expected) => {
    expect(normalizeAiBaseUrl(value)).toBe(expected)
  })

  it.each([
    ['credentials that make the real host another one', 'http://127.0.0.1@evil.com'],
    ['credentials with a port', 'http://127.0.0.1:11434@evil.com:80'],
    ['credentials before loopback', 'http://user:pass@127.0.0.1:11434'],
    ['a host that starts like localhost', 'http://localhost.evil.com:11434'],
    ['a host that ends like localhost', 'http://evillocalhost:11434'],
    ['a subdomain of loopback', 'http://a.127.0.0.1.nip.io:11434'],
    ['an address that only looks like loopback', 'http://127.0.0.1.evil.com:11434'],
    ['the whole of 127.0.0.0/8', 'http://127.0.0.2:11434'],
    ['a short IPv4 form', 'http://127.1:11434'],
    ['a decimal IPv4', 'http://2130706433:11434'],
    ['a hexadecimal IPv4', 'http://0x7f000001:11434'],
    ['the unspecified address', 'http://0.0.0.0:11434'],
    ['the unspecified IPv6 address', 'http://[::]:11434'],
    ['an IPv4-mapped IPv6 address', 'http://[::ffff:127.0.0.1]:11434'],
    ['a long IPv6 loopback', 'http://[0:0:0:0:0:0:0:1]:11434'],
    ['a private network address', 'http://192.168.1.10:11434'],
    ['the link-local metadata address', 'http://169.254.169.254:11434'],
    ['a remote host', 'https://api.openai.com'],
    ['no port', 'http://127.0.0.1'],
    ['no port and a path', 'http://localhost/v1'],
    ['a privileged port', 'http://127.0.0.1:80'],
    ['a port below 1024', 'http://127.0.0.1:1023'],
    ['a port above 65535', 'http://127.0.0.1:65536'],
    ['a port with a leading zero', 'http://127.0.0.1:01234'],
    ['port zero', 'http://127.0.0.1:0'],
    ['a non numeric port', 'http://127.0.0.1:abc'],
    ['another scheme', 'ftp://127.0.0.1:11434'],
    ['file scheme', 'file://127.0.0.1:11434/etc/passwd'],
    ['no scheme', '127.0.0.1:11434'],
    ['a scheme-relative URL', '//127.0.0.1:11434'],
    ['a query string', 'http://127.0.0.1:11434/?token=1'],
    ['a fragment', 'http://127.0.0.1:11434/#x'],
    ['a backslash that WHATWG reads as a slash', 'http://127.0.0.1:11434\\@evil.com'],
    ['an at sign in the path', 'http://127.0.0.1:11434/@evil.com'],
    ['a dot segment', 'http://127.0.0.1:11434/../admin'],
    ['a single dot segment', 'http://127.0.0.1:11434/./v1'],
    ['an encoded slash', 'http://127.0.0.1:11434/%2e%2e/admin'],
    ['whitespace around it', ' http://127.0.0.1:11434'],
    ['a trailing space', 'http://127.0.0.1:11434 '],
    ['a newline that would split a header', 'http://127.0.0.1:11434\nHost: evil.com'],
    ['a tab', 'http://127.0.0.1:\t11434'],
    ['an empty string', ''],
  ])('rejects %s', (_name, value) => {
    expect(normalizeAiBaseUrl(value)).toBeUndefined()
  })
})

describe('AiBaseUrlSchema', () => {
  it('accepts every default address', () => {
    for (const baseUrl of Object.values(AI_DEFAULT_BASE_URLS)) {
      expect(AiBaseUrlSchema.safeParse(baseUrl).success, baseUrl).toBe(true)
    }
  })

  it('rejects non-strings, remote hosts and oversized values', () => {
    expect(AiBaseUrlSchema.safeParse(11434).success).toBe(false)
    expect(AiBaseUrlSchema.safeParse(null).success).toBe(false)
    expect(AiBaseUrlSchema.safeParse('http://example.com:11434').success).toBe(false)
    expect(AiBaseUrlSchema.safeParse(`http://127.0.0.1:11434/${'a'.repeat(200)}`).success).toBe(
      false,
    )
  })
})

describe('AiModelInfoSchema', () => {
  it('requires the embedding flag and rejects unknown fields', () => {
    const valid = { name: 'qwen3:14b', sizeBytes: 9, embedding: false }
    expect(AiModelInfoSchema.safeParse(valid).success).toBe(true)
    expect(AiModelInfoSchema.safeParse({ ...valid, embedding: true }).success).toBe(true)
    expect(AiModelInfoSchema.safeParse({ name: 'qwen3:14b', sizeBytes: 9 }).success).toBe(false)
    expect(AiModelInfoSchema.safeParse({ ...valid, embedding: 'yes' }).success).toBe(false)
    expect(AiModelInfoSchema.safeParse({ ...valid, family: 'qwen3' }).success).toBe(false)
  })
})

describe('AiModelNameSchema', () => {
  it.each(['qwen3:14b', 'qwen/qwen3.8-27b', 'hf.co/org/repo:Q4_K_M', 'nomic-embed-text', 'a'])(
    'accepts %s',
    (name) => {
      expect(AiModelNameSchema.safeParse(name).success).toBe(true)
    },
  )

  it.each(['', ' qwen3', 'qwen3 14b', '-x', '.x', 'a\nb', 'a"b', 'a{b}', 'x'.repeat(129)])(
    'rejects %j',
    (name) => {
      expect(AiModelNameSchema.safeParse(name).success).toBe(false)
    },
  )
})

describe('AiGenerateSqlRequestSchema', () => {
  const valid = { requestId: 'r1', sessionId: 's1', question: 'How many users are there?' }

  it('accepts a question up to the limit', () => {
    expect(AiGenerateSqlRequestSchema.safeParse(valid).success).toBe(true)
    const longest = { ...valid, question: 'q'.repeat(AI_QUESTION_MAX_LENGTH) }
    expect(AiGenerateSqlRequestSchema.safeParse(longest).success).toBe(true)
  })

  it.each([
    ['a question over the limit', { question: 'q'.repeat(AI_QUESTION_MAX_LENGTH + 1) }],
    ['an empty question', { question: '' }],
    ['a blank question', { question: '  \n\t ' }],
    ['no session', { sessionId: undefined }],
    ['an unknown field (a model override)', { model: 'llama3' }],
    ['an unknown field (a schema supplied by the renderer)', { schema: 'create table t (a int)' }],
  ])('rejects %s', (_name, patch) => {
    expect(AiGenerateSqlRequestSchema.safeParse({ ...valid, ...patch }).success).toBe(false)
  })
})

describe('AiGenerateSqlResultSchema', () => {
  const valid = {
    requestId: 'r1',
    sql: 'SELECT 1',
    risk: 'read',
    statementType: 'query',
    warnings: [],
  }

  it('accepts a result with and without `blocked`', () => {
    expect(AiGenerateSqlResultSchema.safeParse(valid).success).toBe(true)
    expect(AiGenerateSqlResultSchema.safeParse({ ...valid, blocked: true }).success).toBe(true)
  })

  it.each([
    ['an unknown risk', { risk: 'safe' }],
    ['an empty statement', { sql: '' }],
    ['a free-text warning', { warnings: ['The model said hello'] }],
    ['an extra field', { rows: [[1]] }],
  ])('rejects %s', (_name, patch) => {
    expect(AiGenerateSqlResultSchema.safeParse({ ...valid, ...patch }).success).toBe(false)
  })
})

describe('other AI schemas', () => {
  it('accepts a partial list-models request and rejects a remote address', () => {
    expect(AiListModelsRequestSchema.safeParse({}).success).toBe(true)
    expect(AiListModelsRequestSchema.safeParse({ provider: 'lmstudio' }).success).toBe(true)
    expect(AiListModelsRequestSchema.safeParse({ baseUrl: 'http://10.0.0.5:1234' }).success).toBe(
      false,
    )
  })

  it('validates a pull request, its progress and the status', () => {
    expect(
      AiPullModelRequestSchema.safeParse({ requestId: 'r1', model: 'qwen3:14b' }).success,
    ).toBe(true)
    expect(AiPullModelRequestSchema.safeParse({ requestId: 'r1', model: 'a b' }).success).toBe(
      false,
    )
    const progress = {
      requestId: 'r1',
      model: 'qwen3:14b',
      status: 'pulling manifest',
      completed: null,
      total: null,
    }
    expect(AiPullProgressSchema.safeParse(progress).success).toBe(true)
    expect(AiPullProgressSchema.safeParse({ ...progress, completed: -1 }).success).toBe(false)
    expect(
      AiStatusSchema.safeParse({
        providers: [
          {
            provider: 'ollama',
            baseUrl: 'http://127.0.0.1:11434',
            reachable: true,
            version: '0.13.0',
          },
        ],
      }).success,
    ).toBe(true)
  })
})
