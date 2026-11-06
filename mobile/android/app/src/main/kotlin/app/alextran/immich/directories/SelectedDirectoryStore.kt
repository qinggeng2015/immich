package app.alextran.immich.directories

import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.CancellationSignal
import android.os.OperationCanceledException
import android.provider.DocumentsContract
import android.util.Base64
import android.util.Log
import app.alextran.immich.sync.AudioSyncPolicy
import app.alextran.immich.sync.HashResult
import app.alextran.immich.sync.PlatformAlbum
import app.alextran.immich.sync.PlatformAsset
import app.alextran.immich.sync.PlatformAssetPlaybackStyle
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.InterruptedIOException
import java.io.OutputStream
import java.security.MessageDigest
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.CancellationException

class SelectedDirectoryStore(context: Context) {
  private val context = context.applicationContext
  private val resolver = this.context.contentResolver
  private val preferences = this.context.getSharedPreferences("Immich::SelectedDirectories", Context.MODE_PRIVATE)

  @Volatile
  private var snapshots: Map<String, Snapshot> = emptyMap()

  private data class Directory(
    val id: String,
    val uri: Uri,
    val name: String,
    val assetCount: Long = 0,
    val updatedAt: Long = 0
  ) {
    fun album() = PlatformAlbum("saf-folder:$id", name, updatedAt, false, assetCount)
  }

  private data class Document(
    val id: String,
    val name: String,
    val mimeType: String,
    val modifiedAt: Long?,
    val size: Long?,
    val flags: Int
  ) {
    val isDirectory get() = mimeType == DocumentsContract.Document.MIME_TYPE_DIR
    val isPartial get() = flags and DocumentsContract.Document.FLAG_PARTIAL != 0
    val isVirtual get() = flags and DocumentsContract.Document.FLAG_VIRTUAL_DOCUMENT != 0
  }

  private data class Identity(
    val authority: String,
    val documentId: String,
    val modifiedAt: Long?,
    val size: Long?,
    val fingerprint: String? = null
  ) {
    fun encode(): String {
      val provider = Base64.encodeToString(authority.toByteArray(Charsets.UTF_8), BASE64_FLAGS)
      val document = Base64.encodeToString(documentId.toByteArray(Charsets.UTF_8), BASE64_FLAGS)
      val base = "saf-file:$provider:$document:${modifiedAt ?: 0}:${size ?: -1}"
      return if (fingerprint == null) base else "$base:$fingerprint"
    }

    fun matches(document: Document): Boolean = document.id == documentId &&
      document.modifiedAt == modifiedAt && document.size == size && !document.isDirectory &&
      !document.isPartial && !document.isVirtual
  }

  private data class Snapshot(val directory: Directory, val assets: List<PlatformAsset>, val error: String? = null)

  private data class StreamResult(val size: Long, val digest: ByteArray) {
    val fingerprint get() = digest.joinToString("") { "%02x".format(it.toInt() and 0xff) }
  }

  private data class MediaMetadata(
    val width: Long? = null,
    val height: Long? = null,
    val duration: Long = 0,
    val orientation: Long = 0
  )

  private data class SupportedMedia(val type: Long, val name: String)

  private data class ResolvedAsset(val directory: Directory, val uri: Uri, val document: Document)

  val hasDirectories: Boolean get() = loadDirectories().isNotEmpty()

  fun addDirectory(uri: Uri): String {
    require(uri.scheme == "content" && DocumentsContract.isTreeUri(uri)) { "A document tree is required" }
    synchronized(preferencesLock) {
      val hadReadGrant = resolver.persistedUriPermissions.any { it.isReadPermission && sameTree(it.uri, uri) }
      resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
      try {
        val rootUri = DocumentsContract.buildDocumentUriUsingTree(uri, DocumentsContract.getTreeDocumentId(uri))
        val root = queryDocument(rootUri) ?: throw IOException("Selected directory is unavailable")
        require(root.isDirectory) { "The selected document is not a directory" }
        val directories = loadDirectories().toMutableList()
        val existing = directories.indexOfFirst { sameTree(it.uri, uri) }
        val directory = if (existing >= 0) {
          directories[existing].copy(name = root.name.ifBlank { directories[existing].name })
        } else {
          Directory(UUID.randomUUID().toString(), uri, root.name.ifBlank { DocumentsContract.getTreeDocumentId(uri) })
        }
        if (existing >= 0) directories[existing] = directory else directories.add(directory)
        saveDirectories(directories)
        snapshots = snapshots - directory.id
        return "saf-folder:${directory.id}"
      } catch (error: Exception) {
        if (!hadReadGrant) {
          try {
            resolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
          } catch (_: SecurityException) {
          }
        }
        throw error
      }
    }
  }

