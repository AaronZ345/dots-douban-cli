function parseStrictInteger(rawValue: string, optionName: string): number {
  const trimmed = rawValue.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${optionName} 必须是整数`);
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${optionName} 超出安全整数范围`);
  }

  return parsed;
}

export function parseNonNegativeInt(value: string | undefined, optionName: string, fallback: number): number {
  if (typeof value === 'undefined') return fallback;
  const parsed = parseStrictInteger(value, optionName);
  if (parsed < 0) {
    throw new Error(`${optionName} 必须是非负整数`);
  }
  return parsed;
}

export function parsePositiveInt(value: string | undefined, optionName: string, fallback: number): number {
  if (typeof value === 'undefined') return fallback;
  const parsed = parseStrictInteger(value, optionName);
  if (parsed <= 0) {
    throw new Error(`${optionName} 必须是正整数`);
  }
  return parsed;
}

export function parsePositiveIntAtMost(
  value: string | undefined,
  optionName: string,
  fallback: number,
  maximum: number
): number {
  const parsed = parsePositiveInt(value, optionName, fallback);
  if (parsed > maximum) {
    throw new Error(`${optionName} 不能超过 ${maximum}`);
  }
  return parsed;
}

export function pageToOffset(page: number, pageSize: number, optionName = '--page'): number {
  if (!Number.isSafeInteger(page) || page <= 0) {
    throw new Error(`${optionName} 必须是安全范围内的正整数`);
  }
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
    throw new Error('每页数量必须是安全范围内的正整数');
  }
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) {
    throw new Error(`${optionName} 与每页数量的组合超出安全整数范围`);
  }
  return offset;
}

export function getPageRange(page: number, pageSize: number, itemCount: number): {
  from: number;
  to: number;
} {
  const offset = pageToOffset(page, pageSize);
  return {
    from: itemCount > 0 ? offset + 1 : 0,
    to: itemCount > 0 ? offset + itemCount : 0
  };
}

export function isNumericId(value: string): boolean {
  return /^\d+$/.test(value.trim());
}

export function formEncode(data: Record<string, string | undefined | null>): string {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    body.set(key, value);
  }
  return body.toString();
}
