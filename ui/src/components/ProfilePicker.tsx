// Profile picker. YTSpot: which YouTube channel (personal or brand account) the library comes
// from. PLEXSpot: which Plex Home user is listening (PIN for protected users).
import { useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { useT } from "../i18n";
import { closeProfilePicker, refreshLibrary, refreshPlaylists, useApp } from "../store/app";
import { cls } from "../util";
import { Art, Loading } from "./common";

interface Profile {
  key: string;
  name: string;
  sub: string;
  photo?: string | null;
  selected: boolean;
  protected: boolean;
  pick: (pin: string | null) => Promise<void>;
}

export function ProfilePicker() {
  const t = useT();
  const flavor = useApp((s) => s.info?.flavor);
  const [list, setList] = useState<Profile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pinFor, setPinFor] = useState<Profile | null>(null);
  const [pin, setPin] = useState("");

  useEffect(() => {
    const load =
      flavor === "plex"
        ? api.plexHomeUsers().then((users) =>
            users.map<Profile>((u) => ({
              key: u.uuid,
              name: u.title,
              sub: u.admin ? t("profileAdmin") : "",
              photo: u.thumb,
              selected: u.selected,
              protected: u.protected,
              pick: (p) => api.plexSwitchUser(u.uuid, p),
            })),
          )
        : api.ytAccounts().then((accounts) =>
            accounts.map<Profile>((a) => ({
              key: a.pageId ?? "primary",
              name: a.name,
              sub: a.handle ?? (a.pageId ? "" : t("primaryAccount")),
              photo: a.photo,
              selected: a.selected,
              protected: false,
              pick: () => api.ytSelectAccount(a.pageId ?? null, a.name),
            })),
          );
    load.then(setList, (e) => setError(errorMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flavor]);

  async function pick(p: Profile, pinValue: string | null) {
    if (p.protected && pinValue === null) {
      setPinFor(p);
      setPin("");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await p.pick(pinValue);
      await api.kvSet(flavor === "plex" ? "plex.profileChosen" : "yt.profileChosen", true);
      useApp.setState((s) => ({ auth: s.auth ? { ...s.auth, account: p.name } : s.auth, library: null }));
      closeProfilePicker();
      refreshLibrary(true);
      refreshPlaylists();
    } catch (e) {
      setError(errorMessage(e));
    }
    setBusy(false);
  }

  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && closeProfilePicker()} onKeyDown={(e) => e.key === "Escape" && closeProfilePicker()}>
      <div className="dialog profiles" role="dialog" aria-modal="true" aria-labelledby="profiles-title">
        <h2 id="profiles-title">{t("chooseProfile")}</h2>
        <p>{flavor === "plex" ? t("chooseProfileHintPlex") : t("chooseProfileHint")}</p>
        {!list && !error && <Loading />}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {pinFor ? (
          <form
            className="field"
            onSubmit={(e) => {
              e.preventDefault();
              pick(pinFor, pin);
            }}
          >
            <span>{t("enterPin", { name: pinFor.name })}</span>
            <input autoFocus inputMode="numeric" type="password" maxLength={8} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
            <div className="dialog-actions">
              <button type="button" className="pill ghost" onClick={() => setPinFor(null)}>
                {t("back")}
              </button>
              <button type="submit" className="pill primary" disabled={busy || pin.length < 4}>
                {t("confirm")}
              </button>
            </div>
          </form>
        ) : (
          <div className="profile-list">
            {list?.map((p, i) => (
              <button key={p.key} className={cls("profile", p.selected && "on")} disabled={busy} autoFocus={i === 0} onClick={() => pick(p, null)}>
                <Art src={p.photo} size={96} round className="sm" />
                <span className="profile-text">
                  <span className="name">{p.name}</span>
                  <span className="sub">
                    {p.sub}
                    {p.protected && ` 🔒`}
                  </span>
                </span>
                {p.selected && <span className="check" aria-label="✓">✓</span>}
              </button>
            ))}
          </div>
        )}
        {!pinFor && (
          <div className="dialog-actions">
            <button className="pill ghost" onClick={closeProfilePicker}>
              {t("close")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
