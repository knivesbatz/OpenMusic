//! "Share audio with Discord" (Windows).
//!
//! Discord's Go Live (and OBS's application audio capture) records the audio of the process that
//! owns the shared window. The app's windows belong to YTSpot.exe / PLEXSpot.exe, but its sound is
//! made by the WebView2 runtime in separate msedgewebview2.exe processes, so a shared window, the
//! mini player included, streams without audio.
//!
//! When the setting is on, a relay thread records the WebView2 processes' audio with Windows
//! process loopback (Windows 10 build 20348 / Windows 11 and later) and plays it again from the
//! app's own process. The WebView2 audio sessions are turned down to almost nothing in the volume
//! mixer so the music is heard once.
//!
//! They are turned down rather than muted: process loopback records a stream after the mixer's
//! per-app volume, so muting WebView2 made the recording, and so the music, silent. The relay
//! measures this when audio first plays (a moment at full volume, a moment turned down) and, when
//! the recording follows the mixer volume, boosts it back by the same amount. If the capture hears
//! nothing while WebView2 plays, the relay restores WebView2's volume, stops and tells the UI why.

use crate::error::{Error, Result};

/// Mixer volume for the WebView2 sessions while the relay plays: about -60 dB with a float
/// capture, about -30 dB with a 16-bit one (whose boosted copy would lose too much detail lower).
pub fn quiet_level(float: bool) -> f32 {
    if float {
        0.001
    } else {
        0.03
    }
}

/// Level of one captured packet, before any gain: peak and sum of squares of the samples
/// (scaled to ±1), and the sample count.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Level {
    pub peak: f32,
    pub sum_sq: f64,
    pub n: u64,
}

impl Level {
    /// Anything above this is sound; exact zeros and -0.0 are not.
    pub fn audible(&self) -> bool {
        self.peak > 1e-6
    }
}

/// Measures a packet of 32-bit float or 16-bit PCM samples, then multiplies it by `gain` in
/// place. A packet that the gain would push past full scale (audio that reached the capture at
/// full volume, e.g. a WebView2 session not turned down yet) keeps its own level instead.
pub fn apply_gain(packet: &mut [u8], float: bool, gain: f32) -> Level {
    let mut level = Level::default();
    let size = if float { 4 } else { 2 };
    let read = |c: &[u8]| -> f32 {
        if float {
            f32::from_le_bytes([c[0], c[1], c[2], c[3]])
        } else {
            i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0
        }
    };
    for c in packet.chunks_exact(size) {
        let v = read(c);
        let v = if v.is_finite() { v } else { 0.0 };
        level.peak = level.peak.max(v.abs());
        level.sum_sq += (v as f64) * (v as f64);
        level.n += 1;
    }
    let gain = if level.peak * gain > 1.0 { 1.0 } else { gain };
    if gain != 1.0 {
        for c in packet.chunks_exact_mut(size) {
            let v = (read(c) * gain).clamp(-1.0, 1.0);
            if float {
                c.copy_from_slice(&v.to_le_bytes());
            } else {
                c.copy_from_slice(&((v * 32767.0).round() as i16).to_le_bytes());
            }
        }
    }
    level
}

/// After measuring the capture with WebView2 at full volume and then turned down to `quiet`:
/// the gain that restores the music's level. The capture follows the mixer volume when the
/// turned-down level drops by most of the expected amount; otherwise it doesn't (gain 1).
pub fn calibrated_gain(full_rms: f64, quiet_rms: f64, quiet: f32) -> f32 {
    if quiet_rms < full_rms * (quiet as f64) * 30.0 {
        1.0 / quiet
    } else {
        1.0
    }
}

/// Emitted when the relay stops by itself; the payload says why.
pub const STOPPED_EVENT: &str = "audio-share-stopped";

#[cfg(windows)]
pub use imp::set;

#[cfg(not(windows))]
pub fn set(_app: tauri::AppHandle, enabled: bool) -> Result<()> {
    if enabled {
        Err(Error::Unsupported("sharing audio with Discord (Windows only)".into()))
    } else {
        Ok(())
    }
}

