// Phone layout navigation (shown by CSS on narrow screens instead of the sidebar): Home, Search
// and Your Library, like Spotify's app.
import { useT } from "../i18n";
import { navigate, useUi } from "../store/ui";
import { cls } from "../util";
import * as I from "./Icons";

export function MobileTabs() {
  const t = useT();
  const name = useUi((s) => s.stack[s.pos].name);
  const tabs = [
    { route: "home" as const, label: t("home"), icon: (on: boolean) => (on ? <I.IHomeFill size={24} /> : <I.IHome size={24} />) },
    { route: "search" as const, label: t("search"), icon: () => <I.ISearch size={24} /> },
    { route: "library" as const, label: t("library"), icon: (on: boolean) => (on ? <I.ILibraryFill size={24} /> : <I.ILibrary size={24} />) },
  ];
  return (
    <nav className="mobile-tabs" aria-label="Main">
      {tabs.map((x) => {
        const on = name === x.route;
        return (
          <button key={x.route} className={cls(on && "on")} aria-current={on ? "page" : undefined} onClick={() => navigate({ name: x.route })}>
            {x.icon(on)}
            <span>{x.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
