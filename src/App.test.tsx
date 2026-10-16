// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { ANGLES } from './render/angles'

// The 3D scene loads lazily and needs a GPU; the shell around it is what these tests cover.
vi.mock('./components/Scene', () => ({ default: () => null }))

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

async function mount() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<App />)
  })
  return { container, unmount: () => act(() => root.unmount()) }
}

describe('showroom shell', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    localStorage.clear()
  })

  it('shows the command bar, the angle strip and the stage toolbar; nothing drags until 360° view', async () => {
    const { container, unmount } = await mount()
    expect(container.querySelector('.command-bar')).not.toBeNull()
    expect(container.querySelector('.project-button')?.textContent).toContain('Create build brief')
    const tiles = container.querySelectorAll('.angle-strip .angle')
    expect(tiles).toHaveLength(ANGLES.length)
    expect(tiles[0].getAttribute('aria-selected')).toBe('true')
    const stage = container.querySelector('.stage')!
    expect(stage.classList.contains('exploring')).toBe(false)
    const toolbar = container.querySelector('.stage-toolbar')!
    const buttons = [...toolbar.querySelectorAll('button')]
    const spin = buttons.find((b) => b.textContent?.includes('360° View'))!
    expect(spin.getAttribute('aria-pressed')).toBe('false')
    await act(async () => {
      spin.click()
    })
    expect(stage.classList.contains('exploring')).toBe(true)
    expect(spin.getAttribute('aria-pressed')).toBe('true')
    // Picking an angle leaves the 360° view again.
    await act(async () => {
      ;(container.querySelectorAll('.angle-strip .angle')[2] as HTMLButtonElement).click()
    })
    expect(stage.classList.contains('exploring')).toBe(false)
    expect(container.querySelectorAll('.angle-strip .angle')[2].getAttribute('aria-selected')).toBe(
      'true',
    )
    await unmount()
  })

  it('steps angles with the arrow keys and lands inside for the interior view', async () => {
    const { container, unmount } = await mount()
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(container.querySelectorAll('.angle-strip .angle')[1].getAttribute('aria-selected')).toBe(
      'true',
    )
    const interior = [...container.querySelectorAll('.view-switch button')].find((b) =>
      b.textContent?.includes('Interior'),
    ) as HTMLButtonElement
    await act(async () => {
      interior.click()
    })
    const selected = container.querySelector('.angle-strip .angle[aria-selected="true"]')!
    expect(selected.classList.contains('interior')).toBe(true)
    await unmount()
  })
})
