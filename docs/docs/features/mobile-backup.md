---
sidebar_position: 1
---

# Mobile Backup

## Overview

Immich supports uploading photos, videos, and supported audio files from your mobile device to the server automatically.

When backup is enabled, Immich will upload new files from selected albums and directories when you open or resume the app, as well as periodically in the background. Audio backup requires the app and server versions described below.

<img
src={require('./img/enable-backup-button.webp').default}
width="400px"
title="Upload button"
/>

## General Features

### Backup albums selection

<img
src={require('./img/backup-album-selection.webp').default}
width="400px"
title="Backup album selection"
/>

You can select which albums on your mobile device to back up to the server. You can also exclude specific albums (by double-tapping on them) from being backed up. This is useful for iOS users since assets can belong to multiple albums. For example, you may want to back up all assets except those in the "Videos" album.

### Audio backup

Audio backup requires both an updated mobile app and a server with audio support. Audio files use the same checksum-based deduplication as photos and videos. Audio uploads use Wi-Fi by default; you can enable **Use cellular data to back up audio** under **Network requirements** in backup settings.

On Android, use **Choose another directory** in the backup album selection page to choose a folder with the system file manager. The selected folder appears alongside the existing device albums and can back up supported photos, videos, and audio files in that folder and its subfolders. Only folders explicitly selected through the file manager are scanned this way. Android controls which folders can be selected. Removing a directory from the backup list does not delete its original files or existing server backups.

On iOS, use **Audio backup folder** in backup settings to choose a folder in Files. The selected folder and its subfolders are scanned for supported audio files. Keep the folder accessible to Immich; removing access prevents further uploads from it. iOS controls when background work runs, so opening or resuming the app also scans for changes. Removing a selected folder does not delete already uploaded files from the server.

iCloud files must have a current local copy in Files. Cloud-only or outdated copies remain pending until downloaded; scanning does not download them automatically.

### Deduplication

When you first select albums for backup, Immich calculates a checksum for each file's content. This checksum identifies assets already on the server—whether uploaded via CLI, web interface, or another device. Files matching existing assets are skipped, preventing duplicate uploads and saving bandwidth.

### Networking requirements

By default, Immich will only upload photos, videos, and audio when connected to Wi-Fi. The backup settings page has separate cellular-data switches for each media type.

<img
src={require('./img/backup-options.webp').default}
width="400px"
title="Upload button"
/>

### Backup album synchronization

<img
src={require('./img/backup-album-sync.webp').default}
width="400px"
title="Backup album synchronization option"
/>

When enabled, Immich automatically creates albums on the server that mirror the albums on your mobile device. Photos and videos are organized into these server-side albums to match your device's album structure, making it easy to find and browse your content the same way you do on your phone.

This is a one-way sync from your device to the server. You can enable this feature at any time and use the **Reorganize into album** button to backfill existing uploads into their corresponding albums.

## Platform Specific Features

### Android

<img
src={require('./img/android-backup-options.webp').default}
width="400px"
title="Android backup options"
/>

- It is a well-known problem that some Android models are very strict with battery optimization settings, which can cause a problem with the background worker. Please visit [Don't kill my app](https://dontkillmyapp.com/) for a guide on disabling this setting on your phone.
- You can allow the background task to run only when the device is charging.
- You can set the minimum delay from the time a photo is taken to when the background upload task will run.

### iOS

- You must enable **Background App Refresh** for the app to work in the background. You can enable it in the Settings app under General > Background App Refresh.

<div style={{textAlign: 'center'}}>
<img src={require('./img/background-app-refresh.webp').default} width="30%" title="background-app-refresh" />
</div>

- iOS automatically manages background tasks; the app cannot control when the background upload task will run. The more frequently you open the app, the more often background tasks will run.

#### iCloud Backup

Local albums containing assets from iCloud and marked for backup in Immich will be pulled from iCloud and temporarily stored in the app's cache folder. Once the hashing and uploading process is completed, the temporary files will be emptied.

This process may consume additional data and storage space on your device, especially if you have a large number of iCloud photos and videos. Please ensure you have sufficient storage space and monitor your data usage if you are not connected to Wi-Fi.
