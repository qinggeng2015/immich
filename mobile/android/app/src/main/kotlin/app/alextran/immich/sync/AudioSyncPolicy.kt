package app.alextran.immich.sync

object AudioSyncPolicy {
  const val VERSION = 3

  private val extensions = setOf("aac", "aif", "aiff", "alac", "amr", "caf", "flac", "m4a", "m4b", "mp3", "oga", "ogg", "opus", "wav", "wma")

  fun supports(name: String): Boolean {
    val separator = name.lastIndexOf('.')
    return separator > 0 && name.substring(separator + 1).lowercase() in extensions
  }

  fun hasAccess(sdk: Int, legacyPermission: Boolean, audioPermission: Boolean): Boolean =
    if (sdk >= 33) audioPermission else legacyPermission

  fun requiresFullSync(storedVersion: Int, storedAccess: Boolean, currentAccess: Boolean): Boolean =
    storedVersion != VERSION || storedAccess != currentAccess

  data class Selection(val sql: String, val arguments: List<String>)

  fun mediaSelection(column: String, imageType: Int, videoType: Int, audioType: Int, audioAccess: Boolean): Selection {
    val types = if (audioAccess) listOf(imageType, videoType, audioType) else listOf(imageType, videoType)
    return Selection(types.joinToString(" OR ", "(", ")") { "$column = ?" }, types.map(Int::toString))
  }

  fun audioSelection(column: String, audioType: Int, audioAccess: Boolean): Selection =
    if (audioAccess) Selection("$column = ?", listOf(audioType.toString())) else Selection("1 = 0", emptyList())
}
