package com.donoy.mybandpractice.v2

import android.Manifest
import android.app.KeyguardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.donoy.mybandpractice.v2.ui.PracticeScreen

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { PracticeScreen() }
        askForNotifications()
    }

    override fun onResume() {
        super.onResume()
        offerHomeShortcut()
    }

    /** adb install does not place a home-screen icon. Ask once. */
    private fun offerHomeShortcut() {
        val prefs = getSharedPreferences("launcher", MODE_PRIVATE)
        if (prefs.getBoolean("pin_requested", false)) return
        // Resumed behind the lock screen the app is not the foreground app yet, and the
        // system throws instead of asking. Wait for a resume that the user can see.
        if (getSystemService(KeyguardManager::class.java)?.isKeyguardLocked == true) return
        val shortcuts = getSystemService(ShortcutManager::class.java) ?: return
        if (!shortcuts.isRequestPinShortcutSupported) return
        val shortcut = ShortcutInfo.Builder(this, "practice")
            .setShortLabel(getString(R.string.app_name))
            .setIcon(Icon.createWithResource(this, R.mipmap.ic_launcher))
            .setIntent(
                Intent(Intent.ACTION_MAIN)
                    .setClass(this, MainActivity::class.java)
                    .addCategory(Intent.CATEGORY_LAUNCHER),
            )
            .build()
        prefs.edit().putBoolean("pin_requested", true).apply()
        runCatching { shortcuts.requestPinShortcut(shortcut, null) }
            .onFailure { Log.w("mbp-launcher", "pin shortcut request failed", it) }
    }

    /** The transport lives in a notification; Android 13 and later ask before showing one. */
    private fun askForNotifications() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        val prefs = getSharedPreferences("launcher", MODE_PRIVATE)
        if (prefs.getBoolean("notifications_asked", false)) return
        prefs.edit().putBoolean("notifications_asked", true).apply()
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 0)
    }
}
