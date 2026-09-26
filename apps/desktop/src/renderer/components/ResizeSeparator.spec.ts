import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ResizeSeparator from './ResizeSeparator.vue'

function mountSeparator(props: Record<string, unknown> = {}) {
  return mount(ResizeSeparator, {
    props: {
      modelValue: 200,
      min: 100,
      max: 300,
      orientation: 'vertical',
      label: 'Redimensionar',
      ...props,
    },
  })
}

const emitted = (wrapper: ReturnType<typeof mountSeparator>) =>
  wrapper.emitted('update:modelValue')?.map(([value]) => value)

describe('ResizeSeparator', () => {
  it('exposes the separator semantics and value range', () => {
    const wrapper = mountSeparator({ controls: 'panel' })
    expect(wrapper.attributes()).toMatchObject({
      role: 'separator',
      tabindex: '0',
      'aria-orientation': 'vertical',
      'aria-label': 'Redimensionar',
      'aria-controls': 'panel',
      'aria-valuenow': '200',
      'aria-valuemin': '100',
      'aria-valuemax': '300',
      'aria-valuetext': '200 píxeles',
    })
  })

  it('resizes a vertical separator with Left/Right arrows', async () => {
    const wrapper = mountSeparator()
    await wrapper.trigger('keydown', { key: 'ArrowRight' })
    await wrapper.trigger('keydown', { key: 'ArrowLeft' })
    expect(emitted(wrapper)).toEqual([216, 184])
  })

  it('resizes an inverted horizontal separator with Up/Down arrows (up grows)', async () => {
    const wrapper = mountSeparator({ orientation: 'horizontal', inverted: true })
    await wrapper.trigger('keydown', { key: 'ArrowUp' })
    await wrapper.trigger('keydown', { key: 'ArrowDown' })
    expect(emitted(wrapper)).toEqual([216, 184])
  })

  it('takes larger steps with Shift and jumps with Home/End', async () => {
    const wrapper = mountSeparator({ modelValue: 150 })
    await wrapper.trigger('keydown', { key: 'ArrowRight', shiftKey: true })
    await wrapper.trigger('keydown', { key: 'Home' })
    await wrapper.trigger('keydown', { key: 'End' })
    expect(emitted(wrapper)).toEqual([214, 100, 300])
  })

  it('never emits values outside the limits and does not emit when nothing changes', async () => {
    const atMax = mountSeparator({ modelValue: 300 })
    await atMax.trigger('keydown', { key: 'ArrowRight' })
    await atMax.trigger('keydown', { key: 'End' })
    expect(emitted(atMax)).toBeUndefined()

    const nearMin = mountSeparator({ modelValue: 104 })
    await nearMin.trigger('keydown', { key: 'ArrowLeft' })
    expect(emitted(nearMin)).toEqual([100])
  })

  it('clamps the reported value when the limits shrink below the model', () => {
    const wrapper = mountSeparator({ modelValue: 400 })
    expect(wrapper.attributes('aria-valuenow')).toBe('300')
  })

  it('prevents default on handled keys only and ignores modified arrows', async () => {
    const wrapper = mountSeparator()
    const handled = new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true })
    wrapper.element.dispatchEvent(handled)
    expect(handled.defaultPrevented).toBe(true)

    const other = new KeyboardEvent('keydown', { key: 'a', cancelable: true })
    wrapper.element.dispatchEvent(other)
    expect(other.defaultPrevented).toBe(false)

    await wrapper.trigger('keydown', { key: 'ArrowRight', metaKey: true })
    expect(emitted(wrapper)).toEqual([216])
  })

  it('resizes with the pointer within the limits', async () => {
    const wrapper = mountSeparator()
    await wrapper.trigger('pointerdown', { button: 0, clientX: 200, pointerId: 1 })
    expect(wrapper.attributes('data-dragging')).toBe('true')
    await wrapper.trigger('pointermove', { clientX: 250 })
    await wrapper.trigger('pointermove', { clientX: 900 })
    await wrapper.trigger('pointermove', { clientX: -900 })
    await wrapper.trigger('pointerup')
    expect(emitted(wrapper)).toEqual([250, 300, 100])
    expect(wrapper.attributes('data-dragging')).toBeUndefined()

    await wrapper.trigger('pointermove', { clientX: 210 })
    expect(emitted(wrapper)).toHaveLength(3)
  })

  it('inverts the pointer direction for inverted separators', async () => {
    const wrapper = mountSeparator({ orientation: 'horizontal', inverted: true })
    await wrapper.trigger('pointerdown', { button: 0, clientY: 500, pointerId: 1 })
    await wrapper.trigger('pointermove', { clientY: 450 })
    expect(emitted(wrapper)).toEqual([250])
  })
})
