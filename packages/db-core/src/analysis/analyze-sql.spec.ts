import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Engine } from '@strata/contracts'
import { describe, expect, it } from 'vitest'
import { analyzeSql, findReadOnlyViolation } from './index'

const allowed = (engine: Engine, sql: string): boolean =>
  analyzeSql(engine, sql).every((statement) => statement.allowedInReadOnly)

const only = (engine: Engine, sql: string) => {
  const [statement, ...rest] = analyzeSql(engine, sql)
  expect(rest).toEqual([])
  if (!statement) throw new Error('no statement')
  return statement
}

describe('analyzeSql: shared behaviour', () => {
  for (const engine of ['postgres', 'sqlite'] as const) {
    describe(engine, () => {
      it('returns one analysis per statement with its text and command', () => {
        const result = analyzeSql(engine, 'select 1; insert into t values (1);')
        expect(result.map((s) => [s.text, s.command, s.type])).toEqual([
          ['select 1', 'SELECT', 'query'],
          ['insert into t values (1)', 'INSERT', 'dml'],
        ])
      })

      it('returns nothing for blank or comment-only documents', () => {
        expect(analyzeSql(engine, '')).toEqual([])
        expect(analyzeSql(engine, '  -- nothing\n /* still nothing */ ;')).toEqual([])
      })

      it('allows plain reads', () => {
        for (const sql of [
          'SELECT 1',
          'select * from t where a = 1',
          'VALUES (1), (2)',
          '(SELECT 1) UNION (SELECT 2)',
          'WITH x AS (SELECT 1) SELECT * FROM x',
          'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10) SELECT * FROM n',
          "SELECT replace('a', 'b', 'c')",
          'SELECT 1.',
        ]) {
          expect(allowed(engine, sql), sql).toBe(true)
        }
      })

      it('allows plain transaction control', () => {
        for (const sql of [
          'BEGIN',
          'BEGIN TRANSACTION',
          'COMMIT',
          'ROLLBACK',
          'END',
          'SAVEPOINT a',
          'RELEASE a',
          'ROLLBACK TO a',
        ]) {
          const statement = only(engine, sql)
          expect(statement.type, sql).toBe('transaction')
          expect(statement.allowedInReadOnly, sql).toBe(true)
        }
      })

      it('rejects every write statement in a read-only profile', () => {
        for (const sql of [
          'INSERT INTO t VALUES (1)',
          'UPDATE t SET a = 1',
          'DELETE FROM t',
          'CREATE TABLE t (a int)',
          'ALTER TABLE t ADD COLUMN b int',
          'DROP TABLE t',
          'REINDEX t',
          'VACUUM',
          'ANALYZE',
          'WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x',
          'WITH x AS (SELECT 1) DELETE FROM t',
          'WITH x AS (SELECT 1) UPDATE t SET a = 1',
        ]) {
          expect(allowed(engine, sql), sql).toBe(false)
        }
      })

      it('rejects unknown, empty-headed and malformed statements (allow-list)', () => {
        for (const sql of ['FROBNICATE t', '\\d t', ')', '1', ';;x', "'select 1'", '"select"']) {
          const analyzed = analyzeSql(engine, sql)
          expect(
            analyzed.some((s) => !s.allowedInReadOnly),
            sql,
          ).toBe(true)
        }
      })

      it('finds the first violation of a document, even hidden after reads', () => {
        const violation = findReadOnlyViolation(
          engine,
          'SELECT 1; SELECT 2; DROP TABLE t; SELECT 3',
        )
        expect(violation?.command).toBe('DROP')
        expect(findReadOnlyViolation(engine, 'SELECT 1; SELECT 2')).toBeUndefined()
      })

      it('ignores keywords inside comments and literals', () => {
        for (const sql of [
          "SELECT 'INSERT INTO t VALUES (1)'",
          "SELECT 'DROP TABLE t; DELETE FROM t'",
          'SELECT 1 -- DELETE FROM t',
          'SELECT 1 /* INSERT INTO t */',
          '/* INSERT INTO t */ SELECT 1',
          '-- DROP TABLE t\nSELECT 1',
          'SELECT "insert", "update", "delete" FROM t',
          "SELECT 'it''s; INSERT INTO t'",
        ]) {
          expect(allowed(engine, sql), sql).toBe(true)
        }
      })

      it('does not let comments hide a write', () => {
        for (const sql of [
          '/* SELECT */ DELETE FROM t',
          'SELECT 1; /* x */ INSERT INTO t VALUES (1)',
          '-- SELECT\nDROP TABLE t',
          'DROP/**/TABLE t',
          'DELETE -- c\n FROM t',
        ]) {
          expect(allowed(engine, sql), sql).toBe(false)
        }
      })

      it('is case insensitive', () => {
        expect(allowed(engine, 'sElEcT 1')).toBe(true)
        expect(allowed(engine, 'dRoP table t')).toBe(false)
        expect(only(engine, 'dElEtE from t').isDestructive).toBe(true)
      })

      describe('destructive detection', () => {
        it('flags DROP and TRUNCATE-like statements', () => {
          expect(only(engine, 'DROP TABLE t').isDestructive).toBe(true)
          expect(only(engine, 'drop index i').isDestructive).toBe(true)
          expect(only(engine, 'ALTER TABLE t DROP COLUMN c').isDestructive).toBe(true)
          expect(only(engine, 'ALTER TABLE t ADD COLUMN c int').isDestructive).toBe(false)
          expect(only(engine, 'CREATE TABLE t (a int)').isDestructive).toBe(false)
        })

        it('flags DELETE and UPDATE without WHERE only', () => {
          expect(only(engine, 'DELETE FROM t').isDestructive).toBe(true)
          expect(only(engine, 'UPDATE t SET a = 1').isDestructive).toBe(true)
          expect(only(engine, 'DELETE FROM t WHERE id = 1').isDestructive).toBe(false)
          expect(only(engine, 'UPDATE t SET a = 1 WHERE id = 1').isDestructive).toBe(false)
          expect(only(engine, "DELETE FROM t WHERE a = 'x'").isDestructive).toBe(false)
        })

        it('does not take a WHERE of a subquery or a literal as the statement filter', () => {
          expect(only(engine, 'DELETE FROM t WHERE id IN (SELECT id FROM u)').isDestructive).toBe(
            false,
          )
          expect(
            only(engine, 'UPDATE t SET a = (SELECT 1 FROM u WHERE u.x = 1)').isDestructive,
          ).toBe(true)
          expect(only(engine, "UPDATE t SET a = 'where'").isDestructive).toBe(true)
          expect(only(engine, 'UPDATE t SET a = 1 -- WHERE x').isDestructive).toBe(true)
        })

        it('looks inside a CTE for the DELETE or UPDATE', () => {
          expect(
            only(engine, 'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d WHERE x = 1')
              .isDestructive,
          ).toBe(true)
          expect(
            only(engine, 'WITH d AS (DELETE FROM t WHERE a = 1 RETURNING *) SELECT * FROM d')
              .isDestructive,
          ).toBe(false)
          expect(only(engine, 'WITH x AS (SELECT 1) DELETE FROM t').isDestructive).toBe(true)
        })

        it('does not treat ON DELETE / ON UPDATE actions or upserts as statements', () => {
          expect(
            only(
              engine,
              'CREATE TABLE c (p int REFERENCES t(id) ON DELETE CASCADE ON UPDATE CASCADE)',
            ).isDestructive,
          ).toBe(false)
          expect(
            only(engine, 'INSERT INTO t VALUES (1) ON CONFLICT (id) DO UPDATE SET a = 2')
              .isDestructive,
          ).toBe(false)
        })

        it('never flags reads', () => {
          expect(only(engine, 'SELECT * FROM t').isDestructive).toBe(false)
        })
      })
    })
  }
})

