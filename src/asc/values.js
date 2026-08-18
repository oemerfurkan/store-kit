#!/usr/bin/env node
'use strict';

/**
 * Renders store/ASC-VALUES.md, the copy-paste sheet for App Store Connect.
 *
 * Generated rather than hand-written so it cannot drift from store/metadata.json, which is
 * the file the length checker validates. Editing the sheet by hand would produce copy that
 * passes review in the document and fails in the form.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = require('../lib/root').root();
const m = require(path.join(ROOT, 'store', 'metadata.json'));
const frames = require(path.join(ROOT, 'store', 'screenshot-frames.json'));

/**
 * Apple's own name for each localization, as it appears in the App Store Connect picker.
 *
 * Four of these do not match the code you would guess. Urdu, Bangla, Malayalam and Tamil
 * are ur-PK, bn-BD, ml-IN and ta-IN in the API, while Apple's published list of App Store
 * localizations prints all four without a region. The bare codes are rejected.
 */
const LOCALE_LABEL = {
  'en-US': 'English (U.S.)',
  'en-GB': 'English (U.K.)',
  tr: 'Turkish',
  'ar-SA': 'Arabic',
  id: 'Indonesian',
  ms: 'Malay',
  'ur-PK': 'Urdu',
  'bn-BD': 'Bangla',
  hi: 'Hindi',
  'ml-IN': 'Malayalam',
  'ta-IN': 'Tamil',
  th: 'Thai',
  'fr-FR': 'French',
  'de-DE': 'German',
  'nl-NL': 'Dutch',
  'es-ES': 'Spanish (Spain)',
  'es-MX': 'Spanish (Mexico)',
  'pt-BR': 'Portuguese (Brazil)',
  it: 'Italian',
  ru: 'Russian',
  ja: 'Japanese',
  ko: 'Korean',
  'zh-Hant': 'Chinese (Traditional)',
};

const locales = Object.keys(m).filter((k) => !k.startsWith('_') && m[k].name !== undefined);
const len = (s) => Array.from(s).length;

// A locale with no label renders as "undefined" in a table cell, which reads as a bug in
// the listing rather than a gap in this file. Failing here is louder and cheaper.
const unlabelled = locales.filter((locale) => !LOCALE_LABEL[locale]);
if (unlabelled.length > 0) {
  console.error(`No LOCALE_LABEL entry for: ${unlabelled.join(', ')}`);
  process.exit(1);
}

const out = [];
const w = (line = '') => out.push(line);

w('# App Store Connect: girilecek değerler');
w();
w('Bu dosya `store/metadata.json`dan üretiliyor. Elle düzenleme, `npm run asc:values` ile');
w('yeniden üret. Uzunluklar `npm run check:store` ile doğrulanmış durumda.');
w();
w(`Uygulama: **${m.shared.bundleId}** · Apple ID **6799609668** · SKU \`${m.shared.sku}\``);
w();
w('---');
w();
w('## 1. App Information');
w();
w('Bir kez ayarlanır, bütün sürümler için geçerli.');
w();
w(`- **Primary Category:** ${m.shared.primaryCategory}`);
w(`- **Secondary Category:** ${m.shared.secondaryCategory}`);
w('- **Content Rights:** "No, it does not contain, show, or access third-party content"');
w('- **License Agreement:** Apple\'s Standard License Agreement (değiştirme)');
w();
w('> **Neden her dilde ad farklı olabilir:** Apple ad benzersizliğini her yerelleştirme');
w('> için ayrı kontrol eder, yani aynı string iki vitrinde kullanılamayabilir ve bunu');
w('> ancak kaydetmeye çalıştığında öğrenirsin. Her vitrine kendi marka kökü artı kısa bir');
w('> tanımlayıcı vermek bunu baştan çözer, ve ad Apple\'ın en ağır indekslediği alan');
w('> olduğu için arama açısından da daha iyidir.');
w();
w('| Localization | Name | Subtitle |');
w('|---|---|---|');
for (const l of locales) {
  w(`| ${LOCALE_LABEL[l]} | \`${m[l].name}\` (${len(m[l].name)}/30) | \`${m[l].subtitle}\` (${len(m[l].subtitle)}/30) |`);
}
w();
w('---');
w();
w('## 2. Sürüm 1.0, dil dil');
w();
w('Her dil için: Promotional Text, Keywords, Description. Support ve Marketing URL her');
w('dilde aynı.');
w();
w(`- **Support URL:** ${m.shared.supportUrl}`);
w(`- **Marketing URL:** ${m.shared.marketingUrl}`);
w(`- **Copyright:** ${m.shared.copyright}`);
w();

