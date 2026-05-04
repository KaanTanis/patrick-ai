import pc from "picocolors";
import { register } from "./registry.js";
import { rememberNote, recallNotes } from "../state.js";

register({
  name: "memory_remember",
  description:
    "Kullanıcı hakkında ya da makinesi hakkında kalıcı bir not kaydeder. " +
    "Örn: tercih ettiği proje yolu, sık kullanılan servis adları, kişisel kısaltmalar. " +
    "Sadece kullanıcı 'bunu hatırla' dediğinde ya da açıkça yararlı olacak bir gerçek öğrenildiğinde kullan. " +
    "Şifre, anahtar, kişisel veri KAYDETME.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "Hatırlanacak gerçek, tek cümle." },
      tags: { type: "array", items: { type: "string" }, description: "İsteğe bağlı etiketler" },
    },
    required: ["text"],
  },
  async handler({ text, tags = [] }) {
    if (!text || !text.trim()) return { ok: false, output: "text boş olamaz" };
    const note = rememberNote(text, tags);
    console.log(pc.dim(`  ↳ memory: not eklendi (${note.id})`));
    return { ok: true, output: `Not kaydedildi (id=${note.id}): ${note.text}` };
  },
});

register({
  name: "memory_recall",
  description: "Hafızadan ilgili notları getirir. 'query' boşsa son notları döndürür.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "number", description: "Varsayılan 10" },
    },
  },
  async handler({ query = "", limit = 10 }) {
    const notes = recallNotes(query, limit);
    if (notes.length === 0) return { ok: true, output: "(eşleşen not yok)" };
    const lines = notes.map((n) => `[${n.id}] ${n.text}` + (n.tags?.length ? ` (#${n.tags.join(", #")})` : ""));
    return { ok: true, output: lines.join("\n") };
  },
});
