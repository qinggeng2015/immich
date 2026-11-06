# Supported Media Formats

Immich supports a number of image, video, and audio formats, the most common of which are outlined here.

:::note
For the full list, refer to the [Immich source code](https://github.com/immich-app/immich/blob/main/server/src/utils/mime-types.ts).
:::

## Image formats

| Format      | Extension(s)                          |     Supported?     | Notes           |
| :---------- | :------------------------------------ | :----------------: | :-------------- |
| `AVIF`      | `.avif`                               | :white_check_mark: |                 |
| `BMP`       | `.bmp`                                | :white_check_mark: |                 |
| `GIF`       | `.gif`                                | :white_check_mark: |                 |
| `HEIC`      | `.heic`                               | :white_check_mark: |                 |
| `HEIF`      | `.heif`                               | :white_check_mark: |                 |
| `JPEG 2000` | `.jp2`                                | :white_check_mark: |                 |
| `JPEG`      | `.jfif` `.jpeg` `.jpg` `.jpe` `.insp` | :white_check_mark: |                 |
| `JPEG XL`   | `.jxl`                                | :white_check_mark: |                 |
| `MPO`       | `.mpo`                                | :white_check_mark: | Multi-Picture   |
| `PNG`       | `.png`                                | :white_check_mark: |                 |
| `PSD`       | `.psd`                                | :white_check_mark: | Adobe Photoshop |
| `RAW`       | `.raw`                                | :white_check_mark: |                 |
| `RW2`       | `.rw2`                                | :white_check_mark: |                 |
| `SVG`       | `.svg`                                | :white_check_mark: |                 |
| `TIFF`      | `.tif` `.tiff`                        | :white_check_mark: |                 |
| `WEBP`      | `.webp`                               | :white_check_mark: |                 |

## Video formats

| Format      | Extension(s)                |     Supported?     | Notes |
| :---------- | :-------------------------- | :----------------: | :---- |
| `3GPP`      | `.3gp` `.3gpp`              | :white_check_mark: |       |
| `AVI`       | `.avi`                      | :white_check_mark: |       |
| `FLV`       | `.flv`                      | :white_check_mark: |       |
| `M4V`       | `.m4v`                      | :white_check_mark: |       |
| `MATROSKA`  | `.mkv`                      | :white_check_mark: |       |
| `MP2T`      | `.mts` `.m2ts` `.m2t` `.ts` | :white_check_mark: |       |
| `MP4`       | `.mp4` `.insv`              | :white_check_mark: |       |
| `MPEG`      | `.mpg` `.mpe` `.mpeg`       | :white_check_mark: |       |
| `MXF`       | `.mxf`                      | :white_check_mark: |       |
| `QUICKTIME` | `.mov`                      | :white_check_mark: |       |
| `WEBM`      | `.webm`                     | :white_check_mark: |       |
| `WMV`       | `.wmv`                      | :white_check_mark: |       |

## Audio formats

This fork supports `.aac`, `.aif`, `.aiff`, `.alac`, `.amr`, `.caf`, `.flac`, `.m4a`, `.m4b`, `.mp3`, `.oga`, `.ogg`, `.opus`, `.wav`, and `.wma`.

Original files are preserved for downloading. The server creates an AAC audio stream in an MP4 container for playback across the web and mobile apps. Playback may require processing to finish first. Audio thumbnails display a play icon and duration. Audio is excluded from face recognition, OCR, visual search, and visual duplicate detection.

To find audio by name, select the audio media type and use filename search. Description and other metadata filters can also narrow the results. On Android, downloaded audio is saved in `Music/Immich`. On iOS, use the sharing menu to save audio to Files.

Audio also supports [waveform playback and speech transcription](/features/audio-analysis), with separate background queues and transcript search.

Audio uploads require a server that advertises audio support. Updated clients connected to older servers continue backing up images and videos and skip audio. Older clients connected to this fork receive compatible asset types; their timeline excludes audio.
