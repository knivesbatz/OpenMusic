// YTSpot: choose which YouTube channel (personal or brand account) the library comes from.
import { useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { useT } from "../i18n";
import { closeProfilePicker, refreshLibrary, useApp } from "../store/app";
import type { YtAccount } from "../types";
import { cls } from "../util";
import { Art, Loading } from "./common";

export function ProfilePicker() {
  const t = useT();
  const [list, setList] = useState<YtAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.ytAccounts().then(setList, (e) => setError(errorMessage(e)));
  }, []);

  async function pick(a: YtAccount) {
    setBusy(true);
    try {
      await api.ytSelectAccount(a.pageId ?? null, a.name);
      await api.kvSet("yt.profileChosen", true);
      useApp.setState((s) => ({ auth: s.auth ? { ...s.auth, account: a.name } : s.auth, library: null }));
      closeProfilePicker();
      refreshLibrary(true);
    } catch (e) {
      setError(errorMessage(e));
    }
    setBusy(false);
  }

  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && closeProfilePicker()} onKeyDown={(e) => e.key === "Escape" && closeProfilePicker()}>
      <div className="dialog profiles" role="dialog" aria-modal="true" aria-labelledby="profiles-title">
        <h2 id="profiles-title">{t("chooseProfile")}</h2>
        <p>{t("chooseProfileHint")}</p>
        {!list && !error && <Loading />}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="profile-list">
          {list?.map((a, i) => (
            <button key={a.pageId ?? "primary"} className={cls("profile", a.selected && "on")} disabled={busy} autoFocus={i === 0} onClick={() => pick(a)}>
              <Art src={a.photo} size={96} round className="sm" />
              <span className="profile-text">
                <span className="name">{a.name}</span>
                <span className="sub">{a.handle ?? (a.pageId ? "" : t("primaryAccount"))}</span>
              </span>
              {a.selected && <span className="check" aria-label="✓">✓</span>}
            </button>
          ))}
        </div>
        <div className="dialog-actions">
          <button className="pill ghost" onClick={closeProfilePicker}>
            {t("close")}
          </button>
        </div>
      </div>
    </div>
  );
}
