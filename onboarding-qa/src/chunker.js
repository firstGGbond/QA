/**
 * 文档分块 & 向量嵌入模块
 * 将知识库 txt 文件按中文段落结构切分，并调用 Embedding API 生成向量
 * 向量结果缓存到磁盘，后续启动直接加载，无需重复调用 API
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(__dirname, '..', 'data', '.embedding_cache.json');

/**
 * 计算 data 目录下 txt 文件的指纹（文件名 + 修改时间）
 * 用于判断缓存是否仍然有效
 */
function computeFilesFingerprint() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.txt')).sort();
  const infos = files.map(f => {
    const stat = fs.statSync(path.join(DATA_DIR, f));
    return `${f}:${stat.mtimeMs}:${stat.size}`;
  });
  return crypto.createHash('md5').update(infos.join('|')).digest('hex');
}

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
 * 对 chunks 做文档分块（不做 embedding）
 */
function buildChunks() {
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
  return allChunks;
}

/**
 * 调用 Embedding API 为每个 chunk 生成向量
 * 使用 OpenAI 兼容接口，支持批量请求
 */
async function computeEmbeddings(chunks, batchSize = 20) {
  const apiKey = process.env.LLM_API_KEY;
  const baseUrl = (process.env.LLM_BASE_URL || 'https://lab.iwhalecloud.com/gpt-proxy/v1').replace(/\/+$/, '');
  const model = process.env.LLM_EMBEDDING_MODEL || 'text-embedding-3-small';

  if (!apiKey) {
    throw new Error('未配置 LLM_API_KEY，向量嵌入功能不可用');
  }

  // 将 title + content 拼接作为嵌入文本，提升语义匹配效果
  const texts = chunks.map(c => `${c.title}\n${c.content}`);

  console.log(`[embedding] 模型: ${model}, 共 ${texts.length} 个文本, 每批 ${batchSize} 个`);

  const embeddings = new Array(texts.length);
  const totalBatches = Math.ceil(texts.length / batchSize);
  const startTime = Date.now();

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;

    let res;
    try {
      res = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, input: batch }),
      });
    } catch (err) {
      throw new Error(`Embedding API 网络错误: ${err.message}`);
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Embedding API 错误 (${res.status}): ${errText}`);
    }

    const data = await res.json();

    // 按 index 排序后填入对应位置
    const sorted = [...data.data].sort((a, b) => a.index - b.index);
    for (let j = 0; j < sorted.length; j++) {
      embeddings[i + j] = sorted[j].embedding;
    }

    // 进度 + 预估剩余时间
    const elapsed = (Date.now() - startTime) / 1000;
    const progress = (i + batch.length) / texts.length;
    const eta = progress > 0 ? (elapsed / progress) - elapsed : 0;
    console.log(`[embedding] ${i + batch.length}/${texts.length} (${(progress * 100).toFixed(0)}%) | 耗时 ${elapsed.toFixed(0)}s | 预计剩余 ${eta.toFixed(0)}s`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const dim = embeddings[0]?.length || 0;
  console.log(`[embedding] ✅ 全部完成: ${embeddings.length} 个向量, 维度 ${dim}, 总耗时 ${elapsed}s`);
  return embeddings;
}

/**
 * 构建全量索引
 * - 优先从缓存加载（磁盘文件，快）
 * - 缓存失效时重新调用 Embedding API 并保存缓存
 * - 返回 { chunks, embeddings }，embeddings[i] 对应 chunks[i]
 */
async function buildIndex() {
  const fingerprint = computeFilesFingerprint();

  // 尝试从缓存加载
  if (fs.existsSync(CACHE_FILE)) {
    try {
      console.log('[embedding] 发现缓存文件，正在验证...');
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (cached.fingerprint === fingerprint && cached.embeddings && cached.chunkCount) {
        // 重建 chunks 并验证数量一致
        const chunks = buildChunks();
        if (chunks.length === cached.chunkCount && cached.embeddings.length === cached.chunkCount) {
          console.log(`[embedding] ✅ 缓存有效，直接从磁盘加载 (${cached.embeddings.length} 个向量, 维度 ${cached.embeddings[0]?.length || 'N/A'})`);
          return { chunks, embeddings: cached.embeddings };
        }
      }
      console.log('[embedding] ⚠️ 缓存已过期（文档有变更），重新生成...');
    } catch (e) {
      console.log(`[embedding] ⚠️ 缓存读取失败 (${e.message})，重新生成...`);
    }
  } else {
    console.log('[embedding] 无缓存，需要首次生成向量...');
  }

  // 无缓存或缓存过期：重新计算
  const chunks = buildChunks();
  const embeddings = await computeEmbeddings(chunks);

  // 保存缓存
  const cacheData = {
    fingerprint,
    chunkCount: chunks.length,
    dimension: embeddings[0]?.length || 0,
    model: process.env.LLM_EMBEDDING_MODEL || 'text-embedding-3-small',
    createdAt: new Date().toISOString(),
    embeddings,
  };

  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheData));
    const sizeMB = (fs.statSync(CACHE_FILE).size / 1024 / 1024).toFixed(1);
    console.log(`[embedding] 💾 缓存已保存: ${CACHE_FILE} (${sizeMB} MB)`);
  } catch (e) {
    console.log(`[embedding] ⚠️ 缓存写入失败 (但索引已构建): ${e.message}`);
  }

  return { chunks, embeddings };
}

module.exports = { buildIndex };
