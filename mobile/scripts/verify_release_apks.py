import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import zipfile

APPLICATION_ID = "app.alextran.immich.audio"
CERTIFICATE_SHA256 = "eb356e414b2f8e38b238b89b8a2ebb0b5d7ff56939f30e6b794408d9758284ed"
ABI_OFFSETS = {"armeabi-v7a": 1000, "arm64-v8a": 2000, "x86_64": 4000}


def capture(arguments):
    return subprocess.check_output(arguments, text=True, stderr=subprocess.STDOUT)


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def main():
    mobile = Path(__file__).resolve().parents[1]
    source = mobile / "build/app/outputs/flutter-apk"
    destination = mobile / "build/release-apks"
    sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    require(sdk, "ANDROID_HOME or ANDROID_SDK_ROOT is required")
    build_tools = Path(sdk) / "build-tools/36.0.0"
    build_number = os.environ.get("AUDIO_BUILD_NUMBER", "")
    require(re.fullmatch(r"[0-9]+", build_number), "AUDIO_BUILD_NUMBER must be numeric")
    expected_base_version = int(build_number)
    require(3040000 <= expected_base_version <= 2100000000, "Invalid base version code")
    require(
        not destination.exists() or not any(destination.iterdir()),
        "Release destination must be empty",
    )
    destination.mkdir(parents=True, exist_ok=True)
    assets = []
    for abi, offset in ABI_OFFSETS.items():
        apk = source / f"app-{abi}-release.apk"
        require(apk.is_file(), f"Missing APK for {abi}")
        badging = capture([str(build_tools / "aapt"), "dump", "badging", str(apk)])
        package = re.search(
            r"^package: name='([^']+)' versionCode='(\d+)' versionName='([^']*)'",
            badging,
            re.MULTILINE,
        )
        require(package is not None, f"Missing package identity for {abi}")
        application_id, version_code, version_name = package.groups()
        require(application_id == APPLICATION_ID, f"Unexpected application ID for {abi}")
        require(
            int(version_code) == expected_base_version + offset,
            f"Unexpected version code for {abi}",
        )
        if abi == "arm64-v8a":
            require(int(version_code) >= 3042000, "ARM64 APK would downgrade the installed application")
        signature = capture(
            [str(build_tools / "apksigner"), "verify", "--verbose", "--print-certs", str(apk)]
        )
        certificates = re.findall(
            r"^Signer #\d+ certificate SHA-256 digest: ([0-9a-fA-F]+)$",
            signature,
            re.MULTILINE,
        )
        require(
            [certificate.lower() for certificate in certificates] == [CERTIFICATE_SHA256],
            f"Signing certificate mismatch for {abi}",
        )
        with zipfile.ZipFile(apk) as archive:
            native_abis = {
                name.split("/")[1]
                for name in archive.namelist()
                if name.startswith("lib/") and name.endswith(".so")
            }
        require(native_abis == {abi}, f"Unexpected native library ABIs for {abi}")
        target = destination / f"immich-audio-{abi}.apk"
        shutil.copyfile(apk, target)
        with target.open("rb") as stream:
            checksum = hashlib.file_digest(stream, "sha256").hexdigest()
        assets.append(
            {
                "file": target.name,
                "sha256": checksum,
                "bytes": target.stat().st_size,
                "applicationId": application_id,
                "versionCode": int(version_code),
                "versionName": version_name,
                "abi": abi,
                "certificateSha256": CERTIFICATE_SHA256,
            }
        )
    commit = capture(["git", "-C", str(mobile.parent), "rev-parse", "HEAD"]).strip()
    manifest = {
        "commit": commit,
        "applicationId": APPLICATION_ID,
        "signingIdentity": "Existing Immich Audio development signing certificate",
        "certificateSha256": CERTIFICATE_SHA256,
        "assets": assets,
    }
    (destination / "android-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (destination / "SHA256SUMS-android").write_text(
        "".join(f"{asset['sha256']}  {asset['file']}\n" for asset in assets)
    )
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
