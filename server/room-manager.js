/**
 * room-manager.js —— 房间管理器
 *
 * 负责管理同步房间的生命周期：
 * - 创建房间（首个用户加入时自动创建）
 * - 用户加入/退出房间
 * - 查询房间信息
 * - 清理空房间
 *
 * 数据结构：使用 Map<roomId, Set<WebSocket>> 存储房间与连接的映射关系
 */

class RoomManager {
  constructor() {
    /** @type {Map<string, Set<import('ws').WebSocket>>} 房间ID -> 连接集合 */
    this.rooms = new Map();
  }

  /**
   * 用户加入房间
   * 如果房间不存在则自动创建
   * @param {string} roomId - 房间ID
   * @param {import('ws').WebSocket} ws - 用户的 WebSocket 连接
   * @returns {number} 加入后房间内的人数
   */
  join(roomId, ws) {
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, new Set());
    }
    const room = this.rooms.get(roomId);
    room.add(ws);
    ws.roomId = roomId;
    return room.size;
  }

  /**
   * 用户退出房间
   * 如果房间变空则自动删除
   * @param {string} roomId - 房间ID
   * @param {import('ws').WebSocket} ws - 用户的 WebSocket 连接
   */
  leave(roomId, ws) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.delete(ws);
    ws.roomId = null;
    // 房间为空时自动清理
    if (room.size === 0) {
      this.rooms.delete(roomId);
    }
  }

  /**
   * 获取房间内的所有连接
   * @param {string} roomId - 房间ID
   * @returns {Set<import('ws').WebSocket>|undefined} 连接集合，房间不存在时返回 undefined
   */
  getRoom(roomId) {
    return this.rooms.get(roomId);
  }

  /**
   * 获取房间内的在线人数
   * @param {string} roomId - 房间ID
   * @returns {number} 在线人数，房间不存在时返回 0
   */
  getRoomSize(roomId) {
    return this.rooms.get(roomId)?.size || 0;
  }
}

module.exports = { RoomManager };
