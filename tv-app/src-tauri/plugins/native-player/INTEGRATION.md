# Native Player Plugin — Android Integration

The Tauri CLI auto-generates `gen/android/tauri.settings.gradle` and
`gen/android/app/tauri.build.gradle.kts` from crates.io dependencies only.
Local path plugins (like this one) are **not** auto-discovered, so after
every `cargo tauri android init` you must manually wire the plugin into
the Gradle build.

Both files below land in `gen/android/`, which is gitignored. Re-apply
each time the Android project is regenerated.

## After `cargo tauri android init`

### 1. `gen/android/settings.gradle` — add the plugin subproject

```groovy
// Local Tauri plugin — native ExoPlayer wrapper
include ':tauri-plugin-native-player'
project(':tauri-plugin-native-player').projectDir = new File("../../plugins/native-player/android")
```

### 2. `gen/android/app/build.gradle.kts` — add the dependency

Inside the `dependencies { }` block:

```kotlin
implementation(project(":tauri-plugin-native-player"))
```

That's it — the auto-generated `MainActivity.kt` is fine as-is. Hardware
back is owned by `lib/hardwareBack.ts` via Tauri's
[`onBackButtonPress`](https://v2.tauri.app/reference/javascript/api/namespaceapp/#onbackbuttonpress)
API (Tauri 2.9+); no Activity-level override is needed.

## Historical note

Earlier integrations of this plugin (commits `1e44f9e`, `50960b4`,
`cf8ac9f`, `1d8b35a`) included a custom `MainActivity.kt` template
that overrode Tauri's `handleBackNavigation`, plus a debounce-based
hardware-back interception in `lib/hardwareBack.ts`. Both were
replaced in `2f291f5` once we discovered Tauri's built-in
`onBackButtonPress` cleanly suppresses the duplicate-fire pattern at
the framework layer. The template / debounce code can be considered
deprecated — if you find references in older branches or notes,
they're no longer the right pattern.
