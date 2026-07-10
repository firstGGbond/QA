/**
 * 主服务器
 * Express + 静态文件 + REST API
 */

require('dotenv').config();

const express = require('express');
const path = require('path');
const { buildIndex } = require('./chunker');
const { retrieve } = require('./retriever');
const { askLLM, buildAnswerFromDocs, hasLLM } = require('./qa');

const PORT = process.env.PORT || 3000;

// ─── 启动时构建索引（异步：需要调用 Embedding API）──
(async () => {
  console.log('='.repeat(60));
  console.log('  浩鲸科技 新人入职问答系统');
  console.log('='.repeat(60));

  const { chunks, embeddings } = await buildIndex();

  const llmAvailable = hasLLM();
  const mode = llmAvailable
    ? `LLM 模式 (${process.env.LLM_MODEL || 'gpt-4o'})`
    : '纯检索模式 (检索匹配)';
  const embeddingModel = process.env.LLM_EMBEDDING_MODEL || 'text-embedding-3-small';

  console.log(`[mode] ${mode}`);
  console.log(`[embedding] 向量模型: ${embeddingModel}, 维度: ${embeddings[0]?.length || 'N/A'}`);
  console.log(`[index] 索引就绪: ${chunks.length} 个文档块, ${embeddings.length} 个向量`);

  // ─── Express App ──────────────────────────────────
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // API: 健康检查
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      chunks: chunks.length,
      embeddings: embeddings.length,
      dimension: embeddings[0]?.length || 0,
      embeddingModel,
      mode,
      model: llmAvailable ? (process.env.LLM_MODEL || 'gpt-4o') : 'none',
    });
  });

  // API: 问答
  app.post('/api/chat', async (req, res) => {
    const { query } = req.body;
    if (!query || query.trim().length === 0) {
      return res.status(400).json({ error: '请输入问题' });
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

  // ─── 启动 ────────────────────────────────────────
  app.listen(PORT, () => {
    console.log(`[server] 服务已启动: http://localhost:${PORT}`);
    console.log(`[server] API 端点: POST http://localhost:${PORT}/api/chat`);
    console.log(`[server] 按 Ctrl+C 停止服务`);
  });
})();