describe('analyzeSql: postgres', () => {
  const sql = (text: string) => only('postgres', text)

  it('classifies statement types', () => {
    const types: Record<string, string> = {
      'SELECT 1': 'query',
      'SHOW search_path': 'query',
      'TABLE t': 'query',
      'INSERT INTO t VALUES (1)': 'dml',
      'COPY t FROM STDIN': 'dml',
      'CALL p()': 'dml',
      'DO $$ BEGIN END $$': 'dml',
      'EXECUTE stmt': 'dml',
      'TRUNCATE t': 'ddl',
      'GRANT SELECT ON t TO u': 'ddl',
      'COMMENT ON TABLE t IS $$x$$': 'ddl',
      'SET a = 1': 'session',
      'RESET ALL': 'session',
      'ALTER SYSTEM SET x = 1': 'session',
      BEGIN: 'transaction',
      'LISTEN c': 'other',
      'PREPARE p AS SELECT 1': 'other',
    }
    for (const [text, type] of Object.entries(types)) {
      expect(sql(text).type, text).toBe(type)
    }
  })

  it('handles a CTE with DML and RETURNING', () => {
    const statement = sql('WITH ins AS (INSERT INTO t VALUES (1) RETURNING id) SELECT * FROM ins')
    expect(statement).toMatchObject({ type: 'dml', isWrite: true, allowedInReadOnly: false })
    expect(
      sql('WITH u AS (UPDATE t SET a = 1 WHERE id = 1 RETURNING *) SELECT * FROM u').isWrite,
    ).toBe(true)
    expect(
      sql('WITH RECURSIVE r AS (SELECT 1), d AS (DELETE FROM t WHERE 1=1 RETURNING *) SELECT 1')
        .allowedInReadOnly,
    ).toBe(false)
  })

  it('treats SELECT ... INTO as a write', () => {
    for (const text of [
      'SELECT * INTO copy FROM t',
      'SELECT * INTO TEMP copy FROM t',
      'select 1 into x',
      'SELECT 1. INTO x',
      'SELECT * INTO UNLOGGED copy FROM t',
    ]) {
      expect(sql(text), text).toMatchObject({
        type: 'ddl',
        isWrite: true,
        allowedInReadOnly: false,
      })
    }
  })

  it('rejects COPY in every form', () => {
    for (const text of [
      'COPY t FROM STDIN',
      "COPY t FROM '/tmp/x.csv'",
      'COPY t TO STDOUT',
      "COPY (SELECT 1) TO PROGRAM 'rm -rf /'",
      "copy t to '/tmp/x'",
    ]) {
      expect(sql(text).allowedInReadOnly, text).toBe(false)
    }
  })

  it('understands EXPLAIN, and that only ANALYZE runs the statement', () => {
    for (const text of [
      'EXPLAIN SELECT 1',
      'EXPLAIN ANALYZE SELECT 1',
      'EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM t',
      'EXPLAIN (FORMAT JSON) SELECT 1',
      'EXPLAIN INSERT INTO t VALUES (1)',
      'EXPLAIN (COSTS off) DELETE FROM t',
      'EXPLAIN VERBOSE UPDATE t SET a = 1',
    ]) {
      expect(sql(text).allowedInReadOnly, text).toBe(true)
    }
    for (const text of [
      'EXPLAIN ANALYZE INSERT INTO t VALUES (1)',
      'EXPLAIN ANALYSE DELETE FROM t WHERE a = 1',
      'EXPLAIN (ANALYZE) UPDATE t SET a = 1',
      'EXPLAIN (ANALYZE true, VERBOSE) DELETE FROM t',
      'EXPLAIN (ANALYZE false) DELETE FROM t',
      'EXPLAIN ANALYZE VERBOSE INSERT INTO t VALUES (1)',
      'EXPLAIN ANALYZE WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x',
      'EXPLAIN ANALYZE SELECT * INTO x FROM t',
      'EXPLAIN ANALYZE EXECUTE p',
      'EXPLAIN ANALYZE CREATE TABLE x AS SELECT 1',
      'EXPLAIN ANALYZE',
      'EXPLAIN (ANALYZE',
    ]) {
      expect(sql(text).allowedInReadOnly, text).toBe(false)
    }
    expect(sql('EXPLAIN ANALYZE DELETE FROM t').isDestructive).toBe(true)
    expect(sql('EXPLAIN DELETE FROM t').isDestructive).toBe(false)
  })

  it('flags mode changes and rejects them in read-only', () => {
    for (const text of [
      'SET default_transaction_read_only = off',
      'set default_transaction_read_only to off',
      'SET LOCAL transaction_read_only = off',
      'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE',
      'SET TRANSACTION READ WRITE',
      'SET search_path = public',
      'RESET default_transaction_read_only',
      'RESET ALL',
      'DISCARD ALL',
      'ALTER SYSTEM SET default_transaction_read_only = off',
      'BEGIN READ WRITE',
      'BEGIN ISOLATION LEVEL SERIALIZABLE, READ WRITE',
      'START TRANSACTION READ WRITE',
      "SELECT set_config('default_transaction_read_only', 'off', false)",
      "SELECT pg_catalog.set_config('transaction_read_only', 'off', true)",
      "SELECT \"set_config\"('a', 'b', false)",
    ]) {
      const statement = sql(text)
      expect(statement.changesMode, text).toBe(true)
      expect(statement.allowedInReadOnly, text).toBe(false)
    }
  })

  it('keeps read-only transaction control allowed', () => {
    for (const text of [
      'BEGIN READ ONLY',
      'START TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      'COMMIT AND CHAIN',
      'ROLLBACK TO SAVEPOINT a',
    ]) {
      expect(sql(text).allowedInReadOnly, text).toBe(true)
    }
    for (const text of [
      'PREPARE TRANSACTION $$x$$',
      "COMMIT PREPARED 'x'",
      "ROLLBACK PREPARED 'x'",
    ]) {
      expect(sql(text).allowedInReadOnly, text).toBe(false)
    }
  })

  it('rejects reads with side effects', () => {
    for (const text of [
      "SELECT nextval('s')",
      "SELECT setval('s', 1)",
      "SELECT lo_import('/etc/passwd')",
      'SELECT pg_terminate_backend(1)',
      "SELECT dblink_exec('x', 'DROP TABLE t')",
      'SELECT * FROM t FOR UPDATE',
      'SELECT * FROM t FOR NO KEY UPDATE',
      'SELECT * FROM t FOR SHARE',
      'SELECT * FROM t FOR KEY SHARE',
      'SELECT * FROM t FOR UPDATE SKIP LOCKED',
    ]) {
      expect(sql(text).allowedInReadOnly, text).toBe(false)
    }
    expect(sql('SELECT * FROM t FOR UPDATE')).toMatchObject({ type: 'query', isWrite: true })
    expect(sql('SELECT pg_sleep(1)').allowedInReadOnly).toBe(true)
    expect(sql('SELECT nextval FROM seqs').allowedInReadOnly).toBe(true)
    expect(sql("SELECT substring('abc' FROM 1 FOR 2)").allowedInReadOnly).toBe(true)
  })

  it('understands dollar quoting, E strings and nested comments', () => {
    for (const text of [
      'SELECT $$ DROP TABLE t; DELETE FROM t $$',
      'SELECT $tag$ INSERT INTO t $tag$',
      'SELECT $a$ $b$ DROP TABLE t $b$ $a$',
      "SELECT E'it\\'s; DROP TABLE t'",
      "SELECT e'\\\\' , 'INSERT'",
      '/* outer /* inner DROP TABLE t */ still comment INSERT */ SELECT 1',
      'SELECT $1, $2',
      "SELECT U&'d\\0061t\\+000061'",
    ]) {
      expect(allowed('postgres', text), text).toBe(true)
    }
  })

  it('splits on semicolons that dollar quoting does not hide', () => {
    const result = analyzeSql('postgres', 'SELECT $$a;b$$; DROP TABLE t')
    expect(result.map((s) => s.allowedInReadOnly)).toEqual([true, false])
    // A function body is opaque, but the CREATE is what matters.
    expect(
      analyzeSql('postgres', 'CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql'),
    ).toHaveLength(1)
  })

  it('keeps the destructive flags of a documented multi-statement script', () => {
    const flags = analyzeSql(
      'postgres',
      'SELECT 1; DELETE FROM t; UPDATE t SET a = 1 WHERE id = 1; TRUNCATE t; DROP TABLE t',
    ).map((s) => s.isDestructive)
    expect(flags).toEqual([false, true, false, true, true])
  })
})

