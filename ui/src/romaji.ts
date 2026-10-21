// Kana → Hepburn romaji for lyrics and metadata. Kanji need a dictionary (see TODO.md), so text
// containing kanji is only partly romanized; the original is always kept and shown alongside.
const H: Record<string, string> = {
  あ: "a", い: "i", う: "u", え: "e", お: "o", か: "ka", き: "ki", く: "ku", け: "ke", こ: "ko",
  さ: "sa", し: "shi", す: "su", せ: "se", そ: "so", た: "ta", ち: "chi", つ: "tsu", て: "te", と: "to",
  な: "na", に: "ni", ぬ: "nu", ね: "ne", の: "no", は: "ha", ひ: "hi", ふ: "fu", へ: "he", ほ: "ho",
  ま: "ma", み: "mi", む: "mu", め: "me", も: "mo", や: "ya", ゆ: "yu", よ: "yo",
  ら: "ra", り: "ri", る: "ru", れ: "re", ろ: "ro", わ: "wa", ゐ: "wi", ゑ: "we", を: "o", ん: "n",
  が: "ga", ぎ: "gi", ぐ: "gu", げ: "ge", ご: "go", ざ: "za", じ: "ji", ず: "zu", ぜ: "ze", ぞ: "zo",
  だ: "da", ぢ: "ji", づ: "zu", で: "de", ど: "do", ば: "ba", び: "bi", ぶ: "bu", べ: "be", ぼ: "bo",
  ぱ: "pa", ぴ: "pi", ぷ: "pu", ぺ: "pe", ぽ: "po", ぁ: "a", ぃ: "i", ぅ: "u", ぇ: "e", ぉ: "o", ゔ: "vu",
  "ー": "-", "、": ", ", "。": ". ", "「": '"', "」": '"', "！": "!", "？": "?", "　": " ",
};
const Y: Record<string, string> = { ゃ: "ya", ゅ: "yu", ょ: "yo" };

function kataToHira(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

export const hasJapanese = (s: string) => /[぀-ヿ一-鿿]/.test(s);
export const hasKana = (s: string) => /[぀-ヿ]/.test(s);

export function toRomaji(input: string): string {
  const s = kataToHira(input);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const n = s[i + 1];
    if (c === "っ") {
      const r = H[n] ?? "";
      out += r && /^[a-z]/.test(r) ? (r.startsWith("ch") ? "t" : r[0]) : "";
      continue;
    }
    if (n && Y[n]) {
      const base = H[c];
      if (base && base.length >= 2 && base.endsWith("i")) {
        const stem = base.slice(0, -1);
        const y = Y[n];
        out += stem === "sh" || stem === "ch" || stem === "j" ? stem + y.slice(1) : stem + y;
        i++;
        continue;
      }
    }
    if (c === "ん" && n && /[aiueoy]/.test((H[n] ?? "")[0] ?? "")) {
      out += "n'";
      continue;
    }
    out += H[c] ?? (Y[c] ?? c);
  }
  return out.replace(/([aeiou])-/g, "$1$1");
}

/** [main, secondary] text according to the Japanese display setting. */
export function displayText(text: string, mode: "original" | "romaji" | "both"): [string, string | null] {
  if (mode === "original" || !hasKana(text)) return [text, null];
  const r = toRomaji(text);
  return mode === "romaji" ? [r, null] : [text, r];
}
