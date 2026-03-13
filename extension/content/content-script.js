/**
 * content-script.js —— B站页面内容脚本（同步核心逻辑）
 *
 * 此脚本注入到 bilibili.com/video/* 页面中，是整个同步系统的核心。
 * 主要职责：
 * 1. 发现并监控页面中的 <video> 元素
 * 2. 监听视频的 seeked / play / pause 事件，房主身份时发送给 service worker
 * 3. 接收远端同步指令，应用到本地视频播放器（客人端）
 * 4. 通过身份机制（房主/客人）从根本上防止同步回环
 *
 * 关键设计：
 * - 房主（host）：视频操作会同步给所有客人
 * - 客人（guest）：只接收同步，本地操作不会发送给任何人
 * - suppressEvents 标志：仅用于客人收到远端指令后短暂抑制事件，防止误触发
 * - 跳转防抖：拖动进度条时，200ms 内只发送最终位置
 * - MutationObserver：应对B站切换清晰度导致 <video> 元素被替换的情况
 */

// ==================== 状态变量 ====================

/**
 * 事件抑制标志
 * 当为 true 时，所有本地视频事件（seeked/play/pause）不会发送到服务器
 * 用于客人端收到远端指令后短暂抑制，避免偏移量调整等操作触发事件
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

/** @type {string|null} 当前身份：'host' 或 'guest'，从 storage 缓存 */
let syncRole = null;

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
 * 仅房主身份时发送事件
 */
function onSeeked() {
  if (suppressEvents || syncRole !== 'host') return;

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
  }, 200);
}

/**
 * 视频播放事件处理（仅房主发送）
 */
function onPlay() {
  if (suppressEvents || syncRole !== 'host') return;

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
 * 视频暂停事件处理（仅房主发送）
 */
function onPause() {
  if (suppressEvents || syncRole !== 'host') return;

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
 * 执行从远端（房主）收到的同步指令
 *
 * 仅客人端执行远端指令。房主端收到远端消息时忽略（房主不需要被同步）。
 *
 * @param {object} message - 远端同步消息 { type, payload }
 */
function applyRemoteCommand(message) {
  console.log('[同步] 收到远端指令:', message.type, 'payload:', JSON.stringify(message.payload));

  if (!videoElement) {
    console.log('[同步] 忽略远端指令：videoElement 不存在');
    return;
  }

  // 检查是否在看同一个视频，不同视频则忽略
  if (message.payload.videoId && message.payload.videoId !== currentVideoId) {
    console.log('[同步] 忽略远端指令：视频不一致，本地:', currentVideoId, '远端:', message.payload.videoId);
    return;
  }

  // 仅客人端执行远端指令
  if (syncRole !== 'guest') {
    console.log('[同步] 忽略远端指令：当前身份为', syncRole, '非客人');
    return;
  }

  chrome.storage.local.get(['timeOffsetMs'], (result) => {
    const offsetSec = (result.timeOffsetMs || 0) / 1000;
    console.log('[同步] 执行远端指令:', message.type, '偏移量:', offsetSec, 's');

    // 启用事件抑制（防止偏移量调整触发事件）
    suppressEvents = true;
    if (suppressTimer) {
      clearTimeout(suppressTimer);
    }

    switch (message.type) {

      case 'SEEK': {
        const targetTime = message.payload.currentTime + offsetSec;
        console.log('[同步] SEEK: 远端时间', message.payload.currentTime, '-> 本地设为', targetTime);
        videoElement.currentTime = targetTime;
        break;
      }

      case 'PLAY': {
        const targetTime = message.payload.currentTime + offsetSec;
        console.log('[同步] PLAY: 远端时间', message.payload.currentTime, '-> 本地设为', targetTime, '并播放');
        videoElement.currentTime = targetTime;
        videoElement.play();
        break;
      }

      case 'PAUSE': {
        const targetTime = message.payload.currentTime + offsetSec;
        console.log('[同步] PAUSE: 远端时间', message.payload.currentTime, '-> 本地设为', targetTime, '并暂停');
        videoElement.currentTime = targetTime;
        videoElement.pause();
        break;
      }

      case 'SYNC_STATE': {
        const targetTime = message.payload.currentTime + offsetSec;
        console.log('[同步] SYNC_STATE: 远端时间', message.payload.currentTime, '-> 本地设为', targetTime, '播放中:', message.payload.isPlaying);
        videoElement.currentTime = targetTime;

        if (message.payload.isPlaying) {
          videoElement.play();
        } else {
          videoElement.pause();
        }
        break;
      }
    }

    console.log('[同步] 指令执行完毕，本地 currentTime:', videoElement.currentTime);

    // 延迟恢复事件监听
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
    // 对方请求当前播放状态（通常在客人刚加入房间时触发）
    // 仅房主响应此请求
    if (syncRole !== 'host') return;

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
    // popup 滑动偏移量时，实时微调本地视频进度（仅客人会触发）
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

// 从 storage 读取缓存身份，并监听变化
chrome.storage.local.get(['syncRole'], (result) => {
  syncRole = result.syncRole || null;
  console.log('[同步] 初始身份:', syncRole);
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.syncRole) {
    syncRole = changes.syncRole.newValue || null;
    console.log('[同步] 身份变更:', syncRole);
  }
});

currentVideoId = getVideoId();
console.log(`[同步] Bilibili Sync 已加载，当前视频: ${currentVideoId}`);
waitForVideo();
setupSPANavigationListener();
