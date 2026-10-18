package com.mcode.remote

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.IBinder

/**
 * Keeps the process alive while a gateway session is expected to keep
 * running: a quiet ongoing notification lifts the process out of the
 * bucket the OS kills first, so the WebSocket survives a locked phone.
 * The connection itself lives with the app; this service is the umbrella.
 */
class KeepAliveService : Service() {
    companion object {
        /** Set while the service lives; the activity pushes permission cards through it. */
        @Volatile
        var instance: KeepAliveService? = null
    }

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel("remote-keepalive", "MCode 连接", NotificationManager.IMPORTANCE_LOW),
        )
        val notification = Notification.Builder(this, "remote-keepalive")
            .setContentTitle("MCode")
            .setContentText("与本机 MCode 的连接保持中")
            .setSmallIcon(R.drawable.mcode_mark)
            .setOngoing(true)
            .build()
        startForeground(2026, notification)
        instance = this
    }

    override fun onDestroy() {
        instance = null
        super.onDestroy()
    }

    /** Swap the ongoing notification's text while a permission card is up. */
    fun showPermission(title: String) {
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        val notification = Notification.Builder(this, "remote-keepalive")
            .setContentTitle("MCode 请求批准")
            .setContentText(title.ifBlank { "打开 MCode 查看详情" })
            .setSmallIcon(R.drawable.mcode_mark)
            .setOngoing(true)
            .build()
        manager.notify(2026, notification)
    }

    /** Restore the plain keep-alive text once the card is answered. */
    fun restoreKeepAlive() {
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        val notification = Notification.Builder(this, "remote-keepalive")
            .setContentTitle("MCode")
            .setContentText("与本机 MCode 的连接保持中")
            .setSmallIcon(R.drawable.mcode_mark)
            .setOngoing(true)
            .build()
        manager.notify(2026, notification)
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
