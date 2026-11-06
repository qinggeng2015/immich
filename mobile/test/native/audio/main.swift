import Foundation

func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
  if try !condition() { throw NSError(domain: "AudioFileIdentityTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
}

func expectFailure(_ message: String, _ operation: () throws -> Void) throws {
  do {
    try operation()
  } catch {
    return
  }
  throw NSError(domain: "AudioFileIdentityTests", code: 2, userInfo: [NSLocalizedDescriptionKey: message])
}

let folderId = "9A56B862-CCB9-4CC2-BD32-95D5C0B97E32"
let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
let outside = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
defer {
  try? FileManager.default.removeItem(at: directory)
  try? FileManager.default.removeItem(at: outside)
}

let identity = try AudioFileIdentity(folderId: folderId, relativePath: "录音/voice #1:a.mp3", modifiedAt: Date(timeIntervalSince1970: 1_700_000_000.123456), size: 100)
let decoded = try AudioFileIdentity(assetId: identity.assetId)
try expect(decoded.relativePath == identity.relativePath, "Unicode, spaces and delimiters must round-trip")
try expect(decoded.assetId == identity.assetId, "Identity must round-trip exactly")
try expect(!decoded.isShared, "Legacy folder identities must remain supported")
let preciseId = "audio-file:\(folderId):dGVzdC5tcDM=:1700000000123457:100"
try expect(AudioFileIdentity(assetId: preciseId).assetId == preciseId, "Microsecond versions must not lose precision")
for path in ["", "/etc/passwd", "../recording.mp3", "folder/../../recording.mp3", "folder/./recording.mp3", "voice\0.mp3"] {
  try expectFailure("Unsafe paths must be rejected: \(path)") {
    _ = try AudioFileIdentity(folderId: folderId, relativePath: path, modifiedAt: Date(), size: 100)
  }
}
for assetId in ["", "audio-file:broken", "audio-file:\(folderId):!!:0:1", "audio-file:\(folderId):dGVzdC5tcDM=:0:-1"] {
  try expectFailure("Malformed IDs must be rejected") { _ = try AudioFileIdentity(assetId: assetId) }
}

try FileManager.default.createSymbolicLink(at: directory.appendingPathComponent("escape"), withDestinationURL: outside)
let linkIdentity = try AudioFileIdentity(folderId: folderId, relativePath: "escape/test.mp3", modifiedAt: Date(), size: 1)
try expectFailure("Symbolic links must not escape the selected folder") { _ = try linkIdentity.file(in: directory) }

let nestedDirectory = directory.appendingPathComponent("recordings", isDirectory: true)
try FileManager.default.createDirectory(at: nestedDirectory, withIntermediateDirectories: true)
let nestedFile = nestedDirectory.appendingPathComponent("voice.mp3")
try Data("nested audio".utf8).write(to: nestedFile)
let nestedValues = try nestedFile.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
let parentSelectionIdentity = try AudioFileIdentity(fileURL: directory.appendingPathComponent("recordings/voice.mp3"), modifiedAt: nestedValues.contentModificationDate!, size: nestedValues.fileSize!)
let childSelectionIdentity = try AudioFileIdentity(fileURL: nestedFile, modifiedAt: nestedValues.contentModificationDate!, size: nestedValues.fileSize!)
let sharedIdentity = try AudioFileIdentity(assetId: parentSelectionIdentity.assetId)
try expect(sharedIdentity.isShared, "New identities must be shared across selected folders")
try expect(parentSelectionIdentity.assetId == childSelectionIdentity.assetId, "Overlapping selections must identify the same source only once")
try expect(sharedIdentity.assetId == parentSelectionIdentity.assetId, "Shared identities must round-trip exactly")
try expect(sharedIdentity.file(in: directory) == nestedFile.resolvingSymlinksInPath(), "A parent selection must authorize a nested source")
try expect(sharedIdentity.file(in: nestedDirectory) == nestedFile.resolvingSymlinksInPath(), "The same identity must remain readable through the child selection")
try expectFailure("Shared sources must remain inside the selected folder") { _ = try sharedIdentity.file(in: outside) }
try expectFailure("Shared sources must not treat a filename as a selected directory") { _ = try sharedIdentity.file(in: nestedFile) }
try expectFailure("Shared identities must reject non-file URLs") {
  _ = try AudioFileIdentity(fileURL: URL(string: "https://example.com/voice.mp3")!, modifiedAt: Date(), size: 1)
}
let prefixDirectory = directory.appendingPathComponent("record", isDirectory: true)
try FileManager.default.createDirectory(at: prefixDirectory, withIntermediateDirectories: true)
try expectFailure("Directory containment must respect complete path components") { _ = try sharedIdentity.file(in: prefixDirectory) }
try FileManager.default.removeItem(at: nestedDirectory)
try Data("outside audio".utf8).write(to: outside.appendingPathComponent("voice.mp3"))
try FileManager.default.createSymbolicLink(at: nestedDirectory, withDestinationURL: outside)
try expectFailure("Shared identities must reject a replaced directory symlink") { _ = try sharedIdentity.file(in: directory) }

var file = directory.appendingPathComponent("test.mp3")
try Data("audio data".utf8).write(to: file)
let values = try file.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
let original = try AudioFileIdentity(folderId: folderId, relativePath: "test.mp3", modifiedAt: values.contentModificationDate!, size: values.fileSize!)
try expect(original.matches(file), "Unchanged source must be readable")
try expect(original.file(in: directory) == file, "Source must resolve under the authorized folder")
try Data("different audio".utf8).write(to: file)
try expect(!original.matches(file), "Replacing a recording must invalidate the old upload identity")
file.removeAllCachedResourceValues()
let replacement = try file.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
let updated = try AudioFileIdentity(folderId: folderId, relativePath: "test.mp3", modifiedAt: replacement.contentModificationDate!, size: replacement.fileSize!)
try expect(updated.assetId != original.assetId, "Replacement must be hashed and backed up again")
try FileManager.default.removeItem(at: file)
try expectFailure("Removed sources must fail cleanly") { _ = try original.matches(file) }
try expect(AudioFileIdentity.canReadContent(isUbiquitous: false, downloadingStatus: nil), "Device-local audio can be read without iCloud metadata")
try expect(AudioFileIdentity.canReadContent(isUbiquitous: true, downloadingStatus: .current), "Current local iCloud content can be backed up")
try expect(!AudioFileIdentity.canReadContent(isUbiquitous: true, downloadingStatus: .notDownloaded), "Cloud placeholders must not be fetched during scanning or hashing")
try expect(!AudioFileIdentity.canReadContent(isUbiquitous: true, downloadingStatus: .downloaded), "Outdated cloud content must wait for a current local copy")
try expect(!AudioFileIdentity.canReadContent(isUbiquitous: true, downloadingStatus: nil), "Unknown cloud availability must defer content reads")
print("AudioFileIdentity tests passed")
