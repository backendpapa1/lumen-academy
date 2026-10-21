package academy.lumen.app

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/**
 * The phone's own voices and ears (ADR-012, A5). Android's TextToSpeech speaks
 * the students and the narrator (one engine each, so stopping one doesn't stop
 * the other), and SpeechRecognizer hears the teacher, on the device when it can.
 * Events go to the page as `lumen-native` DOM events.
 */
class Speech(private val ctx: Context, private val emit: (JSONObject) -> Unit) {
  companion object {
    private const val TAG = "LumenSpeech"

    // Google's TTS voice names don't say who's speaking; these do (by the
    // three-letter code in "en-us-x-iom-local"). Unknown voices get a pitch instead.
    private val FEMALE = setOf(
      "iob", "iog", "sfg", "tpc", "tpf", "gba", "gbc", "gbg", "aua", "auc", "ahp", "cxx", "ena",
    )
    private val MALE = setOf("iol", "iom", "tpd", "gbb", "gbd", "rjs", "aub", "aud", "end")
    private fun code(v: Voice) = Regex("-x-([a-z]{3})").find(v.name)?.groupValues?.get(1)
    fun gender(v: Voice): String? = code(v)?.let { if (it in FEMALE) "female" else if (it in MALE) "male" else null }
  }

  private inner class Engine(val channel: String) {
    var tts: TextToSpeech? = null
    var ready = false
    val pending = ArrayList<() -> Unit>()

    fun use(f: (TextToSpeech) -> Unit) {
      val t = tts
      if (t != null && ready) return f(t)
      pending += { tts?.let(f) }
      if (t != null) return
      tts = TextToSpeech(ctx) { status ->
        ready = status == TextToSpeech.SUCCESS
        if (!ready) Log.w(TAG, "TextToSpeech didn't start ($status)")
        tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
          override fun onStart(id: String) = say("start", id)
          override fun onDone(id: String) = say("done", id)
          @Deprecated("old API") override fun onError(id: String) = say("error", id)
          override fun onError(id: String, code: Int) = say("error", id)
          override fun onStop(id: String, interrupted: Boolean) = say("stopped", id)
        })
        val run = pending.toList()
        pending.clear()
        // Without an engine the lines are dropped; the page carries on without voices.
        if (ready) run.forEach { it() }
      }
    }

    private fun say(state: String, id: String) =
      emit(JSONObject().put("type", "tts").put("channel", channel).put("id", id).put("state", state))
  }

  private val voice = Engine("voice")
  private val narrator = Engine("narrator")
  private fun engine(channel: String) = if (channel == "narrator") narrator else voice

  /** English voices on the device, offline ones first, in a stable order. */
  private fun english(t: TextToSpeech): List<Voice> =
    (t.voices ?: emptySet())
      .filter { it.locale.language == "en" && !it.features.contains("notInstalled") }
      .sortedWith(compareBy({ it.isNetworkConnectionRequired }, { it.locale.toString() }, { it.name }))

  fun voices(done: (JSONArray) -> Unit) = voice.use { t ->
    val out = JSONArray()
    for (v in english(t))
      out.put(
        JSONObject().put("name", v.name).put("locale", v.locale.toString()).put("gender", gender(v) ?: "")
          .put("network", v.isNetworkConnectionRequired),
      )
    done(out)
  }

  /**
   * Speaks a line. `register` and `index` come from the server's voice choice
   * (/api/speech/voice): classmates with different indexes get different voices
   * where the phone has enough, and a different pitch where it doesn't.
   */
  fun speak(a: JSONObject) {
    val channel = a.optString("channel", "voice")
    val id = a.getString("id")
    val text = a.getString("text")
    val register = a.optString("register", "female")
    val index = a.optInt("index", 0)
    val rate = a.optDouble("rate", 1.0).toFloat().coerceIn(0.5f, 2f)
    val queue = a.optBoolean("queue", true)
    val volume = a.optDouble("volume", 1.0).toFloat().coerceIn(0f, 1f)
    engine(channel).use { t ->
      val all = english(t).filter { !it.isNetworkConnectionRequired }.ifEmpty { english(t) }
      val chosen: Voice?
      var pitch = 1f
      if (channel == "narrator") {
        // The Head of School: a British voice of her own, never a student's.
        chosen = all.firstOrNull { it.locale.country == "GB" && gender(it) == "female" }
          ?: all.firstOrNull { it.locale.country == "GB" } ?: all.firstOrNull()
      } else {
        val narratorVoice = all.firstOrNull { it.locale.country == "GB" && gender(it) == "female" }
        val pool = all.filter { gender(it) == register && it != narratorVoice }
        if (pool.isNotEmpty()) {
          chosen = pool[Math.floorMod(index, pool.size)]
          // Past the pool's size, classmates sharing a voice differ in pitch.
          val round = Math.floorDiv(maxOf(0, index), pool.size)
          pitch = if (round == 0) 1f else if (round % 2 == 1) 0.92f else 1.08f
        } else {
          val any = all.filter { it != narratorVoice }.ifEmpty { all }
          chosen = any.getOrNull(Math.floorMod(index, maxOf(1, any.size)))
          pitch = if (register == "male") 0.82f else 1.12f
        }
      }
      chosen?.let { t.voice = it }
      t.setSpeechRate(rate)
      t.setPitch(pitch)
      val params = Bundle().apply { putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, volume) }
      t.speak(text, if (queue) TextToSpeech.QUEUE_ADD else TextToSpeech.QUEUE_FLUSH, params, id)
    }
  }

  fun stop(channel: String) {
    engine(channel).tts?.stop()
  }

  // --- listening ------------------------------------------------------------------

  private var recognizer: SpeechRecognizer? = null
  private var held = false
  private val heard = StringBuilder()
  private var partial = ""
  private var onFinal: ((String) -> Unit)? = null
  private var lastLevel = 0L

  private fun intent() = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
    val lang = Locale.getDefault().takeIf { it.language == "en" }?.toLanguageTag() ?: "en-US"
    putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang)
    putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
    putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
    putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 4000L)
    putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 3000L)
  }

  val canListen get() = SpeechRecognizer.isRecognitionAvailable(ctx)

  /** Starts listening (main thread). It keeps listening through pauses until [stopListening]. */
  fun startListening(): String? {
    if (!canListen) return "This phone has no speech recognizer. Type instead."
    recognizer?.destroy()
    heard.clear()
    partial = ""
    held = true
    onFinal = null
    val r = SpeechRecognizer.createSpeechRecognizer(ctx)
    recognizer = r
    r.setRecognitionListener(object : RecognitionListener {
      override fun onReadyForSpeech(params: Bundle?) = state("listening")
      override fun onBeginningOfSpeech() {}
      override fun onRmsChanged(rmsdB: Float) {
        val now = System.currentTimeMillis()
        if (now - lastLevel < 90) return
        lastLevel = now
        // About -2 dB (quiet) to 10 dB (loud speech).
        val level = ((rmsdB + 2f) / 12f).coerceIn(0f, 1f)
        emit(JSONObject().put("type", "stt").put("state", "level").put("level", level.toDouble()))
      }
      override fun onBufferReceived(buffer: ByteArray?) {}
      override fun onEndOfSpeech() {}
      override fun onError(error: Int) {
        Log.i(TAG, "recognizer error $error")
        // No match or silence while I'm still holding: listen again.
        if (held && (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT)) {
          r.startListening(intent())
          return
        }
        if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS)
          emit(JSONObject().put("type", "stt").put("state", "error").put("message", "Lumen isn't allowed to use the microphone."))
        finish()
      }
      override fun onResults(results: Bundle?) {
        val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
        if (text.isNotBlank()) heard.append(if (heard.isEmpty()) "" else " ").append(text.trim())
        partial = ""
        if (held) r.startListening(intent()) else finish()
      }
      override fun onPartialResults(partialResults: Bundle?) {
        partial = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
        emit(JSONObject().put("type", "stt").put("state", "partial").put("text", (heard.toString() + " " + partial).trim()))
      }
      override fun onEvent(eventType: Int, params: Bundle?) {}
    })
    r.startListening(intent())
    return null
  }

  /** Stops listening; `done` gets everything heard since [startListening]. */
  fun stopListening(cancel: Boolean, done: (String) -> Unit) {
    val r = recognizer
    held = false
    if (r == null || cancel) {
      r?.cancel()
      finish()
      return done("")
    }
    onFinal = done
    r.stopListening()
  }

  /** The words so far, if the recognizer is slow to give its last result. */
  fun flush() = finish()

  private fun finish() {
    val text = (heard.toString() + " " + partial).trim()
    partial = ""
    heard.clear()
    recognizer?.destroy()
    recognizer = null
    state("idle")
    onFinal?.let {
      onFinal = null
      it(text)
    }
  }

  private fun state(s: String) = emit(JSONObject().put("type", "stt").put("state", s))

  fun destroy() {
    voice.tts?.shutdown()
    narrator.tts?.shutdown()
    recognizer?.destroy()
  }
}
