// Spotify-style Profile page: your photo and name (changeable in the app), how many public
// playlists you have and how many artists you follow, your top artists this month, your public
// playlists and the artists you played recently.
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { providerOfId, signedInTo, visibleId } from "../actions";
import { api, errorMessage, inTauri } from "../api";
import { Art, Card, ErrorBox, Loading, Shelf, useAsync, usePageTitle, useProvidersKey } from "../components/common";
import * as I from "../components/Icons";
import { useT } from "../i18n";
import { openProfilePicker, refreshLibrary, refreshSaved, useApp } from "../store/app";
import { loadProfile, pickPhoto, saveCustomProfile, useMe, useProfile } from "../store/profile";
import { isOn } from "../store/providers";
import { navigate, openMenu, toast, useUi, type MenuItem } from "../store/ui";
import type { Artist, MediaItem, Playlist, Provider } from "../types";
import { PROVIDERS } from "../types";
import { isYtLiked, serviceLabel } from "../util";
import { cardMenu, Grid, playItem } from "./Browse";
import { Hero } from "./Detail";

type Section = "top" | "recent" | "playlists";

const dedupe = <T extends { id: string }>(xs: T[]) => xs.filter((x, i) => xs.findIndex((y) => y.id === x.id) === i);

/** Your playlists other people can see. YouTube (the profile is the channel's): the channel's
 * public playlists. Otherwise (Plex has no public playlists, or the channel couldn't be read): the
 * playlists you own: the app's, Plex's (a server's playlists are yours) and YouTube playlists of
 * your channel. */
function usePlaylists(): { list: Playlist[]; isPublic: boolean } {
  const info = useProfile((s) => s.info);
  const lib = useApp((s) => s.library);
  const appPls = useApp((s) => s.playlists);
  const auth = useApp((s) => s.auth);
  const me = useMe();
  useProvidersKey();
  if (info?.publicPlaylists) return { list: info.publicPlaylists, isPublic: true };
  const ytName = auth?.youtube?.account;
  const own = dedupe([...appPls, ...(lib?.playlists ?? [])]).filter((p) => {
    if (isYtLiked(p.id) || !visibleId(p.id)) return false;
    const service = providerOfId(p.id);
    if (p.local || service === "plex" || !p.owner) return true;
    return p.owner === me.name || p.owner === info?.name || (!!ytName && p.owner === ytName);
  });
  return { list: own, isPublic: false };
}

/** Artists you follow: the same list as Your Library → Artists (saved in the app, plus YouTube
 * Music's library; Plex's artists are the whole server, so only saved ones count). */
function useFollowing(): Artist[] {
  const saved = useApp((s) => s.saved.artists);
  const lib = useApp((s) => s.library);
  useProvidersKey();
  return dedupe([...saved, ...(lib?.artists ?? []).filter((a) => providerOfId(a.id) === "youtube")]).filter((a) => visibleId(a.id));
}

/** Services with a profile to switch: on and signed in (YouTube channels, Plex Home users). */
const profileServices = (): Provider[] => PROVIDERS.filter((p) => isOn(p) && signedInTo(p));

function useHistoryArtists(kind: "top" | "recent", limit: number) {
  return useAsync(() => (inTauri ? api.profileArtists(kind, limit) : Promise.resolve([] as Artist[])), [kind, limit]);
}

const asItems = (artists: Artist[]): MediaItem[] => artists.map((a) => ({ type: "artist" as const, ...a }));

export function ProfilePage({ section }: { section?: Section }) {
  useEffect(() => {
    loadProfile();
    refreshLibrary(false);
    refreshSaved();
    // Hiding (or deleting) a playlist changes the public playlists shown here.
    if (!inTauri) return;
    const off = listen("playlists-changed", () => loadProfile(true));
    return () => void off.then((f) => f());
  }, []);
  return section ? <ProfileSection section={section} /> : <ProfileMain />;
}

function ProfileMain() {
  const t = useT();
  const me = useMe();
  const error = useProfile((s) => s.error);
  const info = useProfile((s) => s.info);
  const pls = usePlaylists();
  const following = useFollowing();
  const top = useHistoryArtists("top", 10);
  const recent = useHistoryArtists("recent", 10);
  usePageTitle(me.name || t("profile"));

  const edit = () => useUi.setState({ profileEdit: true });
  const more = (e: React.MouseEvent) => {
    const items: MenuItem[] = [{ label: t("editProfile"), icon: I.IEdit, onClick: edit }];
    if (info?.url) {
      const url = info.url;
      items.push({
        label: t("copyProfileLink"),
        icon: I.ILink,
        onClick: () => navigator.clipboard.writeText(url).then(() => toast(t("copied")), (err) => toast(errorMessage(err))),
      });
    }
    // "Switch profile": one entry per service (a submenu while both have an account).
    const svc = profileServices();
    if (svc.length === 1) items.push({ label: t("switchProfile"), icon: I.IUser, onClick: () => openProfilePicker(svc[0]) });
    else if (svc.length > 1)
      items.push({ label: t("switchProfile"), icon: I.IUser, submenu: svc.map((p) => ({ label: serviceLabel(p), onClick: () => openProfilePicker(p) })) });
    openMenu(e, items);
  };

  const counts = [
    t(pls.isPublic ? "publicPlaylistsCount" : "playlistsCount", { n: pls.list.length }),
    t("followingCount", { n: following.length }),
  ];

  return (
    <div className="page profile-page">
      <Hero
        art={me.photo}
        round
        kind={t("profile")}
        title={me.name || t("profile")}
        onArt={edit}
        onTitle={edit}
        artLabel={t("choosePhoto")}
        placeholder={<I.IUser size={96} />}
        meta={
          <span className="profile-counts">
            {counts.map((c, i) => (
              <span key={i}>{c}</span>
            ))}
          </span>
        }
      />
      <div className="action-bar profile-actions">
        <button className="icon-btn" aria-label={t("settings")} title={t("settings")} onClick={() => navigate({ name: "settings" })}>
          <I.ISettings size={24} />
        </button>
        <button className="icon-btn" aria-label={t("more")} title={t("more")} onClick={more}>
          <I.IMore size={24} />
        </button>
      </div>
      {error && !info && <ErrorBox message={error} onRetry={() => loadProfile(true)} />}

      <ArtistShelf
        title={t("topArtistsThisMonth")}
        note={t("onlyVisibleToYou")}
        state={top}
        onShowAll={() => navigate({ name: "profile", section: "top" })}
      />
      {pls.list.length > 0 && (
        <Shelf
          title={t(pls.isPublic ? "publicPlaylists" : "playlists")}
          onShowAll={pls.list.length > 6 ? () => navigate({ name: "profile", section: "playlists" }) : undefined}
        >
          {pls.list.map((p) => {
            const it: MediaItem = { type: "playlist", ...p };
            return <Card key={p.id} item={it} onPlay={() => playItem(it)} onContext={(e) => cardMenu(e, it)} />;
          })}
        </Shelf>
      )}
      <ArtistShelf title={t("recentlyPlayedArtists")} state={recent} onShowAll={() => navigate({ name: "profile", section: "recent" })} />
    </div>
  );
}

