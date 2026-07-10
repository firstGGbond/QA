# 🐋 浩鲸科技 · 新人入职问答系统

基于 RAG（检索增强生成）的公司制度智能问答助手，帮助新员工快速查询薪酬、假勤、福利、入职流程等制度信息。

## ✨ 功能特性

- **📚 文档检索**：基于倒排索引 + BM25 算法，从 8 份公司制度文档中精准召回相关内容
- **🧠 AI 回答**：对接 DeepSeek V4 大模型，基于检索到的文档生成带来源引用的自然语言回答
- **🔍 关键词扩展**：内置同义词映射（如 "五险一金" → "社保/公积金"），提升检索命中率
- **💡 常见问题**：预设高频问题快捷入口，一键提问
- **📄 来源标注**：每个回答均标注出自哪份文档、第几页，有据可查
- **🔄 双模式运行**：无 LLM API 时自动降级为纯检索模式，仍可正常使用

## 🗂️ 项目结构

```
onboarding-qa/
├── data/                   # 知识库（8份制度文档，txt格式）
│   ├── 员工手册 x 6
│   ├── 员工假勤管理规定
│   └── 员工薪酬管理制度
├── public/                 # 前端静态文件
│   ├── index.html          # 主页面
│   ├── style.css           # 样式
│   └── app.js              # 前端交互逻辑
├── src/
│   ├── server.js           # Express 服务入口
│   ├── chunker.js          # 文档分块 & 倒排索引构建
│   ├── retriever.js        # BM25 检索 & 同义词扩展
│   └── qa.js               # LLM 调用 & 回答生成
├── .env.example            # 环境变量模板
└── package.json
```

## 🚀 快速启动

### 环境要求

- **Node.js** >= 18
- **npm** >= 9

### 1. 安装依赖

```bash
cd onboarding-qa
npm install
```

### 2. 配置环境变量

复制环境变量模板，填入真实的 API 密钥：

```bash
cp .env.example .env
```

编辑 `.env` 文件：

```env
# API 配置（浩鲸内部 AI 代理）
LLM_API_KEY=你的API密钥
LLM_MODEL=g-deepseek-v4-pro
LLM_BASE_URL=https://lab.iwhalecloud.com/gpt-proxy/v1
PORT=3000
```

> 💡 **不配置 `LLM_API_KEY` 也可以启动！** 系统会自动切换为**纯检索模式**，直接返回匹配到的文档原文。

### 3. 启动服务

```bash
# 生产模式
npm start

# 开发模式（文件变更自动重启）
npm run dev
```

启动成功后：

```
============================================================
  浩鲸科技 新人入职问答系统
============================================================
[chunker] 发现 8 个知识库文件
[chunker] 总计 XXX 个检索块
[mode] LLM 模式 (g-deepseek-v4-pro)
[index] 索引就绪: XXX 个文档块, XXX 个索引词
[server] 服务已启动: http://localhost:3000
```

### 4. 访问

打开浏览器访问 **http://localhost:3000**，开始提问吧！

## 📡 API 接口

### 健康检查

```
GET /api/health
```

返回示例：

```json
{
  "status": "ok",
  "chunks": 520,
  "indexTerms": 3400,
  "mode": "LLM 模式 (g-deepseek-v4-pro)",
  "model": "g-deepseek-v4-pro"
}
```

### 问答

```
POST /api/chat
Content-Type: application/json

{ "query": "试用期工资怎么算？" }
```

返回示例：

```json
{
  "query": "试用期工资怎么算？",
  "answer": "根据公司规定，试用期工资...",
  "sources": [
    {
      "source": "员工薪酬管理制度",
      "title": "员工薪酬管理制度 > 试用期薪酬",
      "pageHint": "第3页",
      "snippet": "新员工试用期工资按..."
    }
  ],
  "meta": {
    "retrieveMs": 12,
    "answerMs": 2345,
    "totalMs": 2357,
    "mode": "llm",
    "model": "g-deepseek-v4-pro",
    "contextsFound": 5
  }
}
```

## 🛠️ 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | 原生 HTML/CSS/JavaScript |
| 后端 | Node.js + Express |
| 检索 | 倒排索引 + BM25 + 中文 Bigram 分词 |
| AI | DeepSeek V4 Pro（兼容 OpenAI 接口格式） |

## ⚠️ 注意事项

- **`.env` 文件包含 API 密钥，已加入 `.gitignore`，不会被提交到 Git**
- 知识库文档（`data/` 目录下的 txt 文件）为公司内部制度文档，请勿外传
- LLM 接口使用的是浩鲸内部代理地址，仅限内网访问

## 📄 License

内部项目，仅供浩鲸科技内部使用。
