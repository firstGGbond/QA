/**
 * 主服务器
 * Express + 静态文件 + REST API
 * - 服务立即启动，无需等待索引就绪
 * - 向量索引在后台异步加载（首次慢，后续从缓存秒加载）
 */

require('dotenv').config();

const express = require('express');
const path = require('path');
const { buildIndex } = require('./chunker');
const { retrieve } = require('./retriever');
const { askLLM, buildAnswerFromDocs, hasLLM } = require('./qa');

const PORT = process.env.PORT || 3000;

// ─── 全局状态 ──────────────────────────────────
let chunks = [];
let embeddings = [];
let indexReady = false;
let indexError = null;

// ─── Express App（立即启动）─────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// API: 健康检查
app.get('/api/health', (_req, res) => {
  const llmAvailable = hasLLM();
  res.json({
    status: indexReady ? 'ok' : 'initializing',
    chunks: chunks.length,
    embeddings: embeddings.length,
    dimension: embeddings[0]?.length || 0,
    embeddingModel: process.env.LLM_EMBEDDING_MODEL || 'text-embedding-3-small',
    mode: llmAvailable ? `LLM 模式 (${process.env.LLM_MODEL || 'gpt-4o'})` : '纯检索模式',
    model: llmAvailable ? (process.env.LLM_MODEL || 'gpt-4o') : 'none',
    error: indexError,
  });
});

// API: 问答
app.post('/api/chat', async (req, res) => {
  const { query } = req.body;
  if (!query || query.trim().length === 0) {
    return res.status(400).json({ error: '请输入问题' });
  }

  // 索引尚未就绪
  if (!indexReady) {
    return res.status(503).json({
      query,
      answer: '## ⏳ 系统正在初始化...\n\n'
        + `向量索引正在加载中（${chunks.length} 个文档块），请稍等片刻后重试。\n\n`
        + (indexError
          ? `> ⚠️ 初始化遇到问题：${indexError}\n\n> 💡 请检查 .env 中 LLM_API_KEY 和 LLM_EMBEDDING_MODEL 配置是否正确，然后重启服务。`
          : '> 💡 首次启动需要调用 Embedding API 生成向量，通常需要 1-2 分钟。后续启动会从缓存秒加载。'),
      sources: [],
      meta: { retrieveMs: 0, answerMs: 0, totalMs: 0, mode: 'initializing' },
    });
  }

  console.log(`\n[qa] 问题: ${query}`);

  try {
    // 1. 向量检索相关文档
    const startRetrieve = Date.now();
    const contexts = await retrieve(query.trim(), chunks, embeddings, 8);
    const retrieveMs = Date.now() - startRetrieve;

    console.log(`[qa] 检索到 ${contexts.length} 个相关块 (${retrieveMs}ms)`);
    for (const c of contexts.slice(0, 3)) {
      console.log(`[qa]   - ${c.source} | ${c.title} | ${c.pageHint}`);
    }

    if (contexts.length === 0) {
      return res.json({
        query,
        answer: '抱歉，在现有资料库中未找到与您问题相关的信息。建议您联系 HR 或部门负责人获取帮助。',
        sources: [],
        meta: { retrieveMs, answerMs: 0, totalMs: retrieveMs },
      });
    }

    // 2. 生成回答
    const llmAvailable = hasLLM();
    const startAnswer = Date.now();
    let result, answerMs;

    if (llmAvailable) {
      result = await askLLM(query.trim(), contexts);
      answerMs = Date.now() - startAnswer;
      console.log(`[qa] LLM 生成回答 (${answerMs}ms), tokens: ${result.usage?.total_tokens || 'N/A'}`);
    } else {
      result = buildAnswerFromDocs(contexts);
      answerMs = Date.now() - startAnswer;
      console.log(`[qa] 构建回答 (${answerMs}ms)`);
    }

    // 3. 返回结果
    res.json({
      query,
      answer: result.answer,
      sources: contexts.map(c => ({
        source: c.source,
        title: c.title,
        pageHint: c.pageHint,
        snippet: c.content.substring(0, 200),
      })),
      meta: {
        retrieveMs,
        answerMs,
        totalMs: retrieveMs + answerMs,
        mode: llmAvailable ? 'llm' : 'retrieval-only',
        model: llmAvailable ? (result.model || process.env.LLM_MODEL) : 'none',
        contextsFound: contexts.length,
      },
    });

  } catch (err) {
    console.error(`[qa] 错误:`, err.message);
    res.status(500).json({
      error: '问答处理失败',
      detail: err.message,
    });
  }
});

// ─── 后台初始化索引 + 启动服务 ──────────────────
console.log('='.repeat(60));
console.log('  浩鲸科技 新人入职问答系统');
console.log('='.repeat(60));

(async () => {
  try {
    const result = await buildIndex();
    chunks = result.chunks;
    embeddings = result.embeddings;
    indexReady = true;

    const llmAvailable = hasLLM();
    const mode = llmAvailable
      ? `LLM 模式 (${process.env.LLM_MODEL || 'gpt-4o'})`
      : '纯检索模式';
    const embeddingModel = process.env.LLM_EMBEDDING_MODEL || 'text-embedding-3-small';

    console.log(`[mode] ${mode}`);
    console.log(`[embedding] 向量模型: ${embeddingModel}, 维度: ${embeddings[0]?.length || 'N/A'}`);
    console.log(`[index] ✅ 索引就绪: ${chunks.length} 个文档块, ${embeddings.length} 个向量`);
  } catch (err) {
    indexError = err.message;
    console.error(`[index] ❌ 索引构建失败: ${err.message}`);
    console.error('[index] 服务将以降级模式运行（/api/chat 返回初始化提示）');
  }
})();

// 立即启动监听
app.listen(PORT, () => {
  console.log(`[server] 服务已启动: http://localhost:${PORT}`);
  console.log(`[server] API 端点: POST http://localhost:${PORT}/api/chat`);
  console.log(`[server] 索引在后台加载中，请稍候...`);
  console.log(`[server] 按 Ctrl+C 停止服务`);
});
