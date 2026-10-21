package academy.lumen.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log

/**
 * Keeps Lumen running (ADR-012): a quiet foreground notification while the app
 * is open, so Android doesn't take the server away when you switch apps, and
 * while a class or a curriculum build is still going. Swiping the app away stops
 * the server, unless there's work in progress: then it finishes first.
 */
class LumenService : Service() {
  companion object {
    private const val TAG = "LumenService"
    private const val CHANNEL = "lumen"
    private const val ID = 1

    fun start(ctx: Context) {
      val i = Intent(ctx, LumenService::class.java)
      runCatching { ctx.startForegroundService(i) }.onFailure { Log.w(TAG, "couldn't start: $it") }
    }
  }

  private val main = Handler(Looper.getMainLooper())
  private var taskGone = false
  private var shown: String? = null

  private val poll = object : Runnable {
    override fun run() {
      Thread {
        if (LumenRuntime.running) LumenRuntime.health()
        main.post {
          val busy = LumenRuntime.busy
          if (taskGone && busy == null) {
            Log.i(TAG, "the app is gone and nothing is running: stopping the server")
            LumenRuntime.stop()
            stopSelf()
            return@post
          }
          update(busy)
          main.postDelayed(this, if (taskGone) 5_000 else 15_000)
        }
      }.start()
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    val nm = getSystemService(NotificationManager::class.java)
    nm.createNotificationChannel(
      NotificationChannel(CHANNEL, "Lumen Academy running", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Shown while Lumen's school server runs on this phone."
        setShowBadge(false)
      },
    )
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val n = notification(LumenRuntime.busy)
    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(ID, n)
    }
    main.removeCallbacks(poll)
    main.postDelayed(poll, 5_000)
    return START_NOT_STICKY
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    taskGone = true
    if (LumenRuntime.busy == null) {
      LumenRuntime.stop()
      stopSelf()
    } else {
      update(LumenRuntime.busy)
      main.removeCallbacks(poll)
      main.postDelayed(poll, 5_000)
    }
  }

  override fun onDestroy() {
    main.removeCallbacks(poll)
    super.onDestroy()
  }

  private fun update(busy: String?) {
    if (busy == shown) return
    shown = busy
    getSystemService(NotificationManager::class.java).notify(ID, notification(busy))
  }

  private fun notification(busy: String?): Notification {
    val open = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE,
    )
    val text = when (busy) {
      "building" -> "Building your curriculum…"
      "class" -> "A class is in session."
      else -> "Lumen Academy is running."
    }
    return Notification.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.ic_stat_lumen)
      .setContentTitle("Lumen Academy")
      .setContentText(text)
      .setContentIntent(open)
      .setOngoing(true)
      .setCategory(Notification.CATEGORY_SERVICE)
      .build()
  }
}
