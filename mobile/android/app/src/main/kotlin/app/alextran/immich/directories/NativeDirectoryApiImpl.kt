package app.alextran.immich.directories

import android.app.Activity
import android.content.Context
import android.content.Intent
import app.alextran.immich.core.ImmichPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.PluginRegistry
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

class NativeDirectoryApiImpl(context: Context) : ImmichPlugin(), NativeDirectoryApi, ActivityAware,
  PluginRegistry.ActivityResultListener {
  private val store = SelectedDirectoryStore(context.applicationContext)
  private var activityBinding: ActivityPluginBinding? = null
  private var pendingPick: ((Result<String?>) -> Unit)? = null
  private val completionLock = Any()
  private val exportThreads = mutableSetOf<Thread>()
  private var closed = false

  override fun pickDirectory(callback: (Result<String?>) -> Unit) {
    val activity = activityBinding?.activity
    if (activity == null || pendingPick != null) {
      callback(Result.failure(IllegalStateException("Directory picker is unavailable")))
      return
    }
    pendingPick = callback
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
        Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
    }
    try {
      activity.startActivityForResult(intent, REQUEST_DIRECTORY)
    } catch (error: Exception) {
      pendingPick = null
      callback(Result.failure(error))
    }
  }

  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
    if (requestCode != REQUEST_DIRECTORY) return false
    val callback = pendingPick ?: return true
    pendingPick = null
    val uri = data?.data
    if (resultCode != Activity.RESULT_OK || uri == null) {
      completeWhenActive(callback, Result.success(null))
    } else {
      CoroutineScope(Dispatchers.IO).launch {
        val result = runCatching { store.addDirectory(uri) }
        withContext(Dispatchers.Main) { completeWhenActive(callback, result) }
      }
    }
    return true
  }

  override fun removeDirectory(albumId: String) = store.removeDirectory(albumId)

  override fun getUnavailableDirectoryIds(): List<String> = store.getUnavailableDirectoryIds()

  override fun getFile(assetId: String, callback: (Result<String>) -> Unit) {
    val thread = Thread.currentThread()
    synchronized(completionLock) {
      if (closed) return
      exportThreads.add(thread)
    }
    val result = runCatching { store.exportFile(assetId) }
    synchronized(completionLock) {
      exportThreads.remove(thread)
      if (closed) {
        result.getOrNull()?.let { File(it).delete() }
        Thread.interrupted()
      } else {
        completeWhenActive(callback, result)
      }
    }
  }

  fun close() {
    synchronized(completionLock) {
      closed = true
      exportThreads.forEach { it.interrupt() }
      detachFromEngine()
    }
  }

  override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
    super.onAttachedToEngine(binding)
    synchronized(completionLock) { closed = false }
  }

  override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
    close()
    super.onDetachedFromEngine(binding)
  }

  override fun onAttachedToActivity(binding: ActivityPluginBinding) {
    activityBinding = binding
    binding.addActivityResultListener(this)
  }

  override fun onDetachedFromActivityForConfigChanges() {
    activityBinding?.removeActivityResultListener(this)
    activityBinding = null
  }

  override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) = onAttachedToActivity(binding)

  override fun onDetachedFromActivity() {
    onDetachedFromActivityForConfigChanges()
    pendingPick?.let { completeWhenActive(it, Result.success(null)) }
    pendingPick = null
  }

  companion object {
    private const val REQUEST_DIRECTORY = 6174
  }
}
