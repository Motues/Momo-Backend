const getQueryNumber = (query: string | string[] | undefined, defaultValue: number): number => {
  let strValue: string | undefined;

  if (query === undefined) {
    return defaultValue;
  } else if (Array.isArray(query)) {
    strValue = query[0]; // 可能是 undefined
  } else {
    strValue = query;
  }

  // 如果最终字符串为空或 undefined，返回默认值
  if (strValue === undefined || strValue === '') {
    return defaultValue;
  }

  const num = parseInt(strValue, 10); // 显式指定 radix=10
  return isNaN(num) ? defaultValue : num;
};

const getQueryBoolean = (query: string | string[] | undefined, defaultValue: boolean): boolean => {
  let strValue: string | undefined;

  if (query === undefined) {
    return defaultValue;
  } else if (Array.isArray(query)) {
    strValue = query[0]; // 可能是 undefined
  } else {
    strValue = query;
  }

  if (strValue === undefined || strValue === '') return defaultValue;
  return strValue === 'true';
}

const getQueryString = (query: string | string[] | undefined, defaultValue: string): string => {
  let strValue = "";

  if (query === undefined) {
    return defaultValue;
  } else if (Array.isArray(query)) {
    strValue = query[0]; // 可能是 undefined
  } else {
    strValue = query;
  }

  if (strValue === undefined || strValue === '') return "";
  return strValue;
}

export { getQueryNumber, getQueryBoolean, getQueryString };