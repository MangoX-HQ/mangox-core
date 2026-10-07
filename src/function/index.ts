import NOW from "./now";

/**
 * Execute a function with multiple arguments
 * @param modifier - Function name (uppercase)
 * @param args - Array of arguments
 */
const executeFunction = (modifier: string, ...args: any[]): any => {
  switch (modifier) {
    case 'NOW':
      return NOW();

    case 'NOW_PLUS_DAYS':
      const datePlus = new Date();
      datePlus.setDate(datePlus.getDate() + Number(args[0] ?? 0));
      return datePlus;

    case 'HOW':
      return new Date("2025-11-19T08:55:03.000Z");

    case 'GENERATOR_NUMBER':
      return Math.floor(Math.random() * 10) + 1; // 1 -> 10

    case 'PLUS_GENERATOR_NUMBER':
      return Number(args[0] ?? 0) + (Math.floor(Math.random() * 10) + 1);

    case 'NUMBER_TO_STRING':
      return String(args[0] ?? '');

    // ===== NEW FUNCTIONS WITH MULTIPLE ARGS =====

    // ADD(a, b) -> a + b
    case 'ADD':
      return Number(args[0] ?? 0) + Number(args[1] ?? 0);

    // SUBTRACT(a, b) -> a - b
    case 'SUBTRACT':
      return Number(args[0] ?? 0) - Number(args[1] ?? 0);

    // MULTIPLY(a, b) -> a * b
    case 'MULTIPLY':
      return Number(args[0] ?? 0) * Number(args[1] ?? 0);

    // DIVIDE(a, b) -> a / b
    case 'DIVIDE':
      return Number(args[1]) !== 0 ? Number(args[0] ?? 0) / Number(args[1]) : 0;

    // CONCAT(a, b, c, ...) -> "abc..."
    case 'CONCAT':
      return args.map(a => String(a ?? '')).join('');

    // CONCAT_WITH(separator, a, b, c, ...) -> "a-b-c"
    case 'CONCAT_WITH':
      const separator = String(args[0] ?? '');
      return args.slice(1).map(a => String(a ?? '')).join(separator);

    // MIN(a, b, c, ...) -> smallest number
    case 'MIN':
      return Math.min(...args.map(a => Number(a ?? 0)));

    // MAX(a, b, c, ...) -> largest number
    case 'MAX':
      return Math.max(...args.map(a => Number(a ?? 0)));

    // BETWEEN(value, min, max) -> true/false
    case 'BETWEEN':
      const val = Number(args[0] ?? 0);
      const min = Number(args[1] ?? 0);
      const max = Number(args[2] ?? 0);
      return val >= min && val <= max;

    // DATE_ADD(days, months, years) -> new Date with offset
    case 'DATE_ADD':
      const d = new Date();
      d.setDate(d.getDate() + Number(args[0] ?? 0));
      d.setMonth(d.getMonth() + Number(args[1] ?? 0));
      d.setFullYear(d.getFullYear() + Number(args[2] ?? 0));
      return d;

    // IF(condition, trueValue, falseValue) -> trueValue or falseValue
    case 'IF':
      return args[0] ? args[1] : args[2];

    // COALESCE(a, b, c, ...) -> first non-null value
    case 'COALESCE':
      return args.find(a => a !== null && a !== undefined) ?? null;

    // ROUND(number, decimals) -> rounded number
    case 'ROUND':
      const decimals = Number(args[1] ?? 0);
      return Number(Number(args[0] ?? 0).toFixed(decimals));

    default:
      return args[0] ?? null;
  }
}

export { NOW, executeFunction };