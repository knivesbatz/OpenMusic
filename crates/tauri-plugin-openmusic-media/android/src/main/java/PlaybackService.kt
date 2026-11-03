package app.openmusic.media

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.view.KeyEvent
import androidx.core.content.ContextCompat
import java.util.concurrent.Executors

/**
 * Foreground service that keeps the app alive while music plays and shows the media
 * notification (also used by the lock screen, headsets, Bluetooth and Android Auto controls).
 * The webview stays the player; this only mirrors its state and forwards button presses.
 */
class PlaybackService : Service() {
  companion object {
    @Volatile var instance: PlaybackService? = null
    private const val CHANNEL_ID = "playback"
    private const val NOTIFICATION_ID = 7300
    private const val ACTION = "app.openmusic.media.ACTION"
    /** A press at least this long is a hold, even when the headset sends no key repeats. */
    private const val HOLD_MS = 600L
    /** How long to wait for another press before acting on one, two or three presses. */
    private const val TAPS_MS = 400L
  }

  private lateinit var session: MediaSession
  private val main = Handler(Looper.getMainLooper())
  private val loader = Executors.newSingleThreadExecutor()
  private var artUrl: String? = null
  private var art: Bitmap? = null

  /** Headphones unplugged or a Bluetooth speaker/headset disconnected: pause, like other players. */
  private val noisy = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      if (intent.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY && MediaBridge.nowPlaying?.playing == true) {
        MediaBridge.emit("pause")
      }
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
    session = MediaSession(this, "OpenMusic")
    session.setCallback(object : MediaSession.Callback() {
      override fun onPlay() = MediaBridge.emit("play")
      override fun onPause() = MediaBridge.emit("pause")
      override fun onSkipToNext() = MediaBridge.emit("next")
      override fun onSkipToPrevious() = MediaBridge.emit("previous")
      override fun onStop() = MediaBridge.emit("pause")
      override fun onSeekTo(pos: Long) = MediaBridge.emit("seek", pos)
      override fun onFastForward() = MediaBridge.emit("next")
      override fun onRewind() = MediaBridge.emit("previous")
      override fun onMediaButtonEvent(intent: Intent): Boolean {
        val key = if (Build.VERSION.SDK_INT >= 33) {
          intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java)
        } else {
          @Suppress("DEPRECATION") intent.getParcelableExtra<KeyEvent>(Intent.EXTRA_KEY_EVENT)
        }
        return (key != null && onButton(key)) || super.onMediaButtonEvent(intent)
      }
    })
    session.isActive = true
    ContextCompat.registerReceiver(this, noisy, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), ContextCompat.RECEIVER_EXPORTED)
    if (Build.VERSION.SDK_INT >= 26) {
      val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      nm.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Playback", NotificationManager.IMPORTANCE_LOW))
    }
  }

  private var presses = 0
  private var held = false
  private val actOnPresses = Runnable {
    when (presses) {
      1 -> MediaBridge.emit("toggle")
      2 -> MediaBridge.emit("next")
      0 -> {}
      else -> MediaBridge.emit("previous")
    }
    presses = 0
  }

  /**
   * Headset, earbud and Bluetooth buttons. Android's default treats holding play/pause as one
   * press and ignores fast-forward and rewind (what many earbuds send while a button is held),
   * so holding the button to skip did nothing. Here one press plays or pauses, two skip, three
   * go back, and holding skips. Next, previous, fast-forward and rewind act once per press,
   * however long the button is held.
   */
  private fun onButton(key: KeyEvent): Boolean {
    when (key.keyCode) {
      KeyEvent.KEYCODE_HEADSETHOOK, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> {
        if (key.action == KeyEvent.ACTION_DOWN) {
          if (key.repeatCount == 0) {
            main.removeCallbacks(actOnPresses)
            presses++
            held = false
          } else if (!held) {
            holdToSkip()
          }
        } else if (key.action == KeyEvent.ACTION_UP) {
          if (!held && key.eventTime - key.downTime >= HOLD_MS) holdToSkip()
          if (held) held = false else main.postDelayed(actOnPresses, TAPS_MS)
        }
        return true
      }
      KeyEvent.KEYCODE_MEDIA_NEXT, KeyEvent.KEYCODE_MEDIA_FAST_FORWARD,
      KeyEvent.KEYCODE_MEDIA_SKIP_FORWARD, KeyEvent.KEYCODE_MEDIA_STEP_FORWARD -> return once(key, "next")
      KeyEvent.KEYCODE_MEDIA_PREVIOUS, KeyEvent.KEYCODE_MEDIA_REWIND,
      KeyEvent.KEYCODE_MEDIA_SKIP_BACKWARD, KeyEvent.KEYCODE_MEDIA_STEP_BACKWARD -> return once(key, "previous")
      else -> return false
    }
  }

  private fun holdToSkip() {
    held = true
    presses = 0
    main.removeCallbacks(actOnPresses)
    MediaBridge.emit("next")
  }

  /** Acts on the first key-down only, so a held button skips one song, not one per repeat. */
  private fun once(key: KeyEvent, action: String): Boolean {
    if (key.action == KeyEvent.ACTION_DOWN && key.repeatCount == 0) {
      main.removeCallbacks(actOnPresses)
      if (presses > 0) actOnPresses.run()
      MediaBridge.emit(action)
    }
    return true
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    intent?.getStringExtra(ACTION)?.let { MediaBridge.emit(it) }
    // A foreground start must call startForeground promptly, even before the first update.
    showNotification()
    return START_NOT_STICKY
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // Swiping the app away ends playback, like most music apps.
    stopPlayback()
  }

  override fun onDestroy() {
    instance = null
    try {
      unregisterReceiver(noisy)
    } catch (e: Exception) {
    }
    main.removeCallbacks(actOnPresses)
    session.release()
    loader.shutdownNow()
    super.onDestroy()
  }

  /** Called on the main thread by the plugin after every player update. */
  fun refresh() = main.post { showNotification() }

  fun stopPlayback() = main.post {
    Widgets.playingStopped(this)
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  private fun showNotification() {
    val np = MediaBridge.nowPlaying ?: NowPlayingArgs()
    loadArt(np.artwork)
    val meta = MediaMetadata.Builder()
      .putString(MediaMetadata.METADATA_KEY_TITLE, np.title)
      .putString(MediaMetadata.METADATA_KEY_ARTIST, np.artist)
      .putString(MediaMetadata.METADATA_KEY_ALBUM, np.album ?: "")
      .putLong(MediaMetadata.METADATA_KEY_DURATION, np.durationMs)
    art?.let { meta.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, it) }
    session.setMetadata(meta.build())
    session.setPlaybackState(
      PlaybackState.Builder()
        .setActions(
          PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or
            PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS or PlaybackState.ACTION_SEEK_TO
        )
        .setState(if (np.playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED, np.positionMs, if (np.playing) 1f else 0f)
        .build()
    )

    val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL_ID) else @Suppress("DEPRECATION") Notification.Builder(this)
    builder
      .setSmallIcon(android.R.drawable.ic_media_play)
      .setContentTitle(np.title)
      .setContentText(np.artist)
      .setLargeIcon(art)
      .setOngoing(np.playing)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .setContentIntent(openApp())
      .addAction(action(android.R.drawable.ic_media_previous, "Previous", "previous"))
      .addAction(
        if (np.playing) action(android.R.drawable.ic_media_pause, "Pause", "pause")
        else action(android.R.drawable.ic_media_play, "Play", "play")
      )
      .addAction(action(android.R.drawable.ic_media_next, "Next", "next"))
      .setStyle(Notification.MediaStyle().setMediaSession(session.sessionToken).setShowActionsInCompactView(0, 1, 2))
    val notification = builder.build()
    Widgets.nowPlayingChanged(this, MediaBridge.nowPlaying)
    if (Build.VERSION.SDK_INT >= 29) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun action(icon: Int, title: String, name: String): Notification.Action {
    val intent = Intent(this, PlaybackService::class.java).putExtra(ACTION, name)
    val pending = PendingIntent.getService(this, name.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    @Suppress("DEPRECATION")
    return Notification.Action.Builder(icon, title, pending).build()
  }

  private fun openApp(): PendingIntent? {
    val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return null
    launch.flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
    return PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  /** Artwork is a file in the app's art cache; decode it off the main thread, then redraw. */
  private fun loadArt(path: String?) {
    if (path == artUrl) return
    artUrl = path
    art = null
    if (path.isNullOrEmpty()) return
    loader.execute {
      val bitmap = try {
        BitmapFactory.decodeFile(path)
      } catch (e: Exception) {
        null
      }
      main.post {
        if (artUrl == path && bitmap != null) {
          art = bitmap
          showNotification()
        }
      }
    }
  }
}
