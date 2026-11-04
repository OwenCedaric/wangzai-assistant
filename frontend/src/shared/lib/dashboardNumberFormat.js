export function formatDashboardInteger(value) {
  const number = Number(value) || 0;
  return Math.round(number).toLocaleString();
}
