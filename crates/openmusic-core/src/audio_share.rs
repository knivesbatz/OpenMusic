//! "Share audio with Discord" (Windows).
//!
//! Discord's Go Live (and OBS's application audio capture) records the audio of the process that
//! owns the shared window. The app's windows belong to YTSpot.exe / PLEXSpot.exe, but its sound is
//! made by the WebView2 runtime in separate msedgewebview2.exe processes, so a shared window, the
//! mini player included, streams without audio.
//!
//! When the setting is on, a relay thread records the WebView2 processes' audio with Windows
//! process loopback (Windows 10 build 20348 / Windows 11 and later), plays it again from the app's
//! own process, and mutes the WebView2 audio sessions so the music is heard once. Process loopback
//! taps a stream before the volume mixer's per-app mute. If on some system it doesn't (the capture
//! stays silent while WebView2 plays), the relay unmutes WebView2, stops and tells the UI why.

use crate::error::{Error, Result};

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
        mute_webview(&webview_tree(&processes()), false);
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

    fn relay(stop: &AtomicBool, ready: &mut Option<mpsc::Sender<std::result::Result<(), String>>>) -> std::result::Result<(), String> {
        let mut browser = browser_pid(&processes()).ok_or("the app's WebView2 process was not found")?;
        let (mut capture, fmt) = Capture::open(browser)?;
        let mut render = Render::open(&fmt).map_err(|e| format!("no audio output device: {e}"))?;
        let block = fmt.nBlockAlign as usize;
        if let Some(tx) = ready.take() {
            let _ = tx.send(Ok(()));
        }

        let mut queue: VecDeque<u8> = VecDeque::new();
        let mut primed = false;
        let mut last_data = Instant::now();
        let mut last_check = Instant::now() - Duration::from_secs(10);
        let mut heard = false;
        let mut silent_since: Option<Instant> = None;
        let mut render_errors = 0;

        while !stop.load(Ordering::SeqCst) {
            unsafe { WaitForSingleObject(capture.event, 20) };
            match capture.read(&mut queue) {
                Ok(Some(loud)) => {
                    heard |= loud;
                    last_data = Instant::now();
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

            // Often enough that a new WebView2 audio session is muted before it is heard twice.
            if last_check.elapsed() >= Duration::from_millis(300) {
                last_check = Instant::now();
                let all = processes();
                let active = mute_webview(&webview_tree(&all), true);
                // WebView2 plays but the capture hears nothing: the mute reached the capture too.
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

        /// Appends every waiting packet to `queue`. Some(true) when any of it was audible.
        fn read(&self, queue: &mut VecDeque<u8>) -> windows::core::Result<Option<bool>> {
            let mut got = None;
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
                    let mut loud = false;
                    if silent {
                        queue.extend(std::iter::repeat_n(0u8, bytes));
                    } else {
                        let slice = std::slice::from_raw_parts(data, bytes);
                        loud = slice.iter().any(|&b| b != 0);
                        queue.extend(slice.iter().copied());
                    }
                    self.reader.ReleaseBuffer(frames)?;
                    got = Some(got.unwrap_or(false) | loud);
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

    /// Mutes (or unmutes) the audio sessions of `pids` on every output device. True when one of
    /// them is playing.
    fn mute_webview(pids: &HashSet<u32>, mute: bool) -> bool {
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
                        if volume.GetMute().map(|m| m.as_bool() != mute).unwrap_or(true) {
                            let _ = volume.SetMute(mute, std::ptr::null());
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
