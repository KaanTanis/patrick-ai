# Patrick

> **ChatGPT destekli, hafızalı, web UI'lı akıllı terminal asistanı.**
> Bilgisayarına gerçek shell ve dosya sistemi erişimi olan; ne yaptığını sana açıklayan,
> tehlikeli işler için onay isteyen, öğrendiklerini hatırlayan kişisel sysadmin/dev asistanın.

```
> 3000 ve 3001 portunu kapat
patrick: kill_port'u çağırıyorum, üç sürec görüyorum: node, node, ruby.

┌─ kill_port
│ portlar: 3000, 3001
│ sinyal : SIGTERM (-15)
│ hedef  :
│   • node (PID 43329, user kaan, *:3000)
│   • node (PID 43686, user kaan, *:3001)
└─
3 süreci sonlandırayım mı? [y/N/a=her zaman izin] y

✓ node (PID 43329) → kill -15
✓ node (PID 43686) → kill -15

patrick: 3000 ve 3001 portları boşaltıldı.
```

---

## İçindekiler

- [Özellikler](#özellikler)
- [Kurulum](#kurulum)
- [İlk çalıştırma](#i̇lk-çalıştırma)
- [Kullanım modları](#kullanım-modları)
- [Slash komutları](#slash-komutları)
- [Tool'lar (Patrick'in elindeki yetenekler)](#toollar-patrickin-elindeki-yetenekler)
- [Güvenlik mimarisi](#güvenlik-mimarisi)
- [Hafıza sistemi](#hafıza-sistemi)
- [Web UI](#web-ui)
- [Yapılandırma (.env)](#yapılandırma-env)
- [Dosya/dizin haritası](#dosyadizin-haritası)
- [Özelleştirme](#özelleştirme)
- [Bilinen kısıtlar](#bilinen-kısıtlar)
- [SSS](#sss)
- [Lisans](#lisans)

---

## Özellikler

- **Tool calling** — OpenAI function calling ile shell, dosya sistemi, port yönetimi, hafıza işlemleri.
- **Üç kademeli izin sistemi**: `safe` (onaysız) / `approve` (sorar) / `forbidden` (asla).
- **Kalıcı izinler** — bir komuta "her zaman izin ver" dediğinde regex kalıbı `~/.patrick/permissions.json`'a yazılır.
- **Hafıza** — model, kullanıcı tercihlerini ve sık kullanılan bilgileri kalıcı olarak saklayabilir; sonraki oturumlar bunu görür.
- **Web UI** — `http://127.0.0.1:7878` üzerinde modern bir sohbet arayüzü; **terminal ile aynı oturumu canlı paylaşır.**
- **Çift kanallı onay** — onay sorularına hem terminalden hem tarayıcıdan cevap verilebilir; ilk cevap kazanır.
- **Renkli, açıklamalı çıktı** — her komut çağrılmadan önce *amaç*, *risk seviyesi* ve *gerekçe* gösterilir.
- **Kalıcı oturum logları** — her oturum `~/.patrick/sessions/<timestamp>.json`'a kaydedilir.
- **Tek dosya yapılandırması** — `~/ai-terminal/.env` ile model, port, otomatik onay vb. ayarlanır.
- **Sıfır build adımı** — saf Node.js (ES modülleri); `npm install` yeter.

---

## Kurulum

### Gereksinimler

| | |
|---|---|
| OS | macOS (Linux'ta da çalışır; macOS'a göre ayarlandı) |
| Node.js | ≥ 18 |
| OpenAI API key | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |

### Adımlar

```bash
git clone <repo-url> ~/ai-terminal      # ya da bu dizini koruyarak ilerle
cd ~/ai-terminal
npm install
cp .env.example .env                     # ardından OPENAI_API_KEY'i doldur
```

### `patrick` komutunu PATH'e ekle

`~/.zshrc`'ye:

```bash
# >>> patrick (ChatGPT destekli terminal asistanı) >>>
export PATRICK_HOME="$HOME/ai-terminal"
export PATH="$PATRICK_HOME/bin:$PATH"
# <<< patrick <<<
```

Sonra yeni bir terminal aç (veya `source ~/.zshrc`).

---

## İlk çalıştırma

```bash
patrick
```

Karşına şu çıkar:

```
  patrick  ChatGPT destekli akıllı terminal
  model: gpt-4o   cwd: ~/projects   auto-approve: OFF
  web ui: http://127.0.0.1:7878  (terminalle senkron)
  /help yardım  •  /exit çıkış  •  Ctrl+C iptal/çıkış

(~/projects) you ❯
```

Tarayıcıdan da [http://127.0.0.1:7878](http://127.0.0.1:7878) açabilirsin — aynı oturumu görürsün.

---

## Kullanım modları

| Komut | Davranış |
|---|---|
| `patrick` | İnteraktif REPL + web UI |
| `patrick "soru / komut"` | Soruyu çalıştır, **sonra REPL'de kal** |
| `patrick -p "soru"` | Tek seferlik (script-friendly): cevabı verir, çıkar — **web UI başlatmaz** |
| `patrick --no-web` | Web UI'sız REPL |
| `patrick --help` | Yardım |
| `patrick --version` | Sürüm |

Ayrıca `p` kısa alias'ı: `p "saat kaç"`.

---

## Slash komutları

REPL içinde:

| Komut | Açıklama |
|---|---|
| `/exit`, `/quit`, `Ctrl+D` | Çıkış |
| `/clear` | Konuşma geçmişini sıfırla (system prompt korunur) |
| `/help` | Yardımı göster |
| `/cwd <yol>` | Çalışma dizinini değiştir (`~` desteklenir) |
| `/auto on\|off` | Otomatik onay modunu aç/kapat ⚠️ |
| `/model <ad>` | Çalışan modeli değiştir, geçmiş sıfırlanır |
| `/web` | Web UI URL'sini göster ve tarayıcıda aç |
| `/perms` | Kalıcı izin/yasak kalıplarını listele |
| `/perms clear` | Tüm "her zaman izinli" kuralları sil |
| `/memory` | Hafızadaki tüm notları göster |
| `/forget <id>` | Bir hafıza notunu sil |

**Ctrl+C davranışı**: Yazı yazıyorsan satırı temizler. Boş satırdaysan ilk basışta uyarır, 1.5sn içinde ikinci basışta çıkar (yanlışlıkla terminali kapatmazsın).

---

## Tool'lar (Patrick'in elindeki yetenekler)

Model bu fonksiyonları otomatik çağırır; her birinin parametre şeması API'ya tanıtılmıştır.

### Shell & dosya sistemi

| Tool | Açıklama |
|---|---|
| `run_shell(command, purpose, cwd?, timeout_sec?)` | Genel shell komutu. `purpose` zorunludur, kullanıcıya gösterilir. |
| `read_file(path, max_bytes?)` | Dosya içeriğini oku. Varsayılan üst sınır 200 KB. |
| `write_file(path, content, purpose)` | Dosyaya yaz. Sistem dizinleri yasak. |
| `list_dir(path?)` | Dizin içeriğini listele. |

### Yüksek-seviye sistem yönetimi

| Tool | Açıklama |
|---|---|
| `kill_port(ports[], force?)` | Verilen TCP portlarını dinleyen süreçleri bul ve sonlandır. |
| `list_ports(ports?)` | Dinlenen TCP portlarını listele. |
| `find_process(query)` | `ps aux` çıktısında bir desene uyan süreçleri bul. |

### Hafıza

| Tool | Açıklama |
|---|---|
| `memory_remember(text, tags?)` | Kalıcı bir not ekle (`~/.patrick/memory.json`'a yazılır). |
| `memory_recall(query?, limit?)` | Hafızadan eşleşen notları getir. |

> **Not**: Model, sadece tekrar tekrar işine yarayacak gerçekleri kaydetmesi (proje yolları, takma adlar, sık kullanılan portlar vb.) için talimatlandırılmıştır. Şifre/anahtar/token KAYDETMEZ.

---

## Güvenlik mimarisi

Patrick, kendi ifade ettiği komutları **3 kademeli politika**dan geçirir:

| Seviye | Davranış | Örnek |
|---|---|---|
| 🟢 **safe** | Sorgusuz çalıştırır | `ls`, `pwd`, `git status`, `lsof`, `ps` |
| 🟡 **approve** | Kullanıcıdan onay ister | `rm`, `mv`, `kill`, `sudo`, `npm install`, `git push`, dosyaya `>` yönlendirme |
| 🔴 **forbidden** | Kesinlikle çalıştırılmaz | `rm -rf /`, `mkfs`, `shutdown`, fork bomb, `dd ... of=/dev/sda` |

Onay sorulduğunda 3 seçenek vardır:

```
Bu komutu çalıştırmama izin veriyor musun? [y/N/a=her zaman izin]
```

- **y** → tek seferlik izin
- **N** (varsayılan) → reddet
- **a** → komuttan üretilen bir regex kalıbını **kalıcı izinli** olarak `~/.patrick/permissions.json`'a kaydet. Bir daha bu kalıba uyan komutlar onaysız çalışır.

`/perms` ile listeleyebilir, `/perms clear` ile tümünü silebilirsin. JSON'u elle de düzenleyebilirsin:

```json
{
  "allow_patterns": ["^kill \\d+$", "^npm install\\b"],
  "deny_patterns":  ["^rm -rf /Users/kaan/Documents"]
}
```

> **Forbidden listesi mutlaktır** — kullanıcı kendi `allow_patterns`'ine eklese bile geçemez.

### Politikayı özelleştirmek

Kuralların kalbi tek dosya: [`src/safety.js`](src/safety.js). `SAFE_PREFIXES`, `APPROVAL_PATTERNS` ve `FORBIDDEN_PATTERNS` listelerine ekleme yaparak kendi makinende davranışı şekillendirebilirsin.

### Yazma yolu güvenliği

`/etc`, `/usr`, `/bin`, `/sbin`, `/var`, `/System`, `/Library` altına `write_file` ile yazılamaz; sistem dosyalarını koruma altına alır.

---

## Hafıza sistemi

Patrick, kullanıcı hakkında öğrendiği uzun vadeli gerçekleri `~/.patrick/memory.json`'a yazar:

```json
{
  "notes": [
    {
      "id": "abc123de",
      "ts": "2026-05-04T00:24:32.635Z",
      "text": "Kaan'ın ana proje klasörü ~/Code/myapp",
      "tags": ["project"]
    }
  ]
}
```

Yeni bir oturum açıldığında **son 30 not** sistem promtuna enjekte edilir; model bunları "biliyor" olarak başlar.

### Kullanıcı kontrolü

```
> /memory                  # tüm notları listele
> /forget abc123de         # bir notu sil
```

Ya da JSON dosyasını doğrudan düzenle/sil — Patrick bir sonraki başlangıçta yeni durumu kullanır.

---

## Web UI

Patrick başlatıldığında otomatik olarak `127.0.0.1:7878`'de bir HTTP + WebSocket sunucusu açar.

- **Aynı oturum** — terminalden ya da tarayıcıdan ne yazarsan aynı agent'a gider.
- **Canlı senkron** — model çıktıları, tool çağrıları, çıktıları her iki yere de aynı anda yansır.
- **Çift kanallı onay** — onay isteği geldiğinde tarayıcıda modal açılır, terminalde de prompt çıkar; ilk cevap geçerlidir.
- **Sadece localhost** — dış ağdan erişilmez.

Kapatmak için: `.env`'ye `PATRICK_WEB_PORT=0` koy ya da her seferinde `patrick --no-web` ile aç.

Tarayıcıda otomatik açmak için `.env`'ye:

```bash
PATRICK_WEB_OPEN=true
```

---

## Yapılandırma (.env)

Tüm ayarlar `~/ai-terminal/.env` dosyasındadır. `cp .env.example .env` ile başla.

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `OPENAI_API_KEY` | — | **Zorunlu.** OpenAI API anahtarı. |
| `PATRICK_MODEL` | `gpt-4o` | Kullanılacak model (`gpt-4o-mini`, `gpt-4.1`, `o4-mini`, vb.) |
| `PATRICK_AUTO_APPROVE` | `false` | `true` ise tehlikeli komutlar için bile onay sormaz. **Üretim makinelerinde KESİNLİKLE kapalı tutun.** |
| `PATRICK_WEB_PORT` | `7878` | Web UI portu. `0` = web UI başlatma. |
| `PATRICK_WEB_OPEN` | `false` | `true` ise tarayıcı otomatik açılır. |

---

## Dosya/dizin haritası

```
~/ai-terminal/
├── bin/
│   ├── patrick.js              # giriş noktası
│   ├── patrick                 # symlink → patrick.js
│   └── p                       # kısa alias → patrick.js
├── src/
│   ├── cli.js                  # REPL, slash komutları, web sunucu açılışı, ortak confirmer
│   ├── agent.js                # OpenAI function-calling döngüsü, event yayını
│   ├── tools.js                # Tüm tool'lar + pluggable confirmer/emitter
│   ├── safety.js               # 3 kademeli politika, regex kalıpları
│   ├── state.js                # ~/.patrick/'in tek sahibi (perms + memory + sessions)
│   ├── prompt.js               # System prompt + hafıza enjeksiyonu
│   └── web/
│       ├── server.js           # HTTP + WebSocket
│       └── public/
│           ├── index.html
│           ├── style.css       # Dark tema, GitHub'a benzer
│           └── app.js          # Vanilla JS, build-step yok
├── .env                        # GIT'E GİRMEZ
├── .env.example
├── package.json
└── README.md

~/.patrick/                     # Patrick'in kalıcı durumu
├── permissions.json            # "Her zaman izin ver" kalıpları
├── memory.json                 # Kalıcı notlar
└── sessions/                   # Her oturumun event log'u
    └── 2026-05-04T00-24-32-635Z.json

~/.patrick-history              # REPL satır geçmişi (↑/↓ ile gezinir)
```

---

## Özelleştirme

### System prompt'u değiştir

[`src/prompt.js`](src/prompt.js) → `buildSystemPrompt()`. Karakteri, dilini, kuralları burada tanımlarsın.

### Yeni bir tool ekle

[`src/tools.js`](src/tools.js) içinde:

1. `TOOL_SCHEMAS`'a OpenAI function şeması ekle.
2. `runTool` switch'ine yeni case ekle.
3. Implementasyonu yaz.
4. Yıkıcı işlemler için `getDecision()` ile onay iste.

Örnek:

```js
{
  type: "function",
  function: {
    name: "restart_service",
    description: "macOS launchctl ile bir servisi yeniden başlatır.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
}
```

### Güvenlik kurallarını sıkılaştır/gevşet

[`src/safety.js`](src/safety.js) — `SAFE_PREFIXES`, `APPROVAL_PATTERNS`, `FORBIDDEN_PATTERNS` listeleri.

### Web UI temasını değiştir

[`src/web/public/style.css`](src/web/public/style.css) en üstte CSS değişkenleri:

```css
:root {
  --bg: #0d1117;
  --accent: #7ee787;
  --user: #58a6ff;
  /* ... */
}
```

---

## Bilinen kısıtlar

- **Tool iptali**: REPL'de bir tool çalışırken `Ctrl+C` onu kesmiyor (sadece input satırını temizler). Şimdilik `timeout_sec` koruma sağlıyor.
- **Çift onay race**: Tarayıcıdan onay verildiğinde, terminaldeki `readline.question` hâlâ Enter bekler. Sonuç doğru, sadece bir kez Enter'a basman lazım.
- **Tek kullanıcı**: Web UI çoklu istemciye broadcast yapar; ama her şey tek bir agent state'i paylaşır. Aynı anda iki tarayıcıdan farklı istekler göndermek karışıklığa yol açabilir.
- **macOS odaklı**: `lsof`/`ps`/`open` davranışları macOS'a göre. Linux'ta çoğunlukla çalışır, bazı detaylar (örn. `open`) farklı olabilir.
- **Hafıza yönetimi**: Şu an basit bir append-only liste. Çok büyürse system prompt token tüketir; düzenli `/memory` + `/forget` ile temiz tutmakta fayda var.

---

## SSS

**Soru: OpenAI'nin resmi `codex` CLI'ı bunu zaten yapmıyor mu?**
Evet, [github.com/openai/codex](https://github.com/openai/codex) çok daha olgun bir alternatif: OS-level sandbox (macOS Seatbelt / Linux Landlock), MCP, IDE entegrasyonu, GPT-5-Codex modeli. Patrick eğitim/özelleştirme amaçlı bir prototiptir; üretim için Codex CLI önerilir.

**Soru: API ücretlendirmesi nasıl?**
OpenAI API'sini doğrudan kullanır; her tur için input + output token'ı [OpenAI fiyatlandırması](https://openai.com/api/pricing/) üzerinden faturalanır. Tool çağrıları geri besleme ile birlikte token'a dönüşür; karmaşık görevlerde maliyet artabilir.

**Soru: ChatGPT Plus aboneliğim var, onu kullanabilir miyim?**
Hayır, Patrick OpenAI Platform API'sini kullanır; bu ayrı bir ücretlendirmedir. ChatGPT planı entegrasyonu için Codex CLI'a bak.

**Soru: Anahtarımı nereye koyayım?**
Sadece `~/ai-terminal/.env` (`.gitignore`'da) ya da `~/.zshrc`'de `export`. **Asla repository'ye commit etme.**

**Soru: Web UI'ı kapatmak istiyorum.**
`.env`'de `PATRICK_WEB_PORT=0` ya da her seferinde `patrick --no-web`.

**Soru: Auto-approve'u her zaman açık tutmak güvenli mi?**
**Hayır.** Sadece geçici, izole ortamlarda (tek seferlik bir VM, test container'ı) kullan. Ana makinede `OFF` bırak; gerçekten sık kullandığın komutlar için kalıcı izin (`a` cevabı) yeterli.

---

## Lisans

ISC — özgürce kullan, fork'la, değiştir.
