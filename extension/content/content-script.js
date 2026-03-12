/**
 * content-script.js —— B站页面内容脚本（同步核心逻辑）
 *
 * 此脚本注入到 bilibili.com/video/* 页面中，是整个同步系统的核心。
 * 主要职责：
 * 1. 发现并监控页面中的 <video> 元素
 * 2. 监听视频的 seeked / play / pause 事件，发送给 service worker
 * 3. 接收远端同步指令，应用到本地视频播放器
 * 4. 通过「事件抑制标志」防止同步回环（A->B->A 死循环）
 * 5. 通过时间戳进行延迟补偿，确保两端播放进度尽量一致
 *
 * 关键设计：
 * - suppressEvents 标志：执行远端指令前设为 true，阻止本地事件外发；500ms 后恢复
 * - 跳转防抖：拖动进度条时，200ms 内只发送最终位置
 * - MutationObserver：应对B站切换清晰度导致 <video> 元素被替换的情况
 */

// ==================== 状态变量 ====================

/**
 * 事件抑制标志
 * 当为 true 时，所有本地视频事件（seeked/play/pause）不会发送到服务器
 * 用于防止同步回环：收到远端指令 -> 执行操作 -> 触发本地事件 -> 不能再发回去
 */
let suppressEvents = false;

/** @type {HTMLVideoElement|null} 当前监控的视频元素 */
let videoElement = null;

/** @type {string|null} 当前视频的 BV 号（含分P参数） */
let currentVideoId = null;

/** @type {number|null} 跳转防抖定时器ID */
let seekDebounceTimer = null;

/** @type {number|null} 事件抑制恢复定时器ID */
let suppressTimer = null;

/** @type {MutationObserver|null} 监控视频元素变化的观察器 */
let videoObserver = null;

// ==================== 视频 ID 提取 ====================

/**
 * 从当前页面 URL 中提取视频/番剧 ID
 * 支持以下格式：
 *   /video/BV1xx411c7XW              普通视频
 *   /video/BV1xx411c7XW/             普通视频（带尾斜杠）
 *   /video/BV1xx411c7XW?p=2          分P视频
 *   /bangumi/play/ep266286           番剧/电影页面
 *   /bangumi/play/ss12345            番剧/电影页面（season ID）
 *
 * @returns {string|null} 视频ID（如 "BV1xx411c7XW"、"BV1xx411c7XW?p=2"、"ep266286"），提取失败返回 null
 */
function getVideoId() {
  const pathname = window.location.pathname;

  // 匹配普通视频页面：/video/BVxxxxxxxx
  const videoMatch = pathname.match(/\/video\/(BV[a-zA-Z0-9]+)/);
  if (videoMatch) {
    let videoId = videoMatch[1];

    // 检查是否有分P参数
    const params = new URLSearchParams(window.location.search);
    const page = params.get('p');
    if (page && page !== '1') {
      videoId += `?p=${page}`;
    }

    return videoId;
  }

  // 匹配番剧/电影页面：/bangumi/play/epXXXXXX 或 /bangumi/play/ssXXXXX
  const bangumiMatch = pathname.match(/\/bangumi\/play\/((?:ep|ss)\d+)/);
  if (bangumiMatch) {
    return bangumiMatch[1];
  }

  return null;
}

// ==================== 视频元素发现 ====================

/**
 * 在页面中查找 <video> 元素
 * B站播放器的 DOM 结构中，视频元素位于 .bpx-player-video-wrap 容器内
 * @returns {HTMLVideoElement|null}
 */
function findVideoElement() {
  return document.querySelector('.bpx-player-video-wrap video')
      || document.querySelector('video');
}

/**
 * 等待视频元素出现
 * B站页面是动态加载的，视频元素可能在 content script 执行时还不存在
 * 使用 MutationObserver 监控 DOM 变化，发现视频元素后绑定事件监听
 */
