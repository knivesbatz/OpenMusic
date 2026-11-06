import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { closeMenu, useUi, type MenuHead, type MenuItem } from "../store/ui";
import { cls, fmtMs } from "../util";
import { Art, usePhoneLayout } from "./common";
import * as I from "./Icons";

export function ContextMenu() {
  const menu = useUi((s) => s.menu);
  const phone = usePhoneLayout();
  if (!menu) return null;
  // Phones: Spotify's ••• sheet from the bottom instead of a pop-up menu.
  if (phone) return <MenuSheet key={menu.x + ":" + menu.y + ":" + menu.items.length} items={menu.items} head={menu.head} />;
  return <MenuList items={menu.items} x={menu.x} y={menu.y} root />;
}

/** The phone menu: a sheet that slides up, with what it's about (cover, title) at the top and
 * one big row per action. Submenus open in place with a back row; swipe down or tap outside to
 * close. */
function MenuSheet({ items, head }: { items: MenuItem[]; head?: MenuHead }) {
  const t = useT();
  const [stack, setStack] = useState<{ title?: string; items: MenuItem[] }[]>([{ items }]);
  const [drag, setDrag] = useState(0);
  const startY = useRef<number | null>(null);
  const cur = stack[stack.length - 1];
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && closeMenu();
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, []);
  const touch = {
    onTouchStart: (e: React.TouchEvent) => (startY.current = e.touches[0].clientY),
    onTouchMove: (e: React.TouchEvent) => startY.current != null && setDrag(Math.max(0, e.touches[0].clientY - startY.current)),
    onTouchEnd: () => {
      if (drag > 90) closeMenu();
      startY.current = null;
      setDrag(0);
    },
  };
  return (
    <div className="sheet-bg" onClick={(e) => e.target === e.currentTarget && closeMenu()} onContextMenu={(e) => e.preventDefault()}>
      <div className="menu-sheet" role="menu" style={drag ? { transform: `translateY(${drag}px)`, transition: "none" } : undefined}>
        <div className="sheet-top" {...touch}>
          <div className="sheet-grip" aria-hidden="true" />
          {head && stack.length === 1 && (
            <div className="sheet-head">
              <Art src={head.art} size={128} round={head.round} />
              <div className="sheet-head-text">
                <div className="t">{head.title}</div>
                {head.sub && <div className="s">{head.sub}</div>}
              </div>
            </div>
          )}
          {stack.length > 1 && (
            <button className="sheet-back" onClick={() => setStack((s) => s.slice(0, -1))}>
              <I.IBack size={20} />
              <span>{cur.title ?? t("back")}</span>
            </button>
          )}
        </div>
        <div className="sheet-items">
          {cur.items.map((m, i) =>
            m.separator ? (
              <hr key={i} />
            ) : m.heading ? (
              <div key={i} className="sheet-heading">
                {m.label}
              </div>
            ) : m.icons ? (
              <div key={i} className="menu-icons" role="group" aria-label={m.label}>
                {m.icons.map((b) => (
                  <button key={b.label} className={cls(b.on && "on")} aria-label={b.label} aria-pressed={b.on} onClick={() => (closeMenu(), b.onClick())}>
                    <b.icon size={22} />
                  </button>
                ))}
              </div>
            ) : (
              <button
                key={i}
                role={m.checked !== undefined ? "menuitemradio" : "menuitem"}
                aria-checked={m.checked}
                disabled={m.disabled}
                className={cls("sheet-item", m.danger && "danger", m.checked && "on")}
                onClick={() => {
                  if (m.submenu) return setStack((s) => [...s, { title: m.label, items: m.submenu! }]);
                  closeMenu();
                  m.onClick?.();
                }}
              >
                <span className="sheet-icon">{m.icon ? <m.icon size={24} /> : null}</span>
                <span className="sheet-label">{m.label}</span>
                {m.submenu ? <I.IForward size={18} /> : m.checked ? <I.ICheck size={20} /> : m.hint ? <span className="sheet-hint">{m.hint}</span> : m.external ? <I.IOpen size={18} /> : null}
              </button>
            ),
          )}
        </div>
      </div>
    </div>
  );
}

