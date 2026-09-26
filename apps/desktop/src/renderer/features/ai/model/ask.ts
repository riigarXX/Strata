import type {
  AiGenerateSqlResult,
  AiSqlRisk,
  AiWarning,
  NormalizedError,
  TransactionState,
} from '@strata/contracts'

/** Como se llama cada riesgo en pantalla: el glifo acompaña siempre al texto (nunca solo color). */
export const RISK_PRESENTATION: Record<AiSqlRisk, { label: string; glyph: string }> = {
  read: { label: 'Lectura', glyph: '●' },
  write: { label: 'Escritura', glyph: '✎' },
  destructive: { label: 'Destructiva', glyph: '⚠' },
  unknown: { label: 'Desconocida', glyph: '?' },
}

export const WARNING_MESSAGES: Record<Exclude<AiWarning, 'read_only_blocked'>, string> = {
  schema_truncated:
    'El esquema era muy grande y se envió recortado: puede que falte alguna tabla en la consulta.',
  reasoning_removed: 'Se descartó el razonamiento que el modelo escribió antes de la consulta.',
  formatting_removed:
    'Se limpió el formato de la respuesta (vallas de código o texto alrededor de la consulta).',
}

/** Avisos que se listan: `read_only_blocked` ya tiene su propio mensaje de bloqueo. */
export function visibleWarnings(warnings: readonly AiWarning[]): string[] {
  return warnings.flatMap((warning) =>
    warning === 'read_only_blocked' ? [] : [WARNING_MESSAGES[warning]],
  )
}

export const BLOCKED_MESSAGE =
  'Esta conexión es de solo lectura y la consulta escribiría o cambiaría datos: el servidor la rechazará si intentas ejecutarla. Reformula la pregunta como una consulta de lectura.'

/**
 * Por qué una consulta se ejecuta sola o se queda esperando al usuario. Falla cerrado: ejecuta solo si todo
 * lo comprobable dice que es seguro (ADR 0012).
 */
export type AutoRunDecision =
  { run: true } | { run: false; reason: 'blocked' | 'risk' | 'transaction' | 'busy' }

export interface AutoRunInput {
  result: Pick<AiGenerateSqlResult, 'risk' | 'statementType' | 'blocked'>
  /** Estado de transacción de la sesión de la pestaña. */
  transaction: TransactionState
  /** Otra pestaña ejecuta ahora mismo en esta sesión (main admite una ejecución activa por sesión). */
  sessionBusy: boolean
}

/**
 * Solo una consulta `read` sin bloquear, fuera de cualquier transacción del usuario (abierta o abortada), en una
 * sesión libre. En PostgreSQL la ejecución va además en una transacción READ ONLY que main revierte siempre, porque
 * un SELECT puede llamar a funciones con efectos (`enforceReadOnly` en la petición); lo que no cumpla algo de esto
 * solo se abre en la pestaña, y ejecutarlo es decisión explícita del usuario.
 */
export function decideAutoRun({ result, transaction, sessionBusy }: AutoRunInput): AutoRunDecision {
  if (result.blocked === true) return { run: false, reason: 'blocked' }
  if (result.risk !== 'read' || result.statementType !== 'query') {
    return { run: false, reason: 'risk' }
  }
  if (transaction !== 'none') return { run: false, reason: 'transaction' }
  if (sessionBusy) return { run: false, reason: 'busy' }
  return { run: true }
}

const RISK_NOT_RUN: Record<Exclude<AiSqlRisk, 'read'>, string> = {
  write:
    'No se ha ejecutado: la consulta modifica datos. Revísala en la pestaña nueva y pulsa «Ejecutar» si es lo que quieres.',
  destructive:
    'No se ha ejecutado: la consulta es destructiva (borra datos o cambia la estructura). Revísala en la pestaña nueva; al ejecutarla se pedirá confirmación.',
  unknown:
    'No se ha ejecutado: no se ha podido clasificar la sentencia. Revísala en la pestaña nueva antes de ejecutarla.',
}

export function describeAutoRun(
  decision: AutoRunDecision,
  risk: AiSqlRisk,
  tabTitle: string,
): string {
  if (decision.run) {
    return `Consulta de solo lectura: se ha ejecutado en la pestaña «${tabTitle}».`
  }
  switch (decision.reason) {
    case 'blocked':
      return `Abierta en la pestaña «${tabTitle}», pero no se puede ejecutar en esta conexión.`
    case 'risk':
      return risk === 'read' ? RISK_NOT_RUN.unknown : RISK_NOT_RUN[risk]
    case 'transaction':
      return 'No se ha ejecutado: hay una transacción abierta en esta conexión y por seguridad no se ejecuta nada solo dentro de ella. Revisa la consulta y pulsa «Ejecutar».'
    case 'busy':
      return 'No se ha ejecutado: hay otra consulta en curso en esta conexión. Cuando termine, pulsa «Ejecutar» en la pestaña nueva.'
  }
}

