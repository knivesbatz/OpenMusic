// Lyrics in the right-hand panel (desktop): opened by the Lyrics button, with a button to
// expand them into the fullscreen player.
import { useT } from "../i18n";
import { usePlayer } from "../player/engine";
import { useDisplayTrack } from "../store/songmeta";
import { useUi } from "../store/ui";
import { LyricsView } from "./Fullscreen";
import { TitleText } from "./common";
import * as I from "./Icons";

export function LyricsPanel() {
  const t = useT();
  const item = usePlayer((s) => s.queue.items[s.queue.index]);
  const tr = useDisplayTrack(item?.track);
  return (
    <aside className="queue-panel lyrics-panel" aria-label={t("lyrics")}>
      <div className="panel-head">
        <h2>{t("lyrics")}</h2>
        <div className="row gap">
        <button className="icon-btn" aria-label={t("fullscreen")} title={t("fullscreen")} onClick={() => useUi.setState({ fullscreen: true, lyricsOpen: true })}>
          <I.IFullscreen size={16} />
        </button>
        <button className="icon-btn" aria-label={t("close")} title={t("close")} onClick={() => useUi.setState({ lyricsPanel: false })}>
          <I.IClose size={16} />
        </button>
        </div>
      </div>
      {tr ? (
        <>
          <div className="lp-track muted small">
            <TitleText text={tr.title} /> · {tr.artist}
          </div>
          <div className="lp-body">
            <LyricsView track={tr} />
          </div>
        </>
      ) : (
        <p className="muted pad">{t("nothingPlaying")}</p>
      )}
    </aside>
  );
}