for (const l of locales) {
  w(`### ${LOCALE_LABEL[l]}`);
  w();
  w(`**Promotional Text** (${len(m[l].promotionalText)}/170)`);
  w();
  w('```');
  w(m[l].promotionalText);
  w('```');
  w();
  w(`**Keywords** (${len(m[l].keywords)}/100, virgülle, boşluksuz)`);
  w();
  w('```');
  w(m[l].keywords);
  w('```');
  w();
  w(`**Description** (${len(m[l].description)}/4000)`);
  w();
  w('```');
  w(m[l].description);
  w('```');
  w();
  w(`**What's New** (1.0 için gerekmez, ilk sürümde alan kapalı)`);
  w();
  w('```');
  w(m[l].whatsNew);
  w('```');
  w();
}

w('---');
w();
w('## 3. Ekran görüntüleri');
w();
w(`6.5" iPhone slotu, **${frames.canvas.width}x${frames.canvas.height}**. Her dil için ${frames.frames.length} tanesi de, şu sırayla:`);
w();
w('| # | Dosya | Başlık (İngilizce) |');
w('|---|---|---|');
frames.frames.forEach((frame, i) => {
  w(`| ${i + 1} | \`${i + 1}-${frame.capture}.png\` | ${frames.headlines['en-US'][i]} |`);
});
w();
w('Klasörler: `store/screenshots/en-US/`, `tr/`, `ar-SA/`, `id/`');
w();
w('Apple bu seti diğer ekran boyutlarına kendisi ölçekliyor, başka boyut yüklemeye gerek yok.');
w();
w('---');
w();
w('## 4. Abonelikler');
w();
w(`Grup adı: **${m.inAppPurchases.subscriptionGroupName}**`);
w();
w('| Product ID | Süre | Fiyat (USD) | Teklif |');
w('|---|---|---|---|');
for (const p of m.inAppPurchases.products) {
  w(`| \`${p.productId}\` | ${p.duration} | ${p.priceUSD} | ${p.introductoryOffer} |`);
}
w();
// Whatever is unusual about this app's product ids, in its own words. Printed from the
// metadata rather than written here, because the reason differs per app and a note that
// describes a different app's ids is worse than no note.
for (const p of m.inAppPurchases.products) {
  if (!p._idNote) continue;
  w(`> \`${p.productId}\`: ${p._idNote}`);
  w();
}
w('> Bir ürün kimliği ASC\'de bir kez oluşturulduktan sonra asla yeniden adlandırılamaz,');
w('> ve RevenueCat tam olarak bu stringi tutar. Bir harf yanlış girilirse paywall fiyatsız');
w('> açılır.');
w();
w('### Abonelik grubu yerelleştirmeleri');
w();
w('Grup sayfasındaki Localization bölümü. iOS Ayarlar > Abonelikler ekranında planların');
w('üstünde bu ad görünüyor, yani aboneliğini iptal etmek isteyen kişinin aradığı satır bu.');
w('Custom app name alanını boş bırak, varsayılan zaten o vitrinin uygulama adını kullanıyor.');
w();
w('| Localization | Subscription Group Display Name |');
w('|---|---|');
for (const [loc, name] of Object.entries(m.inAppPurchases.subscriptionGroupLocalizations)) {
  w(`| ${LOCALE_LABEL[loc]} | \`${name}\` (${len(name)}/30) |`);
}
w();
w('### Ürün adları ve açıklamaları');
w();
w('| Product | Localization | Display Name | Description |');
w('|---|---|---|---|');
for (const p of m.inAppPurchases.products) {
  for (const [loc, text] of Object.entries(p.localizations)) {
    w(`| ${p.duration} | ${LOCALE_LABEL[loc]} | \`${text.displayName}\` | \`${text.description}\` |`);
  }
}
w();
w('### Review Notes (her ürünün Review Information bölümüne)');
w();
w('Ekran görüntüsü ikisinde de aynı: `store/screenshots/review/paywall.png`. Paywall her iki');
w('planı da gösterdiği için Apple açısından tek görsel ikisini de karşılıyor.');
w();
for (const p of m.inAppPurchases.products) {
  w(`**${p.productId}** (${len(p.reviewNote)}/4000)`);
  w();
  w('```');
  w(p.reviewNote);
  w('```');
  w();
}

