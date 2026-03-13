/**
 * popup.js —— 扩展弹窗交互逻辑
 *
 * 负责弹窗 UI 的所有交互行为：
 * 1. 加入/退出房间
 * 2. 显示连接状态和在线人数
 * 3. 服务器地址配置
 *
 * 与 service worker 通过 chrome.runtime.sendMessage 通信
 */

// ==================== DOM 元素引用 ====================

const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const joinSection = document.getElementById('join-section');
const roomSection = document.getElementById('room-section');
const roomInput = document.getElementById('room-input');
const joinBtn = document.getElementById('join-btn');
const leaveBtn = document.getElementById('leave-btn');
const roomName = document.getElementById('room-name');
const peerCountEl = document.getElementById('peer-count');
const errorMsg = document.getElementById('error-msg');
const serverUrlInput = document.getElementById('server-url');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const offsetSlider = document.getElementById('offset-slider');
const offsetInput = document.getElementById('offset-input');

/** 记录上一次偏移量，用于计算差值 */
let lastOffsetMs = 0;

/** 滑动开始时的偏移量（用于计算一次滑动操作的总差值） */
let slideStartOffsetMs = null;

/** ADJUST_TIME 防抖定时器 */
let adjustDebounceTimer = null;

// ==================== 初始化 ====================

/**
 * 弹窗打开时，查询当前状态并更新 UI
 */
function init() {
  // 从存储中读取服务器地址
  chrome.storage.local.get(['serverUrl', 'timeOffsetMs'], (result) => {
    serverUrlInput.value = result.serverUrl || 'ws://localhost:8080';
    const offset = result.timeOffsetMs || 0;
    offsetSlider.value = offset;
    offsetInput.value = offset;
    lastOffsetMs = offset;
  });

  // 向 service worker 查询当前连接和房间状态
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
    if (chrome.runtime.lastError) {
      updateStatus('disconnected', '未连接');
      return;
    }
    if (response) {
      if (response.roomId) {
        // 已在房间中
        showRoomView(response.roomId, response.peerCount);
        updateStatus('in-room', `已连接 - 房间 ${response.roomId}`);
      } else if (response.connected) {
        // 已连接但未加入房间
        updateStatus('connected', '已连接');
      } else {
        updateStatus('disconnected', '未连接');
      }
    }
  });
}

// ==================== UI 更新函数 ====================

/**
 * 更新连接状态指示器
 * @param {'connected'|'disconnected'|'in-room'} state - 状态
 * @param {string} text - 显示文本
 */
function updateStatus(state, text) {
  statusDot.className = `dot ${state}`;
  statusText.textContent = text;
}

/**
 * 切换到「已加入房间」视图
 * @param {string} room - 房间ID
 * @param {number} count - 在线人数
 */
function showRoomView(room, count) {
  joinSection.classList.add('hidden');
  roomSection.classList.remove('hidden');
  roomName.textContent = room;
  peerCountEl.textContent = count || 1;
}

/**
 * 切换到「未加入房间」视图
 */
function showJoinView() {
  roomSection.classList.add('hidden');
  joinSection.classList.remove('hidden');
}

/**
 * 显示错误消息（3秒后自动隐藏）
 * @param {string} msg - 错误信息
 */
function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.remove('hidden');
  setTimeout(() => {
    errorMsg.classList.add('hidden');
  }, 3000);
}

// ==================== 事件处理 ====================

/**
 * 点击「加入房间」按钮
 */
joinBtn.addEventListener('click', () => {
  const room = roomInput.value.trim();
  if (!room) {
    showError('请输入房间名');
    return;
  }

  chrome.runtime.sendMessage({
    type: 'JOIN_ROOM',
    payload: { roomId: room }
  });
});

/**
 * 在输入框中按回车也可以加入房间
 */
roomInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    joinBtn.click();
  }
});

/**
 * 点击「退出房间」按钮
 */
leaveBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'LEAVE_ROOM' });
  showJoinView();
  updateStatus('connected', '已连接');
});

/**
 * 保存服务器地址设置
 */
saveSettingsBtn.addEventListener('click', () => {
  const url = serverUrlInput.value.trim();
  if (!url) {
    showError('请输入服务器地址');
    return;
  }

  chrome.runtime.sendMessage({
    type: 'UPDATE_SERVER_URL',
    payload: { serverUrl: url }
  });

  saveSettingsBtn.textContent = '已保存';
  setTimeout(() => {
    saveSettingsBtn.textContent = '保存';
  }, 1500);
});

// ==================== 接收 service worker 的状态更新 ====================

chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case 'ROOM_JOINED':
      showRoomView(message.payload.roomId, message.payload.peerCount);
      updateStatus('in-room', `已连接 - 房间 ${message.payload.roomId}`);
      break;

    case 'PEER_JOINED':
      peerCountEl.textContent = message.payload.peerCount;
      break;

    case 'PEER_LEFT':
      peerCountEl.textContent = message.payload.peerCount;
      break;

    case 'ROOM_ERROR':
      showError(message.payload.error || '房间操作失败');
      break;
  }
});

// ==================== 时间偏移量调节 ====================

/**
 * 保存偏移量到 storage 并同步滑块和输入框，同时实时调整本地视频进度
 * @param {number} newMs - 新偏移量（毫秒）
 * @param {'slider'|'input'} source - 触发源，避免重复赋值
 */
function updateOffset(newMs, source) {
  // 限制范围
  newMs = Math.max(-500, Math.min(500, newMs));

  // 记住这次滑动操作开始时的偏移量
  if (slideStartOffsetMs === null) {
    slideStartOffsetMs = lastOffsetMs;
  }

  lastOffsetMs = newMs;

  if (source !== 'slider') offsetSlider.value = newMs;
  if (source !== 'input') offsetInput.value = newMs;
  chrome.storage.local.set({ timeOffsetMs: newMs });

  // 防抖：用户停止滑动 200ms 后，才发送一次总差值给 content script
  // 避免连续快速滑动时频繁触发 seeked 事件导致同步回环
  if (adjustDebounceTimer) clearTimeout(adjustDebounceTimer);
  adjustDebounceTimer = setTimeout(() => {
    const totalDelta = newMs - slideStartOffsetMs;
    slideStartOffsetMs = null; // 重置，准备下一次滑动

    if (totalDelta !== 0) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, {
            type: 'ADJUST_TIME',
            payload: { deltaMs: totalDelta }
          }).catch(() => {});
        }
      });
    }
  }, 200);
}

offsetSlider.addEventListener('input', () => {
  updateOffset(Number(offsetSlider.value), 'slider');
});

offsetInput.addEventListener('change', () => {
  updateOffset(Number(offsetInput.value), 'input');
});

// ==================== 启动 ====================

init();
