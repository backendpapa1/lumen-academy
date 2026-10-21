package academy.lumen.app

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

@InvokeArg
class SaveSetupArgs {
  var openai: String? = null
  var deepseek: String? = null
}

@InvokeArg
class TestKeyArgs {
  lateinit var provider: String
  var key: String? = null
}

@InvokeArg
class UrlArgs {
  lateinit var url: String
}

@InvokeArg
class ChannelArgs {
  var channel: String = "voice"
}

@InvokeArg
class ListenStopArgs {
  var cancel: Boolean = false
}

/**
 * The "lumen" plugin (ADR-012), registered from src/mobile.rs. It owns the
 * window's pages (loading → configurator → game), the server (LumenRuntime),
 * the keys (Keys), the foreground service (LumenService) and speech (Speech).
 */
@TauriPlugin(
  permissions = [Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = "microphone")],
)
class LumenPlugin(private val activity: Activity) : Plugin(activity) {
  private val main = Handler(Looper.getMainLooper())
  private var webView: WebView? = null
  private var page = "loading" // "loading" | "configurator" | "game"
  /** After saving keys, go to the game as soon as the server is back. */
  private var gameWhenReady = true
  private val speech = Speech(activity.applicationContext) { e -> toPage(e) }
  private val ctx get() = activity.applicationContext

  private val onRuntime: (LumenRuntime.Event) -> Unit = { e ->
    main.post {
      when (e) {
        is LumenRuntime.Event.Progress -> js("window.lumenProgress && window.lumenProgress(${e.json()})")
        is LumenRuntime.Event.Running -> if (page == "loading" || gameWhenReady) showGame()
        is LumenRuntime.Event.Failed ->
          if (page != "configurator") {
            showLocal("index.html")
            main.postDelayed({ js("window.lumenFailed && window.lumenFailed(${JSONObject.quote(e.message)})") }, 600)
          }
      }
    }
  }

  private fun LumenRuntime.Event.Progress.json() =
    JSONObject().put("stage", stage).put("percent", percent).toString()

  override fun load(webView: WebView) {
    this.webView = webView
    LumenRuntime.listeners += onRuntime
    LumenService.start(ctx)
    askForNotifications()
    val keysMissing = Keys.env(ctx).size < Keys.ALL.size
    if (LumenRuntime.running) {
      // A recreated activity: the server is already up; just show the game again.
      main.postDelayed({ showGame() }, 50)
    } else {
      LumenRuntime.ensureStarted(ctx)
      LumenRuntime.replay(onRuntime)
    }
    // A fresh install: the keys come first (the server unpacks meanwhile).
    if (keysMissing) {
      gameWhenReady = false
      main.postDelayed({ showLocal("configurator.html") }, 150)
    }
  }

  override fun onDestroy(activity: AppCompatActivity) {
    LumenRuntime.listeners -= onRuntime
    speech.destroy()
    super.onDestroy(activity)
  }

  override fun onResume(activity: AppCompatActivity) {
    super.onResume(activity)
    LumenService.start(ctx)
    // Back after a long while: Android may have stopped the server meanwhile.
    if (!LumenRuntime.running && LumenRuntime.status != "unpacking" && LumenRuntime.status != "starting") {
      if (page == "game") showLocal("index.html")
      LumenRuntime.ensureStarted(ctx)
    }
  }

