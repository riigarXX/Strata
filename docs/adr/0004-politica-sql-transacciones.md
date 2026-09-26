# ADR 0004: Política de consultas múltiples, DDL, DML y transacciones

- **Estado:** Aceptado
- **Fecha:** 2026-09-16

## Contexto

El editor SQL permite ejecutar la selección actual o el documento completo, que puede contener una o varias sentencias, incluyendo DDL y DML. Es necesario fijar la política antes de definir el contrato `QueryRequest`/`QueryEvent` de `packages/contracts` y el comportamiento de `db-core`.

## Decisión

- **Todo tipo de sentencia está permitido por defecto**: SELECT, DML (INSERT/UPDATE/DELETE) y DDL (CREATE/ALTER/DROP...).
- **Confirmación explícita obligatoria** antes de ejecutar operaciones reconocidas como destructivas o de alto impacto: `DROP`, `TRUNCATE`, `DELETE`/`UPDATE` sin cláusula `WHERE`, y cualquier operación mientras el perfil esté marcado `read-only` (en cuyo caso se bloquea, no solo se confirma).
- **Perfil `read-only`**: cuando el perfil de conexión está marcado como read-only, cualquier sentencia de escritura (DML/DDL) se rechaza antes de llegar al adapter, con un error claro; no se pide confirmación, se bloquea.
- **Consultas múltiples en un mismo documento**: se ejecutan en orden secuencial dentro de la misma sesión; cada sentencia emite su propio `QueryEvent` (duración, filas afectadas, notices) para que el grid y el panel de mensajes puedan mostrarlas de forma diferenciada.
- **Transacciones**: explícitas mediante `begin`/`commit`/`rollback` expuestos por `db-core`, nunca implícitas ni automáticas por parte de la aplicación. El estado de transacción activa debe ser visible en la barra de estado en todo momento.

### Nota: transacción abortada (PostgreSQL)

Tras un error dentro de una transacción, PostgreSQL la deja *abortada* (`Session.transaction === 'aborted'`) y rechaza toda sentencia salvo las que la cierran, con «current transaction is aborted, commands ignored until end of transaction block». La política del cliente es una sola:

- Mientras la transacción está abortada, «Ejecutar» y «Ejecutar todo» solo envían al servidor un texto cuya **primera sentencia** sea de cierre: `ROLLBACK`, `ROLLBACK TO [SAVEPOINT]`, `ABORT`, `END` o `COMMIT` (en estado abortado, `COMMIT` y `END` equivalen a `ROLLBACK`). Tras esa primera sentencia la transacción ya no está abortada y el resto del texto sigue las reglas de siempre, igual que en el servidor. Se reconoce con `analyzeSql` (`type === 'transaction'`), de modo que `ROLLBACK PREPARED` o un `SELECT` que mencione «rollback» no pasan.
- Cualquier otro texto se rechaza en el renderer, sin llegar al servidor, con el mensaje «No se puede ejecutar: la transacción está abortada y solo admite ROLLBACK. Escríbelo o pulsa «Revertir».» (aparece en el indicador de ejecución, que es una región `role="status"`).
- Los botones «Ejecutar» y «Ejecutar todo» **no** se marcan `aria-disabled`: el editor no es un dato reactivo del modelo de disponibilidad (la selección cambia sin eventos) y con un `ROLLBACK` escrito sí funcionan, así que declararlos deshabilitados sería falso. En su lugar, su descripción accesible (`aria-describedby`) es el aviso fijo de la barra, «Transacción abortada: solo puedes ejecutar ROLLBACK o pulsar «Revertir».», que se anuncia una sola vez al aparecer. «Iniciar» y «Confirmar» siguen `aria-disabled` con su motivo; «Revertir» está habilitado.
- Se descartó bloquear «Ejecutar» del todo (ofrecer solo «Revertir»): impediría `ROLLBACK TO SAVEPOINT`, la única forma de recuperarse de un error sin perder el resto de la transacción.
- SQLite no tiene este estado: un error dentro de una transacción no la aborta (el adaptador nunca la marca `aborted`), así que la política no le afecta y cualquier sentencia se sigue ejecutando.

## Consecuencias

- `QueryRequest` en `packages/contracts` **no** incluye el modo read-only del perfil: lo decide main a partir de la `Session`/perfil, nunca el renderer (que no es de confianza). La única marca que puede llevar es `enforceReadOnly: true` ([ADR 0012](0012-ia-local.md)), **solo restrictiva**: pide a main ejecutar como pura lectura (lista de permitidos del modo read-only y solo consultas; en PostgreSQL, dentro de `BEGIN READ ONLY` con `ROLLBACK` siempre y solo con la sesión sin transacción) y no puede relajar nada; `false` no es un valor válido. La usa la ejecución automática del SQL generado por la IA local. `QueryEvent` representa tanto el resultado de una sentencia individual (`statement_done`) como la agregación de la petición (`done`).
- La UI del editor necesita un diálogo de confirmación reutilizable para operaciones destructivas, con detección heurística de patrones peligrosos (`DROP`, `TRUNCATE`, `DELETE`/`UPDATE` sin `WHERE`) antes de enviar la solicitud a main.
- La detección de "destructivo" es una heurística de UX, no un mecanismo de seguridad: el modo read-only del perfil es la única barrera fiable, y debe aplicarse en el proceso main (no solo en el renderer) para que no pueda evitarse.
- `db-core` debe exponer el estado de transacción (`none` | `active`) como parte de la sesión, consultable en cualquier momento.

## Referencias

- `PLAN_BBDD_CLI.md`, sección 5 (`DatabaseAdapter`, `begin`/`commit`/`rollback`), sección 8 (Editor SQL), sección 9 (Seguridad).
