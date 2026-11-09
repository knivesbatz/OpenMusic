// YouTube Music downloads: works out a song's audio stream (where to fetch it and how big it is),
// then Rust fetches it in ranges (downloads.rs `run_youtube`). The approach follows
// github.com/Chaitanya-Shahare/ytspot (MIT, src/main/downloads.ts and botguard.ts):
// - youtubei.js asks YouTube for the song's streams as the YouTube Music web client, and works out
//   the stream URL's scrambled signature by running YouTube's own player script;
// - YouTube's media servers stop after the first megabyte without a PO token ("proof of origin"),
//   which BotGuard (Google's anti-abuse VM, run here with LuanRT's bgutils-js) mints per video. It
//   needs a real browser: this web view is one.
// Every request goes through Rust (`yt_fetch`, YouTube and Google hosts only), so YouTube's CORS
// rules don't apply. Rust signs the YouTube API requests in as the user's account when they're
// signed in (Premium songs need that); BotGuard's requests are never signed in.
import { invoke } from "@tauri-apps/api/core";
import type { Track } from "./types";

/** fetch() through Rust (see commands.rs `yt_fetch`). */
export async function ytFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = new Request(input, init);
  const headers: [string, string][] = [];
  req.headers.forEach((v, k) => headers.push([k, v]));
  const body = req.method === "GET" || req.method === "HEAD" ? null : Array.from(new Uint8Array(await req.arrayBuffer()));
  const raw = await invoke<ArrayBuffer>("yt_fetch", { url: req.url, method: req.method, headers, body });
  const n = new DataView(raw).getUint32(0);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(raw, 4, n))) as { status: number; headers: [string, string][] };
  const h = new Headers();
  for (const [k, v] of meta.headers) {
    try {
      h.append(k, v);
    } catch {
      /* a header the browser won't hold */
    }
  }
  const empty = meta.status === 204 || meta.status === 205 || meta.status === 304;
  return new Response(empty ? null : raw.slice(4 + n), { status: meta.status, headers: h });
}

// ---- BotGuard: PO tokens --------------------------------------------------------------------------

// The request key YouTube's own web player uses.
const REQUEST_KEY = "O43z0dpjhgX20SCx4KAo";

type Minter = { mint: (videoId: string) => Promise<string>; expires: number };
let minter: Promise<Minter> | null = null;

async function startMinter(): Promise<Minter> {
  const { BotGuardClient, getChallenge, buildURL, getHeaders } = await import("bgutils-js/botguard").then(async (b) => ({ ...b, ...(await import("bgutils-js/utils")) }));
  const { WebPoMinter } = await import("bgutils-js/webpo");
  const challenge = await getChallenge({ requestKey: REQUEST_KEY, fetchFunction: ytFetch as typeof fetch });
  const interpreter = challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
  if (!interpreter || !challenge.program || !challenge.globalName) throw new Error("BotGuard sent no challenge");
  // BotGuard's VM, as YouTube's web player loads it.
  new Function(interpreter)();
  const client = await BotGuardClient.create({ program: challenge.program, globalName: challenge.globalName, globalObject: globalThis });
  const signals: Parameters<typeof WebPoMinter.create>[1] = [];
  const answer = await client.snapshot({ webPoSignalOutput: signals });
  const res = await ytFetch(buildURL("GenerateIT"), { method: "POST", headers: getHeaders(), body: JSON.stringify([REQUEST_KEY, answer]) });
  if (!res.ok) throw new Error(`BotGuard refused (${res.status})`);
  const [token, ttl] = (await res.json()) as [string, number];
  const m = await WebPoMinter.create({ integrityToken: token }, signals);
  // Tokens last `ttl` seconds (12 hours); start over a little before that.
  return { mint: (v) => m.mintAsWebsafeString(v), expires: Date.now() + Math.max(60, (ttl ?? 3600) - 300) * 1000 };
}

async function poToken(videoId: string): Promise<string> {
  let m = await (minter ??= startMinter().catch((e) => ((minter = null), Promise.reject(e))));
  if (Date.now() > m.expires) {
    minter = null;
    m = await (minter = startMinter().catch((e) => ((minter = null), Promise.reject(e))));
  }
  return m.mint(videoId);
}

/** Drop the minter (YouTube stopped accepting its tokens); the next token starts afresh. */
export function resetPoTokens() {
  minter = null;
}

// ---- The song's audio stream ----------------------------------------------------------------------

type Innertube = Awaited<ReturnType<typeof import("youtubei.js/web").Innertube.create>>;
let session: Promise<Innertube> | null = null;

