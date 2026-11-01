window.__ModuleLoader__.load({
  id: '@local/dsh-reasoning-slider',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useRef, useState } = React

    const PLUGIN_ID = '@local/dsh-reasoning-slider'
    const SLOT = 'conversation.input.right'

    const TEXT = {
      'zh-CN': { aria: '推理等级', failed: '失联', idle: '推理' },
      en: { aria: 'Reasoning effort', failed: 'LINK LOST', idle: 'Reasoning' },
    }

    const CSS = [
      '@keyframes rs-flow{0%{transform:translateX(-70%)}100%{transform:translateX(170%)}}',
      '@keyframes rs-pulse{0%,100%{opacity:.7}50%{opacity:1}}',
      '.rs{display:inline-flex;align-items:center;gap:8px;height:28px;user-select:none}',
      '.rs-tab{width:8px;height:28px;border-radius:0;flex:none;',
      'background:repeating-linear-gradient(45deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 78%,#ffb020) 0 4px,',
      'color-mix(in srgb,#000 72%,transparent) 4px 8px);',
      'box-shadow:0 0 10px color-mix(in srgb,var(--dsw-alias-brand-primary) 32%,transparent)}',
      '.rs-bar{position:relative;width:200px;height:28px;border-radius:0;overflow:hidden;flex:none;',
      'border:1px solid var(--dsw-alias-border-l1);',
      'background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base)) 86%,',
      'var(--dsw-alias-label-primary) 9%);',
      'box-shadow:inset 0 1px 2px color-mix(in srgb,#000 32%,transparent),',
      'inset 0 1px 0 color-mix(in srgb,#fff 10%,transparent)}',
      '.rs-fill{position:absolute;left:0;top:2px;bottom:2px;overflow:hidden;',
      'background:linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 72%,transparent) 0%,',
      'var(--dsw-alias-brand-primary) 58%,color-mix(in srgb,var(--dsw-alias-brand-primary) 62%,#ffb020) 100%);',
      'box-shadow:0 0 16px color-mix(in srgb,var(--dsw-alias-brand-primary) 46%,transparent),',
      'inset 0 0 10px color-mix(in srgb,#fff 18%,transparent)}',
      '.rs-flow{position:absolute;inset:0;background:linear-gradient(115deg,transparent 40%,',
      'color-mix(in srgb,#fff 24%,transparent) 50%,transparent 60%);',
      'animation:rs-flow 2.8s linear infinite;mix-blend-mode:screen}',
      '.rs-grid{position:absolute;inset:2px 0;pointer-events:none;',
      'background:repeating-linear-gradient(90deg,transparent 0 15px,',
      'color-mix(in srgb,#000 42%,transparent) 15px 16px)}',
      '.rs-core{position:absolute;top:50%;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;',
      'pointer-events:none;background:radial-gradient(circle at 34% 28%,#fff 0%,#eaf4ff 52%,#a9d2ff 100%);',
      'box-shadow:0 0 0 2px color-mix(in srgb,#fff 18%,transparent),0 0 15px 4px color-mix(in srgb,var(--dsw-alias-brand-primary) 52%,transparent)}',
      '.rs-range{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer;z-index:3;',
      '-webkit-appearance:none;appearance:none}',
      '.rs:has(.rs-range:focus-visible) .rs-bar{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.rs[data-state="pending"] .rs-fill{animation:rs-pulse 1s ease-in-out infinite}',
      '.rs[data-state="failed"] .rs-tab{background:var(--dsw-alias-state-error-primary)}',
      '.rs-readout{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;font-weight:700;',
      'letter-spacing:.04em;color:var(--dsw-alias-label-primary);min-width:39px;text-align:right;white-space:nowrap}',
      '.rs[data-state="pending"] .rs-readout{color:var(--dsw-alias-label-caption)}',
      '.rs[data-state="failed"] .rs-readout{color:var(--dsw-alias-state-error-primary);min-width:0;font-size:9px;letter-spacing:.1em}',
      '@media (max-width:1024px){.rs-bar{width:150px}}',
      '@media (max-width:880px){.rs-bar{width:120px}.rs-readout{font-size:10px;min-width:33px}}',
      '.rs-empty{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 8px;border-radius:999px;',
      'border:1px dashed color-mix(in srgb,var(--dsw-alias-border-l2) 70%,transparent);',
      'font-family:ui-monospace,Menlo,monospace;font-size:9px;letter-spacing:.12em;',
      'color:var(--dsw-alias-label-caption);cursor:default}',
      '.rs-empty i{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-label-caption);opacity:.6}',
    ].join('')

    /** Current per-session selection, read through the model-selection projection. */
    function useSelection(ctx, sessionId) {
      const face = useMemo(() => {
        if (!sessionId) return null
        try {
          const binding = ctx.sessions.binding(sessionId)
          return binding?.session?.projections?.faceOf?.('modelSelection') ?? null
        } catch {
          return null
        }
      }, [ctx, sessionId])
      const [value, setValue] = useState(undefined)
      useEffect(() => {
        if (!face) {
          setValue(undefined)
          return undefined
        }
        const update = () => {
          try {
            setValue(face.getSnapshot())
          } catch {
            setValue(undefined)
          }
        }
        update()
        const off = face.subscribe(update)
        return () => {
          if (typeof off === 'function') off()
        }
      }, [face])
      return { selection: value?.next, hasFace: Boolean(face) }
    }

    function Meter(props) {
      const { ctx, loadCatalog, sessionId } = props
      const localeId = ctx.locale?.getLocale?.()?.id ?? 'en'
      const t = TEXT[localeId] ?? TEXT.en
      const { selection: projected, hasFace } = useSelection(ctx, sessionId)
      const [catalog, setCatalog] = useState(null)
      const [draft, setDraft] = useState(null)
      const [pending, setPending] = useState(false)
      const [failed, setFailed] = useState(false)
      const dragging = useRef(false)

      useEffect(() => {
        let alive = true
        loadCatalog().then((value) => {
          if (alive) setCatalog(value ?? null)
        })
        return () => {
          alive = false
        }
      }, [loadCatalog])

      // The durable projection wins; a brand-new session falls back to the
      // catalog default, exactly like the shipped model selector does.
      const selection = projected ?? catalog?.default ?? null

      const model = useMemo(() => {
        if (!catalog || !selection) return null
        const group = catalog.groups?.find((item) => item.id === selection.provider)
        return group?.models?.find((item) => item.id === selection.model) ?? null
      }, [catalog, selection])

      const efforts = model?.reasoning?.efforts ?? []
      const effective = selection?.reasoningEffort ?? model?.reasoning?.defaultEffort
      const settled = Math.max(0, efforts.findIndex((item) => item.id === effective))

      if (!selection || efforts.length < 2) {
        return h(
          'span',
          {
            className: 'rs-empty',
            title: 'reasoning-slider: ' + (selection ? `catalog efforts=${efforts.length}` : hasFace ? 'no model selection' : 'no session projection'),
          },
          h('i', null),
          '推理 · ' + (selection ? '—' : '…'),
        )
      }

      const value = draft ?? settled
      const ratio = value / (efforts.length - 1)
      const shown = Math.min(efforts.length - 1, Math.max(0, Math.round(value)))
      const percent = String(Math.round(ratio * 100)).padStart(3, '0') + '%'

      const commit = async (next) => {
        const index = Math.min(efforts.length - 1, Math.max(0, Math.round(next)))
        setDraft(null)
        if (pending || index === settled) return
        setPending(true)
        setFailed(false)
        try {
          const result = await ctx.remote.session.selectModel({
            sessionId,
            provider: selection.provider,
            model: selection.model,
            reasoningEffort: efforts[index].id,
          })
          if (!result?.ok) throw new Error(result?.error?.message ?? 'selectModel failed')
        } catch {
          setFailed(true)
          setTimeout(() => setFailed(false), 2200)
        } finally {
          setPending(false)
        }
      }

      const state = pending ? 'pending' : failed ? 'failed' : 'idle'

      return h(
        'div',
        {
          className: 'rs',
          'data-eva-reasoning': '',
          'data-state': state,
          title: t.aria + ': ' + (efforts[shown]?.name ?? ''),
        },
        h('style', { 'data-plugin': PLUGIN_ID }, CSS),
        h('span', { className: 'rs-tab', 'aria-hidden': 'true' }),
        h(
          'span',
          { className: 'rs-bar' },
          h(
            'span',
            { className: 'rs-fill', style: { width: `calc(8px + (100% - 16px) * ${ratio.toFixed(4)})` } },
            h('span', { className: 'rs-flow' }),
          ),
          h('span', { className: 'rs-grid' }),
          h('span', { className: 'rs-core', style: { left: `calc(8px + (100% - 16px) * ${ratio.toFixed(4)})` } }),
          h('input', {
            className: 'rs-range',
            type: 'range',
            min: 0,
            max: efforts.length - 1,
            step: 0.01,
            value,
            'aria-label': t.aria,
            'aria-valuetext': (efforts[shown]?.name ?? '') + ' ' + percent,
            onChange: (event) => setDraft(Number(event.target.value)),
            onPointerDown: () => {
              dragging.current = true
            },
            onPointerUp: (event) => {
              dragging.current = false
              void commit(Number(event.target.value))
            },
            onKeyDown: (event) => {
              if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
                event.preventDefault()
                void commit(settled - 1)
              } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
                event.preventDefault()
                void commit(settled + 1)
              } else if (event.key === 'Home') {
                event.preventDefault()
                void commit(0)
              } else if (event.key === 'End') {
                event.preventDefault()
                void commit(efforts.length - 1)
              }
            },
          }),
        ),
        h('span', { className: 'rs-readout' }, failed ? t.failed : percent),
      )
    }

    return {
      inject: ['slots', 'sessions', 'remote', 'remote.session', 'locale'],
      apply(ctx) {
        const cache = { value: null, inflight: null }
        const loadCatalog = () => {
          if (cache.value) return Promise.resolve(cache.value)
          if (cache.inflight) return cache.inflight
          const task = Promise.resolve()
            .then(() => {
              if (!ctx.remote?.session?.modelCatalog) throw new Error('ctx.remote.session.modelCatalog unavailable')
              return ctx.remote.session.modelCatalog()
            })
            .then((result) => {
              const value = result?.ok ? result.value : null
              cache.value = value
              return value
            })
            .catch(() => null)
            .finally(() => {
              if (cache.inflight === task) cache.inflight = null
            })
          cache.inflight = task
          return task
        }
        const reset = () => {
          cache.value = null
          cache.inflight = null
        }
        ctx.effect(() => {
          const off = ctx.on?.('connection/reset', reset)
          return () => {
            off?.()
            reset()
          }
        }, PLUGIN_ID + ': catalog cache')
        ctx.effect(
          () =>
            ctx.slots.inject(SLOT, () =>
              ctx.slots.register(
                { name: SLOT, id: 'reasoning-slider', order: 20 },
                (slotProps) => h(Meter, { ...slotProps, ctx, loadCatalog }),
              ),
            ),
          PLUGIN_ID + ': slot registration',
        )
      },
    }
  },
})