function MenuList({ items, x, y, root }: { items: MenuItem[]; x: number; y: number; root?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [open, setOpen] = useState<number | null>(null);
  const [sub, setSub] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  useLayoutEffect(() => {
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(4, Math.min(x, innerWidth - r.width - 4)), y: Math.max(4, Math.min(y, innerHeight - r.height - 4)) });
    if (root) (el.querySelector("button:not(:disabled)") as HTMLElement | null)?.focus();
  }, [x, y, root]);

  useEffect(() => {
    if (!root) return;
    const close = (e: Event) => {
      if (e.type === "keydown" && (e as KeyboardEvent).key !== "Escape") return;
      if (e.type === "mousedown" && (e.target as HTMLElement).closest(".menu")) return;
      closeMenu();
    };
    addEventListener("mousedown", close);
    addEventListener("keydown", close);
    addEventListener("blur", close);
    addEventListener("resize", close);
    return () => {
      removeEventListener("mousedown", close);
      removeEventListener("keydown", close);
      removeEventListener("blur", close);
      removeEventListener("resize", close);
    };
  }, [root]);

  function key(e: React.KeyboardEvent) {
    const btns = [...ref.current!.querySelectorAll<HTMLElement>(":scope > button:not(:disabled)")];
    const i = btns.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") (e.preventDefault(), btns[(i + 1) % btns.length]?.focus());
    else if (e.key === "ArrowUp") (e.preventDefault(), btns[(i - 1 + btns.length) % btns.length]?.focus());
    else if (e.key === "ArrowLeft" && !root) (e.preventDefault(), e.stopPropagation(), (ref.current!.parentElement?.querySelector(".has-sub.open") as HTMLElement | null)?.focus());
  }

  // A submenu is the menu's sibling, not its child: while a menu scales in, its transform would
  // make it the containing block of a position: fixed child and throw the submenu off screen.
  return (
    <>
      <div ref={ref} className={cls("menu", !root && "sub")} role="menu" style={{ left: pos.x, top: pos.y }} onKeyDown={key} onContextMenu={(e) => e.preventDefault()}>
        {items.map((m, i) =>
          m.separator ? (
            <hr key={i} />
          ) : m.icons ? (
            <div key={i} className="menu-icons" role="group" aria-label={m.label}>
              {m.icons.map((b) => (
                <button
                  key={b.label}
                  className={cls(b.on && "on")}
                  aria-label={b.label}
                  title={b.label}
                  aria-pressed={b.on}
                  onClick={() => {
                    closeMenu();
                    b.onClick();
                  }}
                >
                  <b.icon size={18} />
                </button>
              ))}
            </div>
          ) : m.heading ? (
            <div key={i} className="menu-head">
              {m.label}
            </div>
          ) : (
            <button
              key={i}
              role={m.checked !== undefined ? "menuitemradio" : "menuitem"}
              className={cls(m.danger && "danger", m.submenu && "has-sub", open === i && "open", m.checked && "on")}
              aria-checked={m.checked}
              disabled={m.disabled}
              aria-haspopup={m.submenu ? "menu" : undefined}
              aria-expanded={m.submenu ? open === i : undefined}
              onMouseEnter={(e) => {
                if (m.submenu) {
                  const r = e.currentTarget.getBoundingClientRect();
                  setSub({ x: r.right - 4, y: r.top - 4 });
                  setOpen(i);
                } else setOpen(null);
              }}
              onKeyDown={(e) => {
                if (m.submenu && (e.key === "ArrowRight" || e.key === "Enter")) {
                  e.preventDefault();
                  e.stopPropagation();
                  const r = e.currentTarget.getBoundingClientRect();
                  setSub({ x: r.right - 4, y: r.top - 4 });
                  setOpen(i);
                  setTimeout(() => (document.querySelector(".menu.sub button") as HTMLElement | null)?.focus());
                }
              }}
              onClick={() => {
                if (m.submenu) return;
                closeMenu();
                m.onClick?.();
              }}
            >
              <span className="mi">
                {m.icon && <m.icon size={16} />}
                <span>{m.label}</span>
              </span>
              {m.submenu && <span aria-hidden="true">▸</span>}
              {!m.submenu && (m.hint || m.checked) && <span aria-hidden="true">{m.hint ?? "✓"}</span>}
              {m.external && <I.IOpen size={16} />}
            </button>
          ),
        )}
      </div>
      {open !== null && items[open]?.submenu && <MenuList items={items[open].submenu!} x={sub.x} y={sub.y} />}
    </>
  );
}

