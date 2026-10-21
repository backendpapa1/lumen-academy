package academy.lumen.app

import android.content.Context
import android.net.ConnectivityManager
import android.os.Build
import android.util.Log
import org.json.JSONObject
import org.tukaani.xz.XZInputStream
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.URL
import java.util.TimeZone
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

/**
 * Lumen's Node server inside the app (ADR-012). One per process, so a recreated
 * activity (or a rotation) finds it already running instead of starting another.
 *
 * The runtime ships as assets/lumen-runtime.tar.xz (Node linux-arm64, Debian's
 * glibc, the server bundle) and is unpacked into files/runtime on first run, and
 * again whenever its stamp changes. Android only lets an app exec files from its
 * native library dir, so we exec two: libsigsys.so (a ptrace supervisor that turns
 * the app sandbox's seccomp traps into ENOSYS) and libld.so (glibc's loader), which
 * maps Node and every library from files/ (allowed: mmap, not exec).
 */
object LumenRuntime {
  private const val TAG = "LumenRuntime"

  sealed class Event {
    data class Progress(val stage: String, val percent: Int) : Event()
    data class Running(val port: Int) : Event()
    data class Failed(val message: String) : Event()
  }

  @Volatile var status: String = "not started"
    private set
  @Volatile var port: Int = 0
    private set
  /** From /api/health: "building", "class" or null. */
  @Volatile var busy: String? = null
    private set

