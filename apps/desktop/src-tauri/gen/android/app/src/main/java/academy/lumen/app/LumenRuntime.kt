package academy.lumen.app

import android.content.Context
import android.net.ConnectivityManager
import android.os.Build
import android.system.Os
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

  private fun assetStamp(): String =
    JSONObject(app.assets.open("lumen-runtime.json").bufferedReader().readText()).getString("stamp")

  private fun unpackIfNeeded() {
    val dir = runtimeDir(app)
    val stamp = assetStamp()
    val stampFile = File(dir, ".stamp")
    if (stampFile.exists() && stampFile.readText() == stamp) return
    status = "unpacking"
    val t0 = System.currentTimeMillis()
    val next = File(app.filesDir, "runtime.next")
    next.deleteRecursively()
    next.mkdirs()
    val total = app.assets.openFd("lumen-runtime.tar.xz").use { it.length }
    val raw = app.assets.open("lumen-runtime.tar.xz", android.content.res.AssetManager.ACCESS_STREAMING)
    val counted = CountingStream(BufferedInputStream(raw, 1 shl 16)) { read ->
      emit(Event.Progress("unpacking", ((read * 100) / total).toInt().coerceIn(0, 99)))
    }
    XZInputStream(counted).use { untar(it, next) }
    File(next, ".stamp").writeText(stamp)
    dir.deleteRecursively()
    if (!next.renameTo(dir)) throw IllegalStateException("couldn't move the runtime into place")
    Log.i(TAG, "unpacked the runtime in ${System.currentTimeMillis() - t0} ms")
  }

  private class CountingStream(inner: InputStream, val onStep: (Long) -> Unit) :
    java.io.FilterInputStream(inner) {
    var read = 0L
    private var lastStep = 0L
    private fun count(n: Int) {
      if (n > 0) read += n
      if (read - lastStep > 1 shl 20) {
        lastStep = read
        onStep(read)
      }
    }
    override fun read(): Int = super.read().also { if (it >= 0) count(1) }
    override fun read(b: ByteArray, off: Int, len: Int): Int = super.read(b, off, len).also { count(it) }
  }

  /** A small tar reader: GNU and ustar headers, long names, files, dirs and symlinks. */
  private fun untar(input: InputStream, to: File) {
    val header = ByteArray(512)
    val buf = ByteArray(1 shl 16)
    var longName: String? = null
    var longLink: String? = null
    val root = to.canonicalPath + File.separator
    fun readFully(b: ByteArray, n: Int): Boolean {
      var off = 0
      while (off < n) {
        val r = input.read(b, off, n - off)
        if (r < 0) return false
        off += r
      }
      return true
    }
    fun str(off: Int, len: Int): String {
      var end = off
      while (end < off + len && header[end] != 0.toByte()) end++
      return String(header, off, end - off, Charsets.UTF_8)
    }
    fun octal(off: Int, len: Int): Long {
      if (header[off].toInt() and 0x80 != 0) { // base-256 (GNU, big files)
        var v = 0L
        for (i in off + 1 until off + len) v = (v shl 8) or (header[i].toLong() and 0xff)
        return v
      }
      val s = str(off, len).trim()
      return if (s.isEmpty()) 0 else s.toLong(8)
    }
    fun readData(size: Long): ByteArray {
      val out = java.io.ByteArrayOutputStream()
      var left = size
      while (left > 0) {
        val n = input.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
        if (n < 0) throw IllegalStateException("truncated runtime archive")
        out.write(buf, 0, n)
        left -= n
      }
      skipPadding(input, size)
      return out.toByteArray()
    }
    while (true) {
      if (!readFully(header, 512)) break
      if (header.all { it == 0.toByte() }) break
      val type = header[156].toInt().toChar()
      val size = octal(124, 12)
      val mode = octal(100, 8).toInt()
      var name = longName ?: run {
        val prefix = str(345, 155)
        val n = str(0, 100)
        if (prefix.isNotEmpty() && str(257, 6).startsWith("ustar")) "$prefix/$n" else n
      }
      val link = longLink ?: str(157, 100)
      longName = null
      longLink = null
      when (type) {
        'L' -> { longName = String(readData(size), Charsets.UTF_8).trimEnd('\u0000'); continue }
        'K' -> { longLink = String(readData(size), Charsets.UTF_8).trimEnd('\u0000'); continue }
        'x', 'g' -> {
          val pax = String(readData(size), Charsets.UTF_8)
          Regex("""\d+ path=([^\n]*)\n""").find(pax)?.let { longName = it.groupValues[1] }
          continue
        }
      }
      name = name.removePrefix("./")
      val target = File(to, name)
      if (!target.canonicalPath.startsWith(root) && target.canonicalPath + File.separator != root)
        throw IllegalStateException("bad path in the runtime archive: $name")
      when (type) {
        '5' -> target.mkdirs()
        '2' -> {
          target.parentFile?.mkdirs()
          target.delete()
          Os.symlink(link, target.path)
        }
        '0', '\u0000', '7' -> {
          target.parentFile?.mkdirs()
          FileOutputStream(target).use { out ->
            var left = size
            while (left > 0) {
              val n = input.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
              if (n < 0) throw IllegalStateException("truncated runtime archive")
              out.write(buf, 0, n)
              left -= n
            }
          }
          skipPadding(input, size)
          if (mode and 0b001_001_001 != 0) target.setExecutable(true, true)
        }
        else -> { // hard links, devices: nothing of ours
          var left = size
          while (left > 0) left -= input.skip(left).coerceAtLeast(1)
          skipPadding(input, size)
        }
      }
    }
  }

  private fun skipPadding(input: InputStream, size: Long) {
    var pad = (512 - (size % 512)) % 512
    while (pad > 0) {
      val r = input.read()
      if (r < 0) return
      pad--
    }
  }
}
