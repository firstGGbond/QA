/**
 * 前端聊天交互逻辑
 */

const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('questionInput');
const sendBtn = document.getElementById('sendBtn');
const newChatBtn = document.getElementById('newChatBtn');
const statusEl = document.getElementById('status');

let isLoading = false;

// 欢迎消息模板
const WELCOME_HTML = `
  <div class="msg system-msg">
    <div class="msg-content">
      <p>👋 你好！我是浩鲸科技新人入职助手。</p>
      <p>我可以回答关于 <strong>薪酬制度、假勤规定、员工福利、入职流程</strong> 等问题。</p>
      <p>所有回答均来自公司正式制度文档，并会标注来源。</p>
    </div>
  </div>
`;

// ─── 初始化 ──────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  checkHealth();
  bindEvents();
  inputEl.focus();
});

function checkHealth() {
  fetch('/api/health')
    .then(r => r.json())
    .then(data => {
      if (data.status === 'ok') {
        statusEl.textContent = `✅ 服务就绪 · ${data.chunks}个文档块 · ${data.model}`;
        statusEl.className = 'status-ok';
      }
    })
    .catch(() => {
      statusEl.textContent = '❌ 服务未连接';
      statusEl.className = 'status-error';
    });
}

function bindEvents() {
  // 发送按钮
  sendBtn.addEventListener('click', handleSend);

  // 新会话按钮
  newChatBtn.addEventListener('click', handleNewChat);

  // 键盘事件
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  // 自动调整输入框高度
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  });

  // 快捷问题按钮
  document.querySelectorAll('.q-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const q = btn.getAttribute('data-q');
      if (q && !isLoading) {
        inputEl.value = q;
        handleSend();
      }
    });
  });
}

// ─── 新会话 ──────────────────────────────────
function handleNewChat() {
  messagesEl.innerHTML = WELCOME_HTML;
  inputEl.value = '';
  inputEl.style.height = 'auto';
  inputEl.focus();
}

// ─── 发送消息 ────────────────────────────────
async function handleSend() {
  const query = inputEl.value.trim();
  if (!query || isLoading) return;

  isLoading = true;
  sendBtn.disabled = true;
  inputEl.value = '';
  inputEl.style.height = 'auto';

  // 添加用户消息
  addMessage('user', query);

  // 添加加载中的机器人消息
  const loadingMsg = addMessage('bot', '', true);

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });

    const data = await res.json();

    // 移除加载消息
    loadingMsg.remove();

    if (data.error) {
      addMessage('error', `❌ ${data.error}<br><small>${data.detail || ''}</small>`);
      return;
    }

    // 渲染回答
    const botMsg = addMessage('bot', data.answer);

    // 渲染来源引用
    if (data.sources && data.sources.length > 0) {
      addSources(botMsg, data.sources);
    }

  } catch (err) {
    loadingMsg.remove();
    addMessage('error', `❌ 请求失败：${err.message}`);
  } finally {
    isLoading = false;
    sendBtn.disabled = false;
    inputEl.focus();
  }
}

// ─── 添加消息 ────────────────────────────────
function addMessage(type, content, isThinking) {
  const msgDiv = document.createElement('div');

  if (type === 'user') {
    msgDiv.className = 'msg user-msg';
    msgDiv.innerHTML = `
      <div class="msg-avatar">👤</div>
      <div class="msg-content"><p>${escapeHtml(content)}</p></div>
    `;
  } else if (type === 'error') {
    msgDiv.className = 'msg system-msg';
    msgDiv.innerHTML = `
      <div class="msg-avatar">⚠️</div>
      <div class="msg-content"><p>${content}</p></div>
    `;
  } else if (isThinking) {
    msgDiv.className = 'msg bot-msg';
    msgDiv.id = 'loading-msg';
    msgDiv.innerHTML = `
      <div class="msg-avatar">🐋</div>
      <div class="msg-content">
        <div class="typing-indicator">
          <span></span><span></span><span></span>
        </div>
      </div>
    `;
  } else {
    msgDiv.className = 'msg bot-msg';
    msgDiv.innerHTML = `
      <div class="msg-avatar">🐋</div>
      <div class="msg-content">${renderMarkdown(content)}</div>
    `;
  }

  messagesEl.appendChild(msgDiv);
  scrollToBottom();
  return msgDiv;
}

// ─── 来源引用 ────────────────────────────────
function addSources(msgEl, sources) {
  const contentEl = msgEl.querySelector('.msg-content');
  const sourcesDiv = document.createElement('div');
  sourcesDiv.className = 'sources';

  const toggleId = `sources-${Date.now()}`;
  sourcesDiv.innerHTML = `
    <div class="sources-toggle" onclick="this.nextElementSibling.classList.toggle('open')">
      📚 查看引用来源 (${sources.length}条)
    </div>
    <div class="sources-list">
      ${sources.map((s, i) => `
        <div class="source-item">
          <span class="source-name">${i + 1}. ${escapeHtml(s.source)}</span>
          <span class="source-page">[${escapeHtml(s.pageHint)}]</span>
          <span class="source-snippet">${escapeHtml(s.snippet)}...</span>
        </div>
      `).join('')}
    </div>
  `;

  contentEl.appendChild(sourcesDiv);
}

// ─── 简易 Markdown 渲染 ───────────────────────
function renderMarkdown(text) {
  if (!text) return '';

  let html = escapeHtml(text);

  // 粗体 **text**
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // 行内代码 `code`
  html = html.replace(/`(.+?)`/g, '<code style="background:#f1f5f9;padding:1px 4px;border-radius:3px;font-size:0.9em;">$1</code>');

  // 换行
  html = html.replace(/\n/g, '<br>');

  // 识别带编号的列表项
  html = html.replace(/(<br>|^)(\d+[、．.])/g, '$1$2');

  return html;
}

// ─── HTML 转义 ────────────────────────────────
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ─── 滚动到底部 ──────────────────────────────
function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
