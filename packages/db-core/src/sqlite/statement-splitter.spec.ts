import { describe, expect, it } from 'vitest'
import { splitSqliteStatements } from './statement-splitter'

const texts = (sql: string): string[] =>
  splitSqliteStatements(sql).map((statement) => statement.text)

describe('splitSqliteStatements', () => {
  it('splits on semicolons and trims', () => {
    expect(texts('SELECT 1;  SELECT 2 ;\nSELECT 3')).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3'])
  })

  it('ignores empty statements and a trailing semicolon', () => {
    expect(texts(';; SELECT 1;;;')).toEqual(['SELECT 1'])
    expect(splitSqliteStatements('   \n ')).toEqual([])
  })

  it('reports the first keyword in upper case as the command', () => {
    const commands = splitSqliteStatements(
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

  it('keeps semicolons inside double-quoted, backtick and bracket identifiers', () => {
    expect(texts('SELECT "a;b"; SELECT `c;d`; SELECT [e;f] FROM t; SELECT "x"";y"')).toEqual([
      'SELECT "a;b"',
      'SELECT `c;d`',
      'SELECT [e;f] FROM t',
      'SELECT "x"";y"',
    ])
  })

  it('ignores semicolons inside line and block comments', () => {
    const sql = 'SELECT 1 -- not; a split\n; SELECT /* a; b */ 2; /* unterminated ; comment'
    expect(texts(sql)).toEqual(['SELECT 1 -- not; a split', 'SELECT /* a; b */ 2'])
  })

  it('drops statements made only of comments', () => {
    expect(texts('-- nothing\n/* here */ ; SELECT 1; -- trailing')).toEqual(['SELECT 1'])
  })

  it('treats an unterminated string as the rest of the statement', () => {
    expect(texts("SELECT 'abc; SELECT 2")).toEqual(["SELECT 'abc; SELECT 2"])
  })

  it('does not split CREATE TRIGGER bodies', () => {
    const trigger = `CREATE TRIGGER t_ai AFTER INSERT ON t BEGIN
      INSERT INTO log(msg) VALUES ('inserted;');
      UPDATE t SET n = n + 1 WHERE id = NEW.id;
    END`
    expect(texts(`${trigger}; SELECT 1`)).toEqual([trigger, 'SELECT 1'])
  })

  it('handles CASE ... END inside a trigger body and TEMP triggers', () => {
    const trigger = `CREATE TEMP TRIGGER IF NOT EXISTS tr BEFORE UPDATE ON t WHEN NEW.a > 0 BEGIN
      SELECT CASE WHEN NEW.a > 1 THEN RAISE(ABORT, 'no;') ELSE 0 END;
      UPDATE t SET b = CASE WHEN a = 1 THEN 1 ELSE 2 END WHERE id = 1;
    END`
    expect(texts(`${trigger};\nDROP TRIGGER tr;`)).toEqual([trigger, 'DROP TRIGGER tr'])
  })

  it('does not mistake a transaction BEGIN for a trigger body', () => {
    expect(texts('BEGIN; INSERT INTO t VALUES (1); COMMIT;')).toEqual([
      'BEGIN',
      'INSERT INTO t VALUES (1)',
      'COMMIT',
    ])
    expect(texts('CREATE TABLE begin_log(a); SELECT 1')).toEqual([
      'CREATE TABLE begin_log(a)',
      'SELECT 1',
    ])
  })

  it('ignores BEGIN and END that appear as string or comment content in a trigger', () => {
    const trigger = `CREATE TRIGGER x AFTER INSERT ON t /* BEGIN */ BEGIN
      SELECT 'END;'; -- END
    END`
    expect(texts(`${trigger}; SELECT 2`)).toEqual([trigger, 'SELECT 2'])
  })

  it('does not treat a qualified name ending in a keyword as a keyword', () => {
    const trigger = `CREATE TRIGGER x AFTER INSERT ON t BEGIN
      UPDATE t SET a = NEW.end WHERE id = 1;
      SELECT 1;
    END`
    expect(texts(`${trigger}; SELECT 2`)).toEqual([trigger, 'SELECT 2'])
  })
})
