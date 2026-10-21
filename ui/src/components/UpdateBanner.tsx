import { useT } from "../i18n";
import { isMobileApp } from "../store/app";
import { downloadUpdate, restartToUpdate, useUpdate } from "../store/update";

/** A small card above the player when a new version is available or ready to install. */
export function UpdateBanner() {
  const t = useT();
  const { status, version, dismissed } = useUpdate();
  if (dismissed || !(status === "available" || status === "ready" || status === "downloading") || !version) return null;
  const close = () => useUpdate.setState({ dismissed: true });
  return (
    <div className="update-banner" role="status">
      <div>
        <strong>{t(status === "ready" ? "updateReady" : "updateAvailable", { v: version })}</strong>
        <div className="muted small">{status === "ready" ? t("updateReadyHint") : status === "downloading" ? t("updateDownloading") : t("updateAvailableHint")}</div>
      </div>
      <div className="row gap">
        <button className="pill ghost small" onClick={close}>
          {t("later")}
        </button>
        {status === "ready" && (
          <button className="pill primary small" onClick={restartToUpdate}>
            {t("restartToUpdate")}
          </button>
        )}
        {status === "available" && (
          <button className="pill primary small" onClick={downloadUpdate}>
            {isMobileApp() ? t("downloadUpdate") : t("updateNow")}
          </button>
        )}
      </div>
    </div>
  );
}