function ArtistShelf({
  title,
  note,
  state,
  onShowAll,
}: {
  title: string;
  note?: string;
  state: ReturnType<typeof useHistoryArtists>;
  onShowAll: () => void;
}) {
  if (!state.data?.length) return state.loading ? <Loading /> : null;
  const items = asItems(state.data);
  return (
    <Shelf title={title} note={note} onShowAll={onShowAll}>
      {items.map((it) => (
        <Card key={it.id} item={it} onPlay={() => playItem(it)} onContext={(e) => cardMenu(e, it)} />
      ))}
    </Shelf>
  );
}

function ProfileSection({ section }: { section: Section }) {
  const t = useT();
  const pls = usePlaylists();
  const artists = useHistoryArtists(section === "top" ? "top" : "recent", 50);
  const title =
    section === "top" ? t("topArtistsThisMonth") : section === "recent" ? t("recentlyPlayedArtists") : t(pls.isPublic ? "publicPlaylists" : "playlists");
  usePageTitle(title);
  const items: MediaItem[] = section === "playlists" ? pls.list.map((p) => ({ type: "playlist" as const, ...p })) : asItems(artists.data ?? []);
  return (
    <div className="page">
      <h1>{title}</h1>
      {section === "top" && <p className="muted">{t("onlyVisibleToYou")}</p>}
      {section !== "playlists" && artists.loading && !artists.data ? (
        <Loading />
      ) : section !== "playlists" && artists.error ? (
        <ErrorBox message={artists.error} onRetry={artists.reload} />
      ) : items.length ? (
        <Grid items={items} />
      ) : (
        <p className="muted">{t("empty")}</p>
      )}
    </div>
  );
}

/** "Profile details": choose or remove the photo and set the name shown in the app. */
export function ProfileEditDialog() {
  const t = useT();
  const open = useUi((s) => s.profileEdit);
  const custom = useProfile((s) => s.custom);
  const info = useProfile((s) => s.info);
  const [photo, setPhoto] = useState<string | null>(null);
  const [name, setName] = useState("");
  useEffect(() => {
    if (!open) return;
    setPhoto(custom.photo ?? null);
    setName(custom.name?.trim() || info?.name || "");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!open) return null;
  const close = () => useUi.setState({ profileEdit: false });
  const shown = photo || info?.photo || null;
  const choose = async () => {
    try {
      const p = await pickPhoto();
      if (p) setPhoto(p);
    } catch (e) {
      toast(errorMessage(e));
    }
  };
  const save = async () => {
    try {
      const n = name.trim();
      await saveCustomProfile({ photo, name: n && n !== info?.name ? n : null });
      close();
    } catch (e) {
      toast(errorMessage(e));
    }
  };
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && close()} onKeyDown={(e) => e.key === "Escape" && close()}>
      <div className="dialog profile-edit" role="dialog" aria-modal="true" aria-labelledby="pe-title">
        <div className="row between">
          <h2 id="pe-title">{t("profileDetails")}</h2>
          <button className="icon-btn" aria-label={t("close")} onClick={close}>
            <I.IClose size={18} />
          </button>
        </div>
        <div className="pe-body">
          <div className="pe-photo">
            <button className="hero-art-btn round" onClick={choose} aria-label={t("choosePhoto")}>
              <Art src={shown} size={480} round className="pe-art" placeholder={<I.IUser size={64} />} />
              <span className="hero-art-edit">
                <span>
                  <I.IEdit size={32} />
                  <span className="hero-art-label">{t("choosePhoto")}</span>
                </span>
              </span>
            </button>
            {photo && (
              <button className="link small" onClick={() => setPhoto(null)}>
                {t("removePhoto")}
              </button>
            )}
          </div>
          <div className="pe-fields">
            <label className="field">
              <span>{t("displayName")}</span>
              <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} autoFocus />
            </label>
            <button className="pill primary" onClick={save}>
              {t("save")}
            </button>
          </div>
        </div>
        <p className="small muted">{t("profileAppOnly")}</p>
      </div>
    </div>
  );
}
