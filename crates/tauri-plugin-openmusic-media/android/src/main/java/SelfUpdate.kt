package app.openmusic.media

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.widget.Toast
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Updates from the project's GitHub releases, installed by the app itself (no browser, no files
 * app). Android asks once to allow "Install unknown apps" for this app. On Android 12 and later,
 * an app updating itself is then installed without a prompt; older versions show Android's
 * one-tap "Update" screen. The new APK must be signed with the same key as the installed one.
 */
object SelfUpdate {
  private const val PREFIX = "https://github.com/knivesbatz/OpenMusic/releases/download/"
  const val ACTION_STATUS = "app.openmusic.media.UPDATE_STATUS"
  private const val CHANNEL_ID = "updates"

  @Volatile
  var busy = false

  /**
   * Download and install `url`. Returns false (and opens the settings page) when "Install unknown
   * apps" still has to be allowed for this app, or when the address isn't one of this project's
   * release files.
   */
  fun start(activity: Activity, url: String): Boolean {
    if (!url.startsWith(PREFIX) || !url.endsWith(".apk")) return false
    if (Build.VERSION.SDK_INT >= 26 && !activity.packageManager.canRequestPackageInstalls()) {
      activity.runOnUiThread {
        toast(activity, "Allow \"Install unknown apps\" for this app so it can install its updates, then go back.")
        try {
          activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.packageName)))
        } catch (_: Exception) {
        }
      }
      return false
    }
    if (busy) return true
    busy = true
    val ctx = activity.applicationContext
    Thread {
      try {
        install(ctx, download(ctx, url))
      } catch (e: Exception) {
        busy = false
        toast(ctx, "The update couldn't be installed: ${e.message ?: e.javaClass.simpleName}")
      }
    }.start()
    return true
  }

  private fun download(ctx: Context, url: String): File {
    val dir = File(ctx.cacheDir, "updates").apply { mkdirs() }
    dir.listFiles()?.forEach { it.delete() }
    val out = File(dir, "update.apk")
    val conn = URL(url).openConnection() as HttpURLConnection
    conn.instanceFollowRedirects = true
    conn.connectTimeout = 20_000
    conn.readTimeout = 60_000
    try {
      if (conn.responseCode !in 200..299) error("download failed (HTTP ${conn.responseCode})")
      conn.inputStream.use { input -> out.outputStream().use { input.copyTo(it) } }
    } finally {
      conn.disconnect()
    }
    // An APK is a zip file ("PK…"), not an error page.
    val head = ByteArray(2)
    out.inputStream().use { it.read(head) }
    if (out.length() < 1_000_000 || head[0] != 'P'.code.toByte() || head[1] != 'K'.code.toByte()) error("the download isn't an app")
    return out
  }

  private fun install(ctx: Context, apk: File) {
    val installer = ctx.packageManager.packageInstaller
    val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
    params.setAppPackageName(ctx.packageName)
    params.setSize(apk.length())
    if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
    val id = installer.createSession(params)
    installer.openSession(id).use { session ->
      session.openWrite("base.apk", 0, apk.length()).use { out ->
        apk.inputStream().use { it.copyTo(out) }
        session.fsync(out)
      }
      val intent = Intent(ctx, UpdateStatusReceiver::class.java).setAction(ACTION_STATUS)
      // Mutable: the installer adds the status and, when it needs one, the confirmation screen.
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
      session.commit(PendingIntent.getBroadcast(ctx, id, intent, flags).intentSender)
    }
  }

  fun toast(ctx: Context, text: String) {
    Handler(Looper.getMainLooper()).post { Toast.makeText(ctx, text, Toast.LENGTH_LONG).show() }
  }

  /** After an update: a notification to open the app again (Android doesn't reopen it). */
  fun notifyUpdated(ctx: Context) {
    val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Updates", NotificationManager.IMPORTANCE_DEFAULT))
    val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: return
    val open = PendingIntent.getActivity(ctx, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val version = try {
      ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: ""
    } catch (_: Exception) {
      ""
    }
    val label = ctx.applicationInfo.loadLabel(ctx.packageManager).toString()
    val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(ctx, CHANNEL_ID) else @Suppress("DEPRECATION") Notification.Builder(ctx)
    val n = builder
      .setSmallIcon(R.drawable.om_ic_note)
      .setContentTitle("$label updated to $version")
      .setContentText("Tap to open $label.")
      .setContentIntent(open)
      .setAutoCancel(true)
      .build()
    try {
      nm.notify(7301, n)
    } catch (_: SecurityException) {
      // Notifications not allowed: the update is installed anyway.
    }
  }
}

/** Results of an install started by [SelfUpdate]. */
class UpdateStatusReceiver : BroadcastReceiver() {
  override fun onReceive(ctx: Context, intent: Intent) {
    if (intent.action != SelfUpdate.ACTION_STATUS) return
    when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
      PackageInstaller.STATUS_PENDING_USER_ACTION -> {
        // Android wants a tap this time (Android 11 and older, or the first update the app
        // installs itself): show its "Update" screen.
        val confirm = if (Build.VERSION.SDK_INT >= 33) {
          intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
        } else {
          @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_INTENT)
        }
        if (confirm != null) {
          confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          try {
            ctx.startActivity(confirm)
          } catch (_: Exception) {
            SelfUpdate.busy = false
          }
        }
      }
      PackageInstaller.STATUS_SUCCESS -> SelfUpdate.busy = false
      else -> {
        SelfUpdate.busy = false
        val why = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: ""
        val signedDifferently = status == PackageInstaller.STATUS_FAILURE_CONFLICT ||
          status == PackageInstaller.STATUS_FAILURE_INCOMPATIBLE ||
          why.contains("signature", ignoreCase = true)
        SelfUpdate.toast(
          ctx,
          if (signedDifferently) {
            "This update is signed differently from the installed app. Uninstall the app once and install the new version; after that, updates install by themselves."
          } else if (status == PackageInstaller.STATUS_FAILURE_ABORTED) {
            "Update cancelled."
          } else {
            "The update couldn't be installed. $why".trim()
          },
        )
      }
    }
  }
}

/** The app was replaced by a newer version: offer to open it again. */
class PackageReplacedReceiver : BroadcastReceiver() {
  override fun onReceive(ctx: Context, intent: Intent) {
    if (intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) SelfUpdate.notifyUpdated(ctx)
  }
}
