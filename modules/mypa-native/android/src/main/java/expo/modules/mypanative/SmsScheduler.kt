package expo.modules.mypanative

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import android.os.Build
import android.telephony.SmsManager
import org.json.JSONArray
import org.json.JSONObject
import java.util.Calendar

data class SmsJob(
  val id: String,
  val number: String,
  val message: String,
  val at: Long,
  val repeat: String,
  val subId: Int = -1, // -1 = the phone's default SMS SIM
  val kind: String = "sms", // "sms" or "call"
)

/**
 * Schedules SMS with AlarmManager. Jobs are persisted in SharedPreferences so the alarm can fire
 * (and be restored after a reboot) without the React Native app running.
 */
object SmsScheduler {
  private const val PREFS = "mypa_sms"
  private const val KEY_JOBS = "jobs"
  private const val KEY_RESULTS = "results"
  private const val CHANNEL = "mypa_sms_status"
  private const val GRACE_MS = 10 * 60 * 1000L
  const val ACTION = "expo.modules.mypanative.SEND_SMS"

  private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  // ---------- persistence ----------

  @Synchronized
  fun loadJobs(ctx: Context): MutableList<SmsJob> {
    val out = mutableListOf<SmsJob>()
    try {
      val arr = JSONArray(prefs(ctx).getString(KEY_JOBS, "[]"))
      for (i in 0 until arr.length()) {
        val o = arr.getJSONObject(i)
        out.add(SmsJob(o.getString("id"), o.getString("number"), o.getString("message"), o.getLong("at"), o.optString("repeat", "none"), o.optInt("subId", -1), o.optString("kind", "sms")))
      }
    } catch (_: Exception) {
    }
    return out
  }

  @Synchronized
  private fun saveJobs(ctx: Context, jobs: List<SmsJob>) {
    val arr = JSONArray()
    jobs.forEach {
      arr.put(
        JSONObject().put("id", it.id).put("number", it.number).put("message", it.message).put("at", it.at).put("repeat", it.repeat).put("subId", it.subId).put("kind", it.kind)
      )
    }
    prefs(ctx).edit().putString(KEY_JOBS, arr.toString()).apply()
  }

  @Synchronized
  private fun addResult(ctx: Context, id: String, status: String, error: String?) {
    val arr = try { JSONArray(prefs(ctx).getString(KEY_RESULTS, "[]")) } catch (_: Exception) { JSONArray() }
    arr.put(JSONObject().put("id", id).put("status", status).put("at", System.currentTimeMillis()).put("error", error ?: JSONObject.NULL))
    // keep the newest 100
    val trimmed = JSONArray()
    val start = maxOf(0, arr.length() - 100)
    for (i in start until arr.length()) trimmed.put(arr.get(i))
    prefs(ctx).edit().putString(KEY_RESULTS, trimmed.toString()).apply()
  }

  /** Returns the results as a JSON array string and clears them. */
  @Synchronized
  fun takeResults(ctx: Context): String {
    val s = prefs(ctx).getString(KEY_RESULTS, "[]") ?: "[]"
    prefs(ctx).edit().putString(KEY_RESULTS, "[]").apply()
    return s
  }

  // ---------- alarms ----------

  private fun pendingIntent(ctx: Context, id: String): PendingIntent {
    val intent = Intent(ctx, SmsAlarmReceiver::class.java).setAction(ACTION).putExtra("id", id)
    return PendingIntent.getBroadcast(ctx, id.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  fun canScheduleExact(ctx: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
    val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    return am.canScheduleExactAlarms()
  }

  /** Returns true when the alarm is exact; false when Android only allowed an approximate one. */
  fun schedule(ctx: Context, job: SmsJob, persist: Boolean): Boolean {
    val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    val pi = pendingIntent(ctx, job.id)
    val exact = canScheduleExact(ctx)
    if (exact) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, job.at, pi)
    else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, job.at, pi)
    if (persist) {
      val jobs = loadJobs(ctx).filter { it.id != job.id }.toMutableList()
      jobs.add(job)
      saveJobs(ctx, jobs)
    }
    return exact
  }

  fun cancel(ctx: Context, id: String) {
    val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    am.cancel(pendingIntent(ctx, id))
    saveJobs(ctx, loadJobs(ctx).filter { it.id != id })
  }

  fun cancelAll(ctx: Context) {
    loadJobs(ctx).forEach { cancel(ctx, it.id) }
    saveJobs(ctx, emptyList())
  }

  private fun nextTime(at: Long, repeat: String, now: Long): Long {
    val c = Calendar.getInstance().apply { timeInMillis = at }
    var guard = 0
    while (c.timeInMillis <= now && guard++ < 5000) {
      when (repeat) {
        "daily" -> c.add(Calendar.DAY_OF_YEAR, 1)
        "weekly" -> c.add(Calendar.DAY_OF_YEAR, 7)
        "monthly" -> c.add(Calendar.MONTH, 1)
        else -> return at
      }
    }
    return c.timeInMillis
  }

  // ---------- sending ----------

