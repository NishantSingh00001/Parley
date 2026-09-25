// A light filter for the public rooms: masks common abusive words (English + Hinglish).
const WORDS = ["fuck", "fucking", "shit", "bitch", "bastard", "asshole", "dick", "cunt", "slut", "whore", "madarchod", "behenchod", "bhenchod", "chutiya", "chutiye", "gandu", "bhosdike", "randi", "harami", "lodu", "lauda"];
const RE = new RegExp(`\\b(${WORDS.join("|")})\\b`, "gi");

export function clean(text) {
  return String(text).replace(RE, (w) => w[0] + "•".repeat(Math.max(1, w.length - 1)));
}
