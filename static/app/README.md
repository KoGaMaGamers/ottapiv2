# In-app APK auto-updater — release workflow

The native Android app (`com.ottplayer.app`, repo `appelungeek/ottapi`,
`tv_app_v2/`) checks this folder on launch and from
**Profile → Updates → Check for updates**. The client (`src/utils/appUpdater.js`)
fetches `version.json`, compares `versionCode` against the installed build, and
if newer downloads the APK in the background and prompts the user to install
(`src/components/UpdatePrompt.jsx`). Android always requires one user tap to
confirm the install ("install unknown apps" permission, granted once).

## Files served here (`/home/ottapi/static/` → `GET /static/app/...`)

| File | Purpose |
|------|---------|
| `version.json` | Update manifest the app polls. |
| `symbioplayer-latest.apk` | The signed release APK the manifest points at. |

## `version.json` schema

```json
{
  "versionCode": 2,                 // integer — MUST be > previous; the only field compared
  "versionName": "1.1",             // display string shown in the prompt / Profile
  "apkUrl": "https://ottapi.smartbunker.fr/static/app/symbioplayer-latest.apk",
  "mandatory": false,               // reserved (UI currently always allows "Later")
  "notes": "What changed in this build."
}
```

## Cutting a release

1. **Bump the version** in `tv_app_v2/android/app/build.gradle`:
   - `versionCode` → increment by 1 (this is what the updater compares).
   - `versionName` → human string (e.g. `1.1`).
2. **Build the web assets**: `cd tv_app_v2 && npm run build` (Capacitor copies `dist/`).
3. **Build a SIGNED release APK** with the **same release keystore** as every
   prior build — Android refuses to install an update signed with a different
   key. Example:
   ```bash
   npx cap sync android
   cd android
   ./gradlew assembleRelease            # uses the release signingConfig
   # → app/build/outputs/apk/release/app-release.apk
   ```
4. **Publish** on the server (`/home/ottapi`):
   ```bash
   cp app-release.apk /home/ottapi/static/app/symbioplayer-latest.apk
   # then edit version.json: bump versionCode/versionName + notes
   ```
   Keep `apkUrl` stable (`symbioplayer-latest.apk`) so only `version.json` changes
   per release, or version the filename and point `apkUrl` at it.
5. Existing installs see the update within one launch (auto-check) or immediately
   via **Profile → Updates → Check for updates**.

## Notes / gotchas

- **Signing key is forever.** Losing the release keystore means users must
  uninstall/reinstall to update. Back it up.
- `versionCode` is the *only* field compared — a higher `versionName` with the
  same `versionCode` will NOT trigger an update.
- The APK downloads to the app's external files dir and is shared to the system
  installer via `FileProvider` (`res/xml/file_paths.xml` → `apk_update`).
- Required permission already in the manifest:
  `android.permission.REQUEST_INSTALL_PACKAGES`.
