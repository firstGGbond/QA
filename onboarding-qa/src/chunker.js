/**
 * 文档分块 & 索引模块
 * 将知识库 txt 文件按中文段落结构切分为可检索的块
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

/**
 * 按中文文档结构拆分文本：
 *   - 一级标题: 一、二、三、... 或 第X章
 *   - 二级标题: （一）（二）... 或 1、2、... 或 1.1 1.2
 *   - 段落之间用空行分隔
 *
 * 返回 [{ id, source, title, content, pageHint }]
 */
function chunkDocument(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const source = path.basename(filePath, '.txt');

  // 清洗：移除 form-feed 分页符，压缩多余空白
  const cleaned = raw
    .replace(/\f/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  const lines = cleaned.split('\n');

  // 先提取页面信息
  const pageMap = new Map(); // lineIndex -> pageNumber
  let currentPage = 1;
  for (let i = 0; i < lines.length; i++) {
    const pm = lines[i].match(/第\s*(\d+)\s*\/\s*\d+\s*页/);
    if (pm) {
      currentPage = parseInt(pm[1]);
    }
    pageMap.set(i, currentPage);
  }

  // 识别章节标题模式
  const sectionPatterns = [
    /^[一二三四五六七八九十]+、/,      // 一、二、
    /^第[一二三四五六七八九十\d]+章/,   // 第X章
    /^（[一二三四五六七八九十\d]+）/,    // （一）（二）
    /^\d+[、．.]/,                      // 1、 1.
    /^\d+\.\d+/,                         // 1.1 2.1
    /^[①②③④⑤⑥⑦⑧⑨⑩]/,          // ①②③
  ];

  function isHeading(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 2) return false;
    return sectionPatterns.some(p => p.test(trimmed));
  }

  // 按段落分块：遇到标题行就开新块
  const chunks = [];
  let currentTitle = source;
  let currentLines = [];
  let chunkStartLine = 0;

  function flushChunk(endLine) {
    const text = currentLines.join('\n').trim();
    if (text.length < 20) {
      currentLines = [];
      return;
    }
    const startPage = pageMap.get(chunkStartLine) || 1;
    const endPage = pageMap.get(endLine) || startPage;
    chunks.push({
      id: `${source}__${chunks.length}`,
      source,
      title: currentTitle,
      content: text,
      pageHint: startPage === endPage ? `第${startPage}页` : `第${startPage}-${endPage}页`,
    });
    currentLines = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isHeading(line)) {
      flushChunk(i);
      currentTitle = `${source} > ${line.trim()}`;
      chunkStartLine = i;
    }
    currentLines.push(line);
  }

  // 最后一个块
  if (currentLines.join('\n').trim().length >= 20) {
    flushChunk(lines.length - 1);
  }

  return chunks;
}

/**
 * 二次拆分：对过大的 chunk（>1500字）做段落级切分
 */
function splitLargeChunks(chunks, maxLen = 1500) {
  const result = [];
  for (const c of chunks) {
    if (c.content.length <= maxLen) {
      result.push(c);
      continue;
    }
    // 按空行拆
    const paras = c.content.split(/\n\s*\n/);
    let buf = [];
    let bufLen = 0;
    for (const p of paras) {
      buf.push(p);
      bufLen += p.length;
      if (bufLen >= maxLen) {
        result.push({ ...c, id: `${c.id}_p${result.length}`, content: buf.join('\n\n') });
        buf = [];
        bufLen = 0;
      }
    }
    if (buf.length > 0) {
      result.push({ ...c, id: `${c.id}_p${result.length}`, content: buf.join('\n\n') });
    }
  }
  return result;
}

/**
 * 构建全量索引
 */
function buildIndex() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.txt'));
  console.log(`[chunker] 发现 ${files.length} 个知识库文件`);

  let allChunks = [];
  for (const f of files) {
    const filePath = path.join(DATA_DIR, f);
    const chunks = chunkDocument(filePath);
    console.log(`[chunker]   ${f}: ${chunks.length} 个块`);
    allChunks.push(...chunks);
  }

  allChunks = splitLargeChunks(allChunks);
  console.log(`[chunker] 总计 ${allChunks.length} 个检索块`);

  // 构建倒排索引
  const invertedIndex = buildInvertedIndex(allChunks);

  return { chunks: allChunks, invertedIndex };
}

/**
 * 构建简易倒排索引（用于关键词快速召回）
 */
function buildInvertedIndex(chunks) {
  const index = new Map(); // word -> Set<chunkId>

  // 常用中文停用词
  const stopWords = new Set([
    '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
    '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着',
    '没', '看', '好', '自己', '这', '他', '她', '它', '们', '那', '与',
    '为', '及', '或', '等', '每', '被', '从', '而', '以', '之', '所',
    '能', '对', '将', '已', '其', '更', '并', '个', '中', '但', '该',
    '可', '向', '把', '让', '于', '各', '年', '月', '日', '元', '第',
  ]);

  for (const chunk of chunks) {
    const words = tokenize(chunk.content + ' ' + chunk.title);
    const wordSet = new Set(words.filter(w => !stopWords.has(w) && w.length >= 2));
    for (const w of wordSet) {
      if (!index.has(w)) index.set(w, new Set());
      index.get(w).add(chunk.id);
    }
  }

  return index;
}

/**
 * 简易中文分词（bigram + 关键词提取）
 */
function tokenize(text) {
  // 移除标点，保留中英文数字
  const cleaned = text.replace(/[^一-鿿\w]/g, ' ');
  // 中文 bigram
  const result = [];
  const chars = [...cleaned];
  for (let i = 0; i < chars.length - 1; i++) {
    const bigram = chars[i] + chars[i + 1];
    if (/^[一-鿿]{2}$/.test(bigram)) {
      result.push(bigram);
    }
  }
  // 英文/数字词
  const words = cleaned.split(/\s+/);
  for (const w of words) {
    if (w.length >= 2) result.push(w.toLowerCase());
  }
  return result;
}

module.exports = { buildIndex, tokenize };
