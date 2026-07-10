/**
 * 问答模块
 * - LLM 模式：调用 AI 代理生成带来源引用的自然语言回答
 * - 纯检索模式（fallback）：BM25 结果原文拼接
 */

// ─── LLM 模式 ──────────────────────────────────

function buildSystemPrompt(contexts) {
  const contextText = contexts
    .map((c, i) => `【资料${i + 1}】\n来源：${c.source}\n页码：${c.pageHint}\n内容：\n${c.content}`)
    .join('\n\n---\n\n');

  return `你是"浩鲸科技"公司的新人入职助手，专门回答新员工关于公司制度、薪酬、假勤、入职流程等问题。

你必须严格基于以下资料来回答用户的问题。回答具体要求：
1. 直接、清晰地回答用户问题，使用自然流畅的中文
2. 每个回答必须基于资料中的事实，不得编造
3. 如果资料中没有相关信息，明确说"根据现有资料，暂未找到相关信息，建议联系 HR 获取帮助"
4. 在回答末尾用【来源：XXX文档，第X页】标注引用
5. 回答格式友好，适当使用分点或列表

=== 公司制度参考资料 ===
${contextText}
=== 资料结束 ===`;
}

async function askLLM(query, contexts) {
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL || 'gpt-4o';
  const baseUrl = process.env.LLM_BASE_URL || 'https://lab.iwhalecloud.com/gpt-proxy/v1';

  if (!apiKey) {
    throw new Error('未配置 LLM_API_KEY');
  }

  const body = {
    model,
    messages: [
      { role: 'system', content: buildSystemPrompt(contexts) },
      { role: 'user', content: query },
    ],
    temperature: 0.3,
    max_tokens: 4096,
  };

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LLM API 错误 (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return {
    answer: data.choices[0].message.content,
    usage: data.usage,
    model: data.model,
  };
}

// ─── 纯检索模式 (fallback) ────────────────────

function buildAnswerFromDocs(contexts) {
  if (!contexts || contexts.length === 0) {
    return {
      answer: '抱歉，在现有资料库中未找到与您问题相关的信息。\n\n建议您联系 HR 或部门负责人获取帮助。',
      sources: [],
    };
  }

  const merged = mergeSameSource(contexts.slice(0, 5));
  const parts = ['根据公司制度文档，为您找到以下相关信息：\n'];
  const sources = [];

  for (let i = 0; i < merged.length; i++) {
    const m = merged[i];
    parts.push(`━━━  ${i + 1}. ${m.source}  ━━━`);
    parts.push(`📄 ${m.pageHint}`);
    parts.push('');
    parts.push(formatContent(m.content));
    parts.push('');
    sources.push({ source: m.source, title: m.title, pageHint: m.pageHint, snippet: m.content.substring(0, 200) });
  }

  parts.push('💡 以上内容均来自公司正式制度文档，如有疑问请联系人力资源部。');
  return { answer: parts.join('\n'), sources };
}

function mergeSameSource(contexts) {
  const result = [];
  for (const c of contexts) {
    const last = result[result.length - 1];
    if (last && last.source === c.source && last.pageHint === c.pageHint) {
      if (!last.content.includes(c.content.trim())) last.content += '\n\n' + c.content.trim();
    } else {
      result.push({ ...c, content: c.content.trim() });
    }
  }
  return result;
}

function formatContent(text) {
  return text
    .replace(/^.*版权所有\s*第\s*\d+\s*\/\s*\d+\s*页.*$/gm, '')
    .replace(/^第\s*\d+\s*\/\s*\d+\s*页\s*$/gm, '')
    .replace(/^\d+\s*\/\s*\d+\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── 统一入口 ──────────────────────────────────

function hasLLM() {
  return !!(process.env.LLM_API_KEY && process.env.LLM_API_KEY.trim());
}

module.exports = { askLLM, buildAnswerFromDocs, hasLLM };
