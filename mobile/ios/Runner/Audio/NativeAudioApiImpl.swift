import Flutter
import UIKit
import UniformTypeIdentifiers

final class NativeAudioApiImpl: NSObject, NativeAudioApi, UIDocumentPickerDelegate {
  private var pendingPick: ((Result<String?, Error>) -> Void)?

  func pickDirectory(completion: @escaping (Result<String?, Error>) -> Void) {
    guard pendingPick == nil else {
      completion(.failure(CocoaError(.userCancelled)))
      return
    }
    guard let scene = UIApplication.shared.connectedScenes.first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene,
          var presenter = scene.windows.first(where: \.isKeyWindow)?.rootViewController else {
      completion(.failure(CocoaError(.featureUnsupported)))
      return
    }
    while let presented = presenter.presentedViewController { presenter = presented }
    let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
    picker.allowsMultipleSelection = false
    picker.delegate = self
    pendingPick = completion
    presenter.present(picker, animated: true)
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    guard let completion = pendingPick else { return }
    pendingPick = nil
    do {
      let albumId = try urls.first.map { try AudioFolderStore.shared.addDirectory($0) }
      completion(.success(albumId))
    } catch {
      completion(.failure(error))
    }
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    pendingPick?(.success(nil))
    pendingPick = nil
  }

  func removeDirectory(albumId: String) throws {
    AudioFolderStore.shared.removeDirectory(albumId)
  }

  func getFile(assetId: String, completion: @escaping (Result<String, Error>) -> Void) {
    completion(Result { try AudioFolderStore.shared.exportFile(assetId) })
  }
}
