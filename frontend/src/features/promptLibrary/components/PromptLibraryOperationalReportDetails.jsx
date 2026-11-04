import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';

const PLACEHOLDER_ONLY = /(?:暂无|未返回)$/u;
const FIELD_PATTERN = /^([^\d￥₽%]{1,12}?)[：:\s]+(.+)$/u;

function text(value) {
  return String(value ?? '').trim();
}

function splitMetricRow(value) {
  const normalized = text(value);
  const separatorIndex = normalized.search(/[：:]/u);
  if (separatorIndex <= 0) return null;
  const label = normalized.slice(0, separatorIndex).trim();
  const rowValue = normalized.slice(separatorIndex + 1).trim();
  if (!label || !rowValue || PLACEHOLDER_ONLY.test(rowValue)) return null;
  return { label, value: rowValue };
}

function splitField(value) {
  const normalized = text(value);
  const matched = normalized.match(FIELD_PATTERN);
  if (!matched) return { label: '', value: normalized };
  return { label: text(matched[1]), value: text(matched[2]) };
}

function splitDetailRow(value, sectionTitle) {
  const parts = text(value).split('｜').map(text).filter(Boolean);
  if (parts.length < 2) return null;
  let primary = parts.shift();
  if (sectionTitle === '商品销售排行' && /^第\s*\d+\s*名$/u.test(primary) && parts.length) {
    primary = `${primary} · ${parts.shift()}`;
  }
  const fields = parts
    .map(splitField)
    .filter((item) => item.value && !PLACEHOLDER_ONLY.test(item.value));
  if (!primary || !fields.length) return null;
  return { primary, fields };
}

export function normalizeOperationalReportSections(sections = []) {
  return (Array.isArray(sections) ? sections : []).map((section) => {
    const rawRows = (Array.isArray(section?.rows) ? section.rows : []).map(text).filter(Boolean);
    const metricRows = rawRows.map(splitMetricRow).filter(Boolean);
    const metricLike = rawRows.length > 0 && rawRows.every((row) => !row.includes('｜') && /[：:]/u.test(row));
    if (metricLike) {
      return { title: text(section?.title) || '报表项目', mode: 'metrics', rows: metricRows };
    }
    const detailRows = rawRows
      .map((row) => splitDetailRow(row, text(section?.title)))
      .filter(Boolean);
    return { title: text(section?.title) || '报表项目', mode: 'details', rows: detailRows };
  }).filter((section) => section.rows.length);
}

function sectionGroup(title) {
  if (['读取范围', '经营概览'].includes(title)) return 'overview';
  if (/销售|每日/u.test(title)) return 'sales';
  if (/商品|类目|价格|库存|补货/u.test(title)) return 'products';
  if (/费用|扣费|结算/u.test(title)) return 'finance';
  if (/售后/u.test(title)) return 'after-sales';
  if (/营销|活动/u.test(title)) return 'marketing';
  return title;
}

function canUseCompactLayout(section) {
  if (section.mode === 'metrics') return true;
  return section.rows.length <= 8
    && section.rows.every((row) => row.fields.length <= 4);
}

export function arrangeOperationalReportSections(sections = []) {
  const groups = new Map();
  (Array.isArray(sections) ? sections : []).forEach((section) => {
    const group = sectionGroup(section.title);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(section);
  });
  return [...groups.values()].flatMap((groupSections) => {
    const compactCandidates = groupSections.filter(canUseCompactLayout);
    const wideSections = groupSections.filter((section) => !canUseCompactLayout(section));
    const pairedCount = compactCandidates.length - (compactCandidates.length % 2);
    return [
      ...compactCandidates.map((section, index) => ({
        ...section,
        layout: index < pairedCount ? 'compact' : 'wide',
      })),
      ...wideSections.map((section) => ({ ...section, layout: 'wide' })),
    ];
  });
}

function MetricSection({ section }) {
  return (
    <Box className={`prompt-library-operational-detail-section is-metrics is-${section.layout}`}>
      <Box className="prompt-library-operational-detail-head">
        <Typography component="h3">{section.title}</Typography>
        <Typography component="span">{section.rows.length} 项</Typography>
      </Box>
      <Box className="prompt-library-operational-metric-grid">
        {section.rows.map((row, index) => (
          <Box className="prompt-library-operational-metric" key={`${row.label}-${index}`}>
            <Typography component="span">{row.label}</Typography>
            <Typography component="strong">{row.value}</Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function DetailSection({ section }) {
  const categoryGrid = section.title === '类目分布';
  return (
    <Box
      className={`prompt-library-operational-detail-section is-details is-${section.layout}${categoryGrid ? ' is-category-grid' : ''}`}
    >
      <Box className="prompt-library-operational-detail-head">
        <Typography component="h3">{section.title}</Typography>
        <Typography component="span">{section.rows.length} 条</Typography>
      </Box>
      <Box className="prompt-library-operational-detail-rows">
        {section.rows.map((row, rowIndex) => (
          <Box className="prompt-library-operational-detail-row" key={`${section.title}-${rowIndex}`}>
            <Typography component="div" className="prompt-library-operational-detail-primary">
              {row.primary}
            </Typography>
            <Box className="prompt-library-operational-detail-fields">
              {row.fields.map((field, fieldIndex) => (
                <Box className="prompt-library-operational-detail-field" key={`${field.label}-${fieldIndex}`}>
                  {field.label ? <Typography component="span">{field.label}</Typography> : null}
                  <Typography component="strong">{field.value}</Typography>
                </Box>
              ))}
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

export function PromptLibraryOperationalReportDetails({ sections = [] }) {
  const normalizedSections = React.useMemo(
    () => normalizeOperationalReportSections(sections),
    [sections],
  );
  const arrangedSections = React.useMemo(
    () => arrangeOperationalReportSections(normalizedSections),
    [normalizedSections],
  );
  const rowCount = normalizedSections.reduce((sum, section) => sum + section.rows.length, 0);
  if (!normalizedSections.length) return null;
  return (
    <Box component="section" className="prompt-library-operational-details">
      <Box className="prompt-library-operational-details-title">
        <Box>
          <Typography component="h2">报表明细依据</Typography>
          <Typography component="p">按经营项目拆开显示，字段和值一一对应。</Typography>
        </Box>
        <Typography component="span">{normalizedSections.length} 组 · {rowCount} 条</Typography>
      </Box>
      <Box className="prompt-library-operational-details-grid">
        {arrangedSections.map((section) => (
          section.mode === 'metrics'
            ? <MetricSection key={section.title} section={section} />
            : <DetailSection key={section.title} section={section} />
        ))}
      </Box>
    </Box>
  );
}