const TITLE_PREFIX = 'IA: '
const TITLE_MAX_QUESTION = 28

/** «IA: ¿cuántos pedidos hay por cliente?» abreviado; la pregunta solo se usa de título, nunca se guarda. */
export function tabTitleFor(question: string): string {
  const flat = question.trim().replace(/\s+/g, ' ')
  const short =
    flat.length > TITLE_MAX_QUESTION ? `${flat.slice(0, TITLE_MAX_QUESTION - 1).trimEnd()}…` : flat
  return `${TITLE_PREFIX}${short}`
}

export type AskPrerequisite = 'disabled' | 'no-tab' | 'no-session'

export const PREREQUISITE_MESSAGES: Record<AskPrerequisite, { title: string; detail: string }> = {
  disabled: {
    title: 'La IA local está desactivada',
    detail:
      'Actívala en los ajustes para preguntar en lenguaje natural. Al modelo solo le llegan el esquema y tu pregunta, y todo ocurre en este equipo.',
  },
  'no-tab': {
    title: 'No hay ninguna pestaña abierta',
    detail: 'Abre una pestaña SQL conectada a una base de datos y vuelve a preguntar.',
  },
  'no-session': {
    title: 'La pestaña activa no tiene una conexión abierta',
    detail: 'Conecta una base de datos en esta pestaña: la pregunta se hace sobre su esquema.',
  },
}

export interface AskErrorPresentation {
  message: string
  /** El remedio está en los ajustes de IA. */
  settings: boolean
}

// main envía frases fijas en inglés: solo esta distingue «varias sentencias» del resto de `validation_failed`.
const MULTIPLE_STATEMENTS = /more than one/i

/** Mensajes propios de la interfaz según el código: lo que diga main o el servidor del modelo no se muestra. */
export function describeAskError(error: NormalizedError): AskErrorPresentation {
  switch (error.code) {
    case 'permission_denied':
      return { message: 'La IA local está desactivada. Actívala en los ajustes.', settings: true }
    case 'connection_failed':
      return {
        message:
          'No se pudo conectar con el servidor de modelos. Comprueba que Ollama o LM Studio está en marcha y que la dirección de los ajustes es correcta.',
        settings: true,
      }
    case 'not_found':
      return {
        message:
          'El modelo elegido no está instalado en el servidor. Descárgalo o elige otro en los ajustes.',
        settings: true,
      }
    case 'timeout':
      return {
        message:
          'El modelo tardó demasiado en responder. La primera pregunta puede tardar mientras se carga en memoria: vuelve a intentarlo.',
        settings: false,
      }
    case 'cancelled':
      return { message: 'Generación cancelada.', settings: false }
    case 'busy':
      return {
        message:
          'El asistente está atendiendo otra pregunta. Espera un momento y vuelve a intentarlo.',
        settings: false,
      }
    case 'no_session':
      return {
        message: 'La conexión de la pestaña ya no está abierta. Vuelve a conectarla.',
        settings: false,
      }
    case 'cannot_answer':
      return {
        message:
          'El modelo no ha encontrado cómo responder con este esquema; reformula la pregunta o comprueba la conexión.',
        settings: false,
      }
    case 'transaction_aborted':
      return {
        message:
          'Hay una transacción abortada en esta conexión: pulsa «Revertir» o escribe ROLLBACK antes de preguntar.',
        settings: false,
      }
    case 'validation_failed':
      return {
        message: MULTIPLE_STATEMENTS.test(error.message)
          ? 'El modelo propuso varias sentencias y Strata solo admite una. Pide una única consulta.'
          : 'El modelo no devolvió una consulta SQL válida. Reformula la pregunta o inténtalo de nuevo.',
        settings: false,
      }
    default:
      return { message: 'Ha ocurrido un error inesperado. Vuelve a intentarlo.', settings: false }
  }
}

/** Anuncio sobrio para lectores de pantalla al terminar de generar. */
export function describeReady(
  risk: AiSqlRisk,
  decision: AutoRunDecision,
  tabTitle: string,
): string {
  const label = RISK_PRESENTATION[risk].label.toLowerCase()
  return `Consulta lista, riesgo: ${label}. ${describeAutoRun(decision, risk, tabTitle)}`
}
