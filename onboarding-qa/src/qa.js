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

  return `你是"浩鲸科技"公司的新人入职助手，专门回答新员工关于公司制度、薪酬、假勤、入职流程、员工福利等问题。

## 你的核心职责
帮助新员工快速、准确地了解公司各项规章制度，消除入职困惑，让新员工感受到公司的专业和关怀。

## 回答要求（非常重要）

### 1. 详尽全面
- 不要只给一句话结论，要**充分展开说明**，把来龙去脉讲清楚
- 涉及数字、比例、时限的具体数据必须明确列出
- 如果一个制度有多种情况或条件分支，请**逐一列出并说明适用条件**
- 预计每个回答至少在 200 字以上，复杂问题应在 500-1000 字

### 2. 结构清晰
- 使用**多级标题**组织内容（如：## 基本规定、## 特殊情况、## 申请流程、## 注意事项）
- 善用分点列表（1. 2. 3.）罗列关键信息
- 关键数字、重要条款用**加粗**突出

### 3. 实用导向
- 除了回答"是什么"，还要告诉新员工"怎么做"（去哪里申请、找谁、填什么表）
- 补充常见的注意事项和容易忽略的细节
- 如果制度中有例外情况，一定要说明

### 4. 严格基于资料
- 每个事实必须来源于参考资料，**绝对不得编造或猜测**
- 如果资料之间有不一致的地方，指出差异并建议以最新版本为准
- 如果资料中没有相关信息，明确说"根据现有资料，暂未找到相关信息，建议联系 HR 获取帮助"，并**给出联系 HR 的具体建议**（如：联系部门 HRBP 或拨打人力资源部电话）

### 5. 引用来源
- 在回答中自然嵌入来源引用，例如："根据《员工手册》第X页规定..."
- 在回答末尾统一列出本次使用的参考资料清单：\`\`\`
📚 参考资料：
- 《XXX文档》第X页
- 《XXX制度》第X-Y页
\`\`\`

### 6. 语气亲和
- 使用温暖、友好的语气，像一位有经验的同事在耐心解答
- 适当使用表情符号增加亲和力（如 📌 ⚠️ ✅ 💡 📅 💰）
- 在回答结尾可以附上一句温馨提醒或鼓励

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
    temperature: 0.6,
    max_tokens: 8192,
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
      answer: '## 😕 抱歉，未找到相关信息\n\n'
        + '在现有资料库中，暂未检索到与您问题直接相关的内容。\n\n'
        + '### 💡 建议您尝试：\n\n'
        + '1. **换个问法** — 尝试用不同的关键词重新提问（如用"年假"代替"休假"）\n'
        + '2. **缩小范围** — 将问题拆分为更具体的小问题\n'
        + '3. **联系 HR** — 直接联系您所在部门的 HRBP 或拨打人力资源部服务热线\n\n'
        + '> ⚠️ 当前为纯检索模式（未配置 LLM），回答直接来自文档匹配，可能不够精准。',
      sources: [],
    };
  }

  const merged = mergeSameSource(contexts.slice(0, 5));
  const parts = ['## 📋 根据公司制度文档，为您找到以下相关信息：\n'];
  const sources = [];

  for (let i = 0; i < merged.length; i++) {
    const m = merged[i];
    parts.push(`---`);
    parts.push(`### 📄 ${i + 1}. ${m.source}  |  ${m.pageHint}`);
    parts.push('');
    parts.push(formatContent(m.content));
    parts.push('');
    sources.push({ source: m.source, title: m.title, pageHint: m.pageHint, snippet: m.content.substring(0, 200) });
  }

  parts.push('---');
  parts.push('');
  parts.push('## ⚠️ 重要提醒');
  parts.push('');
  parts.push('以上内容均为公司正式制度文档的直接摘录，请仔细阅读。');
  parts.push('由于当前运行在**纯检索模式**（未配置 AI 大模型），系统仅能展示匹配到的文档原文，无法进行归纳总结和自然语言回答。');
  parts.push('');
  parts.push('### 📚 参考资料');
  const seenSources = new Set();
  for (const s of sources) {
    if (!seenSources.has(s.source)) {
      seenSources.add(s.source);
      parts.push(`- 《${s.source}》${s.pageHint}`);
    }
  }
  parts.push('');
  parts.push('如有疑问，请联系您所在部门的 HRBP 或人力资源部获取进一步帮助。💪');
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
