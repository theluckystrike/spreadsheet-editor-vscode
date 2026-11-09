'use strict';
// Text encoding of a CSV/TSV file: a byte order mark first, then UTF-8, then the legacy encodings that
// Excel and other tools write in East Asian and Cyrillic locales, then Windows-1252.
// Each legacy candidate is decoded strictly and scored by how many of its non-ASCII characters are common
// ones in that language. Wrong guesses decode to rare characters (or fail), so they score low.

/** Encodings the user can pick in the toolbar (WHATWG labels that TextDecoder knows). */
const CSV_ENCODINGS = Object.freeze([
  'utf-8', 'utf-16le', 'utf-16be', 'windows-1252', 'windows-1250', 'windows-1251', 'iso-8859-15', 'koi8-r',
  'shift_jis', 'euc-jp', 'gb18030', 'big5', 'euc-kr',
]);

const ENCODING_NAMES = Object.freeze({
  'utf-8': 'UTF-8', 'utf-16le': 'UTF-16 LE', 'utf-16be': 'UTF-16 BE', 'windows-1252': 'Windows-1252 (Western)',
  'windows-1250': 'Windows-1250 (Central European)', 'windows-1251': 'Windows-1251 (Cyrillic)', 'iso-8859-15': 'ISO-8859-15 (Latin-9)',
  'koi8-r': 'KOI8-R (Russian)', shift_jis: 'Shift_JIS (Japanese)', 'euc-jp': 'EUC-JP (Japanese)', gb18030: 'GB18030 (Simplified Chinese)',
  big5: 'Big5 (Traditional Chinese)', 'euc-kr': 'EUC-KR (Korean)',
});

