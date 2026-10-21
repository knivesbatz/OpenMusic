import { Component, type ReactNode } from "react";
import { api, inTauri } from "../api";
import { translate } from "../i18n";
import { useSettings } from "../store/settings";

interface Props {
  children: ReactNode;
  /** Called by the "Close" button, e.g. to leave the fullscreen player. */
  onClose?: () => void;
  /** Changing this resets the boundary (e.g. the current route). */
  resetKey?: unknown;
}

/**
 * Keeps a rendering error in one view from blanking the whole app (which looks like a crash).
 * Shows the message so it can be reported, and lets the user go back.
 */
export class ErrorBoundary extends Component<Props, { error: Error | null; key: unknown }> {
  state = { error: null as Error | null, key: this.props.resetKey };

  static getDerivedStateFromProps(p: Props, s: { error: Error | null; key: unknown }) {
    return p.resetKey !== s.key ? { error: null, key: p.resetKey } : null;
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error("UI error", error, info.componentStack);
    if (inTauri) api.logUiError(`render error: ${error.message}\n${error.stack ?? ""}\n${info.componentStack ?? ""}`.slice(0, 4000)).catch(() => {});
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const lang = useSettings.getState().language;
    return (
      <div className="center error-view" role="alert">
        <h2>{translate(lang, "errorGeneric")}</h2>
        <code className="muted small">{error.message}</code>
        <div className="row gap">
          <button className="pill" onClick={() => this.setState({ error: null })}>
            {translate(lang, "retry")}
          </button>
          {this.props.onClose && (
            <button className="pill ghost" onClick={this.props.onClose}>
              {translate(lang, "close")}
            </button>
          )}
        </div>
      </div>
    );
  }
}
