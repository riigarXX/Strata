import { describe, expect, it } from 'vitest'
import { splitPostgresStatements } from './statement-splitter'

const texts = (sql: string): string[] =>
  splitPostgresStatements(sql).map((statement) => statement.text)

describe('splitPostgresStatements', () => {
  it('splits on semicolons and trims', () => {
    expect(texts('SELECT 1;  SELECT 2 ;\nSELECT 3')).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3'])
  })

  it('ignores empty statements and a trailing semicolon', () => {
    expect(texts(';; SELECT 1;;;')).toEqual(['SELECT 1'])
    expect(splitPostgresStatements('   \n ')).toEqual([])
  })

  it('reports the first keyword in upper case as the command', () => {
    const commands = splitPostgresStatements(
      'select 1; Insert into t values (1); -- c\n  create table x(a)',
    ).map((statement) => statement.command)
    expect(commands).toEqual(['SELECT', 'INSERT', 'CREATE'])
  })

  it('keeps semicolons inside single-quoted strings, with doubled-quote escapes', () => {
    expect(texts("INSERT INTO t VALUES ('a;b'); SELECT 'it''s; fine'")).toEqual([
      "INSERT INTO t VALUES ('a;b')",
      "SELECT 'it''s; fine'",
    ])
  })

  it('treats a backslash as an ordinary character in standard strings', () => {
    expect(texts("SELECT 'a\\'; SELECT 2")).toEqual(["SELECT 'a\\'", 'SELECT 2'])
  })

  it('honors backslash escapes inside E strings', () => {
    expect(texts("SELECT E'it\\'s; still'; SELECT 2")).toEqual([
      "SELECT E'it\\'s; still'",
      'SELECT 2',
    ])
    expect(texts("SELECT e'a\\\\'; SELECT 2")).toEqual(["SELECT e'a\\\\'", 'SELECT 2'])
    expect(texts("SELECT E'it''s; ok'; SELECT 2")).toEqual(["SELECT E'it''s; ok'", 'SELECT 2'])
  })

  it('does not take an identifier ending in e for an E string prefix', () => {
    expect(texts("SELECT name'x\\'; SELECT 2")).toEqual(["SELECT name'x\\'", 'SELECT 2'])
  })

  it('keeps semicolons inside double-quoted identifiers, with doubled-quote escapes', () => {
    expect(texts('SELECT "a;b"; SELECT "x"";y"')).toEqual(['SELECT "a;b"', 'SELECT "x"";y"'])
  })

  it('handles unicode-escaped strings and identifiers like ordinary quoted ones', () => {
    expect(texts('SELECT U&\'d\\0061t;a\'; SELECT U&"x;y"')).toEqual([
      "SELECT U&'d\\0061t;a'",
      'SELECT U&"x;y"',
    ])
  })

  it('ignores semicolons inside line comments', () => {
    expect(texts('SELECT 1 -- not; a split\n; SELECT 2')).toEqual([
      'SELECT 1 -- not; a split',
      'SELECT 2',
    ])
  })

  it('nests block comments', () => {
    const sql = 'SELECT /* a; /* b; */ still; a comment */ 1; SELECT 2'
    expect(texts(sql)).toEqual(['SELECT /* a; /* b; */ still; a comment */ 1', 'SELECT 2'])
  })

  it('treats an unterminated block comment as the rest of the document', () => {
    expect(texts('SELECT 1; /* open ; SELECT 2')).toEqual(['SELECT 1'])
  })

  it('drops statements made only of comments', () => {
    expect(texts('-- nothing\n/* here */ ; SELECT 1; -- trailing')).toEqual(['SELECT 1'])
  })

  it('treats an unterminated string as the rest of the statement', () => {
    expect(texts("SELECT 'abc; SELECT 2")).toEqual(["SELECT 'abc; SELECT 2"])
  })

  it('keeps dollar-quoted bodies intact', () => {
    const fn = `CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$
      BEGIN
        -- a; comment
        RETURN 1;
      END
    $$`
    expect(texts(`${fn}; SELECT f()`)).toEqual([fn, 'SELECT f()'])
  })

  it('matches dollar-quote tags exactly, so a shorter delimiter inside does not close the body', () => {
    const fn = `DO $body$ BEGIN PERFORM $$ inner; $$; RAISE NOTICE 'x;y'; END $body$`
    expect(texts(`${fn}; SELECT 2`)).toEqual([fn, 'SELECT 2'])
  })

  it('accepts an empty tag, tags with digits and unicode tags', () => {
    expect(texts('SELECT $a1$;$a1$; SELECT $é$;$é$')).toEqual([
      'SELECT $a1$;$a1$',
      'SELECT $é$;$é$',
    ])
  })

  it('does not take positional parameters for dollar quoting', () => {
    expect(texts('SELECT $1; SELECT $2, $3')).toEqual(['SELECT $1', 'SELECT $2, $3'])
  })

  it('does not take a dollar sign inside an identifier for a dollar quote', () => {
    expect(texts('SELECT a$b$c FROM t; SELECT 2')).toEqual(['SELECT a$b$c FROM t', 'SELECT 2'])
  })

  it('treats an unterminated dollar quote as the rest of the statement', () => {
    expect(texts('SELECT $$ open; SELECT 2')).toEqual(['SELECT $$ open; SELECT 2'])
  })

  it('ignores quotes, comment markers and semicolons that appear inside a dollar-quoted body', () => {
    expect(texts(`SELECT $$ it's -- /* ; $$; SELECT 2`)).toEqual([
      `SELECT $$ it's -- /* ; $$`,
      'SELECT 2',
    ])
  })

  it('does not split BEGIN ATOMIC function bodies', () => {
    const fn = `CREATE FUNCTION add(a int, b int) RETURNS int LANGUAGE sql
      BEGIN ATOMIC
        SELECT CASE WHEN a > b THEN a; ELSE b END;
        SELECT a + b;
      END`
    expect(texts(`${fn}; SELECT 1`)).toEqual([fn, 'SELECT 1'])
  })

  it('does not mistake a transaction BEGIN for a function body', () => {
    expect(texts('BEGIN; INSERT INTO t VALUES (1); COMMIT;')).toEqual([
      'BEGIN',
      'INSERT INTO t VALUES (1)',
      'COMMIT',
    ])
    expect(texts('BEGIN ATOMIC; SELECT 1')).toEqual(['BEGIN ATOMIC', 'SELECT 1'])
  })

  it('keeps the command of the statement, not of a leading comment', () => {
    expect(splitPostgresStatements('/* note */ -- more\n  delete from t')[0]?.command).toBe(
      'DELETE',
    )
  })
})
