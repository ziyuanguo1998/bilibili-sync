/**
 * server.js —— Bilibili 视频同步 WebSocket 服务器入口
 *
 * 这是一个轻量级的 WebSocket 中继服务器，核心职责：
 * 1. 接受客户端（Chrome 扩展）的 WebSocket 连接
 * 2. 为每个连接分配唯一 clientId
 * 3. 管理基于房间的消息转发（同一房间内的用户互相同步）
 * 4. 处理连接断开时的清理工作
 *
 * 服务器不存储任何视频状态，仅做消息中继。
 *
 * 启动方式：
 *   npm start          # 默认监听 8080 端口
 *   PORT=3000 npm start # 自定义端口
 */

const { WebSocketServer } = require('ws');
const { RoomManager } = require('./room-manager');
const { handleMessage } = require('./message-handler');
const crypto = require('crypto');

// 服务器端口，优先使用环境变量
const PORT = process.env.PORT || 8080;

// 创建 WebSocket 服务器
const wss = new WebSocketServer({ port: PORT });

// 房间管理器实例
const roomManager = new RoomManager();

/**
 * 生成唯一的客户端 ID
 * @returns {string} UUID v4 格式的客户端标识
 */
function generateClientId() {
  return crypto.randomUUID();
}

/**
 * 向房间内的所有人广播消息（排除发送者自己）
 * @param {string} roomId - 目标房间ID
 * @param {object} message - 要广播的消息对象
 * @param {import('ws').WebSocket} excludeWs - 需要排除的连接（通常是消息发送者）
 */
function broadcastToRoom(roomId, message, excludeWs) {
  const room = roomManager.getRoom(roomId);
  if (!room) return;

  const data = JSON.stringify(message);
  let sentCount = 0;
  for (const client of room) {
    // 排除发送者，且只发给已就绪的连接
    if (client !== excludeWs && client.readyState === 1 /* WebSocket.OPEN */) {
      client.send(data);
      sentCount++;
    }
  }
  if (message.type !== 'HEARTBEAT_ACK') {
    console.log(`[转发] 房间 ${roomId} | 类型: ${message.type} | 发送给 ${sentCount} 人`);
  }
}

// ==================== 连接处理 ====================

wss.on('connection', (ws) => {
  // 为新连接分配唯一标识
  const clientId = generateClientId();
  ws.clientId = clientId;
  ws.roomId = null;

  console.log(`[连接] 新客户端连接: ${clientId}`);

  // 处理收到的消息
  ws.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      // 心跳消息太频繁，不打印
      if (message.type !== 'HEARTBEAT') {
        console.log(`[收到] 客户端 ${clientId} | 类型: ${message.type} | 数据:`, JSON.stringify(message.payload));
      }
      handleMessage(ws, message, roomManager, broadcastToRoom);
    } catch (e) {
      console.error(`[错误] 消息解析失败:`, e.message);
      ws.send(JSON.stringify({
        type: 'ROOM_ERROR',
        payload: { error: '消息格式无效' }
      }));
    }
  });

  // 处理连接断开
  ws.on('close', () => {
    console.log(`[断开] 客户端断开: ${clientId}`);

    // 如果用户在某个房间中，执行退出并通知其他人
    if (ws.roomId) {
      const roomId = ws.roomId;
      roomManager.leave(roomId, ws);
      broadcastToRoom(roomId, {
        type: 'PEER_LEFT',
        payload: {
          roomId,
          peerCount: roomManager.getRoomSize(roomId)
        }
      }, ws);
    }
  });

  // 处理连接错误
  ws.on('error', (err) => {
    console.error(`[错误] 客户端 ${clientId} 连接异常:`, err.message);
  });
});

// ==================== 服务器启动 ====================

console.log(`[启动] Bilibili 视频同步服务器已启动，监听端口: ${PORT}`);
console.log(`[提示] 使用 Ctrl+C 停止服务器`);