// Very common characters per language. Real text hits these sets often; bytes decoded with the wrong
// table land on them only by chance.
const COMMON_SC = new Set('的一是不了在人有我他这个们中来上大为和国地到以说时要就出会可也你对生能而子那得于着下自之年过发后作里用道行所然家种事成方多经么去法学如都同现当没动面起看定天分还进好小部其些主样理心她本前开但因只从想实日军者意无力它与长把机十民第公此已工使情明性知全三又关点正业外将两高间由问很最重并物手应战向头文体政美相见被利什二等产或新己制身果加西月话合回特代内信表化老给世位次度门任常先海通教儿原东声提立及比员解水名真论处走义各入几口认条平系气题活更别打女变四神总何电数安少报才结反受目太量再感建务做接必场件计管期市直德资命山金指克许统区保至队形社便空决治展马科司五基书非则听白却界达光放强即像难且权思王象完设式色路记南品住告类求据程北边死张该交规万取拉格望觉术领共确传师观清今切院让识候带导争运笑飞风步改收根干造言联持组每济车亲极林服快办议往元英士证近失转夫令准布始怎存未远叫台单影具罗字爱击流备兵连调深商算质团集百需价花党华城石级整府离况亚请技际约示复病息究线似官火断精满支视消越器容照须九增研写称企八功包片史委乎查轻易早曾除农找装广显阿李标谈吃图念六引历首医局突专费号尽另周较注语仅考落青随选列武红响虽推势参希古众构房半节土投某案黑维革划敌致陈律足态护七兴派孩验责营星够章音跟志底站严巴例防族供效续施留讲型料终答紧黄绝奇察母京段依批群项故按河米围江织害斗双境客纪采举杀攻父苏密低朝友诉止细愿千值仍男钱破网热助倒育属坐帝限船脸职速刻乐否刚威毛状率甚独球般普怕弹校苦创假久错承印晚兰试股拿脑预谁益阳若哪微尼继送急血惊伤素药适波夜省初喜卫源食险待述陆习置居劳财环排福纳欢雷警获模充负云停木游龙树疑层冷洲冲射略范竟句室异激汉村哈策演简卡罪判担州静退既衣您宗积余痛检差富灵协角占配征修皮挥胜降阶审沉坚善妈刘读超免压银买皇养伊怀执副乱抗犯追帮宣佛岁航优怪香著田铁控税左右份穿艺背阵草脚概恶块顿敢守酒岛托央户烈洋哥索胡款靠评版宝座释景顾弟登货互付伯慢欧换闻危忙核暗姐介坏讨丽良序升监临亮露永呼味野架域沙掉括舰鱼杂误湾吉减编楚肯测败屋跑梦散温困剑渐封救贵枪缺楼县尚毫移娘朋画班智亦耳恩短掌恐遗固席松秘谢鲁遇康虑幸均销钟诗藏赶剧票损忽巨炮旧端探湖录叶春乡附吸予礼港雨板庭妇归饭额含顺输摇招婚脱补谓督毒油疗旅泽材灭逐莫笔亡鲜词圣择寻厂睡博勒烟授诺伦岸奥唐卖俄炸载洛健堂旁宫喝借君禁阴园谋宋避抓荣姑孙逃牙束跳顶玉镇雪午练迫爷篇肉嘴馆遍凡础洞卷坦牛宁纸诸训私庄祖丝翻暴森塔默握戏隐熟骨访弱蒙歌店鬼软典欲萨伙遭盘爸扩盖弄雄稳忘亿刺拥徒姆杨齐赛趣曲刀床迎冰虚玩析窗醒妻透购替塞努休虎扬途侵刑绿兄迅套贸毕唯谷轮库迹尤竞街促延震弃甲伟麻川申缓潜闪售灯针哲络抵朱埃抱鼓植纯夏忍页杰筑折郑贝尊吴秀混臣雅振染盛怒舞圆搞狂措姓残秋培迷诚宽宇猛摆梅毁伸摩盟末乃悲拍丁赵狗元角号省市区县街路销售额数量单价金额合计客户产品订单日期名称编码类型状态备注');
const COMMON_TC = new Set('的一是不了在人有我他這個們中來上大為和國地到以說時要就出會可也你對生能而子那得於著下自之年過發後作裡用道行所然家種事成方多經麼去法學如都同現當沒動面起看定天分還進好小部其些主樣理心她本前開但因只從想實日軍者意無力它與長把機十民第公此已工使情明性知全三又關點正業外將兩高間由問很最重並物手應戰向頭文體政美相見被利什二等產或新己制身果加西月話合回特代內信表化老給世位次度門任常先海通教兒原東聲提立及比員解水名真論處走義各入幾口認條平系氣題活更別打女變四神總何電數安少報才結反受目太量再感建務做接必場件計管期市直德資命山金指克許統區保至隊形社便空決治展馬科司五基書非則聽白卻界達光放強即像難且權思王象完設式色路記南品住告類求據程北邊死張該交規萬取拉格望覺術領共確傳師觀清今切院讓識候帶導爭運笑飛風步改收根乾造言聯持組每濟車親極林服快辦議往元英士證近失轉夫令準布始怎存未遠叫台單影具羅字愛擊流備兵連調深商算質團集百需價花黨華城石級整府離況亞請技際約示復病息究線似官火斷精滿支視消越器容照須九增研寫稱企八功包片史委乎查輕易早曾除農找裝廣顯阿李標談吃圖念六引歷首醫局突專費號盡另周較注語僅考落青隨選列武紅響雖推勢參希古眾構房半節土投某案黑維革劃敵致陳律足態護七興派孩驗責營星夠章音跟志底站嚴巴例防族供效續施留講型料終答緊黃絕奇察母京段依批群項故按河米圍江織害鬥雙境客紀採舉殺攻父蘇密低朝友訴止細願千值仍男錢破網熱助倒育屬坐帝限船臉職速刻樂否剛威毛狀率甚獨球般普怕彈校苦創假久錯承印晚蘭試股拿腦預誰益陽若哪微尼繼送急血驚傷素藥適波夜省初喜衛源食險待述陸習置居勞財環排福納歡雷警獲模充負雲停木遊龍樹疑層冷洲衝射略範竟句室異激漢村哈策演簡卡罪判擔州靜退既衣您宗積餘痛檢差富靈協角佔配徵修皮揮勝降階審沉堅善媽劉讀超免壓銀買皇養伊懷執副亂抗犯追幫宣佛歲航優怪香著田鐵控稅左右份穿藝背陣草腳概惡塊頓敢守酒島託央戶烈洋哥索胡款靠評版寶座釋景顧弟登貨互付伯慢歐換聞危忙核暗姐介壞討麗良序升監臨亮露永呼味野架域沙掉括艦魚雜誤灣吉減編楚肯測敗屋跑夢散溫困劍漸封救貴槍缺樓縣尚毫移娘朋畫班智亦耳恩短掌恐遺固席松秘謝魯遇康慮幸均銷鐘詩藏趕劇票損忽巨炮舊端探湖錄葉春鄉附吸予禮港雨板庭婦歸飯額含順輸搖招婚脫補謂督毒油療旅澤材滅逐莫筆亡鮮詞聖擇尋廠睡博勒煙授諾倫岸奧唐賣俄炸載洛健堂旁宮喝借君禁陰園謀宋避抓榮姑孫逃牙束跳頂玉鎮雪午練迫爺篇肉嘴館遍凡礎洞卷坦牛寧紙諸訓私莊祖絲翻暴森塔默握戲隱熟骨訪弱蒙歌店鬼軟典欲薩夥遭盤爸擴蓋弄雄穩忘億刺擁徒姆楊齊賽趣曲刀床迎冰虛玩析窗醒妻透購替塞努休虎揚途侵刑綠兄迅套貿畢唯谷輪庫跡尤競街促延震棄甲偉麻川申緩潛閃售燈針哲絡抵朱埃抱鼓植純夏忍頁傑築折鄭貝尊吳秀混臣雅振染盛怒舞圓搞狂措姓殘秋培迷誠寬宇猛擺梅毀伸摩盟末乃悲拍丁趙狗元角號省市區縣街路銷售額數量單價金額合計客戶產品訂單日期名稱編碼類型狀態備註');
const COMMON_KO = new Set('이다는의에가을를하고서지기리사정대한로도자니일수시그어나아인국해적전보들으것주부장게되상위만성동요원제회과내연여구신금경중방문면소비세무화개실관공물조간발생명학선모통영업미유분당설거결산계약번호이름날짜가격수량합상품고객주소전화직원부서팀회사월년금액비고합계총단가매출');
// Japanese: kana carry most of the signal; a few kanji common in business sheets help kanji-only columns.
const COMMON_JA_KANJI = new Set('日本東京大阪名古屋会社株式年月時分円名前住所電話番号商品売上数量単価金額合計顧客注文日付区分備考担当部署社員氏名都道府県市区町村中山田川島木本村井小林佐藤鈴高橋伊渡辺加野新');

