import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import ModalDialog from './ModalDialog.vue'

let wrapper: VueWrapper | undefined

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.body.innerHTML = ''
})

async function setup(open = false) {
  wrapper = mount(ModalDialog, {
    props: { open, labelledby: 'title' },
    slots: { default: '<h2 id="title">Título</h2>' },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper.get<HTMLDialogElement>('dialog')
}

describe('ModalDialog', () => {
  it('opens and closes the native dialog with `open`', async () => {
    const dialog = await setup()
    expect(dialog.element.open).toBe(false)

    await wrapper!.setProps({ open: true })
    expect(dialog.element.open).toBe(true)

    await wrapper!.setProps({ open: false })
    expect(dialog.element.open).toBe(false)
  })

  it('routes Escape to the owner instead of closing by itself', async () => {
    const dialog = await setup(true)

    await dialog.trigger('cancel')

    expect(wrapper!.emitted('close')).toHaveLength(1)
    expect(dialog.element.open).toBe(true)
  })

  it('reports a native close that happened while the owner still considers it open', async () => {
    const dialog = await setup(true)

    dialog.element.close()
    await flushPromises()

    expect(wrapper!.emitted('close')).toHaveLength(1)
  })

  it('ignores the late echo of an earlier close once the owner has reopened it', async () => {
    const dialog = await setup(true)

    await wrapper!.setProps({ open: false })
    await wrapper!.setProps({ open: true })
    // El evento `close` de Chromium llega asíncrono: aquí ya está abierto otra vez.
    await dialog.trigger('close')

    expect(wrapper!.emitted('close')).toBeUndefined()
    expect(dialog.element.open).toBe(true)
  })

  it('does not report the close it caused itself', async () => {
    const dialog = await setup(true)

    await wrapper!.setProps({ open: false })
    await dialog.trigger('close')

    expect(wrapper!.emitted('close')).toBeUndefined()
  })
})
