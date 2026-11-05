// "Connect your music": the first screen of a fresh install. Sign in to YouTube Music, Plex or
// both, use YouTube Music without an account, or skip to local files. The sign-in flows themselves
// live in store/signin.ts, shared with Settings → Services.
import { inTauri } from "../api";
import { useT } from "../i18n";
import { continueWithoutAccount, skipToLocalFiles, useProviderSignIn } from "../store/signin";
import type { PlexServer } from "../types";

/** Plex servers to choose from (the last step of a Plex sign-in). Also used in Settings. */
export function ServerList({ servers, busy, onPick }: { servers: PlexServer[]; busy: boolean; onPick: (s: PlexServer) => void }) {
  const t = useT();
  return (
    <>
      {!servers.length && <p className="muted">{t("noServers")}</p>}
      <div className="server-list">
        {servers.map((s) => (
          <button key={s.clientIdentifier} className="server" disabled={busy} onClick={() => onPick(s)}>
            <span className="name">{s.name}</span>
            <span className="sub">
              {s.owned ? t("owned") : t("shared")} • {s.connections.some((c) => c.local) ? t("localNetwork") : t("remote")}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

export function Connect() {
  const t = useT();
  const yt = useProviderSignIn("youtube", "connect");
  const plex = useProviderSignIn("plex", "connect");
  const busy = yt.busy || plex.busy;
  const servers = plex.here ? plex.servers : null;
  const error = (yt.here && yt.error) || (plex.here && plex.error) || null;

  return (
    <div className="login">
      <div className="login-card">
        <div className="logo" aria-hidden="true">
          O
        </div>
        <h1>{t("connectTitle")}</h1>
        {servers ? (
          <>
            <h2>{t("chooseServer")}</h2>
            <ServerList servers={servers} busy={plex.busy} onPick={plex.pickServer} />
            <button className="link" disabled={plex.busy} onClick={plex.cancel}>
              {t("cancel")}
            </button>
          </>
        ) : (
          <>
            <p className="muted">{t("connectHint")}</p>
            <button className="pill primary big" data-testid="connect-youtube" disabled={busy || !inTauri} onClick={yt.start}>
              {yt.busy && yt.here ? t("waitingApproval") : t("connectYouTube")}
            </button>
            <button className="pill primary big" data-testid="connect-plex" disabled={busy || !inTauri} onClick={plex.start}>
              {plex.busy && plex.here ? t("waitingApproval") : t("connectPlex")}
            </button>
            {plex.code && plex.busy && plex.here && <p className="muted small">PIN: {plex.code}</p>}
            {busy && (
              <button className="link" onClick={() => (yt.busy ? yt.cancel() : plex.cancel())}>
                {t("cancel")}
              </button>
            )}
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!servers && (
          <>
            <button className="link" data-testid="connect-anonymous" disabled={busy || !inTauri} onClick={() => void continueWithoutAccount()}>
              {t("useYouTubeWithoutAccount")}
            </button>
            <button className="link" data-testid="connect-local" disabled={busy} onClick={() => void skipToLocalFiles()}>
              {t("skipLocalOnly")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** The 1.x name of this page. */
export const Login = Connect;
