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
import android.webkit.JavascriptInterface
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
import org.json.JSONObject

@InvokeArg
class ListenArgs {
  lateinit var channel: Channel
}

@InvokeArg
class NowPlayingArgs {
  /** Track id and a counter from the page: a late update never replaces a newer one. */
  var id: String = ""
  var seq: Long = 0
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
  @Volatile var webView: WebView? = null
  private val main = Handler(Looper.getMainLooper())

  /**
   * A button on the notification, lock screen, headset or car was pressed, or the audio output
   * went away. Delivered straight into the page: the route through the app's IPC didn't reach a
   * page running in the background, so the buttons did nothing until the app was opened.
   */
  fun emit(action: String, positionMs: Long? = null) {
    val data = JSObject()
    data.put("action", action)
    if (positionMs != null) data.put("positionMs", positionMs)
    val wv = webView
    if (wv == null) {
      sendToChannel(data)
      return
    }
    main.post {
      wakeUp(wv)
      wv.evaluateJavascript("window.__omMedia?(window.__omMedia($data),1):0") { done ->
        // The page hasn't set up its player yet: fall back to the IPC route.
        if (done != "1") sendToChannel(data)
      }
    }
  }

  /** Undo the activity's pause of the webview so the page runs while the app is in the background. */
  fun wakeUp(wv: WebView) {
    wv.onResume()
    wv.resumeTimers()
    // The page counts as visible again, so it isn't treated as a background tab.
    wv.dispatchWindowVisibilityChanged(View.VISIBLE)
  }

  private fun sendToChannel(data: JSObject) {
    try {
      channel?.send(data)
    } catch (e: Exception) {
      Logger.error("openmusic-media: could not deliver ${data.optString("action")}: ${e.message}")
    }
  }

  /** Show `args` (from the page, or from Rust with the artwork file), starting the service if needed. */
  fun apply(context: android.content.Context, args: NowPlayingArgs) {
    val cur = nowPlaying
    if (cur != null && args.seq < cur.seq) {
      // An older update arriving late: only take its artwork, if it's for the same track.
      if (args.id == cur.id && args.artwork != null && cur.artwork == null) {
        cur.artwork = args.artwork
        PlaybackService.instance?.refresh()
      }
      return
    }
    if (args.artwork == null && cur != null && cur.id == args.id) args.artwork = cur.artwork
    nowPlaying = args
    val running = PlaybackService.instance
    if (running != null) {
      running.refresh()
    } else if (args.playing) {
      // Started while the user is pressing play in the app, so the foreground start is allowed.
      try {
        ContextCompat.startForegroundService(context, Intent(context, PlaybackService::class.java))
      } catch (e: Exception) {
        Logger.error("openmusic-media: could not start the playback service: ${e.message}")
      }
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
    MediaBridge.webView = webView
    // `window.OpenMusicMedia.update(json)`: the page reports the playing song directly, so the
    // notification follows song changes while the app is in the background.
    webView.addJavascriptInterface(PageBridge(), "OpenMusicMedia")
  }

  inner class PageBridge {
    @JavascriptInterface
    fun update(json: String) {
      val args = try {
        val o = JSONObject(json)
        NowPlayingArgs().apply {
          id = o.optString("id")
          seq = o.optLong("seq")
          title = o.optString("title")
          artist = o.optString("artist")
          album = o.optString("album").takeIf { o.has("album") && !o.isNull("album") }
          playing = o.optBoolean("playing")
          positionMs = o.optLong("positionMs")
          durationMs = o.optLong("durationMs")
        }
      } catch (e: Exception) {
        return
      }
      activity.runOnUiThread { askForNotifications() }
      MediaBridge.apply(activity, args)
    }
  }

  @Command
  fun listen(invoke: Invoke) {
    MediaBridge.channel = invoke.parseArgs(ListenArgs::class.java).channel
    invoke.resolve()
  }

  @Command
  fun update(invoke: Invoke) {
    val args = invoke.parseArgs(NowPlayingArgs::class.java)
    askForNotifications()
    MediaBridge.apply(activity, args)
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
      MediaBridge.wakeUp(wv)
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