  private fun smsManager(ctx: Context, subId: Int): SmsManager {
    if (subId >= 0) {
      try {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) ctx.getSystemService(SmsManager::class.java).createForSubscriptionId(subId)
        else @Suppress("DEPRECATION") SmsManager.getSmsManagerForSubscriptionId(subId)
      } catch (_: Exception) {
        // chosen SIM is gone: fall back to the default one below
      }
    }
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) ctx.getSystemService(SmsManager::class.java)
    else @Suppress("DEPRECATION") SmsManager.getDefault()
  }

  private fun sendSms(ctx: Context, number: String, message: String, subId: Int) {
    if (ctx.checkSelfPermission(Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) {
      throw SecurityException("SMS permission not granted")
    }
    val sms = smsManager(ctx, subId)
    val parts = sms.divideMessage(message)
    if (parts.size > 1) sms.sendMultipartTextMessage(number, null, parts, null, null)
    else sms.sendTextMessage(number, null, message, null, null)
  }

  /**
   * Sends the job to every recipient (comma-separated numbers), records one result, then reschedules
   * (repeating) or drops (one-off) it. Must run off the main thread: recipients are spaced out slightly.
   */
  fun deliver(ctx: Context, job: SmsJob) {
    if (job.kind == "call") {
      placeCall(ctx, job)
      return
    }
    val numbers = job.number.split(",").map { it.trim() }.filter { it.isNotEmpty() }
    var ok = 0
    val errors = mutableListOf<String>()
    numbers.forEachIndexed { i, n ->
      try {
        sendSms(ctx, n, job.message, job.subId)
        ok++
      } catch (e: Exception) {
        errors.add("$n: ${e.message ?: e.javaClass.simpleName}")
      }
      if (i < numbers.size - 1) Thread.sleep(300)
    }
    val status = if (errors.isEmpty()) "sent" else if (ok > 0) "partial" else "failed"
    addResult(ctx, job.id, status, if (errors.isEmpty()) null else errors.joinToString("; ").take(300))
    // Notifications never include the number or message text.
    notify(
      ctx,
      if (errors.isEmpty()) "Scheduled text sent" else if (ok > 0) "Scheduled text partly sent" else "Scheduled text failed",
      if (errors.isEmpty()) "Sent to ${numbers.size} recipient${if (numbers.size == 1) "" else "s"}" else "Open myPA for details",
    )
    advance(ctx, job)
  }

  /**
   * Places a scheduled call. Android only lets an app start a call from the background if the user
   * granted "Display over other apps"; otherwise we post a notification that places the call when tapped.
   */
  private fun placeCall(ctx: Context, job: SmsJob) {
    val uri = Uri.parse("tel:" + Uri.encode(job.number.trim()))
    val hasCallPerm = ctx.checkSelfPermission(Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED
    val canStart = hasCallPerm && Settings.canDrawOverlays(ctx)
    try {
      if (canStart) {
        ctx.startActivity(Intent(Intent.ACTION_CALL, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        addResult(ctx, job.id, "sent", null)
      } else {
        val tap = Intent(if (hasCallPerm) Intent.ACTION_CALL else Intent.ACTION_DIAL, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val pi = PendingIntent.getActivity(ctx, job.id.hashCode(), tap, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        notify(ctx, "Time for your scheduled call", "Tap to call now", pi)
        addResult(ctx, job.id, "failed", "Could not start the call by itself. Allow 'Display over other apps' for myPA. A tap-to-call notification was shown.")
      }
    } catch (e: Exception) {
      addResult(ctx, job.id, "failed", e.message ?: e.javaClass.simpleName)
    }
    advance(ctx, job)
  }

  fun canDrawOverlays(ctx: Context): Boolean = Settings.canDrawOverlays(ctx)

  private fun advance(ctx: Context, job: SmsJob) {
    if (job.repeat == "none") {
      saveJobs(ctx, loadJobs(ctx).filter { it.id != job.id })
    } else {
      schedule(ctx, job.copy(at = nextTime(job.at, job.repeat, System.currentTimeMillis())), persist = true)
    }
  }

  /** Re-arms alarms after a reboot/app update; sends jobs that were just missed, flags older ones. */
  fun restore(ctx: Context) {
    val now = System.currentTimeMillis()
    for (job in loadJobs(ctx)) {
      when {
        job.at > now -> schedule(ctx, job, persist = false)
        // never place a call late: someone would be rung out of the blue
        now - job.at <= (if (job.kind == "call") 60_000L else GRACE_MS) -> deliver(ctx, job)
        else -> {
          addResult(ctx, job.id, "missed", "Phone was off or app was stopped at the scheduled time")
          advance(ctx, job)
        }
      }
    }
  }

  private fun notify(ctx: Context, title: String, body: String, tap: PendingIntent? = null) {
    try {
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      val builder: Notification.Builder =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          nm.createNotificationChannel(NotificationChannel(CHANNEL, "Scheduled text status", NotificationManager.IMPORTANCE_DEFAULT))
          Notification.Builder(ctx, CHANNEL)
        } else {
          @Suppress("DEPRECATION") Notification.Builder(ctx)
        }
      builder.setSmallIcon(android.R.drawable.stat_notify_chat).setContentTitle(title).setContentText(body).setAutoCancel(true)
      if (tap != null) builder.setContentIntent(tap)
      nm.notify((System.currentTimeMillis() % Int.MAX_VALUE).toInt(), builder.build())
    } catch (_: Exception) {
      // notifications are best-effort (permission may be denied)
    }
  }
}
