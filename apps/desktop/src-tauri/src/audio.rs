//! Native audio for the desktop app. WebKitGTK's Web Audio output is silent on
//! some Linux systems (it plays, but sends zeros to the sound server), and
//! `<audio>` only plays straight after a click. So in the desktop app the page
//! hands each sound to us as a WAV: the narrator's lines, the students' voices,
//! sound cues and the background pads. We play them through the system's
//! sound (cpal: ALSA, which PipeWire and PulseAudio serve).
//!
//! One player per channel ("narrator", "voice", "sfx", "bed", ...), all on one
//! thread that owns the output device.

use std::{collections::HashMap, io::Cursor, sync::mpsc, sync::Mutex, thread};

use rodio::{Decoder, Player, Source};

enum Cmd {
    Play { channel: String, wav: Vec<u8>, queue: bool, looped: bool, mix: bool, volume: f32 },
    Stop { channel: String },
    Volume { channel: String, volume: f32 },
}

pub struct Audio(Mutex<Option<mpsc::Sender<Cmd>>>);

impl Audio {
    pub fn new() -> Self {
        Audio(Mutex::new(None))
    }

    fn send(&self, cmd: Cmd) -> Result<(), String> {
        let mut tx = self.0.lock().unwrap();
        if tx.is_none() {
            *tx = Some(spawn());
        }
        tx.as_ref().unwrap().send(cmd).map_err(|_| "the sound thread stopped".to_string())
    }
}

/// The thread that owns the output device and the players.
fn spawn() -> mpsc::Sender<Cmd> {
    let (tx, rx) = mpsc::channel::<Cmd>();
    thread::spawn(move || {
        let device = match rodio::DeviceSinkBuilder::open_default_sink() {
            Ok(d) => d,
            Err(e) => {
                eprintln!("no sound output: {e}");
                for _ in rx {} // keep accepting, so the page never errors on sound
                return;
            }
        };
        let mut players: HashMap<String, Player> = HashMap::new();
        for cmd in rx {
            match cmd {
                Cmd::Play { wav, mix: true, volume, .. } => {
                    // Cues overlap: straight into the mixer, no queue.
                    match Decoder::try_from(Cursor::new(wav)) {
                        Ok(src) => device.mixer().add(src.amplify(volume)),
                        Err(e) => eprintln!("couldn't read a sound: {e}"),
                    }
                }
                Cmd::Play { channel, wav, queue, looped, volume, .. } => {
                    let player = players
                        .entry(channel)
                        .or_insert_with(|| Player::connect_new(device.mixer()));
                    if !queue {
                        player.clear();
                    }
                    player.set_volume(volume);
                    match Decoder::try_from(Cursor::new(wav)) {
                        Ok(src) if looped => player.append(src.buffered().repeat_infinite()),
                        Ok(src) => player.append(src),
                        Err(e) => eprintln!("couldn't read a sound: {e}"),
                    }
                    // clear() pauses the player; a new sound always plays.
                    player.play();
                }
                Cmd::Stop { channel } => {
                    if let Some(p) = players.get(&channel) {
                        p.clear();
                    }
                }
                Cmd::Volume { channel, volume } => {
                    if let Some(p) = players.get(&channel) {
                        p.set_volume(volume);
                    }
                }
            }
        }
    });
    tx
}

fn header<'a>(req: &'a tauri::ipc::Request<'_>, name: &str) -> Option<&'a str> {
    req.headers().get(name).and_then(|v| v.to_str().ok())
}

/// The page sends the WAV as the raw body; the channel and options as headers.
#[tauri::command]
pub fn audio_play(state: tauri::State<'_, Audio>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(wav) = request.body() else {
        return Err("expected the sound as bytes".into());
    };
    let channel = header(&request, "x-channel").unwrap_or("sfx").to_string();
    let volume = header(&request, "x-volume").and_then(|v| v.parse::<f32>().ok()).unwrap_or(1.0);
    state.send(Cmd::Play {
        channel,
        wav: wav.clone(),
        queue: header(&request, "x-queue") == Some("1"),
        looped: header(&request, "x-loop") == Some("1"),
        mix: header(&request, "x-mix") == Some("1"),
        volume: volume.clamp(0.0, 2.0),
    })
}

#[tauri::command]
pub fn audio_stop(state: tauri::State<'_, Audio>, channel: String) -> Result<(), String> {
    state.send(Cmd::Stop { channel })
}

#[tauri::command]
pub fn audio_volume(state: tauri::State<'_, Audio>, channel: String, volume: f32) -> Result<(), String> {
    state.send(Cmd::Volume { channel, volume: volume.clamp(0.0, 2.0) })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Kokoro's WAVs are 32-bit float, mono, 24 kHz: the decoder must read them.
    #[test]
    fn decodes_float_wav_like_kokoros() {
        let rate = 24_000u32;
        let samples: Vec<f32> = (0..2400).map(|i| (i as f32 * 0.1).sin() * 0.5).collect();
        let mut wav = Vec::new();
        let data_len = (samples.len() * 4) as u32;
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_len).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&3u16.to_le_bytes()); // IEEE float
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&rate.to_le_bytes());
        wav.extend_from_slice(&(rate * 4).to_le_bytes());
        wav.extend_from_slice(&4u16.to_le_bytes());
        wav.extend_from_slice(&32u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_len.to_le_bytes());
        for s in &samples {
            wav.extend_from_slice(&s.to_le_bytes());
        }
        let dec = Decoder::try_from(Cursor::new(wav)).expect("decodes");
        let out: Vec<_> = dec.collect();
        assert_eq!(out.len(), samples.len());
        assert!(out.iter().any(|s| s.abs() > 0.4));
    }
}
