package com.donoy.mybandpractice.v2

import android.content.Context
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import java.io.File

/**
 * Copy a picked song folder, or a folder of song folders, into filesDir/songs.
 * Returns how many song directories were written.
 */
fun importLibraryTree(context: Context, treeUri: Uri): Int {
    val root = DocumentFile.fromTreeUri(context, treeUri)
        ?: error("フォルダを開けません")
    val songs = if (isSongDocument(root)) {
        listOf(root)
    } else {
        root.listFiles().filter { it.isDirectory && isSongDocument(it) }
    }
    if (songs.isEmpty()) error("曲フォルダが見つかりません")
    val destRoot = songsRoot(context)
    for (doc in songs) {
        val staging = File(context.cacheDir, "import-${System.nanoTime()}").apply { mkdirs() }
        try {
            for (child in doc.listFiles()) copyDoc(context, child, staging)
            val slug = readSlug(staging) ?: safeName(doc)
            val dest = File(destRoot, slug)
            if (dest.exists()) dest.deleteRecursively()
            if (!staging.renameTo(dest)) {
                staging.copyRecursively(dest, overwrite = true)
                staging.deleteRecursively()
            }
        } finally {
            if (staging.exists()) staging.deleteRecursively()
        }
    }
    return songs.size
}

private fun isSongDocument(doc: DocumentFile): Boolean {
    val names = doc.listFiles().mapNotNull { it.name }
    return names.any { it == "meta.json" || it == "lyrics.md" || it == "chunks.json" || it == "stems" }
}

private fun readSlug(dir: File): String? {
    val meta = File(dir, "meta.json")
    if (!meta.isFile) return null
    return runCatching { org.json.JSONObject(meta.readText()).optString("slug") }
        .getOrNull()
        ?.takeIf { it.isNotBlank() }
}

fun findChunksDir(root: File): File? {
    if (File(root, "chunks.json").isFile) return root
    val nested = File(root, "stems/chunks")
    if (File(nested, "chunks.json").isFile) return nested
    return root.walkTopDown().firstOrNull { it.isDirectory && File(it, "chunks.json").isFile }
}

internal fun copyDoc(context: Context, doc: DocumentFile, destDir: File) {
    val name = safeName(doc)
    if (doc.isDirectory) {
        val dir = File(destDir, name).apply { mkdirs() }
        for (child in doc.listFiles()) copyDoc(context, child, dir)
        return
    }
    context.contentResolver.openInputStream(doc.uri)?.use { input ->
        File(destDir, name).outputStream().use { output -> input.copyTo(output) }
    }
}

private fun safeName(doc: DocumentFile): String {
    val raw = doc.name ?: doc.uri.lastPathSegment?.substringAfterLast('/')?.substringAfterLast(':')
    val name = raw?.takeIf { it.isNotBlank() } ?: "item"
    return name.replace(Regex("[\\\\/]+"), "_")
}
