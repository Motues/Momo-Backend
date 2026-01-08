/**
 * 辅助函数：生成 Gravatar 头像地址 (MD5 算法)
 */
export const getCravatar = async (email: string): Promise<string> => {
  const cleanEmail = email.trim().toLowerCase();
  const msgUint8 = new TextEncoder().encode(cleanEmail);
  const hashBuffer = await crypto.subtle.digest('MD5', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return `https://cravatar.cn/avatar/${hashHex}?s=200&d=retro`;
};