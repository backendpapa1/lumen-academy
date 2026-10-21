package academy.lumen.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The API keys on Android (ADR-012): encrypted with an AES key that lives in the
 * Android Keystore and never leaves it; the ciphertext is in the app's private
 * preferences. They reach the Node server only as environment variables when it
 * starts. The game page never sees them; the configurator sees only a hint.
 */
object Keys {
  const val OPENAI = "OPENAI_API_KEY"
  const val DEEPSEEK = "DEEPSEEK_API_KEY"
  val ALL = listOf(OPENAI, DEEPSEEK)

  private const val ALIAS = "lumen-api-keys"
  private const val PREFS = "lumen-keys"

  private fun secret(): SecretKey {
    val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    gen.init(
      KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build(),
    )
    return gen.generateKey()
  }

  fun get(ctx: Context, name: String): String? {
    val stored = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(name, null) ?: return null
    return runCatching {
      val bytes = Base64.decode(stored, Base64.NO_WRAP)
      val c = Cipher.getInstance("AES/GCM/NoPadding")
      c.init(Cipher.DECRYPT_MODE, secret(), GCMParameterSpec(128, bytes, 0, 12))
      String(c.doFinal(bytes, 12, bytes.size - 12), Charsets.UTF_8)
    }.getOrNull()?.takeIf { it.isNotEmpty() }
  }

  /** Saves a key; an empty one removes it. */
  fun set(ctx: Context, name: String, value: String) {
    val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
    val v = value.trim()
    if (v.isEmpty()) {
      prefs.remove(name).apply()
      return
    }
    val c = Cipher.getInstance("AES/GCM/NoPadding")
    c.init(Cipher.ENCRYPT_MODE, secret())
    val out = c.iv + c.doFinal(v.toByteArray(Charsets.UTF_8))
    prefs.putString(name, Base64.encodeToString(out, Base64.NO_WRAP)).commit()
  }

  fun env(ctx: Context): Map<String, String> =
    ALL.mapNotNull { n -> get(ctx, n)?.let { n to it } }.toMap()

  /** "sk-…a1b2": enough to recognise a key, never enough to use it. */
  fun hint(v: String): String = v.take(3) + "…" + v.takeLast(4)
}
