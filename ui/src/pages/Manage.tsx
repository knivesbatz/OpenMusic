// Local files, downloads, playlist transfer and settings.
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { checkForUpdates, updatesInBrowser } from "../store/update";

const LASTFM_API = "https://www.last.fm/api/account/create";
import { api, errorMessage, inTauri } from "../api";
import { Loading, Select, useAsync } from "../components/common";
import * as I from "../components/Icons";
import { TrackList } from "../components/TrackList";
import { useT, type Key } from "../i18n";
import * as P from "../player/engine";
import { isMobileApp, openProfilePicker, refreshLibrary, setService, useApp } from "../store/app";
import { signOut } from "../store/profile";
import { serviceName, useOn } from "../store/providers";
import { useProviderSignIn } from "../store/signin";
import { ServerList } from "./Login";
import { useSettings, type NormalizeLevel, type Quality } from "../store/settings";
import { toast } from "../store/ui";
import { SyncPlaylists } from "../components/SyncPlaylists";
import type { DownloadInfo, LastFmStatus, Provider, ScanReport, Track } from "../types";
import { cls, fmtBytes } from "../util";
import { CardShelf } from "./Browse";

const RELEASES_LATEST = "https://github.com/knivesbatz/OpenMusic/releases/latest";

/**
 * Phones: the newest release's page on GitHub (always the latest, with both apps' APKs), in the
 * phone's browser app. The Android app opens it there directly, so the GitHub app or this app's
 * own windows never take the link.
 */
