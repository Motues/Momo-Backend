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

/**
 * 取查询参数中的整数并夹在 [min, max] 区间内。
 * 用于分页参数：getQueryNumber 会把负数/0 原样返回，直接参与 slice/OFFSET 会出错（C14）。
 * 小于 min 的取值（0、负数）视为非法并回退到 defaultValue，与 Go/Worker 的 clamp 行为一致。
 */
const getQueryClampedNumber = (
  query: string | string[] | undefined,
  defaultValue: number,
  min: number,
  max: number
): number => {
  const value = getQueryNumber(query, defaultValue);
  if (value < min) return defaultValue;
  return Math.min(value, max);
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

export { getQueryNumber, getQueryClampedNumber, getQueryBoolean, getQueryString };