#[cfg(windows)]
mod imp {
    use super::{Error, Result, STOPPED_EVENT};
    use std::collections::{HashSet, VecDeque};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc, Mutex};
    use std::thread::JoinHandle;
    use std::time::{Duration, Instant};
    use tauri::Emitter;
    use windows::core::{implement, Interface, Ref, HRESULT};
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Media::Audio::*;
    use windows::Win32::System::Com::StructuredStorage::{PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, BLOB, CLSCTX_ALL, COINIT_MULTITHREADED};
    use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
    use windows::Win32::System::Variant::VT_BLOB;

    struct Relay {
        stop: Arc<AtomicBool>,
        thread: JoinHandle<()>,
    }

    static RELAY: Mutex<Option<Relay>> = Mutex::new(None);

    /// Start or stop the relay. Starting reports setup errors (no process loopback, no audio device).
    pub fn set(app: tauri::AppHandle, enabled: bool) -> Result<()> {
        let mut slot = RELAY.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(r) = slot.as_ref() {
            if !r.thread.is_finished() && enabled {
                return Ok(());
            }
        }
        if let Some(r) = slot.take() {
            r.stop.store(true, Ordering::SeqCst);
            let _ = r.thread.join();
        }
        if !enabled {
            return Ok(());
        }
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel::<std::result::Result<(), String>>();
        let flag = stop.clone();
        let thread = std::thread::Builder::new()
            .name("audio-share".into())
            .spawn(move || run(app, flag, tx))
            .map_err(|e| Error::Invalid(e.to_string()))?;
        match rx.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(())) => {
                *slot = Some(Relay { stop, thread });
                Ok(())
            }
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(Error::Invalid(e))
            }
            Err(_) => {
                stop.store(true, Ordering::SeqCst);
                Err(Error::Invalid("Windows did not start the audio capture".into()))
            }
        }
    }

    /// Stops the relay when the app exits so WebView2 is unmuted.
    pub fn shutdown() {
        if let Some(r) = RELAY.lock().unwrap_or_else(|e| e.into_inner()).take() {
            r.stop.store(true, Ordering::SeqCst);
            let _ = r.thread.join();
        }
    }

    fn run(app: tauri::AppHandle, stop: Arc<AtomicBool>, ready: mpsc::Sender<std::result::Result<(), String>>) {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let mut ready = Some(ready);
        let reason = relay(&stop, &mut ready).err();
        // Whatever happened, the app must not stay silent.
        set_webview_volume(&webview_tree(&processes()), 1.0);
        unsafe { CoUninitialize() };
        if let Some(reason) = reason {
            log::warn!("audio share stopped: {reason}");
            match ready.take() {
                Some(tx) => {
                    let _ = tx.send(Err(reason));
                }
                None => {
                    let _ = app.emit(STOPPED_EVENT, reason);
                }
            }
        }
    }

    /// Both sides use this format; the audio engine converts to and from the device's mix format.
    fn format(float: bool) -> WAVEFORMATEX {
        let bits: u16 = if float { 32 } else { 16 };
        let block = 2 * bits / 8;
        WAVEFORMATEX {
            wFormatTag: if float { 3 } else { 1 }, // WAVE_FORMAT_IEEE_FLOAT / WAVE_FORMAT_PCM
            nChannels: 2,
            nSamplesPerSec: 48_000,
            nAvgBytesPerSec: 48_000 * block as u32,
            nBlockAlign: block,
            wBitsPerSample: bits,
            cbSize: 0,
        }
    }

    const MS: u32 = 48; // frames per millisecond

    /// Measuring how the capture follows WebView2's mixer volume (see the module comment).
    enum Gain {
        /// Step 0/1: WebView2 at full volume, settling then measuring; step 2/3: turned down.
        Measuring { step: u8, since: Instant, full: (f64, u64), quiet: (f64, u64) },
        Fixed(f32),
    }

    /// The WebView2 sessions' mixer volume: full while measuring at full volume, else turned down.
    fn webview_level(gain: &Gain, quiet: f32) -> f32 {
        match gain {
            Gain::Measuring { step, .. } if *step < 2 => 1.0,
            _ => quiet,
        }
    }

    const SETTLE: Duration = Duration::from_millis(150);
    const MEASURE: Duration = Duration::from_millis(250);

    fn relay(stop: &AtomicBool, ready: &mut Option<mpsc::Sender<std::result::Result<(), String>>>) -> std::result::Result<(), String> {
        let mut browser = browser_pid(&processes()).ok_or("the app's WebView2 process was not found")?;
        let (mut capture, fmt) = Capture::open(browser)?;
        let mut render = Render::open(&fmt).map_err(|e| format!("no audio output device: {e}"))?;
        let block = fmt.nBlockAlign as usize;
        let float = fmt.wFormatTag == 3;
        let quiet = super::quiet_level(float);
        if let Some(tx) = ready.take() {
            let _ = tx.send(Ok(()));
        }
        let mut gain = Gain::Measuring { step: 0, since: Instant::now(), full: (0.0, 0), quiet: (0.0, 0) };
        // Audio at full level while the WebView2 sessions are turned down (in total): proof that
        // the capture doesn't follow the mixer volume after all.
        let mut loud_while_quiet = Duration::ZERO;

        let mut queue: VecDeque<u8> = VecDeque::new();
        let mut primed = false;
        let mut last_data = Instant::now();
        let mut last_check = Instant::now() - Duration::from_secs(10);
        let mut heard = false;
        let mut silent_since: Option<Instant> = None;
        let mut render_errors = 0;
        let mut last_heard = Instant::now() - Duration::from_secs(10);
        let mut tree = webview_tree(&processes());

        while !stop.load(Ordering::SeqCst) {
            unsafe { WaitForSingleObject(capture.event, 20) };
            let g = match gain {
                Gain::Fixed(g) => g,
                Gain::Measuring { .. } => 1.0,
            };
            match capture.read(&mut queue, float, g) {
                Ok(Some(level)) => {
                    heard |= level.audible();
                    if level.audible() {
                        last_heard = Instant::now();
                    }
                    last_data = Instant::now();
                    let secs = Duration::from_secs_f64(level.n as f64 / 2.0 / 48_000.0);
                    match &mut gain {
                        Gain::Measuring { step, full, quiet: q, .. } => {
                            if *step == 1 {
                                full.0 += level.sum_sq;
                                full.1 += level.n;
                            } else if *step == 3 {
                                q.0 += level.sum_sq;
                                q.1 += level.n;
                            }
                        }
                        Gain::Fixed(g) if *g != 1.0 && level.peak > quiet * 4.0 => {
                            loud_while_quiet += secs;
                            if loud_while_quiet > Duration::from_millis(1500) {
                                log::warn!("audio share: the capture isn't following the mixer volume; no boost");
                                gain = Gain::Fixed(1.0);
                            }
                        }
                        Gain::Fixed(_) => {}
                    }
                }
                Ok(None) => {}
                Err(_) => {
                    // The WebView2 process went away (crash, reload): follow its successor.
                    std::thread::sleep(Duration::from_millis(500));
                    browser = browser_pid(&processes()).ok_or("the app's WebView2 process went away")?;
                    capture = Capture::open_as(browser, &fmt)?;
                    continue;
                }
            }
            // Keep the delay short: past 250 ms of backlog, drop the oldest audio.
            let max = (250 * MS) as usize * block;
            if queue.len() > max {
                let extra = (queue.len() - max) / block * block;
                queue.drain(..extra);
            }
            if !primed && queue.len() >= (40 * MS) as usize * block {
                primed = true;
            }
            // Often enough that a new WebView2 audio session is turned down before it is heard twice.
            if last_check.elapsed() >= Duration::from_millis(300) {
                last_check = Instant::now();
                let all = processes();
                tree = webview_tree(&all);
                let active = set_webview_volume(&tree, webview_level(&gain, quiet));
                // WebView2 plays but the capture hears nothing.
                if active && !heard {
                    let since = *silent_since.get_or_insert_with(Instant::now);
                    if since.elapsed() >= Duration::from_secs(8) {
                        return Err("Windows didn't pass the app's audio to the relay, so it was turned off".into());
                    }
                } else {
                    silent_since = None;
                }
                heard = false;
                // Follow the default output device.
                if default_device_id().is_some_and(|id| id != render.id) {
                    render = reopen(&fmt, 0)?;
                    primed = false;
                }
                if let Some(pid) = browser_pid(&all).filter(|&pid| pid != browser) {
                    browser = pid;
                    capture = Capture::open_as(browser, &fmt)?;
                }
                render_errors = 0;
            }

            // Measuring: WebView2 is heard directly (and briefly turned down); nothing is relayed.
            if let Gain::Measuring { step, since, full, quiet: q } = &mut gain {
                queue.clear();
                primed = false;
                let playing = last_heard.elapsed() < Duration::from_millis(500);
                match *step {
                    _ if !playing && *step != 0 => {
                        // Paused part-way: start again, at full volume, when the music is back.
                        set_webview_volume(&tree, 1.0);
                        *step = 0;
                        *since = Instant::now();
                        *full = (0.0, 0);
                        *q = (0.0, 0);
                    }
                    0 | 2 if since.elapsed() >= SETTLE && playing => {
                        *step += 1;
                        *since = Instant::now();
                    }
                    1 if since.elapsed() >= MEASURE => {
                        let rms = (full.0 / full.1.max(1) as f64).sqrt();
                        if rms > 1e-4 {
                            *step = 2;
                            set_webview_volume(&tree, quiet);
                        } else {
                            // Too quiet to tell (a gap between songs): measure again.
                            *step = 0;
                            *full = (0.0, 0);
                        }
                        *since = Instant::now();
                    }
                    3 if since.elapsed() >= MEASURE => {
                        let full_rms = (full.0 / full.1.max(1) as f64).sqrt();
                        let quiet_rms = (q.0 / q.1.max(1) as f64).sqrt();
                        let g = super::calibrated_gain(full_rms, quiet_rms, quiet);
                        log::info!("audio share: full {full_rms:.5}, turned down {quiet_rms:.7}, gain {g}");
                        gain = Gain::Fixed(g);
                    }
                    _ => {}
                }
                continue;
            }
            if primed {
                match render.write(&mut queue, block) {
                    Ok(true) => {}
                    Ok(false) => primed = false, // ran dry: build up a little again before playing
                    Err(_) => {
                        render_errors += 1;
                        render = reopen(&fmt, render_errors)?;
                        primed = false;
                    }
                }
            }
            // Idle (paused): stop the output stream so it doesn't keep the PC awake.
            if last_data.elapsed() > Duration::from_secs(2) {
                queue.clear();
                render.pause();
                primed = false;
            }
        }
        render.pause();
        unsafe {
            let _ = capture.client.Stop();
        }
        Ok(())
    }

    fn reopen(fmt: &WAVEFORMATEX, errors: u32) -> std::result::Result<Render, String> {
        if errors > 20 {
            return Err("the audio output device kept failing".into());
        }
        std::thread::sleep(Duration::from_millis(100));
        Render::open(fmt).map_err(|e| format!("no audio output device: {e}"))
    }

    // ---- capture: process loopback of the WebView2 process tree ---------------------------------

    struct Capture {
        client: IAudioClient,
        reader: IAudioCaptureClient,
        event: HANDLE,
        block: usize,
    }

    impl Drop for Capture {
        fn drop(&mut self) {
            unsafe {
                let _ = self.client.Stop();
                let _ = CloseHandle(self.event);
            }
        }
    }

    #[implement(IActivateAudioInterfaceCompletionHandler)]
    struct Activated(Mutex<Option<mpsc::Sender<()>>>);

    impl IActivateAudioInterfaceCompletionHandler_Impl for Activated_Impl {
        fn ActivateCompleted(&self, _op: Ref<IActivateAudioInterfaceAsyncOperation>) -> windows::core::Result<()> {
            if let Some(tx) = self.0.lock().unwrap_or_else(|e| e.into_inner()).take() {
                let _ = tx.send(());
            }
            Ok(())
        }
    }

    impl Capture {
        /// Opens the capture in 32-bit float, or 16-bit PCM where float is refused.
        fn open(pid: u32) -> std::result::Result<(Capture, WAVEFORMATEX), String> {
            match Self::open_as(pid, &format(true)) {
                Ok(c) => Ok((c, format(true))),
                Err(_) => Self::open_as(pid, &format(false)).map(|c| (c, format(false))),
            }
        }

        fn open_as(pid: u32, fmt: &WAVEFORMATEX) -> std::result::Result<Capture, String> {
            Self::try_open(pid, fmt).map_err(|e| format!("Windows refused to capture the app's audio (needs Windows 11 or Windows 10 build 20348+): {e}"))
        }

        fn try_open(pid: u32, fmt: &WAVEFORMATEX) -> windows::core::Result<Capture> {
            unsafe {
                let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
                    ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
                    Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                        ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                            TargetProcessId: pid,
                            ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
                        },
                    },
                };
                let prop = PROPVARIANT {
                    Anonymous: PROPVARIANT_0 {
                        Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                            vt: VT_BLOB,
                            wReserved1: 0,
                            wReserved2: 0,
                            wReserved3: 0,
                            Anonymous: PROPVARIANT_0_0_0 {
                                blob: BLOB {
                                    cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                                    pBlobData: &mut params as *mut _ as *mut u8,
                                },
                            },
                        }),
                    },
                };
                let (tx, rx) = mpsc::channel();
                let handler: IActivateAudioInterfaceCompletionHandler = Activated(Mutex::new(Some(tx))).into();
                let op = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, &IAudioClient::IID, Some(&prop), &handler)?;
                // The PROPVARIANT only borrows `params`; never let it run a destructor.
                std::mem::forget(prop);
                rx.recv_timeout(Duration::from_secs(5)).map_err(|_| windows::core::Error::from(HRESULT(0x800705B4u32 as i32)))?; // ERROR_TIMEOUT
                let mut hr = HRESULT(0);
                let mut unknown = None;
                op.GetActivateResult(&mut hr, &mut unknown)?;
                hr.ok()?;
                let client: IAudioClient = unknown.ok_or_else(|| windows::core::Error::from(HRESULT(0x80004005u32 as i32)))?.cast()?;
                client.Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                    2_000_000, // 200 ms
                    0,
                    fmt,
                    None,
                )?;
                let event = CreateEventW(None, false, false, None)?;
                client.SetEventHandle(event)?;
                let reader: IAudioCaptureClient = client.GetService()?;
                client.Start()?;
                Ok(Capture { client, reader, event, block: fmt.nBlockAlign as usize })
            }
        }

        /// Appends every waiting packet to `queue`, multiplied by `gain`. The level of what was
        /// read (before the gain), or None when nothing was waiting.
        fn read(&self, queue: &mut VecDeque<u8>, float: bool, gain: f32) -> windows::core::Result<Option<super::Level>> {
            let mut got: Option<super::Level> = None;
            unsafe {
                loop {
                    if self.reader.GetNextPacketSize()? == 0 {
                        break;
                    }
                    let mut data = std::ptr::null_mut();
                    let mut frames = 0u32;
                    let mut flags = 0u32;
                    self.reader.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
                    let bytes = frames as usize * self.block;
                    let silent = flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data.is_null();
                    let mut level = super::Level { n: frames as u64 * 2, ..Default::default() };
                    if silent {
                        queue.extend(std::iter::repeat_n(0u8, bytes));
                    } else {
                        let mut packet = std::slice::from_raw_parts(data, bytes).to_vec();
                        level = super::apply_gain(&mut packet, float, gain);
                        queue.extend(packet);
                    }
                    self.reader.ReleaseBuffer(frames)?;
                    let g = got.get_or_insert_with(Default::default);
                    g.peak = g.peak.max(level.peak);
                    g.sum_sq += level.sum_sq;
                    g.n += level.n;
                }
            }
            Ok(got)
        }
    }

    // ---- render: the default output device, from this process ----------------------------------

    struct Render {
        client: IAudioClient,
        writer: IAudioRenderClient,
        frames: u32,
        running: bool,
        id: String,
    }

    impl Render {
        fn open(fmt: &WAVEFORMATEX) -> windows::core::Result<Render> {
            unsafe {
                let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
                let device = devices.GetDefaultAudioEndpoint(eRender, eConsole)?;
                let id = device_id(&device);
                let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;
                client.Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                    1_000_000, // 100 ms
                    0,
                    fmt,
                    None,
                )?;
                let frames = client.GetBufferSize()?;
                let writer: IAudioRenderClient = client.GetService()?;
                Ok(Render { client, writer, frames, running: false, id })
            }
        }

        /// Moves as much of `queue` as fits into the device buffer. False when the device ran dry.
        fn write(&mut self, queue: &mut VecDeque<u8>, block: usize) -> windows::core::Result<bool> {
            unsafe {
                let padding = self.client.GetCurrentPadding()?;
                let dry = self.running && padding == 0;
                let n = ((self.frames - padding) as usize).min(queue.len() / block);
                if n > 0 {
                    let buf = self.writer.GetBuffer(n as u32)?;
                    let out = std::slice::from_raw_parts_mut(buf, n * block);
                    for (o, b) in out.iter_mut().zip(queue.drain(..n * block)) {
                        *o = b;
                    }
                    self.writer.ReleaseBuffer(n as u32, 0)?;
                }
                if !self.running && n > 0 {
                    self.client.Start()?;
                    self.running = true;
                }
                Ok(!dry)
            }
        }

        fn pause(&mut self) {
            if self.running {
                unsafe {
                    let _ = self.client.Stop();
                    let _ = self.client.Reset();
                }
                self.running = false;
            }
        }
    }

    impl Drop for Render {
        fn drop(&mut self) {
            self.pause();
        }
    }

    fn device_id(device: &IMMDevice) -> String {
        unsafe {
            match device.GetId() {
                Ok(p) => {
                    let s = p.to_string().unwrap_or_default();
                    CoTaskMemFree(Some(p.0 as _));
                    s
                }
                Err(_) => String::new(),
            }
        }
    }

    fn default_device_id() -> Option<String> {
        unsafe {
            let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
            let device = devices.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
            Some(device_id(&device))
        }
    }

    // ---- the WebView2 processes and their audio sessions ---------------------------------------

    /// (pid, parent pid, exe name) of every running process.
    fn processes() -> Vec<(u32, u32, String)> {
        let mut out = Vec::new();
        unsafe {
            let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
            let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            if Process32FirstW(snap, &mut e).is_ok() {
                loop {
                    let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                    out.push((e.th32ProcessID, e.th32ParentProcessID, String::from_utf16_lossy(&e.szExeFile[..len])));
                    if Process32NextW(snap, &mut e).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snap);
        }
        out
    }

    fn is_webview(exe: &str) -> bool {
        exe.eq_ignore_ascii_case("msedgewebview2.exe")
    }

    /// Every WebView2 process under this app: the ones whose audio is relayed (never the app itself).
    fn webview_tree(all: &[(u32, u32, String)]) -> HashSet<u32> {
        let me = std::process::id();
        let mut seen: HashSet<u32> = HashSet::from([me]);
        let mut parents = vec![me];
        let mut tree = HashSet::new();
        while let Some(p) = parents.pop() {
            for (pid, parent, exe) in all {
                if *parent == p && seen.insert(*pid) {
                    parents.push(*pid);
                    if is_webview(exe) {
                        tree.insert(*pid);
                    }
                }
            }
        }
        tree
    }

    /// The WebView2 browser process this app started: the top of the tree, whose children make the
    /// pages' sound (renderers, the audio service).
    fn browser_pid(all: &[(u32, u32, String)]) -> Option<u32> {
        let tree = webview_tree(all);
        all.iter().find(|(pid, parent, _)| tree.contains(pid) && !tree.contains(parent)).map(|(pid, ..)| *pid)
    }

    /// Sets the mixer volume of the audio sessions of `pids` on every output device, and unmutes
    /// them (older versions muted them). True when one of them is playing.
    fn set_webview_volume(pids: &HashSet<u32>, level: f32) -> bool {
        let mut active = false;
        if pids.is_empty() {
            return active;
        }
        unsafe {
            let Ok(devices) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) else { return active };
            let Ok(list) = devices.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) else { return active };
            for i in 0..list.GetCount().unwrap_or(0) {
                let Ok(device) = list.Item(i) else { continue };
                let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue };
                let Ok(sessions) = manager.GetSessionEnumerator() else { continue };
                for j in 0..sessions.GetCount().unwrap_or(0) {
                    let Ok(session) = sessions.GetSession(j) else { continue };
                    let Ok(session2) = session.cast::<IAudioSessionControl2>() else { continue };
                    let Ok(pid) = session2.GetProcessId() else { continue };
                    if !pids.contains(&pid) {
                        continue;
                    }
                    if session.GetState().map(|s| s == AudioSessionStateActive).unwrap_or(false) {
                        active = true;
                    }
                    if let Ok(volume) = session.cast::<ISimpleAudioVolume>() {
                        if volume.GetMute().map(|m| m.as_bool()).unwrap_or(true) {
                            let _ = volume.SetMute(false, std::ptr::null());
                        }
                        if volume.GetMasterVolume().map(|v| (v - level).abs() > 1e-4).unwrap_or(true) {
                            let _ = volume.SetMasterVolume(level, std::ptr::null());
                        }
                    }
                }
            }
        }
        active
    }
}

