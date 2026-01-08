import LogService from "./log";

// 存储IP失败次数的Map，包含失败次数和最后尝试时间
const failedAttempts = new Map<string, { attempts: number; lastAttemptAt: number }>();
// 存储被阻止的IP地址
const blockedIPs = new Map<string, { blockedUntil: number }>();

// 失败次数阈值
const MAX_FAILED_ATTEMPTS = 5;
// 黑名单持续时间（毫秒），默认1小时
const BLOCK_DURATION = 60 * 60 * 1000;

/**
 * 检查IP是否被阻止
 * @param ip IP地址
 * @returns 如果IP被阻止返回true，否则返回false
 */
export function isIPBlocked(ip: string): boolean {
  // 检查IP是否在阻止列表中
  const blockInfo = blockedIPs.get(ip);
  if (blockInfo) {
    // 如果黑名单已过期，移除该IP
    if (Date.now() > blockInfo.blockedUntil) {
      blockedIPs.delete(ip);
      LogService.info("IP block expired and removed", { ip });
      return false;
    }
    return true;
  }
  return false;
}

/**
 * 记录登录失败
 * @param ip IP地址
 * @returns 如果IP达到最大失败次数并被加入黑名单，返回true
 */
export function recordFailedAttempt(ip: string): boolean {
  const now = Date.now();
  const attemptInfo = failedAttempts.get(ip);
  
  if (attemptInfo) {
    // 增加失败次数
    const newAttempts = attemptInfo.attempts + 1;
    failedAttempts.set(ip, { attempts: newAttempts, lastAttemptAt: now });
    
    // 如果达到最大失败次数，将IP加入黑名单
    if (newAttempts >= MAX_FAILED_ATTEMPTS) {
      const blockedUntil = now + BLOCK_DURATION;
      blockedIPs.set(ip, { blockedUntil });
      failedAttempts.delete(ip); // 从失败尝试列表中删除
      LogService.warn("IP added to block list due to multiple failed login attempts", { 
        ip, 
        attempts: newAttempts,
        blockedUntil: new Date(blockedUntil)
      });
      return true;
    }
  } else {
    // 首次失败尝试
    failedAttempts.set(ip, { attempts: 1, lastAttemptAt: now });
  }
  
  return false;
}

/**
 * 记录成功登录，清除该IP的失败记录
 * @param ip IP地址
 */
export function recordSuccessfulLogin(ip: string): void {
  // 清除失败尝试记录
  if (failedAttempts.has(ip)) {
    failedAttempts.delete(ip);
    LogService.info("Cleared failed attempts after successful login", { ip });
  }
}

/**
 * 检查IP是否接近被阻止状态（用于警告）
 * @param ip IP地址
 * @returns 返回失败次数
 */
export function getFailedAttemptsCount(ip: string): number {
  const attemptInfo = failedAttempts.get(ip);
  return attemptInfo ? attemptInfo.attempts : 0;
}

/**
 * 重置IP的失败尝试次数
 * @param ip IP地址
 */
export function resetFailedAttempts(ip: string): void {
  if (failedAttempts.has(ip)) {
    failedAttempts.delete(ip);
  }
}