  private fun askForNotifications() {
    if (Build.VERSION.SDK_INT >= 33 &&
      ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7)
    }
  }

  // --- pages ------------------------------------------------------------------------

  private fun showLocal(file: String) {
    page = if (file.startsWith("configurator")) "configurator" else "loading"
    webView?.loadUrl("http://tauri.localhost/$file")
  }

  private fun showGame() {
    val p = LumenRuntime.port
    if (!LumenRuntime.running || p == 0) return showLocal("index.html")
    page = "game"
    gameWhenReady = false
    val url = "http://127.0.0.1:$p/"
    if (webView?.url?.startsWith(url) != true) webView?.loadUrl(url)
  }

  private fun js(code: String) = main.post { webView?.evaluateJavascript(code, null) }

  /** Speech events to the game page, as `lumen-native` DOM events. */
  private fun toPage(e: JSONObject) =
    js("window.dispatchEvent(new CustomEvent('lumen-native',{detail:$e}))")

  // --- the configurator (the same commands as the desktop's, via src/mobile.rs) -------

  private fun keyView(name: String): JSObject {
    val v = Keys.get(ctx, name)
    return JSObject().put("set", v != null).put("hint", v?.let(Keys::hint)).put("storage", if (v != null) "keystore" else "none")
  }

  @Command
  fun getSetup(invoke: Invoke) {
    val data = LumenRuntime.dataDir(ctx)
    val version = ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: ""
    invoke.resolve(
      JSObject()
        .put("platform", "android")
        .put("openai", keyView(Keys.OPENAI))
        .put("deepseek", keyView(Keys.DEEPSEEK))
        .put("dataDir", data.path)
        .put("dataHasDb", File(data, "lumen.db").exists())
        .put("defaultDataDir", data.path)
        .put("autostart", false)
        .put("server", LumenRuntime.status)
        .put("version", version)
        .put("logPath", LumenRuntime.logFile(ctx).path)
        .put("logTail", LumenRuntime.logTail(ctx)),
    )
  }

  @Command
  fun saveSetup(invoke: Invoke) {
    val a = invoke.parseArgs(SaveSetupArgs::class.java)
    try {
      a.openai?.let { Keys.set(ctx, Keys.OPENAI, it) }
      a.deepseek?.let { Keys.set(ctx, Keys.DEEPSEEK, it) }
    } catch (e: Exception) {
      return invoke.reject("Couldn't save the keys: ${e.message}")
    }
    // The server reads its keys at start.
    gameWhenReady = Keys.env(ctx).size == Keys.ALL.size
    LumenRuntime.restart(ctx)
    invoke.resolve(JSObject().put("storage", "keystore"))
  }

  @Command
  fun testKey(invoke: Invoke) {
    val a = invoke.parseArgs(TestKeyArgs::class.java)
    val name = if (a.provider == "openai") Keys.OPENAI else Keys.DEEPSEEK
    val key = a.key?.trim()?.takeIf { it.isNotEmpty() } ?: Keys.get(ctx, name)
    if (key == null) return invoke.resolve(JSObject().put("ok", false).put("message", "Paste a key first."))
    val url = if (a.provider == "openai") "https://api.openai.com/v1/models" else "https://api.deepseek.com/models"
    Thread {
      // Listing the provider's models: a free call, no tokens.
      val (ok, message) = try {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 12_000
        c.readTimeout = 12_000
        c.setRequestProperty("Authorization", "Bearer $key")
        val code = c.responseCode
        c.disconnect()
        when (code) {
          in 200..299 -> true to "That key works."
          401, 403 -> false to "The provider refused that key. Check you copied all of it."
          else -> false to "The provider answered $code. Try again in a minute."
        }
      } catch (e: Exception) {
        false to "Couldn't reach the provider: ${e.message}"
      }
      invoke.resolve(JSObject().put("ok", ok).put("message", message))
    }.start()
  }

  @Command
  fun openConfigurator(invoke: Invoke) {
    main.post { showLocal("configurator.html") }
    invoke.resolve()
  }

  /** The configurator's Close: back to the game (or the loading page while it starts). */
  @Command
  fun openGame(invoke: Invoke) {
    main.post {
      gameWhenReady = true
      if (LumenRuntime.running) showGame() else showLocal("index.html")
    }
    invoke.resolve()
  }

  @Command
  fun openUrl(invoke: Invoke) {
    val a = invoke.parseArgs(UrlArgs::class.java)
    if (!a.url.startsWith("https://")) return invoke.reject("Only web links open from here.")
    activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(a.url)))
    invoke.resolve()
  }

  // --- speech (A5) --------------------------------------------------------------------

  @Command
  fun speak(invoke: Invoke) {
    speech.speak(JSONObject(invoke.getRawArgs()))
    invoke.resolve()
  }

  @Command
  fun stopSpeaking(invoke: Invoke) {
    speech.stop(invoke.parseArgs(ChannelArgs::class.java).channel)
    invoke.resolve()
  }

  @Command
  fun voices(invoke: Invoke) {
    speech.voices { list -> invoke.resolve(JSObject().put("voices", list)) }
  }

  @Command
  fun listenStart(invoke: Invoke) {
    if (getPermissionState("microphone") != PermissionState.GRANTED) {
      requestPermissionForAlias("microphone", invoke, "microphoneAnswered")
      return
    }
    startListening(invoke)
  }

  @PermissionCallback
  fun microphoneAnswered(invoke: Invoke) {
    if (getPermissionState("microphone") == PermissionState.GRANTED) startListening(invoke)
    else invoke.reject("Lumen isn't allowed to use the microphone. You can allow it in Android's settings, or type.")
  }

  private fun startListening(invoke: Invoke) {
    main.post {
      val problem = speech.startListening()
      if (problem != null) invoke.reject(problem) else invoke.resolve()
    }
  }

  @Command
  fun listenStop(invoke: Invoke) {
    val a = invoke.parseArgs(ListenStopArgs::class.java)
    main.post {
      var answered = false
      speech.stopListening(a.cancel) { text ->
        if (!answered) {
          answered = true
          invoke.resolve(JSObject().put("text", text))
        }
      }
      // The recognizer can take a moment for its last words; don't wait forever.
      main.postDelayed({ if (!answered) speech.flush() }, 6000)
    }
  }
}
