package app.openmusic.media

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.os.Bundle
import android.view.View
import android.widget.RemoteViews
import app.tauri.Logger
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import kotlin.math.ceil

/**
 * Home screen widgets, Spotify style: the song playing now (cover, title, artist, previous / play /
 * next), and recently played (what you played last, plus a row of recent albums and playlists).
 * The card takes a muted colour from the cover. State is kept in shared preferences so widgets
 * still show the last song after the app is closed; tapping them then opens the app.
 */
object Widgets {
  private const val PREFS = "openmusic_widgets"
  const val ACTION_BUTTON = "app.openmusic.media.WIDGET_BUTTON"
  const val EXTRA_BUTTON = "button"
  /** Extras on the launch intent: an action for the player ("play"), or a page to open. */
  const val EXTRA_ACTION = "om_action"
  const val EXTRA_KIND = "om_kind"
  const val EXTRA_ID = "om_id"
  private const val DEFAULT_TINT = 0xFF2A2A2A.toInt()
  private val ITEMS = intArrayOf(R.id.om_item1, R.id.om_item2, R.id.om_item3, R.id.om_item4, R.id.om_item5)

  private val worker = Executors.newSingleThreadExecutor()
  private val bitmaps = object : LinkedHashMap<String, Bitmap>(16, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Bitmap>?) = size > 12
  }

  private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  // ---- state ----------------------------------------------------------------------------------

  /** The player changed (from the playback service): remember it and redraw. */
  fun nowPlayingChanged(c: Context, np: NowPlayingArgs?) {
    val app = c.applicationContext
    if (np != null && np.title.isNotEmpty()) {
      prefs(app).edit()
        .putString("np_title", np.title)
        .putString("np_artist", np.artist)
        .putString("np_art", np.artwork)
        .putBoolean("np_playing", np.playing)
        .apply()
    }
    refreshNowPlaying(app)
  }

  fun playingStopped(c: Context) {
    val app = c.applicationContext
    prefs(app).edit().putBoolean("np_playing", false).apply()
    refreshNowPlaying(app)
  }

  /** Recently played albums and playlists (from the app): `[{kind, id, title, art}]`, newest first. */
  fun recentChanged(c: Context, json: String) {
    val app = c.applicationContext
    prefs(app).edit().putString("recent", json).apply()
    refreshRecent(app)
  }

  /** The page came or went: buttons switch between controlling it and opening the app. */
  fun refreshAll(c: Context) {
    refreshNowPlaying(c.applicationContext)
    refreshRecent(c.applicationContext)
  }

  // ---- drawing --------------------------------------------------------------------------------

  fun refreshNowPlaying(c: Context) = worker.execute {
    try {
      val mgr = AppWidgetManager.getInstance(c)
      for (id in mgr.getAppWidgetIds(ComponentName(c, NowPlayingWidget::class.java))) {
        mgr.updateAppWidget(id, nowPlayingViews(c, mgr.getAppWidgetOptions(id)))
      }
    } catch (e: Exception) {
      Logger.error("openmusic-media: now playing widget: ${e.message}")
    }
  }

  fun refreshRecent(c: Context) = worker.execute {
    try {
      val mgr = AppWidgetManager.getInstance(c)
      for (id in mgr.getAppWidgetIds(ComponentName(c, RecentWidget::class.java))) {
        mgr.updateAppWidget(id, recentViews(c, mgr.getAppWidgetOptions(id)))
      }
    } catch (e: Exception) {
      Logger.error("openmusic-media: recent widget: ${e.message}")
    }
  }

  private fun nowPlayingViews(c: Context, opts: Bundle): RemoteViews {
    val p = prefs(c)
    val title = p.getString("np_title", null)
    val alive = MediaBridge.webView != null
    val playing = alive && p.getBoolean("np_playing", false)
    val dp = c.resources.displayMetrics.density
    val v = RemoteViews(c.packageName, R.layout.om_widget_now_playing)

    val art = cover(p.getString("np_art", null), (56 * dp).toInt(), 6 * dp)
    if (art != null) v.setImageViewBitmap(R.id.om_art, art) else v.setImageViewResource(R.id.om_art, R.drawable.om_widget_placeholder)
    v.setInt(R.id.om_bg, "setColorFilter", tint(art))
    v.setTextViewText(R.id.om_title, title ?: c.getString(R.string.om_widget_nothing))
    v.setTextViewText(R.id.om_artist, if (title != null) p.getString("np_artist", "") else c.getString(R.string.om_widget_open))
    v.setImageViewResource(R.id.om_play, if (playing) R.drawable.om_ic_pause_circle else R.drawable.om_ic_play_circle)
    v.setContentDescription(R.id.om_play, c.getString(if (playing) R.string.om_pause else R.string.om_play))
    v.setImageViewResource(R.id.om_logo, c.applicationInfo.icon)

    // Narrow widgets drop the app icon, then the previous button.
    val width = size(opts, AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 300)
    v.setViewVisibility(R.id.om_logo, if (width >= 280) View.VISIBLE else View.GONE)
    v.setViewVisibility(R.id.om_prev, if (width >= 220) View.VISIBLE else View.GONE)

    v.setOnClickPendingIntent(R.id.om_info, openApp(c, 100, null, null, null))
    v.setOnClickPendingIntent(R.id.om_prev, button(c, 101, "previous", alive))
    v.setOnClickPendingIntent(R.id.om_play, button(c, 102, "toggle", alive))
    v.setOnClickPendingIntent(R.id.om_next, button(c, 103, "next", alive))
    return v
  }

  private fun recentViews(c: Context, opts: Bundle): RemoteViews {
    val items = try {
      JSONArray(prefs(c).getString("recent", "[]"))
    } catch (e: Exception) {
      JSONArray()
    }
    val dp = c.resources.displayMetrics.density
    val v = RemoteViews(c.packageName, R.layout.om_widget_recent)
    v.setImageViewResource(R.id.om_logo, c.applicationInfo.icon)

    val head = items.optJSONObject(0)
    val headArt = head?.let { cover(it.optString("art"), (64 * dp).toInt(), 6 * dp) }
    v.setInt(R.id.om_bg, "setColorFilter", tint(headArt))
    if (head != null) {
      if (headArt != null) v.setImageViewBitmap(R.id.om_head_art, headArt) else v.setImageViewResource(R.id.om_head_art, R.drawable.om_widget_placeholder)
      v.setTextViewText(R.id.om_head_title, head.optString("title"))
      v.setTextViewText(R.id.om_head_sub, kindLabel(c, head.optString("kind")))
      v.setOnClickPendingIntent(R.id.om_head, openApp(c, 200, null, head.optString("kind"), head.optString("id")))
    } else {
      v.setOnClickPendingIntent(R.id.om_head, openApp(c, 200, null, null, null))
    }

    // As many covers as fit: the row is as tall as one cover, so a short widget shows fewer,
    // and a very short one only the header.
    val width = size(opts, AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 300)
    val height = size(opts, AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 180)
    val rowHeight = height - 24 - 64 - 12
    val shown = if (rowHeight < 36) 0 else ceil((width - 24 + 8) / (rowHeight + 8.0)).toInt().coerceIn(3, 5)
    v.setViewVisibility(R.id.om_row, if (shown == 0) View.GONE else View.VISIBLE)
    val px = (((width - 24) / shown.coerceAtLeast(1)) * dp).toInt().coerceIn(64, 360)
    for ((i, view) in ITEMS.withIndex()) {
      val item = items.optJSONObject(i + 1)
      when {
        i >= shown -> v.setViewVisibility(view, View.GONE)
        item == null -> v.setViewVisibility(view, View.INVISIBLE)
        else -> {
          v.setViewVisibility(view, View.VISIBLE)
          val art = cover(item.optString("art"), px, 6 * dp)
          if (art != null) v.setImageViewBitmap(view, art) else v.setImageViewResource(view, R.drawable.om_widget_placeholder)
          v.setContentDescription(view, item.optString("title"))
          v.setOnClickPendingIntent(view, openApp(c, 201 + i, null, item.optString("kind"), item.optString("id")))
        }
      }
    }
    return v
  }

  /** A widget size in dp; 0 until the launcher has laid the widget out. */
  private fun size(opts: Bundle, key: String, fallback: Int) = opts.getInt(key, 0).takeIf { it > 0 } ?: fallback

  private fun kindLabel(c: Context, kind: String) = c.getString(
    when (kind) {
      "playlist" -> R.string.om_kind_playlist
      "album" -> R.string.om_kind_album
      "artist" -> R.string.om_kind_artist
      else -> R.string.om_kind_other
    }
  )

  // ---- intents --------------------------------------------------------------------------------

  /** Opens the app (bringing it back if it's running), optionally with a player action or a page. */
  fun openApp(c: Context, code: Int, action: String?, kind: String?, id: String?): PendingIntent? {
    val launch = launchIntent(c, action, kind, id) ?: return null
    return PendingIntent.getActivity(c, code, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  fun launchIntent(c: Context, action: String?, kind: String?, id: String?): Intent? {
    val launch = c.packageManager.getLaunchIntentForPackage(c.packageName) ?: return null
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    if (action != null) launch.putExtra(EXTRA_ACTION, action)
    if (!kind.isNullOrEmpty() && !id.isNullOrEmpty()) {
      launch.putExtra(EXTRA_KIND, kind)
      launch.putExtra(EXTRA_ID, id)
    }
    return launch
  }

  /** While the app runs, a button controls the player; otherwise it opens the app and plays. */
  private fun button(c: Context, code: Int, name: String, alive: Boolean): PendingIntent? {
    if (!alive) return openApp(c, code, "play", null, null)
    val intent = Intent(c, NowPlayingWidget::class.java).setAction(ACTION_BUTTON).putExtra(EXTRA_BUTTON, name)
    return PendingIntent.getBroadcast(c, code, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  /** The launch extras as JSON for the page (`{"action":…, "kind":…, "id":…}`), or null. */
  fun launchJson(intent: Intent?): String? {
    intent ?: return null
    val action = intent.getStringExtra(EXTRA_ACTION)
    val kind = intent.getStringExtra(EXTRA_KIND)
    val id = intent.getStringExtra(EXTRA_ID)
    if (action == null && (kind == null || id == null)) return null
    intent.removeExtra(EXTRA_ACTION)
    intent.removeExtra(EXTRA_KIND)
    intent.removeExtra(EXTRA_ID)
    val o = JSONObject()
    if (action != null) o.put("action", action)
    if (kind != null && id != null) {
      o.put("kind", kind)
      o.put("id", id)
    }
    return o.toString()
  }

  // ---- images ---------------------------------------------------------------------------------

  /** A square, rounded cover `px` wide from an image file in the app's art cache. */
  private fun cover(path: String?, px: Int, radius: Float): Bitmap? {
    if (path.isNullOrEmpty() || path == "null" || px <= 0) return null
    val key = "$path@$px"
    synchronized(bitmaps) { bitmaps[key]?.let { return it } }
    val src = try {
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(path, bounds)
      if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
      var sample = 1
      while (minOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= px) sample *= 2
      BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample })
    } catch (e: Exception) {
      null
    } ?: return null
    val out = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
    val side = minOf(src.width, src.height).toFloat()
    val scale = px / side
    val matrix = Matrix().apply {
      setScale(scale, scale)
      postTranslate(-(src.width - side) / 2f * scale, -(src.height - side) / 2f * scale)
    }
    val shader = BitmapShader(src, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP).apply { setLocalMatrix(matrix) }
    val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG).apply { this.shader = shader }
    Canvas(out).drawRoundRect(RectF(0f, 0f, px.toFloat(), px.toFloat()), radius, radius, paint)
    if (src !== out) src.recycle()
    synchronized(bitmaps) { bitmaps[key] = out }
    return out
  }

  /** A muted card colour from the cover's average colour (white text stays readable on it). */
  private fun tint(art: Bitmap?): Int {
    art ?: return DEFAULT_TINT
    return try {
      val avg = Bitmap.createScaledBitmap(art, 1, 1, true).getPixel(0, 0)
      val hsv = FloatArray(3)
      Color.colorToHSV(avg, hsv)
      hsv[1] = minOf(hsv[1], 0.5f)
      hsv[2] = hsv[2].coerceIn(0.26f, 0.48f)
      Color.HSVToColor(hsv)
    } catch (e: Exception) {
      DEFAULT_TINT
    }
  }
}

class NowPlayingWidget : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) = Widgets.refreshNowPlaying(context)

  override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) =
    Widgets.refreshNowPlaying(context)

  override fun onReceive(context: Context, intent: Intent) {
    super.onReceive(context, intent)
    if (intent.action != Widgets.ACTION_BUTTON) return
    val button = intent.getStringExtra(Widgets.EXTRA_BUTTON) ?: return
    if (MediaBridge.webView != null) {
      MediaBridge.emit(button)
      return
    }
    // The app was closed since the widget was drawn: open it (and play), and redraw so the
    // buttons open the app from now on.
    Widgets.refreshNowPlaying(context)
    try {
      Widgets.launchIntent(context, "play", null, null)?.let { context.startActivity(it) }
    } catch (e: Exception) {
      Logger.error("openmusic-media: could not open the app from the widget: ${e.message}")
    }
  }
}

class RecentWidget : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) = Widgets.refreshRecent(context)

  override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) =
    Widgets.refreshRecent(context)
}