function waitForVideo() {
  videoElement = findVideoElement();
  if (videoElement) {
    console.log('[同步] 找到视频元素，开始监听');
    attachListeners();
    watchVideoElement();
    return;
  }

  console.log('[同步] 视频元素未找到，等待加载...');
  const observer = new MutationObserver(() => {
    videoElement = findVideoElement();
    if (videoElement) {
      observer.disconnect();
      console.log('[同步] 视频元素已加载，开始监听');
      attachListeners();
      watchVideoElement();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

/**
 * 监控视频元素是否被替换（如切换清晰度时B站会替换 <video> 标签）
 * 检测到替换后，重新绑定事件监听器
 */
function watchVideoElement() {
  // 查找视频容器
  const container = document.querySelector('.bpx-player-video-wrap');
  if (!container) return;

  // 如果已有观察器，先断开
  if (videoObserver) {
    videoObserver.disconnect();
  }

  videoObserver = new MutationObserver(() => {
    const newVideo = findVideoElement();
    if (newVideo && newVideo !== videoElement) {
      console.log('[同步] 检测到视频元素被替换，重新绑定监听器');
      videoElement = newVideo;
      attachListeners();
    }
  });

  videoObserver.observe(container, { childList: true, subtree: true });
}

// ==================== 事件监听 ====================

/**
 * 为视频元素绑定播放控制事件监听器
 * 监听 seeked / play / pause 三个关键事件
 */
function attachListeners() {
  if (!videoElement) return;

  console.log('[同步] 正在绑定事件监听器，视频元素:', videoElement);
  console.log('[同步] 视频当前时间:', videoElement.currentTime, '是否暂停:', videoElement.paused);

  // 先移除旧的监听器（防止重复绑定）
  videoElement.removeEventListener('seeked', onSeeked);
  videoElement.removeEventListener('play', onPlay);
  videoElement.removeEventListener('pause', onPause);

  // 绑定新的监听器
  videoElement.addEventListener('seeked', onSeeked);
  videoElement.addEventListener('play', onPlay);
  videoElement.addEventListener('pause', onPause);

  console.log('[同步] 事件监听器绑定完成（seeked / play / pause）');
}

/**
 * 视频跳转事件处理
 * 使用 200ms 防抖：拖动进度条时会连续触发多个 seeked 事件，
 * 只在用户停止拖动后发送最终位置
 */
function onSeeked() {
  console.log('[同步] seeked 事件触发，当前时间:', videoElement.currentTime, 'suppress:', suppressEvents);
  // 如果是远端指令触发的跳转，不要发回去（防回环）
  if (suppressEvents) return;

  // 防抖处理：等 200ms 后再发送，期间有新跳转则重新计时
  if (seekDebounceTimer) {
    clearTimeout(seekDebounceTimer);
  }

  seekDebounceTimer = setTimeout(() => {
    console.log('[同步] 发送 SEEK，时间:', videoElement.currentTime);
    sendToBackground({
      type: 'SEEK',
      payload: {
        videoId: currentVideoId,
        currentTime: videoElement.currentTime,
        timestamp: Date.now()
      }
    });
  }, 200); // 200ms 防抖延迟
}

/**
 * 视频播放事件处理
 */
function onPlay() {
  console.log('[同步] play 事件触发，当前时间:', videoElement.currentTime, 'suppress:', suppressEvents);
  if (suppressEvents) return;

  console.log('[同步] 发送 PLAY，时间:', videoElement.currentTime);
  sendToBackground({
    type: 'PLAY',
    payload: {
      videoId: currentVideoId,
      currentTime: videoElement.currentTime,
      timestamp: Date.now()
    }
  });
}

/**
 * 视频暂停事件处理
 */
function onPause() {
  console.log('[同步] pause 事件触发，当前时间:', videoElement.currentTime, 'suppress:', suppressEvents);
  if (suppressEvents) return;

  console.log('[同步] 发送 PAUSE，时间:', videoElement.currentTime);
  sendToBackground({
    type: 'PAUSE',
    payload: {
      videoId: currentVideoId,
      currentTime: videoElement.currentTime,
      timestamp: Date.now()
    }
  });
}

// ==================== 远端指令执行 ====================

/**
 * 执行从远端（对方）收到的同步指令
 *
 * 核心防回环逻辑：
 * 1. 设置 suppressEvents = true（抑制所有外发事件）
 * 2. 对视频执行操作（设置时间、播放/暂停）
 * 3. 操作会触发本地 DOM 事件（seeked/play/pause）
 * 4. 事件处理函数检查 suppressEvents，发现为 true 则丢弃（不发送）
 * 5. 500ms 后恢复 suppressEvents = false，重新开始监听本地操作
 *
 * @param {object} message - 远端同步消息 { type, payload }
 */
function applyRemoteCommand(message) {
  if (!videoElement) return;

  // 检查是否在看同一个视频，不同视频则忽略
  if (message.payload.videoId && message.payload.videoId !== currentVideoId) {
    console.log('[同步] 忽略远端指令：视频不一致，本地:', currentVideoId, '远端:', message.payload.videoId);
    return;
  }

  // 从 storage 读取用户设置的时间偏移量（毫秒），转换为秒后应用
  chrome.storage.local.get(['timeOffsetMs'], (result) => {
    const offsetSec = (result.timeOffsetMs || 0) / 1000;

    // ===== 第一步：启用事件抑制 =====
    suppressEvents = true;
    if (suppressTimer) {
      clearTimeout(suppressTimer);
    }

    // ===== 第二步：执行远端操作（加上用户偏移量） =====
    switch (message.type) {

      case 'SEEK': {
        const latency = (Date.now() - message.payload.timestamp) / 1000;
        videoElement.currentTime = message.payload.currentTime + latency + offsetSec;
        break;
      }

      case 'PLAY': {
        const latency = (Date.now() - message.payload.timestamp) / 1000;
        videoElement.currentTime = message.payload.currentTime + latency + offsetSec;
        videoElement.play();
        break;
      }

      case 'PAUSE': {
        videoElement.currentTime = message.payload.currentTime + offsetSec;
        videoElement.pause();
        break;
      }

      case 'SYNC_STATE': {
        const latency = (Date.now() - message.payload.timestamp) / 1000;
        videoElement.currentTime = message.payload.currentTime
            + (message.payload.isPlaying ? latency : 0) + offsetSec;

        if (message.payload.isPlaying) {
          videoElement.play();
        } else {
          videoElement.pause();
        }
        break;
      }
    }

    // ===== 第三步：延迟恢复事件监听 =====
    suppressTimer = setTimeout(() => {
      suppressEvents = false;
    }, 500);
  });
}

// ==================== 消息通信 ====================

/**
 * 向 service worker 发送消息
 * @param {object} message - 要发送的消息
 */
function sendToBackground(message) {
  chrome.runtime.sendMessage(message).catch((err) => {
    console.warn('[同步] 发送到后台失败:', err.message);
  });
}

/**
 * 接收来自 service worker 的消息
 * 可能是远端同步指令，也可能是状态请求
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === 'REQUEST_STATE') {
    // 对方请求我们的当前播放状态（通常在对方刚加入房间时触发）
    sendToBackground({
      type: 'SYNC_STATE',
      payload: {
        videoId: getVideoId(),
        currentTime: videoElement?.currentTime || 0,
        isPlaying: videoElement ? !videoElement.paused : false,
        timestamp: Date.now()
      }
    });
  } else if (message.type === 'ADJUST_TIME') {
    // popup 滑动偏移量时，实时微调本地视频进度
    if (videoElement) {
      suppressEvents = true;
      if (suppressTimer) clearTimeout(suppressTimer);
      videoElement.currentTime += message.payload.deltaMs / 1000;
      suppressTimer = setTimeout(() => { suppressEvents = false; }, 500);
    }
  } else {
    // 其他消息都是远端同步指令，执行之
    applyRemoteCommand(message);
  }
});

// ==================== SPA 页面跳转检测 ====================

/**
 * 监听 B 站 SPA 页面内跳转
 *
 * 通过 manifest.json 配置了 inject.js 以 "world": "MAIN" 运行在页面主世界中，
 * inject.js 拦截了 history.pushState / replaceState 并发送自定义事件
 * 'bilibili-sync-urlchange'。自定义 DOM 事件可以跨世界传递，
 * 所以 content script（隔离世界）可以通过 addEventListener 监听到。
 */
function setupSPANavigationListener() {
  let lastUrl = window.location.href;

  function checkUrlChange() {
    const currentUrl = window.location.href;
    if (currentUrl === lastUrl) return;
    lastUrl = currentUrl;

    const newVideoId = getVideoId();
    if (!newVideoId) return;

    if (newVideoId !== currentVideoId) {
      console.log(`[同步] 检测到页面跳转，新视频: ${newVideoId}`);
      currentVideoId = newVideoId;
      videoElement = null;
      if (videoObserver) {
        videoObserver.disconnect();
        videoObserver = null;
      }
      waitForVideo();
    }
  }

  // 监听来自 inject.js（主世界）发送的自定义事件
  window.addEventListener('bilibili-sync-urlchange', checkUrlChange);

  // 监听浏览器前进/后退按钮
  window.addEventListener('popstate', () => {
    setTimeout(checkUrlChange, 100);
  });
}

// ==================== 初始化 ====================

currentVideoId = getVideoId();
console.log(`[同步] Bilibili Sync 已加载，当前视频: ${currentVideoId}`);
waitForVideo();
setupSPANavigationListener();