  fun removeDirectory(albumId: String) {
    val id = directoryId(albumId)
    synchronized(preferencesLock) {
      val directories = loadDirectories()
      val directory = directories.firstOrNull { it.id == id } ?: return
      saveDirectories(directories.filterNot { it.id == id })
      snapshots = snapshots - id
      try {
        resolver.releasePersistableUriPermission(directory.uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
      } catch (_: SecurityException) {
      }
    }
  }

  @Synchronized
  fun getAlbums(): List<PlatformAlbum> {
    checkCancellation()
    val scanned = loadDirectories().associate { directory ->
      val snapshot = try {
        checkCancellation()
        requireReadPermission(directory)
        scan(directory)
      } catch (error: OperationCanceledException) {
        throw error
      } catch (error: InterruptedIOException) {
        throw error
      } catch (error: CancellationException) {
        throw error
      } catch (error: Exception) {
        checkCancellation()
        Log.w("SelectedDirectoryStore", "Directory scan failed (${error.javaClass.simpleName})")
        Snapshot(directory, snapshots[directory.id]?.assets ?: emptyList(), error.message ?: "Directory unavailable")
      }
      directory.id to snapshot
    }
    checkCancellation()
    synchronized(preferencesLock) {
      val current = loadDirectories()
      val updated = current.map { directory ->
        scanned[directory.id]?.takeIf { it.error == null && sameTree(it.directory.uri, directory.uri) }?.directory
          ?: directory
      }
      val ids = current.map { it.id }.toSet()
      snapshots = scanned.filterKeys { it in ids }
      val unavailable = snapshots.filterValues { it.error != null }.keys
      saveDirectories(updated, unavailable)
    }
    return snapshots.values.map { it.directory.album() }.sortedBy { it.id }
  }

  fun getUnavailableDirectoryIds(): List<String> = synchronized(preferencesLock) {
    val unavailable = preferences.getStringSet("unavailableDirectories", emptySet()) ?: emptySet()
    val permissions = resolver.persistedUriPermissions
    loadDirectories().filter { directory ->
      directory.id in unavailable || permissions.none { it.isReadPermission && sameTree(it.uri, directory.uri) }
    }.map { "saf-folder:${it.id}" }.sorted()
  }

  fun getAssets(albumId: String): List<PlatformAsset> {
    val id = directoryId(albumId)
    val directory = findDirectory(id)
    if (snapshots[id] == null) getAlbums()
    val snapshot = snapshots[id] ?: throw IOException("Directory has not been scanned")
    if (!sameTree(snapshot.directory.uri, directory.uri) || snapshot.error != null) {
      throw IOException(snapshot.error ?: "Directory changed during scan")
    }
    requireReadPermission(directory)
    return snapshot.assets
  }

  fun getAssetIds(albumId: String): List<String> = getAssets(albumId).map { it.id }

  fun getAssetsCountSince(albumId: String, timestamp: Long): Long =
    getAssets(albumId).count { (it.updatedAt ?: 0) > timestamp }.toLong()

  fun hashAsset(assetId: String): HashResult = try {
    val identity = parseIdentity(assetId)
    val source = resolveAsset(identity)
    val result = readContent(source.uri)
    validateResult(identity, result)
    validate(identity, source.directory, source.uri)
    HashResult(assetId, null, Base64.encodeToString(result.digest, Base64.NO_WRAP))
  } catch (error: OperationCanceledException) {
    throw error
  } catch (error: InterruptedIOException) {
    throw error
  } catch (error: CancellationException) {
    throw error
  } catch (error: Exception) {
    checkCancellation()
    HashResult(assetId, error.message ?: "Unable to hash selected file", null)
  }

  fun exportFile(assetId: String): String {
    val identity = parseIdentity(assetId)
    val source = resolveAsset(identity)
    val media = supportedMedia(source.document) ?: throw IOException("Selected file is not a supported media format")
    val extension = media.name.substringAfterLast('.').lowercase()
    val exportDirectory = File(context.cacheDir, "selected-directory-exports")
    if (!exportDirectory.isDirectory && !exportDirectory.mkdirs()) throw IOException("Cannot create export directory")
    val output = File.createTempFile("selected-", ".$extension", exportDirectory)
    try {
      val result = output.outputStream().use { readContent(source.uri, it) }
      validateResult(identity, result)
      validate(identity, source.directory, source.uri)
      return output.absolutePath
    } catch (error: Exception) {
      output.delete()
      throw error
    }
  }

  fun getUri(assetId: String): Uri {
    val identity = parseIdentity(assetId)
    val source = resolveAsset(identity)
    if (identity.fingerprint != null) {
      validateResult(identity, readContent(source.uri))
      validate(identity, source.directory, source.uri)
    }
    return source.uri
  }

  private fun scan(directory: Directory): Snapshot {
    val rootId = DocumentsContract.getTreeDocumentId(directory.uri)
    val root = queryDocument(documentUri(directory, rootId)) ?: throw IOException("Selected directory is unavailable")
    if (!root.isDirectory || root.isPartial) throw IOException("Selected directory is incomplete")
    val pending = ArrayDeque<String>()
    val visited = mutableSetOf<String>()
    val assets = mutableListOf<PlatformAsset>()
    pending.add(rootId)
    while (pending.isNotEmpty()) {
      checkCancellation()
      val parentId = pending.removeFirst()
      if (!visited.add(parentId)) continue
      val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(directory.uri, parentId)
      val children = queryDocuments(childrenUri)
      for (document in children) {
        checkCancellation()
        if (document.isDirectory) {
          if (document.isPartial) throw IOException("Directory contains incomplete directories")
          pending.add(document.id)
          continue
        }
        if (!visited.add(document.id) || document.isVirtual) continue
        val media = supportedMedia(document) ?: continue
        val type = media.type
        if (document.isPartial) throw IOException("Directory contains incomplete media files")
        val uri = documentUri(directory, document.id)
        val authority = directory.uri.authority ?: throw IOException("Selected directory has no provider")
        var identity = Identity(authority, document.id, document.modifiedAt, document.size)
        if (document.modifiedAt == null || document.size == null) {
          val result = readContent(uri)
          if (document.size != null && result.size != document.size) throw IOException("Selected file changed during scan")
          identity = identity.copy(fingerprint = result.fingerprint)
          validate(identity, directory, uri)
        }
        val metadata = if (directory.uri.authority in localAuthorities) readMediaMetadata(uri, type) else MediaMetadata()
        validate(identity, directory, uri)
        assets.add(
          PlatformAsset(
            id = identity.encode(),
            name = media.name,
            type = type,
            createdAt = (document.modifiedAt ?: 0) / 1000,
            updatedAt = (document.modifiedAt ?: 0) / 1000,
            width = metadata.width,
            height = metadata.height,
            durationMs = metadata.duration,
            orientation = metadata.orientation,
            isFavorite = false,
            playbackStyle = when (type) {
              1L -> if (media.name.endsWith(".gif", true)) PlatformAssetPlaybackStyle.IMAGE_ANIMATED else PlatformAssetPlaybackStyle.IMAGE
              2L -> PlatformAssetPlaybackStyle.VIDEO
              else -> PlatformAssetPlaybackStyle.UNKNOWN
            }
          )
        )
      }
    }
    val updatedDirectory = directory.copy(
      name = root.name.ifBlank { directory.name },
      assetCount = assets.size.toLong(),
      updatedAt = maxOf((root.modifiedAt ?: 0) / 1000, assets.maxOfOrNull { it.updatedAt ?: 0 } ?: 0)
    )
    return Snapshot(updatedDirectory, assets.sortedBy { it.id })
  }

  private fun readMediaMetadata(uri: Uri, type: Long): MediaMetadata {
    if (type == 1L) {
      val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      try {
        resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
      } catch (error: SecurityException) {
        throw error
      } catch (_: Exception) {
        return MediaMetadata()
      }
      return MediaMetadata(options.outWidth.toLong().takeIf { it > 0 }, options.outHeight.toLong().takeIf { it > 0 })
    }
    val retriever = MediaMetadataRetriever()
    try {
      retriever.setDataSource(context, uri)
      val duration = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()?.coerceAtLeast(0) ?: 0
      if (type == 3L) return MediaMetadata(duration = duration)
      val width = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toLongOrNull()?.takeIf { it > 0 }
      val height = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toLongOrNull()?.takeIf { it > 0 }
      val orientation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toLongOrNull() ?: 0
      return if (orientation == 90L || orientation == 270L) MediaMetadata(height, width, duration, orientation)
      else MediaMetadata(width, height, duration, orientation)
    } catch (error: SecurityException) {
      throw error
    } catch (_: Exception) {
      return MediaMetadata()
    } finally {
      retriever.release()
    }
  }

  private fun validate(identity: Identity, directory: Directory, uri: Uri): Document {
    checkCancellation()
    val currentDirectory = findDirectory(directory.id)
    if (!sameTree(directory.uri, currentDirectory.uri) || identity.authority != currentDirectory.uri.authority) {
      throw IOException("Selected directory changed")
    }
    requireReadPermission(currentDirectory)
    val root = documentUri(currentDirectory, DocumentsContract.getTreeDocumentId(currentDirectory.uri))
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && !DocumentsContract.isChildDocument(resolver, root, uri)) {
      throw SecurityException("File is outside the selected directory")
    }
    val document = queryDocument(uri) ?: throw IOException("Selected file is unavailable")
    if (!identity.matches(document)) throw IOException("Selected file changed; rescan the directory")
    return document
  }

