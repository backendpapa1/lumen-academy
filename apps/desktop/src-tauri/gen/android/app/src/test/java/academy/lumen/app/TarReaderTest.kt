package academy.lumen.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.tukaani.xz.XZInputStream
import java.io.BufferedInputStream
import java.io.File
import java.nio.file.Files

/**
 * The first run's unpack (ADR-012), on the build machine: the real
 * lumen-runtime.tar.xz from scripts/bundle-android.mjs comes out exactly like
 * the folders it was made from (build/android/rt and server).
 */
class TarReaderTest {
  private val project = File(System.getProperty("user.dir")!!) // gen/android/app
  private val archive = File(project, "src/main/assets/lumen-runtime.tar.xz")
  private val source = File(project, "../../../../build/android")

  @Test
  fun unpacksTheRuntimeExactly() {
    assumeTrue("run scripts/bundle-android.mjs first", archive.exists() && source.isDirectory)
    val out = Files.createTempDirectory("lumen-rt").toFile()
    try {
      val t0 = System.currentTimeMillis()
      XZInputStream(BufferedInputStream(archive.inputStream(), 1 shl 16)).use { TarReader.extract(it, out) }
      println("unpacked in ${System.currentTimeMillis() - t0} ms")
      var files = 0
      for (top in listOf("rt", "server")) {
        File(source, top).walkTopDown().filter { it.isFile }.forEach { f ->
          val rel = f.relativeTo(source).path
          val got = File(out, rel)
          assertTrue("missing $rel", got.isFile)
          assertEquals("size of $rel", f.length(), got.length())
          files++
        }
      }
      assertTrue(files > 1000)
      assertTrue(File(out, "rt/bin/node").canExecute())
      assertEquals(
        File(source, "server/server.mjs").readText(),
        File(out, "server/server.mjs").readText(),
      )
    } finally {
      out.deleteRecursively()
    }
  }

  @Test
  fun refusesPathsOutsideTheTarget() {
    val header = ByteArray(512)
    "../evil".toByteArray().copyInto(header, 0)
    "0000644".toByteArray().copyInto(header, 100)
    "00000000000".toByteArray().copyInto(header, 124)
    header[156] = '0'.code.toByte()
    val tar = header + ByteArray(1024)
    val out = Files.createTempDirectory("lumen-rt").toFile()
    try {
      val e = runCatching { TarReader.extract(tar.inputStream(), out) }.exceptionOrNull()
      assertTrue(e?.message.orEmpty().contains("bad path"))
      assertTrue(!File(out.parentFile, "evil").exists())
    } finally {
      out.deleteRecursively()
    }
  }
}
