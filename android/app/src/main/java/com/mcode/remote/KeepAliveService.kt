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
    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel("remote-keepalive", "MCode Remote 连接", NotificationManager.IMPORTANCE_LOW),
        )
        val notification = Notification.Builder(this, "remote-keepalive")
            .setContentTitle("MCode Remote")
            .setContentText("与本机 MCode 的连接保持中")
            .setSmallIcon(R.drawable.mcode_mark)
            .setOngoing(true)
            .build()
        startForeground(2026, notification)
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