describe('analyzeSql: sqlite', () => {
  const sql = (text: string) => only('sqlite', text)

  it('classifies statement types', () => {
    const types: Record<string, string> = {
      'SELECT 1': 'query',
      'EXPLAIN SELECT 1': 'query',
      'EXPLAIN QUERY PLAN SELECT * FROM t': 'query',
      'INSERT INTO t VALUES (1)': 'dml',
      'INSERT OR REPLACE INTO t VALUES (1)': 'dml',
      'REPLACE INTO t VALUES (1)': 'dml',
      'UPDATE OR ROLLBACK t SET a = 1': 'dml',
      'CREATE VIEW v AS SELECT 1': 'ddl',
      "ATTACH DATABASE 'x.db' AS x": 'ddl',
      'DETACH x': 'ddl',
      'PRAGMA journal_mode = wal': 'session',
      'BEGIN IMMEDIATE': 'transaction',
    }
    for (const [text, type] of Object.entries(types)) {
      expect(sql(text).type, text).toBe(type)
    }
  })

  it('allows only read PRAGMAs, without a value', () => {
    for (const text of [
      'PRAGMA table_info(t)',
      "PRAGMA table_info('t')",
      'PRAGMA main.table_info(t)',
      'PRAGMA table_xinfo(t)',
      'PRAGMA index_list(t)',
      'PRAGMA foreign_key_list(t)',
      'PRAGMA database_list',
      'PRAGMA user_version',
      'PRAGMA foreign_keys',
      'pragma journal_mode',
      'PRAGMA integrity_check',
      'PRAGMA quick_check(5)',
      'PRAGMA schema.page_count',
    ]) {
      expect(sql(text).allowedInReadOnly, text).toBe(true)
    }
  })

  it('rejects PRAGMA writes and unknown PRAGMAs as mode changes', () => {
    for (const text of [
      'PRAGMA journal_mode = wal',
      'PRAGMA journal_mode(wal)',
      'PRAGMA user_version = 5',
      'PRAGMA user_version(5)',
      'PRAGMA foreign_keys = OFF',
      'PRAGMA query_only = 0',
      'PRAGMA writable_schema = 1',
      'PRAGMA wal_checkpoint(TRUNCATE)',
      'PRAGMA optimize',
      'PRAGMA incremental_vacuum',
      'PRAGMA table_info(t) = 1',
      'PRAGMA main.user_version = 1',
      'PRAGMA',
      'PRAGMA (t)',
    ]) {
      const statement = sql(text)
      expect(statement.changesMode, text).toBe(true)
      expect(statement.allowedInReadOnly, text).toBe(false)
    }
  })

  it('treats a bare REPLACE as a write but the replace() function as a read', () => {
    expect(sql("SELECT replace(a, 'x', 'y') FROM t").allowedInReadOnly).toBe(true)
    expect(sql('WITH x AS (SELECT 1) REPLACE INTO t SELECT * FROM x').allowedInReadOnly).toBe(false)
    expect(sql('WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x')).toMatchObject({
      type: 'dml',
      allowedInReadOnly: false,
    })
  })

  it('rejects BEGIN IMMEDIATE/EXCLUSIVE, which take the write lock', () => {
    for (const text of ['BEGIN IMMEDIATE', 'BEGIN EXCLUSIVE TRANSACTION']) {
      expect(sql(text)).toMatchObject({ changesMode: true, allowedInReadOnly: false })
    }
    expect(sql('BEGIN DEFERRED').allowedInReadOnly).toBe(true)
  })

  it('rejects ATTACH, VACUUM INTO and load_extension()', () => {
    for (const text of [
      "ATTACH DATABASE '/tmp/new.db' AS n",
      "VACUUM INTO '/tmp/copy.db'",
      "SELECT load_extension('x')",
    ]) {
      expect(sql(text).allowedInReadOnly, text).toBe(false)
    }
  })

  it('understands bracket and backtick identifiers and literals', () => {
    for (const text of [
      'SELECT [insert], `delete`, "update" FROM t',
      "SELECT 'DROP TABLE t'",
      "SELECT x'44524F50'",
      'SELECT [a;b] FROM t',
      '/* one /* not nested */ SELECT 1',
    ]) {
      expect(allowed('sqlite', text), text).toBe(true)
    }
  })

  it('classifies a trigger as one DDL statement even though its body contains DML', () => {
    const statement = sql(
      'CREATE TRIGGER trg AFTER DELETE ON t BEGIN DELETE FROM log; UPDATE c SET n = n - 1; END',
    )
    expect(statement).toMatchObject({ type: 'ddl', isWrite: true, allowedInReadOnly: false })
    expect(statement.isDestructive).toBe(false)
  })
})

describe('analysis module boundaries', () => {
  it('imports no database driver or Node built-in, so the renderer can bundle it', () => {
    const files = readdirSync(__dirname).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'),
    )
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const source = readFileSync(join(__dirname, file), 'utf8')
      const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1] ?? '')
      for (const specifier of specifiers) {
        expect(specifier, `${file} imports ${specifier}`).toMatch(
          /^(\.\/|\.\.\/postgres\/statement-splitter$|\.\.\/sqlite\/statement-splitter$|@strata\/contracts$)/,
        )
      }
    }
  })
})
