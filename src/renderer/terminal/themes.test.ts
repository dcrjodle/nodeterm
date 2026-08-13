import { describe, it, expect } from 'vitest'
import {
  DEFAULT_TERMINAL_THEME_ID,
  TERMINAL_THEMES,
  resolveTerminalTheme
} from './themes'

const ANSI_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
] as const

describe('TERMINAL_THEMES', () => {
  it('has unique ids', () => {
    const ids = TERMINAL_THEMES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('includes the default id', () => {
    expect(TERMINAL_THEMES.some((t) => t.id === DEFAULT_TERMINAL_THEME_ID)).toBe(true)
  })

  // A theme missing an ANSI slot doesn't fail loudly — xterm silently falls back to ITS default
  // for that one colour, so e.g. a Solarized terminal renders one Tango-green among eight
  // Solarized ones. Only a full-palette check catches that.
  it.each(TERMINAL_THEMES.map((t) => [t.id, t] as const))(
    '%s defines a complete palette',
    (_id, t) => {
      for (const key of ANSI_KEYS) {
        expect(t.theme[key], `${t.id}.${key}`).toMatch(/^#[0-9a-f]{6}$/i)
      }
      expect(t.theme.background, `${t.id}.background`).toMatch(/^#[0-9a-f]{6}$/i)
      expect(t.theme.foreground, `${t.id}.foreground`).toMatch(/^#[0-9a-f]{6}$/i)
      expect(t.theme.cursor, `${t.id}.cursor`).toMatch(/^#[0-9a-f]{6}$/i)
      expect(t.theme.cursorAccent, `${t.id}.cursorAccent`).toMatch(/^#[0-9a-f]{6}$/i)
      expect(t.theme.selectionBackground, `${t.id}.selectionBackground`).toMatch(
        /^#[0-9a-f]{6,8}$/i
      )
    }
  )

  it('has a non-empty label for every theme', () => {
    for (const t of TERMINAL_THEMES) expect(t.label.trim().length).toBeGreaterThan(0)
  })

  it('offers at least one light theme', () => {
    expect(TERMINAL_THEMES.some((t) => !t.dark)).toBe(true)
  })
})

describe('the default theme reproduces the Weave appearance', () => {
  // LOAD-BEARING. The default theme's background IS the app palette's node-card surface
  // (`--surface-deep`), so an untouched install renders terminals flush with their card chrome.
  // The Weave re-theme (2026-08) changed these values ON PURPOSE — the pre-themes #1e1e1e pair
  // was retired with the macOS palette. Changing them again means deciding to repaint every
  // terminal of every user who never picked a theme.
  const d = resolveTerminalTheme(DEFAULT_TERMINAL_THEME_ID).theme

  it('keeps the background and foreground in step with the Weave palette', () => {
    expect(d.background).toBe('#161618')
    expect(d.foreground).toBe('#ececee')
  })

  it("keeps xterm's own default ANSI palette", () => {
    expect(d.black).toBe('#2e3436')
    expect(d.red).toBe('#cc0000')
    expect(d.green).toBe('#4e9a06')
    expect(d.yellow).toBe('#c4a000')
    expect(d.blue).toBe('#3465a4')
    expect(d.magenta).toBe('#75507b')
    expect(d.cyan).toBe('#06989a')
    expect(d.white).toBe('#d3d7cf')
    expect(d.brightBlack).toBe('#555753')
    expect(d.brightRed).toBe('#ef2929')
    expect(d.brightGreen).toBe('#8ae234')
    expect(d.brightYellow).toBe('#fce94f')
    expect(d.brightBlue).toBe('#729fcf')
    expect(d.brightMagenta).toBe('#ad7fa8')
    expect(d.brightCyan).toBe('#34e2e2')
    expect(d.brightWhite).toBe('#eeeeec')
  })
})

describe('resolveTerminalTheme', () => {
  it('resolves a known id', () => {
    expect(resolveTerminalTheme('dracula').id).toBe('dracula')
  })

  // settings.json is hand-editable and travels between versions. Handing xterm an undefined theme
  // would drop the terminal to xterm's own black background — a visibly broken app from a typo.
  it('falls back to the default for an unknown id', () => {
    expect(resolveTerminalTheme('no-such-theme').id).toBe(DEFAULT_TERMINAL_THEME_ID)
  })

  it('falls back for undefined and empty input', () => {
    expect(resolveTerminalTheme(undefined).id).toBe(DEFAULT_TERMINAL_THEME_ID)
    expect(resolveTerminalTheme('').id).toBe(DEFAULT_TERMINAL_THEME_ID)
  })

  // `applyLiveOptions` detects a palette change by object identity, so resolution must be stable.
  it('returns the same object for the same id', () => {
    expect(resolveTerminalTheme('nord').theme).toBe(resolveTerminalTheme('nord').theme)
  })
})
