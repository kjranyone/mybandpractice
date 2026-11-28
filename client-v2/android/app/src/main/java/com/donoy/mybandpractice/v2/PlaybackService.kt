package com.donoy.mybandpractice.v2

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Keeps the process alive while music plays, and puts the transport into the notification
 * shade and on the lock screen. Without it Android caches and then freezes an app that is
 * in the background, which stops the audio.
 */
class PlaybackService : Service() {
    private lateinit var session: MediaSession
    private var wakeLock: PowerManager.WakeLock? = null
    private var focusRequest: AudioFocusRequest? = null
    private var noisy: BroadcastReceiver? = null
    private val handler = Handler(Looper.getMainLooper())
    private val manager get() = getSystemService(NotificationManager::class.java)
    private var metadataFor: SongRecord? = null
    private var shown: String? = null
    private var ticks = 0
    private var idleTicks = 0

    override fun onCreate() {
        super.onCreate()
        running = this
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, getString(R.string.playback_channel), NotificationManager.IMPORTANCE_LOW),
        )
        session = MediaSession(this, "mybandpractice").apply {
            setCallback(object : MediaSession.Callback() {
                override fun onPlay() = play()

                override fun onPause() = Playback.pause()

                override fun onSkipToNext() {
                    Playback.listener?.step(1)
                }

                override fun onSkipToPrevious() {
                    Playback.listener?.step(-1)
                }

                override fun onSeekTo(pos: Long) = Playback.seekTo(pos / 1000.0)
            })
            setSessionActivity(openApp())
            isActive = true
        }
        focusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build(),
            )
            // A short notification sound is ducked by the system itself; losses reach
            // Playback.focusChanged.
            .setOnAudioFocusChangeListener({ change -> Playback.focusChanged(change) }, handler)
            .build()
        noisy = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) = Playback.outputDisconnected()
        }
        ContextCompat.registerReceiver(this, noisy, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        } catch (err: RuntimeException) {
            // the type or the moment was not allowed: the song plays without the priority
            Log.w(TAG, "foreground service not started", err)
            stopSelf()
            return START_NOT_STICKY
        }
        requestFocus()
        when (intent?.action) {
            ACTION_PLAY -> play()
            ACTION_PAUSE -> Playback.pause()
            ACTION_NEXT -> Playback.listener?.step(1)
            ACTION_PREVIOUS -> Playback.listener?.step(-1)
        }
        sync()
        handler.removeCallbacks(ticker)
        handler.postDelayed(ticker, 1000)
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onTaskRemoved(rootIntent: Intent?) {
        // swiping the app away ends a paused transport; a running one goes on
        if (Playback.player?.playing() != true) manager.cancel(NOTIFICATION_ID)
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        running = null
        handler.removeCallbacks(ticker)
        holdProcessor(false)
        noisy?.let { runCatching { unregisterReceiver(it) } }
        focusRequest?.let { getSystemService(AudioManager::class.java).abandonAudioFocusRequest(it) }
        session.release()
        super.onDestroy()
    }

    private val ticker = object : Runnable {
        override fun run() {
            if (running !== this@PlaybackService) return
            val playing = Playback.player?.playing() == true
            if (Playback.feeder?.failed == true) {
                // nothing moves the song on any more, and the speaker stays silent
                Playback.outputError = getString(R.string.playback_output_lost)
                Playback.pause()
                return
            }
            refresh()
            // Without a PracticeModel nobody steps to the next song: stop at the end. A song
            // that is about to play passes through a quiet second while it is decoded.
            val idle = !playing && !Playback.waitingForFocus && !Playback.loading
            idleTicks = if (idle) idleTicks + 1 else 0
            if (idleTicks >= 2) {
                sync()
                return
            }
            if (playing && ++ticks % PROGRESS_EVERY_TICKS == 0) Playback.saveProgress()
            handler.postDelayed(this, 1000)
        }
    }

    /** Plays what is loaded, or the song that played last after the process was restarted. */
    private fun play() {
        val loaded = Playback.current
        if (loaded != null) {
            start(loaded)
        } else {
            Playback.restore { song -> if (song != null) start(song) }
        }
    }

    /** The screen, when there is one, shows the song that is about to play. */
    private fun start(song: SongRecord) {
        Playback.listener?.adopt(song)
        Playback.play()
    }

    private fun requestFocus() {
        focusRequest?.let { getSystemService(AudioManager::class.java).requestAudioFocus(it) }
    }

    /** Brings the service in line with the engine: foreground while something plays. */
    fun sync() {
        val playing = Playback.player?.playing() == true
        refresh()
        if (playing || Playback.waitingForFocus || Playback.loading) {
            holdProcessor(true)
        } else {
            holdProcessor(false)
            // the paused transport stays in the shade: its play button starts us again
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_DETACH)
            stopSelf()
        }
    }

    // The notification permission is asked for once in MainActivity; without it this is a no-op.
    @SuppressLint("MissingPermission")
    private fun refresh() {
        val engine = Playback.player
        val song = Playback.current
        val playing = engine?.playing() == true
        var actions = PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or
            PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_SEEK_TO
        if (Playback.listener != null) {
            actions = actions or PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS
        }
        session.setPlaybackState(
            PlaybackState.Builder()
                .setActions(actions)
                .setState(
                    if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
                    ((engine?.position() ?: 0.0) * 1000).toLong(),
                    if (playing) 1f else 0f,
                )
                .build(),
        )
        if (song != metadataFor) {
            metadataFor = song
            session.setMetadata(
                MediaMetadata.Builder()
                    .putString(MediaMetadata.METADATA_KEY_TITLE, song?.title ?: getString(R.string.app_name))
                    .putString(MediaMetadata.METADATA_KEY_ARTIST, song?.artist.orEmpty())
                    .putLong(MediaMetadata.METADATA_KEY_DURATION, ((engine?.duration() ?: 0.0) * 1000).toLong())
                    .build(),
            )
        }
        val key = "${song?.slug}:${playing}:${Playback.listener != null}"
        if (key != shown) {
            shown = key
            manager.notify(NOTIFICATION_ID, notification())
        }
    }

    private fun notification(): Notification {
        val song = Playback.current
        val playing = Playback.player?.playing() == true
        val builder = Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_note)
            .setContentTitle(song?.title ?: getString(R.string.app_name))
            .setContentText(song?.artist?.ifBlank { null } ?: getString(R.string.playback_nothing))
            .setContentIntent(openApp())
            .setCategory(Notification.CATEGORY_TRANSPORT)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setOngoing(playing)
        if (song != null) {
            val stepper = Playback.listener != null
            if (stepper) builder.addAction(transport(R.drawable.ic_stat_previous, R.string.playback_previous, ACTION_PREVIOUS))
            builder.addAction(
                transport(
                    if (playing) R.drawable.ic_stat_pause else R.drawable.ic_stat_play,
                    if (playing) R.string.playback_pause else R.string.playback_play,
                    if (playing) ACTION_PAUSE else ACTION_PLAY,
                ),
            )
            if (stepper) builder.addAction(transport(R.drawable.ic_stat_next, R.string.playback_next, ACTION_NEXT))
            builder.setStyle(
                Notification.MediaStyle()
                    .setMediaSession(session.sessionToken)
                    .setShowActionsInCompactView(*(if (stepper) intArrayOf(0, 1, 2) else intArrayOf(0))),
            )
        }
        return builder.build()
    }

    private fun transport(icon: Int, title: Int, command: String): Notification.Action =
        Notification.Action.Builder(Icon.createWithResource(this, icon), getString(title), pending(command)).build()

    private fun pending(command: String): PendingIntent =
        PendingIntent.getForegroundService(
            this,
            command.hashCode(),
            Intent(this, PlaybackService::class.java).setAction(command),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    private fun openApp(): PendingIntent =
        PendingIntent.getActivity(
            this,
            0,
            Intent(Intent.ACTION_MAIN)
                .setClass(this, MainActivity::class.java)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    /** The decoder has to keep running with the screen off, so the CPU may not sleep. */
    private fun holdProcessor(hold: Boolean) {
        if (hold) {
            val lock = wakeLock ?: getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "mybandpractice:playback")
                .also { wakeLock = it }
            if (!lock.isHeld) lock.acquire()
        } else {
            wakeLock?.let { if (it.isHeld) it.release() }
        }
    }

    companion object {
        private const val TAG = "mbp-playback"
        private const val CHANNEL = "playback"
        private const val NOTIFICATION_ID = 0x4d42
        private const val PROGRESS_EVERY_TICKS = 5
        private const val ACTION_PLAY = "com.donoy.mybandpractice.v2.PLAY"
        private const val ACTION_PAUSE = "com.donoy.mybandpractice.v2.PAUSE"
        private const val ACTION_NEXT = "com.donoy.mybandpractice.v2.NEXT"
        private const val ACTION_PREVIOUS = "com.donoy.mybandpractice.v2.PREVIOUS"

        @Volatile private var running: PlaybackService? = null

        /** Brings the service up as a foreground media player, or refreshes it when it runs. */
        fun running(context: Context) {
            val service = running
            if (service != null) {
                service.requestFocus()
                service.refresh()
                return
            }
            try {
                ContextCompat.startForegroundService(context, Intent(context, PlaybackService::class.java))
            } catch (err: RuntimeException) {
                // not allowed from the background at this moment: play without the priority
                Log.w(TAG, "foreground service not started", err)
            }
        }

        /** Lets the service stop when nothing plays and nothing waits for the focus. */
        fun sync(context: Context) {
            running?.sync()
        }
    }
}