w('### Türkiye fiyatlandırması');
w();
w('Temel fiyat ABD vitrininde belirlenir, Apple gerisini kendi çevirir. Türkiye bu çevirinin');
w('dışına alınmalı: otomatik kur, yerel ödeme gücünün epey üstüne çıkıyor ve pratikte');
w('Türkiye\'den abone gelmemesi anlamına geliyor.');
w();
w('ASC\'de ürünü aç, **Pricing** bölümünde Turkey satırını bul, **Edit** ile ülkeye özel');
w('fiyat ver. Panelde otomatik çevrilmiş rakamı zaten gösteriyor, kıyaslayarak seç.');
w();
w('Hedeflenecek oran:');
w();
w('- Aylık: otomatik çevrilen fiyatın kabaca **üçte biri**');
w('- Yıllık: aylığın **6 katı civarı**, yani 12 ay yerine 6 ay ödemiş gibi');
w();
w('İkinci maddeye dikkat: yıllık, 12 x aylık fiyatın belirgin biçimde altında kalmalı.');
w('ABD\'de 5 ve 30 dolar tam olarak bunu yapıyor, yıllık yarı fiyat. Türkiye\'de de aynı');
w('oranı koru, yoksa yıllık plana geçmek için sebep kalmıyor.');
w();
w('---');
w();
w('## 5. App Privacy');
w();
w('Uygulamanın kendisi hiçbir şey toplamıyor. Beyan edilecek tek veri RevenueCat SDK\'sından');
w('geliyor ve uygulama `Purchases`\'ı özel bir kullanıcı kimliği vermeden yapılandırdığı için');
w('o kimlik anonim. Bu, RevenueCat\'in kendi yayımladığı yönergeyle birebir aynı.');
w();
for (const d of m.appPrivacy.dataCollected) {
  w(`- **${d.type}**`);
  w(`  - Used for: ${d.usedFor.join(', ')}`);
  w(`  - Linked to the user's identity: **${d.linkedToIdentity ? 'Yes' : 'No'}**`);
  w(`  - Used for tracking: **${d.usedForTracking ? 'Yes' : 'No'}**`);
}
w();
w('Diğer bütün veri türleri: **toplanmıyor**. Tracking sorusu: **No**.');
w();
w(`Privacy Policy URL: ${m.shared.privacyPolicyUrl}`);
w();
w('---');
w();
w('## 6. Yaş sınırı');
w();
w('Kritik soru şiddet bölümünde: biyografilerde tarihî olaylar sade bir dille anlatılıyor');
w('ve içlerinde işkence ile savaş yaraları geçiyor (Bilâl kızgın kumda, Uhud\'da on üç');
w('yara). Metin bunları betimlemiyor, aktarıyor.');
w();
w('**Öneri: şiddet kategorilerine "None", sonuç 4+.** Apple betimlemeyen tarihî ve dinî');
w('anlatımı bu şekilde değerlendiriyor; olayın geçtiğini söylemek onu göstermek değil.');
w('"Infrequent/Mild Realistic Violence" seçilirse sonuç 12+ oluyor ve gereksiz yere');
w('erişim kaybediliyor. Karar senin, gerekçe burada açık dursun diye yazıldı: yanlış');
w('cevap sonradan uygulamanın kaldırılmasına yol açabilir.');
w();
w('Diğer bütün kategoriler net: cinsellik yok, küfür yok, kumar yok, kullanıcı içeriği yok,');
w('sınırsız web erişimi yok.');
w();
w('---');
w();
w('## 7. App Review Information');
w();
w('Demo hesap gerekmiyor, uygulamada giriş yok. Notes alanına:');
w();
w('```');
w(m.reviewNotes.text);
w('```');
w();

const document = out.join('\n');
fs.writeFileSync(path.join(ROOT, 'store', 'ASC-VALUES.md'), document);

// Counted from the text, not from `out.length`. Several entries are whole descriptions with
// their own newlines inside, so the array length ran well under what the file actually has.
// Newlines rather than split parts, so the number agrees with `wc -l`.
const lines = (document.match(/\n/g) ?? []).length;
console.log(`Wrote store/ASC-VALUES.md (${lines} lines, ${locales.length} locales).`);
