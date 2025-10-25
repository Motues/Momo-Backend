const getAvatar = async (author: string, email: string): Promise<string | undefined> => {
  /*
  1. 首先查看名称对应的github是否存在头像
  2. 分析邮箱类型，如果是QQ邮箱，则使用对应的QQ头像
  3. 否则使用默认头像
  */

  const qqAvatar = getQQAvatar(email);
  if (qqAvatar) {
    return qqAvatar;
  }

  const githubAvatar = await getGithubAvatar(author);
  if (githubAvatar) {
    return githubAvatar;
  }


  return undefined;
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
    return `https://api.dicebear.com/7.x/identicon/svg?seed=${author}`;
  } catch (error) {
    return undefined;
  }
};

// 获取 QQ 头像的辅助函数
const getQQAvatar = (email: string): string | undefined => {
  const qqEmailMatch = email.match(/^(\d+)@qq\.com$/);
  if (qqEmailMatch) {
    const qqNumber = qqEmailMatch[1];
    // QQ 头像 API
    return `https://q1.qlogo.cn/g?b=qq&nk=${qqNumber}&s=100`;
  }
  return undefined;
};

export { getAvatar };