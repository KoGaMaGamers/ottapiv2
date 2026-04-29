# Native Player Plugin — Android Integration

The Tauri CLI auto-generates `gen/android/tauri.settings.gradle` and
`gen/android/app/tauri.build.gradle.kts` from crates.io dependencies only.
Local path plugins (like this one) are **not** auto-discovered, so after
every `cargo tauri android init` you must manually wire the plugin into
the Gradle build.

The host `MainActivity.kt` also needs to be replaced with our customised
version that disables Tauri's default hardware-back handling — without
it, hardware back fires at two layers and overshoots the SPA route /
exits the app. See `templates/MainActivity.kt` for the canonical version.

All edits below land in `gen/android/`, which is gitignored. Re-apply
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

### 3. `gen/android/app/src/main/java/fr/smartbunker/symbioplayer/MainActivity.kt` — replace with our version

Copy the contents of `plugins/native-player/templates/MainActivity.kt`
verbatim over the auto-generated MainActivity.

The override disables Tauri's `handleBackNavigation` and adds a no-op
`OnBackPressedCallback`, making the JS layer (`lib/hardwareBack.ts`)
the single source of truth for back gestures — see the comment block
in the template for the full rationale.

If your Tauri version exposes `WryActivity` instead of `TauriActivity`
in the auto-generated MainActivity, change the parent class accordingly;
both expose the same `open val handleBackNavigation` to override.

### 4. (Optional sanity check) `gen/android/app/src/main/AndroidManifest.xml`

Confirm the `<activity android:name=".MainActivity">` block has at minimum:

```xml
android:configChanges="keyboardHidden|orientation|screenSize|smallestScreenSize|screenLayout|uiMode|navigation|keyboard"
android:screenOrientation="landscape"
```

The `configChanges` set prevents the host Activity from being recreated
when the native PlayerActivity finishes (orientation/screen-size
transitions during the close animation), which would otherwise trigger
a webview reload and reset the SPA route to /home. Landscape lock is
defence-in-depth for TV.
