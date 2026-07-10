/**
 * 检索模块
 * 基于倒排索引 + BM25 相似度，从知识库中召回最相关的文档块
 */

const { tokenize } = require('./chunker');

/**
 * BM25 检索
 * @param {string} query - 用户查询
 * @param {Array} chunks - 所有文档块
 * @param {Map} invertedIndex - 倒排索引
 * @param {number} topK - 返回数量
 */
// ─── 同义词映射（口语 → 正式术语）─────────────────
const SYNONYM_MAP = {
  '年假': ['年休假', '带薪年休假'],
  '请假': ['休假', '假勤', '事假', '病假'],
  '工资': ['薪酬', '薪资', '报酬'],
  '试用期工资': ['新员工定薪', '试用期薪酬'],
  '五险一金': ['社保', '法定福利', '公积金', '住房公积金', '法定社会保险'],
  '社保': ['五险', '法定社会保险'],
  '打卡': ['考勤'],
  '转正': ['试用期转正', '转正答辩'],
  '入职': ['新员工', '报到', '入职流程'],
  '加班费': ['加班工资', '加班'],
  '发工资': ['发薪', '薪酬发放'],
  '产假': ['产前休养假'],
  '婚假': ['结婚'],
  '公积金': ['住房公积金'],
  '医保': ['医疗保险'],
};

/**
 * 用同义词扩展查询词
 */
function expandQuery(query) {
  let expanded = query;
  for (const [colloquial, formalList] of Object.entries(SYNONYM_MAP)) {
    if (query.includes(colloquial)) {
      expanded += ' ' + formalList.join(' ');
    }
  }
  return expanded;
}

function retrieve(query, chunks, invertedIndex, topK = 8) {
  // 同义词扩展
  const expandedQuery = expandQuery(query);
  const queryTerms = tokenize(expandedQuery);
  if (queryTerms.length === 0) return [];

  // 统计包含各 term 的文档数（用于 IDF）
  const docFreq = new Map();
  for (const term of queryTerms) {
    const docs = invertedIndex.get(term);
    docFreq.set(term, docs ? docs.size : 0);
  }

  // 去重：获取候选文档集合
  const candidateIds = new Set();
  // 扩展：对每个查询词找倒排索引中的匹配
  for (const term of queryTerms) {
    // 精确匹配
    const docs = invertedIndex.get(term);
    if (docs) docs.forEach(id => candidateIds.add(id));

    // 模糊匹配：前缀搜索
    for (const [key, docSet] of invertedIndex) {
      if (key.includes(term) || term.includes(key)) {
        docSet.forEach(id => candidateIds.add(id));
      }
      if (candidateIds.size > 500) break; // 限制候选集
    }
    if (candidateIds.size > 500) break;
  }

  // BM25 相关参数
  const k1 = 1.5;
  const b = 0.75;
  const N = chunks.length;

  // 计算平均文档长度
  const avgdl = chunks.reduce((sum, c) => sum + c.content.length, 0) / N;

  // 对每个候选文档计算 BM25 分数
  const chunkMap = new Map(chunks.map(c => [c.id, c]));
  const scored = [];

  for (const id of candidateIds) {
    const chunk = chunkMap.get(id);
    if (!chunk) continue;

    const docLen = chunk.content.length;
    let score = 0;

    for (const term of queryTerms) {
      const df = docFreq.get(term);
      if (!df || df === 0) continue;

      // IDF
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));

      // TF (term frequency in this chunk)
      const termRegex = new RegExp(escapeRegExp(term), 'gi');
      const matches = (chunk.content + ' ' + chunk.title).match(termRegex);
      const tf = matches ? matches.length : 0;
      if (tf === 0) continue;

      // BM25 score
      const numerator = tf * (k1 + 1);
      const denominator = tf + k1 * (1 - b + b * (docLen / avgdl));
      score += idf * (numerator / denominator);
    }

    // 标题加权：查询词出现在标题中加分
    const titleLower = chunk.title.toLowerCase();
    for (const term of queryTerms) {
      if (titleLower.includes(term)) {
        score *= 1.5;
      }
    }

    if (score > 0) {
      scored.push({ chunk, score });
    }
  }

  // 排序取 TopK
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, topK);

  // 对结果去重（相似内容合并）
  const deduped = [];
  const seenContent = new Set();
  for (const item of top) {
    // 取内容前30字做指纹
    const fingerprint = item.chunk.content.substring(0, 30);
    if (!seenContent.has(fingerprint)) {
      seenContent.add(fingerprint);
      deduped.push(item.chunk);
    }
  }

  return deduped.slice(0, topK);
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { retrieve };
