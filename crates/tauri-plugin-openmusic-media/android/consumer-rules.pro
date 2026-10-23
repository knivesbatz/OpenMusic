# window.OpenMusicMedia (page → notification) is called from JavaScript by name.
-keepclassmembers class app.openmusic.media.MediaPlugin$PageBridge {
    @android.webkit.JavascriptInterface <methods>;
}
