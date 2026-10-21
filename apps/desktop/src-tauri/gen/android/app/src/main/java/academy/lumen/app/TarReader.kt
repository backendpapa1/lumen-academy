package academy.lumen.app

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.Paths

/**
 * Unpacks the runtime archive (ADR-012): the subset of tar that `tar` writes for
 * us (GNU format: long names, files, dirs, symlinks; ustar and pax read too).
 * Plain JVM code, so it's tested on the build machine against the real archive.
 */
object TarReader {
  /** A small tar reader: GNU and ustar headers, long names, files, dirs and symlinks. */
  fun extract(input: InputStream, to: File) {
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
        if (n < 0) throw IOException("truncated runtime archive")
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
        throw IOException("bad path in the runtime archive: $name")
      when (type) {
        '5' -> target.mkdirs()
        '2' -> {
          target.parentFile?.mkdirs()
          target.delete()
          Files.createSymbolicLink(target.toPath(), Paths.get(link))
        }
        '0', '\u0000', '7' -> {
          target.parentFile?.mkdirs()
          FileOutputStream(target).use { out ->
            var left = size
            while (left > 0) {
              val n = input.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
              if (n < 0) throw IOException("truncated runtime archive")
              out.write(buf, 0, n)
              left -= n
            }
          }
          skipPadding(input, size)
          if (mode and 0b001_001_001 != 0) target.setExecutable(true, true)
        }
        else -> readData(size) // hard links, devices: nothing of ours
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
