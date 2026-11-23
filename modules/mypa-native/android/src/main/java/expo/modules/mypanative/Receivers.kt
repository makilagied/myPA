package expo.modules.mypanative

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class SmsAlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val id = intent.getStringExtra("id") ?: return
    val pending = goAsync()
    Thread {
      try {
        val job = SmsScheduler.loadJobs(context).firstOrNull { it.id == id }
        if (job != null) SmsScheduler.deliver(context, job)
      } finally {
        pending.finish()
      }
    }.start()
  }
}

class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val pending = goAsync()
    Thread {
      try {
        SmsScheduler.restore(context)
      } finally {
        pending.finish()
      }
    }.start()
  }
}
