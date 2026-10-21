// Phone layout navigation (shown by CSS on narrow screens instead of the sidebar).
import { useT } from "../i18n";
import { navigate, useUi } from "../store/ui";
import { cls } from "../util";
import * as I from "./Icons";

export function MobileTabs() {
  const t = useT();
  const name = useUi((s) => s.stack[s.pos].name);
  const tabs = [
    { route: "home" as const, label: t("home"), icon: <I.IHome size={24} /> },
    { route: "search" as const, label: t("search"), icon: <I.ISearch size={24} /> },
    { route: "library" as const, label: t("library"), icon: <I.ILibrary size={24} /> },
  ];
  return (
    <nav className="mobile-tabs" aria-label="Main">
      {tabs.map((x) => (
        <button key={x.route} className={cls(name === x.route && "on")} aria-current={name === x.route ? "page" : undefined} onClick={() => navigate({ name: x.route })}>
          {x.icon}
          <span>{x.label}</span>
        </button>
      ))}
    </nav>
  );
}
