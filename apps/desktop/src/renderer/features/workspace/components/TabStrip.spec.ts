import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type { SqlTab } from '../stores/workspace'
import TabStrip from './TabStrip.vue'

const tabs: SqlTab[] = [
  { id: 'tab-1', title: 'Consulta 1', content: '', sessionId: null, saveToHistory: true },
  { id: 'tab-2', title: 'Consulta 2', content: '', sessionId: null, saveToHistory: true },
  { id: 'tab-3', title: 'Consulta 3', content: '', sessionId: null, saveToHistory: true },
]

let mounted: VueWrapper | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  document.body.innerHTML = ''
})

function mountStrip(activeTabId: string | null = 'tab-1', list: SqlTab[] = tabs) {
  const wrapper = mount(TabStrip, { props: { tabs: list, activeTabId }, attachTo: document.body })
  mounted = wrapper
  return wrapper
}

const tab = (wrapper: VueWrapper, id: string) => wrapper.get(`[data-tab-id="${id}"]`)
const activated = (wrapper: VueWrapper) => wrapper.emitted('activate')?.map(([id]) => id)

describe('TabStrip', () => {
  it('exposes tablist and tab roles with selection state', () => {
    const wrapper = mountStrip('tab-2')
    expect(wrapper.get('[role="tablist"]').attributes('aria-label')).toBe('Pestañas SQL')
    const roles = wrapper.findAll('[role="tab"]')
    expect(roles.map((entry) => entry.attributes('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
    ])
    expect(tab(wrapper, 'tab-2').attributes('aria-controls')).toBe('strata-tabpanel-tab-2')
    expect(tab(wrapper, 'tab-1').attributes('aria-controls')).toBeUndefined()
  })

  it('uses a roving tabindex: only the active tab is in the tab order', () => {
    const wrapper = mountStrip('tab-2')
    expect(wrapper.findAll('[role="tab"]').map((entry) => entry.attributes('tabindex'))).toEqual([
      '-1',
      '0',
      '-1',
    ])
  })

  it('moves and activates with Left/Right, wrapping around', async () => {
    const wrapper = mountStrip('tab-3')
    await tab(wrapper, 'tab-3').trigger('keydown', { key: 'ArrowRight' })
    await tab(wrapper, 'tab-1').trigger('keydown', { key: 'ArrowLeft' })
    expect(activated(wrapper)).toEqual(['tab-1', 'tab-3'])
    expect(document.activeElement?.id).toBe('strata-tab-tab-3')
  })

  it('jumps with Home and End', async () => {
    const wrapper = mountStrip('tab-2')
    await tab(wrapper, 'tab-2').trigger('keydown', { key: 'End' })
    await tab(wrapper, 'tab-2').trigger('keydown', { key: 'Home' })
    expect(activated(wrapper)).toEqual(['tab-3', 'tab-1'])
  })

  it('activates a tab by click (which is what Enter and Space trigger on a button)', async () => {
    const wrapper = mountStrip('tab-1')
    await tab(wrapper, 'tab-2').trigger('click')
    expect(activated(wrapper)).toEqual(['tab-2'])
  })

  it('closes the focused tab with Delete and ignores modified keys', async () => {
    const wrapper = mountStrip('tab-2')
    await tab(wrapper, 'tab-2').trigger('keydown', { key: 'Delete', metaKey: true })
    expect(wrapper.emitted('close')).toBeUndefined()
    await tab(wrapper, 'tab-2').trigger('keydown', { key: 'Delete' })
    expect(wrapper.emitted('close')).toEqual([['tab-2']])
  })

  it('does not handle unrelated keys', () => {
    const wrapper = mountStrip()
    const event = new KeyboardEvent('keydown', { key: 'a', cancelable: true })
    tab(wrapper, 'tab-1').element.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('offers labelled buttons to create and close tabs', async () => {
    const wrapper = mountStrip('tab-2')
    const create = wrapper.get('[data-action="new-tab"]')
    expect(create.attributes('aria-label')).toBe('Nueva pestaña SQL')
    await create.trigger('click')
    expect(wrapper.emitted('new')).toHaveLength(1)

    const close = wrapper.get('[data-action="close-active-tab"]')
    expect(close.attributes('aria-label')).toBe('Cerrar pestaña activa')
    await close.trigger('click')
    expect(wrapper.emitted('close')).toEqual([['tab-2']])
  })

  it('closes with the mouse-only glyph without activating the tab', async () => {
    const wrapper = mountStrip('tab-1')
    const glyph = tab(wrapper, 'tab-2').get('.tab__close')
    expect(glyph.attributes('aria-hidden')).toBe('true')
    await glyph.trigger('click')
    expect(wrapper.emitted('close')).toEqual([['tab-2']])
    expect(wrapper.emitted('activate')).toBeUndefined()
  })

  it('disables closing when there are no tabs and lets focus fall back to the new-tab button', async () => {
    const wrapper = mountStrip(null, [])
    expect(wrapper.get('[data-action="close-active-tab"]').attributes('disabled')).toBeDefined()
    ;(wrapper.vm as unknown as { focusActive(): void }).focusActive()
    expect(document.activeElement).toBe(wrapper.get('[data-action="new-tab"]').element)
  })
})
