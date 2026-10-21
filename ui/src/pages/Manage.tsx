// Local files, downloads, Spotify import and settings.
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorMessage, inTauri } from "../api";
import { ErrorBox, Loading, Select, useAsync } from "../components/common";
import * as I from "../components/Icons";
import { TrackList } from "../components/TrackList";
import { useT, type Key } from "../i18n";
import * as P from "../player/engine";
import { isMobileApp, openProfilePicker, refreshPlaylists, setLocalOnly, useApp } from "../store/app";
import { useSettings, type Quality } from "../store/settings";
import { confirmDialog, navigate, toast } from "../store/ui";
import type { DownloadInfo, ImportReport, LastFmStatus, ScanReport, SpotifyPlaylist, Track } from "../types";
import { cls, fmtBytes } from "../util";
import { CardShelf } from "./Browse";

export function LocalPage() {
  const t = useT();
  const [folders, setFolders] = useState<string[]>([]);
  const [lib, setLib] = useState<{ tracks: Track[]; albums: import("../types").Album[]; artists: import("../types").Artist[] } | null>(null);
  const [report, setReport] = useState<ScanReport | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    if (!inTauri) return setLib({ tracks: [], albums: [], artists: [] });
    const [f, l] = await Promise.all([api.localFolders(), api.localLibrary()]);
    setFolders(f ?? []);
    setLib({ tracks: l?.tracks ?? [], albums: l?.albums ?? [], artists: l?.artists ?? [] });
  };
  useEffect(() => {
    load().catch((e) => toast(errorMessage(e)));
    if (!inTauri) return;
    const un = listen("local-changed", () => load().catch(() => {}));
    return () => void un.then((f) => f());
  }, []);

  async function run(fn: () => Promise<ScanReport>) {
    setBusy(true);
    try {
      setReport(await fn());
      await load();
    } catch (e) {
      toast(errorMessage(e));
    }
    setBusy(false);
  }

  async function add() {
    const dir = await openDialog({ directory: true, multiple: false });
    if (typeof dir === "string") run(() => api.localAddFolder(dir));
  }

  const ctx = { kind: "local", id: "local", title: t("localFiles") };
  return (
    <div className="page">
      <div className="row between">
        <h1>{t("localFiles")}</h1>
        <div className="row gap">
          <button className="pill ghost small" disabled={busy || !folders.length} onClick={() => run(api.localScan)}>
            {busy ? t("scanning") : t("rescan")}
          </button>
          <button className="pill primary small" disabled={busy || !inTauri || isMobileApp()} title={isMobileApp() ? t("localFilesMobile") : undefined} onClick={add}>
            {t("addFolder")}
          </button>
        </div>
      </div>
      {report && <p className="muted small">{t("scanResult", { ...report })}</p>}
      {folders.length ? (
        <ul className="folders">
          {folders.map((f) => (
            <li key={f}>
              <I.IFolder size={16} /> <span className="grow">{f}</span>
              <button className="link small" disabled={busy} onClick={() => run(() => api.localRemoveFolder(f))}>
                {t("removeFolder")}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{t("noFolders")}</p>
      )}
      {!lib ? (
        <Loading />
      ) : (
        <>
          {lib.tracks.length > 0 && (
            <div className="action-bar">
              <button className="fab big static" aria-label={t("play")} onClick={() => P.playTracks(lib.tracks, 0, ctx)}>
                <I.IPlay size={24} />
              </button>
            </div>
          )}
          <CardShelf title={t("albums")} items={lib.albums.map((a) => ({ type: "album" as const, ...a }))} />
          <CardShelf title={t("artists")} items={lib.artists.map((a) => ({ type: "artist" as const, ...a }))} />
          {lib.tracks.length > 0 && (
            <section>
              <h2>{t("songs")}</h2>
              <TrackList tracks={lib.tracks} context={ctx} />
            </section>
          )}
        </>
      )}
    </div>
  );
}

export function DownloadsPage() {
  const t = useT();
  const caps = useApp((s) => s.info?.capabilities);
  const [list, setList] = useState<DownloadInfo[] | null>(null);
  const [usage, setUsage] = useState<{ downloadsBytes: number } | null>(null);
  const load = () => {
    if (!inTauri) return setList([]);
    api.downloadList().then(setList, (e) => toast(errorMessage(e)));
    api.storageUsage().then(setUsage, () => {});
  };
  useEffect(() => {
    load();
    if (!inTauri) return;
    const un = listen("downloads-changed", load);
    // Progress for active downloads is polled only while any are running.
    const id = setInterval(() => list?.some((d) => d.status === "downloading" || d.status === "queued") && load(), 1500);
    return () => {
      un.then((f) => f());
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list?.some((d) => d.status === "downloading" || d.status === "queued")]);
  if (!caps?.downloads) return <div className="page"><h1>{t("downloads")}</h1><p className="muted">{t("downloadsUnsupported")}</p></div>;
  if (!list) return <Loading />;
  const done = list.filter((d) => d.status === "done").map((d) => d.track);
  const statusKey: Record<DownloadInfo["status"], Key> = { queued: "statusQueued", downloading: "statusDownloading", done: "statusDone", failed: "statusFailed", cancelled: "statusCancelled" };
  return (
    <div className="page">
      <h1>{t("downloads")}</h1>
      {usage && <p className="muted small">{t("downloadsUsage", { size: fmtBytes(usage.downloadsBytes) })}</p>}
      {!list.length && <p className="muted">{t("downloadsEmpty")}</p>}
      {done.length > 0 && (
        <div className="action-bar">
          <button className="fab big static" aria-label={t("play")} onClick={() => P.playTracks(done, 0, { kind: "downloads", id: "downloads", title: t("downloads") })}>
            <I.IPlay size={24} />
          </button>
        </div>
      )}
      <ul className="dl-list">
        {list.map((d) => (
          <li key={d.track.id} className={cls("dl", d.status)}>
            <div className="grow">
              <div className="name">{d.track.title}</div>
              <div className="sub">
                {d.track.artist} • {t(statusKey[d.status])}
                {d.error ? ` — ${d.error}` : ""}
              </div>
              {d.status === "downloading" && (
                <div className="bar">
                  <div style={{ width: d.total ? (d.bytes / d.total) * 100 + "%" : "30%" }} />
                </div>
              )}
            </div>
            {(d.status === "failed" || d.status === "cancelled") && (
              <button className="pill ghost small" onClick={() => api.downloadTracks([d.track]).then(load)}>
                {t("retry")}
              </button>
            )}
            {(d.status === "downloading" || d.status === "queued") && (
              <button className="pill ghost small" onClick={() => api.downloadCancel(d.track.id).then(load)}>
                {t("cancel")}
              </button>
            )}
            {(d.status === "done" || d.status === "failed" || d.status === "cancelled") && (
              <button className="link small" onClick={() => api.downloadRemove(d.track.id).then(load)}>
                {t("removeDownload")}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

const REDIRECT = "http://127.0.0.1:43117/callback";

export function ImportPage() {
  const t = useT();
  const [user, setUser] = useState<string | null | undefined>(undefined);
  const [clientId, setClientId] = useState("");
  const [lists, setLists] = useState<SpotifyPlaylist[] | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [pick, setPick] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [builtin, setBuiltin] = useState(false);
  const [ownId, setOwnId] = useState(false);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    if (!inTauri) return setUser(null);
    api.spotifyBuiltin().then(setBuiltin, () => setBuiltin(false));
    api.spotifyStatus().then(setUser, () => setUser(null));
    const un = listen<{ done: number; total: number }>("import-progress", (e) => setProgress(e.payload));
    return () => void un.then((f) => f());
  }, []);
  useEffect(() => {
    if (user) api.spotifyPlaylists().then(setLists, (e) => setError(errorMessage(e)));
  }, [user]);

  async function connect(useOwn: boolean) {
    setError(null);
    setConnecting(true);
    try {
      await api.spotifyConnect(useOwn ? clientId.trim() : null);
      setUser(await api.spotifyStatus());
    } catch (e) {
      setError(errorMessage(e));
    }
    setConnecting(false);
  }

  async function run(p: SpotifyPlaylist) {
    setError(null);
    setReport(null);
    setProgress({ done: 0, total: p.trackCount });
    try {
      const r = await api.spotifyImport(p.id, p.name);
      setReport(r);
      setPick(new Set(r.rows.map((row, i) => (row.status === "ambiguous" && row.matched ? i : -1)).filter((i) => i >= 0)));
      refreshPlaylists();
    } catch (e) {
      setError(errorMessage(e));
    }
    setProgress(null);
  }

  async function addAmbiguous() {
    if (!report) return;
    const tracks = report.rows.filter((_, i) => pick.has(i)).map((r) => r.matched!).filter(Boolean);
    try {
      const id = await api.importConfirm(report.playlistId ?? null, report.name, tracks);
      toast(t("addedToPlaylist", { name: report.name }));
      navigate({ name: "playlist", id });
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  if (user === undefined) return <Loading />;
  return (
    <div className="page import">
      <h1>{t("importSpotify")}</h1>
      {error && <ErrorBox message={error} />}
      {!user && builtin && !ownId ? (
        <div className="form">
          <p className="muted">{t("spotifySignInHint")}</p>
          <div className="row gap">
            <button className="pill primary" disabled={connecting} onClick={() => connect(false)}>
              {connecting ? t("waitingApproval") : t("signInSpotify")}
            </button>
            <button className="link small" onClick={() => setOwnId(true)}>
              {t("spotifyUseOwnId")}
            </button>
          </div>
        </div>
      ) : !user ? (
        <div className="form">
          <p className="muted">{t("spotifyHint")}</p>
          <code className="redirect">{REDIRECT}</code>
          <label className="field">
            <span>{t("spotifyClientId")}</span>
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} spellCheck={false} />
          </label>
          <div className="row gap">
            <button className="pill primary" disabled={!clientId.trim() || !inTauri || connecting} onClick={() => connect(true)}>
              {connecting ? t("waitingApproval") : t("connect")}
            </button>
            <button className="link small" onClick={() => openUrl("https://developer.spotify.com/dashboard")}>
              developer.spotify.com
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="row between">
            <p className="muted">{t("connectedAs", { name: user })}</p>
            <button className="link small" onClick={() => api.spotifyDisconnect().then(() => (setUser(null), setLists(null)))}>
              {t("disconnect")}
            </button>
          </div>
          <p className="muted small">{t("importSkipNote")}</p>
          {progress && (
            <div role="status" className="import-progress">
              {t("importing", { done: progress.done, total: progress.total })}
              <div className="bar">
                <div style={{ width: progress.total ? (progress.done / progress.total) * 100 + "%" : "0" }} />
              </div>
            </div>
          )}
          {report && (
            <section className="report">
              <h2>{report.name}</h2>
              <div className="stats">
                <span className="ok">{t("imported")}: {report.imported}</span>
                <span>{t("duplicates")}: {report.duplicates}</span>
                <span className="warn">{t("ambiguous")}: {report.ambiguous}</span>
                <span className="bad">{t("skipped")}: {report.skipped}</span>
              </div>
              <table className="report-table">
                <tbody>
                  {report.rows
                    .map((r, i) => ({ r, i }))
                    .filter(({ r }) => r.status !== "imported")
                    .map(({ r, i }) => (
                      <tr key={i} className={r.status}>
                        <td>
                          {r.status === "ambiguous" && r.matched && (
                            <input
                              type="checkbox"
                              aria-label={t("addSelected")}
                              checked={pick.has(i)}
                              onChange={() => setPick((s) => {
                                const n = new Set(s);
                                if (n.has(i)) n.delete(i);
                                else n.add(i);
                                return n;
                              })}
                            />
                          )}
                        </td>
                        <td>{r.title} — {r.artist}</td>
                        <td className="muted">{r.matched ? `→ ${r.matched.title} — ${r.matched.artist}` : ""}</td>
                        <td>{t(r.status === "ambiguous" ? "ambiguous" : r.status === "duplicate" ? "duplicates" : "skipped")}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {pick.size > 0 && (
                <button className="pill primary" onClick={addAmbiguous}>
                  {t("addSelected")}
                </button>
              )}
            </section>
          )}
          {!lists ? (
            <Loading />
          ) : (
            <ul className="sp-list">
              {lists.map((p) => (
                <li key={p.id}>
                  <div className="grow">
                    <div className="name">{p.name}</div>
                    <div className="sub">{t("by", { name: p.owner })} • {t("songsCount", { n: p.trackCount })}</div>
                  </div>
                  <button className="pill ghost small" disabled={!!progress} onClick={() => run(p)}>
                    {t("importAction")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

export function SettingsPage() {
  const t = useT();
  const s = useSettings();
  const info = useApp((x) => x.info);
  const auth = useApp((x) => x.auth);
  const caps = info?.capabilities;
  const yt = info?.flavor === "youtube";
  const usage = useAsync(() => (inTauri ? api.storageUsage() : Promise.resolve(null)), []);
  const [lfm, setLfm] = useState<LastFmStatus | null>(null);
  const [keys, setKeys] = useState({ key: "", secret: "" });
  const [lfmToken, setLfmToken] = useState<string | null>(null);

  const [autostart, setAutostart] = useState<boolean | null>(null);

  useEffect(() => {
    if (!inTauri) return;
    api.lastfmStatus().then(setLfm, () => {});
    api.htpcAutostartGet().then(setAutostart, () => setAutostart(null));
  }, []);

  const Toggle = ({ k, label, hint, disabled }: { k: "gapless" | "automix" | "autoplay" | "reducedMotion" | "highContrast" | "scrobble" | "htpc" | "translateNames"; label: string; hint?: string; disabled?: boolean }) => (
    <label className={cls("setting", disabled && "disabled")}>
      <div className="grow">
        <div>{label}</div>
        {hint && <div className="muted small">{hint}</div>}
      </div>
      <input type="checkbox" role="switch" className="switch" checked={!disabled && s[k]} disabled={disabled} onChange={(e) => s.set({ [k]: e.target.checked })} />
    </label>
  );

  async function signOut() {
    if (!(await confirmDialog({ title: t("signOut"), body: t("signOutBody"), confirm: t("signOut") }))) return;
    await api.signOut().catch(() => {});
    await api.kvSet(yt ? "yt.profileChosen" : "plex.profileChosen", false).catch(() => {});
    await setLocalOnly(false);
    useApp.setState({ auth: await api.authStatus(), library: null });
  }

  return (
    <div className="page settings">
      <h1>{t("settings")}</h1>

      <section>
        <h2>{t("account")}</h2>
        {auth?.signedIn ? (
          <>
            {auth.account && <p>{t("connectedAs", { name: auth.account })}</p>}
            {auth.server && <p className="muted small">{t("server", { name: auth.server, conn: auth.serverConnection ?? "" })}</p>}
            <div className="row gap">
              {!yt && (
                <button className="pill ghost small" onClick={() => useApp.setState({ auth: { ...auth, needsServer: true } })}>
                  {t("changeServer")}
                </button>
              )}
              <button className="pill ghost small" onClick={openProfilePicker}>
                {t("switchProfile")}
              </button>
              <button className="pill ghost small" onClick={signOut}>
                {t("signOut")}
              </button>
            </div>
          </>
        ) : (
          <button className="pill primary small" onClick={() => setLocalOnly(false)}>
            {t("signIn")}
          </button>
        )}
      </section>

      <section>
        <h2>{t("language")}</h2>
        <Select
          label={t("language")}
          value={s.language}
          onChange={(v) => s.set({ language: v })}
          options={[
            { value: "en", label: "English" },
            { value: "ja", label: "日本語" },
          ]}
        />
        <label className="setting">
          <div className="grow">
            <div>{t("japaneseDisplay")}</div>
            <div className="muted small">{t("japaneseDisplayHint")}</div>
          </div>
          <Select
            label={t("japaneseDisplay")}
            value={s.jpMode}
            onChange={(v) => s.set({ jpMode: v })}
            options={[
              { value: "original", label: t("jpOriginal") },
              { value: "romaji", label: t("jpRomaji") },
              { value: "both", label: t("jpBoth") },
            ]}
          />
        </label>
        <Toggle k="translateNames" label={t("translateNames")} hint={t("translateNamesHint")} />
      </section>

      <section>
        <h2>{t("playback")}</h2>
        <label className={cls("setting", !caps?.qualityControl && "disabled")}>
          <div className="grow">
            <div>{t("audioQuality")}</div>
            <div className="muted small">{caps?.qualityControl ? t("qualityAutoHintPlex") : t("qualityProviderHint")}</div>
          </div>
          <Select<Quality>
            label={t("audioQuality")}
            value={caps?.qualityControl ? s.quality : "auto"}
            disabled={!caps?.qualityControl}
            onChange={(v) => s.set({ quality: v })}
            options={[
              { value: "auto", label: t("qualityAuto") },
              { value: "low", label: t("qualityLow") },
              { value: "medium", label: t("qualityMedium") },
              { value: "high", label: t("qualityHigh") },
            ]}
          />
        </label>
        <label className="setting">
          <div className="grow">
            <div>{t("crossfade")}: {s.crossfade} s</div>
            {yt && <div className="muted small">{t("crossfadeYouTube")}</div>}
          </div>
          <input type="range" className="slider wide" min={0} max={12} step={1} value={s.crossfade} style={{ ["--pct" as string]: (s.crossfade / 12) * 100 + "%" }} onChange={(e) => s.set({ crossfade: Number(e.target.value) })} aria-label={t("crossfade")} />
        </label>
        <Toggle k="gapless" label={t("gapless")} hint={t("gaplessHint")} />
        <Toggle k="automix" label={t("automix")} hint={t("automixHint")} />
        <Toggle k="autoplay" label={t("autoplay")} />
      </section>

      {inTauri && info?.platform === "windows" && (
        <section>
          <h2>{t("performance")}</h2>
          <label className="setting">
            <div className="grow">
              <div>{t("gpuAccel")}</div>
              <div className="muted small">{info.safeMode === "auto" ? t("safeModeAuto") : t("gpuAccelHint")}</div>
            </div>
            <input
              type="checkbox"
              role="switch"
              className="switch"
              defaultChecked={!info.safeMode}
              onChange={(e) => api.gpuSet(e.target.checked).then(() => toast(t("restartToApply")), (err) => toast(errorMessage(err)))}
            />
          </label>
        </section>
      )}

      <section>
        <h2>{t("accessibility")}</h2>
        <label className="setting">
          <div className="grow">{t("textSize")}: {Math.round(s.textScale * 100)}%</div>
          <input type="range" className="slider wide" min={0.85} max={1.5} step={0.05} value={s.textScale} style={{ ["--pct" as string]: ((s.textScale - 0.85) / 0.65) * 100 + "%" }} onChange={(e) => s.set({ textScale: Number(e.target.value) })} aria-label={t("textSize")} />
        </label>
        <Toggle k="reducedMotion" label={t("reduceMotion")} />
        <Toggle k="highContrast" label={t("highContrast")} />
        <p className="muted small">{t("shortcuts")}</p>
      </section>

      {!isMobileApp() && <section>
        <h2>{t("htpc")}</h2>
        <Toggle k="htpc" label={t("htpc")} hint={t("htpcHint")} />
        <label className={cls("setting", autostart === null && "disabled")}>
          <div className="grow">
            <div>{t("htpcAutostart")}</div>
            <div className="muted small">{t("htpcAutostartHint")}</div>
          </div>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={!!autostart}
            disabled={autostart === null}
            onChange={(e) => {
              const on = e.target.checked;
              api.htpcAutostartSet(on).then(() => setAutostart(on), (err) => toast(errorMessage(err)));
            }}
          />
        </label>
      </section>}

      <section>
        <h2>{t("lastfm")}</h2>
        <Toggle k="scrobble" label={t("lastfmScrobble")} />
        {lfm && !lfm.hasKeys && (
          <div className="form">
            <p className="muted small">{t("lastfmKeys")}</p>
            <input placeholder={t("apiKey")} aria-label={t("apiKey")} value={keys.key} onChange={(e) => setKeys({ ...keys, key: e.target.value })} />
            <input placeholder={t("sharedSecret")} aria-label={t("sharedSecret")} type="password" value={keys.secret} onChange={(e) => setKeys({ ...keys, secret: e.target.value })} />
            <button className="pill ghost small" disabled={!keys.key || !keys.secret} onClick={() => api.lastfmSetKeys(keys.key.trim(), keys.secret.trim()).then(() => api.lastfmStatus().then(setLfm)).catch((e) => toast(errorMessage(e)))}>
              {t("save")}
            </button>
          </div>
        )}
        {lfm?.hasKeys && !lfm.connected && (
          <div className="row gap">
            {!lfmToken ? (
              <button className="pill primary small" onClick={() => api.lastfmConnectStart().then(setLfmToken).catch((e) => toast(errorMessage(e)))}>
                {t("lastfmConnect")}
              </button>
            ) : (
              <button className="pill primary small" onClick={() => api.lastfmConnectFinish(lfmToken).then(() => (setLfmToken(null), api.lastfmStatus().then(setLfm))).catch((e) => toast(errorMessage(e)))}>
                {t("lastfmFinish")}
              </button>
            )}
          </div>
        )}
        {lfm?.connected && (
          <div className="row gap">
            <span>{t("connectedAs", { name: lfm.user ?? "" })}</span>
            {lfm.pending > 0 && <span className="muted small">{t("lastfmPending", { n: lfm.pending })}</span>}
            <button className="link small" onClick={() => api.lastfmDisconnect().then(() => api.lastfmStatus().then(setLfm))}>
              {t("lastfmDisconnect")}
            </button>
          </div>
        )}
      </section>

      <section>
        <h2>{t("storage")}</h2>
        {usage.data && (
          <>
            <p className="muted small">{t("downloadsUsage", { size: fmtBytes(usage.data.downloadsBytes) })}</p>
            <p className="muted small">{t("cacheUsage", { size: fmtBytes(usage.data.artCacheBytes) })}</p>
          </>
        )}
        <button className="pill ghost small" onClick={() => api.clearCache().then(() => (toast(t("cacheCleared")), usage.reload())).catch((e) => toast(errorMessage(e)))}>
          {t("clearCache")}
        </button>
      </section>

      <p className="muted small">{info && `${info.name} — ${t("version", { v: info.version })}`}</p>
    </div>
  );
}
