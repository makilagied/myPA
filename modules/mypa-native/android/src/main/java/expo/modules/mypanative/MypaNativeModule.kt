package expo.modules.mypanative

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.provider.Settings
import android.telephony.SubscriptionManager
import org.json.JSONArray
import org.json.JSONObject
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class MypaNativeModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("React context is not available")

  private fun launch(intent: Intent) {
    context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
  }

  override fun definition() = ModuleDefinition {
    Name("MypaNative")

    // ----- scheduled SMS (sent by a native alarm, even when the app is closed) -----
    Function("scheduleSms") { id: String, number: String, message: String, atMillis: Double, repeat: String, subId: Double ->
      SmsScheduler.schedule(context, SmsJob(id, number, message, atMillis.toLong(), repeat, subId.toInt()), persist = true)
    }

    Function("scheduleCall") { id: String, number: String, atMillis: Double, repeat: String ->
      SmsScheduler.schedule(context, SmsJob(id, number, "", atMillis.toLong(), repeat, -1, "call"), persist = true)
    }

    Function("cancelSms") { id: String ->
      SmsScheduler.cancel(context, id)
    }

    Function("cancelAllSms") {
      SmsScheduler.cancelAll(context)
    }

    // JSON array string of {id, status: sent|failed|missed, at, error}; cleared after reading.
    Function("takeSmsResults") {
      SmsScheduler.takeResults(context)
    }

    // JSON array of {subId, slot, name, carrier}; "[]" until READ_PHONE_STATE is granted.
    Function("getSims") {
      if (context.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) {
        "[]"
      } else {
        val sm = context.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE) as SubscriptionManager
        val arr = JSONArray()
        sm.activeSubscriptionInfoList?.forEach {
          arr.put(
            JSONObject()
              .put("subId", it.subscriptionId)
              .put("slot", it.simSlotIndex + 1)
              .put("name", (it.displayName ?: "").toString())
              .put("carrier", (it.carrierName ?: "").toString())
          )
        }
        arr.toString()
      }
    }

    // ----- calls -----
    Function("callNumber") { number: String ->
      if (context.checkSelfPermission(Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
        false
      } else {
        launch(Intent(Intent.ACTION_CALL, Uri.parse("tel:" + Uri.encode(number))))
        true
      }
    }

    // ----- reliability helpers -----
    Function("canScheduleExactAlarms") {
      SmsScheduler.canScheduleExact(context)
    }

    Function("openExactAlarmSettings") {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        launch(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:" + context.packageName)))
      }
    }

    Function("canDrawOverlays") {
      SmsScheduler.canDrawOverlays(context)
    }

    Function("openOverlaySettings") {
      launch(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + context.packageName)))
    }

    // ----- fake call ringing: plays the phone's real ringtone until stopped -----
    Function("startRingtone") {
      RingtonePlayer.start(context)
    }

    Function("stopRingtone") {
      RingtonePlayer.stop()
    }

    Function("isIgnoringBatteryOptimizations") {
      val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      pm.isIgnoringBatteryOptimizations(context.packageName)
    }

    Function("openBatterySettings") {
      launch(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
    }

    Function("openAppSettings") {
      launch(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.packageName)))
    }
  }
}

object RingtonePlayer {
  private var ringtone: Ringtone? = null

  @Synchronized
  fun start(ctx: Context) {
    stop()
    val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
    val r = RingtoneManager.getRingtone(ctx, uri) ?: return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) r.isLooping = true
    r.play()
    ringtone = r
  }

  @Synchronized
  fun stop() {
    try {
      ringtone?.stop()
    } catch (_: Exception) {
    }
    ringtone = null
  }
}
