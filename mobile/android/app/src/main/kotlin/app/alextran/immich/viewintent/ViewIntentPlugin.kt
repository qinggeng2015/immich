package app.alextran.immich.viewintent

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Log
import android.webkit.MimeTypeMap
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.PluginRegistry
import java.io.File
import java.io.FileOutputStream
import java.util.Locale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

private const val TAG = "ViewIntentPlugin"

class ViewIntentPlugin : FlutterPlugin, ActivityAware, PluginRegistry.NewIntentListener, ViewIntentHostApi {
  private var context: Context? = null
  private var activity: Activity? = null
  private var unconsumedIntent: Intent? = null
  private val ioScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
    context = binding.applicationContext
    ViewIntentHostApi.setUp(binding.binaryMessenger, this)
  }

  override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
    ViewIntentHostApi.setUp(binding.binaryMessenger, null)
    ioScope.cancel()
    context = null
  }

  override fun onAttachedToActivity(binding: ActivityPluginBinding) {
    activity = binding.activity
    unconsumedIntent = binding.activity.intent
    binding.addOnNewIntentListener(this)
  }

  override fun onDetachedFromActivityForConfigChanges() {
    activity = null
  }

  override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) {
    onAttachedToActivity(binding)
  }

  override fun onDetachedFromActivity() {
    activity = null
  }

  override fun onNewIntent(intent: Intent): Boolean {
    unconsumedIntent = intent
    return false
  }

  override fun consumeViewIntent(callback: (Result<ViewIntentPayload?>) -> Unit) {
    val context = context ?: run {
      callback(Result.success(null))
      return
    }
    val intent = unconsumedIntent ?: activity?.intent

    if (intent?.action != Intent.ACTION_VIEW) {
      callback(Result.success(null))
      return
    }

    val uri = intent.data
    if (uri == null) {
      callback(Result.success(null))
      return
    }

    ioScope.launch {
      var tempFile: File? = null
      try {
        val mimeType = (context.contentResolver.getType(uri) ?: intent.type)
          ?.substringBefore(';')?.trim()?.lowercase(Locale.ROOT)
        val isAudio = mimeType?.startsWith("audio/") == true
        if (mimeType == null || (!mimeType.startsWith("image/") && !mimeType.startsWith("video/") && !isAudio)) {
          callback(Result.success(null))
          return@launch
        }
        if (isAudio && uri.scheme != "content") {
          callback(Result.success(null))
          return@launch
        }

        val localAssetId = if (isAudio) null else extractLocalAssetId(context, uri, mimeType)
        if (localAssetId == null) {
          tempFile = copyUriToTempFile(context, uri, mimeType) ?: run {
            callback(Result.success(null))
            return@launch
          }
        }
        currentCoroutineContext().ensureActive()
        if (unconsumedIntent != null && unconsumedIntent !== intent) {
          tempFile?.delete()
          callback(Result.success(null))
          return@launch
        }
        val payload = ViewIntentPayload(
          path = tempFile?.absolutePath,
          mimeType = mimeType,
          localAssetId = localAssetId,
        )
        consumeViewIntent(intent)
        callback(Result.success(payload))
      } catch (e: CancellationException) {
        tempFile?.delete()
        throw e
      } catch (e: Exception) {
        tempFile?.delete()
        callback(Result.failure(e))
      }
    }
  }

  private fun consumeViewIntent(currentIntent: Intent) {
    unconsumedIntent = Intent(currentIntent).apply {
      action = null
      data = null
      type = null
    }
    activity?.intent = unconsumedIntent
  }

  private fun extractLocalAssetId(context: Context, uri: Uri, mimeType: String): String? {
    return tryExtractDocumentLocalAssetId(context, uri)
      ?: tryParseContentUriId(uri)
      ?: resolveLocalIdByNameAndSize(context, uri, mimeType)
  }

  private fun tryExtractDocumentLocalAssetId(context: Context, uri: Uri): String? {
    return try {
      if (!DocumentsContract.isDocumentUri(context, uri)) return null
      val docId = DocumentsContract.getDocumentId(uri)
      if (docId.isBlank() || docId.startsWith("raw:")) return null
      docId.substringAfter(':', docId).toLongOrNull()?.toString()
    } catch (e: Exception) {
      Log.w(TAG, "Failed to resolve local asset id from document URI: $uri", e)
      null
    }
  }

  private fun tryParseContentUriId(uri: Uri): String? {
    val id = uri.lastPathSegment?.toLongOrNull() ?: return null
    return if (id >= 0) id.toString() else null
  }

  private suspend fun copyUriToTempFile(context: Context, uri: Uri, mimeType: String): File? {
    var tempFile: File? = null
    return try {
      val extension = MimeTypeMap.getSingleton().getExtensionFromMimeType(mimeType)?.let { ".$it" }
      context.contentResolver.openInputStream(uri)?.use { inputStream ->
        val outputFile = File.createTempFile("view_intent_", extension, context.cacheDir)
        tempFile = outputFile
        FileOutputStream(outputFile).use { outputStream ->
          val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
          while (true) {
            currentCoroutineContext().ensureActive()
            val count = inputStream.read(buffer)
            if (count == -1) break
            outputStream.write(buffer, 0, count)
          }
        }
      } ?: return null
      tempFile
    } catch (e: CancellationException) {
      tempFile?.delete()
      throw e
    } catch (_: Exception) {
      tempFile?.delete()
      null
    }
  }

  private fun resolveLocalIdByNameAndSize(context: Context, uri: Uri, mimeType: String): String? {
    val metaProjection = arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
    val (displayName, size) =
      try {
        context.contentResolver.query(uri, metaProjection, null, null, null)?.use { cursor ->
          if (!cursor.moveToFirst()) return null
          val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
          val name = if (nameIdx >= 0) cursor.getString(nameIdx) else null
          val bytes = if (sizeIdx >= 0) cursor.getLong(sizeIdx) else -1L
          if (name.isNullOrBlank() || bytes < 0) return null
          name to bytes
        } ?: return null
      } catch (_: Exception) {
        return null
      }

    val tableUri = when {
      mimeType.startsWith("image/") -> MediaStore.Images.Media.EXTERNAL_CONTENT_URI
      mimeType.startsWith("video/") -> MediaStore.Video.Media.EXTERNAL_CONTENT_URI
      else -> return null
    }
    return try {
      context.contentResolver
        .query(
          tableUri,
          arrayOf(MediaStore.MediaColumns._ID),
          "${MediaStore.MediaColumns.DISPLAY_NAME}=? AND ${MediaStore.MediaColumns.SIZE}=?",
          arrayOf(displayName, size.toString()),
          "${MediaStore.MediaColumns.DATE_MODIFIED} DESC",
        )?.use { cursor ->
          if (!cursor.moveToFirst()) return null
          val idIndex = cursor.getColumnIndex(MediaStore.MediaColumns._ID)
          if (idIndex < 0) return null
          cursor.getLong(idIndex).toString()
        }
    } catch (_: Exception) {
      null
    }
  }
}
