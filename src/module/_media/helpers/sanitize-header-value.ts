export function sanitizeHeaderValue(value: string): string {
  if (!value) return '';
  return value
    .toString()
    .replace(/[\r\n\t\0\x7F]/g, ' ')
    .replace(/[^\x20-\x7E]/g, '')
    .trim()
    .substring(0, 200);
}