  private fun resolveAsset(identity: Identity): ResolvedAsset {
    var failure: Exception? = null
    for (directory in loadDirectories().filter { it.uri.authority == identity.authority }) {
      checkCancellation()
      try {
        val uri = documentUri(directory, identity.documentId)
        val document = validate(identity, directory, uri)
        return ResolvedAsset(directory, uri, document)
      } catch (error: OperationCanceledException) {
        throw error
      } catch (error: InterruptedIOException) {
        throw error
      } catch (error: CancellationException) {
        throw error
      } catch (error: Exception) {
        checkCancellation()
        failure = error
      }
    }
    throw failure ?: SecurityException("No selected directory grants access to this file")
  }

  private fun validateResult(identity: Identity, result: StreamResult) {
    if (identity.size != null && identity.size != result.size ||
      identity.fingerprint != null && identity.fingerprint != result.fingerprint) {
      throw IOException("Selected file changed while reading; rescan the directory")
    }
  }

  private fun readContent(uri: Uri, output: OutputStream? = null): StreamResult {
    checkCancellation()
    val cancellationSignal = CancellationSignal()
    val digest = MessageDigest.getInstance("SHA-1")
    val descriptor = resolver.openAssetFileDescriptor(uri, "r", cancellationSignal)
    if (descriptor == null) {
      checkCancellation(cancellationSignal)
      throw IOException("Cannot read selected file")
    }
    var size = 0L
    descriptor.use {
      checkCancellation(cancellationSignal)
      it.createInputStream().use { stream: InputStream ->
        val buffer = ByteArray(256 * 1024)
        while (true) {
          checkCancellation(cancellationSignal)
          val count = stream.read(buffer)
          if (count < 0) break
          if (count == 0) continue
          size += count
          digest.update(buffer, 0, count)
          output?.write(buffer, 0, count)
        }
        checkCancellation(cancellationSignal)
      }
    }
    return StreamResult(size, digest.digest())
  }

