/**
 * constants.js —— 共享常量定义
 *
 * 定义客户端和服务端之间通信使用的所有消息类型。
 * 此文件在 Chrome 扩展的 content script 和 service worker 中共享使用。
 *
 * 消息格式：{ type: MESSAGE_TYPES.XXX, payload: {...} }
 */

// eslint-disable-next-line no-unused-vars
const MESSAGE_TYPES = {

  // ==================== 房间生命周期 ====================

  JOIN_ROOM: 'JOIN_ROOM',           // 客户端 -> 服务器：请求加入房间
  LEAVE_ROOM: 'LEAVE_ROOM',         // 客户端 -> 服务器：请求退出房间
  ROOM_JOINED: 'ROOM_JOINED',       // 服务器 -> 客户端：确认已加入房间
  ROOM_LEFT: 'ROOM_LEFT',           // 服务器 -> 客户端：确认已退出房间
  PEER_JOINED: 'PEER_JOINED',       // 服务器 -> 房间内其他人：有新成员加入
  PEER_LEFT: 'PEER_LEFT',           // 服务器 -> 房间内其他人：有人退出或断线
  ROOM_ERROR: 'ROOM_ERROR',         // 服务器 -> 客户端：房间相关错误

  // ==================== 同步事件 ====================

  SEEK: 'SEEK',                     // 跳转到指定时间点
  PLAY: 'PLAY',                     // 在指定时间点开始播放
  PAUSE: 'PAUSE',                   // 在指定时间点暂停
  SYNC_STATE: 'SYNC_STATE',         // 完整状态快照（视频ID + 进度 + 播放状态）
  REQUEST_STATE: 'REQUEST_STATE',   // 请求对方发送当前状态（新加入者触发）

  // ==================== 心跳保活 ====================

  HEARTBEAT: 'HEARTBEAT',           // 客户端 -> 服务器：心跳包
  HEARTBEAT_ACK: 'HEARTBEAT_ACK',   // 服务器 -> 客户端：心跳响应
};

/**
 * 默认配置
 */
// eslint-disable-next-line no-unused-vars
const DEFAULT_CONFIG = {
  SERVER_URL: 'ws://localhost:8080', // 默认 WebSocket 服务器地址
  HEARTBEAT_INTERVAL: 25000,        // 心跳间隔（毫秒），25秒
  SEEK_DEBOUNCE_DELAY: 200,         // 跳转事件防抖延迟（毫秒）
  SUPPRESS_TIMEOUT: 500,            // 事件抑制超时（毫秒），防回环用
};
