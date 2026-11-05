// 时间格式化工具

/**
 * 格式化数字为万单位
 */
export const formatCount = (count: number): string => {
  if (count >= 10000) {
    return (count / 10000).toFixed(1) + '万';
  }
  return count.toString();
};

/**
 * 格式化直播时长
 * @param startTime 开播时间戳
 */
export const formatDuration = (startTime: number): string => {
  // 未开播 / 缺失时长时 startTime 为 0，直接返回占位，
  // 否则 Date.now() - 0 会算出「498075小时35分钟」这种荒谬值。
  if (!startTime || !Number.isFinite(startTime) || startTime <= 0) {
    return '0分钟';
  }
  // 设备时钟偏差可能导致 diff 为负，钳到 0 避免出现「-3分钟」
  const diff = Math.max(0, Date.now() - startTime);
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 0) {
    return `${hours}小时${minutes}分钟`;
  }
  return `${minutes}分钟`;
};

/**
 * 格式化时长（分钟 -> 时分）
 */
export const formatMinutes = (minutes: number): string => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0) {
    return `${h}小时${m}分`;
  }
  return `${m}分钟`;
};

/**
 * 相对时间（刚刚、x分钟前、x小时前、x天前）
 */
export const formatRelativeTime = (timestamp: number): string => {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  if (hours < 24) return `${hours}小时前`;
  if (days < 30) return `${days}天前`;
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
};

/**
 * 格式化日期时间
 */
export const formatDateTime = (timestamp: number): string => {
  const date = new Date(timestamp);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
