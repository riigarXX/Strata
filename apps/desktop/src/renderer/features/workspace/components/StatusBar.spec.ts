import type { ConnectionProfile, Session } from '@strata/contracts'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import StatusBar from './StatusBar.vue'

const postgres: ConnectionProfile = {
  id: 'pg1',
  engine: 'postgres',
  name: 'Producción',
  readOnly: false,
  host: 'db.example.com',
  port: 5432,
  user: 'app',
  database: 'main',
  ssl: 'require',
}

const sqlite: ConnectionProfile = {
  id: 'sq1',
  engine: 'sqlite',
  name: 'Local',
  readOnly: true,
  filePath: '/Users/me/data/app.db',
}

const session = (overrides: Partial<Session>): Session => ({
  sessionId: 's1',
  profileId: 'pg1',
  engine: 'postgres',
  serverVersion: '16.2',
  readOnly: false,
  transaction: 'none',
  ...overrides,
})

const segment = (wrapper: ReturnType<typeof mount>, name: string) =>
  wrapper.get(`[data-segment="${name}"]`)

describe('StatusBar', () => {
  it('is a labelled contentinfo landmark', () => {
    const wrapper = mount(StatusBar, { props: { connection: null } })
    expect(wrapper.element.tagName).toBe('FOOTER')
    expect(wrapper.attributes('aria-label')).toBe('Barra de estado')
  })

  it('says there is no connection instead of leaving blanks', () => {
    const wrapper = mount(StatusBar, { props: { connection: null } })
    expect(segment(wrapper, 'connection').text()).toContain('Sin conexión')
    expect(segment(wrapper, 'database').text()).toContain('ninguna')
    expect(segment(wrapper, 'transaction').text()).toContain('sin conexión')
    expect(segment(wrapper, 'last-query').text()).toContain('sin datos')
  })

  it('shows connection name, engine, database and read/write access', () => {
    const wrapper = mount(StatusBar, {
      props: { connection: { profile: postgres, session: session({}) } },
    })
    expect(segment(wrapper, 'connection').text()).toContain('Producción')
    expect(segment(wrapper, 'connection').text()).toContain('PostgreSQL')
    expect(segment(wrapper, 'database').text()).toContain('main')
    expect(segment(wrapper, 'access').text()).toContain('Lectura y escritura')
  })

  it('shows the SQLite file name and the read-only indicator', () => {
    const wrapper = mount(StatusBar, {
      props: {
        connection: {
          profile: sqlite,
          session: session({ profileId: 'sq1', engine: 'sqlite', readOnly: true }),
        },
      },
    })
    expect(segment(wrapper, 'connection').text()).toContain('SQLite')
    expect(segment(wrapper, 'database').text()).toContain('app.db')
    expect(segment(wrapper, 'database').text()).not.toContain('/Users')
    expect(segment(wrapper, 'access').text()).toContain('Solo lectura')
  })

  it.each([
    ['none', 'Sin transacción'],
    ['active', 'Transacción activa'],
    ['aborted', 'Transacción abortada: hay que revertir'],
  ] as const)('communicates the %s transaction state with text', (state, label) => {
    const wrapper = mount(StatusBar, {
      props: { connection: { profile: postgres, session: session({ transaction: state }) } },
    })
    const transaction = segment(wrapper, 'transaction')
    expect(transaction.text()).toContain(label)
    expect(transaction.get('[data-state]').attributes('data-state')).toBe(state)
    expect(transaction.get('.statusbar__glyph').attributes('aria-hidden')).toBe('true')
  })

  it('keeps every label whole in the text although the compact layout abbreviates some', () => {
    const wrapper = mount(StatusBar, {
      props: {
        connection: { profile: postgres, session: session({ transaction: 'aborted' }) },
        lastQueryDuration: '12 ms',
      },
    })
    expect(segment(wrapper, 'database').get('.statusbar__label').text()).toBe('Base de datos:')
    expect(segment(wrapper, 'last-query').get('.statusbar__label').text()).toBe('Última consulta:')
    expect(segment(wrapper, 'access').get('.statusbar__label').text()).toBe('Acceso:')
    expect(segment(wrapper, 'transaction').get('.statusbar__label').text()).toBe('Transacción:')
    expect(segment(wrapper, 'transaction').get('.statusbar__aux').text()).toBe(': hay que revertir')
  })

  it('announces connection and transaction changes through polite status regions', () => {
    const wrapper = mount(StatusBar, { props: { connection: null } })
    const live = wrapper.findAll('[role="status"]').map((entry) => entry.attributes('data-segment'))
    expect(live).toEqual(['connection', 'transaction'])
  })

  it('reserves the last query slot and fills it when a duration is provided', () => {
    const empty = mount(StatusBar, { props: { connection: null } })
    expect(segment(empty, 'last-query').text()).toContain('—')
    const filled = mount(StatusBar, { props: { connection: null, lastQueryDuration: '12 ms' } })
    expect(segment(filled, 'last-query').text()).toContain('12 ms')
  })
})
