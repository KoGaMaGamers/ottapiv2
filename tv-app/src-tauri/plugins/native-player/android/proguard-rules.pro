# Tauri's plugin runtime reflectively looks up @Command-annotated
# methods at runtime. Keep them so release minification can't strip
# out our startPlayer entry.
-keep class fr.smartbunker.symbioplayer.nativeplayer.NativePlayerPlugin { *; }
-keep class fr.smartbunker.symbioplayer.nativeplayer.PlayerActivity { *; }

# Media3 / ExoPlayer reflective surfaces.
-keep class androidx.media3.** { *; }
-dontwarn androidx.media3.**
