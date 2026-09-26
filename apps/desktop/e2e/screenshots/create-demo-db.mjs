// Se ejecuta con el Node de Electron (ELECTRON_RUN_AS_NODE=1), como create-fixture-db.mjs.
// Base de demostración de una librería: datos ficticios y deterministas (PRNG con semilla) para las capturas del README.
import Database from 'better-sqlite3'

const [target] = process.argv.slice(2)
if (!target) throw new Error('Uso: create-demo-db.mjs <ruta-del-archivo>')

let seed = 20240607
const random = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296
  return seed / 4294967296
}
const pick = (items) => items[Math.floor(random() * items.length)]
const between = (min, max) => min + Math.floor(random() * (max - min + 1))

const categorias = [
  'Novela',
  'Ensayo',
  'Poesía',
  'Ciencia',
  'Historia',
  'Infantil',
  'Cómic',
  'Viajes',
]
const titulos = [
  'El faro de las mareas',
  'Cartas desde Lisboa',
  'La biblioteca de arena',
  'Un verano en Cádiz',
  'Los cien inviernos',
  'Mapa de la memoria',
  'El jardín de los relojes',
  'Cuaderno de bitácora',
  'La ciudad sumergida',
  'Ecos de un volcán',
  'Breve historia del silencio',
  'Las estrellas de Sevilla',
  'El cartógrafo distraído',
  'Ríos de tinta',
  'La orquesta del alba',
  'Noches en el Retiro',
  'Átomos y poemas',
  'El sastre de Toledo',
  'Manual del viajero lento',
  'La última linterna',
  'Trenes hacia el norte',
  'Diario de un naturalista',
  'El árbol que hablaba',
  'Puentes de Praga',
  'La isla de los gatos',
  'Geometría del asombro',
  'Crónica del mar Cantábrico',
  'El taller de Ana',
  'Sombras en la Alhambra',
  'Astronomía para curiosos',
]
const autores = [
  'Lucía Marín',
  'Andrés Cabello',
  'Elena Roldán',
  'Mateo Quintana',
  'Irene Solís',
  'Pablo Ferrer',
  'Carmen Ortiz',
  'Javier Lasa',
  'Marta Bellido',
  'Sergio Arana',
  'Noelia Pardo',
  'Hugo Escribano',
]
const nombres = [
  'Sofía',
  'Daniel',
  'Valeria',
  'Adrián',
  'Paula',
  'Álvaro',
  'Claudia',
  'Iván',
  'Nerea',
  'Rubén',
  'Alba',
  'Óscar',
  'Laura',
  'Diego',
  'Marina',
  'Jorge',
]
const apellidos = [
  'García',
  'Martínez',
  'López',
  'Sánchez',
  'Pérez',
  'Gómez',
  'Ruiz',
  'Hernández',
  'Díaz',
  'Moreno',
  'Muñoz',
  'Álvarez',
  'Romero',
  'Navarro',
  'Torres',
]
const ciudades = [
  'Madrid',
  'Barcelona',
  'Valencia',
  'Sevilla',
  'Bilbao',
  'Zaragoza',
  'Málaga',
  'Granada',
  'Valladolid',
  'A Coruña',
]
const estados = ['entregado', 'entregado', 'entregado', 'enviado', 'preparando', 'cancelado']

const db = new Database(target)
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE categorias (
    id INTEGER PRIMARY KEY,
    nombre TEXT NOT NULL UNIQUE
  );
  CREATE TABLE libros (
    id INTEGER PRIMARY KEY,
    titulo TEXT NOT NULL,
    autor TEXT NOT NULL,
    categoria_id INTEGER NOT NULL REFERENCES categorias(id),
    precio REAL NOT NULL,
    stock INTEGER NOT NULL DEFAULT 0,
    publicado TEXT NOT NULL
  );
  CREATE TABLE clientes (
    id INTEGER PRIMARY KEY,
    nombre TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    ciudad TEXT NOT NULL,
    alta TEXT NOT NULL
  );
  CREATE TABLE pedidos (
    id INTEGER PRIMARY KEY,
    cliente_id INTEGER NOT NULL REFERENCES clientes(id),
    fecha TEXT NOT NULL,
    estado TEXT NOT NULL
  );
  CREATE TABLE lineas_pedido (
    id INTEGER PRIMARY KEY,
    pedido_id INTEGER NOT NULL REFERENCES pedidos(id),
    libro_id INTEGER NOT NULL REFERENCES libros(id),
    cantidad INTEGER NOT NULL,
    precio_unitario REAL NOT NULL
  );
  CREATE INDEX idx_pedidos_cliente ON pedidos(cliente_id);
  CREATE INDEX idx_lineas_pedido ON lineas_pedido(pedido_id);
`)

const date = (year, month, day) =>
  `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`

const insertCategoria = db.prepare('INSERT INTO categorias (nombre) VALUES (?)')
categorias.forEach((nombre) => insertCategoria.run(nombre))

const insertLibro = db.prepare(
  'INSERT INTO libros (titulo, autor, categoria_id, precio, stock, publicado) VALUES (?, ?, ?, ?, ?, ?)',
)
const libros = []
for (let i = 0; i < 48; i++) {
  const precio = between(895, 2990) / 100
  libros.push(precio)
  insertLibro.run(
    titulos[i % titulos.length] + (i >= titulos.length ? ' (2.ª ed.)' : ''),
    pick(autores),
    between(1, categorias.length),
    precio,
    between(0, 60),
    date(between(2012, 2025), between(1, 12), between(1, 28)),
  )
}

const insertCliente = db.prepare(
  'INSERT INTO clientes (nombre, email, ciudad, alta) VALUES (?, ?, ?, ?)',
)
const emails = new Set()
for (let i = 0; i < 40; i++) {
  const nombre = pick(nombres)
  const apellido = pick(apellidos)
  let email = `${nombre}.${apellido}`.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  email = `${email}${i}@ejemplo.es`
  emails.add(email)
  insertCliente.run(
    `${nombre} ${apellido}`,
    email,
    pick(ciudades),
    date(between(2021, 2025), between(1, 12), between(1, 28)),
  )
}

const insertPedido = db.prepare('INSERT INTO pedidos (cliente_id, fecha, estado) VALUES (?, ?, ?)')
const insertLinea = db.prepare(
  'INSERT INTO lineas_pedido (pedido_id, libro_id, cantidad, precio_unitario) VALUES (?, ?, ?, ?)',
)
for (let i = 1; i <= 70; i++) {
  const { lastInsertRowid } = insertPedido.run(
    between(1, 40),
    date(2025, between(1, 12), between(1, 28)),
    pick(estados),
  )
  for (let n = between(1, 3); n > 0; n--) {
    const libro = between(1, 48)
    insertLinea.run(lastInsertRowid, libro, between(1, 3), libros[libro - 1])
  }
}
db.close()
