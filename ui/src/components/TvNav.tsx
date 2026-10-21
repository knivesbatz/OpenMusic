// TV mode navigation, Android TV / Google TV style: a top tab bar instead of the sidebar, with
// the search field inline on the Search tab and a clock. Driven by the D-pad like everything else.
import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { useApp } from "../store/app";
import { navigate, useUi } from "../store/ui";
import { cls } from "../util";
import * as I from "./Icons";

export function TvNav() {
  const t = useT();
  const cur = useUi((s) => s.stack[s.pos]);
  const name = useApp((s) => s.info?.name);
  const [now, setNow] = useState(() => new Date());
  const input = useRef<HTMLInputElement>(null);
  const q = cur.name === "search" ? cur.q ?? "" : "";

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (cur.name === "search") input.current?.focus();
  }, [cur.name]);

  const tabs = [
    { route: "home" as const, label: t("home"), icon: <I.IHome size={22} /> },
    { route: "search" as const, label: t("search"), icon: <I.ISearch size={22} /> },
    { route: "library" as const, label: t("library"), icon: <I.ILibrary size={22} /> },
    { route: "settings" as const, label: t("settings"), icon: <I.ISettings size={22} /> },
  ];
  return (
    <header className="tv-nav">
      <span className="tv-brand">{name}</span>
      <nav className="tv-tabs" aria-label="Main">
        {tabs.map((x) => (
          <button key={x.route} className={cls("tv-tab", cur.name === x.route && "on")} aria-current={cur.name === x.route ? "page" : undefined} onClick={() => navigate({ name: x.route })}>
            {x.icon}
            <span>{x.label}</span>
          </button>
        ))}
      </nav>
      {cur.name === "search" && (
        <input
          ref={input}
          id="global-search"
          className="tv-search"
          type="search"
          placeholder={t("searchPlaceholder")}
          aria-label={t("search")}
          value={q}
          onChange={(e) => navigate({ name: "search", q: e.target.value }, true)}
        />
      )}
      <span className="tv-clock">{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
    </header>
  );
}
