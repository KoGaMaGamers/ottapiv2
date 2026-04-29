# Native Player Plugin — Android Integration

The Tauri CLI auto-generates `gen/android/tauri.settings.gradle` and
`gen/android/app/tauri.build.gradle.kts` from crates.io dependencies only.
Local path plugins (like this one) are **not** auto-discovered, so after
every `cargo tauri android init` you must manually wire the plugin into
the Gradle build.

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

Both files are gitignored, so these edits must be re-applied each time the
Android project is regenerated.