export function DialogHost() {
  const t = useT();
  const d = useUi((s) => s.dialog);
  const [value, setValue] = useState("");
  const [choice, setChoice] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!d) return;
    setValue(d.input?.value ?? "");
    setChoice(d.choice?.value ?? "");
    const prev = document.activeElement as HTMLElement | null;
    setTimeout(() => (ref.current?.querySelector("input, .dialog-actions button:last-child") as HTMLElement | null)?.focus());
    return () => prev?.focus();
  }, [d]);
  if (!d) return null;
  const done = (ok: boolean | null) => {
    useUi.setState({ dialog: null });
    d.resolve(ok, value, choice);
  };
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && done(null)}>
      <div
        ref={ref}
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="dlg-title"
        onKeyDown={(e) => {
          if (e.key === "Escape") done(null);
          if (e.key === "Tab") {
            const f = [...ref.current!.querySelectorAll<HTMLElement>("input, select, button")];
            const i = f.indexOf(document.activeElement as HTMLElement);
            if (e.shiftKey && i === 0) (e.preventDefault(), f[f.length - 1].focus());
            else if (!e.shiftKey && i === f.length - 1) (e.preventDefault(), f[0].focus());
          }
        }}
      >
        <h2 id="dlg-title">{d.title}</h2>
        {d.body && <p>{d.body}</p>}
        {d.input && (
          <label className="field">
            <span>{d.input.label}</span>
            <input value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && done(true)} maxLength={200} />
          </label>
        )}
        {d.choice && (
          <label className="field">
            <span>{d.choice.label}</span>
            <select value={choice} onChange={(e) => setChoice(e.target.value)}>
              {d.choice.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="dialog-actions">
          <button className="pill ghost" onClick={() => done(false)}>
            {d.cancel ?? t("cancel")}
          </button>
          <button className={cls("pill", d.danger ? "danger" : "primary")} onClick={() => done(true)}>
            {d.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

export function InfoDialog() {
  const t = useT();
  const tr = useUi((s) => s.info);
  if (!tr) return null;
  const close = () => useUi.setState({ info: null });
  const rows: [string, string | number | null | undefined][] = [
    [t("title"), tr.title],
    [t("artist"), tr.artist],
    [t("album"), tr.album],
    [t("trackNumber"), tr.trackNumber],
    [t("duration"), fmtMs(tr.durationMs)],
    [t("source"), tr.source === "plex" ? "Plex" : tr.source === "youtube" ? "YouTube Music" : t("localFile")],
  ];
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && close()} onKeyDown={(e) => e.key === "Escape" && close()}>
      <div className="dialog info" role="dialog" aria-modal="true" aria-labelledby="info-title">
        <div className="row gap">
          <Art src={tr.artwork} size={160} className="md" />
          <h2 id="info-title">{t("viewCredits")}</h2>
        </div>
        <dl>
          {rows
            .filter(([, v]) => v != null && v !== "")
            .map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
        </dl>
        <div className="dialog-actions">
          <button className="pill primary" autoFocus onClick={close}>
            {t("close")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((x) => (
        <div key={x.id} className="toast">
          {x.text}
          {/* The toast row ignores the pointer; its button doesn't. */}
          {x.action && (
            <button
              className="link"
              style={{ pointerEvents: "auto", marginLeft: 12, color: "inherit", fontWeight: 700, textDecoration: "underline" }}
              onClick={() => {
                useUi.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== x.id) }));
                x.action!.onClick();
              }}
            >
              {x.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
