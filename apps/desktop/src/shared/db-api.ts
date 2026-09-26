import type {
  AiGenerateSqlRequest,
  AiGenerateSqlResult,
  AiListModelsRequest,
  AiModelInfo,
  AiPullModelRequest,
  AiPullProgress,
  AiPullResult,
  AiStatus,
  CancelRequest,
  CancelResult,
  ChunkAck,
  ConnectionProfile,
  ConnectionProfileInput,
  ConnectionProfileUpdate,
  ConnectRequest,
  DeleteProfileRequest,
  DescribeTableRequest,
  DisconnectRequest,
  HistoryChange,
  HistoryDeleteRequest,
  HistoryDeleteResult,
  HistoryListRequest,
  HistoryPage,
  ListSchemasRequest,
  ListTablesRequest,
  PickSqliteFileResult,
  Preferences,
  PreferencesPatch,
  QueryEvent,
  QueryRequest,
  SchemaInfo,
  Session,
  TableDetails,
  TableInfo,
  TestConnectionRequest,
  TestConnectionResult,
  TransactionRequest,
  TransactionResult,
} from '@strata/contracts'
import type { IpcResult } from './ipc-result'

/** Superficie de `window.db`: única definición, compartida por preload y renderer. */
export interface DbApi {
  readonly connections: {
    list(): Promise<IpcResult<ConnectionProfile[]>>
    create(input: ConnectionProfileInput): Promise<IpcResult<ConnectionProfile>>
    update(input: ConnectionProfileUpdate): Promise<IpcResult<ConnectionProfile>>
    delete(request: DeleteProfileRequest): Promise<IpcResult<void>>
    /** Un fallo de la prueba viaja como `{ ok: true, data: { ok: false, error } }`. */
    test(request: TestConnectionRequest): Promise<IpcResult<TestConnectionResult>>
    connect(request: ConnectRequest): Promise<IpcResult<Session>>
    disconnect(request: DisconnectRequest): Promise<IpcResult<void>>
    /** Abre el diálogo nativo en main; solo las rutas devueltas pueden registrarse en perfiles SQLite. */
    pickSqliteFile(): Promise<IpcResult<PickSqliteFileResult>>
  }
  /** Introspección de una sesión abierta; sin sesión activa responde `no_session`. */
  readonly metadata: {
    listSchemas(request: ListSchemasRequest): Promise<IpcResult<SchemaInfo[]>>
    /** Sin `schema`: `main` en SQLite y todos los schemas visibles en PostgreSQL. */
    listTables(request: ListTablesRequest): Promise<IpcResult<TableInfo[]>>
    describeTable(request: DescribeTableRequest): Promise<IpcResult<TableDetails>>
  }
  readonly query: {
    /**
     * Responde en cuanto main acepta la ejecución; el resultado llega por `onEvent`, con exactamente un evento
     * terminal (`done`, `error` o `cancelled`). Los rechazos previos (`no_session`, `busy`, `read_only_violation`,
     * `validation_failed`) llegan aquí como `{ ok: false }` y no emiten eventos. Suscríbete con `onEvent` antes de ejecutar.
     */
    execute(request: QueryRequest): Promise<IpcResult<void>>
    /** Idempotente: cancelar una petición que no existe (o que no es tuya) responde `not_running`. */
    cancel(request: CancelRequest): Promise<IpcResult<CancelResult>>
    /** Repone crédito de ventana (ADR 0010): main deja de consumir del adapter con 4 chunks sin confirmar. */
    ack(ack: ChunkAck): Promise<IpcResult<void>>
    /** Todos los `QueryEvent` de las ejecuciones de esta ventana; devuelve la función de desuscripción. */
    onEvent(callback: (event: QueryEvent) => void): () => void
  }
  /** Transacciones explícitas; devuelven el estado real de la sesión. `busy` mientras hay una consulta en curso. */
  readonly transactions: {
    begin(request: TransactionRequest): Promise<IpcResult<TransactionResult>>
    commit(request: TransactionRequest): Promise<IpcResult<TransactionResult>>
    rollback(request: TransactionRequest): Promise<IpcResult<TransactionResult>>
  }
  /** Preferencias persistentes (`preferences.json`): nunca contienen secretos. */
  readonly preferences: {
    get(): Promise<IpcResult<Preferences>>
    /** Actualización parcial validada; responde con las preferencias completas ya guardadas. Cambiar `history.retentionDays` purga el historial al instante. */
    update(patch: PreferencesPatch): Promise<IpcResult<Preferences>>
  }
  /**
   * Historial local de consultas (ADR 0005): texto SQL y metadatos de cada ejecución, nunca resultados.
   * Se registra solo, desde main, al terminar cada ejecución (salvo `saveToHistory: false` o historial desactivado).
   */
  readonly history: {
    /** Más reciente primero; `{}` lista la primera página. Búsqueda de subcadena sin distinguir mayúsculas, filtros y cursor. */
    list(request: HistoryListRequest): Promise<IpcResult<HistoryPage>>
    delete(request: HistoryDeleteRequest): Promise<IpcResult<HistoryDeleteResult>>
    clear(): Promise<IpcResult<HistoryDeleteResult>>
    /**
     * Cambios del historial (alta, borrado, vaciado, purga) que main empuja solo a la ventana principal, sea
     * cual sea su origen (una ejecución, este renderer, la retención). Devuelve la función de desuscripción.
     */
    onChange(callback: (change: HistoryChange) => void): () => void
  }
  /**
   * Asistente de IA local (ADR 0012): main habla con un servidor de modelos en el bucle local (Ollama, LM Studio…)
   * y el renderer nunca ve la red. Solo salen hacia el modelo el esquema de la conexión activa y la pregunta,
   * jamás filas ni valores. Nada de lo que devuelve se ejecuta: el renderer decide según `risk`.
   */
  readonly ai: {
    /** Detecta servidores en los puertos por defecto (y en el configurado); un servidor apagado no es un error, sale con `reachable: false`. */
    status(): Promise<IpcResult<AiStatus>>
    /** Sin `provider` ni `baseUrl` usa las preferencias; ambos deben ser de bucle local. */
    listModels(request: AiListModelsRequest): Promise<IpcResult<AiModelInfo[]>>
    /**
     * Una sentencia saneada y clasificada (`read`, `write`, `destructive`, `unknown`); `blocked` si la sesión es de
     * solo lectura y no es un `read`. Rechaza con `permission_denied` si el asistente está desactivado en preferencias.
     */
    generateSql(request: AiGenerateSqlRequest): Promise<IpcResult<AiGenerateSqlResult>>
    /** Solo Ollama. Resuelve al terminar la descarga; el avance llega por `onPullProgress`. */
    pullModel(request: AiPullModelRequest): Promise<IpcResult<AiPullResult>>
    /** Cancela una generación o una descarga por su `requestId`; idempotente. */
    cancel(request: CancelRequest): Promise<IpcResult<CancelResult>>
    /** Avance de las descargas (solo a la ventana principal). Devuelve la función de desuscripción. */
    onPullProgress(callback: (progress: AiPullProgress) => void): () => void
  }
}
