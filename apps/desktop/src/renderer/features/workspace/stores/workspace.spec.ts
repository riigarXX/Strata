import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useWorkspaceStore } from './workspace'

beforeEach(() => setActivePinia(createPinia()))

function storeWithTabs(count: number) {
  const store = useWorkspaceStore()
  for (let index = 0; index < count; index += 1) store.createTab()
  return store
}

const ids = (store: ReturnType<typeof useWorkspaceStore>) => store.tabs.map((tab) => tab.id)

describe('workspace store', () => {
  it('starts empty', () => {
    const store = useWorkspaceStore()
    expect(store.tabs).toEqual([])
    expect(store.activeTab).toBeNull()
  })

  it('creates tabs with unique ids and titles, and activates the new one', () => {
    const store = useWorkspaceStore()
    const first = store.createTab()
    const second = store.createTab('session-1')

    expect(first).toEqual({
      id: 'tab-1',
      title: 'Consulta 1',
      content: '',
      sessionId: null,
      saveToHistory: true,
    })
    expect(second.sessionId).toBe('session-1')
    expect(store.activeTabId).toBe(second.id)
  })

  it('does not reuse ids or titles after closing tabs', () => {
    const store = storeWithTabs(2)
    store.closeTab('tab-2')
    expect(store.createTab().title).toBe('Consulta 3')
  })

  it('closing the active tab activates the right neighbour', () => {
    const store = storeWithTabs(3)
    store.activateTab('tab-2')
    store.closeActiveTab()
    expect(ids(store)).toEqual(['tab-1', 'tab-3'])
    expect(store.activeTabId).toBe('tab-3')
  })

  it('closing the last active tab activates the left neighbour', () => {
    const store = storeWithTabs(3)
    store.closeActiveTab()
    expect(store.activeTabId).toBe('tab-2')
  })

  it('closing an inactive tab keeps the active one', () => {
    const store = storeWithTabs(3)
    store.activateTab('tab-2')
    store.closeTab('tab-1')
    expect(store.activeTabId).toBe('tab-2')
    store.closeTab('tab-3')
    expect(store.activeTabId).toBe('tab-2')
  })

  it('closing the only tab leaves no active tab, and unknown ids are ignored', () => {
    const store = storeWithTabs(1)
    store.closeTab('nope')
    expect(store.tabs).toHaveLength(1)
    store.closeActiveTab()
    expect(store.activeTabId).toBeNull()
    expect(() => store.closeActiveTab()).not.toThrow()
  })

  it('switches by index, to the last tab and circularly', () => {
    const store = storeWithTabs(3)
    store.activateAt(0)
    expect(store.activeTabId).toBe('tab-1')
    store.activateAt(7)
    expect(store.activeTabId).toBe('tab-1')
    store.activateLast()
    expect(store.activeTabId).toBe('tab-3')
    store.activateRelative(1)
    expect(store.activeTabId).toBe('tab-1')
    store.activateRelative(-1)
    expect(store.activeTabId).toBe('tab-3')
  })

  it('ignores relative switching without tabs and activation of unknown ids', () => {
    const store = useWorkspaceStore()
    store.activateRelative(1)
    store.activateTab('ghost')
    expect(store.activeTabId).toBeNull()
  })

  it('stores the text content per tab', () => {
    const store = storeWithTabs(2)
    store.setContent('tab-1', 'select 1')
    expect(store.tabs.map((tab) => tab.content)).toEqual(['select 1', ''])
  })

  it('keeps the history opt-out per tab, saving by default', () => {
    const store = storeWithTabs(2)
    store.setSaveToHistory('tab-1', false)
    store.setSaveToHistory('ghost', false)
    expect(store.tabs.map((tab) => tab.saveToHistory)).toEqual([false, true])
  })

  it('detaches only the tabs whose session is no longer open', () => {
    const store = useWorkspaceStore()
    store.createTab('alive')
    store.createTab('gone')
    store.createTab(null)
    store.detachClosedSessions(new Set(['alive']))
    expect(store.tabs.map((tab) => tab.sessionId)).toEqual(['alive', null, null])
  })

  it('keeps only whitelisted, non-secret fields in the serialised state', () => {
    const store = storeWithTabs(1)
    store.setContent('tab-1', 'select 1')
    const state = JSON.parse(JSON.stringify(store.$state)) as { tabs: Record<string, unknown>[] }
    expect(Object.keys(state.tabs[0]!).sort()).toEqual([
      'content',
      'id',
      'saveToHistory',
      'sessionId',
      'title',
    ])
  })
})

describe('workspace store: insertion requests', () => {
  it('queues text for the active tab and hands it over once', () => {
    const store = storeWithTabs(2)
    store.requestInsert('public.users')
    store.requestInsert('id')

    expect(store.insertQueues).toEqual({ 'tab-2': ['public.users', 'id'] })
    expect(store.takeInserts('tab-1')).toEqual([])
    expect(store.takeInserts('tab-2')).toEqual(['public.users', 'id'])
    expect(store.takeInserts('tab-2')).toEqual([])
    expect(store.insertQueues).toEqual({})
  })

  it('ignores empty text and requests without an active tab', () => {
    const store = useWorkspaceStore()
    store.requestInsert('x')
    expect(store.insertQueues).toEqual({})
    store.createTab()
    store.requestInsert('')
    expect(store.insertQueues).toEqual({})
  })

  it('targets the tab that was active when the request was made', () => {
    const store = storeWithTabs(2)
    store.requestInsert('a')
    store.activateTab('tab-1')
    store.requestInsert('b')
    expect(store.takeInserts('tab-2')).toEqual(['a'])
    expect(store.takeInserts('tab-1')).toEqual(['b'])
  })

  it('drops the pending requests of a closed tab', () => {
    const store = storeWithTabs(2)
    store.requestInsert('a')
    store.closeTab('tab-2')
    expect(store.insertQueues).toEqual({})
  })
})