async function innertube(): Promise<Innertube> {
  const { Innertube, Platform } = await import("youtubei.js/web");
  // Stream URLs carry a scrambled signature that only YouTube's player script can work out; let
  // youtubei.js run that script (YouTube's own code, fetched from youtube.com).
  Platform.shim.eval = async (data: { output: string }, env: Record<string, unknown>) => {
    const out = [env.n && `n: exportedVars.nFunction(${JSON.stringify(env.n)})`, env.sig && `sig: exportedVars.sigFunction(${JSON.stringify(env.sig)})`];
    return new Function(`${data.output}\nreturn { ${out.filter(Boolean).join(", ")} }`)();
  };
  return Innertube.create({ retrieve_player: true, generate_session_locally: true, fetch: ytFetch as typeof fetch });
}

export interface AudioStream {
  url: string;
  size: number;
  ext: "m4a" | "webm";
}

/** Where to fetch a song's audio (AAC when there is one: it plays in every web view, Safari's
 * included) and how big it is. */
/** What a signed-in session's media PO token is bound to: the account's data sync id
 * (`<delegated>||<user>`: the delegated, i.e. brand-account, part when there is one). Null when
 * signed out. */
async function accountBinding(): Promise<string | null> {
  const id = await invoke<string | null>("yt_datasync_id").catch(() => null);
  if (!id) return null;
  const [delegated, user] = id.split("||");
  return delegated || user || null;
}

/** `gvs`: bind the media URL's PO token to this instead of the video (a signed-in account's data
 * sync id, tried when YouTube refused the first one). */
export async function audioStream(videoId: string, gvs?: string): Promise<AudioStream> {
  const yt = await (session ??= innertube().catch((e) => ((session = null), Promise.reject(e))));
  const pot = await poToken(videoId);
  const info = await yt.getBasicInfo(videoId, { client: "YTMUSIC", po_token: pot });
  // Region-blocked, private, removed…: YouTube's own reason.
  const play = info.playability_status;
  if (play && play.status !== "OK") throw new Error(play.reason || "This song can't be played here");
  const audio = (info.streaming_data?.adaptive_formats ?? []).filter((f) => f.has_audio && !f.has_video && !f.is_drc);
  const best = (xs: typeof audio) => xs.reduce<(typeof audio)[number] | undefined>((a, b) => (!a || (b.bitrate ?? 0) > (a.bitrate ?? 0) ? b : a), undefined);
  const format = best(audio.filter((f) => f.mime_type.startsWith("audio/mp4"))) ?? best(audio.filter((f) => f.mime_type.startsWith("audio/webm")));
  if (!format || !format.content_length) throw new Error("No audio for this song");
  const url = new URL(await format.decipher(yt.session.player));
  if (gvs) url.searchParams.set("pot", await poToken(gvs));
  else if (!url.searchParams.has("pot")) url.searchParams.set("pot", pot);
  return { url: url.toString(), size: format.content_length, ext: format.mime_type.startsWith("audio/webm") ? "webm" : "m4a" };
}

// ---- Downloading ------------------------------------------------------------------------------------

const PARALLEL = 2;

/** Download YouTube songs (already queued in Rust: `yt_download_queue`), a couple at a time.
 * Returns the titles that failed. */
export async function downloadYouTube(tracks: Track[]): Promise<string[]> {
  const failed: string[] = [];
  const todo = [...tracks];
  const one = async (t: Track) => {
    const videoId = t.streamKey ?? t.id.replace(/^yt:/, "");
    const attempt = async (gvs?: string) => {
      const s = await audioStream(videoId, gvs);
      await invoke("yt_download", { track: t, url: s.url, size: s.size, ext: s.ext });
    };
    try {
      try {
        await attempt();
      } catch (e) {
        // YouTube's media server refused the token (403): once more with a fresh minter, bound to
        // the signed-in account when there is one (how YouTube's own player does it then).
        if (!String((e as { message?: string })?.message ?? e).includes("(403)")) throw e;
        resetPoTokens();
        await attempt((await accountBinding()) ?? undefined);
      }
    } catch (e) {
      const message = (e as { message?: string })?.message ?? String(e);
      failed.push(t.title);
      // Errors from the download itself are recorded by Rust; these are from working out the stream.
      await invoke("yt_download_failed", { id: t.id, error: message }).catch(() => {});
    }
  };
  await Promise.all(
    Array.from({ length: PARALLEL }, async () => {
      for (let t = todo.shift(); t; t = todo.shift()) await one(t);
    }),
  );
  return failed;
}
