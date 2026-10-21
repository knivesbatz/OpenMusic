package app.openmusic.media

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
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

  @Command
  fun stop(invoke: Invoke) {
    MediaBridge.nowPlaying = null
    PlaybackService.instance?.stopPlayback()
    invoke.resolve()
  }

  // The activity pauses its WebView when it goes to the background, which can silence the
  // player. While music is playing, resume it again once the activity has finished pausing.
  override fun onPause() {
    if (MediaBridge.nowPlaying?.playing == true) {
      Handler(Looper.getMainLooper()).post { webView?.onResume() }
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