  private fun queryDocument(uri: Uri): Document? = queryDocuments(uri).singleOrNull()

  private fun queryDocuments(uri: Uri): List<Document> {
    checkCancellation()
    val cancellationSignal = CancellationSignal()
    val cursor = resolver.query(uri, projection, null, null, null, cancellationSignal)
    if (cursor == null) {
      checkCancellation(cancellationSignal)
      throw IOException("Document query failed")
    }
    return cursor.use {
      checkCancellation(cancellationSignal)
      val documents = mutableListOf<Document>()
      while (it.moveToNext()) {
        checkCancellation(cancellationSignal)
        val id = it.string(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
          ?: throw IOException("Document has no identifier")
        val name = it.string(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
          ?: throw IOException("Document has no name")
        val mimeType = it.string(DocumentsContract.Document.COLUMN_MIME_TYPE)
          ?: throw IOException("Document has no media type")
        documents.add(
          Document(
            id,
            name,
            mimeType,
            it.long(DocumentsContract.Document.COLUMN_LAST_MODIFIED)?.takeIf { value -> value > 0 },
            it.long(DocumentsContract.Document.COLUMN_SIZE)?.takeIf { value -> value >= 0 },
            it.long(DocumentsContract.Document.COLUMN_FLAGS)?.toInt() ?: 0
          )
        )
      }
      checkCancellation(cancellationSignal)
      if (it.extras.getBoolean(DocumentsContract.EXTRA_LOADING, false)) throw IOException("Directory is still loading")
      val error = it.extras.getString(DocumentsContract.EXTRA_ERROR)
      if (!error.isNullOrBlank()) throw IOException(error)
      documents
    }
  }

  private fun Cursor.string(column: String): String? {
    val index = getColumnIndex(column)
    return if (index < 0 || isNull(index)) null else getString(index)
  }

  private fun Cursor.long(column: String): Long? {
    val index = getColumnIndex(column)
    return if (index < 0 || isNull(index)) null else getLong(index)
  }

  private fun requireReadPermission(directory: Directory) {
    if (resolver.persistedUriPermissions.none { it.isReadPermission && sameTree(it.uri, directory.uri) }) {
      throw SecurityException("Access to the selected directory was revoked")
    }
  }

  private fun findDirectory(id: String): Directory =
    loadDirectories().firstOrNull { it.id == id } ?: throw SecurityException("Directory is no longer selected")

  private fun loadDirectories(): List<Directory> = synchronized(preferencesLock) {
    val values = JSONArray(preferences.getString("directories", "[]"))
    List(values.length()) { index ->
      val value = values.getJSONObject(index)
      Directory(
        value.getString("id"),
        Uri.parse(value.getString("uri")),
        value.getString("name"),
        value.optLong("assetCount", 0),
        value.optLong("updatedAt", 0)
      )
    }
  }

  private fun saveDirectories(directories: List<Directory>, unavailable: Set<String>? = null) {
    val values = JSONArray()
    for (directory in directories) {
      values.put(
        JSONObject().put("id", directory.id).put("uri", directory.uri.toString()).put("name", directory.name)
          .put("assetCount", directory.assetCount).put("updatedAt", directory.updatedAt)
      )
    }
    val editor = preferences.edit().putString("directories", values.toString())
    if (unavailable != null) editor.putStringSet("unavailableDirectories", unavailable)
    if (!editor.commit()) {
      throw IOException("Cannot save selected directories")
    }
  }

  private fun documentUri(directory: Directory, documentId: String): Uri =
    DocumentsContract.buildDocumentUriUsingTree(directory.uri, documentId)

  private fun checkCancellation(cancellationSignal: CancellationSignal? = null) {
    if (Thread.currentThread().isInterrupted) {
      cancellationSignal?.cancel()
      throw CancellationException("Selected directory operation interrupted")
    }
  }

  private fun sameTree(first: Uri, second: Uri): Boolean = first.authority == second.authority &&
    DocumentsContract.isTreeUri(first) && DocumentsContract.isTreeUri(second) &&
    DocumentsContract.getTreeDocumentId(first) == DocumentsContract.getTreeDocumentId(second)

  private fun directoryId(albumId: String): String {
    require(albumId.startsWith("saf-folder:")) { "Invalid selected directory identifier" }
    return UUID.fromString(albumId.removePrefix("saf-folder:")).toString()
  }

  private fun parseIdentity(assetId: String): Identity {
    val parts = assetId.split(':')
    require(parts.size in 5..6 && parts[0] == "saf-file") { "Invalid selected file identifier" }
    val authority = String(Base64.decode(parts[1], BASE64_FLAGS), Charsets.UTF_8)
    require(authority.isNotBlank() && parts[1] == Base64.encodeToString(authority.toByteArray(Charsets.UTF_8), BASE64_FLAGS))
    val documentId = String(Base64.decode(parts[2], BASE64_FLAGS), Charsets.UTF_8)
    require(documentId.isNotEmpty() && parts[2] == Base64.encodeToString(documentId.toByteArray(Charsets.UTF_8), BASE64_FLAGS))
    val modifiedAt = parts[3].toLong().also { require(it >= 0) }.takeIf { it > 0 }
    val size = parts[4].toLong().also { require(it >= -1) }.takeIf { it >= 0 }
    val fingerprint = parts.getOrNull(5)
    require(fingerprint == null || fingerprint.matches(Regex("[a-f0-9]{40}")))
    require(modifiedAt != null && size != null || fingerprint != null) { "Selected file has no stable version" }
    return Identity(authority, documentId, modifiedAt, size, fingerprint)
  }

  private fun assetType(name: String): Long? {
    val extension = name.substringAfterLast('.', "").lowercase()
    return when {
      extension in imageExtensions -> 1L
      extension in videoExtensions -> 2L
      AudioSyncPolicy.supports(name) -> 3L
      else -> null
    }
  }

  private fun supportedMedia(document: Document): SupportedMedia? {
    val type = assetType(document.name)
    if (type != null) return SupportedMedia(type, document.name)
    if (document.name.lastIndexOf('.') > 0 && !document.name.endsWith('.')) return null
    val mimeType = document.mimeType.substringBefore(';').trim().lowercase()
    val extension = mimeExtensions[mimeType] ?: return null
    val name = "${document.name.trimEnd('.').ifBlank { "media" }}.$extension"
    return assetType(name)?.let { SupportedMedia(it, name) }
  }

  companion object {
    private val preferencesLock = Any()
    private val BASE64_FLAGS = Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING
    private val localAuthorities = setOf(
      "com.android.externalstorage.documents", "com.android.providers.downloads.documents", "com.android.providers.media.documents"
    )
    private val projection = arrayOf(
      DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      DocumentsContract.Document.COLUMN_DISPLAY_NAME,
      DocumentsContract.Document.COLUMN_MIME_TYPE,
      DocumentsContract.Document.COLUMN_LAST_MODIFIED,
      DocumentsContract.Document.COLUMN_SIZE,
      DocumentsContract.Document.COLUMN_FLAGS
    )
    private val mimeExtensions = mapOf(
      "image/avif" to "avif", "image/bmp" to "bmp", "image/gif" to "gif", "image/jpeg" to "jpg",
      "image/png" to "png", "image/apng" to "png", "image/webp" to "webp", "image/heic" to "heic",
      "image/heif" to "heif", "image/hif" to "hif", "image/jp2" to "jp2", "image/jxl" to "jxl",
      "image/tiff" to "tiff", "image/svg+xml" to "svg", "image/svg" to "svg",
      "image/vnd.adobe.photoshop" to "psd", "image/x-adobe-dng" to "dng", "image/dng" to "dng",
      "image/x-canon-cr2" to "cr2", "image/cr2" to "cr2", "image/x-canon-cr3" to "cr3", "image/cr3" to "cr3",
      "image/x-nikon-nef" to "nef", "image/nef" to "nef", "image/x-sony-arw" to "arw", "image/arw" to "arw",
      "video/3gpp" to "3gp", "video/avi" to "avi", "video/msvideo" to "avi", "video/vnd.avi" to "avi",
      "video/x-msvideo" to "avi", "video/x-flv" to "flv", "video/mp2t" to "ts", "video/x-m4v" to "m4v",
      "video/x-matroska" to "mkv", "video/quicktime" to "mov", "video/mp4" to "mp4", "video/mpeg" to "mpeg",
      "application/mxf" to "mxf", "video/webm" to "webm", "video/x-ms-wmv" to "wmv",
      "audio/aac" to "aac", "audio/aiff" to "aiff", "audio/x-aiff" to "aiff", "audio/amr" to "amr",
      "audio/x-caf" to "caf", "audio/flac" to "flac", "audio/mp4" to "m4a", "audio/x-m4a" to "m4a",
      "audio/mpeg" to "mp3", "audio/mp3" to "mp3", "audio/ogg" to "ogg", "audio/opus" to "opus",
      "audio/wav" to "wav", "audio/x-wav" to "wav", "audio/wave" to "wav", "audio/x-ms-wma" to "wma"
    )
    private val imageExtensions = setOf(
      "3fr", "ari", "arw", "cap", "cin", "cr2", "cr3", "crw", "dcr", "dng", "erf", "fff", "iiq", "k25", "kdc",
      "mrw", "nef", "nrw", "orf", "ori", "pef", "psd", "raf", "raw", "rw2", "rwl", "sr2", "srf", "srw", "x3f",
      "avif", "bmp", "gif", "jfif", "jpeg", "jpg", "png", "webp", "heic", "heif", "hif", "insp", "jp2", "jpe", "jxl",
      "mpo", "svg", "tif", "tiff"
    )
    private val videoExtensions = setOf(
      "3gp", "3gpp", "avi", "flv", "insv", "m2t", "m2ts", "m4v", "mkv", "mov", "mp4", "mpe", "mpeg", "mpg", "mts",
      "mxf", "ts", "vob", "webm", "wmv"
    )
  }
}
