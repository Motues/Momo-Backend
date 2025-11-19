import * as crypto from 'crypto';

const getAvatar = async (author: string, email: string): Promise<string | undefined> => {
  /*
  1. 分析邮箱类型，如果是QQ邮箱，则使用对应的QQ头像
  2. 否则使用默认生成的头像
  */

  // const qqAvatar = getQQAvatar(email);
  // if (qqAvatar) {
  //   return qqAvatar;
  // }

  // const githubAvatar = await getGithub
  // Avatar(author);
  // if (githubAvatar) {
  //   return githubAvatar;
  // }


  return getCravatar(email);
};

// 获取 GitHub 头像的辅助函数
const getGithubAvatar = async (author: string): Promise<string | undefined> => {
  try {
    // 首先尝试使用用户名查询
    if (author) {
      const response = await fetch(`https://api.github.com/users/${encodeURIComponent(author)}`);
      if (response.ok) {
        const userData = await response.json();
        if (userData.avatar_url) {
          return userData.avatar_url;
        }
      }
    }
    return undefined;
  } catch (error) {
    return undefined;
  }
};

const getCravatar = async (email: string): Promise<string | undefined> => { 
  // 将字母变成小写
  email = email.toLowerCase();
  const hash = crypto.createHash('md5').update(email).digest('hex');
  return `https://cravatar.cn/avatar/${hash}?s=200&d=retro`;
};

// 获取 QQ 头像的辅助函数
const getQQAvatar = (email: string): string | undefined => {
  const qqEmailMatch = email.match(/^(\d+)@qq\.com$/);
  // 判断是不是纯数字
  if (!qqEmailMatch || !qqEmailMatch[1].match(/^\d+$/)) {
    return undefined;
  }
  const qqNumber = qqEmailMatch[1];
  // QQ 头像 API
  const hash = crypto.createHash('sha256').update(email).digest('hex');
  return `https://weavatar.com/avatar/${hash}&s=200`;
  // return `https://q1.qlogo.cn/g?b=qq&nk=${qqNumber}&s=100`;
};

const getAvatarSeed = (email: string): string => {
  const hash = crypto.createHash('sha256').update(email).digest('hex');
  return `https://api.dicebear.com/7.x/identicon/svg?seed=${hash}`;
}

export { getAvatar };