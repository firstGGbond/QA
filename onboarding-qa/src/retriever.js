/**
 * 检索模块
 * 基于向量嵌入 + 余弦相似度，从知识库中召回最相关的文档块
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
 * 用同义词扩展查询文本
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

/**
 * 计算两个向量的余弦相似度
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} 相似度 [0, 1]
 */
function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * 调用 Embedding API 将查询文本转为向量
 * @param {string} query - 用户查询
 * @returns {Promise<number[]>} 查询向量
 */
async function embedQuery(query) {
  const apiKey = process.env.LLM_API_KEY;
  const baseUrl = (process.env.LLM_BASE_URL || 'https://lab.iwhalecloud.com/gpt-proxy/v1').replace(/\/+$/, '');
  const model = process.env.LLM_EMBEDDING_MODEL || 'text-embedding-3-small';

  // 同义词扩展查询文本
  const expandedText = expandQuery(query);

  const res = await fetch(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, input: [expandedText] }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`查询 Embedding API 错误 (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return data.data[0].embedding;
}

/**
 * 向量余弦相似度检索
 * @param {string} query - 用户查询
 * @param {Object[]} chunks - 所有文档块
 * @param {number[][]} embeddings - chunks 对应的向量（顺序一致）
 * @param {number} topK - 返回数量
 * @returns {Promise<Object[]>} 最相关的文档块
 */
async function retrieve(query, chunks, embeddings, topK = 8) {
  if (!query || query.trim().length === 0) return [];
  if (!chunks || chunks.length === 0) return [];
  if (!embeddings || embeddings.length !== chunks.length) {
    throw new Error(`向量数量 (${embeddings?.length}) 与 chunks 数量 (${chunks?.length}) 不匹配`);
  }

  // 1. 将查询文本转为向量（带同义词扩展）
  console.log(`[retrieve] 查询向量化...`);
  const queryVec = await embedQuery(query.trim());

  // 2. 计算每个 chunk 与查询的余弦相似度
  console.log(`[retrieve] 计算 ${chunks.length} 个 chunk 的相似度...`);
  const scored = [];
  for (let i = 0; i < chunks.length; i++) {
    const score = cosineSimilarity(queryVec, embeddings[i]);
    if (score > 0) {
      scored.push({ chunk: chunks[i], score });
    }
  }

  // 3. 按相似度降序排列
  scored.sort((a, b) => b.score - a.score);

  // 4. 取 TopK
  const top = scored.slice(0, topK);

  console.log(`[retrieve] Top ${topK} 相似度: ${top.map(t => t.score.toFixed(4)).join(', ')}`);

  // 5. 对结果去重（相似内容合并）
  const deduped = [];
  const seenContent = new Set();
  for (const item of top) {
    // 取内容前40字做指纹（向量检索可能召回更相似的小差异内容）
    const fingerprint = item.chunk.content.substring(0, 40).trim();
    if (!seenContent.has(fingerprint)) {
      seenContent.add(fingerprint);
      deduped.push(item.chunk);
    }
  }

  return deduped.slice(0, topK);
}

module.exports = { retrieve, cosineSimilarity, embedQuery };
