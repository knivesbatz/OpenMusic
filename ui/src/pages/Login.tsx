import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorMessage, inTauri } from "../api";
import { useT } from "../i18n";
import { setLocalOnly, useApp } from "../store/app";
import type { PlexServer } from "../types";

export function Login() {
  const t = useT();
  const info = useApp((s) => s.info);
  const auth = useApp((s) => s.auth);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [servers, setServers] = useState<PlexServer[] | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const plex = info?.flavor === "plex";

  useEffect(() => {
    if (plex && auth?.signedIn && auth.needsServer) api.plexServers().then(setServers, (e) => setError(errorMessage(e)));
  }, [plex, auth]);

  useEffect(() => {
    if (!inTauri || plex) return;
    const a = listen("login-done", async () => {
      setBusy(false);
      useApp.setState({ auth: await api.authStatus() });
    });
    const b = listen<string>("login-error", (e) => {
      setBusy(false);
      setError(e.payload);
    });
    return () => {
      a.then((f) => f());
      b.then((f) => f());
    };
  }, [plex]);

  async function signInPlex() {
    setBusy(true);
    setError(null);
    try {
      const pin = await api.plexPinStart();
      setCode(pin.code);
      await openUrl(pin.authUrl);
      const started = Date.now();
      while (Date.now() - started < 10 * 60_000) {
        await new Promise((r) => setTimeout(r, 2000));
        if (await api.plexPinPoll(pin.id)) {
          const auth = await api.authStatus();
          useApp.setState({ auth });
          setServers(await api.plexServers());
          setBusy(false);
          return;
        }
      }
      setError(t("signInTimeout"));
    } catch (e) {
      setError(errorMessage(e));
    }
    setBusy(false);
  }

  async function signInYouTube() {
    setBusy(true);
    setError(null);
    try {
      await api.ytLogin();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  async function pick(s: PlexServer) {
    setBusy(true);
    setError(null);
    try {
      await api.plexSelectServer(s.clientIdentifier);
      useApp.setState({ auth: await api.authStatus() });
    } catch (e) {
      setError(errorMessage(e));
    }
    setBusy(false);
  }

  return (
    <div className="login">
      <div className="login-card">
        <div className="logo" aria-hidden="true">
          {plex ? "P" : "Y"}
        </div>
        <h1>{t("welcome", { app: info?.name ?? "" })}</h1>
        {servers ? (
          <>
            <h2>{t("chooseServer")}</h2>
            {!servers.length && <p className="muted">{t("noServers")}</p>}
            <div className="server-list">
              {servers.map((s) => (
                <button key={s.clientIdentifier} className="server" disabled={busy} onClick={() => pick(s)}>
                  <span className="name">{s.name}</span>
                  <span className="sub">
                    {s.owned ? t("owned") : t("shared")} • {s.connections.some((c) => c.local) ? t("localNetwork") : t("remote")}
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <p className="muted">{plex ? t("signInPlexHint") : t("signInYouTubeHint")}</p>
            <button className="pill primary big" disabled={busy || !inTauri} onClick={plex ? signInPlex : signInYouTube}>
              {busy ? t("waitingApproval") : plex ? t("signInPlex") : t("signInYouTube")}
            </button>
            {code && busy && <p className="muted small">PIN: {code}</p>}
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="link" onClick={() => setLocalOnly(true)}>
          {t("continueWithout")}
        </button>
      </div>
    </div>
  );
}
