/**
 * Browser half of dsh-code-audit.
 *
 * Adds a native shell entry, like the official skill center: a row in the
 * left sidebar panel list plus a keyed page in the main column. The page
 * embeds the plugin's own console (`/dsh-code-audit/`) so task, finding,
 * prompt and report management stay in one implementation.
 *
 * Loaded by the DSH client module loader; `require` is the shell-provided
 * shared module registry (React is a peer, never bundled).
 */
window.__ModuleLoader__.load({
  id: 'dsh-code-audit',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const jsxRuntime = require('react/jsx-runtime')

    /** Stable id shared by the sidebar row and the main-slot page. */
    const PANEL_ID = 'code-audit'

    /** Row order among global panel rows (plugins 0, schedule 10, board 20, skills 30). */
    const PANEL_ORDER = 40

    /**
     * Sidebar row glyph. The shell owns the button, label and active state;
     * this component draws the icon only.
     */
    function AuditPanelIcon({ size }) {
      return jsxRuntime.jsx('svg', {
        'data-dsh-panel-entry': PANEL_ID,
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        children: [
          jsxRuntime.jsx('path', {
            d: 'M8 1.9 13.4 4v4.1c0 3.1-2.2 5.2-5.4 6-3.2-.8-5.4-2.9-5.4-6V4z',
            key: 'shield',
          }),
          jsxRuntime.jsx('path', {
            d: 'm5.9 8.1 1.5 1.5 3-3.1',
            key: 'check',
          }),
        ],
      })
    }

    /** Center-column page: the audit console fills the panel. */
    function AuditPanelPage() {
      return jsxRuntime.jsx('div', {
        style: {
          width: '100%',
          height: '100%',
          overflow: 'hidden',
          background: 'transparent',
        },
        children: jsxRuntime.jsx('iframe', {
          src: '/dsh-code-audit/',
          title: '代码审计控制台',
          style: {
            display: 'block',
            width: '100%',
            height: '100%',
            border: '0',
          },
        }),
      })
    }

    /** Required services (fiber inject waiting — the shell must be up first). */
    const inject = ['slots']

    /** Mount the sidebar entry and the main page. */
    function apply(ctx) {
      const disposers = []
      try {
        const slots = ctx.slots
        const register = config => (component) =>
          slots.inject(config.name, () => slots.register(config, component))
        const sidebar = register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: PANEL_ORDER,
          label: () => '代码审计',
        })
        const main = register({
          name: 'main',
          key: PANEL_ID,
        })
        disposers.push(sidebar(AuditPanelIcon))
        disposers.push(main(AuditPanelPage))
      } catch (error) {
        console.warn('[code-audit] panel registration failed:', error)
      }
      ctx.effect(
        () => () => {
          for (const dispose of disposers.splice(0)) dispose()
        },
        'code-audit: ui mounts',
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