  val listeners = CopyOnWriteArrayList<(Event) -> Unit>()
  private var lastEvent: Event? = null
  private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "lumen-server") }
  private var process: Process? = null
  @Volatile private var generation = 0
  private lateinit var app: Context

  fun filesDir(ctx: Context): File = ctx.applicationContext.filesDir
  fun runtimeDir(ctx: Context) = File(filesDir(ctx), "runtime")
  fun dataDir(ctx: Context) = File(filesDir(ctx), "data")
  fun logFile(ctx: Context) = File(File(filesDir(ctx), "logs"), "server.log")
  val running get() = status == "running"

  private fun emit(e: Event) {
    lastEvent = e
    for (l in listeners) runCatching { l(e) }
  }

  /** Tells a new listener where things stand (a recreated activity). */
  fun replay(l: (Event) -> Unit) {
    lastEvent?.let { runCatching { l(it) } }
  }

  /** Starts the server once; later calls do nothing while it runs or starts. */
  fun ensureStarted(ctx: Context) {
    app = ctx.applicationContext
    synchronized(this) {
      if (process != null || status == "unpacking" || status == "starting") return
    }
    restart(ctx)
  }

  /** (Re)starts it: after the keys change, or from a failure. */
  fun restart(ctx: Context) {
    app = ctx.applicationContext
    val gen = synchronized(this) { ++generation }
    worker.execute { runCatching { boot(gen) }.onFailure { fail(gen, it.message ?: it.toString()) } }
  }

  fun stop() {
    val old = synchronized(this) {
      generation++
      status = "stopped"
      busy = null
      process.also { process = null }
    }
    old?.let { Thread({ shutDown(it) }, "lumen-server-stop").start() }
  }

  /**
   * Asks the server to close (SIGTERM to the supervisor, which passes it on), so
   * a running period is saved; kills it if it hasn't gone within a few seconds.
   */
  private fun shutDown(proc: Process) {
    // The process's pid isn't public API before Android 13's Process.pid(): try the
    // implementation's field, else find our supervisor in /proc (our own uid's).
    val pid = runCatching {
      proc.javaClass.getDeclaredField("pid").apply { isAccessible = true }.getInt(proc)
    }.getOrNull() ?: runCatching {
      File("/proc").listFiles()?.firstOrNull { d ->
        d.name.all(Char::isDigit) && File(d, "cmdline").readText().startsWith(
          app.applicationInfo.nativeLibraryDir + "/libsigsys.so",
        )
      }?.name?.toInt()
    }.getOrNull()
    if (pid != null && pid > 0) {
      android.os.Process.sendSignal(pid, 15)
      val deadline = System.currentTimeMillis() + 4000
      while (System.currentTimeMillis() < deadline) {
        if (runCatching { proc.exitValue() }.isSuccess) return
        Thread.sleep(100)
      }
    }
    proc.destroy()
  }

  private fun fail(gen: Int, msg: String) {
    Log.e(TAG, msg)
    appendLog("error: $msg")
    if (gen != generation) return
    status = msg
    emit(Event.Failed(msg))
  }

  private fun boot(gen: Int) {
    synchronized(this) { process.also { process = null } }?.let { shutDown(it) }
    unpackIfNeeded()
    if (gen != generation) return
    status = "starting"
    emit(Event.Progress("starting", 100))
    val p = freePort()
    val proc = launch(p)
    synchronized(this) {
      if (gen != generation) {
        proc.destroy()
        return
      }
      process = proc
      port = p
    }
    // The server's output goes to files/logs/server.log (the last session only).
    Thread({
      proc.inputStream.bufferedReader().forEachLine { appendLog(it) }
      val code = runCatching { proc.waitFor() }.getOrDefault(-1)
      appendLog("server exited: $code")
      synchronized(this) { if (process === proc) process = null }
      if (gen == generation) fail(gen, "The server stopped (exit $code). The log has the details.")
    }, "lumen-server-log").start()
    val deadline = System.currentTimeMillis() + 120_000
    while (System.currentTimeMillis() < deadline) {
      if (gen != generation || process !== proc) return
      if (health(p) != null) {
        status = "running"
        Log.i(TAG, "server healthy on 127.0.0.1:$p")
        emit(Event.Running(p))
        return
      }
      Thread.sleep(250)
    }
    fail(gen, "The server took too long to start. The log has the details.")
  }

  /** /api/health, or null if it doesn't answer. Updates [busy]. */
  fun health(p: Int = port): JSONObject? {
    if (p == 0) return null
    return runCatching {
      val c = URL("http://127.0.0.1:$p/api/health").openConnection() as HttpURLConnection
      c.connectTimeout = 1500
      c.readTimeout = 1500
      try {
        if (c.responseCode != 200) return null
        val j = JSONObject(c.inputStream.bufferedReader().readText())
        busy = j.optString("busy").takeIf { it.isNotEmpty() && it != "null" }
        j
      } finally {
        c.disconnect()
      }
    }.getOrNull()
  }

  private fun freePort(): Int =
    ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { it.localPort }

  private fun launch(port: Int): Process {
    val rt = File(runtimeDir(app), "rt")
    val server = File(runtimeDir(app), "server")
    val data = dataDir(app).apply { mkdirs() }
    val tmp = File(app.cacheDir, "node").apply { mkdirs() }
    val nl = app.applicationInfo.nativeLibraryDir
    logFile(app).parentFile?.mkdirs()
    logFile(app).delete()
    val pb = ProcessBuilder(
      "$nl/libsigsys.so",
      "$nl/libld.so",
      "--library-path", "${rt.path}/lib",
      "${rt.path}/bin/node",
      "${server.path}/server.mjs",
    )
    pb.directory(data)
    pb.redirectErrorStream(true)
    val env = pb.environment()
    // Keys only ever come from the Keystore, never from anywhere else.
    env.remove(Keys.OPENAI)
    env.remove(Keys.DEEPSEEK)
    env["HOME"] = app.filesDir.path
    env["TMPDIR"] = tmp.path
    env["TZ"] = TimeZone.getDefault().id
    env["LUMEN_ANDROID"] = "1"
    env["LUMEN_DESKTOP"] = "1"
    env["LUMEN_PARENT_PID"] = android.os.Process.myPid().toString()
    env["LUMEN_PORT"] = port.toString()
    env["LUMEN_DATA_DIR"] = data.path
    env["LUMEN_CONFIG_DIR"] = "${server.path}/config"
    env["LUMEN_MIGRATIONS_DIR"] = "${server.path}/drizzle"
    env["LUMEN_PROMPTS_DIR"] = "${server.path}/prompts"
    env["LUMEN_CLIENT_DIR"] = "${server.path}/client"
    env["LUMEN_DNS"] = dnsServers()
    // Android's seccomp filter kills io_uring_setup; libuv must not try it.
    env["UV_USE_IO_URING"] = "0"
    for ((k, v) in Keys.env(app)) env[k] = v
    appendLog("starting the server on 127.0.0.1:$port (Android ${Build.VERSION.RELEASE}, ${Build.MODEL})")
    return pb.start()
  }

  private fun dnsServers(): String = runCatching {
    val cm = app.getSystemService(ConnectivityManager::class.java)
    cm.getLinkProperties(cm.activeNetwork)?.dnsServers?.mapNotNull { it.hostAddress }?.joinToString(",")
  }.getOrNull() ?: ""

  @Synchronized
  fun appendLog(line: String) {
    runCatching {
      val f = logFile(app)
      f.parentFile?.mkdirs()
      FileOutputStream(f, true).use { it.write((line + "\n").toByteArray()) }
    }
  }

  fun logTail(ctx: Context, lines: Int = 40): String = runCatching {
    logFile(ctx).readLines().takeLast(lines).joinToString("\n")
  }.getOrDefault("")

  // --- unpacking ------------------------------------------------------------------

  private fun manifest() = JSONObject(app.assets.open("lumen-runtime.json").bufferedReader().readText())

  /**
   * Unpacks the runtime's parts in parallel (xz decodes at a few MB/s on one core
   * of a phone), into runtime.next, then swaps it in: a half-done unpack is never
   * taken for a runtime.
   */
  private fun unpackIfNeeded() {
    val dir = runtimeDir(app)
    val m = manifest()
    val stamp = m.getString("stamp")
    val stampFile = File(dir, ".stamp")
    if (stampFile.exists() && stampFile.readText() == stamp) return
    status = "unpacking"
    val t0 = System.currentTimeMillis()
    val next = File(app.filesDir, "runtime.next")
    next.deleteRecursively()
    next.mkdirs()
    val parts = m.getJSONArray("parts").let { a -> (0 until a.length()).map { a.getJSONObject(it).getString("name") } }
    val total = parts.sumOf { name -> app.assets.openFd(name).use { it.length } }
    val read = java.util.concurrent.atomic.AtomicLong()
    val pool = Executors.newFixedThreadPool(minOf(parts.size, maxOf(1, Runtime.getRuntime().availableProcessors())))
    try {
      val jobs = parts.map { name ->
        pool.submit<Unit> {
          val raw = app.assets.open(name, android.content.res.AssetManager.ACCESS_STREAMING)
          val counted = CountingStream(BufferedInputStream(raw, 1 shl 16)) { step ->
            val done = read.addAndGet(step)
            emit(Event.Progress("unpacking", ((done * 100) / total).toInt().coerceIn(0, 99)))
          }
          XZInputStream(counted).use { TarReader.extract(it, next) }
        }
      }
      jobs.forEach { it.get() }
    } finally {
      pool.shutdownNow()
    }
    File(next, ".stamp").writeText(stamp)
    dir.deleteRecursively()
    if (!next.renameTo(dir)) throw IllegalStateException("couldn't move the runtime into place")
    Log.i(TAG, "unpacked the runtime (${parts.size} parts) in ${System.currentTimeMillis() - t0} ms")
  }

  private class CountingStream(inner: InputStream, val onStep: (Long) -> Unit) :
    java.io.FilterInputStream(inner) {
    var read = 0L
    private var lastStep = 0L
    /** Reports the bytes read since the last report, every MB or so. */
    private fun count(n: Int) {
      if (n > 0) read += n
      if (read - lastStep > 1 shl 20) {
        onStep(read - lastStep)
        lastStep = read
      }
    }
    override fun read(): Int = super.read().also { if (it >= 0) count(1) }
    override fun read(b: ByteArray, off: Int, len: Int): Int = super.read(b, off, len).also { count(it) }
  }
}
