# Mod: pipeline — İlan Gelen Kutusu

`data/pipeline.md` dosyasına biriktirilen iş ilanı URL'lerini işler. İstediğin zaman URL ekle, hazır olduğunda `/career-ops pipeline` komutunu çalıştır.

## Liveness taraması

**Herhangi bir URL işlenmeden önce çalıştırın.** Tarayıcının headless/batch modunda yazdığı kayıtlar `**Verification:** unconfirmed (batch mode)` taşır; çünkü tarama anında Playwright kullanılamıyordu — liveness hiç kontrol edilmedi. Tarama yapılmazsa ölü ilanlar değerlendirmeye teker teker ulaşır ve hayalet roller için zaman ve token yakar.

1. `node check-liveness.mjs --file data/pipeline.md` çalıştırın (büyük partilerde WAF hız limitlerinin altında kalmak için `--throttle` ekleyin; saf Playwright, sıfır Claude tokenı). Checker gelen kutusunu doğrudan okur — `- [ ]` satırlarını alır, `- [x]`/`- [!]` satırlarını ve `local:` kayıtlarını yok sayar ve kaç satır atladığını bildirir. URL'leri önce elle geçici bir dosyaya **kopyalamayın**; o adım token harcar ve pratikte atlanan adım tam olarak odur.
2. Checker her URL için bir karar yazdırır ve herhangi bir URL expired/uncertain olur olmaz sıfırdan farklı bir kodla çıkar.
3. Checker'ın **expired/closed** olarak bildirdiği her URL işlenmek yerine sonuçlandırılır: işlenmişler bölümüne `- [x] ~~URL | Şirket | Rol~~ — ilan süresi doldu (liveness taraması)` biçiminde taşıyın ve tracker satırı zaten varsa `Discarded` yapın. Onun için **hiçbir** çıkarım, değerlendirme veya report/PDF üretimi yapılmaz.
4. `uncertain` sonuçlar yerinde bırakılır ve normal çıkarım sırasında doğrulanır (geçici tek bir zaman aşımı, muhtemelen canlı bir ilanı elemeye yetmemeli).
5. Aşağıdaki işleme döngüsüne yalnızca hayatta kalan canlı URL'ler girer.

## İş Akışı

1. **Oku** `data/pipeline.md` → "Bekleyenler" bölümündeki `- [ ]` satırlarını bul
2. **Her bekleyen URL için:**
   a. Sıradaki `REPORT_NUM` değerini atomik olarak rezerve etmek üzere `node reserve-report-num.mjs` komutunu çalıştır (ve rapor yazıldıktan sonra `node reserve-report-num.mjs --release <num>` çalıştırarak sentineli serbest bırak)
   b. **İlan içeriğini çek:** Playwright (browser_navigate + browser_snapshot) → WebFetch → WebSearch. **Playwright kullanılmadıysa** (toplu/headless mod veya yedek yola düşüldüyse) rapor başlığına `**Doğrulama:** doğrulanmamış (toplu mod)` etiketini ekle.
   c. URL erişilemiyorsa → `- [!]` olarak işaretle, not ekle ve bir sonrakine geç
   d. **Tam pipeline'ı çalıştır:** A-G değerlendirmesi → Rapor (.md) → PDF (puan ≥ 3,0 ise) → Takipçi
   e. **"Bekleyenler"den "İşlenenler"e taşı:** `- [x] #NNN | URL | Şirket | Rol | Puan/5 | PDF ✅/❌`
3. **3 veya daha fazla URL varsa ve Playwright kullanılmıyorsa** paralel ajan başlat (Agent aracı, `run_in_background`) — hızı artırır. Playwright etkinse tek tarayıcı örneği paylaşıldığından sıralı işle.
4. **Tamamlanınca** özet tabloyu göster:

```text
| # | Şirket | Rol | Puan | PDF | Önerilen eylem |
```

## pipeline.md Formatı

```markdown
## Bekleyenler
- [ ] https://kariyer.net/is-ilani/12345
- [ ] https://boards.greenhouse.io/sirket/jobs/456 | Şirket A.Ş. | Senior Backend Engineer
- [!] https://ozel.url/ilan — Hata: giriş gerekiyor

## İşlenenler
- [x] #143 | https://kariyer.net/is-ilani/789 | Acme Teknoloji | Backend Developer | 4.2/5 | PDF ✅
- [x] #144 | https://boards.greenhouse.io/xyz/jobs/012 | BigCo | Frontend Engineer | 2.1/5 | PDF ❌
```

> Not: Bölüm başlıkları EN ("Pending"/"Processed"), ES ("Pendientes"/"Procesadas") veya TR ("Bekleyenler"/"İşlenenler") olabilir. Okurken esnek ol; yazarken mevcut dosyanın stilini koru.

## URL'den İlan İçeriği Çekme

1. **Playwright (tercih edilen):** `browser_navigate` + `browser_snapshot` — tüm SPA'larla çalışır.
   - **İsteğe bağlı — CLI çıkarıcı (`config/profile.yml` içinde `scan.extractor: cli`):** bunun yerine `node browser-extract.mjs <url>` (`--mode jd`) çalıştır — kompakt `{ "url", "title", "text" }`, daha az token (portala bağlı). Hata veya eksiklik durumunda **sessizce** `browser_navigate` + `browser_snapshot`'a geri dön.
2. **WebFetch (yedek):** Playwright mevcut değilse (toplu/headless mod). Bu durumda rapor başlığına `**Doğrulama:** doğrulanmamış (toplu mod)` ekle — kullanıcı daha sonra manuel doğrulayabilir.
3. **WebSearch (son çare):** İlanı indeksleyen diğer platformlarda ara. WebFetch'te olduğu gibi rapor başlığına `**Doğrulama:** doğrulanmamış (toplu mod)` ekle.

**Özel durumlar:**
- **Kariyer.net:** Playwright ile sorunsuz çalışır; giriş gerektirmez.
- **Yenibiris.com:** Playwright ile çalışır.
- **LinkedIn:** Giriş gerektirebilir → `[!]` olarak işaretle, adaydan ilan metnini yapıştırmasını iste.
- **PDF linki:** URL doğrudan bir PDF'e işaret ediyorsa Read aracıyla oku.
- **`local:` öneki:** Yerel dosyayı oku. Örnek: `local:jds/kariyer-backend.md` → `jds/kariyer-backend.md` oku.

## Rapor Numaralandırma

1. Sıradaki rapor numarasını atomik olarak rezerve etmek için `node reserve-report-num.mjs` komutunu çalıştır (standart çıktı `{###}` değerini döndürür).
2. Bu numarayı kullanarak rapor dosyasını yaz.
3. Rapor yazıldıktan sonra `node reserve-report-num.mjs --release {###}` komutunu çalıştırarak sentineli serbest bırak.

## Başlamadan Önce

Herhangi bir URL'yi işlemeden önce yapılandırma kontrolü çalıştır:
```bash
node cv-sync-check.mjs
```
Uyarı varsa adayı bilgilendirmeden devam etme.
