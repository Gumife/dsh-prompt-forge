/**
 * dsh-prompt-forge — Client half (P1 preview/accept flow).
 *
 * WHAT THIS IS
 * A ✦ button in `conversation.input.left` — the compact controls at the left
 * of the composer tool row. Clicking it opens a card that:
 *   1. reads the CURRENT composer draft,
 *   2. asks the Host half to rewrite it (faithful polish + hard-fact gate),
 *   3. shows 原稿 / 改写 side by side with the hard-fact counter,
 *   4. on 采纳 writes the rewrite back into the composer draft; on 放弃 it
 *      closes and leaves the draft untouched.
 *
 * WHY input.left AND NOWHERE ELSE
 * `conversation.input.left` is kind:list with replaceRisk:'none' and an empty
 * occupant list — a fresh id is ADDED beside the shipped controls, nothing is
 * shadowed. The model seat (`conversation.input.model`) is deliberately never
 * touched: it is kind:single with replaceRisk:'shadows-shipped-ui', and the
 * previous project lost the composer's model button doing exactly that.
 *
 * HOW THE DRAFT IS REACHED (verified against the packaged host, 2026-10-21)
 * `renderSlot("conversation.input.left", {})` passes NO props, so the draft is
 * not a slot prop. It comes from the session binding instead:
 *   ctx.get('sessions').binding(sessionId)      -> the binding owner
 *   ctx.get('uiSession').bindingSource({...})   -> { hooks, props } source
 *   binding.hooks.input                         -> snapshot store, `.draft`
 *   binding.props.inputActions.setDraft(text)   -> programmatic write
 * Both are re-resolved inside the effect so a session switch cannot leave a
 * stale source attached.
 *
 * CONTRACT NOTES (KICKOFF 避雷清单)
 *   #3  The CSS template literal below must never contain a backtick, not even
 *       inside a comment: it would terminate the template early and the
 *       factory would throw at load time while `node --check` still passes.
 *       verify-client.mjs executes the real factory for exactly this reason.
 *   #4  Every scrolling child carries min-height:0 so overflow-y:auto actually
 *       scrolls instead of pushing the footer past the border.
 *   #5  The module id below equals the package name (dsh-prompt-forge).
 *   #1  inject receives the session id as its FIRST argument and forwards it
 *       verbatim; do not move it into a literal.
 *
 * The popover shell (fixed positioning, viewport clamping, ResizeObservers,
 * Escape/outside-click) is copied from dsh-model-radar's verified menu.
 */
