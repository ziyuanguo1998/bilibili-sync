/**
 * service-worker.js —— 扩展后台服务（Service Worker）
 *
 * 这是 Chrome 扩展的核心后台脚本，运行在 Manifest V3 的 Service Worker 中。
 * 主要职责：
 * 1. 维持与 WebSocket 服务器的长连接
 * 2. 在 content script（B站页面）和服务器之间双向转发消息
 * 3. 管理心跳保活，防止 MV3 Service Worker 被浏览器回收
 * 4. 处理断线自动重连（指数退避策略）
 *
 * 通信链路：
 *   B站页面 Content Script <-> Service Worker <-> WebSocket 服务器 <-> 对方的 Service Worker
 */

// ==================== 状态变量 ====================

/** @type {WebSocket|null} 当前的 WebSocket 连接 */
let ws = null;

/** @type {string|null} 当前加入的房间ID */
let roomId = null;

/** @type {string|null} 服务器分配的客户端ID */
let clientId = null;

/** @type {number|null} 当前活跃的B站标签页ID */
let currentTabId = null;

/** @type {number} 已尝试重连的次数（用于指数退避计算） */
let reconnectAttempts = 0;

/** @type {number} 最大重连等待时间（毫秒） */
const MAX_RECONNECT_DELAY = 30000;

/** @type {number|null} 心跳定时器ID */
let heartbeatInterval = null;

/** @type {number|null} 重连定时器ID */
let reconnectTimer = null;

/** @type {number} 当前房间内的在线人数 */
let peerCount = 0;

/** @type {string} 当前身份：'host' 或 'guest' */
let currentRole = 'host';

// ==================== WebSocket 连接管理 ====================

/**
 * 从 chrome.storage.local 中读取服务器地址，然后建立 WebSocket 连接
 */
function connect() {
  chrome.storage.local.get(['serverUrl'], (result) => {
    const serverUrl = result.serverUrl || 'ws://localhost:8080';
    connectToServer(serverUrl);
  });
}

/**
 * 建立 WebSocket 连接
 * @param {string} serverUrl - WebSocket 服务器地址
 */
function connectToServer(serverUrl) {
  // 如果已有连接，先关闭
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    ws.close();
  }

  console.log(`[连接] 正在连接服务器: ${serverUrl}`);
  ws = new WebSocket(serverUrl);

  ws.onopen = () => {
    console.log('[连接] 已连接到服务器');
    reconnectAttempts = 0; // 重置重连计数
    startHeartbeat();

    // 如果之前在某个房间中，自动重新加入
    if (roomId) {
      ws.send(JSON.stringify({
        type: 'JOIN_ROOM',
        payload: { roomId }
      }));
    }
  };

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      handleServerMessage(message);
    } catch (e) {
      console.error('[错误] 解析服务器消息失败:', e);
    }
  };

  ws.onclose = () => {
    console.log('[连接] 与服务器断开');
    stopHeartbeat();
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error('[错误] WebSocket 连接异常:', err);
    // onclose 会自动触发，无需在这里额外处理
  };
}

/**
 * 安排自动重连（指数退避策略）
 * 重连间隔：1s, 2s, 4s, 8s, 16s, 30s（封顶）
 */
function scheduleReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }

  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
  reconnectAttempts++;
  console.log(`[重连] 将在 ${delay / 1000} 秒后尝试第 ${reconnectAttempts} 次重连...`);

  reconnectTimer = setTimeout(() => {
    connect();
  }, delay);
}

// ==================== 心跳保活 ====================

/**
 * 启动心跳定时器
 * 每 25 秒发送一次心跳，确保：
 * 1. WebSocket 连接不被中间代理/防火墙关闭
 * 2. MV3 Service Worker 不会因空闲而被浏览器停止
 */
function startHeartbeat() {
  stopHeartbeat();
  heartbeatInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'HEARTBEAT',
        payload: { timestamp: Date.now() }
      }));
    }
  }, 25000);
}

/**
 * 停止心跳定时器
 */
function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

// ==================== 服务器消息处理 ====================

/**
 * 处理从 WebSocket 服务器收到的消息
 * @param {object} message - 解析后的 JSON 消息
 */
function handleServerMessage(message) {
  switch (message.type) {

    // 房间加入确认
    case 'ROOM_JOINED':
      clientId = message.payload.clientId;
      peerCount = message.payload.peerCount;
      // 通知 popup 更新状态
      notifyPopup({ type: 'ROOM_JOINED', payload: message.payload });
      break;

    // 新成员加入，向对方发送我们当前的视频状态
    case 'PEER_JOINED':
      peerCount = message.payload.peerCount;
      forwardToContentScript({ type: 'REQUEST_STATE' });
      notifyPopup({ type: 'PEER_JOINED', payload: message.payload });
      break;

    // 有人退出
    case 'PEER_LEFT':
      peerCount = message.payload.peerCount;
      notifyPopup({ type: 'PEER_LEFT', payload: message.payload });
      break;

    // 同步事件：转发给 content script 执行
    case 'SEEK':
    case 'PLAY':
    case 'PAUSE':
    case 'SYNC_STATE':
    case 'REQUEST_STATE':
      forwardToContentScript(message);
      break;

    // 房间错误
    case 'ROOM_ERROR':
      notifyPopup({ type: 'ROOM_ERROR', payload: message.payload });
      break;

    // 心跳响应，无需处理
    case 'HEARTBEAT_ACK':
      break;

    default:
      console.log('[警告] 收到未知服务器消息:', message.type);
  }
}

// ==================== 消息转发辅助函数 ====================

/**
 * 将消息转发给当前活跃的B站标签页中的 content script
 * @param {object} message - 要转发的消息
 */
function forwardToContentScript(message) {
  if (currentTabId) {
    chrome.tabs.sendMessage(currentTabId, message).catch((err) => {
      // content script 可能还未加载或页面已关闭
      console.warn('[转发] 无法发送到 content script:', err.message);
    });
  }
}

/**
 * 通知 popup 弹窗更新（popup 可能未打开，忽略错误）
 * @param {object} message - 要发送的消息
 */
function notifyPopup(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // popup 未打开时会报错，这是正常的，直接忽略
  });
}

// ==================== 接收内部消息（来自 content script 和 popup） ====================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // 记录发送消息的标签页ID（content script 所在的B站页面）
  if (sender.tab) {
    currentTabId = sender.tab.id;
  }

  switch (message.type) {

    // Popup 请求加入房间
    case 'JOIN_ROOM':
      roomId = message.payload.roomId;
      currentRole = message.payload.role || 'host';
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        connect(); // 尚未连接，先连接再加入
      } else {
        ws.send(JSON.stringify(message));
      }
      break;

    // Popup 请求退出房间
    case 'LEAVE_ROOM':
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
      roomId = null;
      peerCount = 0;
      currentRole = 'host';
      break;

    // 同步事件（来自 content script），转发到服务器
    case 'SEEK':
    case 'PLAY':
    case 'PAUSE':
    case 'SYNC_STATE':
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
      break;

    // Popup 查询当前状态
    case 'GET_STATUS':
      sendResponse({
        connected: ws && ws.readyState === WebSocket.OPEN,
        roomId: roomId,
        clientId: clientId,
        peerCount: peerCount,
        role: currentRole
      });
      return true; // 异步 sendResponse

    // Popup 更新服务器地址
    case 'UPDATE_SERVER_URL':
      chrome.storage.local.set({ serverUrl: message.payload.serverUrl }, () => {
        // 断开当前连接，使用新地址重连
        if (ws) {
          ws.close();
        }
        connect();
      });
      break;
  }
});
