import Foundation

struct AudioFileIdentity {
  enum InvalidIdentity: Error { case malformed, outsideDirectory }

  private static let sharedFolderId = "00000000-0000-0000-0000-000000000000"

  let folderId: String
  let relativePath: String
  let modifiedMicroseconds: Int64
  let size: Int

  var isShared: Bool { folderId == Self.sharedFolderId }

  init(fileURL: URL, modifiedAt: Date, size: Int) throws {
    guard fileURL.isFileURL else { throw InvalidIdentity.malformed }
    let path = fileURL.standardizedFileURL.resolvingSymlinksInPath().path
    try self.init(folderId: Self.sharedFolderId, relativePath: String(path.dropFirst()), modifiedAt: modifiedAt, size: size)
  }

  init(folderId: String, relativePath: String, modifiedAt: Date, size: Int) throws {
    try self.init(folderId: folderId, relativePath: relativePath, modifiedMicroseconds: Int64(modifiedAt.timeIntervalSince1970 * 1_000_000), size: size)
  }

  private init(folderId: String, relativePath: String, modifiedMicroseconds: Int64, size: Int) throws {
    guard UUID(uuidString: folderId) != nil,
          !relativePath.isEmpty,
          !relativePath.hasPrefix("/"),
          !relativePath.contains("\0"),
          !relativePath.split(separator: "/").contains(where: { $0 == ".." || $0 == "." }),
          size >= 0 else { throw InvalidIdentity.malformed }
    self.folderId = folderId
    self.relativePath = relativePath
    self.modifiedMicroseconds = modifiedMicroseconds
    self.size = size
  }

  init(assetId: String) throws {
    let parts = assetId.split(separator: ":", omittingEmptySubsequences: false)
    guard parts.count == 5, parts[0] == "audio-file",
          let data = Data(base64Encoded: String(parts[2]).replacingOccurrences(of: "_", with: "/").replacingOccurrences(of: "-", with: "+")),
          let path = String(data: data, encoding: .utf8),
          let microseconds = Int64(parts[3]),
          let size = Int(parts[4]) else { throw InvalidIdentity.malformed }
    try self.init(folderId: String(parts[1]), relativePath: path, modifiedMicroseconds: microseconds, size: size)
  }

  var assetId: String {
    let encoded = Data(relativePath.utf8).base64EncodedString().replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "+", with: "-")
    return "audio-file:\(folderId):\(encoded):\(modifiedMicroseconds):\(size)"
  }

  func file(in directory: URL) throws -> URL {
    let root = directory.standardizedFileURL.resolvingSymlinksInPath()
    let rootPrefix = root.path == "/" ? "/" : root.path + "/"
    let path: String
    if isShared {
      let absolutePath = "/" + relativePath
      guard absolutePath.hasPrefix(rootPrefix), absolutePath != root.path else { throw InvalidIdentity.outsideDirectory }
      path = String(absolutePath.dropFirst(rootPrefix.count))
    } else {
      path = relativePath
    }
    var file = root
    for component in path.split(separator: "/") {
      file.appendPathComponent(String(component))
      let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
      guard attributes[.type] as? FileAttributeType != .typeSymbolicLink else { throw InvalidIdentity.outsideDirectory }
    }
    guard file.path.hasPrefix(rootPrefix), file.path != root.path else { throw InvalidIdentity.outsideDirectory }
    return file
  }

  static func canReadContent(isUbiquitous: Bool, downloadingStatus: URLUbiquitousItemDownloadingStatus?) -> Bool {
    !isUbiquitous || downloadingStatus == .current
  }

  func matches(_ url: URL) throws -> Bool {
    var freshURL = url
    freshURL.removeAllCachedResourceValues()
    let values = try freshURL.resourceValues(forKeys: [.isRegularFileKey, .contentModificationDateKey, .fileSizeKey, .isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey])
    guard values.isRegularFile == true,
          Self.canReadContent(isUbiquitous: values.isUbiquitousItem == true, downloadingStatus: values.ubiquitousItemDownloadingStatus),
          let modified = values.contentModificationDate else { return false }
    return Int64(modified.timeIntervalSince1970 * 1_000_000) == modifiedMicroseconds && values.fileSize == size
  }
}
