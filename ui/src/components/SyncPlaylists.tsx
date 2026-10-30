// Settings → Sync playlists between devices: send app playlists over Wi-Fi (see sync.rs).
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../api";
import { useT } from "../i18n";
import { toast } from "../store/ui";
import type { SyncReceiving, SyncSummary } from "../types";

const LAST_ADDRESS = "om.syncAddress";

function lastAddress() {
  try {
    return localStorage.getItem(LAST_ADDRESS) ?? "";
  } catch {
    return "";
  }
}

export function SyncPlaylists() {
  const t = useT();
  const [recv, setRecv] = useState<SyncReceiving | null>(null);
  const recvRef = useRef(recv);
  recvRef.current = recv;
  const [address, setAddress] = useState(lastAddress);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const unRecv = listen<SyncSummary>("sync-received", (e) => toast(t("syncReceived", { n: e.payload.playlists, songs: e.payload.songs })));
    // Ten minutes are up (or too many wrong codes): hide the code it was showing.
    const unEnd = listen<string>("sync-receive-ended", (e) => recvRef.current?.code === e.payload && setRecv(null));
    return () => {
      unRecv.then((f) => f()).catch(() => {});
      unEnd.then((f) => f()).catch(() => {});
      if (recvRef.current) api.syncReceiveStop().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = () => api.syncReceiveStart().then(setRecv, (e) => toast(errorMessage(e)));
  const stop = () => api.syncReceiveStop().finally(() => setRecv(null));
  const send = () => {
    setBusy(true);
    api
      .syncSend(address, code)
      .then(
        (s) => {
          toast(t("syncSent", { n: s.playlists, songs: s.songs }) + (s.skipped ? ". " + t("syncSkipped", { n: s.skipped }) : ""));
          setCode("");
          try {
            localStorage.setItem(LAST_ADDRESS, address.trim());
          } catch {
            /* remembering is a convenience */
          }
        },
        (e) => toast(errorMessage(e)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <section className="sync">
      <h2>{t("syncPlaylists")}</h2>
      <p className="muted small">{t("syncPlaylistsHint")}</p>
      <div className="setting">
        <div className="grow">
          <div>{t("syncReceive")}</div>
          <div className="muted small">{t("syncReceiveHint")}</div>
        </div>
        {recv ? (
          <button className="pill ghost small" onClick={stop}>
            {t("syncStop")}
          </button>
        ) : (
          <button className="pill primary small" onClick={start}>
            {t("syncReceiveStart")}
          </button>
        )}
      </div>
      {recv && (
        <div className="sync-code" role="status">
          <div>
            <span className="muted small">{t("syncAddress")}</span>
            <strong>{recv.address}</strong>
          </div>
          <div>
            <span className="muted small">{t("syncCode")}</span>
            <strong>{recv.code}</strong>
          </div>
          <p className="muted small">{t("syncWaiting")}</p>
        </div>
      )}
      <div className="setting">
        <div className="grow">
          <div>{t("syncSend")}</div>
          <div className="muted small">{t("syncSendHint")}</div>
        </div>
      </div>
      <form
        className="form sync-send"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input placeholder="192.168.1.23:47380" aria-label={t("syncAddress")} inputMode="url" autoComplete="off" value={address} onChange={(e) => setAddress(e.target.value)} />
        <input placeholder="123456" aria-label={t("syncCode")} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} />
        <button type="submit" className="pill primary small" disabled={busy || !address.trim() || code.length !== 6}>
          {t("syncSendButton")}
        </button>
      </form>
    </section>
  );
}
