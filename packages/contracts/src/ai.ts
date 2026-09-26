import { z } from 'zod'
import { SessionIdSchema } from './connections'
import { RequestIdSchema } from './queries'

// Local AI assistant (ADR 0012): main talks to a model server on the user's own machine and nothing else.
// Every network address that can reach main through preferences or IPC passes AiBaseUrlSchema first.

export const AI_PROVIDERS = ['ollama', 'lmstudio', 'custom'] as const
export const AiProviderSchema = z.enum(AI_PROVIDERS)
export type AiProvider = z.infer<typeof AiProviderSchema>

// Where each server listens by default; `custom` is any OpenAI-compatible loopback server (llama.cpp's default port).
export const AI_DEFAULT_BASE_URLS = {
  ollama: 'http://127.0.0.1:11434',
  lmstudio: 'http://127.0.0.1:1234',
  custom: 'http://127.0.0.1:8080',
} as const satisfies Record<AiProvider, string>

export const AI_DEFAULT_MODEL = 'qwen3:14b'
export const AI_QUESTION_MAX_LENGTH = 2000
// Ports below this are the well-known services of the machine, never a model server.
export const AI_MIN_PORT = 1024

// Closed grammar instead of "parse and compare": only the three canonical loopback spellings, an explicit port and a plain path.
// Everything else (credentials, query, fragment, other hosts, `127.1`, `0.0.0.0`, IPv4-mapped IPv6, backslashes) fails to match.
const LOOPBACK_BASE_URL =
  /^(https?):\/\/(127\.0\.0\.1|localhost|\[::1\]):([1-9]\d{3,4})((?:\/[A-Za-z0-9._~-]+)*)\/?$/i

/** Canonical form (lower-case scheme and host, no trailing slash), or `undefined` when it is not a permitted loopback address. */
export function normalizeAiBaseUrl(value: string): string | undefined {
  const match = LOOPBACK_BASE_URL.exec(value)
  if (!match) return undefined
  const [, scheme = '', host = '', port = '', path = ''] = match
  const portNumber = Number(port)
  if (portNumber < AI_MIN_PORT || portNumber > 65535) return undefined
  if (path.split('/').some((segment) => /^\.+$/.test(segment))) return undefined
  return `${scheme.toLowerCase()}://${host.toLowerCase()}:${portNumber}${path}`
}

export const AiBaseUrlSchema = z
  .string()
  .max(200)
  .refine((value) => normalizeAiBaseUrl(value) !== undefined, {
    message: 'Must be an http(s) loopback address with an explicit port',
  })
export type AiBaseUrl = z.infer<typeof AiBaseUrlSchema>

// Names as Ollama, LM Studio and llama.cpp write them (`qwen3:14b`, `qwen/qwen3.8-27b`, `hf.co/org/repo:Q4_K_M`).
// They only ever travel inside a JSON body, never in a URL.
export const AiModelNameSchema = z
  .string()
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/)
export type AiModelName = z.infer<typeof AiModelNameSchema>

export const AiQuestionSchema = z
  .string()
  .max(AI_QUESTION_MAX_LENGTH)
  .refine((question) => question.trim().length > 0, { message: 'The question must not be blank' })

export const AiProviderStatusSchema = z.strictObject({
  provider: AiProviderSchema,
  baseUrl: AiBaseUrlSchema,
  reachable: z.boolean(),
  version: z.string().max(64).nullable(),
})
export type AiProviderStatus = z.infer<typeof AiProviderStatusSchema>

// The default Ollama and LM Studio ports plus the configured server when it is somewhere else.
export const AiStatusSchema = z.strictObject({ providers: z.array(AiProviderStatusSchema).max(8) })
export type AiStatus = z.infer<typeof AiStatusSchema>

// Both optional: what is omitted comes from the saved preferences, so the settings screen can look at a server before saving it.
export const AiListModelsRequestSchema = z.strictObject({
  provider: AiProviderSchema.optional(),
  baseUrl: AiBaseUrlSchema.optional(),
})
export type AiListModelsRequest = z.infer<typeof AiListModelsRequestSchema>

export const AiModelInfoSchema = z.strictObject({
  name: AiModelNameSchema,
  sizeBytes: z.int().nonnegative().nullable(),
  // Embedding models (nomic-embed-text...) cannot generate SQL: settings leaves them out of the model picker.
  embedding: z.boolean(),
})
export type AiModelInfo = z.infer<typeof AiModelInfoSchema>

export const AiGenerateSqlRequestSchema = z.strictObject({
  requestId: RequestIdSchema,
  sessionId: SessionIdSchema,
  question: AiQuestionSchema,
})
export type AiGenerateSqlRequest = z.infer<typeof AiGenerateSqlRequestSchema>

// How dangerous the generated statement is (ADR 0012, from ADR 0004): only `read` may run without asking.
// `unknown` is everything else: transaction control, session settings, statements the analyzer does not recognize.
export const AI_SQL_RISKS = ['read', 'write', 'destructive', 'unknown'] as const
export const AiSqlRiskSchema = z.enum(AI_SQL_RISKS)
export type AiSqlRisk = z.infer<typeof AiSqlRiskSchema>

export const AiSqlStatementTypeSchema = z.enum([
  'query',
  'dml',
  'ddl',
  'transaction',
  'session',
  'other',
])
export type AiSqlStatementType = z.infer<typeof AiSqlStatementTypeSchema>

// Codes and not sentences: the text shown is the renderer's, and nothing the model wrote reaches the UI as a message.
export const AI_WARNINGS = [
  'schema_truncated',
  'reasoning_removed',
  'formatting_removed',
  'read_only_blocked',
] as const
export const AiWarningSchema = z.enum(AI_WARNINGS)
export type AiWarning = z.infer<typeof AiWarningSchema>

export const AI_SQL_MAX_LENGTH = 20_000

export const AiGenerateSqlResultSchema = z.strictObject({
  requestId: RequestIdSchema,
  sql: z.string().min(1).max(AI_SQL_MAX_LENGTH),
  risk: AiSqlRiskSchema,
  statementType: AiSqlStatementTypeSchema,
  warnings: z.array(AiWarningSchema).max(AI_WARNINGS.length),
  // Present (true) only when the session is read-only and the statement is not a read: main would reject it anyway.
  blocked: z.boolean().optional(),
})
export type AiGenerateSqlResult = z.infer<typeof AiGenerateSqlResultSchema>

export const AiPullModelRequestSchema = z.strictObject({
  requestId: RequestIdSchema,
  model: AiModelNameSchema,
})
export type AiPullModelRequest = z.infer<typeof AiPullModelRequestSchema>

export const AiPullResultSchema = z.strictObject({
  requestId: RequestIdSchema,
  model: AiModelNameSchema,
})
export type AiPullResult = z.infer<typeof AiPullResultSchema>

// main -> renderer while a download runs. `total` is null until the server reports it (manifest steps have no size).
export const AiPullProgressSchema = z.strictObject({
  requestId: RequestIdSchema,
  model: AiModelNameSchema,
  status: z.string().min(1).max(100),
  completed: z.int().nonnegative().nullable(),
  total: z.int().nonnegative().nullable(),
})
export type AiPullProgress = z.infer<typeof AiPullProgressSchema>
