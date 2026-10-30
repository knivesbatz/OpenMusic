import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { closeMenu, useUi, type MenuItem } from "../store/ui";
import { cls, fmtMs } from "../util";
import { Art } from "./common";

export function ContextMenu() {
  const menu = useUi((s) => s.menu);
  if (!menu) return null;
  return <MenuList items={menu.items} x={menu.x} y={menu.y} root />;
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
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!d) return;
    setValue(d.input?.value ?? "");
    const prev = document.activeElement as HTMLElement | null;
    setTimeout(() => (ref.current?.querySelector("input, .dialog-actions button:last-child") as HTMLElement | null)?.focus());
    return () => prev?.focus();
  }, [d]);
  if (!d) return null;
  const done = (ok: boolean) => {
    useUi.setState({ dialog: null });
    d.resolve(ok, value);
  };
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && done(false)}>
      <div
        ref={ref}
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="dlg-title"
        onKeyDown={(e) => {
          if (e.key === "Escape") done(false);
          if (e.key === "Tab") {
            const f = [...ref.current!.querySelectorAll<HTMLElement>("input, button")];
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
        <div className="dialog-actions">
          <button className="pill ghost" onClick={() => done(false)}>
            {t("cancel")}
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
        </div>
      ))}
    </div>
  );
}
