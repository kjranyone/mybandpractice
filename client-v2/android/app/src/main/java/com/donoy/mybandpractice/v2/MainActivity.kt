package com.donoy.mybandpractice.v2

import android.content.Intent
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import android.media.AudioManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.donoy.mybandpractice.v2.ui.PracticeScreen

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val audio = getSystemService(AudioManager::class.java)
        requestPlaybackFocus(audio)
        setContent { PracticeScreen() }
    }

    override fun onResume() {
        super.onResume()
        offerHomeShortcut()
    }

    /** adb install does not place a home-screen icon. Ask once. */
    private fun offerHomeShortcut() {
        val prefs = getSharedPreferences("launcher", MODE_PRIVATE)
        if (prefs.getBoolean("pin_requested", false)) return
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
        shortcuts.requestPinShortcut(shortcut, null)
    }
}
