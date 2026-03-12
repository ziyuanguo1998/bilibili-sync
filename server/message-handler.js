/**
 * message-handler.js —— 消息处理器
 *
 * 负责解析和分发客户端发来的 WebSocket 消息。
 * 服务器本身不存储视频状态，只做消息中继转发：
 * - 房间生命周期消息：JOIN_ROOM / LEAVE_ROOM
 * - 同步事件消息：SEEK / PLAY / PAUSE / SYNC_STATE / REQUEST_STATE（直接转发给房间内其他人）
 * - 心跳消息：HEARTBEAT（回复 HEARTBEAT_ACK）
 *
 * @param {import('ws').WebSocket} ws - 发送消息的客户端连接
 * @param {object} message - 解析后的 JSON 消息对象
 * @param {import('./room-manager').RoomManager} roomManager - 房间管理器实例
 * @param {function} broadcastToRoom - 广播函数，向房间内其他人发送消息
 */
function handleMessage(ws, message, roomManager, broadcastToRoom) {
  switch (message.type) {

    // ==================== 房间生命周期 ====================

    case 'JOIN_ROOM': {
      const { roomId } = message.payload;

      // 如果用户已在某个房间，先退出
      if (ws.roomId) {
        roomManager.leave(ws.roomId, ws);
      }

      // 加入新房间
      const peerCount = roomManager.join(roomId, ws);

      // 向加入者发送确认消息
      ws.send(JSON.stringify({
        type: 'ROOM_JOINED',
        payload: { roomId, peerCount, clientId: ws.clientId }
      }));

      // 通知房间内的其他人有新成员加入
      broadcastToRoom(roomId, {
        type: 'PEER_JOINED',
        payload: { roomId, peerCount }
      }, ws);

      console.log(`[房间] 用户 ${ws.clientId} 加入房间 ${roomId}，当前人数: ${peerCount}`);
      break;
    }

    case 'LEAVE_ROOM': {
      const roomId = ws.roomId;
      if (roomId) {
        roomManager.leave(roomId, ws);

        // 向退出者发送确认
        ws.send(JSON.stringify({
          type: 'ROOM_LEFT',
          payload: { roomId }
        }));

        // 通知房间内剩余的人
        broadcastToRoom(roomId, {
          type: 'PEER_LEFT',
          payload: { roomId, peerCount: roomManager.getRoomSize(roomId) }
        }, ws);

        console.log(`[房间] 用户 ${ws.clientId} 退出房间 ${roomId}`);
      }
      break;
    }

    // ==================== 同步事件（直接转发） ====================

    case 'SEEK':
    case 'PLAY':
    case 'PAUSE':
    case 'SYNC_STATE':
    case 'REQUEST_STATE': {
      // 将同步消息原样转发给同一房间内的其他人
      if (ws.roomId) {
        broadcastToRoom(ws.roomId, message, ws);
      }
      break;
    }

    // ==================== 心跳保活 ====================

    case 'HEARTBEAT': {
      ws.send(JSON.stringify({
        type: 'HEARTBEAT_ACK',
        payload: { timestamp: Date.now() }
      }));
      break;
    }

    default: {
      console.log(`[警告] 收到未知消息类型: ${message.type}`);
      break;
    }
  }
}

module.exports = { handleMessage };
