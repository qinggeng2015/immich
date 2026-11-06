import AVFoundation
import CryptoKit
import Foundation

final class AudioFolderStore {
  static let shared = AudioFolderStore()
  static let albumPrefix = "audio-folder:"
  static let assetPrefix = "audio-file:"
  private let bookmarkLock = NSRecursiveLock()
  private let defaults: UserDefaults
  private let bookmarkKey = "immich:audioFolderBookmarks"
  private let extensions: Set<String> = ["mp3", "m4a", "m4b", "aac", "flac", "wav", "ogg", "oga", "opus", "aif", "aiff", "wma", "caf", "alac", "amr"]

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
  }

  private var bookmarks: [String: Data] {
    bookmarkLock.lock()
    defer { bookmarkLock.unlock() }
    return defaults.dictionary(forKey: bookmarkKey) as? [String: Data] ?? [:]
  }

  var hasDirectories: Bool { !bookmarks.isEmpty }

  func addDirectory(_ url: URL) throws -> String {
    bookmarkLock.lock()
    defer { bookmarkLock.unlock() }
    guard url.startAccessingSecurityScopedResource() else {
      throw CocoaError(.fileReadNoPermission)
    }
    defer { url.stopAccessingSecurityScopedResource() }
    var entries = bookmarks
    for id in entries.keys {
      if let existing = try? resolveDirectory(id), existing.standardizedFileURL == url.standardizedFileURL {
        entries[id] = try url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
        defaults.set(entries, forKey: bookmarkKey)
        return Self.albumPrefix + id
      }
    }
    let id = UUID().uuidString
    entries[id] = try url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
    defaults.set(entries, forKey: bookmarkKey)
    defaults.set(url.lastPathComponent, forKey: bookmarkKey + id + ":name")
    return Self.albumPrefix + id
  }

  func removeDirectory(_ albumId: String) {
    bookmarkLock.lock()
    defer { bookmarkLock.unlock() }
    guard albumId.hasPrefix(Self.albumPrefix) else { return }
    let id = String(albumId.dropFirst(Self.albumPrefix.count))
    var entries = bookmarks
    entries.removeValue(forKey: id)
    defaults.set(entries, forKey: bookmarkKey)
    defaults.removeObject(forKey: bookmarkKey + id + ":name")
    defaults.removeObject(forKey: bookmarkKey + id + ":count")
  }

  private func resolveDirectory(_ id: String) throws -> URL {
    bookmarkLock.lock()
    defer { bookmarkLock.unlock() }
    guard let bookmark = bookmarks[id] else { throw CocoaError(.fileNoSuchFile) }
    var stale = false
    let url = try URL(resolvingBookmarkData: bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
    if stale, url.startAccessingSecurityScopedResource() {
      defer { url.stopAccessingSecurityScopedResource() }
      var entries = bookmarks
      entries[id] = try url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
      defaults.set(entries, forKey: bookmarkKey)
    }
    return url
  }

  func albums() -> [PlatformAlbum] {
    bookmarks.keys.sorted().map { id in
      let albumId = Self.albumPrefix + id
      let assets = try? assets(albumId)
      if let assets { defaults.set(assets.count, forKey: bookmarkKey + id + ":count") }
      return PlatformAlbum(
        id: albumId,
        name: defaults.string(forKey: bookmarkKey + id + ":name") ?? albumId,
        updatedAt: Int64(Date().timeIntervalSince1970),
        isCloud: false,
        assetCount: Int64(assets?.count ?? defaults.integer(forKey: bookmarkKey + id + ":count"))
      )
    }
  }

  func assets(_ albumId: String, since: Int64? = nil) throws -> [PlatformAsset] {
    let id = String(albumId.dropFirst(Self.albumPrefix.count))
    let directory = try resolveDirectory(id)
    guard directory.startAccessingSecurityScopedResource() else { throw CocoaError(.fileReadNoPermission) }
    defer { directory.stopAccessingSecurityScopedResource() }
    let keys: Set<URLResourceKey> = [.isRegularFileKey, .isSymbolicLinkKey, .creationDateKey, .contentModificationDateKey, .fileSizeKey, .isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey]
    var enumerationError: Error?
    guard let enumerator = FileManager.default.enumerator(
      at: directory,
      includingPropertiesForKeys: Array(keys),
      options: [.skipsHiddenFiles, .skipsPackageDescendants],
      errorHandler: { _, error in enumerationError = error; return false }
    ) else { throw CocoaError(.fileReadUnknown) }
    var result: [PlatformAsset] = []
    for case let file as URL in enumerator {
      try Task.checkCancellation()
      guard extensions.contains(file.pathExtension.lowercased()) else { continue }
      let values = try file.resourceValues(forKeys: keys)
      guard values.isRegularFile == true, values.isSymbolicLink != true else { continue }
      let rootPath = directory.resolvingSymlinksInPath().path + "/"
      guard file.resolvingSymlinksInPath().path.hasPrefix(rootPath) else { continue }
      let modified = values.contentModificationDate ?? values.creationDate ?? .distantPast
      if let since, Int64(modified.timeIntervalSince1970) <= since { continue }
      let identity = try AudioFileIdentity(fileURL: file, modifiedAt: modified, size: values.fileSize ?? 0)
      guard let authorizedFile = try? identity.file(in: directory) else { continue }
      let canReadContent = AudioFileIdentity.canReadContent(
        isUbiquitous: values.isUbiquitousItem == true,
        downloadingStatus: values.ubiquitousItemDownloadingStatus
      )
      let seconds = canReadContent ? AVURLAsset(url: authorizedFile).duration.seconds : 0
      result.append(PlatformAsset(
        id: identity.assetId,
        name: file.lastPathComponent,
        type: 3,
        createdAt: Int64((values.creationDate ?? modified).timeIntervalSince1970),
        updatedAt: Int64(modified.timeIntervalSince1970),
        durationMs: seconds.isFinite && seconds > 0 ? Int64(seconds * 1000) : 0,
        orientation: 0,
        isFavorite: false,
        adjustmentTime: Int64(modified.timeIntervalSince1970),
        playbackStyle: .unknown
      ))
    }
    if let enumerationError { throw enumerationError }
    return result.sorted { $0.id < $1.id }
  }

  private func withFile<T>(_ assetId: String, work: (URL) throws -> T) throws -> T {
    try Task.checkCancellation()
    let identity = try AudioFileIdentity(assetId: assetId)
    let folderIds = identity.isShared ? bookmarks.keys.sorted() : [identity.folderId]
    var lastError: Error = CocoaError(.fileReadNoPermission)
    for folderId in folderIds {
      try Task.checkCancellation()
      let directory: URL
      do {
        directory = try resolveDirectory(folderId)
      } catch {
        lastError = error
        continue
      }
      guard directory.startAccessingSecurityScopedResource() else {
        lastError = CocoaError(.fileReadNoPermission)
        continue
      }
      defer { directory.stopAccessingSecurityScopedResource() }
      let url: URL
      do {
        url = try identity.file(in: directory)
        guard try identity.matches(url) else { throw CocoaError(.fileReadUnknown) }
      } catch {
        lastError = error
        continue
      }
      return try work(url)
    }
    throw lastError
  }

  func exportFile(_ assetId: String) throws -> String {
    try Task.checkCancellation()
    return try withFile(assetId) { source in
      try Task.checkCancellation()
      let targetDirectory = FileManager.default.temporaryDirectory.appendingPathComponent("immich-audio", isDirectory: true).appendingPathComponent(UUID().uuidString, isDirectory: true)
      let destination = targetDirectory.appendingPathComponent(source.lastPathComponent)
      do {
        try FileManager.default.createDirectory(at: targetDirectory, withIntermediateDirectories: true)
        let coordinator = NSFileCoordinator()
        var coordinationError: NSError?
        var copyError: Error?
        coordinator.coordinate(readingItemAt: source, options: [], error: &coordinationError) { url in
          do {
            try Task.checkCancellation()
            let input = try FileHandle(forReadingFrom: url)
            defer { try? input.close() }
            guard FileManager.default.createFile(atPath: destination.path, contents: nil) else { throw CocoaError(.fileWriteUnknown) }
            let output = try FileHandle(forWritingTo: destination)
            defer { try? output.close() }
            while true {
              try Task.checkCancellation()
              guard let data = try input.read(upToCount: 1024 * 1024), !data.isEmpty else { break }
              try output.write(contentsOf: data)
            }
            try Task.checkCancellation()
          } catch {
            copyError = error
          }
        }
        if let coordinationError { throw coordinationError }
        if let copyError { throw copyError }
        try Task.checkCancellation()
        try withFile(assetId) { _ in () }
      } catch {
        try? FileManager.default.removeItem(at: targetDirectory)
        throw error
      }
      return destination.path
    }
  }

  func hash(_ assetId: String) -> HashResult? {
    do {
      try Task.checkCancellation()
      let path = try exportFile(assetId)
      defer { try? FileManager.default.removeItem(atPath: (path as NSString).deletingLastPathComponent) }
      let handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: path))
      defer { try? handle.close() }
      var hash = Insecure.SHA1()
      while true {
        try Task.checkCancellation()
        guard let data = try handle.read(upToCount: 1024 * 1024), !data.isEmpty else { break }
        hash.update(data: data)
      }
      try Task.checkCancellation()
      return HashResult(assetId: assetId, hash: Data(hash.finalize()).base64EncodedString())
    } catch is CancellationError {
      return nil
    } catch {
      return HashResult(assetId: assetId, error: error.localizedDescription)
    }
  }
}
