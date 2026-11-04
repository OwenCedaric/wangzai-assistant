export function dataBackupText(...values) {
  const value = values.find((candidate) => String(candidate ?? '').trim());
  return value === undefined ? '' : String(value).trim();
}

export function dataBackupCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}