#[cfg(windows)]
pub use imp::shutdown;

#[cfg(not(windows))]
pub fn shutdown() {}

#[cfg(test)]
mod tests {
    use super::*;

    fn floats(v: &[f32]) -> Vec<u8> {
        v.iter().flat_map(|x| x.to_le_bytes()).collect()
    }

    fn read_floats(b: &[u8]) -> Vec<f32> {
        b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
    }

    #[test]
    fn turned_down_audio_is_boosted_back() {
        let q = quiet_level(true);
        let mut p = floats(&[0.0005, -0.0002, 0.0, -0.0]);
        let l = apply_gain(&mut p, true, 1.0 / q);
        assert!((l.peak - 0.0005).abs() < 1e-9 && l.n == 4 && l.audible());
        let out = read_floats(&p);
        assert!((out[0] - 0.5).abs() < 1e-4 && (out[1] + 0.2).abs() < 1e-4, "{out:?}");
    }

    #[test]
    fn negative_zero_is_silence() {
        // Muted float audio comes back as -0.0, whose bytes aren't all zero.
        let mut p = floats(&[-0.0, -0.0, 0.0]);
        assert!(!apply_gain(&mut p, true, 1.0).audible());
    }

    #[test]
    fn full_level_audio_is_never_boosted() {
        // A session that hasn't been turned down yet: passed through, not blown up.
        let mut p = floats(&[0.5, -0.3]);
        apply_gain(&mut p, true, 1000.0);
        assert_eq!(read_floats(&p), vec![0.5, -0.3]);
    }

    #[test]
    fn pcm_is_boosted_too() {
        let mut p: Vec<u8> = [500i16, -500].iter().flat_map(|x| x.to_le_bytes()).collect();
        let l = apply_gain(&mut p, false, 10.0);
        assert!(l.audible());
        let out: Vec<i16> = p.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect();
        assert!((out[0] - 5000).abs() <= 1 && (out[1] + 5000).abs() <= 1, "{out:?}");
    }

    #[test]
    fn gain_follows_how_the_capture_reacts_to_the_mixer() {
        let q = quiet_level(true);
        // The capture dropped with the mixer volume (what silenced the music): boost.
        assert_eq!(calibrated_gain(0.2, 0.0002, q), 1.0 / q);
        assert_eq!(calibrated_gain(0.2, 0.0, q), 1.0 / q);
        // The capture kept its level (louder or quieter music in the second moment): no boost.
        assert_eq!(calibrated_gain(0.2, 0.1, q), 1.0);
        assert_eq!(calibrated_gain(0.2, 0.4, q), 1.0);
    }
}