window.__ModuleLoader__.load({
  id: 'dsh-prompt-forge',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;

    /* The popover is PORTALLED to document.body, never rendered inside the
     * composer's DOM subtree.
     *
     * Why this is not cosmetic: .pf-pop is position:fixed and its coordinates
     * come from getBoundingClientRect(), which is a VIEWPORT rect. But the
     * composer's panel carries backdrop-filter, and backdrop-filter creates a
     * containing block for fixed descendants — exactly like transform or
     * perspective does. So while the panel lived inside it, "fixed" resolved
     * against the composer instead of the viewport, and the panel landed
     * several centimetres off, sitting on top of the draft text.
     *
     * document.body carries none of those properties, so a portal restores the
     * coordinate system the placement maths already assumes. The host's own
     * ContextMeter popover does the same thing for the same reason. */

    const NS = 'dsh-prompt-forge';

    const POPOVER_MIN = 160;
    const POPOVER_MAX = 360;
    /* Must match the .pf-pop width in the CSS below, padding included: this is
     * only the pre-measure fallback used on the very first frame, before
     * offsetWidth is readable. When the two drift apart the panel visibly
     * jumps sideways on first paint.
     *
     * 268, not 248: the mode track and the docs pill together need ~234px of
     * content box (two 66px segments + a 90px docs pill + gaps). At 248 the
     * docs label wrapped to two lines and burst its own pill. */
    const POPOVER_WIDTH = 268;
    const POPOVER_MARGIN = 12;
    const POPOVER_GAP = 8;

    /* A rewrite is one round trip but up to three model calls (first draft, the
     * hard-fact repair, the acceptance-section retry). A live clean run measures
     * ~4s, so 90s is roughly 20x the happy path: generous enough never to kill a
     * slow-but-alive rewrite, tight enough that a wedged provider cannot leave
     * the trigger disabled forever. The timeout is a BACKSTOP — the user's own
     * way out is clicking the trigger again, which aborts immediately. */
    const REWRITE_TIMEOUT_MS = 90000;

    function usePopoverPlacement(open, triggerRef, popRef) {
      const [pos, setPos] = React.useState(null);
      const place = React.useCallback(() => {
        const el = triggerRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const menu = popRef.current;
        const lw = menu ? menu.offsetWidth : 0;
        const width = lw > 0 ? lw : Math.min(POPOVER_WIDTH, window.innerWidth - POPOVER_MARGIN * 2);
        /* Centre the panel on the trigger, then clamp to the viewport. Anchoring
         * either edge (right-to-right, then left-to-left) always parks the panel
         * off to one side of the button; the pointer opens it and then has to
         * travel. Centre-on-trigger puts the ink directly over the pointer, and
         * the clamp only moves it when the button is too near a screen edge to
         * fit the panel at all. */
        let left = rect.left + rect.width / 2 - width / 2;
        left = Math.min(Math.max(left, POPOVER_MARGIN), window.innerWidth - width - POPOVER_MARGIN);
        const above = rect.top - POPOVER_GAP - POPOVER_MARGIN;
        const below = window.innerHeight - rect.bottom - POPOVER_GAP - POPOVER_MARGIN;
        const openUp = above >= POPOVER_MIN || above >= below;
        if (openUp) {
          setPos({
            left,
            bottom: window.innerHeight - rect.top + POPOVER_GAP,
            maxHeight: Math.min(POPOVER_MAX, Math.max(POPOVER_MIN, above)),
          });
        } else {
          setPos({
            left,
            top: rect.bottom + POPOVER_GAP,
            maxHeight: Math.min(POPOVER_MAX, Math.max(POPOVER_MIN, below)),
          });
        }
      }, [triggerRef, popRef]);
      return { pos, place };
    }

    /**
     * Rewrites that finished after their card was already gone.
     *
     * Switching sessions disposes the input shell: the host detaches the
     * editor's update listener (`unregister()`), so nothing re-projects and
     * `rev` stops advancing, and it unbinds the store writer. A write landing
     * after that point edits the abandoned editor and never reaches the
     * per-session store — so reading the draft back on return shows the
     * original text, no matter how long we wait.
     *
     * The result is therefore parked here, keyed by session, and written on the
     * next mount of that session's card, when the fresh actions belong to a
     * live shell. Module scope, not component state: the whole point is to
     * outlive the component. The map is small (one entry per session that had a
     * rewrite land while backgrounded) and each entry clears on delivery, so a
     * stale rewrite can never be replayed twice.
     */
    const pendingWrites = new Map();

    /* sessionId -> { from, to }: the last replacement this plugin wrote into a
     * composer, kept so the trigger can offer one-click undo. Keyed by session
     * for the same reason as pendingWrites — the card unmounts on a session
     * switch, and the record has to outlive it. An entry is honoured only while
     * the composer still holds exactly `to`; once the user types or presses
     * Ctrl+Z, the record is dropped and the click means "rewrite" again. */
    const lastApply = new Map();

    /* One composer write = three persisted flushes, at three tick depths. The
     * host projects the composer into its per-session store on its own schedule,
     * so a single persistDraft() fired in the same tick as setDraft can run
     * before that store has seen the new text — and a session switch right
     * afterwards then reads the OLD draft back. The microtask lands after the
     * editor commit, the frame after React's re-render. Re-flushing an already
     * persisted draft is a no-op, so the extra calls are free. */
    function flushDraft(actions) {
      if (!actions || typeof actions.persistDraft !== 'function') return;
      actions.persistDraft();
      Promise.resolve().then(() => {
        try { actions.persistDraft(); } catch (error) { /* the draft is already in the editor */ }
      });
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
          try { actions.persistDraft(); } catch (error) { /* frame torn down before we ran */ }
        });
      }
    }

    async function api(command, payload, signal) {
      const res = await fetch('/prompt-forge/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command, ...payload }),
        ...(signal === undefined ? {} : { signal }),
      });
      const body = await res.json().catch(() => ({ ok: false, error: 'bad response' }));
      if (!body.ok) throw new Error(body.error || command + ' failed');
      return body;
    }

    /**
     * Live view of the composer draft for one session.
     * Returns { draft, actions } and re-subscribes whenever the session changes.
     */
    function useComposerDraft(ctx, sessionId) {
      const [view, setView] = React.useState({ draft: '', actions: null, ready: false });

      React.useEffect(() => {
        if (!sessionId) { setView({ draft: '', actions: null, ready: false }); return undefined; }
        const uiSession = ctx.get('uiSession');
        const sessions = ctx.get('sessions');
        if (!uiSession || !sessions || typeof sessions.binding !== 'function') {
          setView({ draft: '', actions: null, ready: false });
          return undefined;
        }

        let source = null;
        try {
          const owner = sessions.binding(sessionId);
          if (owner) source = uiSession.bindingSource({ sessionId, binding: owner });
        } catch (error) {
          source = null;
        }
        if (!source || typeof source.subscribe !== 'function') {
          setView({ draft: '', actions: null, ready: false });
          return undefined;
        }

        let inputSource = null;
        let offInput = null;

        const read = () => {
          let binding = null;
          try { binding = source.getSnapshot(); } catch (error) { binding = null; }
          const nextInput = binding && binding.hooks ? binding.hooks.input : null;
          if (nextInput && nextInput !== inputSource) {
            if (offInput) { offInput(); offInput = null; }
            inputSource = nextInput;
            if (typeof inputSource.subscribe === 'function') offInput = inputSource.subscribe(read);
          }
          let snapshot = null;
          try { snapshot = inputSource ? inputSource.getSnapshot() : null; } catch (error) { snapshot = null; }
          const draft = snapshot && typeof snapshot.draft === 'string' ? snapshot.draft : '';
          const actions = binding && binding.props ? binding.props.inputActions : null;
          setView({ draft, actions: actions || null, ready: true });
        };

        read();
        const offSource = source.subscribe(read);
        return () => {
          offSource();
          if (offInput) offInput();
        };
      }, [ctx, sessionId]);

      return view;
    }

    /* No backticks anywhere inside this template literal (see contract #3). */
    const CSS = `
.pf-root{position:relative;display:inline-flex;flex:none;font-size:13px;color:var(--dsw-alias-label-primary)}
.pf-btn{display:inline-flex;align-items:center;justify-content:center;flex:none;
  width:28px;height:28px;box-sizing:border-box;padding:0;background:0 0;border:0;
  border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);
  font:inherit;cursor:pointer}
.pf-btn:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary)}
.pf-btn[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary)}
.pf-btn:focus-visible{outline:none;box-shadow:0 0 0 var(--dsw-focus-ring-width,2px) var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary)))}
.pf-btn[aria-disabled="true"]{cursor:progress;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));opacity:.55}
.pf-btn[aria-disabled="true"]:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-secondary)}
/* While busy the button holds nothing but the ring, so the 55% dim on
 * aria-disabled lands on the ring itself and washes it out: a near-black pen at
 * 55% over the toolbar surface resolves to about rgb(127,127,127), lighter than
 * the grey we started from. That makes "make the arc darker" unachievable by
 * picking a darker colour alone — the dim has to come off. Motion is already the
 * busy signal, so the dim was redundant here; the ring now runs at full opacity
 * and reads as the near-black reference does. */
.pf-btn[data-busy="true"]{opacity:1}
/* The second click takes the rewrite back instead of starting another. Tone
 * shifts, shape does not: the spark still means "this button writes the draft",
 * the tint says "this time it writes it back". */
.pf-btn[data-undo="true"]{color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary))}
/* Both marks stay mounted and the state is carried by opacity alone. Swapping
 * the elements instead (a ternary on busy) made the button blink: the spark
 * vanished and the ring appeared in the same frame, which reads as a redraw
 * rather than as the same control entering a new phase. 120ms is long enough to
 * read as a transition and short enough that a fast request never shows a
 * half-faded glyph. The two marks are equal-weight, so crossfading them at one
 * spot reads as one thing changing, not two things trading places. */
.pf-glyph{position:relative;display:block;width:15px;height:15px}
/* The opacity and its transition live on the same element — putting the fade on
 * a wrapper while the transition sits on the inner .ico animates nothing. */
.pf-glyph .ico{position:absolute;inset:0;transition:opacity 120ms linear}
.pf-glyph-idle .ico{opacity:1}
.pf-glyph-busy .ico{opacity:0}
/* Third layer: the "this click takes it back" mark. Hidden by default like the
 * spinner, revealed by data-undo. Busy wins over undo — a running request means
 * the cancel semantics, never the revert. */
.pf-glyph-undo .ico{opacity:0}
.pf-btn[data-undo="true"] .pf-glyph-idle .ico{opacity:0}
.pf-btn[data-undo="true"] .pf-glyph-undo .ico{opacity:1}
.pf-btn[data-busy="true"] .pf-glyph-undo .ico{opacity:0}
.pf-btn[data-busy="true"] .pf-glyph-idle .ico{opacity:0}
/* The spin lives on the ring mark itself, not on .ico: both marks are mounted at
 * all times, so an .ico-wide animation would also spin the spark while it fades
 * out. Because the ring is never unmounted, its rotation is already underway the
 * moment it becomes visible — the ring does not start from zero on every click. */
.pf-btn[data-busy="true"] .pf-glyph-busy .ico{opacity:1;animation:pf-spin .95s linear infinite}
.pf-btn[data-busy="true"] .ico{color:var(--dsw-alias-label-primary,currentColor)}
.pf-line.pf-busy{display:flex;align-items:center;gap:6px}
/* Both carriers of the ring use the primary label colour, not the tertiary one.
 * The tertiary grey read as a hairlight next to the near-black reference arc
 * (measured rgb(22,22,22) at its darkest), and the panel line sits directly
 * beside body text, so a light ring next to dark text looked like a disabled
 * control rather than an active one. */
.pf-spin{flex:none;width:11px;height:11px;box-sizing:border-box;color:var(--dsw-alias-label-primary,currentColor);animation:pf-spin .95s linear infinite}
.pf-spin svg{display:block;width:11px;height:11px}
/* The ring is a nearly-closed circle with one small opening, measured off the
 * reference capture: 294 degrees drawn, a constant 66 degree gap, no dim track
 * underneath (the gap reads as pure background), turning once per 0.95s. An
 * earlier draft drew a short 86 degree dash over a fading full ring, which at
 * 15px collapsed into "a thin line orbiting" rather than "a ring with a notch".
 * The gap is longer than the leftover circumference on purpose: a dash pattern
 * whose sum equals the path length would tile exactly once and leave a hairline
 * seam where the dash restarts.
 *
 * The rotation is deliberately NOT on this circle: a CSS animation on an SVG
 * shape resolves transform-origin against the view-box origin (0 0), so the
 * marked circle swung around the top-left corner of the 20x20 view-box and
 * spent most of each turn clipped outside the 15px icon box — an intermittent
 * spinner that looked like it was not there at all. The spin belongs to the
 * box (.ico / .pf-spin), which rotates about its own centre like any element. */
.pf-spin-arc{stroke-dasharray:41 60}
.pf-spin-arc{fill:none;stroke:currentColor}
/* The reference ring is genuinely heavy: stroke 2.6px against an 8.85px radius,
 * a stroke-to-radius ratio near 0.29. Both carriers here draw r=8 inside a 20x20
 * view-box, so one view-box stroke value yields one ratio regardless of the pixel
 * size they are scaled to — 2.4/8 = 0.30 matches the capture in either place. The
 * 2-unit presentation attribute would give 0.25, visibly thinner than the
 * reference. The panel ring used to keep that default while only the trigger was
 * thickened, which left the same state drawn at two weights side by side. */
.pf-btn .ico .pf-spin-arc{stroke-width:2.4}
.pf-spin .pf-spin-arc{stroke-width:2.4}
@keyframes pf-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){
  /* The busy animation is the ONLY signal that a rewrite is running, so it must
   * not be deleted outright — an earlier version set animation:none here and, on
   * a machine that reports reduce, the trigger looked completely idle while a
   * request was in flight. Slowing it down honours the intent (less motion)
   * while keeping the state readable. The gap stays put, so the ring is still
   * legible as a load indicator when it crawls. */
  .pf-btn[data-busy="true"] .pf-glyph-busy .ico{animation-duration:4s}
  /* The crossfade is decorative motion, so it goes away entirely under reduce —
   * unlike the spin, which is the only busy signal and is merely slowed. */
  .pf-glyph .ico{transition:none}
  .pf-spin{animation-duration:4s}
}
.pf-btn .ico{width:15px;height:15px;fill:currentColor}
.pf-pop{position:fixed;z-index:1100;display:flex;flex-direction:column;gap:8px;
  box-sizing:border-box;
  width:268px;min-width:min(228px,calc(100vw - 32px));
  max-width:min(268px,calc(100vw - 32px));max-height:min(360px,calc(100vh - 96px));
  padding:10px 12px;overflow:hidden;border:0;border-radius:var(--dsw-radius-lg);
  background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay));
  -webkit-backdrop-filter:var(--dsw-menu-backdrop-filter);backdrop-filter:var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color:var(--dsw-alias-border-l1);
  box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);
  --dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
.pf-body{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:6px}
.pf-line{font-size:12px;line-height:18px}
.pf-line.muted{color:var(--dsw-alias-label-secondary)}
.pf-err{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.pf-done{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-2)}
.pf-done-h{font-size:12px;line-height:17px;font-weight:600;color:var(--dsw-alias-label-primary)}
.pf-done-b{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary)}
/* The acceptance verdict on the one-click receipt. Same colours as .pf-fact so
 * "nothing checkable" reads as neutral information rather than a failure. */
.pf-done-a{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.pf-done-a.warn{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-state-error-primary))}
/* The invented-literal row carries the literals themselves in its tooltip; a
 * list of paths set as visible text would wrap the panel to three lines and
 * push the rewrite off screen. The ellipsis is what tells the user to hover. */
.pf-done-a[title]{cursor:help;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The cost row. Muted and rule-free on purpose: it is context for the
 * decision, not a measurement of the rewrite, and it must never compete
 * visually with the fact counter above it or the judgement below it. */
.pf-cost{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);opacity:.85}
.pf-cost.muted{opacity:.7;font-style:italic}.pf-fact{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.pf-fact.warn{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-state-error-primary))}
/* The judgement row. It gets its own class rather than reusing .pf-fact
 * because the two report different KINDS of claim: .pf-fact is a deterministic
 * count this plugin can prove, .pf-judge is a model's opinion about its own
 * output. The left rule marks it as a comment on the rewrite rather than a
 * measurement of it, so a green judgement cannot borrow authority from the fact
 * counter sitting above it. */
.pf-judge{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary);
  padding-left:6px;border-left:2px solid var(--dsw-alias-border-l1)}
.pf-judge.warn{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-state-error-primary))}
/* An unanswered judgement. Muted on purpose: 'the judge did not answer' must
 * never render like 'the judge approved'. */
.pf-judge.muted{opacity:.7}
.pf-preview{display:flex;flex-direction:column;gap:6px;min-height:0}
.pf-pane{display:flex;flex-direction:column;min-height:0;overflow:hidden;
  border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md)}
.pf-pane-h{flex:0 0 auto;padding:3px 7px;font-size:11px;line-height:16px;
  color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.pf-pane-b{flex:1 1 auto;min-height:0;max-height:96px;overflow-y:auto;padding:5px 7px;
  font-size:12px;line-height:17px;white-space:pre-wrap;word-break:break-word}
.pf-actions{flex:0 0 auto;display:flex;gap:6px;padding-top:8px;margin-top:8px;
  border-top:1px solid var(--dsw-alias-border-l1)}
.pf-act{flex:1 1 auto;height:28px;padding:0 10px;font:inherit;font-size:12px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);
  background:0 0;color:var(--dsw-alias-label-primary)}
.pf-act:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.pf-act[disabled]{opacity:.5;cursor:default}
.pf-act-primary{background:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary));
  border-color:transparent;color:var(--dsw-alias-label-on-primary,#fff)}
.pf-act-primary:hover{filter:brightness(1.06)}
.pf-foot{flex:0 0 auto;padding-top:8px;margin-top:8px;border-top:1px solid var(--dsw-alias-border-l1);
  color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:16px}
/* Mode is a SINGLE choice and docs is an independent TOGGLE, but both used to
 * render as identical solid-blue pills, so the panel showed two competing
 * primary actions and no way to tell a radio from a switch. The mode pair is
 * now one segmented track (exactly one segment filled, white on grey) and the
 * docs toggle is a separate outlined pill with a check mark. No blue at all in
 * this row: blue stays reserved for the real commit action (pf-act-primary). */
.pf-modes{flex:0 0 auto;display:flex;align-items:center;gap:6px}
.pf-seg{flex:none;display:inline-flex;align-items:center;gap:2px;padding:2px;
  box-sizing:border-box;border-radius:999px;
  background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.pf-mode{flex:none;display:inline-flex;align-items:center;justify-content:center;
  height:24px;padding:0 10px;box-sizing:border-box;white-space:nowrap;
  font:inherit;font-size:11.5px;line-height:1;cursor:pointer;
  border:0;border-radius:999px;background:0 0;color:var(--dsw-alias-label-secondary);
  transition:background .12s ease,color .12s ease}
.pf-mode:hover{color:var(--dsw-alias-label-primary)}
.pf-mode:focus-visible{outline:none;
  box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary))}
.pf-mode.on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);
  font-weight:600;box-shadow:0 0 0 .5px #00000014,0 1px 2px #0000000f}
.pf-docs{margin-left:auto;display:inline-flex;align-items:center;gap:4px;
  height:28px;padding:0 9px;box-sizing:border-box;
  font:inherit;font-size:11.5px;line-height:1;cursor:pointer;white-space:nowrap;
  flex:0 0 auto;
  border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:0 0;
  color:var(--dsw-alias-label-secondary)}
.pf-docs:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.pf-docs:focus-visible{outline:none;
  box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary))}
.pf-docs.on{color:var(--dsw-alias-label-primary);
  border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
/* The tick always occupies its slot and only fades in, so toggling never
 * reflows the pill or shifts the text. */
.pf-docs .tick{flex:none;width:10px;height:10px;fill:none;stroke:currentColor;
  stroke-width:2;stroke-linecap:round;stroke-linejoin:round;
  opacity:0;transition:opacity .12s ease}
.pf-docs.on .tick{opacity:1}
@media (prefers-reduced-motion:reduce){
  .pf-mode{transition:none}
  .pf-docs .tick{transition:none}
}
`;

    /* The idle mark: the four-point spark the composer knows us by. Only shown
     * when nothing is running — a busy trigger swaps in the arc spinner below,
     * because spinning this star in place reads as "random decoration turning"
     * rather than "something is loading". */
    function SparkIcon() {
      return h('svg', { className: 'ico', viewBox: '0 0 16 16', 'aria-hidden': true },
        h('path', { d: 'M8 1.2 L9.6 6.4 L14.8 8 L9.6 9.6 L8 14.8 L6.4 9.6 L1.2 8 L6.4 6.4 Z' }));
    }

    /* The busy mark: one bold ring with a single notch, turning once per 0.95s.
     * Measured off the reference capture rather than invented: 294 degrees drawn,
     * a constant 66 degree opening, no dim track beneath it, and a circumference
     * that leaves the gap wider than the ring so the dash never tiles into a
     * visible seam. Both the trigger and the panel line mount this same SVG so
     * one loading state never wears two costumes; the rotation lives on whichever
     * element wraps it (.ico on the button, .pf-spin in the line), and
     * currentColor lets each surface inherit its own label tier. */
    function SpinIcon(props) {
      return h('svg', {
        className: props && props.className,
        viewBox: '0 0 20 20', 'aria-hidden': true, focusable: 'false',
      },
        h('circle', { className: 'pf-spin-arc', cx: '10', cy: '10', r: '8',
          fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' }));
    }

    /* The undo mark: a half-circle arc with its arrowhead on the open end. Shown
     * only while the trigger's click would take the last rewrite back — leaving
     * the spark there would promise a fresh rewrite the click is not going to
     * perform. Drawn with strokes rather than the filled path the spark uses: a
     * solid arrow at 15px collapses into a blob, while a 1.55 stroke keeps both
     * the arc and the head legible. */
    function UndoIcon() {
      return h('svg', { className: 'ico', viewBox: '0 0 16 16', 'aria-hidden': true, focusable: 'false' },
        h('path', {
          d: 'M4.4 5.8 H9.0 A3.4 3.4 0 0 1 9.0 12.6 H6.8',
          fill: 'none', stroke: 'currentColor',
          'stroke-width': '1.55', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        }),
        h('path', {
          d: 'M6.9 3.3 L4.1 5.8 L6.9 8.3',
          fill: 'none', stroke: 'currentColor',
          'stroke-width': '1.55', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        }));
    }

    /* ── settings (P2) ──────────────────────────────────────────────────
     * Two copies, on purpose: localStorage is always writable and therefore
     * authoritative for this browser; the workspace file survives a different
     * machine. A failed host write is a downgrade, never an error. */
    const SETTINGS_KEY = 'dsh-prompt-forge:settings';
    /* ONE source of truth for the mode ids: the mode row renders from it and the
     * read path validates against it, so the row and the whitelist cannot drift.
     * The Host keeps its own copy (index.js AVAILABLE_MODES) and rejects
     * anything else with 400 "mode not available". */
    const MODE_IDS = ['polish', 'acceptance'];
    const MODE_LABEL_KEYS = { polish: 'modePolish', acceptance: 'modeAcceptance' };
    const MODE_ID_SET = new Set(MODE_IDS);
    const DEFAULT_MODE = 'polish';
    const DEFAULT_SETTINGS = { mode: DEFAULT_MODE, workspaceDocs: true };

    /* The stored value is a map of workspace cwd -> settings. Keying by
     * workspace matters: one browser is normally used for several projects,
     * and a single flat key made workspace B silently inherit workspace A's
     * mode. A legacy flat object (<= 0.3.1) is read into the "" bucket only,
     * so a real workspace falls back to its own file or the defaults instead
     * of inheriting another project's choice. */
    function readSettingsStore() {
      try {
        const raw = window.localStorage.getItem(SETTINGS_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        if ('mode' in parsed || 'workspaceDocs' in parsed) return { '': parsed };
        return parsed;
      } catch { return {}; }
    }

    function readLocalSettings(cwd) {
      const bucket = readSettingsStore()[cwd || ''];
      return bucket && typeof bucket === 'object' && !Array.isArray(bucket) ? bucket : null;
    }

    /* THE FIX for 开放项 1 (unknown mode id silently killed every rewrite).
     * A stale/typo'd mode id used to flow straight through the spread merge,
     * light up NEITHER mode button (so the UI looked blank rather than broken)
     * and get POSTed as-is, where the Host answered 400 "mode not available".
     * A value the UI cannot represent must never leave this module: anything
     * outside the whitelist falls back to the default instead of surviving the
     * merge. Every read path (initial state, workspace bucket, workspace file)
     * goes through here, so a dirty value cannot re-enter by a side door. */
    function sanitizeSettings(raw) {
      const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      return {
        mode: MODE_ID_SET.has(source.mode) ? source.mode : DEFAULT_MODE,
        workspaceDocs: typeof source.workspaceDocs === 'boolean'
          ? source.workspaceDocs
          : DEFAULT_SETTINGS.workspaceDocs,
      };
    }

    function writeLocalSettings(cwd, settings) {
      try {
        const store = readSettingsStore();
        store[cwd || ''] = settings;
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(store));
      } catch { /* quota — ignore */ }
    }

    function useSettings(sessionId) {
      const [settings, setSettings] = React.useState(() => sanitizeSettings(readLocalSettings('')));
      /* The workspace decides the localStorage bucket, and only the host knows
       * it, so it is resolved once per session and kept in state. */
      const [cwd, setCwd] = React.useState('');

      React.useEffect(() => {
        let alive = true;
        (async () => {
          let resolved = '';
          let remote = null;
          try {
            const body = await api('settings-get', { sessionId: sessionId || '' });
            if (body && typeof body.cwd === 'string') resolved = body.cwd;
            remote = body && body.settings;
          } catch { /* no workspace, no route — defaults are fine */ }
          if (!alive) return;
          setCwd(resolved);
          /* A local copy means this browser already has the user's choice for
           * THIS workspace; do not let an older workspace file overwrite it. */
          const local = readLocalSettings(resolved);
          if (local) { setSettings(sanitizeSettings(local)); return; }
          if (remote && typeof remote === 'object' && Object.keys(remote).length > 0) {
            setSettings(sanitizeSettings(remote));
          }
        })();
        return () => { alive = false; };
      }, [sessionId]);

      /* Side effects stay OUTSIDE the updater: React may invoke an updater
       * more than once (StrictMode, replayed renders), and doing the POST in
       * there sent the same settings write twice. Computing `next` from the
       * current state keeps the value correct without an updater. */
      const update = React.useCallback((patch) => {
        /* Sanitizing the write side too: an unknown mode must never reach
         * localStorage or the Host, whatever the caller passed. */
        const next = sanitizeSettings({ ...settings, ...patch });
        setSettings(next);
        writeLocalSettings(cwd, next);
        api('settings-set', { sessionId: sessionId || '', settings: next }).catch(() => { /* degrade silently */ });
      }, [sessionId, cwd, settings]);

      return { settings, update };
    }

    function CheckIcon() {
      return h('svg', { className: 'tick', viewBox: '0 0 10 10', 'aria-hidden': true },
        h('path', { d: 'M1.5 5.2 L4 7.6 L8.5 2.4' }));
    }

    function ModeRow({ settings, update, t, disabled }) {
      /* Rendered FROM the whitelist, so "which buttons exist" and "which ids
       * are legal" can never disagree again.
       *
       * The two modes are a radiogroup, not two independent buttons: the Host
       * accepts exactly one mode per rewrite, so exposing them as pressed/
       * unpressed toggles told screen readers a lie ("you can have both"). The
       * docs switch really IS independent, so it keeps aria-pressed but gets a
       * visibly different control — an outlined pill with a tick — instead of
       * borrowing the mode pill's look. */
      const modes = MODE_IDS.map((id) => ({ id, label: t(MODE_LABEL_KEYS[id]) }));
      return h('div', { className: 'pf-modes' },
        h('div', { className: 'pf-seg', role: 'radiogroup', 'aria-label': t('modeGroup') },
          modes.map((mode) => h('button', {
            key: mode.id,
            type: 'button',
            role: 'radio',
            className: 'pf-mode' + (settings.mode === mode.id ? ' on' : ''),
            'aria-checked': settings.mode === mode.id ? 'true' : 'false',
            /* roving tabindex: one stop for the whole group, like a real radio
             * group, so Tab does not walk through every option. */
            tabIndex: settings.mode === mode.id ? 0 : -1,
            disabled: disabled ? true : undefined,
            onClick: () => update({ mode: mode.id }),
          }, mode.label))),
        h('button', {
          type: 'button',
          className: 'pf-docs' + (settings.workspaceDocs ? ' on' : ''),
          'aria-pressed': settings.workspaceDocs ? 'true' : 'false',
          'aria-label': t('docsToggle') + '：' + t('docsHint'),
          disabled: disabled ? true : undefined,
          onClick: () => update({ workspaceDocs: !settings.workspaceDocs }),
        }, h(CheckIcon), t('docsToggle')),
      );
    }

    /* One place that knows what the three acceptance states are called, used by
     * both the preview line and the one-click receipt. They diverged once: the
     * receipt counted facts only, so acceptance mode reported nothing at all on
     * the path every click actually takes. */
    function acceptanceText(acceptance, t) {
      if (!acceptance || !acceptance.required) return '';
      if (acceptance.present) return t('acceptanceOk');
      if (acceptance.declared) return t('acceptanceDeclared');
      return t('acceptanceMissing');
    }

    function acceptanceWarn(acceptance) {
      if (!acceptance || !acceptance.required) return false;
      return !acceptance.present && !acceptance.declared;
    }

    /* The two outcomes the Host already reports as first-class fields but the
     * card used to drop on the floor. Both mean "what you are about to paste is
     * not what you think it is":
     *   truncated — the model ran out of budget mid-sentence, so the text is
     *               unfinished, not merely shorter than hoped.
     *   invented  — the model wrote a path/version/identifier the draft never
     *               contained. The loss gate never looked for this direction,
     *               so silence here would read as "nothing was fabricated".
     * Returned as a list so the receipt and the preview fallback share ONE
     * definition; letting them diverge is what made acceptance mode mute in the
     * first place. */
    function alertTexts(source, t) {
      if (!source) return [];
      const out = [];
      if (source.truncated === true) out.push({ text: t('truncatedWarn'), warn: true });
      const facts = source.facts;
      if (facts && Array.isArray(facts.invented) && facts.invented.length > 0) {
        out.push({
          text: t('factInvented') + ' ' + facts.invented.length,
          warn: true,
          /* The count alone tells a user something happened but not WHAT. The
           * literals go in the tooltip: a row of paths would wrap the panel
           * into three lines and push the rewrite out of view. */
          detail: facts.invented.join(' · '),
        });
      }
      return out;
    }

    function AlertLines({ source, t }) {
      const alerts = alertTexts(source, t);
      if (alerts.length === 0) return null;
      return h(React.Fragment, null, alerts.map((alert, i) => h('div', {
        key: 'alert-' + i,
        className: 'pf-done-a' + (alert.warn ? ' warn' : ''),
        title: alert.detail || undefined,
      }, alert.text)));
    }

    function MetaLine({ result, t }) {
      if (!result) return null;
      const parts = [];
      const docs = result.context && Array.isArray(result.context.workspaceDocs) ? result.context.workspaceDocs : [];
      if (docs.length > 0) parts.push(t('docsUsed') + ' ' + docs.map((d) => d.name).join(', '));
      /* Three cases, not two. "declared" is the model saying, in the agreed
       * token, that the draft has nothing checkable — that is an honest
       * outcome and must not be painted as a failure, or the next thing the
       * model learns is to invent a section to avoid the yellow line. */
      const accText = acceptanceText(result.acceptance, t);
      if (accText) parts.push(accText);
      if (parts.length === 0) return null;
      const warn = acceptanceWarn(result.acceptance);
      return h('div', { className: 'pf-fact' + (warn ? ' warn' : '') }, parts.join(' · '));
    }

    /* The cost row. Its own component, and its own collapse rule, because a
     * number with a currency sign is the easiest thing in this panel to
     * misread as a bill: every field it needs (the estimate flag, the period,
     * the call count) is printed beside the amount rather than tucked into a
     * tooltip, so the caveats cannot be missed by someone reading only the
     * total. Absent when no usage was reported at all — the line then says so
     * in words instead of showing a confident zero. */
    function CostLine({ result, t }) {
      if (!result) return null;
      const cost = result.cost;
      const calls = result.usageTotal && typeof result.usageTotal.calls === 'number' ? result.usageTotal.calls : 0;
      if (!cost || typeof cost.amount !== 'number') {
        /* Only speak when something was spent but left unreported: an ordinary
         * response with no provider usage should not grow a line announcing
         * nothing. */
        if (calls <= 0) return null;
        return h('div', { className: 'pf-cost muted' }, t('costUnknown'));
      }
      /* Four decimals below a cent, two above: one rewrite usually costs a
       * fraction of one, and rounding it to '¥0.00' would read as free. */
      const amount = cost.amount < 0.01 ? cost.amount.toFixed(4) : cost.amount.toFixed(2);
      const symbol = cost.currency === 'CNY' ? '¥' : (cost.currency === 'USD' ? '$' : String(cost.currency || '') + ' ');
      const period = cost.period === 'peak' ? t('costPeak') : t('costOffPeak');
      const multiplier = cost.multiplier > 1 ? ' ×' + cost.multiplier : '';
      return h('div', { className: 'pf-cost' },
        t('costEstimate') + ' ' + symbol + amount
        + ' · ' + period + multiplier
        + (calls > 0 ? ' · ' + calls + ' ' + t('costCalls') : ''));
    }

    function FactLine({ result, t }) {
      if (!result || !result.facts) return null;
      const facts = result.facts;
      const warn = facts.missing && facts.missing.length > 0;
      /* total === 0 means the draft carried no literal at all (no path, URL,
       * code span, identifier, version). The gate did its job — nothing to
       * protect. Printing "0/0" reads like a failure, so say so in words. */
      const text = facts.total === 0
        ? t('factNone')
        : t('factKept') + ' ' + facts.kept + '/' + facts.total;
      /* The cap used to shrink `total` with nothing said, so "34/34" looked like
       * a clean sweep while facts 35+ were never guarded. The count alone cannot
       * carry that, because it is exactly the number that lies. */
      const capped = facts.capped === true ? ' · ' + t('factCapped') : '';
      return h('div', { className: 'pf-fact' + (warn ? ' warn' : '') },
        warn ? text + ' · ' + t('factFixed') + ' ' + facts.missing.length + capped : text + capped);
    }

    /* The judgement line. Deliberately NOT folded into the fact counter or the
     * acceptance line: those two report deterministic gates this plugin owns,
     * and this one reports a model's opinion about its own output. Merging them
     * into a single score-like row would let the opinion borrow the authority of
     * the machine checks next to it. So it is its own line, with its own colour,
     * and it says who said it.
     *
     * Three states, not two, and the third one is the important one:
     *   judged=false  — the judge did not answer. Shown as muted text, never as
     *                   a pass. Silence must not read as approval.
     *   verdict=ok    — all four signals clean and no conflicts.
     *   verdict=fix/check — something to look at, with the reason attached.
     */
    function judgeText(judge, t) {
      if (!judge || judge.enabled !== true) return '';
      if (judge.judged !== true) return t('judgeAbsent');
      const verdict = judge.verdict;
      if (verdict === 'ok') return t('judgeOk');
      if (verdict === 'fix') return t('judgeFix');
      if (verdict === 'check') return t('judgeCheck');
      return t('judgeAbsent');
    }

    /* Which signals fired, in words. Only the alarming ones are named: listing
     * four values including three clean ones buries the one that matters, and a
     * user reads a row of green as reassurance about the row rather than about
     * the rewrite. */
    function judgeDetail(judge, t) {
      if (!judge || judge.judged !== true || !judge.signals) return '';
      const parts = [];
      const s = judge.signals;
      if (s.fidelity === 'fail') parts.push(t('judgeFidelityFail'));
      if (s.depth === 'rephrased-only') parts.push(t('judgeDepthShallow'));
      if (s.depth === 'compressed') parts.push(t('judgeDepthCompressed'));
      if (s.grounding === 'invented') parts.push(t('judgeGroundingInvented'));
      else if (s.grounding === 'inferred') parts.push(t('judgeGroundingInferred'));
      if (s.executability === 'blocked') parts.push(t('judgeExecBlocked'));
      else if (s.executability === 'needs-clarification') parts.push(t('judgeExecClarify'));
      return parts.join(' · ');
    }

    /* Conflicts get their own tooltip rather than a visible row: each one is a
     * sentence about why two answers cannot both be true, which is too long for
     * a 268px panel and is only interesting to a user who already suspects the
     * verdict. The verdict itself already says 'check'. */
    function judgeConflictHint(judge, t) {
      if (!judge || judge.judged !== true || !Array.isArray(judge.conflicts) || judge.conflicts.length === 0) return '';
      return judge.conflicts.map((key) => t('conflict_' + key) || key).join(' · ');
    }

    function JudgeLine({ source, t }) {
      const text = judgeText(source && source.judge, t);
      if (text === '') return null;
      const judge = source.judge;
      const detail = judgeDetail(judge, t);
      const reason = judge && judge.judged === true && judge.reason ? judge.reason : '';
      const conflicts = judgeConflictHint(judge, t);
      const warn = judge && judge.judged === true && (judge.verdict === 'fix' || judge.verdict === 'check');
      const tip = [reason, conflicts].filter((x) => x !== '').join(' · ');
      return h('div', {
        className: 'pf-judge' + (warn ? ' warn' : '') + (judge && judge.judged === true ? '' : ' muted'),
        title: tip || undefined,
      }, detail === '' ? text : text + ' · ' + detail);
    }

    function Preview({ draft, result, t }) {
      return h('div', { className: 'pf-preview' },
        h('div', { className: 'pf-pane' },
          h('div', { className: 'pf-pane-h' }, t('labelOriginal')),
          h('div', { className: 'pf-pane-b' }, draft),
        ),
        h('div', { className: 'pf-pane' },
          h('div', { className: 'pf-pane-h' }, t('labelRewrite')),
          h('div', { className: 'pf-pane-b' }, result.rewrite),
        ),
      );
    }

    function ForgeCard({ ctx, sessionId, t, runRef, cancelRef, undoRef, onBusy, onCanUndo, open, pos, popRef, onMouseEnter, onMouseLeave }) {
      const { draft, actions, ready } = useComposerDraft(ctx, sessionId);
      const { settings, update } = useSettings(sessionId);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [result, setResult] = React.useState(null);
      /* The receipt of a one-click replacement. `rewrite` is kept so the notice
       * can go stale by itself: once the composer draft no longer equals what we
       * wrote (Ctrl+Z, or the user typing), the claim "已替换" stops being true
       * and the line disappears without any extra bookkeeping. */
      const [notice, setNotice] = React.useState(null);
      /* An abort is not a failure, so it must not reuse the red error line. This
       * holds the replacement text for a cancelled/timed-out run and renders in
       * the muted style instead. */
      const [quiet, setQuiet] = React.useState('');

      /* The in-flight call's abort handle plus its timeout id. A ref (not state)
       * because aborting is an event, not something the UI renders: the click
       * handler reads it synchronously, and changing it must never itself cause
       * a render. `mounted` guards the late setState after an unmount. */
      const abortRef = React.useRef(null);
      const timerRef = React.useRef(null);
      /* True until this card unmounts. Late setState calls after that point are
       * dropped (React would warn, and there is no UI to update), but the
       * composer write is NOT conditional on it — see the unmount effect. */
      const mountedRef = React.useRef(true);

      /* Stop whatever is running, right now. Returns true when there really was
       * something to stop — that is what lets the trigger tell "the click landed
       * on a live request" apart from "the click was the normal start". */
      const cancel = React.useCallback(() => {
        const controller = abortRef.current;
        if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null; }
        if (!controller || controller.signal.aborted) return false;
        abortRef.current = null;
        controller.abort();
        return true;
      }, []);

      /* Unmounting used to abort the in-flight call. That was the bug behind
       * "the rewrite disappears after switching sessions": leaving a session
       * unmounts this card, the abort killed the fetch, so the result never
       * arrived and nothing was ever written into the composer — coming back
       * showed the untouched draft. The request is therefore left to finish;
       * its result is still written through the actions this render captured,
       * which belong to the session that asked for it. `mountedRef` only stops
       * the late setState calls (React warns on those); it does not gate the
       * write, because the write is the whole point. */
      React.useEffect(() => () => {
        mountedRef.current = false;
      }, []);

      /* Write the rewrite into the composer, in ONE click. The composer's own
       * undo stack collapses this into a single Ctrl+Z (verified on the live
       * build), so Ctrl+Z — not a preview — is the way back. */
      const replaceDraft = React.useCallback((body, from) => {
        if (!actions || typeof actions.setDraft !== 'function') return false;
        /* A rewrite identical to the source is not an edit. Writing it anyway
         * pushes a no-op onto the composer's undo stack and then claims
         * "已替换草稿" about text that did not change — the receipt would be
         * reporting an event that never happened. This is reachable in normal
         * use: a draft with nothing to change ("优化一下" plus a full stop) is
         * exactly what acceptance mode is asked to recognise. */
        if (body.rewrite === from) {
          if (mountedRef.current) {
            setNotice({
              rewrite: body.rewrite,
              before: from.length,
              after: body.rewrite.length,
              facts: body.facts || null,
              acceptance: body.acceptance || null,
              /* The verdict rides along with the receipt. It is computed on the
               * text the model produced, so it stays true after the write; what
               * goes stale is the panel's claim about the COMPOSER, which is why
               * the receipt branch is keyed on draft === notice.rewrite below. */
              judge: body.judge || null,
              truncated: body.truncated === true,
              same: true,
              mode: settings.mode,
            });
          }
          return true;
        }
        actions.setDraft(body.rewrite);
        /* Remember what was overwritten so the trigger's next click can undo it.
         * Recorded only on a real edit — the identical-text branch above returns
         * before reaching this line. */
        if (sessionId) lastApply.set(sessionId, { from, to: body.rewrite });
        flushDraft(actions);
        /* The notice is a paint, the write is the deliverable: only the paint
         * depends on this card still being mounted. */
        if (mountedRef.current) {
          setNotice({
            rewrite: body.rewrite,
            before: from.length,
            after: body.rewrite.length,
            facts: body.facts || null,
            /* The acceptance outcome is part of the receipt, not decoration.
             * Every click goes through this one-shot path, so a receipt that
             * only counted facts left the whole acceptance mode — and now its
             * third state — invisible exactly where it is always used. */
            acceptance: body.acceptance || null,
            judge: body.judge || null,
            truncated: body.truncated === true,
            mode: settings.mode,
          });
        }
        return true;
      }, [actions, sessionId, settings.mode]);

      /* Whether the trigger's next click should mean "undo". True only while the
       * composer still holds exactly what we last wrote: once the text differs,
       * the record describes a past we can no longer reconstruct, and offering
       * undo there would overwrite whatever the user typed since. */
      const applied = sessionId ? lastApply.get(sessionId) : null;
      const canUndo = !!applied && draft === applied.to;

      const undo = React.useCallback(() => {
        if (!sessionId) return false;
        const rec = lastApply.get(sessionId);
        if (!rec) return false;
        /* The composer moved on — typed into, or already undone by hand. Drop the
         * record and let this click start a fresh rewrite instead. */
        if (draft !== rec.to) {
          lastApply.delete(sessionId);
          return false;
        }
        if (!actions || typeof actions.setDraft !== 'function') return false;
        actions.setDraft(rec.from);
        flushDraft(actions);
        lastApply.delete(sessionId);
        if (mountedRef.current) {
          setResult(null);
          setNotice({
            rewrite: rec.from,
            before: rec.to.length,
            after: rec.from.length,
            facts: null,
            acceptance: null,
            judge: null,
            truncated: false,
            mode: settings.mode,
            reverted: true,
          });
        }
        return true;
      }, [actions, draft, sessionId, settings.mode]);

      /* Publish the undo handle and its availability to the trigger, which owns
       * the click. Same shape as runRef/cancelRef: the button knows whether this
       * click starts work or takes it back, never how a write is made. */
      if (undoRef) undoRef.current = undo;
      React.useEffect(() => {
        if (onCanUndo) onCanUndo(canUndo);
      }, [canUndo, onCanUndo]);

      /* Deliver a rewrite that landed while this session was in the background.
       * Runs once the fresh actions are available, i.e. after the shell for
       * this session has been recreated and can actually persist. The entry is
       * dropped only when the write really happened: if the shell is still not
       * ready, the next mount retries instead of silently discarding it. */
      React.useEffect(() => {
        if (!ready || !sessionId) return;
        const parked = pendingWrites.get(sessionId);
        if (!parked) return;
        if (!actions || typeof actions.setDraft !== 'function') return;
        if (replaceDraft(parked.body, parked.from)) pendingWrites.delete(sessionId);
      }, [ready, sessionId, actions, replaceDraft]);

      const run = React.useCallback(async () => {
        if (busy || draft === '') return;
        /* A fresh controller per run: a previous one is already spent, and the
         * Host keys its own abort off the request being closed. */
        const controller = new AbortController();
        abortRef.current = controller;
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        /* The backstop. Fires only when the call is still outstanding after
         * REWRITE_TIMEOUT_MS, so a wedged provider cannot hold the trigger. */
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          if (abortRef.current === controller && !controller.signal.aborted) {
            controller.abort('timeout');
          }
        }, REWRITE_TIMEOUT_MS);
        setBusy(true);
        if (onBusy) onBusy(true);
        setError('');
        setQuiet('');
        setResult(null);
        setNotice(null);
        const from = draft;
        try {
          const body = await api('rewrite', {
            sessionId: sessionId || '',
            draft,
            mode: settings.mode,
            workspaceDocs: settings.workspaceDocs,
          }, controller.signal);
          /* One click, one landing: the rewrite goes straight into the
           * composer. Ctrl+Z is how a user backs out, and that is common
           * knowledge — a lossy result is therefore NOT worth a second
           * gate. The composer's own undo stack collapses our write into a
           * single step, so even a rewrite that dropped a literal is one
           * Ctrl+Z away from the original. */
          const noActions = !actions || typeof actions.setDraft !== 'function';
          /* Landing after the card is gone is the session-switch case: the
           * shell that owned this composer has been disposed, so a write here
           * would edit an abandoned editor and never reach the store. Park it
           * for the next mount of this session instead of writing into a
           * surface nobody will read. */
          if (!mountedRef.current) {
            if (sessionId) pendingWrites.set(sessionId, { body, from });
            return;
          }
          if (noActions || !replaceDraft(body, from)) {
            setResult(body);
          }
        } catch (e) {
          /* Abort is not a failure. The user asked for it (clicking the trigger
           * again) or the backstop fired; either way a red error line would be a
           * lie, so the two cases get their own quiet message. */
          const aborted = (e && (e.name === 'AbortError' || controller.signal.aborted)) === true;
          if (aborted) {
            if (mountedRef.current) setQuiet(controller.signal.reason === 'timeout' ? t('timeout') : t('canceled'));
          } else {
            if (mountedRef.current) setError(String(e && e.message ? e.message : e));
          }
        } finally {
          if (abortRef.current === controller) abortRef.current = null;
          if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null; }
          if (mountedRef.current) {
            setBusy(false);
            if (onBusy) onBusy(false);
          }
        }
      }, [busy, draft, sessionId, settings.mode, settings.workspaceDocs, actions, replaceDraft, onBusy, t]);

      /* Hand the run callback up to the trigger. The popover is a HOVER surface
       * now, so the button — not a second button inside the panel — starts the
       * work; the card is mounted exactly while the panel is open, which is
       * exactly when a click can arrive. */
      if (runRef) runRef.current = run;
      /* The SECOND click on a busy trigger means "stop", not "start again", so
       * the trigger needs the abort handle too. */
      if (cancelRef) cancelRef.current = cancel;

      const adopt = React.useCallback(() => {
        if (!result) return;
        replaceDraft(result, draft);
        setResult(null);
      }, [draft, result, replaceDraft]);

      const discard = React.useCallback(() => { setResult(null); }, []);

      let body;
      if (!ready) {
        body = h('div', { className: 'pf-line muted' }, t('loading'));
      } else if (busy) {
        /* The in-progress state is owned by `busy`, which flips on the first
         * line of `run` and off in its `finally` — the whole request, not the
         * click. The panel says so for the entire round trip, so "is it still
         * working?" is answerable without guessing. */
        body = h('div', { className: 'pf-line pf-busy' },
          h('span', { className: 'pf-spin', 'aria-hidden': 'true' }, h(SpinIcon)),
          h('span', null, t('running')));
      } else if (draft === '') {
        body = h('div', { className: 'pf-line muted' }, t('needDraft'));
      } else if (error !== '') {
        body = h('div', { className: 'pf-err' }, t('connFail') + '：' + error);
      } else if (quiet !== '') {
        /* A cancelled/timed-out run. Muted, not red: nothing went wrong. */
        body = h('div', { className: 'pf-line muted' }, quiet);
      } else if (result) {
        body = h(React.Fragment, null,
          /* Beside the two machine rows, not in the receipt: the result panel
           * is where a rewrite is evaluated before it is adopted, and what it
           * cost to try again belongs to that decision. The receipt makes a
           * claim about what was written, which is a different question. */
          h(CostLine, { result, t }),
          h(FactLine, { result, t }),
          h(MetaLine, { result, t }),
          /* Below the two machine rows and above the preview: the judgement is
           * a reading of the text, so it belongs next to the text, not in the
           * header stack where a user would take it for a gate result. */
          h(JudgeLine, { source: result, t }),
          /* The preview branch is the fallback path (no inputActions), but the
           * two alerts must not exist only on the path users actually take
           * either — that asymmetry is exactly how the acceptance line went
           * missing. Same helper, both branches. */
          h(AlertLines, { source: result, t }),
          h(Preview, { draft, result, t }),
        );
      } else if (notice && draft === notice.rewrite) {
        /* Still in effect: the composer holds exactly what we wrote. The moment
         * it does not (Ctrl+Z, manual edit), this branch stops matching and the
         * card falls back to the neutral "draft loaded" line — a claim about a
         * state we can check, never a timer we hope fires. */
        const facts = notice.facts;
        const factCapped = facts && facts.capped === true ? ' · ' + t('factCapped') : '';
        const factText = !facts ? '' : (facts.total === 0
          ? t('factNone')
          : t('factKept') + ' ' + facts.kept + '/' + facts.total) + factCapped;
        /* A lossy rewrite still lands (see `run`), so the receipt has to name
         * what the gate had to repair — quietly overwriting a lost literal
         * would be the one dishonest outcome left. */
        const repaired = facts && Array.isArray(facts.missing) ? facts.missing.length : 0;
        /* Every click lands through here, so this is the ONLY place acceptance
         * mode is ever reported in normal use. Leaving it out made the mode
         * silently mute; leaving out `declared` would make its honest answer
         * look like a missing section. */
        const accText = acceptanceText(notice.acceptance, t);
        const accWarn = acceptanceWarn(notice.acceptance);
        body = h('div', { className: 'pf-done' },
          h('span', { className: 'pf-done-h' }, notice.reverted ? t('reverted') : (notice.same ? t('unchanged') : t('replaced'))),
          h('span', { className: 'pf-done-b' },
            notice.before + ' → ' + notice.after + ' ' + t('chars')
            + (factText ? ' · ' + factText : '')
            + (repaired > 0 ? ' · ' + t('factFixed') + ' ' + repaired : '')),
          accText
            ? h('span', { className: 'pf-done-a' + (accWarn ? ' warn' : '') }, accText)
            : null,
          /* The verdict on the receipt, in its own row. Every click lands here,
           * so leaving it out would make the whole feature invisible on the path
           * users actually take — the same way acceptance mode once went mute. */
          h(JudgeLine, { source: notice, t }),
          /* Appended, never merged into the line above: an alert is a different
           * claim from a fact count, and a user skimming one line will read a
           * trailing warning as part of the counter. Absent when neither field
           * fired, so the receipt stays the three lines it always was. */
          h(AlertLines, { source: notice, t }),
        );
      } else {
        body = h('div', { className: 'pf-line muted' }, t('draftReady') + ' ' + draft.length + ' ' + t('chars'));
      }

      /* The ONLY buttons inside the panel are the preview fallback's. The
       * panel is a hover surface, so an action button here would compete with
       * the trigger — which is the action. */
      let actionsRow = null;
      if (result) {
        actionsRow = h('div', { className: 'pf-actions' },
          h('button', { type: 'button', className: 'pf-act pf-act-primary', onClick: adopt }, t('adopt')),
          h('button', { type: 'button', className: 'pf-act', onClick: discard }, t('discard')),
        );
      }

      /* The card owns the panel shell rather than the trigger. It is mounted for
       * the whole session, so hovering in and out (or the mouse leaving while a
       * rewrite is in flight) only hides the shell — the in-flight request, the
       * busy flag and the receipt all survive. Mounting the shell from the
       * trigger would unmount this component on mouseleave and throw the
       * receipt away the instant the pointer moved. */
      if (!open || !pos) return null;

      /* The panel is a HOVER surface: it carries the three settings chips and
       * whatever the last click reported. There is deliberately no 改写 button
       * and no 采纳 step — the trigger button itself is the action. */
      return ReactDOM.createPortal(
        h('div', {
          ref: popRef,
          className: 'pf-pop',
          style: { left: pos.left, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight },
          /* Hover is tracked on the PANEL's own enter/leave, but the panel is
           * no longer a DOM descendant of the trigger — a portal sits directly
           * under document.body. The pointer therefore DOES cross the gap
           * between button and panel, firing mouseleave on the wrapper. The
           * wrapper's handler is a 180ms grace timer, and this enter cancels
           * it, so the panel stays reachable exactly as before. */
          onMouseEnter,
          onMouseLeave,
        },
          h(ModeRow, { settings, update, t, disabled: busy }),
          h('div', { className: 'pf-body', role: 'status', 'aria-live': 'polite' }, body),
          actionsRow,
        ),
        document.body,
      );
    }

    function ForgeButton({ ctx, sessionId, t }) {
      const [open, setOpen] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const triggerRef = React.useRef(null);
      const popRef = React.useRef(null);
      const runRef = React.useRef(null);
      /* The card publishes its abort handle here so a second click on the
       * trigger can mean "stop" without the trigger knowing how runs work. */
      const cancelRef = React.useRef(null);
      const closeTimer = React.useRef(null);
      const { pos, place } = usePopoverPlacement(open, triggerRef, popRef);

      /* Added after every pre-existing hook on purpose. verify-client.mjs keys
       * some assertions off slot INDICES (slots[0] = open, slots[1] = busy), so
       * inserting a hook earlier shifts every ref below and silently mis-seats
       * the harness's seeded values. Appending keeps those indices intact.
       *
       * undoRef: same contract as cancelRef — the card publishes a function that
       * returns true only when it actually reverted something.
       * canUndo: mirrors the card's verdict, used only for the label and tint. */
      const undoRef = React.useRef(null);
      const [canUndo, setCanUndo] = React.useState(false);

      /* Hover is the way IN: the panel exists to expose the three settings. It
       * is opened by the pointer, not by a click, and it leaves the stage as
       * soon as the pointer does (see scheduleClose) — the panel must never sit
       * in front of the composer while the user is typing again. */
      const openNow = React.useCallback(() => {
        if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
        setOpen(true);
        place();
      }, [place]);

      /* A short grace period, not an instant close: the pointer has to cross
       * the gap between the trigger and the panel, and a 0ms close would make
       * the panel unreachable. 180ms is longer than a mouse move and far
       * shorter than a user noticing a stale box. */
      const scheduleClose = React.useCallback(() => {
        if (closeTimer.current) clearTimeout(closeTimer.current);
        closeTimer.current = setTimeout(() => { closeTimer.current = null; setOpen(false); }, 180);
      }, []);

      React.useEffect(() => () => {
        if (closeTimer.current) clearTimeout(closeTimer.current);
      }, []);

      React.useEffect(() => {
        if (!open) return undefined;
        place();
        const away = (e) => {
          if (e.target.closest && (e.target.closest('.pf-pop') || e.target.closest('.pf-btn'))) return;
          setOpen(false);
        };
        const key = (e) => { if (e.key === 'Escape') setOpen(false); };
        const reflow = () => place();
        document.addEventListener('mousedown', away, true);
        document.addEventListener('keydown', key, true);
        window.addEventListener('resize', reflow);
        window.addEventListener('scroll', reflow, true);
        const menu = popRef.current;
        const watcher = typeof ResizeObserver !== 'undefined' && menu ? new ResizeObserver(reflow) : null;
        if (watcher && menu) watcher.observe(menu);
        const anchor = triggerRef.current;
        const anchorWatcher = typeof ResizeObserver !== 'undefined' && anchor
          ? new ResizeObserver(reflow) : null;
        if (anchorWatcher && anchor) anchorWatcher.observe(anchor);
        return () => {
          document.removeEventListener('mousedown', away, true);
          document.removeEventListener('keydown', key, true);
          window.removeEventListener('resize', reflow);
          window.removeEventListener('scroll', reflow, true);
          if (watcher) watcher.disconnect();
          if (anchorWatcher) anchorWatcher.disconnect();
        };
      }, [open, place]);

      /* ONE click, ONE rewrite — unless a rewrite is already in flight, in which
       * case the SAME click cancels it. That makes the trigger the single
       * control for the whole lifecycle: start, and stop. */
      const fire = React.useCallback(() => {
        openNow();
        if (busy) {
          const cancel = cancelRef && cancelRef.current;
          if (typeof cancel === 'function') cancel();
          return;
        }
        /* A rewrite that already landed turns the same click into its undo. The
         * card decides whether that is still honest — the composer must hold
         * exactly what we wrote — and returns false when it is not, so the click
         * falls through to a new rewrite. */
        const undo = undoRef.current;
        if (typeof undo === 'function' && undo()) return;
        const run = runRef.current;
        if (typeof run === 'function') run();
      }, [busy, openNow]);

      return h('div', {
        className: 'pf-root',
        /* The hover surface lives on the wrapper, not on the button. Chromium
         * stops dispatching mouseenter/mouseleave on a DISABLED button, so
         * hanging the panel off the button would make "改写中…" unreadable for
         * the exact window it describes. The wrapper is never disabled; the
         * panel is its DOM descendant, so moving the pointer onto the panel
         * does not even fire mouseleave here. */
        onMouseEnter: openNow,
        onMouseLeave: scheduleClose,
      },
        h('style', null, CSS),
        h('button', {
          ref: triggerRef,
          type: 'button',
          className: 'pf-btn',
          'aria-label': canUndo ? t('undoTitle') : t('btnTitle'),
          title: canUndo ? t('undoTitle') : t('btnTitle'),
          'aria-expanded': open ? 'true' : 'false',
          /* Declares the panel as a popup, so assistive tech announces
           * "expanded" meaningfully instead of reading a bare toggle. */
          'aria-haspopup': 'true',
          'aria-busy': busy ? 'true' : 'false',
          /* aria-disabled, NOT disabled: the second click on a busy trigger is a
           * CANCEL, so the element must still receive it. A real `disabled`
           * attribute would swallow that click and strand the user with no way
           * out until the 90s backstop fired. The visual dimming and the
           * progress cursor are driven off this attribute instead. */
          'aria-disabled': busy ? 'true' : 'false',
          'data-busy': busy ? 'true' : 'false',
          /* Marks the click as a take-back rather than a write. Visual only —
           * the decision was already made in fire(). */
          'data-undo': canUndo ? 'true' : 'false',
          onMouseDown: (e) => e.preventDefault(),
          /* Hover alone left the panel unreachable from the keyboard and from
           * touch. onFocus covers Tab; onKeyDown covers Enter/Space, which a
           * native button turns into a click but which must also OPEN the panel
           * if it was shut. */
          onFocus: (e) => { if (e && e.currentTarget === e.target) openNow(); },
          onKeyDown: (e) => {
            if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
            e.preventDefault();
            fire();
          },
          onClick: fire,
          /* Busy swaps the glyph, not just its state: the spark is the button's
           * identity mark, so keeping it and spinning it would read as "this
           * star wobbles" instead of "a job is running". The arc IS the loading
           * idiom, and it matches the panel line one-for-one.
           *
           * Both marks are mounted at once and the crossfade is done in CSS off
           * data-busy. Deciding here with a ternary would unmount one and mount
           * the other in the same frame, which is a blink, and it would also
           * restart the ring from 0deg on every click. The DOM therefore does
           * not change between idle and busy — only which mark is opaque does. */
        }, h('span', { className: 'pf-glyph' },
          h('span', { className: 'pf-glyph-idle' }, h(SparkIcon)),
          h('span', { className: 'pf-glyph-busy' }, h(SpinIcon, { className: 'ico' })),
          h('span', { className: 'pf-glyph-undo' }, h(UndoIcon)))),
        h(ForgeCard, {
          ctx,
          sessionId,
          t,
          runRef,
          cancelRef,
          undoRef,
          onBusy: setBusy,
          onCanUndo: setCanUndo,
          open,
          pos,
          popRef,
          onMouseEnter: openNow,
          onMouseLeave: scheduleClose,
        }),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const dicts = {
          zh: {
            btnTitle: '提示词锻造：把口语化草稿改写成 agent 可执行的提示词',
            undoTitle: '回退：把草稿恢复成改写前的样子',
            loading: '读取草稿中…',
            connOk: '服务已连通',
            connFail: '改写失败',
            needDraft: '输入框是空的：先在输入框写点东西',
            draftReady: '已读取草稿',
            chars: '字符',
            factKept: '硬事实保留',
            factNone: '无字面量需保护',
            factFixed: '补回',
            factCapped: '超出上限，未全量校验',
            labelOriginal: '原稿',
            labelRewrite: '改写',
            adopt: '采纳并替换',
            discard: '放弃',
            replaced: '已替换草稿',
            reverted: '已回退到改写前',
            unchanged: '改写结果与原文一致',
            modePolish: '保真优化',
            modeAcceptance: '验收补全',
            modeGroup: '改写模式（单选）',
            docsToggle: '工作区文档',
            docsHint: '读取工作区根目录的 AGENTS.md / GLOSSARY-MAP.md 等约定，注入改写上下文',
            docsUsed: '已用文档',
            acceptanceOk: '验收段已生成',
            acceptanceDeclared: '草稿无可核对目标，未编验收段',
            acceptanceMissing: '未生成验收段',
            truncatedWarn: '结果被截断：结尾不完整，不要直接粘贴',
            factInvented: '凭空新增的字面量',
            running: '改写中…',
            cancelHint: '正在改写：再点一次可取消',
            canceled: '已取消改写',
            timeout: '改写超时（90 秒）：已中止，可重试',
            judgeOk: '判定通过：四个信号都无异常',
            judgeCheck: '判定需复核',
            judgeFix: '判定有问题',
            judgeAbsent: '判定未返回',
            judgeFidelityFail: '丢失原稿内容',
            judgeDepthShallow: '只是换了说法',
            judgeDepthCompressed: '比原稿更笼统',
            judgeGroundingInvented: '凭空补了内容',
            judgeGroundingInferred: '有内容属推断',
            judgeExecBlocked: '无法直接执行',
            judgeExecClarify: '仍需先澄清',
            conflict_depthIsFabricated: '说更深入，但新增内容原稿推不出',
            conflict_depthBreaksExecutability: '说更深入，但变得无法直接执行',
            conflict_depthIsCosmetic: '说更深入，实际只是换了措辞',
            conflict_fidelityContradictsFactGate: '判定说保真通过，但硬事实闸发现缺失',
            /* 费用行的五个键。金额、峰谷、调用次数、以及「没报用量」这一态必须
             * 都能说清楚：只给一个数字，用户会把它当成账单。 */
            costEstimate: '本次约',
            costPeak: '峰时',
            costOffPeak: '谷时',
            costCalls: '次模型调用',
            costUnknown: '模型未回报用量：费用未知（不等于免费）',
          },
          en: {
            btnTitle: 'Prompt Forge: rewrite a rough draft into an agent-ready prompt',
            undoTitle: 'Undo: restore the draft as it was before the rewrite',
            loading: 'Reading draft…',
            connOk: 'Host connected',
            connFail: 'Rewrite failed',
            needDraft: 'Composer is empty: type something first',
            draftReady: 'Draft loaded',
            chars: 'chars',
            factKept: 'Hard facts kept',
            factNone: 'No literals to protect',
            factFixed: 'restored',
            factCapped: 'over cap, not fully checked',
            labelOriginal: 'Original',
            labelRewrite: 'Rewrite',
            adopt: 'Adopt and replace',
            discard: 'Discard',
            replaced: 'Draft replaced',
            reverted: 'Reverted to the original draft',
            unchanged: 'Rewrite matches the original',
            modePolish: 'Faithful',
            modeAcceptance: 'Acceptance',
            modeGroup: 'Rewrite mode (one of)',
            docsToggle: 'Workspace docs',
            docsHint: 'Read AGENTS.md / GLOSSARY-MAP.md from the workspace root into the rewrite context',
            docsUsed: 'Docs used',
            acceptanceOk: 'Acceptance section generated',
            acceptanceDeclared: 'Nothing checkable in the draft; none invented',
            acceptanceMissing: 'No acceptance section',
            truncatedWarn: 'Truncated: the ending is incomplete, do not paste as-is',
            factInvented: 'Fabricated literals',
            running: 'Rewriting…',
            cancelHint: 'Rewriting: click again to cancel',
            canceled: 'Rewrite cancelled',
            timeout: 'Rewrite timed out (90s): aborted, you can retry',
            judgeOk: 'Verdict: all four signals clean',
            judgeCheck: 'Verdict: worth a look',
            judgeFix: 'Verdict: problem found',
            judgeAbsent: 'Verdict: none returned',
            judgeFidelityFail: 'dropped original content',
            judgeDepthShallow: 'reworded only',
            judgeDepthCompressed: 'vaguer than the draft',
            judgeGroundingInvented: 'added unsupported content',
            judgeGroundingInferred: 'partly inferred',
            judgeExecBlocked: 'not executable',
            judgeExecClarify: 'still needs clarification',
            conflict_depthIsFabricated: 'claims depth, but the additions cannot be traced to the draft',
            conflict_depthBreaksExecutability: 'claims depth, but the result cannot be executed',
            conflict_depthIsCosmetic: 'claims depth, but only the wording changed',
            conflict_fidelityContradictsFactGate: 'judge says fidelity passed while the fact gate found losses',
            /* The five cost keys. Amount, period, call count and the
             * no-usage state must all be sayable: a bare number gets read as
             * a bill, and 'unknown' must never look like zero. */
            costEstimate: 'About',
            costPeak: 'peak',
            costOffPeak: 'off-peak',
            costCalls: 'model calls',
            costUnknown: 'Usage not reported: cost unknown (not free)',
          },
        };
        ctx.effect(() => ctx.locale.register(NS, dicts), 'dsh-prompt-forge: dictionaries');
        const t = ctx.locale.bind(NS);

        ctx.effect(() => ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'dsh-prompt-forge',
          order: 100,
          registrant: 'dsh-prompt-forge',
          locale: NS,
          inject: (sessionId) => ({ sessionId }),
        }, (props) => h(ForgeButton, { ...props, ctx, t }))), 'dsh-prompt-forge: input.left entry');
      },
    };
  },
});