function isKana(cp) { return (cp >= 0x3040 && cp <= 0x30ff) || cp === 0x30fc; }

/** Share (0..1) of the non-ASCII characters of `text` that are common in the language of `enc`. */
function scoreLegacy(text, enc) {
  let nonAscii = 0, hits = 0, bad = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) continue;
    nonAscii++;
    if (cp === 0xfffd || (cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0x80 && cp <= 0x9f)) { bad++; continue; }
    switch (enc) {
      case 'shift_jis': case 'euc-jp':
        if (isKana(cp) || COMMON_JA_KANJI.has(ch) || (cp >= 0x3000 && cp <= 0x303f) || (cp >= 0xff01 && cp <= 0xff5e)) hits++;
        else if (cp >= 0xff61 && cp <= 0xff9f) bad++; // half-width katakana: what GBK/Big5 bytes become in Shift_JIS
        break;
      case 'gb18030': if (COMMON_SC.has(ch) || (cp >= 0x3000 && cp <= 0x303f) || (cp >= 0xff01 && cp <= 0xff5e)) hits++; break;
      case 'big5': if (COMMON_TC.has(ch) || (cp >= 0x3000 && cp <= 0x303f) || (cp >= 0xff01 && cp <= 0xff5e)) hits++; break;
      case 'euc-kr': if (COMMON_KO.has(ch)) hits++; break;
      default: break;
    }
  }
  if (!nonAscii) return 0;
  return Math.max(0, (hits - 3 * bad) / nonAscii);
}

/** Strict decode, or null when the bytes are not valid in `enc` (a split character at the end is fine). */
function strictDecode(bytes, enc) {
  try { return new TextDecoder(enc, { fatal: true }).decode(bytes, { stream: true }); } catch { return null; }
}

/**
 * Cyrillic text in Windows-1251 is made of runs of non-ASCII letters (whole words), while Western text in
 * Windows-1252 has single accented letters inside ASCII words. Share of non-ASCII letters with a non-ASCII
 * letter next to them.
 */
function cyrillicRunShare(bytes) {
  let hi = 0, paired = 0;
  const n = Math.min(bytes.length, 65536);
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b < 0xc0) continue; // 0xC0-0xFF are the letters А-я in Windows-1252's slots
    hi++;
    if ((i > 0 && bytes[i - 1] >= 0xc0) || (i + 1 < n && bytes[i + 1] >= 0xc0)) paired++;
  }
  return hi >= 8 ? paired / hi : 0;
}

/** UTF-16 without a byte order mark: many zero bytes on one side. */
function utf16NoBom(bytes) {
  const n = Math.min(bytes.length, 4096) & ~1;
  if (n < 16) return null;
  let evenZero = 0, oddZero = 0;
  for (let i = 0; i < n; i += 2) { if (bytes[i] === 0) evenZero++; if (bytes[i + 1] === 0) oddZero++; }
  const pairs = n / 2;
  if (oddZero > pairs * 0.4 && evenZero < pairs * 0.05) return 'utf-16le';
  if (evenZero > pairs * 0.4 && oddZero < pairs * 0.05) return 'utf-16be';
  return null;
}

function supported(enc) { try { new TextDecoder(enc); return true; } catch { return false; } }

/**
 * Guess the encoding of the first bytes of a text file. Returns a WHATWG label for TextDecoder.
 * @param {Uint8Array} head the first chunk of the file (up to 64 KB is plenty)
 */
function detectEncoding(head) {
  const b = head.length > 65536 ? head.subarray(0, 65536) : head;
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return 'utf-8';
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return 'utf-16le';
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return 'utf-16be';
  const u16 = utf16NoBom(b);
  if (u16) return u16;
  if (strictDecode(b, 'utf-8') !== null) return 'utf-8';
  let best = null, bestScore = 0;
  for (const enc of ['shift_jis', 'gb18030', 'big5', 'euc-kr', 'euc-jp']) {
    if (!supported(enc)) continue;
    const text = strictDecode(b, enc);
    if (text === null) continue;
    const s = scoreLegacy(text, enc);
    if (s > bestScore + 1e-9) { best = enc; bestScore = s; }
  }
  if (best && bestScore >= 0.2) return best;
  if (cyrillicRunShare(b) >= 0.6 && supported('windows-1251')) return 'windows-1251';
  // Excel's "CSV" on Windows in Western locales writes Windows-1252, not UTF-8.
  return 'windows-1252';
}

function encodingName(enc) { return ENCODING_NAMES[enc] || enc; }

module.exports = { CSV_ENCODINGS, ENCODING_NAMES, detectEncoding, encodingName, scoreLegacy, cyrillicRunShare };
