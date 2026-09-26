// Se ejecuta con el Node de Electron (ELECTRON_RUN_AS_NODE=1): better-sqlite3 está compilado para su ABI (ADR 0007),
// así que el proceso de Playwright, con el Node del sistema, no puede cargarlo.
import Database from 'better-sqlite3'

const [target] = process.argv.slice(2)
if (!target) throw new Error('Uso: create-fixture-db.mjs <ruta-del-archivo>')

const db = new Database(target)
db.exec(`
  CREATE TABLE people (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    age INTEGER,
    score REAL,
    note TEXT
  );
  INSERT INTO people (id, name, age, score, note) VALUES
    (1, 'Ada', 36, 9.5, 'first'),
    (2, 'Grace', 45, 8.25, NULL),
    (3, 'Linus', NULL, 7, 'kernel');
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    owner_id INTEGER REFERENCES people(id)
  );
  INSERT INTO projects (id, title, owner_id) VALUES (1, 'Analytical Engine', 1);
`)
db.close()
