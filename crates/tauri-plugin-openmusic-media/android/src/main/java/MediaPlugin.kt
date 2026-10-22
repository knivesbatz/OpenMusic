package app.openmusic.media

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.Logger
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class ListenArgs {
  lateinit var channel: Channel
}

@InvokeArg
class NowPlayingArgs {
  var title: String = ""
  var artist: String = ""
  var album: String? = null
  var artwork: String? = null
  var playing: Boolean = false
  var positionMs: Long = 0
  var durationMs: Long = 0
}

@InvokeArg
class CookiesArgs {
  var url: String = ""
}

/** Shared between the plugin (webview side) and the playback service (notification side). */
object MediaBridge {
  @Volatile var channel: Channel? = null
  @Volatile var nowPlaying: NowPlayingArgs? = null

  /** A button on the notification, lock screen, headset or car was pressed. */
  fun emit(action: String, positionMs: Long? = null) {
    val data = JSObject()
    data.put("action", action)
    if (positionMs != null) data.put("positionMs", positionMs)
    try {
      channel?.send(data)
    } catch (e: Exception) {
      Logger.error("openmusic-media: could not deliver $action: ${e.message}")
    }
  }
}

@TauriPlugin
class MediaPlugin(private val activity: Activity) : Plugin(activity) {
  private var webView: WebView? = null
  private var askedForNotifications = false

  override fun load(webView: WebView) {
    this.webView = webView
    // wry asks for a user gesture before media plays; the player starts the next song and the
    // crossfade's second player on its own, so allow it.
    webView.settings.mediaPlaybackRequiresUserGesture = false
  }

  @Command
  fun listen(invoke: Invoke) {
    MediaBridge.channel = invoke.parseArgs(ListenArgs::class.java).channel
    invoke.resolve()
  }

  @Command
  fun update(invoke: Invoke) {
    val args = invoke.parseArgs(NowPlayingArgs::class.java)
    MediaBridge.nowPlaying = args
    askForNotifications()
    val running = PlaybackService.instance
    if (running != null) {
      running.refresh()
    } else if (args.playing) {
      // Started while the user is pressing play in the app, so the foreground start is allowed.
      try {
        ContextCompat.startForegroundService(activity, Intent(activity, PlaybackService::class.java))
      } catch (e: Exception) {
        Logger.error("openmusic-media: could not start the playback service: ${e.message}")
      }
    }
    invoke.resolve()
  }

  /**
   * The webview's cookies for a URL ("name=value; …"), for adopting a sign-in. wry's own
   * cookies_for_url panics on the UI thread when its caller has already timed out, which crashed
   * the app while YouTube Music was loading after sign-in; this answers whenever it can.
   */
  @Command
  fun cookies(invoke: Invoke) {
    val url = invoke.parseArgs(CookiesArgs::class.java).url
    val ret = JSObject()
    ret.put("cookies", try { CookieManager.getInstance().getCookie(url) ?: "" } catch (e: Exception) { "" })
    invoke.resolve(ret)
  }

  @Command
  fun stop(invoke: Invoke) {
    MediaBridge.nowPlaying = null
    PlaybackService.instance?.stopPlayback()
    invoke.resolve()
  }

  // Leaving the app pauses the activity's WebView (wry calls WebView.onPause()) and hides the
  // page, which pauses the song: the <audio> element stops, and YouTube's mobile player pauses a
  // hidden page. While music is playing, undo all of that once the activity has finished pausing
  // or stopping, and tell the player so it resumes a song that was paused on the way out.
  override fun onPause() = keepPlaying()

  override fun onStop() = keepPlaying()

  private fun keepPlaying() {
    if (MediaBridge.nowPlaying?.playing != true) return
    val wv = webView ?: return
    Handler(Looper.getMainLooper()).post {
      wv.onResume()
      wv.resumeTimers()
      // The page counts as visible again, so it isn't treated as a background tab.
      wv.dispatchWindowVisibilityChanged(View.VISIBLE)
      wv.evaluateJavascript("window.__omBackground&&window.__omBackground()", null)
    }
  }

  private fun askForNotifications() {
    if (askedForNotifications || Build.VERSION.SDK_INT < 33) return
    askedForNotifications = true
    val perm = Manifest.permission.POST_NOTIFICATIONS
    if (ContextCompat.checkSelfPermission(activity, perm) != PackageManager.PERMISSION_GRANTED) {
      ActivityCompat.requestPermissions(activity, arrayOf(perm), 7301)
    }
  }
}
