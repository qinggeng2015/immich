package app.alextran.immich.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioSyncPolicyTest {
  @Test
  fun granularAudioAccessDoesNotDependOnPhotoPermissionsOrLegacyStorage() {
    for (sdk in listOf(33, 34, 35, 36, 37)) {
      assertTrue(AudioSyncPolicy.hasAccess(sdk, false, true))
      assertTrue(AudioSyncPolicy.hasAccess(sdk, true, true))
      assertFalse(AudioSyncPolicy.hasAccess(sdk, true, false))
      assertFalse(AudioSyncPolicy.hasAccess(sdk, false, false))
    }
  }

  @Test
  fun olderAndroidUsesExistingStoragePermission() {
    for (sdk in listOf(26, 29, 30, 32)) {
      assertTrue(AudioSyncPolicy.hasAccess(sdk, true, false))
      assertFalse(AudioSyncPolicy.hasAccess(sdk, false, true))
    }
  }

  @Test
  fun deniedAudioUsesTheExistingPhotoVideoQueryAndSelectsNoAudio() {
    val selection = AudioSyncPolicy.mediaSelection("media_type", 1, 3, 2, false)
    assertEquals("(media_type = ? OR media_type = ?)", selection.sql)
    assertEquals(listOf("1", "3"), selection.arguments)
    val audio = AudioSyncPolicy.audioSelection("media_type", 2, false)
    assertEquals("1 = 0", audio.sql)
    assertTrue(audio.arguments.isEmpty())
  }

  @Test
  fun grantingAudioAddsItsMediaTypeWithoutRemovingImagesOrVideo() {
    val before = AudioSyncPolicy.mediaSelection("media_type", 1, 3, 2, false)
    val after = AudioSyncPolicy.mediaSelection("media_type", 1, 3, 2, true)
    assertEquals(before.arguments, after.arguments.take(2))
    assertEquals(listOf("1", "3", "2"), after.arguments)
    assertEquals(after.arguments.size, after.sql.count { it == '?' })
    assertEquals(listOf("2"), AudioSyncPolicy.audioSelection("media_type", 2, true).arguments)
  }

  @Test
  fun grantRevokeAndRegainForceRescans() {
    var previousAccess = false
    for (access in listOf(true, false, true)) {
      assertTrue(AudioSyncPolicy.requiresFullSync(AudioSyncPolicy.VERSION, previousAccess, access))
      previousAccess = access
      assertFalse(AudioSyncPolicy.requiresFullSync(AudioSyncPolicy.VERSION, previousAccess, access))
    }
  }

  @Test
  fun firstUpgradeRescansOldCheckpointsEvenWithoutAnyNewMedia() {
    for (access in listOf(false, true)) {
      assertTrue(AudioSyncPolicy.requiresFullSync(0, access, access))
      assertFalse(AudioSyncPolicy.requiresFullSync(AudioSyncPolicy.VERSION, access, access))
    }
  }

  @Test
  fun supportedAudioFormatsIncludeUppercaseAndExcludeUnrelatedFiles() {
    for (extension in listOf("aac", "aif", "aiff", "alac", "amr", "caf", "flac", "m4a", "m4b", "mp3", "oga", "ogg", "opus", "wav", "wma")) {
      assertTrue(extension, AudioSyncPolicy.supports("recording.$extension"))
      assertTrue(extension, AudioSyncPolicy.supports("录音.2026.${extension.uppercase()}"))
    }
    for (name in listOf("image.jpg", "video.mp4", "recording.mid", "recording", ".mp3", "recording.mp3.tmp")) {
      assertFalse(name, AudioSyncPolicy.supports(name))
    }
  }
}