async function openLatestRelease() {
  const bridge = (window as unknown as { OpenMusicMedia?: { openInBrowser?: (url: string) => boolean } }).OpenMusicMedia;
  try {
    if (bridge?.openInBrowser?.(RELEASES_LATEST)) return;
  } catch {
    /* an older app without the bridge: below */
  }
  if (inTauri) await openUrl(RELEASES_LATEST).catch((e) => toast(errorMessage(e)));
  else window.open(RELEASES_LATEST, "_blank");
}

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
  // Downloads are a Plex feature; files already downloaded stay manageable with Plex off.
  const plexOn = useOn("plex");
  const ytOn = useOn("youtube");
  const anyDownloaded = useApp((s) => s.downloaded.size > 0);
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
  if (!plexOn && (list ? !list.length : !anyDownloaded))
    return (
      <div className="page">
        <h1>{t("downloads")}</h1>
        <p className="muted">{ytOn ? t("downloadsUnsupported") : t("needsService", { service: serviceName("plex") })}</p>
      </div>
    );
  if (!list) return <Loading />;
  const done = list.filter((d) => d.status === "done").map((d) => d.track);
  const statusKey: Record<DownloadInfo["status"], Key> = { queued: "statusQueued", downloading: "statusDownloading", done: "statusDone", failed: "statusFailed", cancelled: "statusCancelled" };
  return (
    <div className="page">
      <h1>{t("downloads")}</h1>
      {usage && <p className="muted small">{t("downloadsUsage", { size: fmtBytes(usage.downloadsBytes) })}</p>}
      {!plexOn && <p className="muted small">{t("downloadsPlexOff")}</p>}
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
            {(d.status === "failed" || d.status === "cancelled") && plexOn && (
              <button className="pill ghost small" onClick={() => api.downloadTracks([d.track]).then(load, (e) => toast(errorMessage(e)))}>
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

const SOUNDIIZ = "https://soundiiz.com/";
const TUNEMYMUSIC = "https://www.tunemymusic.com/transfer";

/**
 * Transferring Spotify playlists is handed off to Soundiiz, which can write playlists to YouTube
 * Music and to Plex. A built-in importer would need a registered Spotify developer app, so the
 * app sends users to Soundiiz instead and picks the transferred playlists up from the library.
 */
export function ImportPage() {
  const t = useT();
  const ytOn = useOn("youtube");
  const plexOn = useOn("plex");
  const [syncing, setSyncing] = useState(false);
  // Soundiiz writes to each service that is on (YouTube Music when none is).
  const dest = ytOn && plexOn ? t("transferDestBoth") : plexOn ? serviceName("plex") : serviceName("youtube");
  const steps: Key[] = ["transferStep1", "transferStep2", "transferStep3", "transferStep4"];
  return (
    <div className="page import">
      <h1>{t("transferPlaylists")}</h1>
      <p className="muted">{t("transferIntro", { dest })}</p>
      <ol className="steps">
        {steps.map((k) => (
          <li key={k}>{t(k, { dest })}</li>
        ))}
      </ol>
      <div className="row gap">
        <button className="pill primary" onClick={() => (inTauri ? openUrl(SOUNDIIZ) : window.open(SOUNDIIZ, "_blank"))}>
          {t("openSoundiiz")}
        </button>
        <button
          className="pill ghost"
          disabled={syncing}
          onClick={async () => {
            setSyncing(true);
            await refreshLibrary(true);
            setSyncing(false);
            toast(t("libraryRefreshed"));
          }}
        >
          {syncing ? t("loading") : t("sync")}
        </button>
      </div>
      {(ytOn || !plexOn) && <p className="muted small">{t("transferNoteYt")}</p>}
      {plexOn && <p className="muted small">{t("transferNotePlex")}</p>}

      <h2>{t("tmmTitle")}</h2>
      <p className="muted">{t("tmmIntro")}</p>
      <ol className="steps">
        {(["tmmStep1", "tmmStep2", "tmmStep3", "tmmStep4"] as const).map((k) => (
          <li key={k}>{t(k, { dest })}</li>
        ))}
      </ol>
      <div className="row gap">
        <button className="pill ghost" onClick={() => (inTauri ? openUrl(TUNEMYMUSIC) : window.open(TUNEMYMUSIC, "_blank"))}>
          {t("openTuneMyMusic")}
        </button>
      </div>
      <p className="muted small">{t("tmmNote", { dest })}</p>

      <h2>{t("exportTitle")}</h2>
      <p className="muted">{t("exportHint")}</p>
    </div>
  );
}

/**
 * Settings → Services: one card per provider with its switch (`data-service`, flipped by the
 * self-test, so turning a service off never asks anything and never signs out), the account, and
 * Sign in / Sign out. Plex also has its server and Home users; YouTube its channels.
 */
function ServiceCard({ provider }: { provider: Provider }) {
  const t = useT();
  const on = useOn(provider);
  const auth = useApp((x) => x.auth?.[provider]);
  const flow = useProviderSignIn(provider, "settings");
  const plex = provider === "plex";
  const name = serviceName(provider);
  const signedIn = !!auth?.signedIn;
  const ready = signedIn && !auth?.needsServer;
  const status = ready
    ? auth?.account
      ? t("connectedAs", { name: auth.account })
      : name
    : signedIn
      ? t("chooseServer")
      : plex
        ? t("notSignedIn")
        : t("ytAnonymous");
  const servers = flow.here ? flow.servers : null;
  return (
    <div className="service">
      <label className="setting">
        <div className="grow">
          <div>{name}</div>
          <div className="muted small">{status}</div>
          {plex && ready && auth?.server && <div className="muted small">{t("server", { name: auth.server, conn: auth.serverConnection ?? "" })}</div>}
        </div>
        {/* Plex has nothing to show without an account: it turns on by signing in. */}
        <input
          type="checkbox"
          role="switch"
          className="switch"
          data-service={provider}
          aria-label={name}
          checked={on}
          disabled={!on && plex && !ready}
          onChange={(e) => void setService(provider, e.target.checked)}
        />
      </label>
      {servers ? (
        <div className="form">
          <p className="muted small">{t("chooseServer")}</p>
          <ServerList servers={servers} busy={flow.busy} onPick={flow.pickServer} />
          <button className="link small" disabled={flow.busy} onClick={flow.cancel}>
            {t("cancel")}
          </button>
        </div>
      ) : flow.busy && flow.here ? (
        <div className="row gap">
          <span className="muted small">
            {t("waitingApproval")}
            {flow.code ? ` PIN: ${flow.code}` : ""}
          </span>
          <button className="pill ghost small" onClick={flow.cancel}>
            {t("cancel")}
          </button>
        </div>
      ) : (
        <div className="row gap">
          {!signedIn && (
            <button className="pill primary small" data-testid={`signin-${provider}`} disabled={!inTauri || flow.busy} onClick={flow.start}>
              {t("signIn")}
            </button>
          )}
          {plex && signedIn && (
            <button className={cls("pill small", ready ? "ghost" : "primary")} onClick={flow.changeServer}>
              {ready ? t("changeServer") : t("choosePlexServer")}
            </button>
          )}
          {ready && (
            <button className="pill ghost small" disabled={!on} title={on ? undefined : t("needsService", { service: name })} onClick={() => openProfilePicker(provider)}>
              {t("switchProfile")}
            </button>
          )}
          {signedIn && (
            <button className="pill ghost small" onClick={() => void signOut(provider)}>
              {t("signOut")}
            </button>
          )}
        </div>
      )}
      {flow.here && flow.error && (
        <p className="error small" role="alert">
          {flow.error}
        </p>
      )}
    </div>
  );
}

export function SettingsPage() {
  const t = useT();
  const s = useSettings();
  const info = useApp((x) => x.info);
  const ytOn = useOn("youtube");
  const plexOn = useOn("plex");
  // Only Plex streams at a chosen quality (YouTube picks its own).
  const quality = plexOn && !!info?.providers.plex.qualityControl;
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

  const Toggle = ({ k, label, hint, disabled }: { k: "gapless" | "automix" | "normalizeVolume" | "autoplaySimilar" | "closeToTray" | "autoUpdate" | "discordPresence" | "shareAudio" | "privateSession" | "reducedMotion" | "highContrast" | "lastfmScrobble" | "htpc" | "translateNames" | "translateLyrics"; label: string; hint?: string; disabled?: boolean }) => (
    <label className={cls("setting", disabled && "disabled")}>
      <div className="grow">
        <div>{label}</div>
        {hint && <div className="muted small">{hint}</div>}
      </div>
      <input type="checkbox" role="switch" className="switch" checked={!disabled && s[k]} disabled={disabled} onChange={(e) => s.set({ [k]: e.target.checked })} />
    </label>
  );

  return (
    <div className="page settings">
      <h1>{t("settings")}</h1>

      <section className="services">
        <h2>{t("servicesSection")}</h2>
        <p className="muted small">{t("servicesHint")}</p>
        <ServiceCard provider="youtube" />
        <ServiceCard provider="plex" />
      </section>

      <section>
        <h2>{t("language")}</h2>
        <div className="setting">
          <div className="grow">
            <div>{t("appLanguage")}</div>
            <div className="muted small">{t("appLanguageHint")}</div>
          </div>
          <Select
            label={t("language")}
            value={s.language}
            onChange={(v) => s.set({ language: v })}
            options={[
              { value: "en", label: "English" },
              { value: "ja", label: "日本語" },
            ]}
          />
        </div>
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
        <Toggle k="translateLyrics" label={t("translateLyrics")} hint={t("translateLyricsHint")} />
      </section>

      <section>
        <h2>{t("playback")}</h2>
        <label className={cls("setting", !quality && "disabled")}>
          <div className="grow">
            <div>{t("audioQuality")}</div>
            <div className="muted small">
              {quality ? t(ytOn ? "qualityPlexOnly" : "qualityAutoHintPlex") : ytOn ? t("qualityProviderHint") : t("needsService", { service: serviceName("plex") })}
            </div>
          </div>
          <Select<Quality>
            label={t("audioQuality")}
            value={quality ? s.quality : "auto"}
            disabled={!quality}
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
            {ytOn && <div className="muted small">{t(plexOn ? "crossfadeMixed" : "crossfadeYouTube")}</div>}
          </div>
          <input type="range" className="slider wide" min={0} max={12} step={1} value={s.crossfade} style={{ ["--pct" as string]: (s.crossfade / 12) * 100 + "%" }} onChange={(e) => s.set({ crossfade: Number(e.target.value) })} aria-label={t("crossfade")} />
        </label>
        <Toggle k="gapless" label={t("gapless")} hint={t("gaplessHint")} />
        <Toggle k="automix" label={t("automix")} hint={t("automixHint")} />
        <Toggle k="autoplaySimilar" label={t("autoplay")} hint={t("autoplayHint")} />
        <Toggle
          k="normalizeVolume"
          label={t("normalizeVolume")}
          hint={t(ytOn && plexOn ? "normalizeVolumeHintBoth" : ytOn ? "normalizeVolumeHintYouTube" : "normalizeVolumeHint")}
        />
        {s.normalizeVolume && (
          <label className="setting">
            <div className="grow">
              <div>{t("normalizeLevel")}</div>
              <div className="muted small">{t("normalizeLevelHint")}</div>
            </div>
            <Select<NormalizeLevel>
              label={t("normalizeLevel")}
              value={s.normalizeLevel}
              onChange={(v) => s.set({ normalizeLevel: v })}
              options={[
                { value: "quiet", label: t("normalizeQuiet") },
                { value: "normal", label: t("normalizeNormal") },
                { value: "loud", label: t("normalizeLoud") },
              ]}
            />
          </label>
        )}
      </section>

      {!isMobileApp() && (
        <section>
          <h2>{t("window")}</h2>
          <Toggle k="closeToTray" label={t("closeToTray")} hint={t("closeToTrayHint")} />
          {info?.discordPresence && <Toggle k="discordPresence" label={t("discordPresence")} hint={t("discordPresenceHint")} />}
          {inTauri && info?.platform === "windows" && <Toggle k="shareAudio" label={t("shareAudio")} hint={t("shareAudioHint")} />}
        </section>
      )}

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
        <h2>{t("privacy")}</h2>
        <Toggle k="privateSession" label={t("privateSession")} hint={t("privateSessionHint")} />
      </section>

      {inTauri && <SyncPlaylists />}

      <section>
        <h2>{t("lastfm")}</h2>
        <Toggle k="lastfmScrobble" label={t("lastfmScrobble")} hint={lfm?.connected ? undefined : t("lastfmConnectFirst")} disabled={!lfm?.connected} />
        {lfm && !lfm.hasKeys && (
          <div className="form">
            <p className="muted small">{t("lastfmKeys")}</p>
            <button className="pill ghost small" onClick={() => (inTauri ? openUrl(LASTFM_API) : window.open(LASTFM_API, "_blank"))}>
              {t("lastfmGetKey")}
            </button>
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
              <button className="pill primary small" onClick={() => api.lastfmConnectFinish(lfmToken).then(() => (setLfmToken(null), s.set({ lastfmScrobble: true }), api.lastfmStatus().then(setLfm))).catch((e) => toast(errorMessage(e)))}>
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

      <section>
        <h2>{t("aboutApp")}</h2>
        <div className="setting">
          <div className="grow">
            <div>{info && t("version", { v: info.version })}</div>
            <div className="muted small">{t("updatesHint")}</div>
          </div>
          <button className="pill ghost small" onClick={() => checkForUpdates(true)}>
            {t("checkForUpdates")}
          </button>
        </div>
        {!updatesInBrowser() && <Toggle k="autoUpdate" label={t("autoUpdate")} hint={t("autoUpdateHint")} />}
        {isMobileApp() && (
          <div className="setting">
            <div className="grow">
              <div>{t("latestApk")}</div>
              <div className="muted small">{t("latestApkHint")}</div>
            </div>
            <button className="pill ghost small" onClick={openLatestRelease}>
              {t("openInBrowser")}
            </button>
          </div>
        )}
      </section>

      <footer className="credits">
        <p>{t("publishedBy", { name: "マッキニー マイヤ" })}</p>
        <p className="muted small">{info && `${info.name} — ${t("version", { v: info.version })}`}</p>
      </footer>
    </div>
  );
}
