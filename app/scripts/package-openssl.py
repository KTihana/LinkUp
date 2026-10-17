# SPDX-License-Identifier: GPL-3.0-only
"""Build a deterministic Android Prefab AAR from official static OpenSSL output."""
import json
import pathlib
import sys
import zipfile

prefix, license_file, destination = map(pathlib.Path, sys.argv[1:4])
version = sys.argv[4]
entries = {
    "AndroidManifest.xml": b'<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="org.linkup.security.opensslstatic"><uses-sdk android:minSdkVersion="21" /></manifest>\n',
    "META-INF/LICENSE.txt": license_file.read_bytes(),
    "prefab/prefab.json": json.dumps({"name": "opensslstatic", "schema_version": 1, "dependencies": [], "version": version}, sort_keys=True).encode(),
}
headers = sorted(prefix.joinpath("include").rglob("*"))
for module in ("ssl", "crypto"):
    base = "prefab/modules/" + module
    entries[base + "/module.json"] = json.dumps({"export_libraries": [":crypto"]} if module == "ssl" else {}).encode()
    entries[base + "/libs/android.arm64-v8a/abi.json"] = json.dumps({"abi": "arm64-v8a", "api": 21, "ndk": 27, "stl": "c++_shared"}, sort_keys=True).encode()
    archive = prefix / "lib" / ("lib" + module + ".a")
    if not archive.is_file():
        archive = prefix / "lib64" / archive.name
    data = archive.read_bytes()
    if not data.startswith(b"!<arch>\n"):
        raise ValueError("Expected a static library archive")
    entries[base + "/libs/android.arm64-v8a/" + archive.name] = data
    for header in headers:
        if header.is_file():
            entries[base + "/include/" + str(header.relative_to(prefix / "include"))] = header.read_bytes()

with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as result:
    for name, data in sorted(entries.items()):
        info = zipfile.ZipInfo(name, date_time=(2026, 9, 29, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.create_system = 3
        info.external_attr = 0o100644 << 16
        result.writestr(info, data)
