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
    })
    session.isActive = true
    ContextCompat.registerReceiver(this, noisy, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), ContextCompat.RECEIVER_EXPORTED)
    if (Build.VERSION.SDK_INT >= 26) {
      val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      nm.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Playback", NotificationManager.IMPORTANCE_LOW))
    }
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
    session.release()
    loader.shutdownNow()
    super.onDestroy()
  }

  /** Called on the main thread by the plugin after every player update. */
  fun refresh() = main.post { showNotification() }

  fun stopPlayback() = main.post {
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
